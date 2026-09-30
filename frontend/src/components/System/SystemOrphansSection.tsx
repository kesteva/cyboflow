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
import type { ReactElement } from 'react';
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

const ROW =
  'flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-border-primary/60 px-3.5 py-1.5 text-xs text-text-secondary';

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

function WorktreeRow({ worktree }: { worktree: SystemWorktree }): ReactElement {
  return (
    <div data-testid="orphan-wt-row" data-worktree={worktree.path} className={ROW}>
      <KindTag kind="worktree" />
      <span className="min-w-0 truncate font-medium text-text-primary" title={worktree.path}>
        {basename(worktree.path)}
      </span>
      <span className="text-text-tertiary">branch {worktree.branch}</span>
      <span className="ml-auto text-text-tertiary">
        disk <DiskFigure usage={worktree.usage} />
      </span>
    </div>
  );
}

function ProcessRow({ process }: { process: ManagedProcess }): ReactElement {
  return (
    <div data-testid="orphan-proc-row" data-bucket={process.bucket} className={ROW}>
      <KindTag kind="process" />
      <span className="min-w-0 truncate font-medium text-text-primary" title={process.command}>
        {processName(process.command)}
      </span>
      <span className="text-text-tertiary">pid {process.pid}</span>
      <span className="ml-auto flex gap-3 text-text-tertiary">
        <span>{formatPercent(process.pcpu)} CPU</span>
        <span>{formatPercent(process.pmem)} mem</span>
        <span>up {formatElapsed(process.etimeSeconds)}</span>
      </span>
    </div>
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
  return (
    <div className="flex items-center gap-3 px-3.5 py-3">
      <KindTag kind={kind} variant="tile" />
      <div className="min-w-0">
        <h3 className="text-sm font-bold text-text-primary">{title}</h3>
        <div data-testid={testId} className="text-[11px] text-text-secondary">
          {summary}
        </div>
      </div>
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
        <h2 className="eyebrow text-text-tertiary">Orphans — reclaim</h2>
        <span data-testid="orphans-count" className="text-[11px] text-text-tertiary">
          {staleWorktrees.length} wt · {orphanProcesses.length} proc
        </span>
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
