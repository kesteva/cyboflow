import type { Approval } from '../../../shared/types/approvals';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueueItem =
  | { kind: 'single'; approval: Approval; isBlocking: boolean }
  | {
      kind: 'group';
      runId: string;
      toolName: string;
      payloadSignature: string;
      items: Approval[];
      isBlocking: boolean;
    };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalised payload signature used to detect repeated approvals.
 *
 * Trim + lowercase + first 100 chars — sufficient to collapse the
 * "same gcloud logging read command repeated 14 times" case (IDEA slice 6)
 * without a cryptographic hash.
 */
export function payloadSignature(payload: string): string {
  return payload.trim().toLowerCase().slice(0, 100);
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** Sort approvals oldest-first (ascending by createdAt). Pure — returns a new array. */
export function sortQueueOldestFirst(items: Approval[]): Approval[] {
  return [...items].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

const DEFAULT_THRESHOLD_MS = 3 * 60 * 1000;

/**
 * Split approvals into blocking (age > thresholdMs) and normal buckets.
 *
 * @param items      Pre-sorted approval list.
 * @param now        Current timestamp in ms (injectable for testing).
 * @param thresholdMs Age threshold in ms (default: 3 minutes).
 */
export function partitionBlockingItems(
  items: Approval[],
  now: number,
  thresholdMs = DEFAULT_THRESHOLD_MS,
): { blocking: Approval[]; normal: Approval[] } {
  const blocking: Approval[] = [];
  const normal: Approval[] = [];

  for (const item of items) {
    const age = now - new Date(item.createdAt).getTime();
    if (age > thresholdMs) {
      blocking.push(item);
    } else {
      normal.push(item);
    }
  }

  return { blocking, normal };
}

/**
 * Collapse consecutive approvals from the same run with the same
 * toolName + payloadSignature into group items.
 *
 * Grouping is scoped to a single run — never across different runIds.
 * Non-repeating items become `kind: 'single'`.
 * Groups of two or more become `kind: 'group'`.
 *
 * isBlocking is set to false here; callers override via map() after calling.
 */
export function groupRepeatedApprovals(items: Approval[]): QueueItem[] {
  if (items.length === 0) return [];

  const result: QueueItem[] = [];
  let i = 0;

  while (i < items.length) {
    const current = items[i];
    const sig = payloadSignature(current.payloadPreview);
    let j = i + 1;

    while (
      j < items.length &&
      items[j].runId === current.runId &&
      items[j].toolName === current.toolName &&
      payloadSignature(items[j].payloadPreview) === sig
    ) {
      j++;
    }

    const count = j - i;

    if (count === 1) {
      result.push({ kind: 'single', approval: current, isBlocking: false });
    } else {
      result.push({
        kind: 'group',
        runId: current.runId,
        toolName: current.toolName,
        payloadSignature: sig,
        items: items.slice(i, j),
        isBlocking: false,
      });
    }

    i = j;
  }

  return result;
}

/**
 * Compose sort → partition → group into a single view-ready structure.
 *
 * Returns `{ blocking, normal }` where both lists are oldest-first and have
 * grouping applied within each section.  The `isBlocking` flag is set on
 * every item.
 */
export function selectQueueView(
  items: Approval[],
  now: number,
): { blocking: QueueItem[]; normal: QueueItem[] } {
  const sorted = sortQueueOldestFirst(items);
  const { blocking, normal } = partitionBlockingItems(sorted, now);
  return {
    blocking: groupRepeatedApprovals(blocking).map((g) => ({ ...g, isBlocking: true })),
    normal: groupRepeatedApprovals(normal).map((g) => ({ ...g, isBlocking: false })),
  };
}
