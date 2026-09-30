/**
 * SystemGroupedBody — the grouped body of the System view (design IDEA-037).
 *
 * Two groupings over the one polled snapshot:
 *   - By worktree (default): one card per worktree, its processes nested in a table.
 *   - By process type: one card per process type with an aggregate line, rows
 *     showing the OWNING worktree (an orphan renders "none — orphaned").
 *
 * Trust tiers are visible, never interleaved:
 *   - foreign   — someone else's. Read-only: the snapshot gives a foreign row no
 *                 pid, and this view never renders a destructive control for it.
 *   - suspected — cyboflow-shaped but carrying no spawn marker. Rendered in its own
 *                 dashed tier ({@link SuspectedTier}, reused by the Orphans section).
 *
 * Destructive affordances (Kill tree / Kill all / Prune) render only when the
 * caller supplies the matching handler — the manifest-confirm wiring is a later
 * task's job, and a control that does nothing is worse than none.
 *
 * The By-worktree grouping leaves orphan-bucket processes and orphan-tag
 * worktrees to the Orphans section; By-process-type shows every process.
 */
import type { ReactElement, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import type { SystemSnapshotData } from '../../hooks/useSystemSnapshot';
import type { SystemGroupBy } from '../../utils/systemGroupBy';
import { openSystemRun, openSystemSession } from '../../utils/systemNavigation';
import { KindTag } from '../cyboflow/KindTag';
import { formatManifestBytes } from './formatManifestBytes';

export type SystemProcess = SystemSnapshotData['processes'][number];
export type SystemWorktree = SystemSnapshotData['worktrees'][number];
/** Every process the view may act on — a foreign row is excluded by type (it has no pid). */
export type SystemActionableProcess = Exclude<SystemProcess, { bucket: 'foreign' }>;
type ProcessType = SystemProcess['processType'];

export type SystemSortKey = 'disk' | 'cpu' | 'mem' | 'owner';

export const SYSTEM_SORT_OPTIONS: ReadonlyArray<{ key: SystemSortKey; label: string }> = [
  { key: 'disk', label: 'Disk' },
  { key: 'cpu', label: 'CPU' },
  { key: 'mem', label: 'Memory' },
  { key: 'owner', label: 'Owner' },
];

const HOT_CPU_PERCENT = 50;

const TYPE_ORDER: readonly ProcessType[] = [
  'claude-cli',
  'codex-cli',
  'pi-cli',
  'omp-cli',
  'shell-pty',
  'codex-broker',
  'unknown',
];

const TYPE_LABEL: Record<ProcessType, string> = {
  'claude-cli': 'CLI · Claude SDK',
  'codex-cli': 'CLI · Codex',
  'pi-cli': 'CLI · pi',
  'omp-cli': 'CLI · OMP',
  'shell-pty': 'Shell PTY',
  'codex-broker': 'Codex broker · detached',
  unknown: 'Other',
};

const OWNER_LABEL: Record<SystemWorktree['tag'], string> = {
  'session-owned': 'Session',
  'run-owned': 'Run',
  in_place: 'In place',
  is_main_repo: 'Main repo',
  orphan: 'Orphan',
};

export interface SystemActionHandlers {
  /** Kill one process's tree. Never invoked for a foreign row. */
  onKillTree?: (process: SystemActionableProcess) => void;
  /** Kill every listed process (the non-foreign members of a card/type). */
  onKillAll?: (processes: SystemActionableProcess[], scope: { kind: 'worktree' | 'type'; label: string }) => void;
  /** Prune one worktree (only offered enabled when the registry marks it prunable). */
  onPruneWorktree?: (worktree: SystemWorktree) => void;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? path;
}

const INTERPRETERS = /^(node|bun|deno|python[\d.]*|ruby|bash|sh|zsh)$/;

/** A short display name for a process command line. */
export function processName(command: string): string {
  const tokens = command.trim().split(/\s+/).filter((t) => t.length > 0);
  const first = basename(tokens[0] ?? command);
  if (INTERPRETERS.test(first)) {
    const script = tokens.slice(1).find((t) => !t.startsWith('-'));
    if (script !== undefined) return basename(script);
  }
  return first;
}

export function formatElapsed(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

function formatPercent(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`;
}

interface ProcessMetrics {
  cpu: string;
  mem: string;
  up: string;
  hot: boolean;
}

function metricsOf(p: SystemProcess): ProcessMetrics {
  if (p.bucket === 'foreign') {
    return { cpu: p.display.cpu ?? '—', mem: p.display.mem ?? '—', up: p.display.elapsed ?? '—', hot: false };
  }
  return {
    cpu: formatPercent(p.pcpu),
    mem: formatPercent(p.pmem),
    up: formatElapsed(p.etimeSeconds),
    hot: p.pcpu !== null && p.pcpu >= HOT_CPU_PERCENT,
  };
}

/**
 * Numeric CPU/memory figure of a row, for sorting and aggregate totals. Foreign rows
 * carry formatted strings only (read-only by construction), so parse what the row
 * displays — the totals then always match the rows they summarise. Unparseable → 0.
 */
function figureOf(displayed: string | null): number {
  const n = displayed === null ? Number.NaN : Number.parseFloat(displayed);
  return Number.isFinite(n) ? n : 0;
}

const cpuOf = (p: SystemProcess): number => (p.bucket === 'foreign' ? figureOf(p.display.cpu) : (p.pcpu ?? 0));
const memOf = (p: SystemProcess): number => (p.bucket === 'foreign' ? figureOf(p.display.mem) : (p.pmem ?? 0));

/** Owning-worktree lookup used to give Disk / Owner a per-process meaning (By process type). */
export type WorktreesByPath = ReadonlyMap<string, SystemWorktree>;

function ownerNameOf(p: SystemProcess, worktrees: WorktreesByPath | undefined): string | null {
  if (p.worktreePath === null) return null;
  return worktrees?.has(p.worktreePath) === true ? basename(p.worktreePath) : null;
}

function ownerDiskOf(p: SystemProcess, worktrees: WorktreesByPath | undefined): number | null {
  if (p.worktreePath === null) return null;
  const w = worktrees?.get(p.worktreePath);
  return w === undefined ? null : diskBytesOf(w);
}

/** Ascending by name, rows with no owner last. */
function compareOwnerNames(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
}

/** Descending by size, unmeasured last — never as 0. */
function compareDiskDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/**
 * Sort processes within a table. Disk and Owner are properties of the OWNING
 * worktree: with `worktrees` supplied (the By-process-type table) rows order by their
 * owner's disk / name; without it (a single worktree's table, where every row shares
 * one owner) they tie and fall back to CPU / name order.
 */
export function sortProcesses(
  processes: readonly SystemProcess[],
  key: SystemSortKey,
  worktrees?: WorktreesByPath,
): SystemProcess[] {
  const byName = (a: SystemProcess, b: SystemProcess): number => processName(a.command).localeCompare(processName(b.command));
  const byCpu = (a: SystemProcess, b: SystemProcess): number => cpuOf(b) - cpuOf(a) || byName(a, b);
  const copy = [...processes];
  switch (key) {
    case 'mem':
      return copy.sort((a, b) => memOf(b) - memOf(a) || byName(a, b));
    case 'owner':
      return copy.sort(
        (a, b) => compareOwnerNames(ownerNameOf(a, worktrees), ownerNameOf(b, worktrees)) || byName(a, b),
      );
    case 'disk':
      return copy.sort((a, b) => compareDiskDesc(ownerDiskOf(a, worktrees), ownerDiskOf(b, worktrees)) || byCpu(a, b));
    case 'cpu':
      return copy.sort(byCpu);
  }
}

function diskBytesOf(w: SystemWorktree): number | null {
  return w.usage.status === 'measured' ? w.usage.bytes : null;
}

/** Sort worktree cards. Unmeasured disk sorts last — never as 0. */
export function sortWorktrees(
  worktrees: readonly SystemWorktree[],
  processesByPath: ReadonlyMap<string, SystemProcess[]>,
  key: SystemSortKey,
): SystemWorktree[] {
  const sum = (w: SystemWorktree, pick: (p: SystemProcess) => number): number =>
    (processesByPath.get(w.path) ?? []).reduce((acc, p) => acc + pick(p), 0);
  const byOwner = (a: SystemWorktree, b: SystemWorktree): number =>
    OWNER_LABEL[a.tag].localeCompare(OWNER_LABEL[b.tag]) || basename(a.path).localeCompare(basename(b.path));
  const copy = [...worktrees];
  switch (key) {
    case 'disk':
      return copy.sort((a, b) => {
        const da = diskBytesOf(a);
        const db = diskBytesOf(b);
        if (da === null && db === null) return byOwner(a, b);
        if (da === null) return 1;
        if (db === null) return -1;
        return db - da;
      });
    case 'cpu':
      return copy.sort((a, b) => sum(b, cpuOf) - sum(a, cpuOf) || byOwner(a, b));
    case 'mem':
      return copy.sort((a, b) => sum(b, memOf) - sum(a, memOf) || byOwner(a, b));
    case 'owner':
      return copy.sort(byOwner);
  }
}

export interface ProcessTypeGroup {
  type: ProcessType;
  members: SystemProcess[];
}

/**
 * Order the By-process-type cards by the selected sort: aggregate CPU / memory
 * (descending), the disk held by the distinct worktrees the group's processes live in
 * (descending, unmeasured last), or the alphabetically-first owning worktree (groups
 * with no owner last). Ties keep the canonical type order.
 */
export function sortTypeGroups(
  groups: readonly ProcessTypeGroup[],
  key: SystemSortKey,
  worktrees: WorktreesByPath,
): ProcessTypeGroup[] {
  const typeRank = (g: ProcessTypeGroup): number => TYPE_ORDER.indexOf(g.type);
  const sumOf = (g: ProcessTypeGroup, pick: (p: SystemProcess) => number): number =>
    g.members.reduce((acc, p) => acc + pick(p), 0);
  const diskOf = (g: ProcessTypeGroup): number | null => {
    const paths = new Set<string>();
    for (const p of g.members) if (p.worktreePath !== null) paths.add(p.worktreePath);
    let total: number | null = null;
    for (const path of paths) {
      const w = worktrees.get(path);
      const bytes = w === undefined ? null : diskBytesOf(w);
      if (bytes !== null) total = (total ?? 0) + bytes;
    }
    return total;
  };
  const firstOwner = (g: ProcessTypeGroup): string | null => {
    const names = g.members
      .map((p) => ownerNameOf(p, worktrees))
      .filter((n): n is string => n !== null)
      .sort((a, b) => a.localeCompare(b));
    return names[0] ?? null;
  };
  const copy = [...groups];
  switch (key) {
    case 'cpu':
      return copy.sort((a, b) => sumOf(b, cpuOf) - sumOf(a, cpuOf) || typeRank(a) - typeRank(b));
    case 'mem':
      return copy.sort((a, b) => sumOf(b, memOf) - sumOf(a, memOf) || typeRank(a) - typeRank(b));
    case 'disk':
      return copy.sort((a, b) => compareDiskDesc(diskOf(a), diskOf(b)) || typeRank(a) - typeRank(b));
    case 'owner':
      return copy.sort((a, b) => compareOwnerNames(firstOwner(a), firstOwner(b)) || typeRank(a) - typeRank(b));
  }
}

function isActionable(p: SystemProcess): p is SystemActionableProcess {
  return p.bucket !== 'foreign';
}

function groupByPath(processes: readonly SystemProcess[]): Map<string, SystemProcess[]> {
  const map = new Map<string, SystemProcess[]>();
  for (const p of processes) {
    if (p.worktreePath === null) continue;
    const list = map.get(p.worktreePath);
    if (list === undefined) map.set(p.worktreePath, [p]);
    else list.push(p);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

const BADGE = 'eyebrow inline-flex items-center rounded-button border px-1.5 py-0.5 text-[10px] font-medium';
const BADGE_NEUTRAL = `${BADGE} border-border-primary text-text-secondary`;
const BUTTON =
  'inline-flex items-center rounded-button border border-border-primary bg-bg-primary px-2 py-1 font-mono text-[11px] text-text-secondary transition-colors hover:border-border-emphasized hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50';
const BUTTON_DANGER =
  'inline-flex items-center rounded-button border border-status-error/50 bg-status-error/10 px-2 py-1 font-mono text-[11px] text-status-error transition-colors hover:bg-status-error/20 disabled:cursor-not-allowed disabled:opacity-50';

/** "Suspected" chip — the marker the Orphans section reuses. */
export function SuspectedBadge(): ReactElement {
  return (
    <span
      data-testid="suspected-badge"
      title="Cyboflow-shaped ancestry but no spawn marker — not verified as ours"
      className={`${BADGE} border-dashed border-status-warning/60 bg-status-warning/10 text-status-warning`}
    >
      Suspected
    </span>
  );
}

/**
 * A dashed, labelled tier for suspected rows. Rendered as its own block so a
 * suspected row can never be read as a confirmed one.
 */
export function SuspectedTier({ children, className = '' }: { children: ReactNode; className?: string }): ReactElement {
  return (
    <div
      data-testid="suspected-tier"
      className={`border-t border-dashed border-status-warning/60 bg-status-warning/5 ${className}`}
    >
      <div className="flex items-center gap-2 px-3.5 py-1.5">
        <SuspectedBadge />
        <span className="text-[10px] text-text-tertiary">cyboflow-shaped, no spawn marker — unverified, kill with care</span>
      </div>
      {children}
    </div>
  );
}

function DiskFigure({ usage }: { usage: SystemWorktree['usage'] }): ReactElement {
  switch (usage.status) {
    case 'measured':
      return (
        <span data-testid="wt-disk" data-state="measured">
          {formatManifestBytes(usage.bytes)}
        </span>
      );
    case 'measuring':
      return (
        <span
          role="status"
          aria-label="Measuring disk usage"
          data-testid="wt-disk"
          data-state="measuring"
          className="inline-flex items-center gap-1"
        >
          <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          measuring…
        </span>
      );
    case 'queued':
      return (
        <span
          role="status"
          aria-label="Disk usage queued for measurement"
          data-testid="wt-disk"
          data-state="queued"
          className="inline-block h-3 w-14 animate-pulse motion-reduce:animate-none rounded-button bg-bg-secondary align-middle"
        />
      );
    case 'unsupported':
      return (
        <span data-testid="wt-disk" data-state="unsupported" title={usage.reason}>
          n/a
        </span>
      );
  }
}

const ROW_GRID = 'grid grid-cols-[76px_minmax(0,1.4fr)_minmax(0,1.6fr)_56px_56px_64px_auto] items-center gap-2 px-3.5';

function OpenButton({ process, projectId }: { process: SystemActionableProcess; projectId: number }): ReactElement | null {
  const owner = process.owner;
  if (owner === null) return null;
  if (owner.kind === 'cli') {
    return (
      <button type="button" data-testid={`open-session-proc-${process.pid}`} className={BUTTON} onClick={() => openSystemSession(owner.sessionId, projectId)}>
        Open session
      </button>
    );
  }
  return (
    <button type="button" data-testid={`open-run-proc-${process.pid}`} className={BUTTON} onClick={() => openSystemRun(owner.runId, projectId)}>
      Open run
    </button>
  );
}

interface ProcessRowProps {
  process: SystemProcess;
  projectId: number;
  /** When set, the middle column names the owning worktree instead of the type/pid detail. */
  worktreeNames?: ReadonlyMap<string, string>;
  handlers: SystemActionHandlers;
}

function ProcessRow({ process, projectId, worktreeNames, handlers }: ProcessRowProps): ReactElement {
  const m = metricsOf(process);
  const foreign = process.bucket === 'foreign';
  const idLabel = process.bucket === 'foreign' ? process.pidLabel : `pid ${process.pid}`;

  let detail: ReactNode;
  if (worktreeNames !== undefined) {
    const owning = process.worktreePath === null ? undefined : worktreeNames.get(process.worktreePath);
    detail =
      owning !== undefined ? (
        <span data-testid="proc-owning-worktree" title={process.worktreePath ?? undefined}>{owning}</span>
      ) : process.bucket === 'orphan' ? (
        <span data-testid="proc-owning-worktree" className="text-status-warning">none — orphaned</span>
      ) : (
        <span data-testid="proc-owning-worktree" className="text-text-tertiary">none</span>
      );
  } else {
    detail = (
      <span className="flex flex-wrap items-center gap-1.5">
        <span className={BADGE_NEUTRAL}>{TYPE_LABEL[process.processType]}</span>
        <span className="text-text-tertiary">{idLabel}</span>
      </span>
    );
  }

  return (
    <div
      role="row"
      data-testid="proc-row"
      data-bucket={process.bucket}
      className={`${ROW_GRID} border-t border-border-primary/60 py-1.5 text-xs text-text-secondary`}
    >
      <span><KindTag kind="process" /></span>
      <span className="min-w-0 truncate font-medium text-text-primary" title={process.command}>
        {processName(process.command)}
        {worktreeNames !== undefined && <span className="ml-1.5 font-normal text-text-tertiary">{idLabel}</span>}
      </span>
      <span className="min-w-0 truncate">{detail}</span>
      <span data-testid="proc-cpu" className={`text-right ${m.hot ? 'text-status-warning' : ''}`}>{m.cpu}</span>
      <span className="text-right">{m.mem}</span>
      <span className="text-right">{m.up}</span>
      <span className="flex items-center justify-end gap-1.5">
        {foreign ? (
          <span data-testid="proc-readonly" title="Owned by another program or instance — cyboflow will not touch it" className={BADGE_NEUTRAL}>
            Foreign · read-only
          </span>
        ) : (
          <>
            {process.bucket === 'suspected' && <SuspectedBadge />}
            <OpenButton process={process} projectId={projectId} />
            {handlers.onKillTree !== undefined && (
              <button
                type="button"
                data-testid={`kill-tree-${process.pid}`}
                className={BUTTON_DANGER}
                onClick={() => handlers.onKillTree?.(process)}
              >
                Kill tree
              </button>
            )}
          </>
        )}
      </span>
    </div>
  );
}

function ProcessTableHead({ detailLabel }: { detailLabel: string }): ReactElement {
  return (
    <div role="row" className={`${ROW_GRID} py-1.5 text-[10px] uppercase tracking-wide text-text-tertiary`}>
      <span />
      <span>Process</span>
      <span>{detailLabel}</span>
      <span className="text-right">CPU</span>
      <span className="text-right">Mem</span>
      <span className="text-right">Up</span>
      <span />
    </div>
  );
}

interface ProcessTableProps {
  processes: SystemProcess[];
  sortBy: SystemSortKey;
  projectId: number;
  worktreeNames?: ReadonlyMap<string, string>;
  /** Owning-worktree lookup so Disk / Owner sorting has meaning (By process type). */
  worktreesByPath?: WorktreesByPath;
  handlers: SystemActionHandlers;
}

/** The nested table: confirmed rows, then the suspected tier, then foreign rows (read-only). */
function ProcessTable({ processes, sortBy, projectId, worktreeNames, worktreesByPath, handlers }: ProcessTableProps): ReactElement {
  const sorted = sortProcesses(processes, sortBy, worktreesByPath);
  const confirmed = sorted.filter((p) => p.bucket === 'owned' || p.bucket === 'orphan');
  const suspected = sorted.filter((p) => p.bucket === 'suspected');
  const foreign = sorted.filter((p) => p.bucket === 'foreign');
  const row = (p: SystemProcess, i: number): ReactElement => (
    <ProcessRow
      key={p.bucket === 'foreign' ? `foreign-${p.pidLabel}-${i}` : `pid-${p.pid}`}
      process={p}
      projectId={projectId}
      worktreeNames={worktreeNames}
      handlers={handlers}
    />
  );
  return (
    <div role="table" data-testid="proc-table">
      <ProcessTableHead detailLabel={worktreeNames === undefined ? 'Detail' : 'Owning worktree'} />
      {confirmed.map(row)}
      {suspected.length > 0 && <SuspectedTier>{suspected.map(row)}</SuspectedTier>}
      {foreign.map(row)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// By worktree
// ---------------------------------------------------------------------------

interface WorktreeCardProps {
  worktree: SystemWorktree;
  processes: SystemProcess[];
  sortBy: SystemSortKey;
  projectId: number;
  handlers: SystemActionHandlers;
}

function WorktreeCard({ worktree, processes, sortBy, projectId, handlers }: WorktreeCardProps): ReactElement {
  const name = basename(worktree.path);
  const killable = processes.filter(isActionable);
  return (
    <div data-testid="wt-card" data-worktree={worktree.path} className="rounded-card border border-border-primary bg-card-bg shadow-sm">
      <div className="flex items-start gap-3 px-3.5 py-3">
        <KindTag kind="worktree" variant="tile" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <KindTag kind="worktree" />
            <span data-testid="wt-name" className="truncate text-sm font-bold text-text-primary" title={worktree.path}>{name}</span>
            <span data-testid="wt-owner" className={BADGE_NEUTRAL}>{OWNER_LABEL[worktree.tag]}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-text-secondary">
            <span><span className="text-text-tertiary">branch</span> {worktree.branch}</span>
            <span><span className="text-text-tertiary">disk</span> <DiskFigure usage={worktree.usage} /></span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {worktree.sessionId !== undefined && (
            <button
              type="button"
              data-testid="wt-open-session"
              className={BUTTON}
              onClick={() => worktree.sessionId !== undefined && openSystemSession(worktree.sessionId, projectId)}
            >
              Open session
            </button>
          )}
          {worktree.runId !== undefined && (
            <button
              type="button"
              data-testid="wt-open-run"
              className={BUTTON}
              onClick={() => worktree.runId !== undefined && openSystemRun(worktree.runId, projectId)}
            >
              Open run
            </button>
          )}
        </div>
      </div>
      {processes.length > 0 && (
        <ProcessTable processes={processes} sortBy={sortBy} projectId={projectId} handlers={handlers} />
      )}
      {(handlers.onKillAll !== undefined || handlers.onPruneWorktree !== undefined) && (
        <div className="flex justify-end gap-2 border-t border-border-primary px-3.5 py-2">
          {handlers.onKillAll !== undefined && (
            <button
              type="button"
              data-testid="wt-kill-all"
              className={BUTTON_DANGER}
              disabled={killable.length === 0}
              onClick={() => handlers.onKillAll?.(killable, { kind: 'worktree', label: name })}
            >
              Kill all processes
            </button>
          )}
          {handlers.onPruneWorktree !== undefined && (
            <button
              type="button"
              data-testid="wt-prune"
              className={BUTTON_DANGER}
              disabled={!worktree.prunable}
              title={worktree.prunable ? undefined : 'Your real checkout — it can never be pruned'}
              onClick={() => handlers.onPruneWorktree?.(worktree)}
            >
              Prune worktree
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ByWorktree({
  snapshot,
  sortBy,
  projectId,
  handlers,
}: {
  snapshot: SystemSnapshotData;
  sortBy: SystemSortKey;
  projectId: number;
  handlers: SystemActionHandlers;
}): ReactElement {
  const cards = snapshot.worktrees.filter((w) => w.tag !== 'orphan');
  const cardPaths = new Set(cards.map((w) => w.path));
  // Orphan-bucket processes belong to the Orphans section.
  const shown = snapshot.processes.filter((p) => p.bucket !== 'orphan');
  const byPath = groupByPath(shown);
  const unattributed = shown.filter((p) => p.worktreePath === null || !cardPaths.has(p.worktreePath));
  const ordered = sortWorktrees(cards, byPath, sortBy);
  const nestedCount = shown.length - unattributed.length;

  return (
    <section data-testid="system-by-worktree" className="px-7 py-5">
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="eyebrow text-text-tertiary">Active worktrees</h2>
        <span data-testid="system-worktrees-count" className="text-[11px] text-text-tertiary">
          {cards.length} owned · {nestedCount} processes
        </span>
      </div>
      {cards.length === 0 && unattributed.length === 0 ? (
        <div data-testid="system-body-empty" className="text-sm text-text-tertiary">
          No active worktrees or processes.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {ordered.map((w) => (
            <WorktreeCard
              key={w.path}
              worktree={w}
              processes={(byPath.get(w.path) ?? []).filter((p) => p.bucket !== 'orphan')}
              sortBy={sortBy}
              projectId={projectId}
              handlers={handlers}
            />
          ))}
          {unattributed.length > 0 && (
            <div data-testid="unattributed-card" className="rounded-card border border-border-primary bg-card-bg shadow-sm">
              <div className="flex items-center gap-3 px-3.5 py-3">
                <KindTag kind="process" variant="tile" />
                <div>
                  <div className="text-sm font-bold text-text-primary">Unattributed processes</div>
                  <div className="text-[11px] text-text-tertiary">Not resolved to any listed worktree</div>
                </div>
              </div>
              <ProcessTable processes={unattributed} sortBy={sortBy} projectId={projectId} handlers={handlers} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// By process type
// ---------------------------------------------------------------------------

function ByProcessType({
  snapshot,
  sortBy,
  projectId,
  handlers,
}: {
  snapshot: SystemSnapshotData;
  sortBy: SystemSortKey;
  projectId: number;
  handlers: SystemActionHandlers;
}): ReactElement {
  const worktreeNames = new Map(snapshot.worktrees.map((w) => [w.path, basename(w.path)] as const));
  const worktreesByPath: WorktreesByPath = new Map(snapshot.worktrees.map((w) => [w.path, w] as const));
  const groups = sortTypeGroups(
    TYPE_ORDER.map((type) => ({
      type,
      members: snapshot.processes.filter((p) => p.processType === type),
    })).filter((g) => g.members.length > 0),
    sortBy,
    worktreesByPath,
  );

  return (
    <section data-testid="system-by-process-type" className="px-7 py-5">
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="eyebrow text-text-tertiary">Processes by type</h2>
        <span className="text-[11px] text-text-tertiary">{snapshot.processes.length} processes</span>
      </div>
      {groups.length === 0 ? (
        <div data-testid="system-body-empty" className="text-sm text-text-tertiary">
          No processes.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map(({ type, members }) => {
            const killable = members.filter(isActionable);
            const cpu = members.reduce((acc, p) => acc + cpuOf(p), 0);
            const mem = members.reduce((acc, p) => acc + memOf(p), 0);
            return (
              <div
                key={type}
                data-testid={`type-group-${type}`}
                className="rounded-card border border-border-primary bg-card-bg shadow-sm"
              >
                <div className="flex items-center gap-3 px-3.5 py-3">
                  <KindTag kind="process" variant="tile" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-text-primary">{TYPE_LABEL[type]}</div>
                    <div data-testid={`type-aggregate-${type}`} className="text-[11px] text-text-secondary">
                      {members.length} {members.length === 1 ? 'process' : 'processes'} · {cpu.toFixed(1)}% CPU · {mem.toFixed(1)}% mem
                    </div>
                  </div>
                  {handlers.onKillAll !== undefined && (
                    <button
                      type="button"
                      data-testid={`type-kill-all-${type}`}
                      className={BUTTON_DANGER}
                      disabled={killable.length === 0}
                      onClick={() => handlers.onKillAll?.(killable, { kind: 'type', label: TYPE_LABEL[type] })}
                    >
                      Kill all ({killable.length})
                    </button>
                  )}
                </div>
                <ProcessTable
                  processes={members}
                  sortBy={sortBy}
                  projectId={projectId}
                  worktreeNames={worktreeNames}
                  worktreesByPath={worktreesByPath}
                  handlers={handlers}
                />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export interface SystemGroupedBodyProps extends SystemActionHandlers {
  snapshot: SystemSnapshotData;
  projectId: number;
  groupBy: SystemGroupBy;
  sortBy: SystemSortKey;
}

export function SystemGroupedBody({
  snapshot,
  projectId,
  groupBy,
  sortBy,
  onKillTree,
  onKillAll,
  onPruneWorktree,
}: SystemGroupedBodyProps): ReactElement {
  const handlers: SystemActionHandlers = { onKillTree, onKillAll, onPruneWorktree };
  return groupBy === 'worktree' ? (
    <ByWorktree snapshot={snapshot} sortBy={sortBy} projectId={projectId} handlers={handlers} />
  ) : (
    <ByProcessType snapshot={snapshot} sortBy={sortBy} projectId={projectId} handlers={handlers} />
  );
}
