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
 *
 * permissionMode type-axis note: WorkflowRow stores 'default' | 'acceptEdits' |
 * 'dontAsk', while ClaudeSpawnOptions.permissionMode is 'approve' | 'ignore'.
 * buildOptionsOverrides() leaves permissionMode undefined until TASK-643 lands.
 */

import type { LoggerLike } from './types';
import type { WorkflowRow, WorkflowRunRow } from '../../../shared/types/workflows';

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
  permissionMode?: 'approve' | 'ignore';
}

/**
 * Narrow interface for spawning a Claude CLI process.
 * Matches the ClaudeManagerLike pattern in stuckDetector.ts:36.
 */
export interface ClaudeSpawnerLike {
  spawnCliProcess(options: ClaudeSpawnerOptions): Promise<void>;
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
 * Extended by TASK-644 as more lifecycle phases are introduced.
 */
export type ExecutionPhase = 'spawning' | 'spawned' | 'error';

export class RunExecutor {
  constructor(
    private readonly spawner: ClaudeSpawnerLike,
    private readonly registry: WorkflowRegistryLike,
    private readonly logger: LoggerLike,
  ) {}

  /**
   * Execute a workflow run by runId.
   *
   * 1. Load the workflow_runs row (throws if missing).
   * 2. Load the workflow row (throws if missing).
   * 3. Derive synthetic panelId and sessionId from runId.
   * 4. Call getPrompt() to retrieve the prompt (default: throws NOT_IMPLEMENTED).
   * 5. Call buildOptionsOverrides() to get optional spawn-option overrides.
   * 6. Call bridgeEvents() to wire event forwarding (default: no-op).
   * 7. Call spawnCliProcess() on the ClaudeSpawnerLike collaborator.
   * 8. Call onLifecycleTransition() for lifecycle signalling (default: no-op).
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

    const prompt = await this.getPrompt(workflow);
    const overrides = await this.buildOptionsOverrides(runId, run, workflow);

    // Wire event forwarding BEFORE spawning so no SDK-initialization events
    // are lost — bridgeEvents registers listeners, spawnCliProcess starts the
    // iterator that emits them.
    await this.bridgeEvents(runId, panelId);

    await this.onLifecycleTransition(runId, 'spawning');

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

    await this.onLifecycleTransition(runId, 'spawned');
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
   * @param _runId   The workflow run ID.
   * @param _panelId The synthetic panel ID used by ClaudeCodeManager.
   */
  protected async bridgeEvents(_runId: string, _panelId: string): Promise<void> {
    // no-op until TASK-642
  }

  /**
   * Returns optional overrides for ClaudeSpawnerOptions (e.g. permissionMode).
   * Default returns an empty object — permissionMode mapping is owned by TASK-643.
   *
   * @param _runId    The workflow run ID.
   * @param _run      The workflow_runs row.
   * @param _workflow The workflow row.
   */
  protected buildOptionsOverrides(
    _runId: string,
    _run: WorkflowRunRow,
    _workflow: WorkflowRow,
  ): Partial<ClaudeSpawnerOptions> {
    return {};
  }

  /**
   * Called at key lifecycle transition points (spawning, spawned, error).
   * Default is a no-op until TASK-644 lands.
   *
   * @param _runId  The workflow run ID.
   * @param _phase  The lifecycle phase label.
   */
  protected async onLifecycleTransition(_runId: string, _phase: ExecutionPhase): Promise<void> {
    // no-op until TASK-644
  }
}
