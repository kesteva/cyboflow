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
import type { WorkflowRunListRow } from '../../../../../shared/types/workflows';
import { getStuckInspectionHandler } from '../../inspectorQueries';
import { listRunsHandler } from '../../runQueries';
import {
  cancelAndRestartHandler,
  type CancelAndRestartDeps,
} from '../../cancelAndRestartHandler';

// ---------------------------------------------------------------------------
// cancelAndRestart dependency bag
//
// Injected at boot by main/src/index.ts via setCancelAndRestartDeps().
// All fields are optional so the router compiles during the workflow-runs epic
// before wiring is complete — the mutation throws METHOD_NOT_SUPPORTED when deps
// are absent rather than crashing the process.
// ---------------------------------------------------------------------------

let cancelAndRestartDeps: CancelAndRestartDeps | null = null;

/**
 * Wire up the real collaborators for the cancelAndRestart mutation.
 *
 * Called once at boot by main/src/index.ts after the DB, ApprovalRouter,
 * RunQueueRegistry, and ClaudeCodeManager have been initialized.
 *
 * Until this is called the mutation throws METHOD_NOT_SUPPORTED (same as
 * all other stub procedures in this router).
 */
export function setCancelAndRestartDeps(deps: CancelAndRestartDeps): void {
  cancelAndRestartDeps = deps;
}

// ---------------------------------------------------------------------------
// start dependency bag
//
// Injected at boot by main/src/index.ts via setStartRunDeps() after both
// RunLauncher and SessionManager are constructed.  Until wired, the mutation
// throws METHOD_NOT_SUPPORTED — same pattern as cancel and cancelAndRestart.
// ---------------------------------------------------------------------------

export interface RunLauncherLike {
  launch(workflowId: string, projectPath: string): Promise<{
    runId: string;
    worktreePath: string;
    branchName: string;
  }>;
}

export interface SessionManagerLike {
  getProjectById(projectId: number): { path: string } | undefined;
}

export interface StartRunDeps {
  runLauncher: RunLauncherLike;
  sessionManager: SessionManagerLike;
}

let startRunDeps: StartRunDeps | null = null;

/**
 * Wire up the real collaborators for the start mutation.
 *
 * Called once at boot by main/src/index.ts after RunLauncher and
 * SessionManager have been initialized.
 *
 * Until this is called the mutation throws METHOD_NOT_SUPPORTED.
 */
export function setStartRunDeps(deps: StartRunDeps): void {
  startRunDeps = deps;
}

export const runsRouter = router({
  /** List workflow runs for a project, ordered newest-first. */
  list: protectedProcedure
    .input(z.object({ projectId: z.number().int().positive() }))
    .query(({ ctx, input }): WorkflowRunListRow[] => {
      if (ctx.userId !== 'local') {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      if (!ctx.db) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'db not wired into tRPC context',
        });
      }
      return listRunsHandler(ctx.db, input.projectId);
    }),

  /** Start a new workflow run for the given workflow and project. */
  start: protectedProcedure
    .input(z.object({
      workflowId: z.string().min(1),
      projectId: z.number().int().positive(),
    }))
    .mutation(async ({ ctx, input }): Promise<{ runId: string; worktreePath: string; branchName: string }> => {
      if (ctx.userId !== 'local') {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      if (!startRunDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'start dependencies not wired yet. Call setStartRunDeps() at boot.',
        });
      }
      const project = startRunDeps.sessionManager.getProjectById(input.projectId);
      if (!project) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Project ${input.projectId} not found`,
        });
      }
      const { runId, worktreePath, branchName } = await startRunDeps.runLauncher.launch(
        input.workflowId,
        project.path,
      );
      return { runId, worktreePath, branchName };
    }),

  /** Cancel a running workflow run by ID. */
  cancel: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .mutation(() => throwNotImplemented('workflow-runs')),

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
   * Until that is called the mutation throws METHOD_NOT_SUPPORTED.
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
   */
  getStuckInspection: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(async ({ ctx, input }): Promise<StuckInspectionResult> => {
      if (ctx.userId !== 'local') {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      if (!ctx.db) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'db not wired into tRPC context',
        });
      }
      const result = getStuckInspectionHandler(ctx.db, input.runId);
      if (result === null) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Run ${input.runId} not found`,
        });
      }
      return result;
    }),
});
