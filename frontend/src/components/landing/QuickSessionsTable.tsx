/**
 * QuickSessionsTable — the live quick-session status board on the review home.
 *
 * Replaces the old "Idle sessions" group (stale blocking `human_task` rows that
 * never self-cleared on open). Renders the COMPACT status of every non-blocked
 * quick session:
 *   - idle    (rust)  — rested after a turn; an unviewed one shows a dot + how
 *                       long it has been quiet
 *   - running (green) — actively working (no action needed)
 *
 * `blocked` sessions (waiting on an AskUserQuestion / permission answer) are NOT
 * shown here — they are surfaced as full-width cards near the top of the queue
 * (TypeGroupedQueue), alongside the other waiting-on-input items — so this board
 * carries only running/idle rows and never duplicates that treatment.
 *
 * Rows are ordered by attention: idle-unviewed (longest quiet first) →
 * idle-viewed → running. Opening a row switches to the quick-session host AND
 * marks it viewed (the live fix for bug #1: the old queue item never cleared
 * because opening from the queue never stamped last_viewed_at), then triggers an
 * immediate board refresh so its state updates without waiting for the poll.
 *
 * Two idle→running overlays run on the live clock: {@link overrideRunningForActiveWorkflows}
 * (a detached dynamic workflow is still working) and {@link overrideRecentIdleAsRunning}
 * (a session rested < {@link QUIET_GRACE_MS} ago isn't "quiet" yet).
 *
 * Data + polling come from {@link useQuickSessionsStore}; this component owns the
 * grouping chrome, the board sort, and a shared 1s clock for the "quiet for N"
 * elapsed labels (one interval for the whole table, not one per row).
 */
import React from 'react';
import { useQuickSessionRows, useQuickSessionsStore } from '../../stores/quickSessionsStore';
import { useActiveDynamicWorkflows } from '../../stores/dynamicWorkflowStore';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useSessionStore } from '../../stores/sessionStore';
import { formatElapsed } from '../../utils/homeClassify';
import type { QuickSessionRow, QuickSessionState } from '../../../../shared/types/quickSessions';

/** Board sort weight — lower sorts first. Attention descends, running last. */
function sortWeight(row: QuickSessionRow): number {
  if (row.state === 'blocked') return 0;
  if (row.state === 'idle') return row.unviewed ? 1 : 2;
  return 3; // running
}

/**
 * Override `idle` → `running` for sessions with a live dynamic workflow.
 *
 * A quick session that launches a Claude Code dynamic workflow (the Workflow
 * tool) parks its PTY turn while the workflow runs DETACHED in the background —
 * so `sessions.status` reads `completed` and the row derives to `idle`, even
 * though the session is actively working (and the Active-agents panel shows it
 * running). This reconciles the board with that panel: any idle row whose
 * sessionId has an active dynamic workflow is shown `running` (idleSince cleared
 * so no "quiet for N" label). `blocked` is never overridden — a pending question
 * still wins.
 */
export function overrideRunningForActiveWorkflows(
  rows: QuickSessionRow[],
  activeWorkflowSessionIds: ReadonlySet<string>,
): QuickSessionRow[] {
  return rows.map((row) =>
    row.state === 'idle' && activeWorkflowSessionIds.has(row.sessionId)
      ? { ...row, state: 'running', idleSince: null }
      : row,
  );
}

/**
 * Grace window before a rested session is labeled `idle` / "quiet".
 *
 * A turn ending stamps `sessions.updated_at`, so a session that JUST finished
 * derives to `idle` with "quiet 0s" — noisy, since a follow-up turn often lands
 * within a few seconds. Within this window after its last turn the row is shown
 * `running` instead, and only flips to `idle` once it has actually been quiet
 * for the full window. At the boundary the label reads "quiet 1m", never
 * resetting a counter (idleSince is preserved, so elapsed keeps climbing from
 * the real rest time).
 */
export const QUIET_GRACE_MS = 60_000;

/**
 * Override `idle` → `running` for sessions that rested less than {@link QUIET_GRACE_MS}
 * ago (see the grace-window rationale above). Time-based, so it must be recomputed
 * against the live clock (`nowMs`). `blocked`/`running` rows and rows with an
 * unparseable `idleSince` pass through untouched.
 */
export function overrideRecentIdleAsRunning(
  rows: QuickSessionRow[],
  nowMs: number,
  graceMs: number = QUIET_GRACE_MS,
): QuickSessionRow[] {
  return rows.map((row) => {
    if (row.state !== 'idle' || row.idleSince === null) return row;
    const idleMs = Date.parse(row.idleSince);
    if (Number.isNaN(idleMs)) return row;
    return nowMs - idleMs < graceMs ? { ...row, state: 'running', idleSince: null } : row;
  });
}

/** Stable board order: attention first, then longest-quiet idle first. */
export function sortQuickSessionRows(rows: QuickSessionRow[]): QuickSessionRow[] {
  return [...rows].sort((a, b) => {
    const wa = sortWeight(a);
    const wb = sortWeight(b);
    if (wa !== wb) return wa - wb;
    // Within idle, oldest idleSince (longest quiet) first.
    if (a.idleSince !== null && b.idleSince !== null) return a.idleSince.localeCompare(b.idleSince);
    return a.name.localeCompare(b.name);
  });
}

/** Per-state chip presentation. */
const STATE_CHIP: Record<QuickSessionState, { label: string; className: string }> = {
  blocked: { label: 'blocked', className: 'border-status-error text-status-error' },
  idle: { label: 'idle', className: 'border-border-emphasized text-text-tertiary' },
  running: { label: 'running', className: 'border-border-emphasized text-status-success' },
};

/** Wall-clock refresh cadence for the "quiet for N" labels (shared across rows).
 *  1s so the counter climbs continuously (per-second) rather than in visible jumps. */
const ELAPSED_TICK_MS = 1000;

/** Open a quick session AND mark it viewed, then refresh the board so its row updates promptly. */
function openQuickSession(row: QuickSessionRow): void {
  useCyboflowStore.getState().setActiveQuickSession(row.sessionId, row.runId ?? undefined);
  useNavigationStore.getState().setActiveProjectId(row.projectId);
  useNavigationStore.getState().goToSession();
  // Stamp last_viewed_at (clears the unviewed/attention state) — the board's
  // markViewed path the review-queue "Open session →" click never had.
  void useSessionStore
    .getState()
    .markSessionAsViewed(row.sessionId)
    .finally(() => {
      void useQuickSessionsStore.getState().refresh();
    });
}

function StateChip({ state }: { state: QuickSessionState }): React.JSX.Element {
  const chip = STATE_CHIP[state];
  return (
    <span className={`eyebrow shrink-0 border px-1.5 py-0.5 ${chip.className}`}>{chip.label}</span>
  );
}

function QuickSessionRowView({ row, nowMs }: { row: QuickSessionRow; nowMs: number }): React.JSX.Element {
  const quiet = row.state === 'idle' ? formatElapsed(row.idleSince, nowMs) : null;
  const needsDot = row.state === 'blocked' || (row.state === 'idle' && row.unviewed);
  return (
    <button
      type="button"
      onClick={() => openQuickSession(row)}
      className="flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors hover:bg-surface-hover"
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          row.state === 'blocked'
            ? 'bg-status-error'
            : row.state === 'running'
              ? 'bg-status-success'
              : needsDot
                ? 'bg-interactive'
                : 'bg-border-emphasized'
        }`}
      />
      <span className="truncate font-bold text-text-primary" style={{ fontSize: '13px' }} title={row.name}>
        {row.name}
      </span>
      <StateChip state={row.state} />
      <span className="ml-auto shrink-0 text-[11px] text-text-muted">
        {row.state === 'idle' ? `quiet ${quiet}` : row.state === 'blocked' ? 'waiting on you' : ''}
      </span>
    </button>
  );
}

/**
 * The board section. Renders nothing when there are no quick sessions (so the
 * review home doesn't show an empty box). Self-subscribes to the polling feed.
 */
export function QuickSessionsTable(): React.JSX.Element | null {
  const rows = useQuickSessionRows();
  // Sessions with a live dynamic workflow (Active-agents feed) — used to override
  // their idle rows to `running` (dynamicWorkflowStore is init'd by LandingHome).
  const activeDynamicWorkflows = useActiveDynamicWorkflows();

  // Join the polling feed while mounted (ref-counted in the store).
  React.useEffect(() => useQuickSessionsStore.getState().init(), []);

  // One shared clock for every row's elapsed label. `formatElapsed` renders
  // seconds for sub-minute durations ("quiet 12s"), so the cadence stays 1s
  // while visible — it can't be coarsened. Pause the interval while the
  // document is hidden (backgrounded/minimized window), mirroring the pattern
  // in useSessionMetrics.ts: stop on hide, restart + immediate catch-up tick
  // on visible so the label isn't stale by however long the tab was hidden.
  const [nowMs, setNowMs] = React.useState<number>(() => Date.now());
  React.useEffect(() => {
    const tick = () => setNowMs(Date.now());
    let id: number | null = null;
    const start = () => {
      if (id !== null) return;
      tick();
      id = window.setInterval(tick, ELAPSED_TICK_MS);
    };
    const stop = () => {
      if (id === null) return;
      window.clearInterval(id);
      id = null;
    };
    const handleVisibilityChange = () => {
      if (document.hidden) {
        stop();
      } else {
        start();
      }
    };

    if (document.hidden) {
      tick();
    } else {
      start();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      stop();
    };
  }, []);

  const activeWorkflowSessionIds = React.useMemo(
    () => new Set(activeDynamicWorkflows.map((w) => w.sessionId)),
    [activeDynamicWorkflows],
  );
  const sorted = React.useMemo(() => {
    // Blocked sessions are surfaced as full-width cards up top (TypeGroupedQueue),
    // so the compact board carries only running/idle rows — no duplicate treatment.
    const boardRows = rows.filter((row) => row.state !== 'blocked');
    const overridden = overrideRecentIdleAsRunning(
      overrideRunningForActiveWorkflows(boardRows, activeWorkflowSessionIds),
      nowMs,
    );
    return sortQuickSessionRows(overridden);
  }, [rows, activeWorkflowSessionIds, nowMs]);
  if (sorted.length === 0) return null;

  return (
    <section data-testid="queue-group-quick-sessions">
      <div className="sticky top-0 z-10 flex items-center gap-2.5 bg-bg-primary px-4 py-2 border-b border-border-primary">
        <span aria-hidden="true" className="inline-block h-[14px] w-[8px] flex-shrink-0 bg-interactive" />
        <span className="text-[12px] font-bold text-text-primary">Quick sessions</span>
        <span className="eyebrow text-text-tertiary">{sorted.length} total</span>
        <span className="ml-auto text-[11px] text-text-muted">Live — blocked and idle need you; open to continue or wrap up</span>
      </div>
      {sorted.map((row) => (
        <QuickSessionRowView key={row.sessionId} row={row} nowMs={nowMs} />
      ))}
    </section>
  );
}
