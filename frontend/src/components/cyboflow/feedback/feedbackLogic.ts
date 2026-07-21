/**
 * Pure logic for the in-artifact feedback surface (IDEA-033) — kept free of
 * React/DOM so it is directly unit-testable. Consumed by FeedbackDocPanel (the
 * doc-scoped comment/send UI) and the "changes requested" gate-row chips.
 */
import type { FeedbackBatch, FeedbackComment } from '../../../../../shared/types/feedback';

// ---------------------------------------------------------------------------
// Send-button gating
// ---------------------------------------------------------------------------

export interface SendDisabledInput {
  draftCount: number;
  ideaDecomposed: boolean;
  hasPendingGate: boolean;
  hasPendingBatch: boolean;
}

/**
 * Why the "Send feedback" button is disabled, in priority order — also used
 * verbatim as the button's tooltip. Returns null when Send is enabled: N draft
 * comments, the idea is not decomposed, an open blocking decision gate exists,
 * and no batch is already pending for this document.
 */
export function computeSendDisabledReason(input: SendDisabledInput): string | null {
  if (input.ideaDecomposed) return 'Idea already decomposed';
  if (input.hasPendingBatch) return 'Revision in progress';
  if (!input.hasPendingGate) return 'No open review gate';
  if (input.draftCount === 0) return 'No draft comments to send';
  return null;
}

// ---------------------------------------------------------------------------
// Addressed-comment history grouping
// ---------------------------------------------------------------------------

export interface AddressedRoundGroup {
  round: number;
  batchId: string;
  comments: FeedbackComment[];
}

/**
 * Groups 'addressed' comments by their owning batch's round, newest round
 * first. A comment whose batch id is missing from `batches` (shouldn't happen —
 * batches outlive their comments) still groups under round 0 rather than being
 * dropped.
 */
export function groupAddressedByRound(
  comments: FeedbackComment[],
  batches: FeedbackBatch[],
): AddressedRoundGroup[] {
  const roundByBatch = new Map(batches.map((b) => [b.id, b.round]));
  const groups = new Map<string, AddressedRoundGroup>();
  for (const comment of comments) {
    if (comment.status !== 'addressed' || comment.batchId === null) continue;
    let group = groups.get(comment.batchId);
    if (!group) {
      group = { round: roundByBatch.get(comment.batchId) ?? 0, batchId: comment.batchId, comments: [] };
      groups.set(comment.batchId, group);
    }
    group.comments.push(comment);
  }
  return Array.from(groups.values()).sort((a, b) => b.round - a.round);
}

// ---------------------------------------------------------------------------
// Gate-row "changes requested" chip status
// ---------------------------------------------------------------------------

export type ChipStatus =
  | { kind: 'pending'; round: number }
  | { kind: 'applied'; round: number }
  | { kind: 'failed'; round: number; error: string | null };

/** Status priority when batches tie on `createdAt` — higher wins. */
const STATUS_PRIORITY: Record<FeedbackBatch['status'], number> = { pending: 2, failed: 1, applied: 0 };

/**
 * The chip to show on one idea's gate row: derived from the most RECENT batch
 * across every document (idea-spec + arch-design) for that idea. `round` is
 * scoped per (runId, atype, sourceRef), so it is not comparable across
 * documents — recency is `createdAt` (ISO-8601, lexicographically ordered),
 * tie-broken by status priority (pending > failed > applied, since a pending
 * revision is always the most operationally relevant thing to show). Null
 * when the idea has no feedback batches at all (no chip).
 */
export function latestBatchStatus(batches: FeedbackBatch[], ideaId: string): ChipStatus | null {
  const forIdea = batches.filter((b) => b.sourceRef === ideaId);
  if (forIdea.length === 0) return null;
  const latest = forIdea.reduce((a, b) => {
    if (b.createdAt !== a.createdAt) return b.createdAt > a.createdAt ? b : a;
    return STATUS_PRIORITY[b.status] > STATUS_PRIORITY[a.status] ? b : a;
  });
  if (latest.status === 'pending') return { kind: 'pending', round: latest.round };
  if (latest.status === 'applied') return { kind: 'applied', round: latest.round };
  return { kind: 'failed', round: latest.round, error: latest.error };
}
