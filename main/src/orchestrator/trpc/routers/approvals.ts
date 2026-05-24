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
import { selectPendingApprovals } from '../../approvalListing';
import { withLock } from '../../../utils/mutex';

// ---------------------------------------------------------------------------
// approveRestOfRunHandler / rejectRestOfRunHandler
//
// Core implementations for per-run batch approval decisions.  Extracted for
// direct unit testing without the tRPC wrapping.
//
// NOTE: previously these lived in the legacy main/src/trpc/routers/approvals.ts
// tree (deleted in TASK-717).  They now live here — the canonical orchestrator
// router — so the orchestrator subtree has no cross-tree dependency.
// ---------------------------------------------------------------------------

/** Narrow DatabaseLike surface required by the handlers below. */
type DatabaseLike = {
  prepare: (sql: string) => {
    all: (...params: unknown[]) => unknown[];
    run: (...params: unknown[]) => void;
  };
};

/**
 * Shared implementation for approve/reject-rest-of-run.
 *
 * Selects all pending approvals for `runId` and updates each to `decision`
 * under the per-run mutex.  Best-effort: if a single UPDATE fails, the error
 * is logged with a decision-derived prefix and iteration continues.
 *
 * Not exported — callers must use the named wrappers below.
 */
async function decideRestOfRunHandler(
  db: DatabaseLike,
  runId: string,
  decision: 'approved' | 'rejected',
): Promise<{ decided: number }> {
  return withLock(`run:${runId}`, async () => {
    // Select all pending approval IDs for this run only.
    const rows = db
      .prepare(
        `SELECT id FROM approvals WHERE run_id = ? AND status = 'pending'`,
      )
      .all(runId) as { id: string }[];

    if (rows.length === 0) {
      return { decided: 0 };
    }

    const now = new Date().toISOString();
    let decided = 0;

    // Derive log-prefix and verb from decision so the messages appear verbatim.
    const prefix = decision === 'approved' ? 'approveRestOfRun' : 'rejectRestOfRun';
    const verb = decision === 'approved' ? 'approve' : 'reject';

    for (const row of rows) {
      try {
        db.prepare(
          `UPDATE approvals
           SET status = ?, decided_at = ?, decided_by = 'user'
           WHERE id = ? AND status = 'pending'`,
        ).run(decision, now, row.id);
        decided++;
      } catch (err) {
        // Best-effort: log and continue so a single failure does not block
        // the remaining approvals.
        console.error(
          `[${prefix}] Failed to ${verb} ${row.id} for run ${runId}:`,
          err,
        );
      }
    }

    return { decided };
  });
}

/**
 * Core implementation of the approveRestOfRun logic — extracted for direct
 * unit testing without the tRPC wrapping.
 *
 * Selects all pending approvals for the given `runId` and sets each to
 * `status='approved'` under the per-run mutex.  Best-effort: if a single
 * approval update fails, the error is logged and iteration continues.
 *
 * @param db     - A narrow DatabaseLike surface (prepare + run).
 * @param runId  - The workflow_runs.id to scope the operation to.
 * @returns `{ decided: number }` — count of approvals approved in this call.
 */
export async function approveRestOfRunHandler(
  db: DatabaseLike,
  runId: string,
): Promise<ApproveRestOfRunResult> {
  return decideRestOfRunHandler(db, runId, 'approved');
}

/**
 * Core implementation of the rejectRestOfRun logic — extracted for direct
 * unit testing without the tRPC wrapping.
 *
 * Selects all pending approvals for the given `runId` and sets each to
 * `status='rejected'` under the per-run mutex.  Best-effort: if a single
 * approval update fails, the error is logged and iteration continues.
 *
 * @param db     - A narrow DatabaseLike surface (prepare + run).
 * @param runId  - The workflow_runs.id to scope the operation to.
 * @returns `{ decided: number }` — count of approvals rejected in this call.
 */
export async function rejectRestOfRunHandler(
  db: DatabaseLike,
  runId: string,
): Promise<RejectRestOfRunResult> {
  return decideRestOfRunHandler(db, runId, 'rejected');
}

export const approvalsRouter = router({
  /**
   * List all pending approvals across all runs.
   *
   * Delegates to selectPendingApprovals from approvalListing.ts so the query
   * is shared with the bridge parity test — no inline SQL here.
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

      return selectPendingApprovals(ctx.db);
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
   * Delegates to `approveRestOfRunHandler` (defined in this file).
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
   * Delegates to `rejectRestOfRunHandler` (defined in this file).
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
