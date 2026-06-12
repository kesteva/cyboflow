/**
 * useRunEndEligibility — single source for "can this run be Ended?".
 *
 * A run is end-eligible when it has nothing left for the operator to act on:
 *   - it self-terminated (completed / failed), so End is pure navigation; or
 *   - it RESTED at awaiting_review with NO open gate — no pending permission
 *     approval and no pending blocking review item (mirrors the backend
 *     runs.end guard, which refuses 'blocking_items_pending').
 *
 * Shared by RunActionBar (the End button in the top bar) and CyboflowRoot's
 * in-canvas completion banner so the two affordances can never disagree.
 */
import { useReviewQueueStore } from '../stores/reviewQueueStore';
import { useAggregatedReviewItems } from '../stores/landingStore';

const SELF_TERMINATED_STATUSES: readonly string[] = ['completed', 'failed'];

export function useRunEndEligibility(runId: string | null, status: string | undefined): boolean {
  // Hooks run unconditionally (rules of hooks) — gating happens after.
  const approvals = useReviewQueueStore((s) => s.queue);
  const aggregatedReviewItems = useAggregatedReviewItems();

  if (runId === null || status === undefined) return false;
  if (SELF_TERMINATED_STATUSES.includes(status)) return true;
  if (status !== 'awaiting_review') return false;

  const hasOpenGate =
    approvals.some((a) => a.runId === runId) ||
    aggregatedReviewItems.some((it) => it.run_id === runId && it.blocking);
  return !hasOpenGate;
}
