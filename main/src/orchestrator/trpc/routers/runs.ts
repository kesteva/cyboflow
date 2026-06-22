/**
 * cyboflow.runs sub-router.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import type { StuckInspectionResult } from '../../../../../shared/types/stuckInspection';
import type { WorkflowRunListRow, WorkflowDefinition, WorkflowStepState, PermissionMode } from '../../../../../shared/types/workflows';
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
import { listRunFiles, readRunFile } from '../../runFileExplorer';
import { withRunFileErrorMapping } from '../runFileErrors';
import type { RunFileEntry, RunFileContent } from '../../../../../shared/types/runFiles';
import type { StreamEnvelope } from '../../../../../shared/types/claudeStream';
import type { CliSubstrate } from '../../../../../shared/types/substrate';
import type { SprintLaneRow, SprintLaneChangedEvent } from '../../../../../shared/types/sprintBatch';
import { SPRINT_BATCH_MAX_TASKS } from '../../../../../shared/types/sprintBatch';
import { sprintLaneEvents, sprintLaneChannel, SprintLaneStore } from '../../sprintLaneStore';
import { countPendingBlockingReviewItems } from '../../reviewItemListing';
import { ApprovalRouter } from '../../approvalRouter';
import { QuestionRouter } from '../../questionRouter';
import {
  cancelAndRestartHandler,
  type CancelAndRestartDeps,
} from '../../cancelAndRestartHandler';
import {
  cancelRunHandler,
  type CancelRunDeps,
  type CancelRunResult,
} from '../../cancelRunHandler';
import type { WorkflowRunRow } from '../../../../../shared/types/cyboflow';
import {
  nudgeRunHandler,
  type NudgeRunDeps,
  type NudgeRunResult,
} from '../../nudgeRunHandler';
import {
  pauseRunHandler,
  type PauseRunDeps,
  type PauseRunResult,
} from '../../pauseRunHandler';
import {
  resumeRunHandler,
  type ResumeRunDeps,
  type ResumeRunResult,
} from '../../resumeRunHandler';
import {
  reopenRunHandler,
  type ReopenRunDeps,
  type ReopenRunResult,
} from '../../reopenRunHandler';
import { stepTransitionEvents, eventToAsyncIterable, runStatusEvents } from './events';

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
// cancel dependency bag (session<->run restructure, Phase 4a — git-neutral run Cancel)
//
// Injected at boot by main/src/index.ts via setCancelRunDeps(). The git-neutral
// Cancel stops the live agent on BOTH substrates (via SubstrateDispatchFacade.
// abort — which routes to the spawning manager's killProcess; killSession is a
// no-op for SDK runs) and marks the run 'canceled' — it NEVER touches git (no worktree
// removal, no merge, no branch delete), so its dep bag is deliberately free of any
// WorktreeManager collaborator (contrast RunCloseoutDeps). Until wired the mutation
// throws METHOD_NOT_SUPPORTED — same stub pattern as the other dep-bags.
// ---------------------------------------------------------------------------

let cancelRunDeps: CancelRunDeps | null = null;

/**
 * Wire up the real collaborators for the git-neutral `cancel` mutation.
 *
 * Called once at boot by main/src/index.ts after the DB, RunQueueRegistry,
 * SubstrateDispatchFacade, ApprovalRouter, and QuestionRouter are constructed.
 *
 * Until this is called the mutation throws METHOD_NOT_SUPPORTED (same as all
 * other stub procedures in this router).
 */
export function setCancelRunDeps(deps: CancelRunDeps): void {
  cancelRunDeps = deps;
}

// ---------------------------------------------------------------------------
// pause / resume dependency bags (session<->run restructure, Phase 4b —
// SDK-ONLY Pause/Resume)
//
// Pause is the NON-terminal, git-neutral twin of Cancel: it stops the active SDK
// turn and parks the run in `paused`, PRESERVING claude_session_id +
// current_step_id so Resume can re-drive the SAME conversation via the SDK
// --resume path. Both are SDK-ONLY — the handlers refuse a non-sdk run (the
// interactive substrate is fresh-session-only with no native --resume). Like
// Cancel, neither bag carries a WorktreeManager collaborator — they NEVER touch
// git. Until wired the mutations throw METHOD_NOT_SUPPORTED — same stub pattern as
// the other dep-bags.
// ---------------------------------------------------------------------------

let pauseRunDeps: PauseRunDeps | null = null;

/**
 * Wire up the real collaborators for the SDK-only `pause` mutation.
 *
 * Called once at boot by main/src/index.ts after the DB, RunQueueRegistry,
 * SubstrateDispatchFacade, ApprovalRouter, and QuestionRouter are constructed.
 * Until this is called the mutation throws METHOD_NOT_SUPPORTED.
 */
export function setPauseRunDeps(deps: PauseRunDeps): void {
  pauseRunDeps = deps;
}

let resumeRunDeps: ResumeRunDeps | null = null;

/**
 * Wire up the real collaborators for the SDK-only `resume` mutation.
 *
 * Called once at boot by main/src/index.ts after the DB, RunQueueRegistry, and
 * RunExecutor (the SAME module-scoped instance nudge uses, so the executor's
 * pendingResume / pendingNudge maps are shared) are constructed. Until this is
 * called the mutation throws METHOD_NOT_SUPPORTED.
 */
export function setResumeRunDeps(deps: ResumeRunDeps): void {
  resumeRunDeps = deps;
}

// ---------------------------------------------------------------------------
// nudge dependency bag (Piece C — idle-chat nudge)
//
// Injected at boot by main/src/index.ts via setNudgeRunDeps(), alongside the
// cancelAndRestart / start wiring. Until wired the mutation throws
// METHOD_NOT_SUPPORTED — same pattern as cancelAndRestart.
// ---------------------------------------------------------------------------

let nudgeRunDeps: NudgeRunDeps | null = null;

/**
 * Wire up the real collaborators for the nudge mutation.
 *
 * Called once at boot by main/src/index.ts after the DB, RunQueueRegistry, and
 * RunExecutor have been initialized. Until this is called the mutation throws
 * METHOD_NOT_SUPPORTED.
 */
export function setNudgeRunDeps(deps: NudgeRunDeps): void {
  nudgeRunDeps = deps;
}

// ---------------------------------------------------------------------------
// reopen dependency bag (session reopen-on-timeout follow-up)
//
// Injected at boot by main/src/index.ts via setReopenRunDeps(), reusing the SAME
// RunExecutor instance nudge/resume use. Until wired the mutation throws
// METHOD_NOT_SUPPORTED — same pattern as nudge/resume.
// ---------------------------------------------------------------------------

let reopenRunDeps: ReopenRunDeps | null = null;

/**
 * Wire up the real collaborators for the SDK-only `reopen` mutation.
 *
 * Called once at boot by main/src/index.ts after the DB, RunQueueRegistry, and
 * RunExecutor have been initialized. Until this is called the mutation throws
 * METHOD_NOT_SUPPORTED.
 */
export function setReopenRunDeps(deps: ReopenRunDeps): void {
  reopenRunDeps = deps;
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
   * `taskId` links the run to a native backlog task (migration 014); `ideaId`
   * is the planner's pre-launch seed idea (migration 017), written DIRECTLY to
   * workflow_runs.seed_idea_id (NOT routed through the task-stage deriver);
   * `sessionId` hosts the run inside an existing session's worktree (session<->run
   * restructure, Phase 1 / migration 019); `requestedPermissionMode` carries the
   * user's per-run agent-permission choice (WorkflowPicker) down to the resolver's
   * highest-precedence `requestedMode` rung in WorkflowRegistry.createRun;
   * `baseBranch` cuts the run's dedicated worktree branch off a non-default tip;
   * `seedTaskIds` (feat/parallel-sprint, single-run lane model) seeds the
   * per-task lanes of a session-hosted `sprint` run — only valid when the
   * workflow's name === 'sprint'; `projectId` is the EXPLICIT launch project
   * (migration 030 — global workflows) threaded into WorkflowRegistry.createRun
   * (stamped onto workflow_runs.project_id) and SprintLaneStore.createForRun;
   * `findingIds` (findings-triage redesign / migration 032) seeds the selected
   * findings of a `compound` run — only valid when the workflow's name ===
   * 'compound', written DIRECTLY to workflow_runs.seed_finding_ids. All are
   * OPTIONAL — when substrate is omitted the run falls through the resolver
   * ladder to DEFAULT_SUBSTRATE ('sdk'); when taskId / ideaId are omitted no link
   * is recorded; when sessionId is omitted the run creates its own dedicated
   * worktree (legacy path); when requestedPermissionMode is omitted the
   * permission ladder falls through to frontmatter → global default → 'default';
   * when projectId is omitted createRun falls back to workflow.project_id (a
   * GLOBAL workflow launched without it throws); when findingIds is omitted the
   * run is not finding-seeded.
   */
  launch(workflowId: string, projectPath: string, substrate?: CliSubstrate, taskId?: string, ideaId?: string, sessionId?: string, requestedPermissionMode?: PermissionMode, baseBranch?: string, seedTaskIds?: string[], projectId?: number, findingIds?: string[]): Promise<{
    runId: string;
    worktreePath: string;
    branchName: string;
    // The resolved-and-stamped per-run permission mode. The start mutation does
    // not forward it in its response (it lives on workflow_runs.permission_mode_snapshot),
    // but the interface mirrors the implementation's return shape for type accuracy.
    permissionMode: PermissionMode;
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
// sprint-lane dependency bag (feat/parallel-sprint, single-run lane model)
//
// Backs cyboflow.runs.sprintLanes. Injected at boot by main/src/index.ts via
// setSprintLaneDeps() after SprintLaneStore.initialize. Until wired the query
// throws METHOD_NOT_SUPPORTED — same stub pattern as the other dep-bags.
// ---------------------------------------------------------------------------

/** Narrow slice of SprintLaneStore the runs router reads. */
export interface SprintLaneDeps {
  listLanes(batchId: string): SprintLaneRow[];
}

let sprintLaneDeps: SprintLaneDeps | null = null;

export function setSprintLaneDeps(deps: SprintLaneDeps): void {
  sprintLaneDeps = deps;
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
// run user-shell dependency bag (worktree-terminal feature)
//
// Backs the run "Shell" tab: a plain $SHELL PTY in the run's worktree, keyed by
// runId. Flow runs (planner/sprint/compound/ship) never create a `sessions` row
// (workflow_runs.session_id is always NULL — migration 019), so the panel/session
// terminal stack (TerminalPanelManager) cannot host them; this bag is the
// run-scoped substitute. Injected at boot by main/src/index.ts via
// setRunShellDeps(), backed by RunShellManager. Function-reference shape keeps the
// router free of any services/* import (standalone-typecheck invariant). Until
// wired, the shell procedures throw METHOD_NOT_SUPPORTED — same stub pattern as
// the relay bag. The user shell is wholly independent of the agent PTY pipeline
// (relayInput/getPtyBacklog), so the structured SDK/interactive stream is
// untouched (Q3 panel-preservation).
// ---------------------------------------------------------------------------

export interface RunShellDeps {
  /** Lazily spawn the run's worktree shell (idempotent). `ok:false` +
   *  `reason:'no_worktree'` when the run has no worktree to anchor it in. */
  open(runId: string): { ok: boolean; reason?: string };
  /** Write user keystrokes verbatim into the run's shell. */
  write(runId: string, data: string): void;
  /** Relay an xterm geometry change into the run's shell. */
  resize(runId: string, cols: number, rows: number): void;
  /** The retained scrollback tail, replayed into a (re)mounting xterm. */
  getBacklog(runId: string): string;
  /** Terminate + forget the run's shell (close-out, before worktree removal). */
  close(runId: string): void;
}

let runShellDeps: RunShellDeps | null = null;

/**
 * Wire up the RunShellManager-backed collaborators for the shell* procedures.
 * Called once at boot by main/src/index.ts. Until called the procedures throw
 * METHOD_NOT_SUPPORTED.
 */
export function setRunShellDeps(deps: RunShellDeps): void {
  runShellDeps = deps;
}

/**
 * Tear down a run's user shell as part of close-out (merge / createPr / dismiss),
 * before worktree removal so no shell process (or a dev server it launched) keeps
 * the worktree dir open during removal. Fail-soft + opt-in: a missing bag or a
 * throwing close is swallowed so close-out still proceeds.
 */
function closeRunShell(runId: string): void {
  if (!runShellDeps) return;
  try {
    runShellDeps.close(runId);
  } catch (err) {
    console.error(
      `[runs.closeout] run shell close failed (run ${runId}):`,
      err instanceof Error ? err.message : String(err),
    );
  }
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
   * Dispose the run's ON-DEMAND monitor at terminal close-out (the monitor-unify
   * refactor): tears down the per-run inject plumbing (progSource/progBridge) AND
   * unregisters the MonitorRegistry entry. Unlike the rest of the run's per-run
   * state (disposed at walk-drain by RunExecutor.teardownRun), the monitor survives
   * the walk so the user can chat with it while the run rests — so it must be
   * disposed HERE, where the worktree is removed (merge / createPr / dismiss). A
   * no-op for runs that never had an SDK monitor. Backed by
   * RunExecutor.disposeMonitorResources + MonitorRegistry.unregister.
   */
  disposeMonitorResources: (runId: string) => void;
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
): { worktreePath: string; branchName: string | null; projectPath: string; sessionId: string | null } {
  if (!runCloseoutDeps) {
    throw new TRPCError({
      code: 'METHOD_NOT_SUPPORTED',
      message: 'run close-out dependencies not wired yet. Call setRunCloseoutDeps() at boot.',
    });
  }
  const row = db
    .prepare('SELECT worktree_path, branch_name, project_id, session_id FROM workflow_runs WHERE id = ?')
    .get(runId) as
    | { worktree_path: string | null; branch_name: string | null; project_id: number; session_id: string | null }
    | undefined;
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
  return {
    worktreePath: row.worktree_path,
    branchName: row.branch_name,
    projectPath: project.path,
    sessionId: row.session_id,
  };
}

/**
 * Close-out safety guard (session<->run restructure, Phase 1).
 *
 * A SESSION-HOSTED run (session_id != null) executes inside the SHARED session
 * worktree, so the run-level close-out path MUST NEVER touch git — removing the
 * worktree or deleting the branch would destroy work that belongs to the session,
 * not the run. Merging is likewise the session's job (wired in Phase 3). For such
 * runs every run-level close-out mutation (merge / createPr / dismiss) throws
 * PRECONDITION_FAILED; the frontend routes those actions to the owning session in
 * Phase 3. Run-level Cancel (Phase 4a) is IMPLEMENTED and deliberately does NOT
 * go through this guard — it is git-neutral (stop the agent + mark 'canceled', no
 * worktree touch), so it is safe for session-hosted runs. Run-level Pause is
 * deferred to a later pass.
 *
 * Legacy runs (session_id == null) are unaffected — this is a no-op for them.
 */
function assertNotSessionHosted(runId: string, sessionId: string | null): void {
  if (sessionId !== null) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `Run ${runId} is session-hosted; close it out via its session.`,
    });
  }
}

/**
 * Detect the WorktreeManager's specific "nothing to merge" outcome.
 *
 * A Planner run writes entities to the DB via MCP and makes ZERO git commits, so
 * its worktree branch has no commits ahead of base. WorktreeManager's merge
 * helpers throw a hard error in that case:
 *   squash:   "No commits to squash. The branch is already up to date with <main>."
 *   preserve: "No commits to merge. The branch is already up to date with <main>."
 * which it then re-wraps as a generic `Failed to merge worktree to <main>` /
 * `Failed to squash and merge worktree to <main>` Error carrying the original on
 * an `originalError` field (and the original text on `gitOutput`).
 *
 * The run's output is ALREADY persisted (DB-canonical), so there is genuinely
 * nothing to merge — this is a benign success, NOT a failure. We match on the
 * stable "No commits to" prefix across the wrapped message, the preserved
 * `originalError.message`, and the `gitOutput` snapshot so a re-wrap can't hide
 * it. We deliberately do NOT broaden this to "already up to date" alone — only
 * the WorktreeManager's own no-commits sentinel is swallowed; every other git
 * failure (rebase conflict, non-ff divergence, etc.) still propagates.
 */
function isNoCommitsToMergeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const wrapped = err as Error & { originalError?: unknown; gitOutput?: unknown };
  const candidates: string[] = [err.message];
  if (wrapped.originalError instanceof Error) {
    candidates.push(wrapped.originalError.message);
  }
  if (typeof wrapped.gitOutput === 'string') {
    candidates.push(wrapped.gitOutput);
  }
  return candidates.some(
    (m) => m.includes('No commits to merge') || m.includes('No commits to squash'),
  );
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
      // Optional planner pre-launch seed idea (migration 017). When supplied, the
      // launcher writes workflow_runs.seed_idea_id DIRECTLY (no stage derivation);
      // RunExecutor.getPrompt injects the idea body as a `# Selected idea` block.
      ideaId: z.string().min(1).optional(),
      // Optional session host (session<->run restructure, Phase 1 / migration 019).
      // When supplied, the run executes inside that session's existing worktree
      // instead of creating its own. DORMANT in Phase 1 — no caller passes it yet
      // (the frontend wires it in Phase 3).
      sessionId: z.string().min(1).optional(),
      // Optional per-run agent permission override (WorkflowPicker). When supplied,
      // it is the HIGHEST-precedence rung of the permission ladder in
      // WorkflowRegistry.createRun (requestedMode > frontmatter > global > 'default'),
      // stamped immutably onto workflow_runs.permission_mode_snapshot. When omitted
      // the run inherits the global default — byte-identical to before.
      permissionMode: z.enum(['default', 'acceptEdits', 'auto', 'dontAsk']).optional(),
      // Optional sprint seed tasks (feat/parallel-sprint, single-run lane model).
      // When supplied, the launcher creates the batch + per-task lane rows via
      // SprintLaneStore.createForRun and stamps workflow_runs.batch_id. Only
      // valid for the 'sprint' workflow (the launcher enforces this); the
      // substrate-keyed selection cap N is enforced here (defense in depth — the
      // picker also enforces it client-side).
      taskIds: z.array(z.string().min(1)).optional(),
      // Optional compound seed findings (findings-triage redesign / migration 032).
      // When supplied, the launcher writes workflow_runs.seed_finding_ids (a JSON
      // string array) directly; RunExecutor.getPrompt injects the selected findings
      // as a `## Selected findings` block, and the terminal-seam close-out clears
      // `selected` on any un-resolved seeded finding. Only valid for the 'compound'
      // workflow (the launcher enforces this). Mirrors taskIds/ideaId; NO selection
      // cap (OD-7) — a triage tray may seed any number of findings.
      findingIds: z.array(z.string().min(1)).optional(),
    }))
    .mutation(async ({ ctx, input }): Promise<{ runId: string; worktreePath: string; branchName: string }> => {
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
      // Substrate-keyed sprint selection cap (defense in depth — the batch
      // picker also enforces it client-side). Keyed off the forced pin FIRST
      // (demo 'sdk' / interactive-PTY-only lock 'interactive'), mirroring both
      // substrates.resolveEffective and the value createRun stamps, so the cap
      // the server enforces matches the substrate the run actually runs on; falls
      // back to the requested substrate or the 'sdk' default.
      if (input.taskIds !== undefined) {
        const forced = ctx.getForcedSubstrate?.() ?? null;
        const capSubstrate: CliSubstrate = forced ?? input.substrate ?? 'sdk';
        const max = SPRINT_BATCH_MAX_TASKS[capSubstrate];
        if (input.taskIds.length > max) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `too many tasks for the ${capSubstrate} substrate: ${input.taskIds.length} > ${max}`,
          });
        }
      }
      // Forward the per-run substrate choice (IDEA-013), native-task link
      // (migration 014), planner seed idea (migration 017), session host
      // (Phase 1 / migration 019), per-run agent permission override
      // (WorkflowPicker), and sprint seed tasks (feat/parallel-sprint), PLUS the
      // explicit launch projectId (migration 030 — global workflows) and the
      // compound seed findings (findings-triage / migration 032). The projectId
      // MUST always be threaded now: a GLOBAL built-in / custom flow carries
      // workflow.project_id = NULL, so createRun has no fallback project and would
      // throw without it. (The earlier "legacy 2-arg shape when all optionals are
      // omitted" fast path is gone — it could not supply a project for a global
      // flow.) Any optional arg may still be undefined, which the launcher treats
      // as "no link / no host / resolver default". baseBranch and
      // requestedExecutionModel are never sent over this IPC path — undefined
      // placeholders. findingIds is the LAST positional arg, AFTER
      // requestedExecutionModel.
      const { runId, worktreePath, branchName } = await startRunDeps.runLauncher.launch(
        input.workflowId,
        project.path,
        input.substrate,
        input.taskId,
        input.ideaId,
        input.sessionId,
        input.permissionMode,
        undefined,
        input.taskIds,
        input.projectId,
        undefined,
        input.findingIds,
      );
      return { runId, worktreePath, branchName };
    }),

  /**
   * Git-neutral Cancel of a running workflow run (session<->run restructure,
   * Phase 4a). Stops the live agent on BOTH substrates (via the
   * SubstrateDispatchFacade kill seam injected as cancelRunDeps.stopLiveRun) and
   * marks the run terminal ('canceled') — it NEVER removes a worktree, merges, or
   * deletes a branch. That worktree/branch lifecycle (Merge / PR / Dismiss) is the
   * SESSION's job, so cancel deliberately does NOT call assertNotSessionHosted and
   * is safe for a session-hosted run (the shared session worktree survives).
   *
   * Returns:
   *   { success: true }                — the run was stopped + marked 'canceled'.
   *   { noOp: true; reason }           — 'not_found' / 'already_terminal'
   *                                      (idempotent double-cancel) / 'race'
   *                                      (a concurrent terminal transition won).
   *
   * Standalone-typecheck invariant: collaborators (db, runQueues, stopLiveRun,
   * clearPendingApprovalsForRun, clearPendingQuestionsForRun, emitRunStatusChanged)
   * are injected via setCancelRunDeps(). Until wired the mutation throws
   * METHOD_NOT_SUPPORTED.
   */
  cancel: protectedProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .mutation(async ({ input }): Promise<CancelRunResult> => {
      if (!cancelRunDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'cancel-run deps not wired yet. Call setCancelRunDeps() at boot.',
        });
      }
      return cancelRunHandler(input.runId, cancelRunDeps);
    }),

  /**
   * End a RESTED workflow run as 'completed' — the backend half of the
   * "End workflow" gate for SESSION-HOSTED runs (whose Merge/PR/Dismiss live on
   * the SESSION and are blocked by assertNotSessionHosted on the run-scoped
   * close-outs). A run that finishes its work rests at 'awaiting_review' and
   * previously had NO exit short of Cancel: this marks it terminal so the
   * centre pane can return to the session's resting canvas and another
   * workflow (e.g. a Sprint after a Planner) can start on the SAME session.
   *
   * Git-neutral by design: no merge, no worktree removal, no branch delete, no
   * outcome stamp — the session still owns the worktree lifecycle, and task
   * stages are left wherever the run's gates put them (a Planner's tasks stay
   * Ready-for-development; nothing reverts).
   *
   * Guards:
   *   - only an 'awaiting_review' run can be ended (a running/paused run must
   *     be cancelled or allowed to drain);
   *   - a run with pending BLOCKING review items cannot be ended — resolve the
   *     gates first (mirrors aggregate-unblock; prevents silently bypassing an
   *     open human gate).
   *
   * Returns { ended: true } or { noOp: true, reason } — 'not_found' /
   * 'already_terminal' (idempotent) / 'not_rested' / 'blocking_items_pending'.
   */
  end: protectedProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .mutation(async ({ ctx, input }): Promise<
      | { ended: true }
      | { noOp: true; reason: 'not_found' | 'already_terminal' | 'not_rested' | 'blocking_items_pending' }
    > => {
      if (!ctx.db) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'db not wired into tRPC context' });
      }
      const db = ctx.db;
      const run = db
        .prepare('SELECT status, batch_id AS batchId FROM workflow_runs WHERE id = ?')
        .get(input.runId) as { status?: string; batchId?: string | null } | undefined;
      if (!run?.status) return { noOp: true, reason: 'not_found' };
      if (['completed', 'failed', 'canceled'].includes(run.status)) {
        return { noOp: true, reason: 'already_terminal' };
      }
      if (run.status !== 'awaiting_review') return { noOp: true, reason: 'not_rested' };
      if (countPendingBlockingReviewItems(db, input.runId) > 0) {
        return { noOp: true, reason: 'blocking_items_pending' };
      }

      const info = db
        .prepare(
          `UPDATE workflow_runs
              SET status = 'completed', ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'awaiting_review'`,
        )
        .run(input.runId) as { changes: number };
      if (info.changes === 0) return { noOp: true, reason: 'already_terminal' }; // concurrent transition won

      // Defensive settles — nothing blocking was pending (guard above), but a
      // stray non-gating socket must not strand once the run is terminal.
      try {
        ApprovalRouter.getInstance().clearPendingForRun(input.runId);
        QuestionRouter.getInstance().clearPendingForRun(input.runId);
      } catch {
        // Routers not initialized (tests) — nothing to clear.
      }
      // Sprint batch close-out: a batch-bearing run going terminal must flip its
      // sprint_batches row terminal too (mirrors cancel's markBatchTerminal).
      if (run.batchId) {
        try {
          SprintLaneStore.getInstance().markBatchTerminal(run.batchId, 'completed');
        } catch {
          // Store not initialized (tests) — lane substrate absent.
        }
      }
      runStatusEvents.emit('changed', { runId: input.runId, status: 'completed' });
      return { ended: true };
    }),

  /**
   * SDK-only Pause of a running workflow run (session<->run restructure, Phase 4b).
   *
   * Stops the active SDK turn (via the SubstrateDispatchFacade kill seam injected
   * as pauseRunDeps.stopLiveRun) and parks the run in the NON-terminal `paused`
   * status, PRESERVING claude_session_id + current_step_id so Resume can re-drive
   * the SAME conversation. Like Cancel it is git-neutral (no worktree removal /
   * merge / branch delete) and safe for a session-hosted run, so it deliberately
   * does NOT call assertNotSessionHosted.
   *
   * SDK-ONLY: the interactive substrate is fresh-session-only (no native --resume),
   * so the handler refuses a non-sdk run with { noOp: 'interactive_unsupported' }
   * and the UI disables Pause for interactive runs.
   *
   * Returns:
   *   { success: true }      — the run was paused.
   *   { noOp: true; reason } — 'not_found' / 'interactive_unsupported' /
   *                            'not_pausable' (not running|awaiting_review) /
   *                            'no_session' (no captured claude_session_id) /
   *                            'race' (a concurrent transition won).
   *
   * Standalone-typecheck invariant: collaborators are injected via
   * setPauseRunDeps(). Until wired the mutation throws METHOD_NOT_SUPPORTED.
   */
  pause: protectedProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .mutation(async ({ input }): Promise<PauseRunResult> => {
      if (!pauseRunDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'pause-run deps not wired yet. Call setPauseRunDeps() at boot.',
        });
      }
      return pauseRunHandler(input.runId, pauseRunDeps);
    }),

  /**
   * SDK-only Resume of a paused workflow run (session<->run restructure, Phase 4b).
   *
   * Flips the run paused -> running and re-drives execute(runId) with the executor
   * in resume mode: it threads the PRESERVED claude_session_id as the SDK resume id
   * (so the SAME conversation continues) and sends a minimal CONTINUE prompt (the
   * base workflow prompt is already in the resumed SDK history).
   *
   * SDK-ONLY: the interactive substrate has no native --resume, so the handler
   * refuses a non-sdk run with { noOp: 'interactive_unsupported' }.
   *
   * Returns:
   *   { delivered: true }    — the run was flipped to running and re-driven.
   *   { noOp: true; reason } — 'not_found' / 'interactive_unsupported' /
   *                            'not_paused' / 'no_session' / 'race' /
   *                            'execute_failed'.
   *
   * Standalone-typecheck invariant: collaborators are injected via
   * setResumeRunDeps(). Until wired the mutation throws METHOD_NOT_SUPPORTED.
   */
  resume: protectedProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .mutation(async ({ input }): Promise<ResumeRunResult> => {
      if (!resumeRunDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'resume-run deps not wired yet. Call setResumeRunDeps() at boot.',
        });
      }
      return resumeRunHandler(input.runId, resumeRunDeps);
    }),

  /**
   * Get a single workflow run by ID (session<->run restructure, Phase 4a).
   *
   * Reads the full workflow_runs row directly from ctx.db (matching the dominant
   * convention in this router — the WorkflowRegistry surface in the tRPC context
   * does not expose getRunById). Throws NOT_FOUND when the run does not exist.
   */
  get: protectedProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .query(({ ctx, input }): WorkflowRunRow => {
      if (!ctx.db) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'db not wired into tRPC context',
        });
      }
      const row = ctx.db
        .prepare(
          `SELECT id, workflow_id, project_id, worktree_path, status, policy_json,
                  stuck_at, stuck_reason, created_at, updated_at, started_at, ended_at
             FROM workflow_runs WHERE id = ?`,
        )
        .get(input.runId) as WorkflowRunRow | undefined;
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Run ${input.runId} not found` });
      }
      return row;
    }),

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
   * Nudge an idle workflow run (Piece C — idle-chat nudge / conversation resume).
   *
   * When a run has drained to `awaiting_review`, its SDK iterator is dead. A
   * nudge re-spawns the run with `--resume <claude_session_id>` so the agent
   * continues the SAME conversation as a follow-up turn (not a fresh re-run).
   *
   * Returns:
   *   { delivered: true }            — the run was re-driven with the nudge text.
   *   { noOp: true; reason }         — the nudge was rejected without re-driving:
   *     'empty' (blank text) / 'not_found' / 'terminal' / 'not_idle'
   *     (not awaiting_review) / 'blocked' (pending blocking review items) /
   *     'no_session' (no captured claude_session_id) / 'race' (concurrent
   *     transition won the flip) / 'execute_failed'.
   *
   * Standalone-typecheck invariant: collaborators (db, runQueues, runExecutor)
   * are injected via setNudgeRunDeps(). Until wired the mutation throws
   * METHOD_NOT_SUPPORTED.
   */
  nudge: protectedProcedure
    .input(z.object({ runId: z.string().min(1), text: z.string() }))
    .mutation(async ({ input }): Promise<NudgeRunResult> => {
      if (!nudgeRunDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'nudge dependencies not wired yet. Call setNudgeRunDeps() at boot.',
        });
      }
      return nudgeRunHandler(input.runId, input.text, nudgeRunDeps);
    }),

  /**
   * Reopen a FAILED workflow run (session reopen-on-timeout follow-up).
   *
   * Revives a terminal 'failed' run: flips it back to running (clearing the
   * failure stamp) and re-drives the SAME SDK conversation via --resume with the
   * user's text as a follow-up turn. The escape hatch for a run that errored /
   * timed out while a gate was open and is still resumable.
   *
   * Returns:
   *   { delivered: true }    — the run was revived + re-driven with the text.
   *   { noOp: true; reason } — rejected: 'empty' / 'not_found' /
   *     'interactive_unsupported' (PTY has no --resume) / 'not_failed' /
   *     'no_session' (no captured claude_session_id) / 'race' / 'execute_failed'.
   *
   * Standalone-typecheck invariant: collaborators are injected via
   * setReopenRunDeps(). Until wired the mutation throws METHOD_NOT_SUPPORTED.
   */
  reopen: protectedProcedure
    .input(z.object({ runId: z.string().min(1), text: z.string() }))
    .mutation(async ({ input }): Promise<ReopenRunResult> => {
      if (!reopenRunDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'reopen dependencies not wired yet. Call setReopenRunDeps() at boot.',
        });
      }
      return reopenRunHandler(input.runId, input.text, reopenRunDeps);
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
   * Lazily spawn (idempotent) the run's plain worktree shell — the backend for
   * the run "Shell" tab. This is the USER's shell ($SHELL in the run's worktree)
   * for running commands (e.g. a dev server) against the code a flow built — NOT
   * the agent PTY (relayInput/getPtyBacklog). Returns { ok:false,
   * reason:'no_worktree' } when the run has no worktree yet. Throws
   * METHOD_NOT_SUPPORTED until setRunShellDeps() is wired.
   */
  shellOpen: protectedProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .mutation(({ input }): { ok: boolean; reason?: string } => {
      if (!runShellDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'run shell dependencies not wired yet. Call setRunShellDeps() at boot.',
        });
      }
      return runShellDeps.open(input.runId);
    }),

  /** Write keystrokes verbatim into the run's worktree shell. */
  shellInput: protectedProcedure
    .input(z.object({ runId: z.string().min(1), text: z.string() }))
    .mutation(({ input }): { success: true } => {
      if (!runShellDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'run shell dependencies not wired yet. Call setRunShellDeps() at boot.',
        });
      }
      runShellDeps.write(input.runId, input.text);
      return { success: true };
    }),

  /** Relay a PTY geometry change into the run's worktree shell. */
  shellResize: protectedProcedure
    .input(z.object({
      runId: z.string().min(1),
      cols: z.number().int().positive(),
      rows: z.number().int().positive(),
    }))
    .mutation(({ input }): { success: true } => {
      if (!runShellDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'run shell dependencies not wired yet. Call setRunShellDeps() at boot.',
        });
      }
      runShellDeps.resize(input.runId, input.cols, input.rows);
      return { success: true };
    }),

  /**
   * The retained scrollback tail for the run's worktree shell. The Shell tab
   * fetches this once on mount and replays it into the xterm so a (re)mounting
   * terminal reconstructs recent output instead of rendering blank (mirrors
   * getPtyBacklog for the agent PTY). '' for an unknown run.
   */
  shellBacklog: protectedProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .query(({ input }): { backlog: string } => {
      if (!runShellDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'run shell dependencies not wired yet. Call setRunShellDeps() at boot.',
        });
      }
      return { backlog: runShellDeps.getBacklog(input.runId) };
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
      const { worktreePath, branchName, projectPath, sessionId } = resolveRunForCloseout(ctx.db, input.runId);
      // Close-out safety guard (Phase 1): a session-hosted run must NEVER merge or
      // remove the shared session worktree — that is the session's job (Phase 3).
      assertNotSessionHosted(input.runId, sessionId);
      // deps is guaranteed non-null after resolveRunForCloseout (it throws otherwise).
      const wm = deps!.worktreeManager;

      // Terminate the live interactive REPL (IDEA-030 / TASK-818) BEFORE the
      // worktree mutation so its spawn promise resolves as part of close-out.
      // NO-OP for the SDK substrate and when the relay bag is unwired.
      await endLiveInteractiveSession(input.runId);

      const mainBranch = await wm.getProjectMainBranch(projectPath);
      // Commit-less runs (e.g. Planner) persist their output to the DB via MCP
      // and make ZERO git commits, so there is genuinely nothing to merge. Treat
      // WorktreeManager's specific "no commits" error as a BENIGN SUCCESS and fall
      // through to the normal close-out (worktree removal + mark completed +
      // outcome='merged') so the run still leaves the rail cleanly. Any OTHER
      // merge failure (rebase conflict, non-ff divergence, …) re-throws — a Sprint
      // run with real commits MUST still merge normally and surface real errors.
      try {
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
      } catch (err) {
        // A missing commit message is a real BAD_REQUEST — never swallow it.
        if (err instanceof TRPCError) throw err;
        if (!isNoCommitsToMergeError(err)) throw err;
        // benign: nothing to merge (output already in DB) → continue close-out.
      }

      // Tear down the run's user shell (and any dev server it launched) BEFORE
      // removing the worktree dir, so no shell process holds it open.
      closeRunShell(input.runId);
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
      // Dispose the run's on-demand monitor (inject plumbing + registry entry): it
      // outlived the walk so the user could chat with it at rest, and close-out
      // (worktree removed above) is where it finally goes away. No-op without a monitor.
      deps!.disposeMonitorResources(input.runId);
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
      const { worktreePath, projectPath, sessionId } = resolveRunForCloseout(ctx.db, input.runId);
      // Close-out safety guard (Phase 1): a session-hosted run must NEVER push or
      // remove the shared session worktree — that is the session's job (Phase 3).
      assertNotSessionHosted(input.runId, sessionId);
      // deps is guaranteed non-null after resolveRunForCloseout (it throws otherwise).
      const wm = deps!.worktreeManager;

      // Terminate the live interactive REPL (IDEA-030 / TASK-818) BEFORE pushing
      // so its spawn promise resolves as part of close-out. NO-OP for SDK /
      // unwired relay bag.
      await endLiveInteractiveSession(input.runId);

      await wm.gitPush(worktreePath);
      const { remoteUrl, branchName } = await wm.getRemoteUrlAndBranch(worktreePath);

      // Artifact delivered to origin — close the run out. Tear down the run's
      // user shell BEFORE removing the worktree so no shell process holds it open.
      closeRunShell(input.runId);
      // Remove the local worktree (the branch now lives on origin) and mark the
      // run completed. The local branch is intentionally NOT deleted here: it
      // tracks the pushed origin branch the user is about to open a PR from.
      await wm.removeWorktreeByPath(projectPath, worktreePath);
      // Drop any pending approvals for the run so close-out doesn't leave
      // orphaned items in the review queue.
      deps!.clearPendingApprovalsForRun(input.runId);
      // Dispose the run's on-demand monitor (inject plumbing + registry entry): it
      // outlived the walk so the user could chat with it at rest, and close-out
      // (worktree removed above) is where it finally goes away. No-op without a monitor.
      deps!.disposeMonitorResources(input.runId);
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
      const { worktreePath, branchName, projectPath, sessionId } = resolveRunForCloseout(ctx.db, input.runId);
      // Close-out safety guard (Phase 1): a session-hosted dismiss must NOT remove
      // the shared session worktree or delete its branch — abandon the run via the
      // session (Phase 3). Throw before any git/kill work.
      assertNotSessionHosted(input.runId, sessionId);
      // HARD-kill the live interactive REPL (IDEA-030) BEFORE removing the
      // worktree. Dismiss can target a RUNNING flow whose claude is busy and never
      // reads a graceful EOF/`/exit`, so endSession would leave the process alive
      // (orphaned in the Claude app) and holding the worktree open during removal.
      // killSession routes to killProcess (teardown + process-tree kill); the
      // spawn-promise settle on kill is the designed RunExecutor close path. NO-OP
      // for the SDK substrate and when the relay bag is unwired.
      await killLiveInteractiveSession(input.runId);
      // Tear down the run's user shell (and any dev server it launched) BEFORE
      // removing the worktree dir, so no shell process holds it open.
      closeRunShell(input.runId);
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
      // Dispose the run's on-demand monitor (inject plumbing + registry entry): it
      // outlived the walk so the user could chat with it at rest, and close-out
      // (worktree removed above) is where it finally goes away. No-op without a monitor.
      deps!.disposeMonitorResources(input.runId);
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

  // @cyboflow-hidden: the run-keyed File Explorer routes (listFiles / readFile)
  // are superseded by the session-keyed cyboflow.files.* routes in cyboflow v1.
  // PRESERVED for the Phase-5 legacy parentless-run fallback (a pre-upgrade run
  // with its own worktree and no sessions row). Behavior is unchanged.
  // Re-enable by adding a runId-keyed File Explorer surface again — the live
  // component is now session-keyed (SessionFileExplorer.tsx); prefer
  // cyboflow.files.list/read keyed by the selected session.

  /**
   * List one directory level of a run's git worktree for the File Explorer rail.
   * `path` is relative to the worktree root (omit for the root). Directories
   * sort first, then files; the `.git` directory is excluded. Read-only.
   *
   * Throws:
   *   PRECONDITION_FAILED — ctx.db missing, or the run has no worktree yet /
   *                         the worktree no longer exists on disk.
   *   NOT_FOUND           — unknown runId, or the target directory is missing.
   *   BAD_REQUEST         — path escapes the worktree or is not a directory.
   */
  listFiles: protectedProcedure
    .input(z.object({ runId: z.string().min(1), path: z.string().optional() }))
    .query(async ({ ctx, input }): Promise<RunFileEntry[]> => {
      if (!ctx.db) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'db not wired into tRPC context',
        });
      }
      const db = ctx.db;
      return withRunFileErrorMapping(() => listRunFiles(db, input.runId, input.path));
    }),

  /**
   * Read a single file from a run's git worktree as UTF-8 text for the File
   * Explorer viewer. Binary or oversized files return `content: null` with an
   * `unviewableReason` instead of throwing. Read-only.
   *
   * @cyboflow-hidden: superseded by cyboflow.files.read (session-keyed) in v1;
   * PRESERVED for the Phase-5 legacy parentless-run fallback. Behavior unchanged.
   *
   * Throws:
   *   PRECONDITION_FAILED — ctx.db missing, or the run has no worktree yet /
   *                         the worktree no longer exists on disk.
   *   NOT_FOUND           — unknown runId, or the file is missing.
   *   BAD_REQUEST         — path escapes the worktree or is a directory.
   */
  readFile: protectedProcedure
    .input(z.object({ runId: z.string().min(1), path: z.string().min(1) }))
    .query(async ({ ctx, input }): Promise<RunFileContent> => {
      if (!ctx.db) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'db not wired into tRPC context',
        });
      }
      const db = ctx.db;
      return withRunFileErrorMapping(() => readRunFile(db, input.runId, input.path));
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
      // the built-in fallback for a CyboflowWorkflowName, else null.
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

  /**
   * Read the per-task lanes of a sprint run (feat/parallel-sprint, single-run
   * lane model). Resolves the run's batch_id from workflow_runs; a run with no
   * batch (non-sprint, or a sprint launched without seed tasks) returns [].
   * Lane rows come from SprintLaneStore.listLanes via the injected dep-bag.
   *
   * Standalone-typecheck invariant: the SprintLaneStore slice is injected via
   * setSprintLaneDeps(); until wired the query throws METHOD_NOT_SUPPORTED.
   */
  sprintLanes: protectedProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .query(({ ctx, input }): SprintLaneRow[] => {
      if (!ctx.db) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'db not wired into tRPC context',
        });
      }
      if (!sprintLaneDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'sprint-lane dependencies not wired yet. Call setSprintLaneDeps() at boot.',
        });
      }
      const row = ctx.db
        .prepare('SELECT batch_id FROM workflow_runs WHERE id = ?')
        .get(input.runId) as { batch_id: string | null } | undefined;
      if (!row || !row.batch_id) return [];
      return sprintLaneDeps.listLanes(row.batch_id);
    }),

  /**
   * Subscribe to lane-change events for a specific sprint run (feat/parallel-
   * sprint, single-run lane model). Modeled on onStepTransition above. Events
   * are emitted by SprintLaneStore on the per-run `sprint-lane-<runId>` channel
   * after every lane write, so the channel name itself scopes delivery — no
   * additional runId filtering is required.
   *
   * No throttle — lane transitions are infrequent boundary events (unlike
   * high-throughput stream output) and must not be coalesced.
   */
  onSprintLaneChanged: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .subscription(async function* ({ input, signal }): AsyncGenerator<SprintLaneChangedEvent> {
      const abortSignal = signal ?? new AbortController().signal;
      const source = eventToAsyncIterable<SprintLaneChangedEvent>(
        sprintLaneEvents,
        sprintLaneChannel(input.runId),
        abortSignal,
      );
      for await (const ev of source) {
        if (ev.runId !== input.runId) continue;
        yield ev;
      }
    }),
});
