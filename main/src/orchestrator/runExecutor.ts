/**
 * RunExecutor — translates a runId into the panelId/sessionId shape that
 * ClaudeCodeManager.spawnCliProcess() expects (panelId === runId === sessionId),
 * and exposes four protected extension hooks for sibling tasks (TASK-641–644) to override.
 *
 * Standalone-typecheck invariant (ROADMAP-001 §6.3):
 * This module must NOT import 'electron', 'better-sqlite3', or any concrete
 * service in main/src/services/*.  All collaborators are injected via the
 * constructor (ClaudeSpawnerLike, WorkflowRegistryLike, LoggerLike).
 *
 * Extension hooks and their owning tasks:
 *   getPrompt(workflow)               — TASK-641 (workflow prompt resolver)
 *   bridgeEvents(runId, panelId)      — TASK-642 (SDK event bridge)
 *   buildOptionsOverrides(...)        — TASK-643 (permission mode mapper)
 *   onLifecycleTransition(runId, phase) — TASK-644 (run lifecycle transitions)
 */

import { EventEmitter } from 'node:events';
import type { LoggerLike } from './types';
import type { WorkflowRow, WorkflowRunRow } from '../../../shared/types/workflows';
import type { PermissionMode } from '../../../shared/types/workflows';
import type { ClaudeStreamEvent } from '../../../shared/types/claudeStream';
import type { RunEventBridge, BridgeEventsOptions } from './runEventBridge';
import { bridgeEvents as bridgeEventsImpl } from './runEventBridge';
import type { StreamEventPublisher } from './runLauncher';
import { rollupRunUsage } from './runUsageRollup';

// ---------------------------------------------------------------------------
// Narrow interfaces (no concrete imports)
// ---------------------------------------------------------------------------

/**
 * Narrow interface for reading a workflow prompt.
 * The real implementation delegates to readWorkflowPrompt() for built-in / edited
 * built-in flows (non-null `workflow_path`) and to renderCustomFlowPrompt() for
 * custom flows (null `workflow_path`, graph in `spec_json`); tests inject a stub.
 * Synchronous — matches the existing readWorkflowPrompt API.
 * Throws WorkflowPromptReadError when a built-in `.md` is missing/empty or when a
 * custom flow has no resolvable definition.
 */
export interface WorkflowPromptReaderLike {
  read(workflow: WorkflowRow): { prompt: string; systemPromptAppend: string };
}

/**
 * Narrow interface for resolving a backlog idea's prose body by id (migration 017).
 *
 * The real implementation delegates to `selectTaskById` (which UNIONs the
 * ideas/epics/tasks tables) in main/src/index.ts; tests inject a stub. Returns
 * null when the id resolves to no entity. When injected and a run carries a
 * `seed_idea_id`, getPrompt() prepends the resolved idea body to the planner's
 * MAIN prompt as a `# Selected idea` block (Piece A).
 *
 * NOTE: this is a Pre-launch idea-selection collaborator only — it participates
 * in NO stage derivation (distinct from the task_id / taskStageDeriver path).
 */
export interface IdeaBodyReaderLike {
  read(id: string): {
    type: string;
    title: string;
    summary: string | null;
    body: string | null;
    scope: string | null;
    /**
     * Display ref (e.g. 'TASK-123'). OPTIONAL so pre-existing stubs/adapters
     * that predate the sprint seed-tasks block keep compiling; when absent the
     * seed-tasks renderer falls back to the raw entity id.
     */
    ref?: string | null;
    /**
     * Image attachments on the entity (ideas only, migration 028). When present,
     * getPrompt() appends their absolute on-disk paths to the `# Selected idea`
     * block so the planner can read the images with its Read tool. OPTIONAL so
     * pre-existing stubs/adapters keep compiling.
     */
    attachments?: Array<{ name: string; path: string }> | null;
  } | null;
}

/**
 * Narrow slice of SprintLaneStore needed by getPrompt to resolve which task ids
 * a sprint run's batch covers (feat/parallel-sprint, single-run lane model).
 * Wired from main/src/index.ts as a thin adapter over
 * SprintLaneStore.listLanes — injected as an interface (not the singleton) to
 * preserve the standalone-typecheck invariant + test ergonomics.
 */
export interface SprintLaneTaskIdsLike {
  listLaneTaskIds(batchId: string): string[];
  /**
   * OPTIONAL terminal close-out: when the sprint run reaches a terminal
   * failed/canceled phase, deriveTaskStageForPhase marks the run's batch
   * 'failed' so the lane substrate never strands a non-terminal batch. (The
   * 'completed' close-out lives in the session-merge path in
   * main/src/ipc/git.ts.) Optional so prompt-only stubs stay minimal.
   */
  markBatchTerminal?(batchId: string, status: 'completed' | 'failed'): void;
}

/**
 * Options accepted by ClaudeCodeManager.spawnCliProcess (narrow shape).
 * The real ClaudeCodeManager satisfies this interface; tests use a vi.fn() stub.
 */
export interface ClaudeSpawnerOptions {
  panelId: string;
  sessionId: string;
  worktreePath: string;
  prompt: string;
  /**
   * Workflow 4-mode agent permission value resolved from the run snapshot
   * (`workflow_runs.permission_mode_snapshot`). Threaded to the spawning
   * manager so each substrate can apply native auto / accept-edits / ask /
   * skip behavior. Behavior branching lands in a later step; here the field is
   * only carried. DISTINCT from the legacy session `permissionMode`.
   */
  agentPermissionMode?: PermissionMode;
  systemPromptAppend?: string;
  /**
   * The real workflow_runs.id. For workflow runs this equals panelId/sessionId
   * per the orchestrator invariant (panelId === runId === sessionId); the
   * spawner uses it to set CYBOFLOW_RUN_ID. Optional so quick-session callers
   * (which never reach this executor) are unaffected.
   */
  runId?: string;
  /**
   * Explicit SDK session id to resume (Piece C — idle-chat nudge). When set,
   * the spawner passes it directly as the SDK `resume` option, bypassing the
   * panel-customState lookup that workflow runs cannot satisfy (they never
   * create a panel row). Threaded by RunExecutor.execute ONLY when a pending
   * nudge exists for the run; absent (and thus byte-identical) on a fresh run.
   */
  resumeSessionId?: string;
}

/**
 * Narrow interface for spawning and aborting a Claude CLI process.
 * Matches the ClaudeManagerLike pattern in stuckDetector.ts:36.
 */
export interface ClaudeSpawnerLike {
  spawnCliProcess(options: ClaudeSpawnerOptions): Promise<void>;
  abort(panelId: string): Promise<void>;
}

/**
 * Context handed to a ProgrammaticRunner for one `programmatic`-model run.
 * Mirrors the data RunExecutor already has in scope at the spawn seam.
 */
export interface ProgrammaticRunContext {
  runId: string;
  panelId: string;
  sessionId: string;
  worktreePath: string;
  run: WorkflowRunRow;
  workflow: WorkflowRow;
  /**
   * Fires when the run is canceled. The runner threads it into the
   * WorkflowController (which checks it each step) and the human gate (which
   * settles + cleans up on abort), so a canceled programmatic run stops promptly
   * instead of continuing to spawn agent turns or hanging at a gate. Owned by
   * RunExecutor (one AbortController per programmatic run, aborted by
   * requestProgrammaticCancel / cancel).
   */
  signal: AbortSignal;
  /**
   * Crash-safe resume (optional): the step id to fast-forward the controller to —
   * the run's persisted `current_step_id` when a stranded programmatic run is
   * re-driven on boot. Absent on a fresh run (walk starts from the beginning).
   */
  resumeFromStepId?: string;
  /**
   * Crash-safe resume (optional, migration 033): step ids that INDIVIDUALLY
   * completed before the restart (persisted done/skipped). The controller skips
   * these without re-running — finer than `resumeFromStepId` alone.
   */
  completedStepIds?: ReadonlySet<string>;
  /**
   * Inject a synthetic event into the run's unified stream (monitor-unify seam).
   *
   * Emits a `'output'` event on the per-run PERSISTING bridge source so the host
   * (e.g. the on-demand monitor) can render conversation turns + triage rationale
   * in the run's Chat pane: the bridge INSERTs the event into `raw_events` and
   * publishes it to the renderer. Threaded by `executeProgrammatic`; a no-op
   * (`() => {}`) when no persisting bridge was wired (no publisher/db — the test
   * construction path), so callers can invoke it unconditionally.
   */
  injectEvent: (event: ClaudeStreamEvent) => void;
}

/**
 * The collaborator that drives a `programmatic` run — the host-side
 * WorkflowController plus its SDK step-runner. Injected (optional) so the
 * orchestrated path is byte-identical when it is absent, and so the heavy /
 * not-yet-live-verified SDK walk is isolated behind a fakeable seam.
 *
 * Its `run()` shares the spawn contract of `spawnCliProcess`: it RESOLVES when
 * the walk completes (the run then rests in awaiting_review) and THROWS to fail
 * the run — so RunExecutor's existing drained/failed lifecycle handling applies
 * unchanged.
 */
export interface ProgrammaticRunner {
  run(ctx: ProgrammaticRunContext): Promise<void>;
}

/**
 * Narrow interface for querying workflow and workflow_runs rows.
 * Avoids importing the concrete WorkflowRegistry class to preserve test ergonomics.
 */
export interface WorkflowRegistryLike {
  getRunById(runId: string): WorkflowRunRow | null;
  getById(workflowId: string): WorkflowRow | null;
}

/**
 * Narrow interface for firing workflow_runs status transitions.
 * The concrete adapter in main/src/index.ts delegates to the transitionTo*
 * helpers from services/cyboflow/transitions.ts.  Keeping this interface
 * here preserves the standalone-typecheck invariant: runExecutor.ts never
 * imports from main/src/services/*.
 */
export interface LifecycleTransitionsLike {
  running(runId: string): void;
  /**
   * REST transition: running -> awaiting_review on SDK iterator drain.
   *
   * The executor NEVER transitions a run to `completed` — `completed` is set
   * ONLY by an explicit user accept (Merge / Create-PR) via the runs router.
   * On a clean drain the run rests in `awaiting_review` ("agent finished its
   * turn; awaiting the user's Merge / PR / Dismiss decision"). This rest
   * transition does NOT insert an approval row (distinct from the tool-approval
   * gate, which also rests in awaiting_review but with a PENDING approvals row).
   */
  restAwaitingReview(runId: string): void;
  failed(runId: string, fromStatus: 'starting' | 'running' | 'awaiting_review' | 'stuck', errorMessage: string): void;
  canceled(runId: string): void;
}

/**
 * Narrow slice of TaskChangeRouter needed to derive a task's execution stage as
 * the linked run transitions through its lifecycle (migration 014).
 *
 * Injected (not reached for via `TaskChangeRouter.getInstance()`) to preserve
 * the standalone-typecheck invariant + constructor-injection test ergonomics.
 * The concrete TaskChangeRouter singleton satisfies this shape structurally.
 * When absent, all task derivation is silently skipped (backward-compat with
 * callers that predate native tasks).
 */
export interface TaskStageRecomputeLike {
  recomputeTaskExecutionStage(taskId: string): Promise<void>;
}

/**
 * Narrow interface for emitting step-transition events.
 * The concrete adapter in main/src/index.ts delegates to buildStepTransitionEvent()
 * from stepTransitionBridge.ts. Keeping this interface here preserves the
 * standalone-typecheck invariant: runExecutor.ts never imports from the bridge
 * or from main/src/services/*.
 *
 * `emit(runId, status)` is fail-soft by convention: the executor wraps each
 * call in a try/catch and logs at warn level without escalating.
 */
export interface StepTransitionEmitterLike {
  emit(runId: string, status: 'pending' | 'running' | 'done'): void;
}

// ---------------------------------------------------------------------------
// RunExecutor
// ---------------------------------------------------------------------------

/**
 * Execution phase labels used by onLifecycleTransition.
 * Covers the full workflow_runs lifecycle.
 */
export type ExecutionPhase = 'pre_spawn' | 'post_spawn' | 'sdk_initialized' | 'drained' | 'failed' | 'canceled';

/**
 * Minimal CONTINUE prompt sent on a RESUME turn (Phase 4b — SDK-only Pause/Resume).
 *
 * Unlike a nudge (free-form human text), Resume carries no user message: it simply
 * re-drives the PAUSED run on the SAME SDK conversation (execute() threads the run's
 * claude_session_id as resumeSessionId). The base workflow prompt is already in the
 * resumed history, so getPrompt() returns this short nudge-to-continue instead of
 * re-sending it.
 */
export const RESUME_CONTINUE_PROMPT = 'Continue.';

export class RunExecutor {
  /**
   * Per-run bridge handles, keyed by runId.
   * Populated when bridgeEvents() returns a RunEventBridge; disposed by teardownRun().
   */
  private readonly bridges: Map<string, { dispose(): void }> = new Map();

  /**
   * Per-run dedicated EventEmitter sources for PROGRAMMATIC runs (monitor-unify
   * seam), keyed by runId. Created in executeProgrammatic() when a persisting
   * bridge is wired (publisher && db present); the run context's injectEvent emits
   * a synthetic 'output' event on it, which the per-run persisting bridge picks up
   * and persists+publishes. Distinct from the shared `source` (which fans in the
   * spawner/interactive manager); a programmatic run owns its own emitter so its
   * injected turns never collide with another run's stream. All listeners removed
   * (and the key deleted) by teardownRun().
   */
  private readonly progSources: Map<string, EventEmitter> = new Map();

  /**
   * Per-run handle for the programmatic INJECT bridge (the persisting bridge over
   * `progSources`). Kept SEPARATE from `bridges` (which holds the shared-facade
   * live-publish bridge) because a programmatic run wires BOTH: the facade bridge
   * publishes the agent's per-step output, and this one persists+publishes injected
   * monitor turns. Both are disposed by teardownRun(). Empty for orchestrated runs.
   */
  private readonly progBridges: Map<string, RunEventBridge> = new Map();

  /**
   * Per-run panelId mapping, keyed by runId.
   * Stored during execute() so cancel() can look up the panelId to abort.
   */
  private readonly activePanelIds: Map<string, string> = new Map();

  /**
   * Per-run AbortController for PROGRAMMATIC runs only, keyed by runId. Created in
   * executeProgrammatic(); its signal is threaded into the WorkflowController +
   * human gate so a cancel actually stops the host-driven DAG walk (aborting the
   * spawner alone only kills the current step — the controller would keep
   * spawning the next one, and a gate would hang forever). Aborted by
   * requestProgrammaticCancel() (wired from the cancel path) and cancel(); removed
   * by teardownRun(). Empty for orchestrated runs (one spawn == the whole run).
   */
  private readonly programmaticAborts: Map<string, AbortController> = new Map();

  /**
   * Per-run crash-safe resume step (programmatic runs only), keyed by runId. Set
   * by setPendingResumeStep() before boot recovery re-drives a stranded run; read
   * by executeProgrammatic() to fast-forward the controller to the persisted
   * current_step_id; cleared by teardownRun(). Empty for fresh runs.
   */
  private readonly pendingResumeStep: Map<string, string> = new Map();

  /**
   * Per-run set of already-completed step ids for crash-safe resume (migration
   * 032), keyed by runId. Set by setPendingCompletedSteps() before boot recovery
   * re-drives a stranded run; read by executeProgrammatic() so the controller
   * skips individually-completed steps; cleared by teardownRun().
   */
  private readonly pendingCompletedSteps: Map<string, ReadonlySet<string>> = new Map();

  /**
   * Per-run 'turn-end' listeners bound to the `source` EventEmitter, keyed by
   * runId (IDEA-030 / TASK-818). Registered for INTERACTIVE/persistent runs only
   * (gated in execute()); removed by teardownRun() so a re-init does not leak
   * listeners. The SDK path never registers one (sdk runs never receive a
   * 'turn-end' event — the facade only fans in the interactive manager).
   */
  private readonly turnEndListeners: Map<string, (payload: unknown) => void> = new Map();

  /**
   * Per-run systemPromptAppend values stashed by getPrompt() and consumed by
   * buildOptionsOverrides(). Cleared by teardownRun() to prevent leaks.
   */
  private pendingSystemPromptAppend = new Map<string, string>();

  /**
   * Per-run pending nudge text (Piece C — idle-chat nudge). Set by
   * setPendingNudge() before nudgeRunHandler re-drives execute(); read by
   * getPrompt() (returns JUST the nudge text — the resumed conversation already
   * holds planner.md) and by execute() (threads resumeSessionId from
   * claude_session_id). Cleared by teardownRun() so a subsequent execute() of
   * the same run is a clean fresh turn.
   */
  private pendingNudge = new Map<string, string>();

  /**
   * Per-run RESUME flag (Phase 4b — SDK-only Pause/Resume). Set by
   * setPendingResume() before resumeRunHandler re-drives execute() on a run that
   * was PAUSED (status flipped paused -> running by the handler). It is the
   * human-text-less twin of pendingNudge: when a run is in resume mode, execute()
   * threads the run's claude_session_id as the SDK resume id (so the SAME
   * conversation continues) and getPrompt() returns a minimal CONTINUE prompt
   * (the base workflow prompt is already in the resumed SDK history). Cleared by
   * teardownRun() so a later execute() of the same run is a clean fresh turn.
   *
   * A Set (not a Map) because resume carries no payload — the continue prompt is
   * a fixed sentinel. pendingNudge wins over pendingResume in getPrompt/execute
   * (a nudge is a more specific resumed turn), though in practice a run is never
   * in both modes at once.
   */
  private pendingResume = new Set<string>();

  /**
   * Per-run error messages stashed in execute()'s catch arm before firing the
   * 'failed' phase. Cleared by teardownRun() to prevent leaks.
   */
  private pendingFailedMessage = new Map<string, string>();

  /**
   * Per-run fromStatus values for the 'failed' transition, defaulting to 'running'.
   * Cleared by teardownRun() to prevent leaks.
   */
  private pendingFailedFromStatus = new Map<string, 'starting' | 'running' | 'awaiting_review' | 'stuck'>();

  constructor(
    protected readonly spawner: ClaudeSpawnerLike,
    private readonly registry: WorkflowRegistryLike,
    protected readonly logger: LoggerLike,
    private readonly promptReader?: WorkflowPromptReaderLike,
    private readonly lifecycleTransitions?: LifecycleTransitionsLike,
    private readonly publisher?: StreamEventPublisher,
    private readonly db?: BridgeEventsOptions['db'],
    /**
     * Optional EventEmitter source for the event bridge.  In production this is
     * the concrete AbstractCliManager (which extends EventEmitter and emits
     * 'output' events).  Injected here so bridgeEvents() does not need to cast
     * `this.spawner` — the spawner is a plain-object adapter that has no .on().
     * When absent, bridgeEvents() short-circuits (no bridging, backward-compat).
     */
    private readonly source?: EventEmitter,
    /**
     * Optional step-transition emitter collaborator (TASK-765).
     * When injected, emitStep() calls stepEmitter.emit(runId, status) at run
     * start ('running') and run end ('done'). When absent, step transitions are
     * silently skipped (backward-compat with callers that predate TASK-765).
     */
    private readonly stepEmitter?: StepTransitionEmitterLike,
    /**
     * Optional native-task stage deriver (migration 014). When injected, terminal
     * and running lifecycle transitions set workflow_runs.outcome (for failed /
     * canceled) and recompute the linked task's derived execution stage via the
     * chokepoint. Requires `db` to also be injected (to read the run's task_id and
     * write its outcome). When absent, task derivation is silently skipped.
     */
    private readonly taskStageDeriver?: TaskStageRecomputeLike,
    /**
     * Optional idea-body reader (migration 017). When injected and a run carries
     * a `seed_idea_id`, getPrompt() prepends the resolved idea body to the
     * planner's MAIN prompt as a `# Selected idea` block (Piece A pre-launch idea
     * selection). When absent, or when the run has no seed_idea_id, or when the
     * reader resolves no/empty body, getPrompt() returns the base prompt verbatim
     * (zero-behavior-change floor). Participates in NO stage derivation.
     */
    private readonly ideaBodyReader?: IdeaBodyReaderLike,
    /**
     * Optional sprint-lane task-id reader (feat/parallel-sprint, migration 022).
     * When injected and a run carries a `batch_id`, getPrompt() prepends a
     * `# Sprint tasks` block (one section per seeded task, resolved fail-soft
     * via ideaBodyReader) to the sprint's MAIN prompt. When absent, or when the
     * run has no batch_id, getPrompt() returns the base prompt verbatim
     * (zero-behavior-change floor). Participates in NO stage derivation.
     */
    private readonly sprintLaneTaskIds?: SprintLaneTaskIdsLike,
    /**
     * Optional programmatic-run driver (execution-model seam, Stage 1). When
     * injected AND a run's immutable `execution_model` stamp is 'programmatic',
     * execute() delegates the whole run to this collaborator (host code walks the
     * DAG) instead of spawning a single orchestrator turn. When absent — or for
     * the default 'orchestrated' model — execute() takes the unchanged spawn path,
     * so the orchestrated lifecycle is byte-identical (zero-behavior-change floor).
     */
    private readonly programmaticRunner?: ProgrammaticRunner,
  ) {}

  /**
   * Execute a workflow run by runId.
   *
   * 1. Load the workflow_runs row (throws if missing).
   * 2. Load the workflow row (throws if missing).
   * 3. Set panelId === runId === sessionId (invariant: no prefix).
   * 4. Call getPrompt() to retrieve the prompt (default: throws NOT_IMPLEMENTED).
   * 5. Call buildOptionsOverrides() to get optional spawn-option overrides.
   * 6. Call bridgeEvents() to wire event forwarding; store returned handle.
   * 7. Call onLifecycleTransition(runId, 'pre_spawn').
   * 8. Call spawnCliProcess() on the ClaudeSpawnerLike collaborator.
   * 9. Call onLifecycleTransition(runId, 'post_spawn').
   * 10. Call teardownRun(runId) in a finally block to dispose the bridge.
   *
   * quick session boundary (IDEA-024 / TASK-743): this executor runs WORKFLOW
   * runs. A quick session (a session with null run_id) MUST NOT be passed as
   * runId — call sites are guarded by the session_id ↔ run_id linkage in
   * TASK-744's IPC handler.  If a quick session id is nonetheless passed here,
   * step 1 above throws `workflow_runs row not found for runId=…`, which is the
   * intended loud-failure mode.
   */
  async execute(runId: string): Promise<void> {
    const run = this.registry.getRunById(runId);
    if (!run) {
      throw new Error(`RunExecutor.execute: workflow_runs row not found for runId=${runId}`);
    }

    const workflow = this.registry.getById(run.workflow_id);
    if (!workflow) {
      throw new Error(
        `RunExecutor.execute: workflow row not found for workflowId=${run.workflow_id} (runId=${runId})`,
      );
    }

    if (!run.worktree_path) {
      throw new Error(
        `RunExecutor.execute: worktree_path is null for runId=${runId} — run must be in status 'starting' or later`,
      );
    }

    // Invariant: panelId === runId === sessionId across the orchestrator surface.
    // The `p.panelId !== runId` guard in bridgeEvents() keys on raw runId; ApprovalRouter's
    // workflow_runs UPDATE keys on runId. Any other value here silently breaks both.
    const panelId = runId;
    const sessionId = runId;

    // Store the panelId so cancel() can look it up.
    this.activePanelIds.set(runId, panelId);

    // Execution-model branch (Stage 1). A run whose immutable stamp is
    // 'programmatic' is driven by host code (the WorkflowController) instead of a
    // single orchestrator turn. Gated on BOTH the stamp AND an injected runner so
    // the orchestrated path below stays byte-identical; if a programmatic run is
    // somehow stamped with no runner wired, fall through to orchestrated (the
    // agent can always read+walk the same DAG) rather than dead-ending the run.
    if (run.execution_model === 'programmatic') {
      if (this.programmaticRunner) {
        await this.executeProgrammatic(runId, run, workflow, panelId, sessionId);
        return;
      }
      this.logger.warn(
        '[RunExecutor] run stamped execution_model=programmatic but no programmatic runner is injected; falling through to orchestrated',
        { runId },
      );
    }

    try {
      const prompt = await this.getPrompt(runId, workflow);
      const overrides = await this.buildOptionsOverrides(runId, run, workflow);

      // Wire event forwarding BEFORE spawning so no SDK-initialization events
      // are lost — bridgeEvents registers listeners, spawnCliProcess starts the
      // iterator that emits them.
      const bridgeHandle = await this.bridgeEvents(runId, panelId);
      if (bridgeHandle) {
        this.bridges.set(runId, bridgeHandle);
      }

      // Event-driven rest for the persistent interactive substrate (IDEA-030 /
      // TASK-818). For an interactive run the spawn promise stays PENDING across
      // turns (it resolves only on explicit end-session / kill), so the
      // 'drained' path below never fires per-turn. Instead each assistant
      // turn-end emits a 'turn-end' event (interactive manager -> facade ->
      // here) that rests the run in awaiting_review WITHOUT touching the spawn
      // promise. Registered BEFORE spawn (mirrors bridgeEvents) so no turn-end
      // is lost. Gated so SDK runs NEVER take this path — they drain via the
      // query() iterator and the unchanged 'drained' arm.
      this.registerTurnEndRest(runId, run);

      await this.onLifecycleTransition(runId, 'pre_spawn');
      // Emit step 'running' after the run transitions to running status (write-then-emit
      // ordering mirrors stepTransitionBridge: lifecycle transition fires first, then step emit).
      this.emitStep(runId, 'running');

      this.logger.info('[RunExecutor] spawning Claude CLI process', {
        runId,
        panelId,
        worktreePath: run.worktree_path,
      });

      // Resume the SAME SDK conversation when EITHER a Piece-C nudge OR a Phase-4b
      // Pause/Resume is pending AND the run captured a claude_session_id on a prior
      // turn. The captured id is threaded as the explicit SDK resume id so the agent
      // continues the SAME conversation instead of starting fresh. On a plain fresh
      // run (neither pending) this is undefined and the spawn options stay
      // byte-identical (zero-behavior-change floor).
      const resumeSessionId =
        ((this.pendingNudge.has(runId) || this.pendingResume.has(runId)) &&
          run.claude_session_id) ||
        undefined;

      try {
        await this.spawner.spawnCliProcess({
          panelId,
          sessionId,
          runId,
          worktreePath: run.worktree_path,
          prompt,
          ...overrides,
          ...(resumeSessionId ? { resumeSessionId } : {}),
        });

        // Iterator drained without error — the agent finished its turn. The run
        // RESTS in awaiting_review awaiting the user's Merge / PR / Dismiss
        // decision. The executor NEVER auto-completes a run.
        await this.onLifecycleTransition(runId, 'drained');
        // Emit step 'done' after the rest transition fires.
        this.emitStep(runId, 'done');
      } catch (err) {
        // Stash the error message so onLifecycleTransition('failed') can pick it up.
        const message = err instanceof Error ? err.message : String(err);
        this.pendingFailedMessage.set(runId, message);
        await this.onLifecycleTransition(runId, 'failed');
        // Emit step 'done' on failure path as well — the step ended, regardless of outcome.
        this.emitStep(runId, 'done');
        // Re-throw so the caller's catch (in runLauncher.ts) can log it.
        throw err;
      }
    } finally {
      this.teardownRun(runId);
    }
  }

  /**
   * Drive a `programmatic`-model run (execution-model seam, Stage 1). Mirrors the
   * orchestrated scaffolding in execute() — event bridge, pre_spawn transition,
   * step 'running', then the SAME drained/failed lifecycle handling — but swaps
   * the single orchestrator `spawnCliProcess` for the injected
   * `programmaticRunner.run()` (host code walking the DAG). Kept as a separate
   * method so the orchestrated path in execute() is untouched.
   *
   * Precondition: `this.programmaticRunner` is defined (checked by the caller).
   * Skips `registerTurnEndRest` — programmatic implies the SDK substrate (the
   * interactive substrate hard-pins 'orchestrated'), so there is no turn-end
   * rest path. teardownRun runs in finally exactly like execute().
   *
   * Unlike execute(), this does NOT drive the run-level stepEmitter (which
   * resolves the workflow's INITIAL step id and would rewind the timeline on
   * rest). The WorkflowController reports EVERY real step boundary itself (via the
   * host's reporter), so the per-step timeline is already complete and accurate.
   */
  private async executeProgrammatic(
    runId: string,
    run: WorkflowRunRow,
    workflow: WorkflowRow,
    panelId: string,
    sessionId: string,
  ): Promise<void> {
    const runner = this.programmaticRunner;
    if (!runner) {
      // Defensive: the caller already gated on this; never reached in practice.
      throw new Error(`RunExecutor.executeProgrammatic: no programmatic runner for runId=${runId}`);
    }
    if (!run.worktree_path) {
      throw new Error(`RunExecutor.executeProgrammatic: worktree_path is null for runId=${runId}`);
    }

    // Per-run AbortController so a cancel can stop the host-driven DAG walk and
    // settle any open human gate (see requestProgrammaticCancel / cancel).
    const abort = new AbortController();
    this.programmaticAborts.set(runId, abort);

    try {
      // (a) LIVE-PUBLISH the agent's per-step output: bridge the SHARED facade
      // `source` (skipPersistence:true — the CCM pipeline owns raw_events
      // persistence for agent turns), exactly as the orchestrated path and the
      // pre-refactor programmatic path did. Each step spawn emits 'output' with
      // panelId===runId onto the facade, so without this bridge the agent's
      // conversation turns persist (CCM sink) but never reach the renderer live and
      // the Chat pane goes STALE mid-walk (review: prog-step-output-not-published-live).
      const facadeBridge = await this.bridgeEvents(runId, panelId);
      if (facadeBridge) {
        this.bridges.set(runId, facadeBridge);
      }

      // (b) PERSIST+PUBLISH injected monitor turns: a PER-RUN bridge over a
      // dedicated EventEmitter (monitor-unify seam). These synthetic 'output'
      // events (triage rationale, chat exchanges) are produced by NOTHING else, so
      // this bridge runs with skipPersistence:false to own their raw_events
      // persistence AND render them live. Kept on a separate source/handle from the
      // facade bridge so the two streams never collide. Gated on publisher && db
      // (tests construct RunExecutor without them) — when absent, injectEvent is a
      // no-op for the run (mirrors the base method's guard).
      let injectEvent: (event: ClaudeStreamEvent) => void = () => {};
      if (this.publisher && this.db) {
        const progSource = new EventEmitter();
        this.progSources.set(runId, progSource);
        const progBridge = bridgeEventsImpl({
          runId,
          source: progSource,
          publisher: this.publisher,
          db: this.db,
          logger: this.logger,
          skipPersistence: false,
        });
        this.progBridges.set(runId, progBridge);
        injectEvent = (event: ClaudeStreamEvent): void => {
          progSource.emit('output', {
            panelId: runId,
            sessionId: runId,
            type: 'json',
            data: event,
            timestamp: new Date().toISOString(),
          });
        };
      }

      await this.onLifecycleTransition(runId, 'pre_spawn');

      this.logger.info('[RunExecutor] driving programmatic workflow run', {
        runId,
        panelId,
        worktreePath: run.worktree_path,
      });

      try {
        const resumeFromStepId = this.pendingResumeStep.get(runId);
        const completedStepIds = this.pendingCompletedSteps.get(runId);
        await runner.run({
          runId,
          panelId,
          sessionId,
          worktreePath: run.worktree_path,
          run,
          workflow,
          signal: abort.signal,
          injectEvent,
          ...(resumeFromStepId ? { resumeFromStepId } : {}),
          ...(completedStepIds ? { completedStepIds } : {}),
        });
        // If the run was canceled mid-walk, the cancel path owns the terminal DB
        // transition ('canceled') — do NOT fire the 'drained' rest (it would race
        // a non-terminal awaiting_review against the cancel write).
        if (abort.signal.aborted) {
          this.logger.info('[RunExecutor] programmatic run canceled; cancel path owns terminal', { runId });
          return;
        }
        // The controller walk completed — the run RESTS in awaiting_review,
        // identical to the orchestrated 'drained' arm. The executor never
        // auto-completes a run. The controller already emitted the final step
        // 'done', so no run-level emitStep here.
        await this.onLifecycleTransition(runId, 'drained');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.pendingFailedMessage.set(runId, message);
        await this.onLifecycleTransition(runId, 'failed');
        throw err;
      }
    } finally {
      this.teardownRun(runId);
    }
  }

  /**
   * Request cancellation of a PROGRAMMATIC run mid-walk (execution-model seam).
   * Wired into the cancel path (cancelRunHandler's stopLiveRun) so cancelling a
   * programmatic run aborts the WorkflowController's walk and settles any open
   * human gate — aborting the spawner alone only kills the current step. A no-op
   * for orchestrated runs (no entry in the map) and idempotent (double-abort is
   * safe). Returns true when a controller was actually signalled.
   */
  requestProgrammaticCancel(runId: string): boolean {
    const abort = this.programmaticAborts.get(runId);
    if (!abort) return false;
    if (!abort.signal.aborted) abort.abort();
    return true;
  }

  /**
   * Dispose a programmatic run's MONITOR inject plumbing (the per-run progSource +
   * its persisting bridge). Anchored to TERMINAL close-out (merge / createPr /
   * dismiss — wherever the worktree is removed), NOT to walk-drain: the monitor
   * stays reachable while the run rests in awaiting_review (or sits failed /
   * canceled-but-kept) so the user can still chat with it. The MonitorRegistry
   * entry is unregistered by the composition-root close-out wiring alongside this
   * call. Idempotent; a no-op for orchestrated runs (no entry) and for an already-
   * disposed run.
   */
  disposeMonitorResources(runId: string): void {
    const progBridge = this.progBridges.get(runId);
    if (progBridge) {
      progBridge.dispose();
      this.progBridges.delete(runId);
    }
    const progSource = this.progSources.get(runId);
    if (progSource) {
      progSource.removeAllListeners();
      this.progSources.delete(runId);
    }
  }

  /**
   * Mark a programmatic run for crash-safe RESUME at `stepId` (boot recovery).
   * Called before re-driving execute(runId) on a run whose previous process died
   * mid-walk; executeProgrammatic threads it into the controller so already-done
   * steps are skipped and the walk resumes at the persisted current_step_id.
   * Cleared by teardownRun() when the resumed turn settles.
   */
  setPendingResumeStep(runId: string, stepId: string): void {
    this.pendingResumeStep.set(runId, stepId);
  }

  /**
   * Mark already-completed step ids for crash-safe RESUME (migration 033). Set by
   * boot recovery (from the persisted step_results) before re-driving execute();
   * executeProgrammatic threads them so the controller skips those steps. Cleared
   * by teardownRun().
   */
  setPendingCompletedSteps(runId: string, stepIds: readonly string[]): void {
    this.pendingCompletedSteps.set(runId, new Set(stepIds));
  }

  /**
   * Register the event-driven REST handler for a persistent interactive run
   * (IDEA-030 / TASK-818).
   *
   * Gated on `run.substrate === 'interactive'` AND a wired `source` EventEmitter
   * — an SDK run (or any run with no source) registers NOTHING and so never
   * takes the event-driven rest path (it drains via the query() iterator and the
   * unchanged 'drained' arm). For an interactive run, each assistant turn-end
   * emits a 'turn-end' event (interactive manager -> SubstrateDispatchFacade ->
   * this source) whose payload carries the runId. On each such event we route
   * through onLifecycleTransition('drained') -> restAwaitingReview WITHOUT
   * resolving the spawn promise (the promise stays pending across turns; it
   * settles only on explicit end-session / kill). restAwaitingReview is guarded
   * on status='running', so firing it per-turn while an approval/question gate is
   * already open is a swallowed no-op — safe and re-entrant. NEVER emits step
   * 'done' here (the run rests between turns; it is NOT terminal).
   *
   * The payload is opaque `unknown` on the source EventEmitter, so it is narrowed
   * through a typed local shape (NO `any`); a payload whose runId does not match
   * is ignored (defensive — the facade fan-in does not pre-filter by runId).
   */
  private registerTurnEndRest(runId: string, run: WorkflowRunRow): void {
    if (!this.source || run.substrate !== 'interactive') return;

    const onTurnEnd = (payload: unknown): void => {
      if (typeof payload !== 'object' || payload === null || !('runId' in payload)) return;
      const evt = payload as { runId: string };
      if (evt.runId !== runId) return;
      // Rest the run in awaiting_review WITHOUT resolving the spawn promise.
      // Fire-and-forget: the transition is fail-soft (a rejected rest is
      // swallowed inside onLifecycleTransition), so a rejected promise here is
      // already handled — catch defensively to avoid an unhandled rejection.
      void this.onLifecycleTransition(runId, 'drained').catch((err) => {
        this.logger.warn('[RunExecutor] event-driven rest transition threw (fail-soft)', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };

    this.source.on('turn-end', onTurnEnd);
    this.turnEndListeners.set(runId, onTurnEnd);
  }

  /**
   * Cancel all in-flight runs managed by this executor.
   *
   * For each active run:
   *   1. Look up the panelId. If not present, no-op (idempotent).
   *   2. Abort the SDK run via spawner.abort(panelId).
   *   3. Fire onLifecycleTransition(runId, 'canceled') while pending* maps still populated.
   *   4. Fire teardownRun to dispose the bridge and clean up state.
   *
   * In the common single-run-per-executor pattern (used with RunExecutorRegistry),
   * this cancels exactly the one in-flight run. Double-cancel is idempotent.
   */
  async cancel(): Promise<void> {
    // Snapshot the active runIds so teardownRun deletions don't mutate the iterator.
    const activeRunIds = Array.from(this.activePanelIds.keys());

    for (const runId of activeRunIds) {
      const panelId = this.activePanelIds.get(runId);
      if (!panelId) continue;

      // Stop a programmatic run's host-driven walk FIRST (abort the controller +
      // settle any open gate); aborting the spawner alone only kills the current
      // step and would let the controller spawn the next one. No-op for
      // orchestrated runs.
      this.requestProgrammaticCancel(runId);
      await this.spawner.abort(panelId);
      await this.onLifecycleTransition(runId, 'canceled');
      // Emit step 'done' on canceled path — the step ended regardless of reason.
      this.emitStep(runId, 'done');
      this.teardownRun(runId);
    }
  }

  /**
   * Stash a pending nudge for a run (Piece C — idle-chat nudge).
   *
   * Called by nudgeRunHandler immediately before it re-drives execute(runId) on
   * a run that has drained to awaiting_review. The next getPrompt(runId) returns
   * JUST this text (the resumed conversation already holds planner.md) and
   * execute() threads the run's claude_session_id as the SDK resume id. The
   * nudge is cleared by teardownRun() when that turn drains, so a later
   * execute() of the same run is a clean fresh turn.
   */
  setPendingNudge(runId: string, text: string): void {
    this.pendingNudge.set(runId, text);
  }

  /**
   * Mark a run for RESUME (Phase 4b — SDK-only Pause/Resume).
   *
   * Called by resumeRunHandler immediately before it re-drives execute(runId) on a
   * run it just flipped paused -> running. The next getPrompt(runId) returns the
   * minimal CONTINUE prompt (RESUME_CONTINUE_PROMPT) instead of re-sending the base
   * workflow prompt, and execute() threads the run's claude_session_id as the SDK
   * resume id so the SAME conversation continues. The flag is cleared by
   * teardownRun() when that turn drains, so a later execute() of the same run is a
   * clean fresh turn.
   *
   * SDK-path only by construction: the interactive substrate has no native
   * --resume and resumeRunHandler refuses non-sdk runs before reaching here.
   */
  setPendingResume(runId: string): void {
    this.pendingResume.add(runId);
  }

  /**
   * Dispose the bridge handle and remove the panelId for the given runId.
   * Also clears the stashed systemPromptAppend + pending nudge to prevent leaks
   * across runs. Safe to call multiple times (idempotent).
   */
  private teardownRun(runId: string): void {
    const bridge = this.bridges.get(runId);
    if (bridge) {
      bridge.dispose();
      this.bridges.delete(runId);
    }
    // NOTE: the per-run PROGRAMMATIC inject bridge (progBridges/progSources) is
    // deliberately NOT disposed here. teardownRun fires at walk-drain
    // (awaiting_review REST), but the monitor must stay reachable AFTER the walk so
    // the user can chat with it about a run that is resting / failed / canceled-but-
    // kept (the worktree survives until close-out). Those resources are disposed by
    // `disposeMonitorResources(runId)`, called from the terminal close-out paths
    // (merge / createPr / dismiss) where the worktree is removed. Empty for
    // orchestrated runs regardless.
    // Remove the per-run 'turn-end' listener (interactive runs only — the map is
    // empty for SDK runs). For a persistent interactive run teardownRun fires
    // only AFTER the spawn promise settles on explicit end-session / kill (the
    // `finally` in execute() blocks on the still-pending spawn until then), so
    // the listener stays live across every turn and is removed exactly once at
    // terminal close-out — never mid-REPL.
    const turnEndListener = this.turnEndListeners.get(runId);
    if (turnEndListener && this.source) {
      this.source.off('turn-end', turnEndListener);
    }
    this.turnEndListeners.delete(runId);
    this.activePanelIds.delete(runId);
    this.programmaticAborts.delete(runId);
    this.pendingResumeStep.delete(runId);
    this.pendingCompletedSteps.delete(runId);
    this.pendingSystemPromptAppend.delete(runId);
    this.pendingNudge.delete(runId);
    this.pendingResume.delete(runId);
    this.pendingFailedMessage.delete(runId);
    this.pendingFailedFromStatus.delete(runId);
  }

  /**
   * Fail-soft step-transition emit.
   *
   * Calls stepEmitter.emit(runId, status) if a stepEmitter is injected.
   * A throwing emitter is caught, logged at warn level, and NOT escalated —
   * step-transition events must never crash the executor.
   *
   * @param runId  The workflow run ID.
   * @param status The new step status to emit.
   */
  private emitStep(runId: string, status: 'pending' | 'running' | 'done'): void {
    if (!this.stepEmitter) return;
    try {
      this.stepEmitter.emit(runId, status);
    } catch (err) {
      this.logger.warn('[RunExecutor] stepEmitter.emit threw (fail-soft)', {
        runId,
        status,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Protected extension hooks — overridden by TASK-641/642/643/644
  // ---------------------------------------------------------------------------

  /**
   * Returns the prompt string to pass to ClaudeCodeManager.spawnCliProcess.
   *
   * Default implementation reads the workflow file via the injected
   * WorkflowPromptReaderLike collaborator and stashes systemPromptAppend for
   * buildOptionsOverrides().  When no promptReader is injected (e.g. legacy
   * subclass that overrides getPrompt directly), the subclass override is called
   * instead via the two-arg form.
   *
   * Throws NOT_IMPLEMENTED if neither a reader nor a subclass override is available.
   *
   * Injection branches (shared seam for Piece A + Piece C + Phase 4b). After
   * resolving the base prompt + stashing systemPromptAppend, the run state is read
   * via the already-held registry (no interface widening) and composed in priority
   * order:
   *   1. (Piece C) pending nudge → return JUST the trimmed nudge text (the
   *      resumed conversation already holds planner.md; do NOT re-send it).
   *   2. (Phase 4b) pending resume → return the minimal CONTINUE prompt (the
   *      resumed conversation already holds the base prompt; do NOT re-send it).
   *   3. (Piece A) run.seed_idea_id set + idea body resolves → PREPEND a
   *      `# Selected idea` block to the MAIN prompt (never systemPromptAppend,
   *      which is invisible to the chat transcript).
   *   4. none → return the base prompt verbatim (zero-behavior-change floor).
   *
   * @param runId    The workflow run ID — used to stash systemPromptAppend.
   * @param workflow The workflow row containing workflow_path.
   */
  protected async getPrompt(runId: string, workflow: WorkflowRow): Promise<string> {
    if (!this.promptReader) {
      throw new Error('RunExecutor.getPrompt: no WorkflowPromptReaderLike injected — pass a promptReader to the constructor or override getPrompt in a subclass');
    }
    const { prompt, systemPromptAppend } = this.promptReader.read(workflow);
    this.pendingSystemPromptAppend.set(runId, systemPromptAppend);

    // Piece C — idle-chat nudge. When a pending nudge exists, return JUST the
    // trimmed nudge text: this turn RESUMES the SDK conversation (execute()
    // threads claude_session_id as resumeSessionId), so planner.md is already in
    // the resumed history and must NOT be re-sent. Checked FIRST — ahead of the
    // seed-idea branch — so the nudge text wins on a resumed turn.
    const nudge = this.pendingNudge.get(runId)?.trim();
    if (nudge) {
      return Promise.resolve(nudge);
    }

    // Phase 4b — Resume. When a run is in resume mode (no human text) return the
    // minimal CONTINUE prompt: this turn RESUMES the SDK conversation (execute()
    // threads claude_session_id as resumeSessionId), so the base workflow prompt is
    // already in the resumed history and must NOT be re-sent. Checked AFTER the
    // nudge branch (a nudge's free-form text is more specific) but ahead of the
    // seed-idea branch (which only applies to a fresh planner launch).
    if (this.pendingResume.has(runId)) {
      return Promise.resolve(RESUME_CONTINUE_PROMPT);
    }

    // Sprint seed-tasks injection (feat/parallel-sprint, single-run lane model).
    // When the run carries a batch_id, prepend a `# Sprint tasks` block (one
    // section per seeded lane task) to the sprint's MAIN prompt. Checked AFTER
    // the nudge/resume branches (a resumed conversation already holds the seeds
    // and must NOT receive them again) and ahead of the seed-idea branch (a
    // sprint run never carries a seed_idea_id, so order is mostly academic).
    // Fail-soft on every miss → fall through to the base prompt unchanged.
    const seedTasksBlock = this.buildSeedTasksBlock(runId);
    if (seedTasksBlock) {
      return Promise.resolve(`# Sprint tasks\n\n${seedTasksBlock}\n\n${prompt}`);
    }

    // Piece A — seed-idea injection. Read the run via the already-held registry
    // (no WorkflowRegistryLike widening). Fail-soft on every miss: null run /
    // null seed_idea_id / sentinel runId / no reader / unresolved or empty body
    // → fall through to the base prompt unchanged.
    const seedBlock = this.buildSeedIdeaBlock(runId);
    if (seedBlock) {
      return Promise.resolve(`# Selected idea\n\n${seedBlock}\n\n${prompt}`);
    }

    return Promise.resolve(prompt);
  }

  /**
   * Resolve the `# Selected idea` block body for a run's seed_idea_id (Piece A).
   *
   * Returns null (so getPrompt falls through to the base prompt) when: no
   * ideaBodyReader is injected, the run is missing or carries no seed_idea_id,
   * the reader resolves no entity, or the resolved entity has no usable content
   * (title, summary AND body all empty/whitespace). A title-only idea IS valid
   * and is injected. The block is title + (summary + body, each when present),
   * trimmed.
   *
   * Kept as a separate helper so Piece C can layer its pending-nudge branch
   * ahead of this one in getPrompt without re-deriving the seed-idea logic.
   *
   * The block leads with a dedup directive naming the existing idea (by ref +
   * id) so the planner FOLDS the spec into it via cyboflow_update_task rather
   * than creating a duplicate idea row.
   */
  private buildSeedIdeaBlock(runId: string): string | null {
    if (!this.ideaBodyReader) return null;
    const run = this.registry.getRunById(runId);
    const seedIdeaId = run?.seed_idea_id ?? null;
    if (!seedIdeaId) return null;

    const idea = this.ideaBodyReader.read(seedIdeaId);
    if (!idea) return null;

    // A title-only idea is valid — the title IS the idea (e.g. "Create a
    // website for tester"). Render whatever fields are present; only bail when
    // the resolved entity has no usable content at all (title + summary + body
    // all empty/whitespace).
    const title = idea.title?.trim() ?? '';
    const summary = idea.summary?.trim() ?? '';
    const body = idea.body?.trim() ?? '';
    if (title === '' && summary === '' && body === '') return null;

    const ref = idea.ref?.trim() ?? '';
    const handle = ref !== '' ? `ref \`${ref}\`, id \`${seedIdeaId}\`` : `id \`${seedIdeaId}\``;

    const parts: string[] = [];
    parts.push(
      `> This idea already exists (${handle}). Fold the spec INTO this idea via cyboflow_update_task(task_id="${seedIdeaId}", …) — do NOT create a new idea row for it.`
    );
    if (title !== '') parts.push(`## ${title}`);
    if (summary !== '') parts.push(summary);
    if (body !== '') parts.push(body);

    // Attachments (ideas only, migration 028): surface the absolute on-disk
    // paths so the planner can open the images with its Read tool. Skip entries
    // missing a path; render nothing when there are none.
    const attachments = (idea.attachments ?? []).filter((a) => a.path?.trim());
    if (attachments.length > 0) {
      const lines = attachments.map(
        (a) => `- ${a.name?.trim() || 'image'}: ${a.path.trim()}`,
      );
      parts.push(
        ['### Attached images', 'The user attached these images — read them with the Read tool:', ...lines].join('\n'),
      );
    }

    return parts.join('\n\n');
  }

  /**
   * Resolve the `# Sprint tasks` block body for a sprint run's batch_id
   * (feat/parallel-sprint, single-run lane model).
   *
   * Returns null (so getPrompt falls through) when: no sprintLaneTaskIds reader
   * or no ideaBodyReader is injected, the run is missing or carries no batch_id,
   * the lane listing throws/returns no ids, or NO seeded task resolves to usable
   * content. Each task renders as `## <ref ?? id>: <title>` + summary + body
   * (present fields only — same style as buildSeedIdeaBlock); an individual task
   * that fails to resolve is skipped fail-soft so one bad id never sinks the
   * whole sprint prompt.
   */
  private buildSeedTasksBlock(runId: string): string | null {
    if (!this.sprintLaneTaskIds || !this.ideaBodyReader) return null;
    const run = this.registry.getRunById(runId);
    const batchId = run?.batch_id ?? null;
    if (!batchId) return null;

    let taskIds: string[];
    try {
      taskIds = this.sprintLaneTaskIds.listLaneTaskIds(batchId);
    } catch (err) {
      this.logger.warn(`RunExecutor.buildSeedTasksBlock: lane listing failed for batch ${batchId} (run ${runId}): ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    if (taskIds.length === 0) return null;

    const sections: string[] = [];
    for (const taskId of taskIds) {
      try {
        const task = this.ideaBodyReader.read(taskId);
        if (!task) continue;
        const title = task.title?.trim() ?? '';
        const summary = task.summary?.trim() ?? '';
        const body = task.body?.trim() ?? '';
        if (title === '' && summary === '' && body === '') continue;

        const refOrId = task.ref?.trim() || taskId;
        const parts: string[] = [title !== '' ? `## ${refOrId}: ${title}` : `## ${refOrId}`];
        if (summary !== '') parts.push(summary);
        if (body !== '') parts.push(body);
        sections.push(parts.join('\n\n'));
      } catch (err) {
        // Fail-soft per id — one unresolvable task never sinks the sprint prompt.
        this.logger.warn(`RunExecutor.buildSeedTasksBlock: could not resolve task ${taskId} for batch ${batchId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (sections.length === 0) return null;

    const intro = `This sprint covers ${sections.length} task${sections.length === 1 ? '' : 's'}. Execute ALL of them.`;
    return [intro, ...sections].join('\n\n');
  }

  /**
   * Wire event forwarding between the SDK pipeline and the renderer.
   * Default implementation calls bridgeEventsImpl with onFirstMessage wired to
   * fire 'sdk_initialized' so the run transitions from 'starting' to 'running'
   * on the first SDK message.
   *
   * Returns a RunEventBridge handle (or void) that is stored per-run and
   * disposed when the run terminates or is canceled.
   *
   * @param runId   The workflow run ID.
   * @param _panelId The panel ID (per invariant, equals runId; unused by the bridge
   *                 which keys directly on runId).
   */
  protected async bridgeEvents(runId: string, _panelId: string): Promise<RunEventBridge | void> {
    if (!this.publisher || !this.db || !this.source) {
      // No publisher/db/source injected — skip bridging (backward-compat with tests
      // that construct RunExecutor without them).
      return;
    }
    return bridgeEventsImpl({
      runId,
      source: this.source,
      publisher: this.publisher,
      db: this.db,
      logger: this.logger,
      // skipPersistence: true — ClaudeCodeManager.runSdkQuery already constructs its
      // own EventRouter + RawEventsSink pipeline (claudeCodeManager.ts:247-255) and
      // calls router.emitForRun() for every SDK event (line ~341). Without this flag,
      // each event would be INSERTed twice into raw_events — once by the CCM-owned sink
      // and once by the bridge's own sink. FIND-SPRINT-021-5 identified this as a
      // latent double-INSERT regression that becomes active the moment the panelId
      // mismatch fixed in TASK-663 is effective.
      skipPersistence: true,
      onFirstMessage: () => this.onLifecycleTransition(runId, 'sdk_initialized'),
    });
  }

  /**
   * Returns optional overrides for ClaudeSpawnerOptions.
   * Threads the run's resolved 4-mode agentPermissionMode (read from the
   * IMMUTABLE snapshot `run.permission_mode_snapshot`, NOT the live
   * `workflow.permission_mode`) to the spawning manager, plus any pending
   * system-prompt append. Substrate behavior branching off this value lands in
   * a later step.
   *
   * @param runId     The workflow run ID.
   * @param run       The workflow_runs row (source of the permission snapshot).
   * @param _workflow The workflow row.
   */
  protected async buildOptionsOverrides(
    runId: string,
    run: WorkflowRunRow,
    _workflow: WorkflowRow,
  ): Promise<Partial<ClaudeSpawnerOptions>> {
    const systemPromptAppend = this.pendingSystemPromptAppend.get(runId) || undefined;
    const overrides: Partial<ClaudeSpawnerOptions> = {
      systemPromptAppend,
      agentPermissionMode: run.permission_mode_snapshot,
    };

    return overrides;
  }

  /**
   * Called at key lifecycle transition points.
   * Routes ExecutionPhase labels to the injected LifecycleTransitionsLike collaborator.
   * A throwing transition (e.g. TransitionRejectedError from a race with cancel) is
   * logged at warn level and NOT escalated — the race is expected.
   *
   * Phase routing:
   *   'pre_spawn'       → lifecycleTransitions.running(runId)  // primary path (see FIND-SPRINT-026-10)
   *   'sdk_initialized' → lifecycleTransitions.running(runId)  // defensive idempotency fallback
   *   'drained'         → lifecycleTransitions.restAwaitingReview(runId)  // running -> awaiting_review REST
   *   'failed'          → lifecycleTransitions.failed(runId, fromStatus, errorMessage)
   *   'canceled'        → lifecycleTransitions.canceled(runId)
   *   'post_spawn'      → no-op
   *
   * @param runId  The workflow run ID.
   * @param phase  The lifecycle phase label.
   */
  protected async onLifecycleTransition(runId: string, phase: ExecutionPhase): Promise<void> {
    if (this.lifecycleTransitions) {
      try {
        switch (phase) {
          // FIND-SPRINT-026-10 regression fix: 'pre_spawn' was previously a no-op
          // (fell through to 'post_spawn' return). Tests were failing because the
          // production contract changed: running() must fire BEFORE spawnCliProcess so
          // ApprovalRouter sees 'running' status when the SDK's PreToolUse hook fires.
          // The SDK can invoke PreToolUse before its first stream event is dispatched to
          // the bridge's onFirstMessage callback, so the prior 'sdk_initialized'-only
          // path would race: tool calls would arrive at the router while status='starting'
          // and be rejected with RunNotRunningError.
          case 'pre_spawn':
            await this.lifecycleTransitions.running(runId);
            break;
          case 'sdk_initialized':
            // Defensive idempotency: if pre_spawn somehow didn't fire (legacy code
            // paths or test subclasses overriding bridgeEvents), still attempt the
            // transition. transitionToRunning rejects when status≠'starting', so a
            // double-call just emits a (logged) TransitionRejectedError that's
            // safely swallowed below.
            await this.lifecycleTransitions.running(runId);
            break;
          case 'drained': {
            // The SDK iterator drained without error — the agent finished its turn.
            // The executor NEVER auto-completes a run: `completed` is reserved for an
            // explicit user accept (Merge / Create-PR). Instead the run RESTS in
            // awaiting_review, awaiting the user's decision.
            //
            // restAwaitingReview is guarded on status='running', so it is a safe
            // no-op (rejected → swallowed below) when the run is already parked in a
            // non-terminal state:
            //   - awaiting_review with a PENDING approval row: a tool approval gate is
            //     still open; the existing approval cycle (transitionFromAwaitingReview)
            //     drives it back to running. The rejected rest transition leaves the
            //     gate untouched.
            //   - awaiting_input: a question gate is open (QuestionRouter owns it).
            //   - stuck: the StuckDetector flagged it; leave it for triage.
            // Any of these means there is nothing for the rest transition to do.
            await this.lifecycleTransitions.restAwaitingReview(runId);
            break;
          }
          case 'failed': {
            const fromStatus = this.pendingFailedFromStatus.get(runId) ?? 'running';
            const errorMessage = this.pendingFailedMessage.get(runId) ?? 'unknown error';
            await this.lifecycleTransitions.failed(runId, fromStatus, errorMessage);
            break;
          }
          case 'canceled':
            await this.lifecycleTransitions.canceled(runId);
            break;
          case 'post_spawn':
            // no-op
            break;
        }
      } catch (err) {
        this.logger.warn('[RunExecutor] lifecycle transition rejected (expected race)', {
          runId,
          phase,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Native-task derivation (migration 014) — runs AFTER the status transition
    // (and independently of whether it was rejected as a race) so the chokepoint
    // aggregate reads the just-written run status. Sets workflow_runs.outcome for
    // terminal phases, then recomputes the linked task's derived execution stage
    // through TaskChangeRouter. Fail-soft: a task-side error is logged, never
    // escalated — task overlays must never crash the run lifecycle.
    await this.deriveTaskStageForPhase(runId, phase);

    // Insights Phase-2 (migration 026) — materialize the durable run_usage rollup
    // at EVERY terminal seam: 'drained' (clean rest in awaiting_review), 'failed',
    // and 'canceled'. Placed LAST in onLifecycleTransition so it runs after the
    // status transition + task derivation; by this point the run's raw_events log
    // is fully persisted for this seam (the SDK iterator drained for 'drained';
    // whatever landed is persisted for 'failed'/'canceled'). A single placement
    // here also covers the interactive substrate's per-turn re-drain and resumed
    // runs re-rolling up — INSERT OR REPLACE makes each re-materialization
    // idempotent. Fail-soft inside rollupRunUsage: a rollup error is logged and
    // swallowed there, so it can never break this transition.
    this.materializeRunUsage(runId, phase);
  }

  /**
   * Terminal-seam dispatch to the run_usage rollup writer (migration 026).
   *
   * Skips non-terminal phases (pre_spawn / post_spawn / sdk_initialized) and the
   * case where no `db` was injected (backward-compat with executor constructions
   * that omit it). For 'drained' / 'failed' / 'canceled' it calls the fail-soft
   * `rollupRunUsage`, threading the executor's logger (CLAUDE.md: never omit the
   * optional logger). The rollup writer owns its own try/catch — this seam adds
   * only the phase gate and the db presence check.
   */
  private materializeRunUsage(runId: string, phase: ExecutionPhase): void {
    if (!this.db) return;
    if (phase !== 'drained' && phase !== 'failed' && phase !== 'canceled') return;
    rollupRunUsage(this.db, runId, this.logger);
  }

  /**
   * Phase → task-stage derivation seam (migration 014).
   *
   * Resolves the run's linked task_id (skipping entirely when there is none, no
   * deriver is wired, or no db is injected). For the terminal phases it stamps
   * the DB-canonical close-out signal on workflow_runs.outcome BEFORE recomputing
   * so the chokepoint aggregate sees it:
   *   'failed'   → outcome='failed'
   *   'canceled' → outcome='canceled'
   * Then recomputeTaskExecutionStage drives the task to its derived stage:
   *   running phases (pre_spawn / sdk_initialized) → In development
   *   'drained' (rests awaiting_review)            → Ready to merge
   *   'failed' / 'canceled' (all runs terminal)    → revert to entry stage
   * 'post_spawn' is a no-op for tasks (status is unchanged).
   *
   * NOTE: merged / pr_open / dismissed outcomes are owned by the run close-out
   * mutations in trpc/routers/runs.ts, NOT here.
   */
  private async deriveTaskStageForPhase(runId: string, phase: ExecutionPhase): Promise<void> {
    if (!this.taskStageDeriver || !this.db || phase === 'post_spawn') return;

    try {
      const run = this.registry.getRunById(runId);

      // Sprint batch close-out (feat/parallel-sprint, single-run lane model):
      // a sprint run that dies terminally (failed/canceled) must not strand its
      // batch in a non-terminal status. Fail-soft and BEFORE the task_id
      // early-return — sprint runs carry batch_id but usually no task_id. The
      // 'completed' close-out is the session-merge path (main/src/ipc/git.ts).
      if ((phase === 'failed' || phase === 'canceled') && run?.batch_id && this.sprintLaneTaskIds?.markBatchTerminal) {
        try {
          this.sprintLaneTaskIds.markBatchTerminal(run.batch_id, 'failed');
        } catch (batchErr) {
          this.logger.warn('[RunExecutor] sprint batch terminal close-out failed (fail-soft)', {
            runId,
            batchId: run.batch_id,
            phase,
            error: batchErr instanceof Error ? batchErr.message : String(batchErr),
          });
        }
      }

      const taskId = run?.task_id ?? null;
      if (!taskId) return;

      if (phase === 'failed') {
        this.db
          .prepare(
            `UPDATE workflow_runs SET outcome = 'failed', updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND outcome IS NULL`,
          )
          .run(runId);
      } else if (phase === 'canceled') {
        this.db
          .prepare(
            `UPDATE workflow_runs SET outcome = 'canceled', updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND outcome IS NULL`,
          )
          .run(runId);
      }

      await this.taskStageDeriver.recomputeTaskExecutionStage(taskId);
    } catch (err) {
      this.logger.warn('[RunExecutor] task stage derivation failed (fail-soft)', {
        runId,
        phase,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
