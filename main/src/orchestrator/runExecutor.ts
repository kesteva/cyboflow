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
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { LoggerLike } from './types';
import type { WorkflowRow, WorkflowRunRow } from '../../../shared/types/workflows';
import type { PermissionMode } from '../../../shared/types/workflows';
import { buildPreToolUseHook } from './permissionModeMapper';
import type { RunEventBridge, BridgeEventsOptions } from './runEventBridge';
import { bridgeEvents as bridgeEventsImpl } from './runEventBridge';
import type { StreamEventPublisher } from './runLauncher';

// ---------------------------------------------------------------------------
// Narrow interfaces (no concrete imports)
// ---------------------------------------------------------------------------

/**
 * Narrow interface for reading a workflow prompt file.
 * The real implementation delegates to readWorkflowPrompt(); tests inject a stub.
 * Synchronous — matches the existing readWorkflowPrompt API.
 * Throws WorkflowPromptReadError when the file is missing or the body is empty.
 */
export interface WorkflowPromptReaderLike {
  read(workflowPath: string): { prompt: string; systemPromptAppend: string };
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
  } | null;
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
  preToolUseHook?: HookCallback;
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

export class RunExecutor {
  /**
   * Per-run bridge handles, keyed by runId.
   * Populated when bridgeEvents() returns a RunEventBridge; disposed by teardownRun().
   */
  private readonly bridges: Map<string, { dispose(): void }> = new Map();

  /**
   * Per-run panelId mapping, keyed by runId.
   * Stored during execute() so cancel() can look up the panelId to abort.
   */
  private readonly activePanelIds: Map<string, string> = new Map();

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

      // Piece C — idle-chat nudge resume. When a pending nudge exists AND the
      // run captured a claude_session_id on a prior turn, thread it as the
      // explicit SDK resume id so the agent continues the SAME conversation.
      // On a fresh run (no pending nudge) this is undefined and the spawn
      // options stay byte-identical (zero-behavior-change floor).
      const resumeSessionId =
        (this.pendingNudge.has(runId) && run.claude_session_id) || undefined;

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
    this.pendingSystemPromptAppend.delete(runId);
    this.pendingNudge.delete(runId);
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
   * Injection branches (shared seam for Piece A + Piece C). After resolving the
   * base prompt + stashing systemPromptAppend, the run state is read via the
   * already-held registry (no interface widening) and composed in priority order:
   *   1. (Piece C) pending nudge → return JUST the trimmed nudge text (the
   *      resumed conversation already holds planner.md; do NOT re-send it).
   *   2. (Piece A) run.seed_idea_id set + idea body resolves → PREPEND a
   *      `# Selected idea` block to the MAIN prompt (never systemPromptAppend,
   *      which is invisible to the chat transcript).
   *   3. neither → return the base prompt verbatim (zero-behavior-change floor).
   *
   * @param runId    The workflow run ID — used to stash systemPromptAppend.
   * @param workflow The workflow row containing workflow_path.
   */
  protected async getPrompt(runId: string, workflow: WorkflowRow): Promise<string> {
    if (!this.promptReader) {
      throw new Error('RunExecutor.getPrompt: no WorkflowPromptReaderLike injected — pass a promptReader to the constructor or override getPrompt in a subclass');
    }
    if (!workflow.workflow_path) {
      throw new Error(`RunExecutor.getPrompt: workflow_path is null for workflowId=${workflow.id}`);
    }
    const { prompt, systemPromptAppend } = this.promptReader.read(workflow.workflow_path);
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

    const parts: string[] = [];
    if (title !== '') parts.push(`## ${title}`);
    if (summary !== '') parts.push(summary);
    if (body !== '') parts.push(body);
    return parts.join('\n\n');
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
   * Returns optional overrides for ClaudeSpawnerOptions (e.g. preToolUseHook).
   * Default returns preToolUseHook from buildPreToolUseHook when permission_mode
   * is set on the workflow; otherwise returns an empty object.
   *
   * @param runId     The workflow run ID.
   * @param _run      The workflow_runs row.
   * @param workflow  The workflow row.
   */
  protected async buildOptionsOverrides(
    runId: string,
    _run: WorkflowRunRow,
    workflow: WorkflowRow,
  ): Promise<Partial<ClaudeSpawnerOptions>> {
    const systemPromptAppend = this.pendingSystemPromptAppend.get(runId) || undefined;
    const overrides: Partial<ClaudeSpawnerOptions> = { systemPromptAppend };

    if (workflow.permission_mode) {
      const hook = buildPreToolUseHook(workflow.permission_mode as PermissionMode, runId, this.logger);
      if (hook !== undefined) {
        overrides.preToolUseHook = hook;
      }
    }

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
