/**
 * cyboflow.approvals sub-router.
 *
 * Provides the typed tRPC contract for the renderer's reviewQueueStore:
 *   - listPending  : query    → Approval[] (full-state sync source)
 *   - approve      : mutation → { success: true } (stub — full impl in approval-router epic)
 *   - reject       : mutation → { success: true } (stub — full impl in approval-router epic)
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import type { Approval } from '../../../../../shared/types/approvals';

export const approvalsRouter = router({
  /**
   * List all pending approvals across all runs.
   *
   * Reads from the `approvals` table where `status = 'pending'`, ordered by
   * `created_at ASC`.  If the table does not yet exist (the approval-router
   * epic is not yet merged), returns [] and logs a warning rather than
   * throwing — the reviewer UI gracefully shows an empty queue.
   *
   * The return type is Approval[] from shared/types/approvals.ts so that the
   * inferred AppRouter type carries the full UI-visible shape to the renderer.
   */
  listPending: protectedProcedure
    .query(async ({ ctx }): Promise<Approval[]> => {
      // ctx.db is not yet present in the local context (v1 context carries only
      // userId). Until the approval-router epic wires the DB into context, this
      // procedure returns an empty list.  The comment block below documents the
      // intended implementation so the approval-router executor can grep-replace
      // the stub with minimal diff.
      //
      // TODO(approval-router): replace stub with:
      //   const rows = ctx.db.prepare(
      //     `SELECT id, run_id, workflow_name, tool_name, payload_preview,
      //             rationale, created_at, status
      //      FROM approvals WHERE status = 'pending' ORDER BY created_at ASC`
      //   ).all() as DbApprovalRow[];
      //   return rows.map(rowToApproval);
      void ctx; // ctx.userId is asserted by protectedProcedure — silence unused-var lint
      console.warn(
        '[approvals.listPending] DB not yet wired into tRPC context; returning empty list. ' +
        'Full implementation lands in the approval-router epic.'
      );
      return [];
    }),

  /**
   * Approve a pending approval gate.
   *
   * Stub implementation: logs and returns success.  The full implementation
   * (updating the DB row, resolving the in-process pending promise, emitting
   * the onApprovalDecided event) is out of scope for TASK-401 and lands in
   * the approval-router epic.
   */
  approve: protectedProcedure
    .input(z.object({ approvalId: z.string(), message: z.string().optional() }))
    .mutation(async ({ input, ctx }): Promise<{ success: true }> => {
      void ctx;
      console.log(`[approvals.approve] STUB — approvalId=${input.approvalId}`);
      return { success: true };
    }),

  /**
   * Reject a pending approval gate.
   *
   * Stub implementation: logs and returns success.  Same caveat as approve.
   */
  reject: protectedProcedure
    .input(z.object({ approvalId: z.string(), message: z.string().optional() }))
    .mutation(async ({ input, ctx }): Promise<{ success: true }> => {
      void ctx;
      console.log(`[approvals.reject] STUB — approvalId=${input.approvalId}`);
      return { success: true };
    }),
});
