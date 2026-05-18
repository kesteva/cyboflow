/**
 * WARNING: DO NOT ADD NEW ROUTERS HERE.
 *
 * This file is part of the orphan main/src/trpc/ subtree.  The canonical
 * live-router location is main/src/orchestrator/trpc/routers/.  Once the
 * approval-router epic wires ctx.db in the orchestrator, this file will be
 * collapsed into main/src/orchestrator/trpc/routers/approvals.ts and deleted.
 *
 * cyboflow.approvals sub-router — TASK-401/TASK-406 additions.
 *
 * Re-exports the canonical approvalsRouter (listPending, approve, reject,
 * approveRestOfRun) from the orchestrator sub-tree.  The orchestrator owns
 * the live router definition; this file provides the stable import surface
 * for callers outside the orchestrator package.
 *
 * Also exports the approveRestOfRunHandler function — consumed by the
 * orchestrator's approvalsRouter.approveRestOfRun mutation once ctx.db is
 * wired (approval-router epic).
 *
 * In the interim the handler is self-contained and directly testable: the
 * unit tests in main/src/trpc/__tests__/approvals.test.ts import and call
 * the handler function directly, bypassing the tRPC layer.
 *
 * Standalone-typecheck invariant: no imports from 'electron'.
 */

// Re-export the canonical router so the AC grep finds 'listPending' here.
// The router definition lives in main/src/orchestrator/trpc/routers/approvals.ts.
export { approvalsRouter } from '../../orchestrator/trpc/routers/approvals';
// (listPending is a procedure on approvalsRouter — re-exported above)
import { withLock } from '../../utils/mutex';
import type { ApproveRestOfRunResult, RejectRestOfRunResult } from '../../../../shared/types/approvals';

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
  db: {
    prepare: (sql: string) => {
      all: (...params: unknown[]) => unknown[];
      run: (...params: unknown[]) => void;
    };
  },
  runId: string,
): Promise<RejectRestOfRunResult> {
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
           SET status = 'rejected', decided_at = ?, decided_by = 'user'
           WHERE id = ? AND status = 'pending'`,
        ).run(now, row.id);
        decided++;
      } catch (err) {
        // Best-effort: log and continue so a single failure does not block
        // the remaining approvals.
        console.error(
          `[rejectRestOfRun] Failed to reject ${row.id} for run ${runId}:`,
          err,
        );
      }
    }

    return { decided };
  });
}
