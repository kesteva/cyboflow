/**
 * SystemOrphansSection — the read-only "Orphans — reclaim" inventory of the
 * System view (design IDEA-037), placed above the active worktrees because
 * reaping is the view's primary job.
 *
 * Two labelled subgroups keep the reap backlog from mixing kinds:
 *   - Stale worktrees      — registry entries tagged `orphan` (in git, no owner row)
 *   - Orphaned processes   — `orphan`-bucket processes (spawned by a dead instance)
 *
 * Processes that are only *suspected* (cyboflow-shaped ancestry, no spawn marker)
 * and not attributed to a live worktree render in the shared {@link SuspectedTier}
 * beneath the confirmed orphans, never interleaved with them.
 *
 * Inventory only: destructive reclaim (Prune / Kill tree / Reap all stale) is wired
 * onto this list by a later epic, so this section renders no button of any kind —
 * not a disabled one, not a placeholder.
 */
import { AlertTriangle, Cpu, Folder } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import type { SystemSnapshotData } from '../../hooks/useSystemSnapshot';
import { KindTag } from '../cyboflow/KindTag';
import { formatManifestBytes } from './formatManifestBytes';
import {
  DiskFigure,
  SuspectedTier,
  basename,
  formatElapsed,
  processName,
  type SystemProcess,
  type SystemWorktree,
} from './SystemGroupedBody';

type ManagedProcess = Exclude<SystemProcess, { bucket: 'foreign' }>;

const CARD = 'border-t border-status-warning/40 bg-status-warning/5 px-3.5 py-3';
const BADGE = 'eyebrow inline-flex items-center rounded-button border px-1.5 py-0.5 text-[10px] font-medium';
const BADGE_WARN = `${BADGE} border-status-warning/40 bg-status-warning/10 text-status-warning`;

function formatPercent(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`;
}

/**
 * Sum of the measured worktree sizes. An unmeasured worktree is never counted as
 * zero: the caller labels a partial total instead.
 */
function measuredTotal(worktrees: SystemWorktree[]): { bytes: number; measured: number } {
  let bytes = 0;
  let measured = 0;
  for (const w of worktrees) {
    if (w.usage.status === 'measured') {
      bytes += w.usage.bytes;
      measured += 1;
    }
  }
  return { bytes, measured };
}

function Stat({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="eyebrow text-[10px] text-text-tertiary">{label}</span>
      <span>{children}</span>
    </span>
  );
}

/** One orphan card: kind tile, title row, owner line, stats — inventory only, no controls. */
function OrphanCard({
  testId,
  attrs,
  kind,
  name,
  nameTitle,
  badge,
  owner,
  children,
}: {
  testId: string;
  attrs: Record<string, string>;
  kind: 'worktree' | 'process';
  name: string;
  nameTitle: string;
  badge: string;
  owner: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div data-testid={testId} {...attrs} className={CARD}>
      <div className="flex items-start gap-3">
        <KindTag kind={kind} variant="tile" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <KindTag kind={kind} />
            <span className="min-w-0 truncate text-xs font-bold text-text-primary" title={nameTitle}>
              {name}
            </span>
            <span data-testid="orphan-badge" className={BADGE_WARN}>
              {badge}
            </span>
          </div>
          <div data-testid="orphan-owner" className="mt-1 text-[11px] text-text-secondary">
            {owner}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-text-secondary">{children}</div>
        </div>
      </div>
    </div>
  );
}

function WorktreeRow({ worktree }: { worktree: SystemWorktree }): ReactElement {
  return (
    <OrphanCard
      testId="orphan-wt-row"
      attrs={{ 'data-worktree': worktree.path }}
      kind="worktree"
      name={worktree.path}
      nameTitle={worktree.path}
      badge="Orphan"
      owner="No owning session or run"
    >
      <Stat label="branch">{worktree.branch}</Stat>
      <Stat label="disk">
        <DiskFigure usage={worktree.usage} />
      </Stat>
    </OrphanCard>
  );
}

function ProcessRow({ process }: { process: ManagedProcess }): ReactElement {
  const owner =
    process.worktreePath === null
      ? 'No owning worktree'
      : `Its worktree ${basename(process.worktreePath)} no longer exists`;
  return (
    <OrphanCard
      testId="orphan-proc-row"
      attrs={{ 'data-bucket': process.bucket }}
      kind="process"
      name={processName(process.command)}
      nameTitle={process.command}
      badge={process.bucket === 'suspected' ? 'Suspected' : 'Orphan'}
      owner={owner}
    >
      <Stat label="pid">{process.pid}</Stat>
      <Stat label="cpu">{formatPercent(process.pcpu)}</Stat>
      <Stat label="mem">{formatPercent(process.pmem)}</Stat>
      <Stat label="up">{formatElapsed(process.etimeSeconds)}</Stat>
    </OrphanCard>
  );
}

function SubgroupHeader({
  testId,
  title,
  kind,
  summary,
}: {
  testId: string;
  title: string;
  kind: 'worktree' | 'process';
  summary: string;
}): ReactElement {
  const hue = kind === 'worktree' ? 'text-status-info' : 'text-[var(--color-phase-compound)]';
  const Icon = kind === 'worktree' ? Folder : Cpu;
  return (
    <div className={`flex items-center gap-2 px-3.5 py-3 ${hue}`}>
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <h3 className="eyebrow text-[11px] font-bold">{title}</h3>
      <span data-testid={testId} className="text-[11px] text-text-secondary">
        {summary}
      </span>
    </div>
  );
}

export interface SystemOrphansSectionProps {
  snapshot: SystemSnapshotData;
}

export function SystemOrphansSection({ snapshot }: SystemOrphansSectionProps): ReactElement {
  const staleWorktrees = snapshot.worktrees.filter((w) => w.tag === 'orphan');
  const liveWorktreePaths = new Set(snapshot.worktrees.filter((w) => w.tag !== 'orphan').map((w) => w.path));
  const orphanProcesses = snapshot.processes.filter(
    (p): p is ManagedProcess => p.bucket === 'orphan',
  );
  // Suspected rows with no live worktree to sit under would otherwise have no tier.
  const suspectedProcesses = snapshot.processes.filter(
    (p): p is ManagedProcess =>
      p.bucket === 'suspected' && (p.worktreePath === null || !liveWorktreePaths.has(p.worktreePath)),
  );

  const { bytes, measured } = measuredTotal(staleWorktrees);
  let wtSummary = `${staleWorktrees.length} stale`;
  if (measured > 0) {
    wtSummary +=
      measured === staleWorktrees.length
        ? ` · ${formatManifestBytes(bytes)} on disk`
        : ` · ${formatManifestBytes(bytes)} on disk (${measured} of ${staleWorktrees.length} measured)`;
  }

  const cpu = orphanProcesses.reduce((acc, p) => acc + (p.pcpu ?? 0), 0);
  const mem = orphanProcesses.reduce((acc, p) => acc + (p.pmem ?? 0), 0);
  const procSummary =
    orphanProcesses.length === 0
      ? '0 orphaned'
      : `${orphanProcesses.length} orphaned · ${cpu.toFixed(1)}% CPU · ${mem.toFixed(1)}% mem`;

  return (
    <section data-testid="system-orphans" className="px-7 py-5">
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="eyebrow text-status-warning">Orphans — reclaim</h2>
        <span data-testid="orphans-count" className="text-[11px] text-text-tertiary">
          {staleWorktrees.length} wt · {orphanProcesses.length} proc
        </span>
      </div>
      <div
        data-testid="orphan-reclaim-note"
        className="mb-3 flex items-center gap-2 rounded-card border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-xs text-text-secondary"
      >
        <AlertTriangle className="h-4 w-4 shrink-0 text-status-warning" aria-hidden="true" />
        No live session or run owns these — this is the reap backlog.
      </div>
      <div className="flex flex-col gap-3">
        <div data-testid="orphan-group-worktrees" className="rounded-card border border-status-warning/40 bg-card-bg shadow-sm">
          <SubgroupHeader testId="orphan-worktrees-summary" title="Stale worktrees" kind="worktree" summary={wtSummary} />
          {staleWorktrees.length === 0 ? (
            <div data-testid="orphan-worktrees-empty" className="border-t border-border-primary/60 px-3.5 py-2 text-xs text-text-tertiary">
              No stale worktrees.
            </div>
          ) : (
            staleWorktrees.map((w) => <WorktreeRow key={w.path} worktree={w} />)
          )}
        </div>
        <div data-testid="orphan-group-processes" className="rounded-card border border-status-warning/40 bg-card-bg shadow-sm">
          <SubgroupHeader testId="orphan-processes-summary" title="Orphaned processes" kind="process" summary={procSummary} />
          {orphanProcesses.length === 0 && suspectedProcesses.length === 0 ? (
            <div data-testid="orphan-processes-empty" className="border-t border-border-primary/60 px-3.5 py-2 text-xs text-text-tertiary">
              No orphaned processes.
            </div>
          ) : (
            <>
              {orphanProcesses.map((p) => (
                <ProcessRow key={`pid-${p.pid}`} process={p} />
              ))}
              {suspectedProcesses.length > 0 && (
                <SuspectedTier>
                  {suspectedProcesses.map((p) => (
                    <ProcessRow key={`pid-${p.pid}`} process={p} />
                  ))}
                </SuspectedTier>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
