/**
 * cyboflow.approvals sub-router.
 *
 * All procedure bodies are deliberate NOT_IMPLEMENTED placeholders.
 * They will be filled in during the approval-router epic.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';

const NOT_IMPLEMENTED_MSG = 'TODO: implemented in approval-router epic';

export const approvalsRouter = router({
  /** List all pending approvals (across all runs). */
  listPending: protectedProcedure
    .query(() => {
      throw new TRPCError({ code: 'NOT_IMPLEMENTED', message: NOT_IMPLEMENTED_MSG });
    }),

  /** Approve a pending approval gate. */
  approve: protectedProcedure
    .input(z.object({ approvalId: z.string(), message: z.string().optional() }))
    .mutation(() => {
      throw new TRPCError({ code: 'NOT_IMPLEMENTED', message: NOT_IMPLEMENTED_MSG });
    }),

  /** Reject a pending approval gate. */
  reject: protectedProcedure
    .input(z.object({ approvalId: z.string(), message: z.string().optional() }))
    .mutation(() => {
      throw new TRPCError({ code: 'NOT_IMPLEMENTED', message: NOT_IMPLEMENTED_MSG });
    }),
});
