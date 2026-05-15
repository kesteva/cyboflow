/**
 * cyboflow.approvals sub-router — TASK-406 additions.
 *
 * This module exports `approveRestOfRunRouter`, a tRPC router fragment that
 * adds the `approveRestOfRun` mutation to the approvals namespace.  The
 * fragment is merged into the main approvalsRouter (at
 * main/src/orchestrator/trpc/routers/approvals.ts) during the approval-router
 * epic integration once that epic finalises.
 *
 * In the interim the module is self-contained and directly testable: the unit
 * tests in main/src/trpc/__tests__/approvals.test.ts import and call the
 * handler function directly, bypassing the tRPC layer.
 *
 * Standalone-typecheck invariant: no imports from 'electron'.
 */
import { z } from 'zod';
import { router, publicProcedure } from '../index';
import { withLock } from '../../utils/mutex';
import type { ApproveRestOfRunResult } from '../../../../shared/types/approvals';

// ---------------------------------------------------------------------------
// NO global approve-all exists in v1 — deliberate omission per IDEA-009 slice 8.
// Rationale: global approve-all maps to the highest-harm failure mode (accidental
// bulk-delete during prune+sprint queue clearing). The per-run scoping below is
// safe because the user has context about what one run is doing.
// See: user-needs research §5; risks research §10.
// ---------------------------------------------------------------------------

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
  db: {
    prepare: (sql: string) => {
      all: (...params: unknown[]) => unknown[];
      run: (...params: unknown[]) => void;
    };
  },
  runId: string,
): Promise<ApproveRestOfRunResult> {
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

    for (const row of rows) {
      try {
        db.prepare(
          `UPDATE approvals
           SET status = 'approved', decided_at = ?, decided_by = 'user'
           WHERE id = ? AND status = 'pending'`,
        ).run(now, row.id);
        decided++;
      } catch (err) {
        // Best-effort: log and continue so a single failure does not block
        // the remaining approvals.
        console.error(
          `[approveRestOfRun] Failed to approve ${row.id} for run ${runId}:`,
          err,
        );
      }
    }

    return { decided };
  });
}

/**
 * tRPC router fragment containing the `approveRestOfRun` mutation.
 *
 * Merge into the main approvalsRouter to expose this mutation under
 * `cyboflow.approvals.approveRestOfRun`.
 *
 * NOTE: In the current stub context the procedure does not have access to
 * `ctx.db` (the DB is not yet wired into the tRPC context — that lands in the
 * approval-router epic).  The unit tests exercise `approveRestOfRunHandler`
 * directly with an injected DB instance.
 */
export const approveRestOfRunRouter = router({
  approveRestOfRun: publicProcedure
    .input(z.object({ runId: z.string() }))
    .mutation(async ({ input }): Promise<ApproveRestOfRunResult> => {
      // TODO(approval-router epic): replace with ctx.db once wired into context.
      // For now, log and return 0 — the unit tests exercise the handler directly.
      console.log(
        `[approvals.approveRestOfRun] STUB — runId=${input.runId}; ` +
        `full impl (ctx.db wired) lands in the approval-router epic`,
      );
      return { decided: 0 };
    }),
});
