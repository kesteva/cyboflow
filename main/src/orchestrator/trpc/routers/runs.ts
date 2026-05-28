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
import type { WorkflowRunListRow, WorkflowDefinition, WorkflowStepState } from '../../../../../shared/types/workflows';
import { WORKFLOW_DEFINITIONS, SOLOFLOW_WORKFLOW_NAMES } from '../../../../../shared/types/workflows';
import type { WorkflowStepTransitionEvent } from '../../../../../shared/types/workflows';
import type { ChatMessage } from '../../../../../shared/types/chatMessage';
import type { UnifiedMessage } from '../../../../../shared/types/unifiedMessage';
import type { DatabaseLike } from '../../types';
import { getStuckInspectionHandler } from '../../inspectorQueries';
import { listRunsHandler } from '../../runQueries';
import { selectRunMessages } from '../../runMessagesListing';
import { selectRunUnifiedMessages } from '../../runUnifiedMessagesListing';
import {
  cancelAndRestartHandler,
  type CancelAndRestartDeps,
} from '../../cancelAndRestartHandler';
import { stepTransitionEvents, eventToAsyncIterable } from './events';

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

// ---------------------------------------------------------------------------
// run close-out dependency bag (GAP-B)
//
// Planner / workflow runs never create a `sessions` row (a sessions row would
// double-list the run in the rail and its flat worktree-name layout does not
// match the run's nested `.cyboflow/worktrees/<workflow>/<runId8>` path). So
// the lifecycle close-out (Merge / Dismiss + worktree cleanup) operates on the
// `workflow_runs` row directly, reusing WorktreeManager's git helpers — which
// already take an absolute worktreePath — via the narrow interfaces below.
//
// Injected at boot by main/src/index.ts via setRunCloseoutDeps(). Until wired,
// the mutations throw METHOD_NOT_SUPPORTED (same pattern as the other stubs).
// ---------------------------------------------------------------------------

/**
 * Narrow slice of WorktreeManager needed for run close-out. Keeps the router
 * free of a concrete services/* import (standalone-typecheck invariant).
 */
export interface RunWorktreeManagerLike {
  getProjectMainBranch(projectPath: string): Promise<string>;
  squashAndMergeWorktreeToMain(
    projectPath: string,
    worktreePath: string,
    mainBranch: string,
    commitMessage: string,
  ): Promise<void>;
  mergeWorktreeToMain(projectPath: string, worktreePath: string, mainBranch: string): Promise<void>;
  /** `git worktree remove "<worktreePath>" --force` — idempotent on already-gone trees. */
  removeWorktreeByPath(projectPath: string, worktreePath: string): Promise<void>;
}

export interface RunCloseoutSessionManagerLike {
  getProjectById(projectId: number): { path: string } | undefined;
}

export interface RunCloseoutDeps {
  worktreeManager: RunWorktreeManagerLike;
  sessionManager: RunCloseoutSessionManagerLike;
}

let runCloseoutDeps: RunCloseoutDeps | null = null;

/**
 * Wire up the real collaborators for the run close-out mutations (merge /
 * dismiss). Called once at boot by main/src/index.ts after WorktreeManager and
 * SessionManager are constructed. Until then the mutations throw
 * METHOD_NOT_SUPPORTED.
 */
export function setRunCloseoutDeps(deps: RunCloseoutDeps): void {
  runCloseoutDeps = deps;
}

/**
 * Shared helper: load a run, validate it has a worktree + project, and resolve
 * the project path. Throws TRPCError on any failure so the procedures stay thin.
 */
function resolveRunForCloseout(
  db: DatabaseLike,
  runId: string,
): { worktreePath: string; branchName: string | null; projectPath: string } {
  if (!runCloseoutDeps) {
    throw new TRPCError({
      code: 'METHOD_NOT_SUPPORTED',
      message: 'run close-out dependencies not wired yet. Call setRunCloseoutDeps() at boot.',
    });
  }
  const row = db
    .prepare('SELECT worktree_path, branch_name, project_id FROM workflow_runs WHERE id = ?')
    .get(runId) as { worktree_path: string | null; branch_name: string | null; project_id: number } | undefined;
  if (!row) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `Run ${runId} not found` });
  }
  if (!row.worktree_path) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Run ${runId} has no worktree to close out`,
    });
  }
  const project = runCloseoutDeps.sessionManager.getProjectById(row.project_id);
  if (!project) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `Project ${row.project_id} not found for run ${runId}` });
  }
  return { worktreePath: row.worktree_path, branchName: row.branch_name, projectPath: project.path };
}

export const runsRouter = router({
  /** List workflow runs for a project, ordered newest-first. */
  list: protectedProcedure
    .input(z.object({ projectId: z.number().int().positive() }))
    .query(({ ctx, input }): WorkflowRunListRow[] => {
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
    .mutation(async ({ input }): Promise<{ runId: string; worktreePath: string; branchName: string }> => {
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
    .mutation(async ({ input }): Promise<{ newRunId: string } | { noOp: true; reason: string }> => {
      if (!cancelAndRestartDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'cancelAndRestart dependencies not wired yet (workflow-runs epic). Call setCancelAndRestartDeps() at boot.',
        });
      }

      return cancelAndRestartHandler(input.runId, cancelAndRestartDeps);
    }),

  /**
   * Merge a workflow run's worktree into the project's main branch (GAP-B).
   *
   * strategy='squash'   → squash all commits into one with `commitMessage`.
   * strategy='preserve' → replay all commits onto main (no squash).
   *
   * After a successful merge the run's worktree is removed and the run is
   * marked terminal ('completed'); the caller (dialog) then drops the active-run
   * selection. Mirrors the session merge dialog's squash/preserve choice but
   * operates on the workflow_runs row instead of a sessions row.
   */
  merge: protectedProcedure
    .input(z.object({
      runId: z.string().min(1),
      strategy: z.enum(['squash', 'preserve']),
      commitMessage: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }): Promise<{ success: true }> => {
      if (!ctx.db) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'db not wired into tRPC context' });
      }
      const deps = runCloseoutDeps;
      const { worktreePath, projectPath } = resolveRunForCloseout(ctx.db, input.runId);
      // deps is guaranteed non-null after resolveRunForCloseout (it throws otherwise).
      const wm = deps!.worktreeManager;

      const mainBranch = await wm.getProjectMainBranch(projectPath);
      if (input.strategy === 'squash') {
        const message = input.commitMessage?.trim();
        if (!message) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'commitMessage is required for a squash merge',
          });
        }
        await wm.squashAndMergeWorktreeToMain(projectPath, worktreePath, mainBranch, message);
      } else {
        await wm.mergeWorktreeToMain(projectPath, worktreePath, mainBranch);
      }

      // Remove the worktree and mark the run terminal. The worktree removal is
      // idempotent; mark-completed is guarded so it no-ops on an already-terminal
      // run rather than throwing.
      await wm.removeWorktreeByPath(projectPath, worktreePath);
      ctx.db
        .prepare(
          `UPDATE workflow_runs
              SET status = 'completed', ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status NOT IN ('completed', 'failed', 'canceled')`,
        )
        .run(input.runId);
      return { success: true };
    }),

  /**
   * Dismiss a workflow run (GAP-B): remove its worktree and mark the run
   * terminal ('canceled'). Any unmerged changes in the worktree are discarded.
   * The session-side equivalent is `sessions:delete`; this is the run-scoped
   * twin that operates on the workflow_runs row + its nested worktree path.
   */
  dismiss: protectedProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .mutation(async ({ ctx, input }): Promise<{ success: true }> => {
      if (!ctx.db) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'db not wired into tRPC context' });
      }
      const deps = runCloseoutDeps;
      const { worktreePath, projectPath } = resolveRunForCloseout(ctx.db, input.runId);
      await deps!.worktreeManager.removeWorktreeByPath(projectPath, worktreePath);
      ctx.db
        .prepare(
          `UPDATE workflow_runs
              SET status = 'canceled', ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status NOT IN ('completed', 'failed', 'canceled')`,
        )
        .run(input.runId);
      return { success: true };
    }),

  /**
   * Return the reconstructed chat history for a run.
   *
   * Reads from `raw_events` filtered to 'assistant' and 'user' event types,
   * reconstructing user-text and assistant-text turns as ChatMessage[]. Tool-use
   * and tool-result blocks are intentionally excluded — they surface via the
   * approvals and questions channels.
   *
   * Uses `selectRunMessages` from runMessagesListing.ts which applies
   * json_extract() at the SQL layer for efficient pre-filtering.
   */
  listMessages: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(async ({ ctx, input }): Promise<ChatMessage[]> => {
      if (!ctx.db) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'db not wired into tRPC context',
        });
      }
      return selectRunMessages(ctx.db, input.runId);
    }),

  /**
   * Return the reconstructed chat history for a run as fully-correlated
   * `UnifiedMessage[]` — the SAME rich projection the quick-session path
   * produces (tool_use folded together with its matching tool_result, system
   * init/compact and error messages surfaced).
   *
   * Reads from `raw_events` and folds every stored event through the shared
   * `TypedEventNarrowing` + `MessageProjection` pipeline via
   * `selectRunUnifiedMessages` from runUnifiedMessagesListing.ts.
   *
   * This is the Phase-1 backend half of chat unification. `listMessages`
   * (the legacy TEXT-ONLY reducer) is intentionally kept intact — a later
   * phase will mark it `@cyboflow-hidden` once the renderer migrates here.
   */
  listUnifiedMessages: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(async ({ ctx, input }): Promise<UnifiedMessage[]> => {
      if (!ctx.db) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'db not wired into tRPC context',
        });
      }
      return selectRunUnifiedMessages(ctx.db, input.runId);
    }),

  /**
   * Return diagnostic data for a stuck run: stuck reason, pending approval
   * payload, and the latest 10 raw_events rows.
   */
  getStuckInspection: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(async ({ ctx, input }): Promise<StuckInspectionResult> => {
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

  /**
   * Return the phase state for a workflow run: the resolved WorkflowDefinition,
   * the current_step_id (null when no step is active), and a stepStates array
   * that walks all steps in declaration order and assigns 'done' / 'running' /
   * 'pending' status relative to currentStepId.
   *
   * Step state derivation rules:
   *   - currentStepId is null OR not found in the definition → all 'pending'.
   *   - currentStepId matches a step → that step 'running'; all before 'done';
   *     all after 'pending'.
   *
   * Throws:
   *   PRECONDITION_FAILED — ctx.db is undefined.
   *   NOT_FOUND           — runId does not exist in workflow_runs.
   *   NOT_FOUND           — workflow.name is not a recognized SoloFlowWorkflowName.
   */
  getPhaseState: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(({ ctx, input }): { definition: WorkflowDefinition; currentStepId: string | null; stepStates: WorkflowStepState[] } => {
      if (!ctx.db) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'db not wired into tRPC context',
        });
      }

      // JOIN workflow_runs with workflows to get the workflow name and run status in one query.
      // Including wr.status allows getPhaseState to mark the current step as 'done' when
      // the run has reached a terminal state — fixing the race where both 'running' and
      // 'done' subscription events arrive before the query resolves and are dropped by
      // useWorkflowPhaseState's mergeTransition (definition is null at that point).
      const row = ctx.db
        .prepare(
          `SELECT wr.current_step_id, wr.status AS run_status, w.name AS workflow_name
             FROM workflow_runs wr
             JOIN workflows w ON wr.workflow_id = w.id
            WHERE wr.id = ?`,
        )
        .get(input.runId) as { current_step_id: string | null; run_status: string; workflow_name: string } | undefined;

      if (row === undefined) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Run ${input.runId} not found`,
        });
      }

      // Narrow workflow name to SoloFlowWorkflowName.
      if (!(SOLOFLOW_WORKFLOW_NAMES as readonly string[]).includes(row.workflow_name)) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Workflow name '${row.workflow_name}' is not a recognized SoloFlowWorkflowName`,
        });
      }

      // TypeScript narrowing: cast is safe because we validated membership above.
      const workflowName = row.workflow_name as (typeof SOLOFLOW_WORKFLOW_NAMES)[number];
      const definition = WORKFLOW_DEFINITIONS[workflowName];
      const currentStepId = row.current_step_id;

      // Terminal run statuses: when the run has completed, failed, or been canceled,
      // the current step's status must be 'done' — not 'running'. Without this check,
      // a run that completes before the renderer's getPhaseState query resolves (which
      // causes subscription 'done' events to be silently dropped) would show the current
      // step as perpetually 'running'.
      const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'canceled']);
      const runIsTerminal = TERMINAL_RUN_STATUSES.has(row.run_status);

      // Flatten all steps across phases in declaration order.
      const flatSteps = definition.phases.flatMap((p) => p.steps);

      // Compute stepStates. If currentStepId is null or not found (orphan),
      // all steps are 'pending'.
      const matchIndex = currentStepId !== null
        ? flatSteps.findIndex((s) => s.id === currentStepId)
        : -1;

      const stepStates: WorkflowStepState[] = flatSteps.map((s, i) => {
        let status: WorkflowStepState['status'];
        if (runIsTerminal) {
          status = 'done';
        } else if (matchIndex === -1) {
          status = 'pending';
        } else if (i < matchIndex) {
          status = 'done';
        } else if (i === matchIndex) {
          status = 'running';
        } else {
          status = 'pending';
        }
        return { stepId: s.id, status };
      });

      return { definition, currentStepId, stepStates };
    }),

  /**
   * Subscribe to step-transition events for a specific run.
   *
   * Events are emitted by stepTransitionBridge.buildStepTransitionEvent() and
   * filtered server-side by runId so clients only receive events for their run.
   *
   * No throttle — step transitions are infrequent boundary events (unlike
   * high-throughput stream output) and must not be coalesced.
   *
   * Backed by the module-level `stepTransitionEvents` EventEmitter (declared in
   * events.ts, wired in stepTransitionBridge.ts). The 'transition' event name
   * matches the emit call in buildStepTransitionEvent.
   */
  onStepTransition: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .subscription(async function* ({ input, signal }): AsyncGenerator<WorkflowStepTransitionEvent> {
      const abortSignal = signal ?? new AbortController().signal;
      const source = eventToAsyncIterable<WorkflowStepTransitionEvent>(
        stepTransitionEvents,
        'transition',
        abortSignal,
      );
      for await (const ev of source) {
        if (ev.runId !== input.runId) continue;
        yield ev;
      }
    }),
});
