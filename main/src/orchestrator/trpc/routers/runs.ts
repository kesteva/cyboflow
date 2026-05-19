/**
 * cyboflow.runs sub-router.
 *
 * All procedure bodies are deliberate not-implemented placeholders.
 * They will be filled in during the workflow-runs epic — grep for
 * `throwNotImplemented` to find every remaining stub.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, throwNotImplemented } from '../trpc';
import type { StuckInspectionResult } from '../../../../../shared/types/stuckInspection';
import {
  cancelAndRestartHandler,
  type CancelAndRestartDeps,
} from '../../cancelAndRestartHandler';
import type { DatabaseLike, LoggerLike } from '../../types';
import type { ApprovalRouter } from '../../approvalRouter';

// ---------------------------------------------------------------------------
// cancelAndRestart dependency bag
//
// Injected at boot by main/src/index.ts via setCancelAndRestartDeps().
// All fields are optional so the router compiles during the workflow-runs epic
// before wiring is complete — the mutation throws NOT_IMPLEMENTED when deps
// are absent rather than crashing the process.
// ---------------------------------------------------------------------------

let cancelAndRestartDeps: CancelAndRestartDeps | null = null;

/**
 * Wire up the real collaborators for the cancelAndRestart mutation.
 *
 * Called once at boot by main/src/index.ts after the DB, ApprovalRouter,
 * RunQueueRegistry, and ClaudeCodeManager have been initialized.
 *
 * Until this is called the mutation throws NOT_IMPLEMENTED (same as
 * all other stub procedures in this router).
 */
export function setCancelAndRestartDeps(deps: CancelAndRestartDeps): void {
  cancelAndRestartDeps = deps;
}

// ---------------------------------------------------------------------------
// cancel dependency bag
//
// Mirrors the cancelAndRestartDeps pattern above. Injected at boot by
// main/src/index.ts via setCancelDeps() once DB, ApprovalRouter, and
// RunExecutor lookup are available. Until wired, the mutation throws
// METHOD_NOT_SUPPORTED.
// ---------------------------------------------------------------------------

export interface CancelDeps {
  db: DatabaseLike;
  approvalRouter: Pick<ApprovalRouter, 'clearPendingForRun'>;
  /**
   * Look up the RunExecutor for the given runId.
   * Returns null when no executor is active (e.g. run already finished before
   * the cancel request arrived).
   */
  lookupExecutor: (runId: string) => { cancel(): Promise<void> } | null;
  logger?: LoggerLike;
}

let cancelDeps: CancelDeps | null = null;

/**
 * Wire up the real collaborators for the cancel mutation.
 *
 * Called once at boot by main/src/index.ts after the DB, ApprovalRouter,
 * and RunExecutor registry have been initialized.
 *
 * Until this is called the mutation throws METHOD_NOT_SUPPORTED.
 */
export function setCancelDeps(deps: CancelDeps): void {
  cancelDeps = deps;
}

// ---------------------------------------------------------------------------
// cancelHandler — extracted for direct testability
//
// The tRPC cancel mutation delegates to this function so that tests can
// exercise the ordering invariant (clearPendingForRun -> executor.cancel ->
// DB write to status='canceled') without wiring the full tRPC context.
// ---------------------------------------------------------------------------

/**
 * Cancels an in-flight workflow run.
 *
 * Execution order:
 *   1. Look up the RunExecutor for runId. If not found, skip steps 2-3.
 *   2. `deps.approvalRouter.clearPendingForRun(runId)` — deny pending
 *      approvals BEFORE killing the executor.
 *   3. `await executor.cancel()` — terminate the SDK AsyncIterator.
 *   4. `UPDATE workflow_runs SET status='canceled'` — DB write last.
 *      If the row is already terminal, returns `{ canceled: false, reason: 'already_terminal' }`.
 *   5. Returns `{ canceled: true }` on success.
 */
export async function cancelHandler(
  runId: string,
  deps: CancelDeps,
): Promise<{ canceled: true } | { canceled: false; reason: string }> {
  const executor = deps.lookupExecutor(runId);

  if (executor !== null) {
    // Step 2: deny all pending approvals BEFORE killing the executor.
    deps.approvalRouter.clearPendingForRun(runId);
    // Step 3: terminate the SDK AsyncIterator.
    // Wrapped in try/catch so a rejection here does NOT leave the run stuck
    // forever — the DB write in step 4 still applies.
    try {
      await executor.cancel();
    } catch (err: unknown) {
      deps.logger?.error('[cancel] executor.cancel rejected — proceeding to DB write', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Step 4: DB write — guarded UPDATE so we handle concurrent terminal transitions.
  const result = deps.db.prepare(
    `UPDATE workflow_runs
        SET status = 'canceled', ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status NOT IN ('canceled', 'failed', 'completed')`,
  ).run(runId) as { changes: number };

  if (result.changes === 0) {
    return { canceled: false, reason: 'already_terminal' };
  }

  return { canceled: true };
}

export const runsRouter = router({
  /** List workflow runs, optionally filtered by project. */
  list: protectedProcedure
    .input(z.object({ projectId: z.string().optional() }))
    // STUB — no raw-IPC equivalent. Implementation pending (workflow-runs epic).
    .query(() => throwNotImplemented('workflow-runs')),

  /** Start a new workflow run for the given workflow and project. */
  start: protectedProcedure
    .input(z.object({ workflowId: z.string(), projectId: z.string() }))
    // STUB — raw-IPC equivalent (cyboflow:startRun) in main/src/ipc/cyboflow.ts is the live surface. TBD-tRPC-cutover migration replaces this stub.
    .mutation(() => throwNotImplemented('workflow-runs')),

  /** Cancel a running workflow run by ID. */
  cancel: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .mutation(async ({ ctx, input }): Promise<{ canceled: true } | { canceled: false; reason: string }> => {
      if (ctx.userId !== 'local') {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }

      if (!cancelDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'cancel dependencies not wired yet (workflow-runs epic). Call setCancelDeps() at boot.',
        });
      }

      return cancelHandler(input.runId, cancelDeps);
    }),

  /** Get a single workflow run by ID. */
  get: protectedProcedure
    .input(z.object({ runId: z.string() }))
    // STUB — no raw-IPC equivalent. Implementation pending (workflow-runs epic).
    .query(() => throwNotImplemented('workflow-runs')),

  /**
   * Cancel a stuck workflow run and immediately enqueue a fresh run for
   * the same workflow, project, prompt, and worktree path.
   *
   * Execution order (all within the per-run PQueue for `runId`):
   *   1. Fetch the run row. If already terminal, return { noOp: true }.
   *   2. Send deny replies for every pending approval
   *      (approvalRouter.clearPendingForRun) — BEFORE killing the PTY.
   *   3. Kill the Claude SDK run (claudeManager.stop).
   *   4. UPDATE old run to status='canceled'.
   *   5. INSERT a new run row reusing workflow_id, project_id, prompt,
   *      and worktree_path (worktree is PRESERVED — no worktreeManager.remove).
   *   6. Return { newRunId }.
   *
   * Worktree preservation rationale (TASK-502 hardest decision):
   *   The worktree may contain partially-completed work the user wants to
   *   inspect.  v2 can add an explicit "Cancel and discard worktree" variant.
   *
   * Standalone-typecheck invariant: the real collaborators (db, approvalRouter,
   * runQueues, claudeManagerStop) are injected via setCancelAndRestartDeps().
   * Until that is called the mutation throws NOT_IMPLEMENTED.
   */
  cancelAndRestart: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .mutation(async ({ ctx, input }): Promise<{ newRunId: string } | { noOp: true; reason: string }> => {
      if (ctx.userId !== 'local') {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }

      if (!cancelAndRestartDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'cancelAndRestart dependencies not wired yet (workflow-runs epic). Call setCancelAndRestartDeps() at boot.',
        });
      }

      return cancelAndRestartHandler(input.runId, cancelAndRestartDeps);
    }),

  /**
   * Return diagnostic data for a stuck run: stuck reason, pending approval
   * payload, and the latest 10 raw_events rows.
   *
   * Principal scoping: v1 uses userId === 'local' for all runs. The guard
   * is structurally present for forward compatibility when the v2 team-tier
   * swap introduces real per-user scoping.
   *
   * Implementation note: ctx.db is not yet wired into the tRPC context
   * (pending approval-router epic). The handler function
   * `getStuckInspectionHandler` in main/src/trpc/routers/runs.ts is
   * directly testable without the tRPC wrapper; the procedure stub throws
   * NOT_IMPLEMENTED until ctx.db is wired.
   *
   * TODO(workflow-runs epic): replace stub with:
   *   if (ctx.principal.userId !== 'local') {
   *     throw new TRPCError({ code: 'FORBIDDEN' });
   *   }
   *   const result = getStuckInspectionHandler(ctx.db, input.runId);
   *   if (!result) throw new TRPCError({ code: 'NOT_FOUND' });
   *   return result;
   */
  getStuckInspection: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(async ({ ctx, input }): Promise<StuckInspectionResult> => {
      // Principal scoping — structurally present for v2 forward-compat.
      // In v1, ctx.userId is always 'local', matching the implicit run ownership.
      if (ctx.userId !== 'local') {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      // STUB — tRPC is the actual call path (StuckInspectorModal); implementation pending workflow-runs epic.
      // DB not yet wired into tRPC context (approval-router epic).
      // Throw NOT_IMPLEMENTED so the modal surfaces a visible error rather than
      // silently returning empty data.
      void input; // consumed once DB is wired
      throw new TRPCError({
        code: 'NOT_IMPLEMENTED',
        message: `getStuckInspection is not wired yet (workflow-runs epic). runId=${input.runId}`,
      });
    }),
});
