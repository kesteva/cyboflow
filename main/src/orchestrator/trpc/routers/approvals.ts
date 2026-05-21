/**
 * cyboflow.approvals sub-router.
 *
 * Provides the typed tRPC contract for the renderer's reviewQueueStore:
 *   - listPending       : query    → Approval[] (reads approvals JOIN workflow_runs JOIN workflows)
 *   - approve           : mutation → { success: true } (resolves in-process decisionPromise)
 *   - reject            : mutation → { success: true } (resolves in-process decisionPromise)
 *   - approveRestOfRun  : mutation → { decided: number } (per-run batch approve via DB handler)
 *   - rejectRestOfRun   : mutation → { decided: number } (per-run batch reject via DB handler)
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 *
 * TODO(approval-router): consolidate single + batch decision paths.
 * approve/reject route through ApprovalRouter.respond() which resolves the
 * in-process decisionPromise AND writes the DB row.  approveRestOfRun/
 * rejectRestOfRun only update the DB; they do NOT resolve any in-flight
 * decisionPromise.  This is acceptable for the v1 batch path but a follow-on
 * task may want to unify them.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import type { Approval, ApproveRestOfRunResult, RejectRestOfRunResult } from '../../../../../shared/types/approvals';
import { ApprovalRouter, ApprovalNotFoundError } from '../../approvalRouter';
import { approveRestOfRunHandler, rejectRestOfRunHandler } from '../../../trpc/routers/approvals';

// ---------------------------------------------------------------------------
// Internal DB row type for listPending query
// ---------------------------------------------------------------------------

interface DbApprovalRow {
  id: string;
  runId: string;
  workflowName: string;
  toolName: string;
  payloadPreviewRaw: string;
  rationale: string | null;
  createdAt: string;
  status: string;
}

export const approvalsRouter = router({
  /**
   * List all pending approvals across all runs.
   *
   * Reads from the `approvals` table where `status = 'pending'`, joined to
   * `workflow_runs` and `workflows` for the human-readable workflow name,
   * ordered by `created_at ASC`.
   *
   * The return type is Approval[] from shared/types/approvals.ts so that the
   * inferred AppRouter type carries the full UI-visible shape to the renderer.
   */
  listPending: protectedProcedure
    .query(async ({ ctx }): Promise<Approval[]> => {
      if (!ctx.db) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: '[approvals.listPending] db not wired into tRPC context',
        });
      }

      const rows = ctx.db.prepare(
        `SELECT
           a.id          AS id,
           a.run_id      AS runId,
           w.name        AS workflowName,
           a.tool_name   AS toolName,
           a.tool_input_json AS payloadPreviewRaw,
           a.rationale   AS rationale,
           a.created_at  AS createdAt,
           a.status      AS status
         FROM approvals a
         JOIN workflow_runs r ON r.id = a.run_id
         JOIN workflows     w ON w.id = r.workflow_id
         WHERE a.status = 'pending'
         ORDER BY a.created_at ASC`,
      ).all() as DbApprovalRow[];

      return rows.map((row): Approval => ({
        id: row.id,
        runId: row.runId,
        workflowName: row.workflowName,
        toolName: row.toolName,
        payloadPreview: row.payloadPreviewRaw.length > 512
          ? row.payloadPreviewRaw.slice(0, 512)
          : row.payloadPreviewRaw,
        rationale: row.rationale,
        createdAt: new Date(row.createdAt).toISOString(),
        status: row.status as Approval['status'],
      }));
    }),

  /**
   * Approve a pending approval gate.
   *
   * Delegates to ApprovalRouter.getInstance().respond() which:
   *  1. Resolves the in-process decisionPromise (unblocks the SDK PreToolUse hook).
   *  2. Updates the DB row (approvals.status → 'approved').
   *  3. Updates workflow_runs.status → 'running'.
   *
   * Maps ApprovalNotFoundError → TRPCError code:'NOT_FOUND'.
   */
  approve: protectedProcedure
    .input(z.object({ approvalId: z.string(), message: z.string().optional() }))
    .mutation(async ({ input }): Promise<{ success: true }> => {
      try {
        await ApprovalRouter.getInstance().respond(input.approvalId, { behavior: 'allow' });
        return { success: true };
      } catch (err) {
        if (err instanceof ApprovalNotFoundError) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `Approval ${input.approvalId} is not pending or does not exist`,
          });
        }
        throw err;
      }
    }),

  /**
   * Reject a pending approval gate.
   *
   * Delegates to ApprovalRouter.getInstance().respond() which:
   *  1. Resolves the in-process decisionPromise with a deny decision.
   *  2. Updates the DB row (approvals.status → 'rejected').
   *  3. Does NOT touch workflow_runs.status (Claude receives deny on socket and
   *     the run remains in awaiting_review until Claude yields — §5.7).
   *
   * Maps ApprovalNotFoundError → TRPCError code:'NOT_FOUND'.
   */
  reject: protectedProcedure
    .input(z.object({ approvalId: z.string(), message: z.string().optional() }))
    .mutation(async ({ input }): Promise<{ success: true }> => {
      try {
        await ApprovalRouter.getInstance().respond(input.approvalId, {
          behavior: 'deny',
          message: input.message ?? 'Rejected by user',
        });
        return { success: true };
      } catch (err) {
        if (err instanceof ApprovalNotFoundError) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `Approval ${input.approvalId} is not pending or does not exist`,
          });
        }
        throw err;
      }
    }),

  // NO global approve-all exists in v1 — deliberate omission per IDEA-009 slice 8.
  // Rationale: global approve-all maps to the highest-harm failure mode (accidental
  // bulk-delete during prune+sprint queue clearing). The per-run scoping below is
  // safe because the user has context about what one run is doing.
  // See: user-needs research §5; risks research §10.

  /**
   * Approve all pending approval gates for the given run.
   *
   * Scoped to a single run — never affects approvals from other runs.
   * Best-effort: if one approval update fails, iteration continues and the
   * count reflects only the successfully approved items.
   *
   * Delegates to `approveRestOfRunHandler` in main/src/trpc/routers/approvals.ts.
   *
   * CONTRACT DIVERGENCE: unlike approve(), this handler only updates the DB and
   * does NOT resolve any in-flight decisionPromise.  The rest-of-run user gesture
   * is interpreted as "the user no longer cares about per-approval responses for
   * this run".  See TODO above re: consolidation.
   */
  approveRestOfRun: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .mutation(async ({ input, ctx }): Promise<ApproveRestOfRunResult> => {
      if (!ctx.db) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'db not wired into tRPC context',
        });
      }
      return approveRestOfRunHandler(ctx.db, input.runId);
    }),

  /**
   * Reject all pending approval gates for the given run.
   *
   * Scoped to a single run — never affects approvals from other runs.
   * Best-effort: if one approval update fails, iteration continues and the
   * count reflects only the successfully rejected items.
   *
   * Delegates to `rejectRestOfRunHandler` in main/src/trpc/routers/approvals.ts.
   *
   * CONTRACT DIVERGENCE: unlike reject(), this handler only updates the DB and
   * does NOT resolve any in-flight decisionPromise.  See TODO above re: consolidation.
   */
  rejectRestOfRun: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .mutation(async ({ input, ctx }): Promise<RejectRestOfRunResult> => {
      if (!ctx.db) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'db not wired into tRPC context',
        });
      }
      return rejectRestOfRunHandler(ctx.db, input.runId);
    }),
});
