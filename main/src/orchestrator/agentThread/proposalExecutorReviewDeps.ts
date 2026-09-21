/**
 * proposalExecutorReviewDeps — the review-queue closures of
 * {@link ProposalExecutorDeps} (triage-findings' write + live-state read),
 * factored out of the boot composition root (main/src/index.ts) next to the
 * executor's other collaborator modules so index.ts stays under its #19 size
 * ratchet.
 *
 * Pure wiring: the write delegates to the SINGLE review-inbox chokepoint
 * (ReviewItemRouter.applyReviewItem — the change shapes are its own, forwarded
 * verbatim, actor already pinned 'user' by the executor) and the read is a
 * plain project-scoped SELECT. No policy lives here.
 */
import type { DatabaseLike } from '../types';
import type { ReviewItemRouter } from '../reviewItemRouter';
import type { ProposalExecutorDeps } from './proposalExecutor';

export interface ProposalExecutorReviewCollaborators {
  reviewItemRouter: Pick<ReviewItemRouter, 'applyReviewItem'>;
  db: DatabaseLike;
}

export type ProposalExecutorReviewDeps = Pick<ProposalExecutorDeps, 'applyReviewItemChange' | 'readReviewItemState'>;

export function buildProposalExecutorReviewDeps(c: ProposalExecutorReviewCollaborators): ProposalExecutorReviewDeps {
  return {
    applyReviewItemChange: async (projectId, change) => {
      await c.reviewItemRouter.applyReviewItem(projectId, change);
    },
    readReviewItemState: (projectId, reviewItemId) => {
      const row = c.db
        .prepare('SELECT status, staged_at, selected FROM review_items WHERE id = ? AND project_id = ?')
        .get(reviewItemId, projectId) as { status: 'pending' | 'resolved' | 'dismissed'; staged_at: string | null; selected: number } | undefined;
      if (!row) return null;
      return { status: row.status, stagedAt: row.staged_at, selected: row.selected === 1 };
    },
  };
}
