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
import { resolveRunFrozenSpec } from '../../runFrozenSpec';
import { getStuckInspectionHandler } from '../../inspectorQueries';
import { listRunsHandler } from '../../runQueries';
import { selectRunMessages } from '../../runMessagesListing';
import { selectRunUnifiedMessages } from '../../runUnifiedMessagesListing';
import { selectRunRawStreamEvents } from '../../runRawEventsListing';
import { selectRunContextUsage, type RunContextUsage } from '../../runContextUsageListing';
import { listRunFiles, readRunFile } from '../../runFileExplorer';
import { withRunFileErrorMapping } from '../runFileErrors';
import type { RunFileEntry, RunFileContent, RunGitDiff } from '../../../../../shared/types/runFiles';
import type { StreamEnvelope } from '../../../../../shared/types/claudeStream';
import type { CliSubstrate } from '../../../../../shared/types/substrate';
import type { ExecutionModel } from '../../../../../shared/types/executionModel';
import type { ExperimentArm } from '../../../../../shared/types/experiments';
import type { SprintLaneRow, SprintLaneChangedEvent } from '../../../../../shared/types/sprintBatch';
import { SPRINT_BATCH_MAX_TASKS } from '../../../../../shared/types/sprintBatch';
import { sprintLaneEvents, sprintLaneChannel, SprintLaneStore } from '../../sprintLaneStore';
import { countPendingBlockingReviewItems } from '../../reviewItemListing';
import { ReviewItemRouter } from '../../reviewItemRouter';
import { StepResultStore } from '../../stepResultStore';
import { ApprovalRouter } from '../../approvalRouter';
import { QuestionRouter } from '../../questionRouter';
import { TaskChangeRouter } from '../../taskChangeRouter';
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
  answerRecoveryGateHandler,
  type AnswerRecoveryGateResult,
} from '../../answerRecoveryGateHandler';
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
import {
  retryRunHandler,
  type RetryRunDeps,
  type RetryRunResult,
} from '../../retryRunHandler';
import { stepTransitionEvents, eventToAsyncIterable, runStatusEvents } from './events';
import {
  updateSessionAgentPermissionMode,
  type SessionAgentPermissionModeDeps,
} from '../../sessionPermissionMode';

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
// queueInput dependency bag ("always allow messaging a running flow")
//
// Backs the runs.queueInput mutation: a chat message typed while an SDK flow run
// is EXECUTING is buffered on the (shared) RunExecutor and DELIVERED as the next
// turn at the drained REST seam. Injected at boot by main/src/index.ts via
// setQueueInputDeps(), reusing the SAME RunExecutor instance nudge/resume/reopen
// use (so the executor's queuedInput buffer is the one its drain seam reads).
// Until wired the mutation throws METHOD_NOT_SUPPORTED — same stub pattern as the
// other dep-bags.
// ---------------------------------------------------------------------------

/** Narrow slice of RunExecutor the queueInput mutation drives. */
export interface QueueInputRunExecutorLike {
  queueInput(runId: string, text: string): void;
  /** Remove one queued message by text (click-to-reopen — no double delivery). */
  dequeueInput(runId: string, text: string): boolean;
}

export interface QueueInputDeps {
  runExecutor: QueueInputRunExecutorLike;
}

let queueInputDeps: QueueInputDeps | null = null;

/**
 * Wire up the real collaborators for the queueInput mutation.
 *
 * Called once at boot by main/src/index.ts with the SAME RunExecutor instance the
 * nudge / resume / reopen bags use. Until this is called the mutation throws
 * METHOD_NOT_SUPPORTED.
 */
export function setQueueInputDeps(deps: QueueInputDeps): void {
  queueInputDeps = deps;
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
// retryStep dependency bag (retry-from-failed-step)
//
// Injected at boot by main/src/index.ts via setRetryRunDeps(), reusing the
// SAME RunExecutor/RunQueueRegistry instance nudge/resume/reopen use. Until
// wired the mutation throws METHOD_NOT_SUPPORTED — same pattern as the other
// dep-bags.
// ---------------------------------------------------------------------------

let retryRunDeps: RetryRunDeps | null = null;

/**
 * Wire up the real collaborators for the `retryStep` mutation.
 *
 * Called once at boot by main/src/index.ts after the DB, RunQueueRegistry,
 * RunExecutor, StepResultStore, and SprintLaneStore have been initialized.
 * Until this is called the mutation throws METHOD_NOT_SUPPORTED.
 */
export function setRetryRunDeps(deps: RetryRunDeps): void {
  retryRunDeps = deps;
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
   * `requestedExecutionModel` carries the user's per-run execution-model choice
   * (orchestrated vs programmatic) down to the resolver's highest-precedence rung
   * in WorkflowRegistry.createRun (DORMANT until a picker surfaces it);
   * `findingIds` (findings-triage redesign / migration 034) seeds the selected
   * findings of a `compound` run — only valid when the workflow's name ===
   * 'compound', written DIRECTLY to workflow_runs.seed_finding_ids. All are
   * OPTIONAL — when substrate is omitted the run falls through the resolver
   * ladder to DEFAULT_SUBSTRATE ('sdk'); when taskId / ideaId are omitted no link
   * is recorded; when sessionId is omitted the run creates its own dedicated
   * worktree (legacy path); when requestedPermissionMode is omitted the
   * permission ladder falls through to frontmatter → global default → 'default';
   * when projectId is omitted createRun falls back to workflow.project_id (a
   * GLOBAL workflow launched without it throws); when findingIds is omitted the
   * run is not finding-seeded. `requestedModel` (migration 037) carries the user's
   * per-run model choice (Configure surface) — a user-facing alias stamped onto
   * workflow_runs.model and resolved to a concrete snapshot at the spawn seam; when
   * omitted the run pins no model and falls through to the SDK default.
   */
  launch(workflowId: string, projectPath: string, substrate?: CliSubstrate, taskId?: string, ideaId?: string, sessionId?: string, requestedPermissionMode?: PermissionMode, baseBranch?: string, seedTaskIds?: string[], projectId?: number, requestedExecutionModel?: ExecutionModel, findingIds?: string[], requestedModel?: string, requestedEvalEnabled?: boolean, launchOptions?: { requestedVariantId?: string; experiment?: { experimentId: string; arm: ExperimentArm }; baseline?: boolean }): Promise<{
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
// setPermissionMode dependency bag (permission-mode redesign §3d / Slice 5)
//
// cyboflow.runs.setPermissionMode is re-routed through the SHARED session-mode
// write chokepoint (updateSessionAgentPermissionMode): the mode lives on
// sessions.agent_permission_mode (the execution SoT), NOT on
// workflow_runs.permission_mode_snapshot (demoted to a launch-time audit value).
// The chokepoint's collaborators (DatabaseService / SessionManager) are
// services, so they are injected at boot by
// main/src/index.ts via setSetPermissionModeDeps() — the SAME deps object the
// RunLauncher receives. Until wired the mutation throws METHOD_NOT_SUPPORTED.
// ---------------------------------------------------------------------------

let setPermissionModeDeps: SessionAgentPermissionModeDeps | null = null;

/**
 * Wire up the shared session-mode write chokepoint deps for the setPermissionMode
 * mutation. Called once at boot by main/src/index.ts. Until this is called the
 * mutation throws METHOD_NOT_SUPPORTED.
 */
export function setSetPermissionModeDeps(deps: SessionAgentPermissionModeDeps): void {
  setPermissionModeDeps = deps;
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
  /** Lazily spawn a worktree terminal for a run (idempotent). `terminalId`
   *  defaults to `runId` (the run's primary terminal); pass a distinct id for
   *  additional terminals. `ok:false` + `reason:'no_worktree'` when the run has
   *  no worktree to anchor it in. */
  open(runId: string, terminalId: string): { ok: boolean; reason?: string };
  /** Write user keystrokes verbatim into a terminal. */
  write(terminalId: string, data: string): void;
  /** Relay an xterm geometry change into a terminal. */
  resize(terminalId: string, cols: number, rows: number): void;
  /** The retained scrollback tail, replayed into a (re)mounting xterm. */
  getBacklog(terminalId: string): string;
  /** Terminate + forget a SINGLE terminal (UI close of an added terminal tab). */
  closeOne(terminalId: string): void;
  /** Terminate + forget EVERY terminal for a run (close-out, before worktree
   *  removal). */
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
      // REQUIRED session host (session<->run restructure / migration 019;
      // permission-mode redesign slice 1a). The run executes inside this session's
      // existing worktree, and createRun stamps workflow_runs.session_id from it so
      // every run is session-owned (the never-session-less invariant; the createRun
      // throw + signature tighten land in slice 1b). All frontend launch surfaces
      // thread a session via ensureSessionForLaunch, so requiring it here is safe.
      sessionId: z.string().min(1),
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
      // Optional compound seed findings (findings-triage redesign / migration 034).
      // When supplied, the launcher writes workflow_runs.seed_finding_ids (a JSON
      // string array) directly; RunExecutor.getPrompt injects the selected findings
      // as a `## Selected findings` block, and the terminal-seam close-out clears
      // `selected` on any un-resolved seeded finding. Only valid for the 'compound'
      // workflow (the launcher enforces this). Mirrors taskIds/ideaId; NO selection
      // cap (OD-7) — a triage tray may seed any number of findings.
      findingIds: z.array(z.string().min(1)).optional(),
      // Optional per-run model pin (migration 037). A USER-FACING alias from the
      // Configure surface ('opus' | 'opus-250k' | 'sonnet' | 'haiku' | 'auto'),
      // forwarded to RunLauncher.launch → WorkflowRegistry.createRun which stamps
      // workflow_runs.model. Validated only as a non-empty string here — the alias
      // set is owned by the spawn-seam resolver (modelContext.resolveModelAlias),
      // which passes any unrecognized value through unchanged (and 'auto'/unknown
      // resolve to the SDK default), so an over-strict enum here would be a
      // drift-prone second source of truth. When omitted the run pins no model.
      model: z.string().min(1).optional(),
      // Optional per-run code-review-eval override (migration 044). true = force
      // the eval ON for this run, false = force it OFF, omitted = no per-run pin →
      // inherit the global codeReviewEvalEnabled toggle at the trigger seam. Set
      // from the launch Configure surface's Advanced "Quality eval" tri-state (flow
      // launches only — meaningless for quick sessions). Forwarded to
      // RunLauncher.launch → WorkflowRegistry.createRun, which stamps
      // workflow_runs.eval_enabled. A per-run ON does NOT unlock quick/custom flows
      // (the trigger's built-ins-only isCyboflowWorkflowName gate is unchanged).
      evalEnabled: z.boolean().optional(),
      // Optional per-run execution-model override — the HIGHEST-precedence rung of
      // resolveExecutionModel (above frontmatter / project config / the global
      // defaultExecutionModel / env). 'programmatic' hands the run's DAG walk to the
      // in-process host loop (WorkflowController); omitted = no per-run choice → the
      // resolver ladder decides (floor 'orchestrated'). Set from the launch wizard's
      // Advanced "Orchestration" tri-state. Safe on any substrate: the resolver
      // hard-pins 'orchestrated' for interactive-PTY runs regardless of this value.
      executionModel: z.enum(['orchestrated', 'programmatic']).optional(),
      // Optional explicit A/B variant pin (migration 046). When supplied it is
      // threaded to RunLauncher.launch as an EXPLICIT variant pin (loaded
      // regardless of status); when omitted the launcher's VariantResolver applies
      // weighted rotation over the workflow's active variants (or resolves null →
      // baseline live-spec run, byte-identical to before).
      variantId: z.string().min(1).optional(),
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
        // Q1 eligibility pre-check (fail fast before the launch machinery). A
        // sprint may only seed APPROVED tasks at a ready-or-later, non-terminal
        // stage. STRICT for this user-facing path: a MIXED selection (some
        // eligible, some not) is rejected too — createForRun silently DROPS
        // ineligible ids, and launching a sprint that executes only part of an
        // explicit selection with no notice is worse than asking the user to
        // fix the selection. (The agent path — cyboflow_create_sprint_batch —
        // keeps the permissive drop-with-log behaviour in createForRun.)
        // SprintLaneStore.filterEligibleTaskIds is the same guard createForRun
        // uses (it degrades to permissive on a pre-042 schema). Guarded so an
        // uninitialized store (tests) simply skips the pre-check — createForRun
        // remains the authoritative gate.
        let eligibleIds: string[] | null = null;
        try {
          eligibleIds = SprintLaneStore.getInstance().filterEligibleTaskIds(
            input.projectId,
            input.taskIds,
          );
        } catch {
          eligibleIds = null;
        }
        if (eligibleIds !== null) {
          if (eligibleIds.length === 0) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message:
                'no sprint-eligible tasks in selection (each must be approved + at "Ready for development" or later, not archived/done)',
            });
          }
          const uniqueSelection = [...new Set(input.taskIds)];
          if (eligibleIds.length < uniqueSelection.length) {
            const eligibleSet = new Set(eligibleIds);
            const ineligible = uniqueSelection.filter((id) => !eligibleSet.has(id));
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `selection includes ${ineligible.length} sprint-ineligible task(s): ${ineligible.join(', ')} — each must be approved + at "Ready for development" or later, not archived/done/won't-do. Remove them or fix their state, then relaunch.`,
            });
          }
        }
      }
      // Forward the per-run substrate choice (IDEA-013), native-task link
      // (migration 014), planner seed idea (migration 017), session host
      // (Phase 1 / migration 019), per-run agent permission override
      // (WorkflowPicker), and sprint seed tasks (feat/parallel-sprint), PLUS the
      // explicit launch projectId (migration 030 — global workflows) and the
      // compound seed findings (findings-triage / migration 034). The projectId
      // MUST always be threaded now: a GLOBAL built-in / custom flow carries
      // workflow.project_id = NULL, so createRun has no fallback project and would
      // throw without it. (The earlier "legacy 2-arg shape when all optionals are
      // omitted" fast path is gone — it could not supply a project for a global
      // flow.) Any optional arg may still be undefined, which the launcher treats
      // as "no link / no host / resolver default". baseBranch is never sent over
      // this IPC path — an undefined placeholder. requestedExecutionModel carries
      // the wizard's per-run Orchestration override (undefined = inherit the
      // resolver ladder); findingIds, requestedModel, then requestedEvalEnabled
      // (migration 044) are the LAST positional args, AFTER requestedExecutionModel.
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
        input.executionModel,
        input.findingIds,
        input.model,
        input.evalEnabled,
        // A/B testing (migration 046): the trailing launchOptions object. Only an
        // explicit variant pin is threaded over this IPC path; rotation (no pin)
        // and experiment stamps are resolved/supplied elsewhere.
        input.variantId !== undefined ? { requestedVariantId: input.variantId } : undefined,
      );
      return { runId, worktreePath, branchName };
    }),

  /**
   * Restart a FAILED workflow run (end-of-workflow failure UX).
   *
   * Relaunches the SAME workflow in the SAME session/worktree as the failed run,
   * creating a NEW run row through the SAME RunLauncher.launch chokepoint runs.start
   * uses (so substrate/model/permission all re-resolve through their seams and no
   * entity table is written directly). The flows are DB-canonical (the entity model),
   * so the fresh run picks progress up where the failed run left off. The failed run
   * stays terminal ('failed') — this never mutates it.
   *
   * Provenance is COPIED off the failed row so the caller does not re-thread it:
   * workflow_id, substrate, model pin, permission_mode_snapshot, and the seed params
   * (task_id / seed_idea_id / seed_finding_ids, plus the sprint batch's task ids read
   * back from sprint_batch_tasks). NO lineage column is added — no consumer needs a
   * restarted_from link, so a schema change would be dead weight.
   *
   * Contrast runs.reopen, which REVIVES the same row via --resume and REQUIRES a
   * captured claude_session_id; restart instead starts a clean run that re-reads DB
   * state, so it works even for a run that died before capturing a session.
   *
   * Reuses the start deps (runLauncher + sessionManager); until wired it throws
   * METHOD_NOT_SUPPORTED. Returns the new run's ids, or a typed no-op.
   */
  restart: protectedProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .mutation(async ({ ctx, input }): Promise<
      | { runId: string; worktreePath: string; branchName: string }
      | { noOp: true; reason: 'not_found' | 'not_failed' | 'no_session' | 'no_project' }
    > => {
      if (!startRunDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'start dependencies not wired yet. Call setStartRunDeps() at boot.',
        });
      }
      if (!ctx.db) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'db not wired into tRPC context' });
      }
      const row = ctx.db
        .prepare(
          `SELECT workflow_id, project_id, status, substrate, session_id,
                  permission_mode_snapshot, model, task_id, seed_idea_id, seed_finding_ids, batch_id,
                  eval_enabled, variant_id, experiment_id
             FROM workflow_runs WHERE id = ?`,
        )
        .get(input.runId) as
        | {
            workflow_id: string;
            project_id: number;
            status: string;
            substrate: CliSubstrate | null;
            session_id: string | null;
            permission_mode_snapshot: PermissionMode | null;
            model: string | null;
            task_id: string | null;
            seed_idea_id: string | null;
            seed_finding_ids: string | null;
            batch_id: string | null;
            eval_enabled: number | null;
            variant_id: string | null;
            experiment_id: string | null;
          }
        | undefined;
      if (!row) return { noOp: true, reason: 'not_found' };
      // Only a terminally-FAILED run may restart — a running / rested / completed run
      // is not a restart candidate (the panel only shows the CTA for 'failed').
      if (row.status !== 'failed') return { noOp: true, reason: 'not_failed' };
      // A/B testing (migration 046): REFUSE restarting an experiment-tagged arm.
      // The arm's run identity is load-bearing for the experiment (its entity writes
      // are sandboxed by experiment_id); a fresh run would silently lose the tag and
      // de-sandbox its writes. The human must decide/abandon the experiment (or
      // reopen the run) instead.
      if (row.experiment_id !== null) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `run ${input.runId} is part of experiment ${row.experiment_id}; restart is disabled for experiment arms — decide or abandon the experiment, or reopen the run instead`,
        });
      }
      // Restart re-hosts in the SAME session's worktree; a legacy session-less run
      // (no session_id) has no worktree to re-enter.
      if (!row.session_id) return { noOp: true, reason: 'no_session' };
      const project = startRunDeps.sessionManager.getProjectById(row.project_id);
      if (!project) return { noOp: true, reason: 'no_project' };

      // Recover the exact seed params the failed run carried so the restart targets
      // the SAME work: compound findings (a JSON string array) and sprint batch task
      // ids (read back from the lane table — the row stores batch_id, not the ids).
      let findingIds: string[] | undefined;
      if (row.seed_finding_ids) {
        try {
          const parsed: unknown = JSON.parse(row.seed_finding_ids);
          if (Array.isArray(parsed)) {
            findingIds = parsed.filter((x): x is string => typeof x === 'string');
          }
        } catch {
          findingIds = undefined;
        }
      }
      let taskIds: string[] | undefined;
      if (row.batch_id) {
        const laneRows = ctx.db
          .prepare('SELECT task_id FROM sprint_batch_tasks WHERE batch_id = ?')
          .all(row.batch_id) as Array<{ task_id: string }>;
        if (laneRows.length > 0) taskIds = laneRows.map((r) => r.task_id);
      }

      // SAME chokepoint runs.start uses. session_id is reused so the new run lands in
      // the failed run's worktree; substrate / permission / model re-resolve through
      // their seams inside createRun. baseBranch + requestedExecutionModel are not
      // threaded over IPC (undefined placeholders), mirroring start.
      const { runId, worktreePath, branchName } = await startRunDeps.runLauncher.launch(
        row.workflow_id,
        project.path,
        row.substrate ?? undefined,
        row.task_id ?? undefined,
        row.seed_idea_id ?? undefined,
        row.session_id,
        row.permission_mode_snapshot ?? undefined,
        undefined,
        taskIds,
        row.project_id,
        undefined,
        findingIds,
        row.model ?? undefined,
        // Copy the failed run's per-run eval pin (1/0 → true/false; NULL → inherit
        // the global setting) so a restart preserves the launch-time choice.
        row.eval_enabled === null ? undefined : row.eval_enabled === 1,
        // A/B testing (migration 046): INHERIT the failed run's variant (no re-roll)
        // so per-variant stats stay coherent. An explicit pin loads regardless of
        // status, so a paused/retired variant still restarts correctly. Baseline
        // runs (variant_id NULL) pin `baseline: true` so the resolver returns null
        // WITHOUT rotating — reproducing the baseline config even if the workflow has
        // since gained active variants (restart inherits, no re-roll).
        row.variant_id !== null ? { requestedVariantId: row.variant_id } : { baseline: true },
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
      // F3 — fail-soft completion reveal. The run ran to COMPLETION; if it was
      // plan-gated but plan_approved_at is still NULL (a user-edited workflow that
      // kept the approve-plan step id but used gate labels isApproveAnswer never
      // matched, or a free-text approval), its draft entities are still PENDING and
      // would be silently lost on a later dismiss. Reveal them now — visible-but-
      // unwanted beats invisible-then-deleted. The entry point self-gates on
      // plan-gated + unapproved and is naturally a no-op when the run's drafts were
      // already swept (cancel/dismiss/fail/reject deleted the rows). Fail-soft +
      // awaited AFTER the terminal UPDATE so a reveal error can never un-complete
      // the run.
      try {
        await QuestionRouter.getInstance().promotePendingDraftsForRun(input.runId);
      } catch {
        // Router not initialized (tests) / reveal already fail-soft — never block end.
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
   * Change the agent permission mode for the session that hosts a workflow run
   * (permission-mode redesign §3d / Slice 5). The mode is a SESSION property —
   * the sole execution authority is sessions.agent_permission_mode (the SDK hook
   * + the interactive PTY both re-read it). workflow_runs.permission_mode_snapshot
   * is demoted to a launch-time audit value and is NO LONGER written here.
   *
   * Re-routed through the SHARED session-mode write chokepoint
   * (updateSessionAgentPermissionMode), so this mutation fires the SAME three
   * side effects as the composer pill (sessions:update-agent-permission-mode)
   * and the launch picker: persist sessions.agent_permission_mode +
   * 'session-updated' emit (the session-store-derived pill refreshes, no
   * respawn) + runtime mutate. A raw UPDATE would skip the pill refresh. (The
   * interactive substrate needs no settings-file re-prime: the PTY gating hook
   * rides the inline `--settings` flag and is recomputed from the persisted
   * mode at every spawn.)
   *
   * NO terminal-status guard for the session write (this is the #4
   * chat-after-terminal-flow case): the owning session is resolved from the run
   * REGARDLESS of run status, so a terminal flow run can still change its
   * session's mode for the next chat turn. noOp:'not_found' is returned ONLY when
   * no session resolves (run absent OR run.session_id NULL) — never 'already_terminal'.
   *
   * Standalone-typecheck invariant holds — the chokepoint + its deps are
   * structurally typed (no electron/better-sqlite3/services import is added). The
   * service-backed deps are injected at boot via setSetPermissionModeDeps().
   *
   * Returns { updated: true } or { noOp: true, reason: 'not_found' }.
   */
  setPermissionMode: protectedProcedure
    .input(z.object({
      runId: z.string().min(1),
      // Keep the enum literal identical to PERMISSION_MODES so it cannot drift
      // (mirrors the `start` mutation). zod validates at the boundary — no runtime
      // isPermissionMode call is needed.
      permissionMode: z.enum(['default', 'acceptEdits', 'auto', 'dontAsk']),
    }))
    .mutation(async ({ ctx, input }): Promise<
      | { updated: true }
      | { noOp: true; reason: 'not_found' }
    > => {
      if (!ctx.db) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'db not wired into tRPC context' });
      }
      if (!setPermissionModeDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'setPermissionMode deps not wired',
        });
      }
      const db = ctx.db;
      // Resolve the owning session from the run REGARDLESS of run status. Mode is
      // a session property, so a terminal flow run must NOT block it. noOp only
      // when no session resolves (run absent OR run.session_id NULL).
      const row = db
        .prepare('SELECT session_id FROM workflow_runs WHERE id = ?')
        .get(input.runId) as { session_id?: string | null } | undefined;
      const sessionId = row?.session_id;
      if (!sessionId) return { noOp: true, reason: 'not_found' };

      // Write through the shared chokepoint (persist + emit + runtime mutate +
      // interactive re-prime). A not_found here means the session row was deleted
      // between resolving it from the run and the persist.
      const result = updateSessionAgentPermissionMode(
        setPermissionModeDeps,
        sessionId,
        input.permissionMode,
      );
      if (!result.ok) return { noOp: true, reason: 'not_found' };
      return { updated: true };
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
   * Capture the working-directory diff of a run's git worktree (run-scoped Diff
   * tab). Flow runs have workflow_runs.session_id = NULL and are keyed by runId,
   * so the session-scoped diff path (sessions:get-combined-diff) cannot serve
   * them — the worktree is resolved here from workflow_runs.worktree_path.
   *
   * Returns the raw unified diff + aggregate stats, or `null` when the run has no
   * worktree_path (e.g. a not-yet-materialized run). An empty `diff` string means
   * the worktree exists but has no working-directory changes.
   *
   * Standalone-typecheck invariant: the diff capture is performed via the
   * injected `ctx.gitDiff` closure (backed by GitDiffManager in index.ts), NOT a
   * direct services/* import. Mirrors `get` for the ctx.db precondition guard and
   * adds a ctx.gitDiff precondition (PRECONDITION_FAILED until wired at boot).
   */
  gitDiff: protectedProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .query(async ({ ctx, input }): Promise<RunGitDiff | null> => {
      if (!ctx.db) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'db not wired into tRPC context',
        });
      }
      if (!ctx.gitDiff) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'gitDiff not wired into tRPC context',
        });
      }
      const row = ctx.db
        .prepare('SELECT worktree_path, base_sha FROM workflow_runs WHERE id = ?')
        .get(input.runId) as { worktree_path: string | null; base_sha: string | null } | undefined;
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Run ${input.runId} not found` });
      }
      if (!row.worktree_path) {
        // No worktree yet (e.g. a not-yet-materialized run) — nothing to diff.
        return null;
      }
      // Diff against the run's base_sha (worktree HEAD at launch) so committed
      // work — sprint/ship runs merge parallel task lanes back to the branch —
      // shows alongside uncommitted/untracked changes. Legacy runs without a
      // base_sha fall back to the working-directory diff.
      return ctx.gitDiff(row.worktree_path, row.base_sha ?? undefined);
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
   * Answer an `ask-user-question-recovery` decision gate: resume the run with the
   * chosen answer as a `--resume` turn AND resolve the blocking review item —
   * but resolve ONLY once the resume is confirmed delivered, so a refused resume
   * never loses the answer (see answerRecoveryGateHandler for the ordering
   * rationale). A plain reviewItems.resolve is NOT enough here: its
   * aggregate-unblock path uses HumanStepManager.maybeResumeRun, which only flips
   * a run's status and cannot re-spawn a DRAINED SDK turn.
   *
   * Returns `{ resolved, nudge }` — the UI keeps the card visible (for retry)
   * whenever `resolved` is false.
   */
  answerRecoveryGate: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        reviewItemId: z.string().min(1),
        answerText: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<AnswerRecoveryGateResult> => {
      if (!nudgeRunDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'nudge dependencies not wired yet. Call setNudgeRunDeps() at boot.',
        });
      }
      if (!ctx.db) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'db not wired into tRPC context' });
      }
      const deps = nudgeRunDeps;
      return answerRecoveryGateHandler(input.projectId, input.reviewItemId, input.answerText, {
        db: ctx.db,
        nudge: (runId, text, opts) => nudgeRunHandler(runId, text, deps, opts),
        resolveReviewItem: (projectId, reviewItemId, resolution) =>
          ReviewItemRouter.getInstance()
            .applyReviewItem(projectId, { op: 'resolve', actor: 'user', reviewItemId, resolution })
            .then(() => undefined),
        logger: deps.logger,
      });
    }),

  /**
   * Queue a chat message for a RUNNING workflow run ("always allow messaging a
   * running flow"). The composer is now ENABLED while an SDK run executes; the
   * SDK substrate runs a one-shot query() per turn, so there is NO mid-turn input
   * injection — the text is BUFFERED on the (shared) RunExecutor and DELIVERED as
   * the NEXT turn at the drained REST seam (running -> awaiting_review), via the
   * SAME nudge re-spawn mechanism. This is the SDK twin of relayInput (which feeds
   * the live interactive PTY); a running interactive run keeps using relayInput.
   *
   * PERMITTED only while the run is mid-flight (running / starting / queued):
   *   - terminal (completed/failed/canceled) → { noOp: 'terminal' } (a failed run
   *     uses runs.reopen; a completed run is done);
   *   - awaiting_review / paused / awaiting_input / stuck → { noOp: 'not_running' }
   *     (those rested states use runs.nudge / runs.resume / the question gate, not
   *     this queue path);
   *   - blank-after-trim text → { noOp: 'empty' } (nothing to deliver).
   *
   * ctx.db-direct status guard (no handler module): pure status check + a single
   * executor-buffer append, mirroring the `end` / `setPermissionMode` shape. The
   * append is idempotent-safe and side-effect-free until the next drain.
   *
   * Standalone-typecheck invariant: the executor is injected via
   * setQueueInputDeps(); until wired the mutation throws METHOD_NOT_SUPPORTED.
   */
  queueInput: protectedProcedure
    .input(z.object({ runId: z.string().min(1), text: z.string() }))
    .mutation(async ({ ctx, input }): Promise<
      | { queued: true }
      | { noOp: true; reason: 'not_found' | 'terminal' | 'not_running' | 'empty' }
    > => {
      if (!queueInputDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'queueInput dependencies not wired yet. Call setQueueInputDeps() at boot.',
        });
      }
      if (!ctx.db) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'db not wired into tRPC context' });
      }
      if (input.text.trim() === '') return { noOp: true, reason: 'empty' };

      const run = ctx.db
        .prepare('SELECT status FROM workflow_runs WHERE id = ?')
        .get(input.runId) as { status?: string } | undefined;
      if (!run?.status) return { noOp: true, reason: 'not_found' };
      if (['completed', 'failed', 'canceled'].includes(run.status)) {
        return { noOp: true, reason: 'terminal' };
      }
      if (!['running', 'starting', 'queued'].includes(run.status)) {
        return { noOp: true, reason: 'not_running' };
      }

      queueInputDeps.runExecutor.queueInput(input.runId, input.text);
      return { queued: true };
    }),

  /**
   * Remove a queued (not-yet-delivered) chat message from a running flow run's
   * buffer — the flow-run counterpart of panels:dequeue-input. Backs "behavior 3"
   * (click a queued row → reopen it in the composer AND drop it from the queue, so
   * it is not also delivered at the turn's rest boundary). Matches by text (the
   * buffer stores strings). Returns { dequeued } — false when there was no such
   * queued entry (already drained / never queued), which the caller treats as a
   * benign no-op.
   */
  dequeueInput: protectedProcedure
    .input(z.object({ runId: z.string().min(1), text: z.string() }))
    .mutation(async ({ input }): Promise<{ dequeued: boolean }> => {
      if (!queueInputDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'queueInput dependencies not wired yet. Call setQueueInputDeps() at boot.',
        });
      }
      return { dequeued: queueInputDeps.runExecutor.dequeueInput(input.runId, input.text) };
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
   * Retry a FAILED (or resting awaiting_review) PROGRAMMATIC workflow run at a
   * chosen or derived step, via the crash-safe resume machinery.
   *
   * Revives the run (guarded UPDATE, same sanctioned bypass family as reopen /
   * boot recovery / reviveQuickRunToRunning) and re-drives it starting at
   * `input.stepId` when given, else the last failed step, else the run's
   * current_step_id. Unlike `reopen`/`resume`, this does NOT await the
   * re-drive — a programmatic walk can rest at a human gate for a long time,
   * so it returns as soon as the revive lands.
   *
   * Returns:
   *   { delivered: true; stepId }  — the run was revived and re-driven from `stepId`.
   *   { noOp: true; reason }       — rejected: 'not_found' / 'not_programmatic' /
   *     'not_retryable' (wrong status, or a live gate is holding an
   *     awaiting_review run) / 'no_target_step' / 'unknown_step' / 'race'.
   *
   * Standalone-typecheck invariant: collaborators are injected via
   * setRetryRunDeps(). Until wired the mutation throws METHOD_NOT_SUPPORTED.
   */
  retryStep: protectedProcedure
    .input(z.object({ runId: z.string().min(1), stepId: z.string().min(1).optional() }))
    .mutation(async ({ input }): Promise<RetryRunResult> => {
      if (!retryRunDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'retry-run deps not wired yet. Call setRetryRunDeps() at boot.',
        });
      }
      return retryRunHandler(input.runId, input.stepId, retryRunDeps);
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
    .input(z.object({ runId: z.string().min(1), terminalId: z.string().min(1).optional() }))
    .mutation(({ input }): { ok: boolean; reason?: string } => {
      if (!runShellDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'run shell dependencies not wired yet. Call setRunShellDeps() at boot.',
        });
      }
      // terminalId defaults to runId (the run's primary terminal).
      return runShellDeps.open(input.runId, input.terminalId ?? input.runId);
    }),

  /** Write keystrokes verbatim into a run worktree terminal (by terminalId). */
  shellInput: protectedProcedure
    .input(z.object({ terminalId: z.string().min(1), text: z.string() }))
    .mutation(({ input }): { success: true } => {
      if (!runShellDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'run shell dependencies not wired yet. Call setRunShellDeps() at boot.',
        });
      }
      runShellDeps.write(input.terminalId, input.text);
      return { success: true };
    }),

  /** Relay a PTY geometry change into a run worktree terminal (by terminalId). */
  shellResize: protectedProcedure
    .input(z.object({
      terminalId: z.string().min(1),
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
      runShellDeps.resize(input.terminalId, input.cols, input.rows);
      return { success: true };
    }),

  /**
   * The retained scrollback tail for a run worktree terminal (by terminalId).
   * The terminal tab fetches this once on mount and replays it into the xterm so
   * a (re)mounting terminal reconstructs recent output instead of rendering blank
   * (mirrors getPtyBacklog for the agent PTY). '' for an unknown terminal.
   */
  shellBacklog: protectedProcedure
    .input(z.object({ terminalId: z.string().min(1) }))
    .query(({ input }): { backlog: string } => {
      if (!runShellDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'run shell dependencies not wired yet. Call setRunShellDeps() at boot.',
        });
      }
      return { backlog: runShellDeps.getBacklog(input.terminalId) };
    }),

  /**
   * Terminate a SINGLE run worktree terminal (the user closed an added terminal
   * tab). The run's primary terminal (terminalId === runId) is never closed this
   * way; it is torn down with the run at close-out. No-op for an unknown id.
   */
  shellClose: protectedProcedure
    .input(z.object({ terminalId: z.string().min(1) }))
    .mutation(({ input }): { success: true } => {
      if (!runShellDeps) {
        throw new TRPCError({
          code: 'METHOD_NOT_SUPPORTED',
          message: 'run shell dependencies not wired yet. Call setRunShellDeps() at boot.',
        });
      }
      runShellDeps.closeOne(input.terminalId);
      return { success: true };
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
      // Q1 GUARD (interrupt = no tasks): a dismissed plan-gated run discards the
      // PENDING draft entities it created pre-approval (epics + orphan tasks) so
      // the abandoned run leaves no orphans on the board. deleteRunCreatedEntities
      // self-gates on plan_approved_at IS NULL (an approved run's revealed tasks
      // survive) and keys on run_id (a non-planner run created nothing run-keyed ->
      // no-op). Fail-soft: an uninitialized router (unit tests) or any throw is
      // swallowed — the worktree is already removed and the run row is canonical.
      try {
        const pr = ctx.db
          .prepare('SELECT project_id AS projectId FROM workflow_runs WHERE id = ?')
          .get(input.runId) as { projectId?: number } | undefined;
        if (pr && typeof pr.projectId === 'number') {
          await TaskChangeRouter.getInstance().deleteRunCreatedEntities(pr.projectId, input.runId);
        }
      } catch {
        // Best-effort draft cleanup — never block the dismiss.
      }
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
   * Return the run's latest token/context-usage facts recovered from
   * `raw_events` (newest assistant `message.usage` sum + newest result
   * `contextWindow`), so the Chat meta strip's ticker can BACKFILL on view
   * (re)entry instead of waiting for fresh live events — the in-memory
   * `streamEvents` buffer is wiped on every `setActiveRun`, and the
   * denominator only arrives on step-boundary `result` events, so without
   * this the meter showed "--" after every view switch. Cheap bounded scans;
   * see `selectRunContextUsage`.
   */
  contextUsage: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(async ({ ctx, input }): Promise<RunContextUsage> => {
      if (!ctx.db) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'db not wired into tRPC context',
        });
      }
      return selectRunContextUsage(ctx.db, input.runId);
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

      // A/B testing (migration 046): resolve the effective definition from the run's
      // FROZEN spec (its variant graph, else the live spec) via resolveRunFrozenSpec —
      // NOT the live JOIN read above — so a structural variant run (or a run whose live
      // workflows.spec_json was edited mid-run) renders the graph its current_step_id was
      // validated against. Falls back to the live JOIN read (workflow_name + spec_json)
      // when no frozen revision resolves, keeping legacy/baseline runs byte-identical.
      const frozen = resolveRunFrozenSpec(ctx.db, input.runId);
      const effectiveWorkflowName = frozen?.workflowName ?? row.workflow_name;
      const effectiveSpecJson = frozen ? frozen.specJson : row.spec_json;
      const definition = resolveWorkflowDefinition(effectiveWorkflowName, effectiveSpecJson);
      if (definition === null) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `No workflow definition for run ${input.runId} (workflow name '${effectiveWorkflowName}')`,
        });
      }

      const currentStepId = row.current_step_id;

      // Terminal run statuses: when the run has completed or been canceled, every
      // step collapses to 'done' — not 'running'. Without this check, a run that
      // completes before the renderer's getPhaseState query resolves (which causes
      // subscription 'done' events to be silently dropped) would show the current
      // step as perpetually 'running'.
      //
      // A FAILED run is terminal too but deliberately KEEPS the positional
      // derivation (before → 'done', at → 'done', after → 'pending'): steps the
      // walk never reached must not render as DONE beside the FAILED marker the
      // overlay below promotes — and this mirrors exactly what the live 'failed'
      // transition event painted before the reload (mergeTransition sets
      // after-steps to 'pending').
      const runIsAllDone = row.run_status === 'completed' || row.run_status === 'canceled';
      const runIsFailed = row.run_status === 'failed';

      // Flatten all steps across phases in declaration order.
      const flatSteps = definition.phases.flatMap((p) => p.steps);

      // Compute stepStates. If currentStepId is null or not found (orphan),
      // all steps are 'pending'.
      const matchIndex = currentStepId !== null
        ? flatSteps.findIndex((s) => s.id === currentStepId)
        : -1;

      const stepStates: WorkflowStepState[] = flatSteps.map((s, i) => {
        let status: WorkflowStepState['status'];
        if (runIsAllDone) {
          status = 'done';
        } else if (matchIndex === -1) {
          status = 'pending';
        } else if (i < matchIndex) {
          status = 'done';
        } else if (i === matchIndex) {
          // Failed runs are terminal: the step the run stopped on must not show
          // 'running' (the overlay below promotes it to 'failed' when recorded).
          status = runIsFailed ? 'done' : 'running';
        } else {
          status = 'pending';
        }
        return { stepId: s.id, status };
      });

      // Overlay the persisted per-step OUTCOMES (migration 033). The positional
      // derivation above collapses every settled step to 'done', but the
      // programmatic controller records rich outcomes to step_results. Promote a
      // 'done' step to 'failed'/'skipped' when its recorded outcome says so, so the
      // timeline distinguishes a failed/skipped step from a completed one.
      // Constraints:
      //   - ONLY 'done' is overlaid — a step being re-driven right now ('running')
      //     must not show a stale marker, and a not-yet-reached step ('pending')
      //     has no outcome to show.
      //   - 'rejected'/'canceled' outcomes are LEFT as 'done' (they aren't timeline
      //     markers — mirrors WorkflowController.reportStep's collapse).
      //   - Store uninitialized (early boot / orchestrated-only DBs) ⇒ null ⇒ exact
      //     legacy behavior (no overlay).
      const stepResultStore = StepResultStore.tryGetInstance();
      if (stepResultStore !== null) {
        const outcomeByStepId = new Map(
          stepResultStore.listForRun(input.runId).map((r) => [r.stepId, r.outcome] as const),
        );
        for (const s of stepStates) {
          if (s.status !== 'done') continue;
          const outcome = outcomeByStepId.get(s.stepId);
          if (outcome === 'failed') s.status = 'failed';
          else if (outcome === 'skipped') s.status = 'skipped';
        }
      }

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
