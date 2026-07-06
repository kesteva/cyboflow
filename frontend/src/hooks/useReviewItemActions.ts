/**
 * useReviewItemActions — triage mutations for the unified review_items inbox.
 *
 * Exposes the three triage operations that funnel through the ReviewItemRouter
 * chokepoint (and, for promote, the TaskChangeRouter chokepoint too):
 *   - resolve        : mark an item resolved. For a BLOCKING, run-bound item the
 *                      backend applies aggregate-unblock and AUTO-RESUMES the run
 *                      once no other blocking item remains — surfaced here via the
 *                      `resumed` flag returned to the caller. This is how a
 *                      DECISION item (approve-idea / approve-plan gate) advances
 *                      the flow: resolving it resumes the paused run.
 *   - dismiss        : mark an item dismissed (cruft).
 *   - promoteToTask  : mint a real task from the item (two chokepoints) and
 *                      resolve the item, recording the minted task id.
 *
 * The hook owns NO validation — that lives entirely in the chokepoints. It
 * tracks an in-flight item id (so a card can disable its buttons) and the last
 * error message (surfaced per-card). Each mutation resolves to a typed result on
 * success or `null` on error (with `error` set).
 *
 * All payloads are AppRouter-inferred from the reviewItems router input — no
 * local mirror of the request shape.
 */
import { useCallback, useState } from 'react';
import { trpc } from '../trpc/client';
import { acceptedResolution } from '../../../shared/types/reviews';

export interface ReviewItemActionsState {
  /** Review item id whose mutation is currently in flight (or null when idle). */
  pendingItemId: string | null;
  /** Last triage error message, or null. */
  error: string | null;
  /**
   * Resolve a review item. Returns `{ resumed }` on success (resumed=true when a
   * blocking, run-bound item triggered an aggregate-unblock auto-resume), or null
   * on error.
   *
   * `outcome` makes a programmatic human-gate verdict explicit: 'approve' resolves
   * + reveals the run's drafts (approve-plan) and resumes; 'reject' tears down the
   * rejected drafts and lets the controller end the run 'rejected' (no resume).
   * Omit it for non-gate resolves (findings / human tasks).
   */
  resolve: (
    projectId: number,
    reviewItemId: string,
    opts?: { resolution?: string; outcome?: 'approve' | 'reject' },
  ) => Promise<{ resumed: boolean } | null>;
  /**
   * Accept a finding whose proposedTarget is a manual ('docs' | 'prompt') edit:
   * resolve it with a 'triaged:accepted-<target>' note (built via
   * {@link acceptedResolution}) recording the human's decision. The human applies
   * the actual edit; nothing is minted. Thin wrapper over {@link resolve} — the
   * only triage chokepoint is still reviewItems.resolve. Returns `{ resumed }` on
   * success or null on error (mirrors resolve).
   */
  acceptFinding: (
    projectId: number,
    reviewItemId: string,
    target: 'docs' | 'prompt',
  ) => Promise<{ resumed: boolean } | null>;
  /** Dismiss a review item (cruft). Returns true on success, false on error. */
  dismiss: (projectId: number, reviewItemId: string, resolution?: string) => Promise<boolean>;
  /**
   * Promote a review item to a real task (mints the task, then resolves the
   * item). Returns the minted `{ taskId }` on success, or null on error.
   */
  promoteToTask: (
    projectId: number,
    reviewItemId: string,
    overrides?: { title?: string; body?: string | null },
  ) => Promise<{ taskId: string } | null>;
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function useReviewItemActions(): ReviewItemActionsState {
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolve = useCallback(
    async (
      projectId: number,
      reviewItemId: string,
      opts?: { resolution?: string; outcome?: 'approve' | 'reject' },
    ): Promise<{ resumed: boolean } | null> => {
      setError(null);
      setPendingItemId(reviewItemId);
      try {
        const result = await trpc.cyboflow.reviewItems.resolve.mutate({
          projectId,
          reviewItemId,
          ...(opts?.resolution !== undefined ? { resolution: opts.resolution } : {}),
          ...(opts?.outcome !== undefined ? { outcome: opts.outcome } : {}),
        });
        return { resumed: result.resumed };
      } catch (err: unknown) {
        setError(messageOf(err, 'Failed to resolve review item'));
        return null;
      } finally {
        setPendingItemId(null);
      }
    },
    [],
  );

  const acceptFinding = useCallback(
    (
      projectId: number,
      reviewItemId: string,
      target: 'docs' | 'prompt',
    ): Promise<{ resumed: boolean } | null> =>
      resolve(projectId, reviewItemId, { resolution: acceptedResolution(target) }),
    [resolve],
  );

  const dismiss = useCallback(
    async (projectId: number, reviewItemId: string, resolution?: string): Promise<boolean> => {
      setError(null);
      setPendingItemId(reviewItemId);
      try {
        await trpc.cyboflow.reviewItems.dismiss.mutate({
          projectId,
          reviewItemId,
          ...(resolution !== undefined ? { resolution } : {}),
        });
        return true;
      } catch (err: unknown) {
        setError(messageOf(err, 'Failed to dismiss review item'));
        return false;
      } finally {
        setPendingItemId(null);
      }
    },
    [],
  );

  const promoteToTask = useCallback(
    async (
      projectId: number,
      reviewItemId: string,
      overrides?: { title?: string; body?: string | null },
    ): Promise<{ taskId: string } | null> => {
      setError(null);
      setPendingItemId(reviewItemId);
      try {
        const result = await trpc.cyboflow.reviewItems.promoteToTask.mutate({
          projectId,
          reviewItemId,
          ...(overrides?.title !== undefined ? { title: overrides.title } : {}),
          ...(overrides?.body !== undefined ? { body: overrides.body } : {}),
        });
        return { taskId: result.taskId };
      } catch (err: unknown) {
        setError(messageOf(err, 'Failed to promote review item to task'));
        return null;
      } finally {
        setPendingItemId(null);
      }
    },
    [],
  );

  return { pendingItemId, error, resolve, acceptFinding, dismiss, promoteToTask };
}
