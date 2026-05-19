/**
 * RunExecutor — translates a runId into the synthetic panelId/sessionId shape
 * that ClaudeCodeManager.spawnCliProcess() expects, and exposes four protected
 * extension hooks for sibling tasks (TASK-641–644) to override.
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

import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { LoggerLike } from './types';
import type { WorkflowRow, WorkflowRunRow } from '../../../shared/types/workflows';
import type { PermissionMode } from '../../../shared/types/workflows';
import { buildPreToolUseHook } from './permissionModeMapper';
import type { RunEventBridge } from './runEventBridge';

// ---------------------------------------------------------------------------
// Narrow interfaces (no concrete imports)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// RunExecutor
// ---------------------------------------------------------------------------

/**
 * Execution phase labels used by onLifecycleTransition.
 * Covers the full workflow_runs lifecycle.
 */
export type ExecutionPhase = 'pre_spawn' | 'post_spawn' | 'sdk_initialized' | 'completed' | 'failed' | 'canceled';

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

  constructor(
    protected readonly spawner: ClaudeSpawnerLike,
    private readonly registry: WorkflowRegistryLike,
    protected readonly logger: LoggerLike,
  ) {}

  /**
   * Execute a workflow run by runId.
   *
   * 1. Load the workflow_runs row (throws if missing).
   * 2. Load the workflow row (throws if missing).
   * 3. Derive synthetic panelId and sessionId from runId.
   * 4. Call getPrompt() to retrieve the prompt (default: throws NOT_IMPLEMENTED).
   * 5. Call buildOptionsOverrides() to get optional spawn-option overrides.
   * 6. Call bridgeEvents() to wire event forwarding; store returned handle.
   * 7. Call onLifecycleTransition(runId, 'pre_spawn').
   * 8. Call spawnCliProcess() on the ClaudeSpawnerLike collaborator.
   * 9. Call onLifecycleTransition(runId, 'post_spawn').
   * 10. Call teardownRun(runId) in a finally block to dispose the bridge.
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

    // Deterministic synthetic identifiers — panelId and sessionId are derived
    // from runId so ClaudeCodeManager can track them without a separate lookup.
    const panelId = `run-${runId}`;
    const sessionId = `run-${runId}`;

    // Store the panelId so cancel() can look it up.
    this.activePanelIds.set(runId, panelId);

    try {
      const prompt = await this.getPrompt(workflow);
      const overrides = await this.buildOptionsOverrides(runId, run, workflow);

      // Wire event forwarding BEFORE spawning so no SDK-initialization events
      // are lost — bridgeEvents registers listeners, spawnCliProcess starts the
      // iterator that emits them.
      const bridgeHandle = await this.bridgeEvents(runId, panelId);
      if (bridgeHandle) {
        this.bridges.set(runId, bridgeHandle);
      }

      await this.onLifecycleTransition(runId, 'pre_spawn');

      this.logger.info('[RunExecutor] spawning Claude CLI process', {
        runId,
        panelId,
        worktreePath: run.worktree_path,
      });

      await this.spawner.spawnCliProcess({
        panelId,
        sessionId,
        worktreePath: run.worktree_path,
        prompt,
        ...overrides,
      });

      await this.onLifecycleTransition(runId, 'post_spawn');
    } finally {
      this.teardownRun(runId);
    }
  }

  /**
   * Cancel all in-flight runs managed by this executor.
   *
   * For each active run:
   *   1. Look up the panelId. If not present, no-op (idempotent).
   *   2. Abort the SDK run via spawner.abort(panelId).
   *   3. Fire teardownRun to dispose the bridge and clean up state.
   *   4. Fire onLifecycleTransition(runId, 'canceled').
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
      this.teardownRun(runId);
      await this.onLifecycleTransition(runId, 'canceled');
    }
  }

  /**
   * Dispose the bridge handle and remove the panelId for the given runId.
   * Safe to call multiple times (idempotent).
   */
  private teardownRun(runId: string): void {
    const bridge = this.bridges.get(runId);
    if (bridge) {
      bridge.dispose();
      this.bridges.delete(runId);
    }
    this.activePanelIds.delete(runId);
  }

  // ---------------------------------------------------------------------------
  // Protected extension hooks — overridden by TASK-641/642/643/644
  // ---------------------------------------------------------------------------

  /**
   * Returns the prompt string to pass to ClaudeCodeManager.spawnCliProcess.
   *
   * Default implementation throws NOT_IMPLEMENTED so TASK-641 has an obvious
   * wiring target. Override in a subclass to provide the real prompt.
   */
  protected async getPrompt(_workflow: WorkflowRow): Promise<string> {
    throw new Error('NOT_IMPLEMENTED: getPrompt — TASK-641 must override');
  }

  /**
   * Wire event forwarding between the SDK pipeline and the renderer.
   * Default is a no-op until TASK-642 lands.
   *
   * Returns a RunEventBridge handle (or void) that is stored per-run and
   * disposed when the run terminates or is canceled.
   *
   * @param _runId   The workflow run ID.
   * @param _panelId The synthetic panel ID used by ClaudeCodeManager.
   */
  protected async bridgeEvents(_runId: string, _panelId: string): Promise<RunEventBridge | void> {
    // no-op until TASK-642
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
    if (workflow.permission_mode) {
      const hook = buildPreToolUseHook(workflow.permission_mode as PermissionMode, runId, this.logger);
      if (hook !== undefined) {
        return { preToolUseHook: hook };
      }
    }
    return {};
  }

  /**
   * Called at key lifecycle transition points.
   * Default is a no-op until TASK-644 lands.
   *
   * @param _runId  The workflow run ID.
   * @param _phase  The lifecycle phase label.
   */
  protected async onLifecycleTransition(_runId: string, _phase: ExecutionPhase): Promise<void> {
    // no-op until TASK-644
  }
}
