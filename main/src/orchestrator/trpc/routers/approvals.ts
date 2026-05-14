/**
 * cyboflow.approvals sub-router.
 *
 * All procedure bodies are deliberate not-implemented placeholders.
 * They will be filled in during the approval-router epic — grep for
 * `throwNotImplemented` to find every remaining stub.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { z } from 'zod';
import { router, protectedProcedure, throwNotImplemented } from '../trpc';

export const approvalsRouter = router({
  /** List all pending approvals (across all runs). */
  listPending: protectedProcedure
    .query(() => throwNotImplemented('approval-router')),

  /** Approve a pending approval gate. */
  approve: protectedProcedure
    .input(z.object({ approvalId: z.string(), message: z.string().optional() }))
    .mutation(() => throwNotImplemented('approval-router')),

  /** Reject a pending approval gate. */
  reject: protectedProcedure
    .input(z.object({ approvalId: z.string(), message: z.string().optional() }))
    .mutation(() => throwNotImplemented('approval-router')),
});
