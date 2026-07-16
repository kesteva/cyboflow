/**
 * QuickSessionsTable — the live quick-session status board on the review home.
 *
 * Replaces the old "Idle sessions" group (stale blocking `human_task` rows that
 * never self-cleared on open). Renders EVERY quick session with its live state:
 *   - blocked (red)   — waiting on an AskUserQuestion / permission answer
 *   - idle    (rust)  — rested after a turn; an unviewed one shows a dot + how
 *                       long it has been quiet
 *   - running (green) — actively working (no action needed)
 *
 * Rows are ordered by attention: blocked → idle-unviewed (longest quiet first) →
 * idle-viewed → running. Opening a row switches to the quick-session host AND
 * marks it viewed (the live fix for bug #1: the old queue item never cleared
 * because opening from the queue never stamped last_viewed_at), then triggers an
 * immediate board refresh so its state updates without waiting for the poll.
 *
 * Data + polling come from {@link useQuickSessionsStore}; this component owns the
 * grouping chrome, the board sort, and a shared ~5s clock for the "quiet for N"
 * elapsed labels (one interval for the whole table, not one per row).
 */
import React from 'react';
import { useQuickSessionRows, useQuickSessionsStore } from '../../stores/quickSessionsStore';
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

/** Wall-clock refresh cadence for the "quiet for N" labels (shared across rows). */
const ELAPSED_TICK_MS = 5000;

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

  // Join the polling feed while mounted (ref-counted in the store).
  React.useEffect(() => useQuickSessionsStore.getState().init(), []);

  // One shared clock for every row's elapsed label.
  const [nowMs, setNowMs] = React.useState<number>(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const sorted = React.useMemo(() => sortQuickSessionRows(rows), [rows]);
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
