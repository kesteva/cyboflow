/**
 * SystemView — the live process & worktree monitor (design IDEA-037).
 *
 * A full-width center pane over `cyboflow.system.snapshot`, polled by
 * {@link useSystemSnapshot}. This is the shell: the header plus the toolbar
 * strip of four stat tiles (Worktrees, Processes, Disk used, Orphans). The
 * grouped body, ports and orphan sections mount beneath the toolbar in their
 * own tasks.
 *
 * The Disk-used tile renders exactly one of three states, because disk sizing
 * runs off the poll loop (lazy, staggered, concurrency 1) and a figure is never
 * simply "there":
 *   - measured  — every worktree is sized: the summed value
 *   - measuring — a `du` is in flight: a spinner, no partial total
 *   - queued    — waiting on the queue: a pulsing skeleton bar
 * An unmeasured worktree is NEVER summed in or rendered as "0 MB".
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { API } from '../../utils/api';
import type { Project } from '../../types/project';
import { useNavigationStore } from '../../stores/navigationStore';
import { useSystemSnapshot, type SystemSnapshotData } from '../../hooks/useSystemSnapshot';
import {
  getSystemGroupByPreference,
  setSystemGroupByPreference,
  type SystemGroupBy,
} from '../../utils/systemGroupBy';
import {
  SYSTEM_SORT_OPTIONS,
  SystemGroupedBody,
  type SystemActionableProcess,
  type SystemSortKey,
} from '../System/SystemGroupedBody';
import { SystemOrphansSection } from '../System/SystemOrphansSection';
import { useProcessReap } from '../System/useProcessReap';
import { useWorktreeReap, WorktreeReapError } from '../System/useWorktreeReap';
import { SystemPortsSection } from './SystemPortsSection';

const REFRESH_INTERVAL_MS = 2500;

/** What the Disk-used tile shows; `total` exists only in the `measured` state. */
export type DiskTileState =
  | { state: 'measured'; total: number; done: number; of: number }
  | { state: 'measuring'; done: number; of: number }
  | { state: 'queued'; done: number; of: number }
  | { state: 'unsupported'; reason: string };

/** Fold the per-worktree tri-state into the tile's single state. Pure. */
export function summarizeDisk(snapshot: SystemSnapshotData): DiskTileState {
  const { diskSizing } = snapshot.capabilities;
  if (!diskSizing.supported) return { state: 'unsupported', reason: diskSizing.reason };

  let total = 0;
  let done = 0;
  let measuring = false;
  for (const wt of snapshot.worktrees) {
    if (wt.usage.status === 'measured') {
      total += wt.usage.bytes;
      done += 1;
    } else if (wt.usage.status === 'measuring') {
      measuring = true;
    }
  }
  const of = snapshot.worktrees.length;
  if (done === of) return { state: 'measured', total, done, of };
  return { state: measuring ? 'measuring' : 'queued', done, of };
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Human-readable size (1024-based). Only ever called with a measured value. */
export function formatDiskBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

interface StatTileProps {
  testId: string;
  label: string;
  tone?: 'default' | 'warning';
  children: React.ReactNode;
  sub?: React.ReactNode;
}

function StatTile({ testId, label, tone = 'default', children, sub }: StatTileProps): ReactElement {
  const toneClass =
    tone === 'warning'
      ? 'border-status-warning/40 bg-status-warning/10'
      : 'border-border-primary bg-bg-primary';
  return (
    <div data-testid={testId} className={`min-w-[150px] flex-1 rounded-card border px-3.5 py-2.5 ${toneClass}`}>
      <div className="eyebrow text-text-tertiary">{label}</div>
      <div className="mt-1 font-mono text-lg font-bold leading-tight text-text-primary">{children}</div>
      {sub !== undefined && <div className="mt-0.5 text-[10px] text-text-tertiary">{sub}</div>}
    </div>
  );
}

function DiskTile({ disk }: { disk: DiskTileState | null }): ReactElement {
  if (disk === null || disk.state === 'queued') {
    // Pulsing skeleton — the app's `animate-pulse` loading idiom.
    return (
      <StatTile
        testId="system-tile-disk"
        label={disk === null ? 'Disk used' : `Disk · ${disk.done} of ${disk.of}`}
        sub="queued"
      >
        <div
          role="status"
          aria-label="Disk usage queued for measurement"
          data-testid="system-disk-queued"
          data-state="queued"
          className="mt-1.5 h-4 w-20 animate-pulse motion-reduce:animate-none rounded-button bg-bg-secondary"
        />
      </StatTile>
    );
  }
  if (disk.state === 'measuring') {
    return (
      <StatTile testId="system-tile-disk" label={`Disk · ${disk.done} of ${disk.of}`} sub="staggered, one at a time">
        <span
          role="status"
          aria-label="Measuring disk usage"
          data-testid="system-disk-measuring"
          data-state="measuring"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          measuring…
        </span>
      </StatTile>
    );
  }
  if (disk.state === 'unsupported') {
    return (
      <StatTile testId="system-tile-disk" label="Disk used" sub={disk.reason}>
        <span data-testid="system-disk-unsupported" data-state="unsupported" className="text-sm font-medium text-text-tertiary">
          not supported
        </span>
      </StatTile>
    );
  }
  return (
    <StatTile testId="system-tile-disk" label="Disk used" sub={`${disk.of} worktree${disk.of === 1 ? '' : 's'} measured`}>
      <span data-testid="system-disk-measured" data-state="measured">
        {disk.of === 0 ? '—' : formatDiskBytes(disk.total)}
      </span>
    </StatTile>
  );
}

const GROUP_BY_OPTIONS: ReadonlyArray<{ value: SystemGroupBy; label: string }> = [
  { value: 'worktree', label: 'By worktree' },
  { value: 'process-type', label: 'By process type' },
];

export function SystemView(): ReactElement {
  // Hydrated from the persisted preference on mount; defaults to "By worktree".
  const [groupBy, setGroupBy] = useState<SystemGroupBy>(() => getSystemGroupByPreference());
  const [sortBy, setSortBy] = useState<SystemSortKey>('disk');
  const activeProjectId = useNavigationStore((s) => s.activeProjectId);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | null>(activeProjectId);

  useEffect(() => {
    let active = true;
    void API.projects
      .getAll()
      .then((res) => {
        if (!active) return;
        if (res.success && Array.isArray(res.data)) {
          const list = res.data as Project[];
          setProjects(list);
          setProjectId((cur) => cur ?? list[0]?.id ?? null);
        }
      })
      .catch(() => {
        // Non-fatal: keep rendering with whatever project is selected.
      });
    return () => {
      active = false;
    };
  }, []);

  // Mounted only while the System pane is the center surface, so polling is
  // inherently gated on visibility: closing the view unmounts it and stops `ps`.
  const { snapshot, isLoading, error, refetch, lastUpdatedAt } = useSystemSnapshot({
    projectId,
    refetchIntervalMs: REFRESH_INTERVAL_MS,
  });

  // Destructive worktree actions (Prune, Reap all stale): resolve → confirm → execute
  // against the monitorReap contract, refreshing the snapshot after every attempt.
  const worktreeReap = useWorktreeReap({ projectId, onSettled: refetch });
  const staleWorktrees = snapshot?.worktrees.filter((w) => w.tag === 'orphan' && w.prunable) ?? [];

  // Destructive process actions (Kill tree / Kill all / process half of Reap all stale).
  const processReap = useProcessReap({ projectId, onSettled: refetch });
  const orphanProcessRows =
    snapshot?.processes.filter((p): p is SystemActionableProcess => p.bucket === 'orphan') ?? [];
  const staleCount = staleWorktrees.length + orphanProcessRows.length;

  // Ticks once a second so "Updated Ns ago" advances between the 2.5s polls.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const updatedAgoSeconds =
    lastUpdatedAt === null ? null : Math.max(0, Math.floor((now - lastUpdatedAt) / 1000));

  const orphanWorktrees = snapshot?.worktrees.filter((w) => w.tag === 'orphan').length ?? 0;
  const orphanProcesses = snapshot?.processes.filter((p) => p.bucket === 'orphan').length ?? 0;

  return (
    <div data-testid="system-view" className="flex h-full w-full flex-col overflow-hidden bg-bg-primary font-mono">
      <div className="flex items-center gap-3 border-b border-border-primary bg-bg-secondary px-7 py-4">
        <div className="min-w-0">
          <div className="eyebrow text-text-tertiary">System · live process &amp; worktree monitor</div>
          <h2 className="text-base font-bold text-text-primary">System</h2>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {updatedAgoSeconds !== null && (
            <span data-testid="system-updated" className="text-[11px] text-text-tertiary">
              Updated {updatedAgoSeconds}s ago
            </span>
          )}
          <span className="eyebrow rounded-button border border-border-primary px-1.5 py-0.5 text-[10px] text-text-secondary">
            Auto-refresh · {REFRESH_INTERVAL_MS / 1000}s
          </span>
          <button
            type="button"
            data-testid="system-refresh"
            aria-label="Refresh system snapshot"
            disabled={projectId === null}
            onClick={refetch}
            className="inline-flex items-center gap-1.5 rounded-button border border-border-primary bg-bg-primary px-2.5 py-1 font-mono text-xs text-text-secondary transition-colors hover:border-border-emphasized hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
            Refresh
          </button>
          <label className="flex items-center gap-2">
            <span className="eyebrow text-text-tertiary">Project</span>
            <select
              data-testid="system-project-filter"
              aria-label="Choose the project to monitor"
              value={projectId === null ? '' : String(projectId)}
              onChange={(e) => setProjectId(e.target.value === '' ? null : Number(e.target.value))}
              className="rounded-button border border-border-primary bg-bg-primary px-2.5 py-1 font-mono text-xs text-text-secondary transition-colors hover:border-border-emphasized hover:text-text-primary focus:border-border-emphasized focus:outline-none"
            >
              {projectId === null && <option value="">Select a project…</option>}
              {projects.map((project) => (
                <option key={project.id} value={String(project.id)}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {error !== null && (
        <div
          data-testid="system-error"
          className="border-b border-border-primary bg-status-error/10 px-7 py-2 text-xs text-status-error"
        >
          Failed to refresh the system snapshot: {error.message}
        </div>
      )}

      {worktreeReap.error !== null && (
        <WorktreeReapError error={worktreeReap.error} onDismiss={worktreeReap.clearError} />
      )}
      {worktreeReap.dialog}
      {processReap.overlay}

      <div className="flex-1 overflow-y-auto">
        {projectId === null ? (
          <div data-testid="system-no-project" className="px-7 py-5 text-sm text-text-tertiary">
            Select a project to monitor its processes and worktrees.
          </div>
        ) : (
          <>
            <div
              data-testid="system-toolbar"
              className="flex flex-wrap items-center gap-3 border-b border-border-primary px-7 py-4"
            >
              {snapshot === null && isLoading ? (
                [0, 1, 2, 3].map((i) => (
                  <div
                    key={i}
                    data-testid="system-tile-loading"
                    className="h-[68px] min-w-[150px] flex-1 animate-pulse motion-reduce:animate-none rounded-card bg-bg-secondary"
                  />
                ))
              ) : (
                <>
                  <StatTile testId="system-tile-worktrees" label="Worktrees">
                    {snapshot?.worktrees.length ?? 0}
                  </StatTile>
                  <StatTile testId="system-tile-processes" label="Processes">
                    {snapshot?.processes.length ?? 0}
                  </StatTile>
                  <DiskTile disk={snapshot === null ? null : summarizeDisk(snapshot)} />
                  <StatTile
                    testId="system-tile-orphans"
                    label="Orphans"
                    tone="warning"
                    sub={`${orphanWorktrees} wt · ${orphanProcesses} proc`}
                  >
                    {orphanWorktrees + orphanProcesses}
                  </StatTile>
                </>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-4 border-b border-border-primary px-7 py-3">
              <div
                role="radiogroup"
                aria-label="Group by"
                data-testid="system-groupby"
                className="inline-flex overflow-hidden rounded-button border border-border-primary"
              >
                {GROUP_BY_OPTIONS.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={groupBy === value}
                    data-testid={`system-groupby-${value}`}
                    onClick={() => {
                      setGroupBy(value);
                      setSystemGroupByPreference(value);
                    }}
                    className={`px-3 py-1 font-mono text-xs transition-colors ${
                      groupBy === value
                        ? 'bg-bg-secondary font-bold text-text-primary'
                        : 'bg-bg-primary text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-2">
                <span className="eyebrow text-text-tertiary">Sort</span>
                <select
                  data-testid="system-sort"
                  aria-label="Sort by"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SystemSortKey)}
                  className="rounded-button border border-border-primary bg-bg-primary px-2.5 py-1 font-mono text-xs text-text-secondary transition-colors hover:border-border-emphasized hover:text-text-primary focus:border-border-emphasized focus:outline-none"
                >
                  {SYSTEM_SORT_OPTIONS.map(({ key, label }) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                data-testid="system-reap-all-stale"
                disabled={staleCount === 0 || worktreeReap.busy || processReap.busy}
                onClick={() => {
                  // One click, both halves: each resolves its own manifest and opens its own confirm.
                  if (orphanProcessRows.length > 0) processReap.reapAllStale(orphanProcessRows);
                  if (staleWorktrees.length > 0) worktreeReap.reapAllStale(staleWorktrees);
                }}
                className="ml-auto inline-flex items-center gap-1.5 rounded-button border border-status-error/40 bg-status-error/10 px-2.5 py-1 font-mono text-xs font-bold text-status-error transition-colors hover:bg-status-error/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Reap all stale{staleCount > 0 ? ` (${staleCount})` : ''}
              </button>
            </div>
            {snapshot !== null && (
              <SystemPortsSection ports={snapshot.ports} />
            )}
            {snapshot !== null && <SystemOrphansSection snapshot={snapshot} />}
            {snapshot !== null && (
              <SystemGroupedBody
                snapshot={snapshot}
                projectId={projectId}
                groupBy={groupBy}
                sortBy={sortBy}
                onPruneWorktree={worktreeReap.prune}
                onKillTree={processReap.handlers.onKillTree}
                onKillAll={processReap.handlers.onKillAll}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
