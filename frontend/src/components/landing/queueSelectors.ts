/**
 * queueSelectors — the Human Review Queue's pure helpers.
 *
 * Kept out of the section components so they stay unit-testable and so those
 * files export components only (a mixed module breaks Fast Refresh).
 */
import type { ReviewItem } from '../../../../shared/types/reviews';
import type { QueueItem } from '../../utils/reviewQueueSelectors';
import type { ActiveRunRow } from '../../stores/activeRunsStore';
import type { QuickSessionRow } from '../../../../shared/types/quickSessions';
import type { QuickSessionTriage } from '../../utils/quickSessionTriage';
import { classifyRun, parseDbTimestampMs } from '../../utils/homeClassify';

/**
 * Select runs that are genuinely ready for post-workflow review.
 *
 * Moved here verbatim from the retired TypeGroupedQueue. `awaiting_review` is
 * also used while a programmatic workflow is parked at an intermediate human
 * gate; those runs already have a blocking decision (or permission) in the
 * queue and must not be duplicated as finished work.
 */
export function selectReadyToReviewRuns(
  runs: ActiveRunRow[],
  reviewItems: ReviewItem[],
  permissionItems: QueueItem[],
  landingBlockingRunIds: ReadonlySet<string> = new Set(),
): ActiveRunRow[] {
  const blockedRunIds = new Set(landingBlockingRunIds);
  for (const item of permissionItems) {
    blockedRunIds.add(item.kind === 'single' ? item.approval.runId : item.runId);
  }
  for (const item of reviewItems) {
    if (item.blocking && item.run_id !== null) blockedRunIds.add(item.run_id);
  }
  return runs.filter((run) => run.status === 'awaiting_review' && !blockedRunIds.has(run.id));
}

/**
 * Coarse age for a row that can legitimately be days old ("3h", "2d").
 *
 * `formatElapsedMinutes` tops out at hours, which reads badly past a day. Uses
 * the same UTC-normalizing {@link parseDbTimestampMs} parse so a zone-less
 * SQLite stamp is not read as local time.
 */
export function compactAge(timestamp: string, nowMs: number): string {
  const startMs = parseDbTimestampMs(timestamp);
  if (Number.isNaN(startMs)) return '—';
  const minutes = Math.floor(Math.max(0, nowMs - startMs) / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Count the underlying approvals represented by a list of grouped queue items. */
export function countApprovals(items: QueueItem[]): number {
  let total = 0;
  for (const item of items) {
    total += item.kind === 'single' ? 1 : item.items.length;
  }
  return total;
}

/**
 * Sessions a non-terminal FLOW run already represents, keyed by session id.
 *
 * A flow run (sprint/planner/…) and a `__quick__` chat can share ONE session —
 * launching a flow parks the session's chat turn while the run drives in the
 * background. WorkingSection has always treated the run as the thing that
 * speaks for that session while it is non-terminal ("flow run > dynamic
 * workflow > quick session"); this is that same precedence extracted so every
 * home section (Needs-input, Ready-for-review, Working) can share it instead
 * of only Working applying it inline. `awaiting_review`/`stuck`/`paused`
 * count as non-terminal here too — only `completed`/`failed`/`canceled` give
 * the session back to its own quick-session row (see TASK-226: a session with
 * a failed/interrupted `__quick__` run must not be classified from that dead
 * run while its flow run is still blocked-but-alive).
 */
export function nonTerminalFlowRunBySession(runs: ActiveRunRow[]): Map<string, ActiveRunRow> {
  const map = new Map<string, ActiveRunRow>();
  for (const run of runs) {
    if (classifyRun(run.status) === 'terminal') continue;
    if (typeof run.session_id !== 'string' || run.session_id === '') continue;
    map.set(run.session_id, run);
  }
  return map;
}

/**
 * The MOST SIGNIFICANT flow run per session, INCLUDING a terminal one — the
 * navigation/label counterpart of {@link nonTerminalFlowRunBySession} for the
 * Ready-for-review band (TASK-226 address-review). Once a session's flow run
 * finishes, the session's own quick row comes back to Ready (the non-terminal
 * map above stops hiding it) — but "Open →" on that row must still open the
 * flow run whose output is what there is to review, not the `__quick__` chat
 * the flow interrupted when it launched, and the row's status label must
 * describe the run that actually finished (a completed planner run is not
 * "stopped by you" just because its parked chat run reads `stopped`).
 *
 * Precedence: a non-terminal run always wins; otherwise the NEWEST terminal
 * run (by `created_at`, then list order). Feed this the store's RETAINED rows
 * (`useAggregatedRetainedRuns`), which keep the newest terminal run per
 * session — the active-only `useAggregatedRuns` list never contains one.
 */
export function significantFlowRunBySession(runs: ActiveRunRow[]): Map<string, ActiveRunRow> {
  const map = new Map<string, ActiveRunRow>();
  for (const run of runs) {
    if (typeof run.session_id !== 'string' || run.session_id === '') continue;
    const current = map.get(run.session_id);
    if (current === undefined) {
      map.set(run.session_id, run);
      continue;
    }
    const currentTerminal = classifyRun(current.status) === 'terminal';
    const runTerminal = classifyRun(run.status) === 'terminal';
    if (currentTerminal && !runTerminal) {
      map.set(run.session_id, run);
    } else if (currentTerminal && runTerminal && run.created_at > current.created_at) {
      map.set(run.session_id, run);
    }
  }
  return map;
}

/**
 * Strip quick-session triage rows for any session a non-terminal flow run
 * already represents, from EVERY bucket — not just `working`, which was the
 * only place this precedence was applied before TASK-226. Without this, a
 * session holding an interrupted `__quick__` run alongside a still-running (or
 * gate-parked) flow run doubled into both Working (correctly, via the run row)
 * and Needs-input/Ready-for-review (incorrectly, via its stale quick-session
 * row, which could read "stopped by you" off the DEAD chat run and route
 * `Open →` there instead of the live flow run).
 */
export function applyFlowRunPrecedence(
  triage: QuickSessionTriage,
  flowRunBySession: ReadonlyMap<string, ActiveRunRow>,
): QuickSessionTriage {
  const keep = (row: QuickSessionRow): boolean => !flowRunBySession.has(row.sessionId);
  return {
    needsInput: triage.needsInput.filter(keep),
    readyForReview: triage.readyForReview.filter(keep),
    working: triage.working.filter(keep),
  };
}

/** Where {@link resolveOpenTarget} routes a session row's `Open →` action. */
export type OpenSessionTarget =
  | { kind: 'run'; runId: string; projectId: number }
  | { kind: 'quick'; sessionId: string; runId: string | null; projectId: number };

/**
 * Resolve the ONE navigation target for a session row, so the flow-vs-quick
 * routing rule can't drift between call sites (Needs-input, Working,
 * Ready-for-review, and the Recommended-actions dispatch all funnel through
 * this). A session a non-terminal flow run already represents always opens
 * THAT run — never the (possibly interrupted/dead) `__quick__` chat sitting
 * beside it; only a session with no live flow run falls back to opening the
 * quick session itself. Pure so the routing decision is testable without
 * mocking navigation stores — the caller performs the actual side effect.
 */
export function resolveOpenTarget(
  row: Pick<QuickSessionRow, 'sessionId' | 'runId' | 'projectId'>,
  flowRunBySession: ReadonlyMap<string, ActiveRunRow>,
): OpenSessionTarget {
  const flowRun = flowRunBySession.get(row.sessionId);
  if (flowRun !== undefined) {
    return { kind: 'run', runId: flowRun.id, projectId: flowRun.project_id };
  }
  return { kind: 'quick', sessionId: row.sessionId, runId: row.runId, projectId: row.projectId };
}
