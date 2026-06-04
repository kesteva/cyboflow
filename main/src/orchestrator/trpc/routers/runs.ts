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
import { resolveWorkflowDefinition } from '../../../../../shared/types/workflows';
import type { WorkflowStepTransitionEvent } from '../../../../../shared/types/workflows';
import type { ChatMessage } from '../../../../../shared/types/chatMessage';
import type { UnifiedMessage } from '../../../../../shared/types/unifiedMessage';
import type { DatabaseLike } from '../../types';
import { getStuckInspectionHandler } from '../../inspectorQueries';
import { listRunsHandler } from '../../runQueries';
import { selectRunMessages } from '../../runMessagesListing';
import { selectRunUnifiedMessages } from '../../runUnifiedMessagesListing';
import { selectRunRawStreamEvents } from '../../runRawEventsListing';
import type { StreamEnvelope } from '../../../../../shared/types/claudeStream';
import type { CliSubstrate } from '../../../../../shared/types/substrate';
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
  /**
   * Launch a workflow run. `substrate` carries the user's per-run CLI choice
   * (IDEA-013) down to the S1 resolver/stamp in WorkflowRegistry.createRun;
   * `taskId` links the run to a native backlog task (migration 014). Both are
   * OPTIONAL — when substrate is omitted the run falls through the resolver
   * ladder to DEFAULT_SUBSTRATE ('sdk'); when taskId is omitted no task link is
   * recorded.
   */
  launch(workflowId: string, projectPath: string, substrate?: CliSubstrate, taskId?: string): Promise<{
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
// live-input relay dependency bag (IDEA-030 / TASK-817)
//
// The ONLY post-spawn input path into a LIVE interactive run. Injected at boot
// by main/src/index.ts via setRelayDeps(), backed by SubstrateDispatchFacade's
// relayInput/relayResize (which route to the interactive manager's live PTY and
// NO-OP for the SDK substrate). Function-reference shape (mirrors
// CancelAndRestartDeps.claudeManagerStop) keeps the router free of any
// services/* import (standalone-typecheck invariant). Until wired, the relay
// mutations throw METHOD_NOT_SUPPORTED — same stub pattern as the other dep-bags.
// ---------------------------------------------------------------------------

export interface RelayDeps {
  /** Relay a complete REPL turn (text + '\n') into the live interactive PTY. */
  relayInput(runId: string, text: string): void;
  /** Relay a PTY geometry change into the live interactive node-pty. */
  relayResize(runId: string, cols: number, rows: number): void;
  /**
   * Explicitly END a LIVE interactive run's persistent REPL (IDEA-030 /
   * TASK-818). Writes the EOF/`/exit` control sequence so the interactive
   * manager's inherited onExit settles the run's spawn promise and tears the run
   * down — the ONLY non-kill spawn-promise resolver for a persistent interactive
   * run. Strict NO-OP for the SDK substrate (no PTY). Called by the close-out
   * mutations (merge / createPr / dismiss) BEFORE worktree removal so the live
   * REPL is terminated as part of close-out. RelayDeps is the SINGLE bag for
   * live-session collaborators (relay + end-session).
   */
  endSession(runId: string): Promise<void>;
  /**
   * HARD-terminate a LIVE interactive run's persistent REPL (IDEA-030). The
   * discard twin of `endSession`: routes to the manager's `killProcess` (teardown
   * + process-tree kill) instead of a graceful EOF/`/exit`, because a RUNNING
   * claude is busy and never reads the polite request — so on Dismiss of an
   * in-flight flow the process would linger orphaned. Used by `dismiss` ONLY;
   * merge / createPr keep `endSession` (their claude is idle at awaiting-review).
   * Strict NO-OP for the SDK substrate. Idempotent.
   */
  killSession(runId: string): Promise<void>;
  /**
   * Return the retained interactive-PTY backlog for a run (IDEA-030 blank-xterm
   * fix). The renderer fetches this on mount and REPLAYS it into the xterm so a
   * late-mounting terminal reconstructs claude's current screen instead of
   * rendering blank (the live `cyboflow:pty:<runId>` channel drops bytes emitted
   * before a listener exists). Empty string for an unknown/SDK run.
   */
  getPtyBacklog(runId: string): string;
}

let relayDeps: RelayDeps | null = null;

/**
 * Wire up the real collaborators for the relayInput / relayResize mutations.
 *
 * Called once at boot by main/src/index.ts after the SubstrateDispatchFacade is
 * constructed. Until this is called the mutations throw METHOD_NOT_SUPPORTED.
 */
export function setRelayDeps(deps: RelayDeps): void {
  relayDeps = deps;
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
  /**
   * `git branch -d/-D "<branch>"` — idempotent on already-gone branches. Called
   * AFTER the worktree is removed so the branch is no longer checked out.
   */
  deleteBranch(projectPath: string, branchName: string, opts?: { force?: boolean }): Promise<void>;
  /** `git push` from the worktree — pushes the run's branch to origin (Create-PR). */
  gitPush(worktreePath: string): Promise<{ output: string }>;
  /** Resolve the origin remote URL + current branch of the worktree (Create-PR). */
  getRemoteUrlAndBranch(worktreePath: string): Promise<{ remoteUrl: string; branchName: string }>;
}

export interface RunCloseoutSessionManagerLike {
  getProjectById(projectId: number): { path: string } | undefined;
}

/**
 * Narrow slice of TaskChangeRouter needed for run close-out stage derivation
 * (migration 014). Optional — when absent, close-out skips native-task
 * derivation (backward-compat with the pre-tasks close-out path). The concrete
 * TaskChangeRouter singleton satisfies this shape structurally; the boot wiring
 * in main/src/index.ts passes it in.
 */
export interface RunCloseoutTaskDeriverLike {
  recomputeTaskExecutionStage(taskId: string): Promise<void>;
}

export interface RunCloseoutDeps {
  worktreeManager: RunWorktreeManagerLike;
  sessionManager: RunCloseoutSessionManagerLike;
  /**
   * Settle + drop any pending approvals for the run so close-out doesn't leave
   * orphaned items stuck in the review queue. Backed by
   * ApprovalRouter.clearPendingForRun (settles in-memory entries + sweeps any
   * DB-only `pending` rows, emitting approvalDecided for each).
   */
  clearPendingApprovalsForRun: (runId: string) => void;
  /**
   * Optional native-task stage deriver (migration 014). When wired, the merge /
   * createPr / dismiss mutations stamp workflow_runs.outcome and recompute the
   * linked task's derived execution stage through the chokepoint. The run's
   * task_id is resolved BEFORE worktree teardown (the run row survives teardown,
   * but the lookup is kept adjacent to the outcome write for clarity).
   */
  taskStageDeriver?: RunCloseoutTaskDeriverLike;
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

/**
 * Stamp the DB-canonical close-out signal on workflow_runs.outcome and recompute
 * the linked task's derived execution stage through the chokepoint (migration 014).
 *
 * GATED on a wired `taskStageDeriver`: the entire migration-013 close-out path —
 * including ANY reference to the `task_id` / `outcome` columns — is opt-in via the
 * injected deriver. When no deriver is wired (the pre-tasks close-out path, and the
 * legacy close-out tests whose fixture DB omits the migration-013 columns), this is
 * a complete no-op that touches none of the new columns.
 *
 * The run's `task_id` is read here, AFTER the git/worktree close-out but using the
 * run row that survives teardown (worktree teardown does not delete the run row).
 * The read is kept adjacent to the outcome write so both touch the new columns only
 * under the same gate.
 *
 * Fail-soft: a task-side error is logged-then-swallowed so it never fails an
 * otherwise-successful merge / PR / dismiss.
 *
 *   'merged'    → task -> Done
 *   'pr_open'   → task stays at Ready to merge
 *   'dismissed' → task reverts to its entry (planning) stage
 */
async function stampOutcomeAndDeriveTask(
  db: DatabaseLike,
  runId: string,
  outcome: 'merged' | 'pr_open' | 'dismissed',
): Promise<void> {
  const deriver = runCloseoutDeps?.taskStageDeriver;
  if (!deriver) return; // migration-013 close-out is opt-in; touch no new columns otherwise

  try {
    // task_id read + outcome write both gated behind the deriver so the legacy
    // (no-deriver) path never references columns a pre-migration-013 DB lacks.
    const linkRow = db
      .prepare('SELECT task_id FROM workflow_runs WHERE id = ?')
      .get(runId) as { task_id: string | null } | undefined;
    db.prepare(
      `UPDATE workflow_runs SET outcome = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).run(outcome, runId);

    const taskId = linkRow?.task_id ?? null;
    if (!taskId) return;
    await deriver.recomputeTaskExecutionStage(taskId);
  } catch (err) {
    console.error(
      `[runs.closeout] task stage derivation failed (run ${runId}, outcome ${outcome}):`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Terminate a LIVE interactive run's persistent REPL as part of close-out
 * (IDEA-030 / TASK-818). Routes through the RelayDeps `endSession` seam (backed
 * by SubstrateDispatchFacade.endSession), which writes EOF/`/exit` into the live
 * PTY so the run's spawn promise resolves and teardown fires. Strict NO-OP for
 * the SDK substrate (the facade resolves the substrate per-run). Called BEFORE
 * worktree removal in merge / createPr / dismiss.
 *
 * Fail-soft + opt-in: when `relayDeps` is not wired (legacy close-out / tests
 * that don't inject the relay bag) this is a complete no-op — close-out still
 * proceeds. A throwing endSession is logged-then-swallowed so a flaky live-PTY
 * write never fails an otherwise-successful merge / PR / dismiss; the guarded
 * UPDATE below marks the run terminal regardless.
 */
async function endLiveInteractiveSession(runId: string): Promise<void> {
  if (!relayDeps) return;
  try {
    await relayDeps.endSession(runId);
  } catch (err) {
    console.error(
      `[runs.closeout] endSession failed (run ${runId}):`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * HARD-terminate a LIVE interactive run's persistent REPL as part of the DISMISS
 * close-out (IDEA-030). Routes through the RelayDeps `killSession` seam (backed
 * by SubstrateDispatchFacade.killSession → manager.killProcess), which kills the
 * process tree + tears the run down — NOT the graceful EOF/`/exit` of
 * `endSession`, which a RUNNING (busy) claude never reads, leaving the process
 * orphaned. Dismiss discards the run, so a hard kill is correct. Strict NO-OP for
 * the SDK substrate. Same fail-soft + opt-in contract as endLiveInteractiveSession:
 * a missing relay bag or a throwing kill is swallowed so close-out still proceeds
 * (the guarded UPDATE marks the run terminal regardless).
 */
async function killLiveInteractiveSession(runId: string): Promise<void> {
  if (!relayDeps) return;
  try {
    await relayDeps.killSession(runId);
  } catch (err) {
    console.error(
      `[runs.closeout] killSession failed (run ${runId}):`,
      err instanceof Error ? err.message : String(err),
    );
  }
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

  /**
   * Start a new workflow run for the given workflow and project.
   *
   * `substrate` is the user's per-run CLI choice (IDEA-013 / TASK-812). It is
   * OPTIONAL and validated against the CliSubstrate union via z.enum; when the
   * renderer omits it, resolution falls through the override ladder to
   * DEFAULT_SUBSTRATE ('sdk'). The value is carried into runLauncher.launch and
   * stamped (immutably, once) onto workflow_runs.substrate by the S1 resolver
   * inside WorkflowRegistry.createRun — this router only forwards the choice.
   */
  start: protectedProcedure
    .input(z.object({
      workflowId: z.string().min(1),
      projectId: z.number().int().positive(),
      substrate: z.enum(['sdk', 'interactive']).optional(),
      // Optional native-task link (migration 014). When supplied, the launcher
      // records workflow_runs.task_id and derives the task's execution stage.
      taskId: z.string().min(1).optional(),
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
      // Forward the per-run substrate choice (IDEA-013) and native-task link
      // (migration 014). When BOTH are omitted, call the legacy 2-arg shape so
      // the resolver ladder owns the substrate decision and the SDK-default call
      // site stays byte-identical (zero-behavior-change floor); otherwise pass
      // both (substrate may be undefined, which the resolver treats as default).
      const { runId, worktreePath, branchName } =
        input.substrate === undefined && input.taskId === undefined
          ? await startRunDeps.runLauncher.launch(input.workflowId, project.path)
          : await startRunDeps.runLauncher.launch(input.workflowId, project.path, input.substrate, input.taskId);
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
   * Relay a complete REPL turn into a LIVE interactive run (IDEA-030 / TASK-817).
   *
   * The `runId === panelId === sessionId` orchestrator invariant means the runId
   * IS the panelId, so this forwards straight to facade.relayInput(panelId=runId,
   * text) with no lookup. The composer appends '\n' to make the text a complete
   * REPL turn the user submitted; the raw-keystroke path (InteractiveTerminalView)
   * sends bytes verbatim. The relay writes into the SAME running process (never a
   * kill+respawn) and is a strict NO-OP for the SDK substrate (no PTY) — so the
   * structured Workflow panel + SDK path stay byte-identical (Q3).
   *
   * Standalone-typecheck invariant: the facade is injected as a function ref via
   * setRelayDeps(); until wired the mutation throws METHOD_NOT_SUPPORTED.
   */
  relayInput: protectedProcedure
    .input(z.object({ runId: z.string().min(1), text: z.string() }))
    .mutation(({ input }): { success: true } => {
      if (!relayDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'relay dependencies not wired yet (IDEA-030). Call setRelayDeps() at boot.',
        });
      }
      relayDeps.relayInput(input.runId, input.text);
      return { success: true };
    }),

  /**
   * Relay a PTY geometry change into a LIVE interactive run (IDEA-030 / TASK-817).
   *
   * runId IS the panelId per the orchestrator invariant, so this forwards to
   * facade.relayResize(panelId=runId, cols, rows). Safe to call regardless of the
   * first-interaction guardrail (resize never mutates session state). NO-OP for
   * the SDK substrate and a NO-OP on the interactive manager until its resize seam
   * lands (TASK-818). Throws METHOD_NOT_SUPPORTED until setRelayDeps() is wired.
   */
  relayResize: protectedProcedure
    .input(z.object({
      runId: z.string().min(1),
      cols: z.number().int().positive(),
      rows: z.number().int().positive(),
    }))
    .mutation(({ input }): { success: true } => {
      if (!relayDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'relay dependencies not wired yet (IDEA-030). Call setRelayDeps() at boot.',
        });
      }
      relayDeps.relayResize(input.runId, input.cols, input.rows);
      return { success: true };
    }),

  /**
   * Return the retained interactive-PTY backlog for a run (IDEA-030 blank-xterm
   * fix). InteractiveTerminalView calls this once on mount and replays the bytes
   * into the xterm BEFORE live `cyboflow:pty:<runId>` chunks, so claude's startup
   * TUI paint (emitted before the renderer subscribed) is reconstructed instead of
   * lost. A read-only query; returns '' for the SDK substrate / unknown run.
   * Throws METHOD_NOT_SUPPORTED until setRelayDeps() is wired.
   */
  getPtyBacklog: protectedProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .query(({ input }): { backlog: string } => {
      if (!relayDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'relay dependencies not wired yet (IDEA-030). Call setRelayDeps() at boot.',
        });
      }
      return { backlog: relayDeps.getPtyBacklog(input.runId) };
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
      const { worktreePath, branchName, projectPath } = resolveRunForCloseout(ctx.db, input.runId);
      // deps is guaranteed non-null after resolveRunForCloseout (it throws otherwise).
      const wm = deps!.worktreeManager;

      // Terminate the live interactive REPL (IDEA-030 / TASK-818) BEFORE the
      // worktree mutation so its spawn promise resolves as part of close-out.
      // NO-OP for the SDK substrate and when the relay bag is unwired.
      await endLiveInteractiveSession(input.runId);

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
      // The content is now in main; delete the run's branch so close-out doesn't
      // leave an orphaned ref. Force-delete because a squash merge leaves the
      // branch a non-ancestor of main (safe `-d` would refuse it). Skip when the
      // run never recorded a branch name.
      if (branchName) {
        await wm.deleteBranch(projectPath, branchName, { force: true });
      }
      // Drop any pending approvals for the run so close-out doesn't leave
      // orphaned items in the review queue.
      deps!.clearPendingApprovalsForRun(input.runId);
      ctx.db
        .prepare(
          `UPDATE workflow_runs
              SET status = 'completed', ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status NOT IN ('completed', 'failed', 'canceled')`,
        )
        .run(input.runId);
      // DB-canonical merge signal + task derivation (-> Done). NO git probe: the
      // squash/merge above already succeeded, so 'merged' is authoritative. The
      // chokepoint aggregate keys 'done' on outcome='merged', so this MUST be
      // stamped before the recompute (handled inside the helper).
      await stampOutcomeAndDeriveTask(ctx.db, input.runId, 'merged');
      return { success: true };
    }),

  /**
   * Create a pull request for a workflow run (GAP-B / un-defer): push the run's
   * branch from its worktree to origin, then return the origin remote URL +
   * branch name so the renderer can open the GitHub compare URL. Mirrors the
   * session-scoped Create-PR flow (sessions:git-push + sessions:get-remote-url),
   * but operates on the workflow_runs row + its nested worktree path.
   *
   * After a successful push the run's artifact is considered delivered, so the
   * run is marked terminal ('completed') — the same close-out outcome as merge.
   * The local worktree is removed (idempotent) since the branch now lives on
   * origin; this matches the session flow's post-PR session deletion.
   *
   * Completion is a guarded UPDATE (`WHERE status NOT IN (terminal)`) so it works
   * from the run's CURRENT status (awaiting_review / stuck / running) and no-ops
   * if the run already reached a terminal state.
   */
  createPr: protectedProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .mutation(async ({ ctx, input }): Promise<{ remoteUrl: string; branchName: string }> => {
      if (!ctx.db) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'db not wired into tRPC context' });
      }
      const deps = runCloseoutDeps;
      const { worktreePath, projectPath } = resolveRunForCloseout(ctx.db, input.runId);
      // deps is guaranteed non-null after resolveRunForCloseout (it throws otherwise).
      const wm = deps!.worktreeManager;

      // Terminate the live interactive REPL (IDEA-030 / TASK-818) BEFORE pushing
      // so its spawn promise resolves as part of close-out. NO-OP for SDK /
      // unwired relay bag.
      await endLiveInteractiveSession(input.runId);

      await wm.gitPush(worktreePath);
      const { remoteUrl, branchName } = await wm.getRemoteUrlAndBranch(worktreePath);

      // Artifact delivered to origin — close the run out. Remove the local
      // worktree (the branch now lives on origin) and mark the run completed.
      // The local branch is intentionally NOT deleted here: it tracks the
      // pushed origin branch the user is about to open a PR from.
      await wm.removeWorktreeByPath(projectPath, worktreePath);
      // Drop any pending approvals for the run so close-out doesn't leave
      // orphaned items in the review queue.
      deps!.clearPendingApprovalsForRun(input.runId);
      ctx.db
        .prepare(
          `UPDATE workflow_runs
              SET status = 'completed', ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status NOT IN ('completed', 'failed', 'canceled')`,
        )
        .run(input.runId);
      // outcome='pr_open' keeps the task at Ready to merge (the chokepoint
      // aggregate maps pr_open -> merge). The PR is open but not yet merged, so
      // the task is NOT marked Done here — that happens on a later merge.
      await stampOutcomeAndDeriveTask(ctx.db, input.runId, 'pr_open');

      return { remoteUrl, branchName };
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
      const { worktreePath, branchName, projectPath } = resolveRunForCloseout(ctx.db, input.runId);
      // HARD-kill the live interactive REPL (IDEA-030) BEFORE removing the
      // worktree. Dismiss can target a RUNNING flow whose claude is busy and never
      // reads a graceful EOF/`/exit`, so endSession would leave the process alive
      // (orphaned in the Claude app) and holding the worktree open during removal.
      // killSession routes to killProcess (teardown + process-tree kill); the
      // spawn-promise settle on kill is the designed RunExecutor close path. NO-OP
      // for the SDK substrate and when the relay bag is unwired.
      await killLiveInteractiveSession(input.runId);
      await deps!.worktreeManager.removeWorktreeByPath(projectPath, worktreePath);
      // Dismiss discards the run — force-delete its branch too (its commits go
      // with it), so close-out doesn't leave an orphaned ref. No-op when the run
      // never recorded a branch name.
      if (branchName) {
        await deps!.worktreeManager.deleteBranch(projectPath, branchName, { force: true });
      }
      // Drop any pending approvals for the run so close-out doesn't leave
      // orphaned items in the review queue.
      deps!.clearPendingApprovalsForRun(input.runId);
      ctx.db
        .prepare(
          `UPDATE workflow_runs
              SET status = 'canceled', ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status NOT IN ('completed', 'failed', 'canceled')`,
        )
        .run(input.runId);
      // outcome='dismissed' + recompute reverts the task to its entry (planning)
      // stage: the chokepoint aggregate sees all runs terminal-without-merge and
      // restores entry_stage_id (fallback Ready for development).
      await stampOutcomeAndDeriveTask(ctx.db, input.runId, 'dismissed');
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
   * Return the run's full RAW stream-event log as `StreamEnvelope[]` — the same
   * envelope shape the live IPC bridge publishes — so the Data Stream tab can
   * BACKFILL its history when a run is reopened. Without this the in-memory
   * `streamEvents` buffer (wiped on every `setActiveRun`) made the stream
   * appear erased after clicking away and returning.
   *
   * Unlike `listUnifiedMessages` (which folds events into correlated chat
   * messages), this preserves every persisted event 1:1, including
   * `stream_event` deltas — see `selectRunRawStreamEvents`.
   */
  listRawEvents: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(async ({ ctx, input }): Promise<StreamEnvelope[]> => {
      if (!ctx.db) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'db not wired into tRPC context',
        });
      }
      return selectRunRawStreamEvents(ctx.db, input.runId);
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
   *   NOT_FOUND           — no effective WorkflowDefinition resolves for the run
   *                         (resolveWorkflowDefinition returned null: a custom
   *                         flow with a missing/broken spec, or an unknown name).
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
          `SELECT wr.current_step_id, wr.status AS run_status, w.name AS workflow_name, w.spec_json AS spec_json
             FROM workflow_runs wr
             JOIN workflows w ON wr.workflow_id = w.id
            WHERE wr.id = ?`,
        )
        .get(input.runId) as
        | { current_step_id: string | null; run_status: string; workflow_name: string; spec_json: string | null }
        | undefined;

      if (row === undefined) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Run ${input.runId} not found`,
        });
      }

      // Resolve the effective definition: an edited/custom `spec_json` wins, else
      // the built-in fallback for a SoloFlowWorkflowName, else null.
      const definition = resolveWorkflowDefinition(row.workflow_name, row.spec_json);
      if (definition === null) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `No workflow definition for run ${input.runId} (workflow name '${row.workflow_name}')`,
        });
      }

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
