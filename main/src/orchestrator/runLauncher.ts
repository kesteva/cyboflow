/**
 * RunLauncher — orchestrates the launch sequence for a single workflow run.
 *
 * Responsibilities:
 *   1. Ensure `.cyboflow/worktrees/` is in the project's `.gitignore`
 *   2. Create a new `workflow_runs` row via WorkflowRegistry.createRun
 *   3. Create a deterministic worktree via WorktreeManager.createDeterministicWorktree
 *   4. UPDATE the `workflow_runs` row with worktree_path, branch_name, status='starting'
 *   5. (Optional) Enqueue RunExecutor.execute(runId) via RunQueueRegistry after publish
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron'
 * or any concrete service in main/src/services/*.  All collaborators are
 * injected via the constructor. The new optional 10th (runExecutor) and 11th
 * (runQueueRegistry) constructor parameters preserve backward compatibility
 * with all existing call sites that omit them.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import type { WorkflowRegistry } from './workflowRegistry';
import type { WorktreeManager } from '../services/worktreeManager';
import type { DatabaseLike, LoggerLike } from './types';
import type { PermissionMode } from '../../../shared/types/workflows';
import type { CliSubstrate } from '../../../shared/types/substrate';
import { resolveWorkflowDefinition } from '../../../shared/types/workflows';
import type { StreamEnvelope } from '../../../shared/types/claudeStream';
import type { McpConfigWriter } from './mcpConfigWriter';
import type { RunExecutor } from './runExecutor';
import type { RunQueueRegistry } from './RunQueueRegistry';
import type { TaskChange } from './taskChangeRouter';

/**
 * Provides the Unix socket path that the orchestrator IPC server listens on.
 * In production, this is the real `permissionIpcServer.getSocketPath()`.
 * In tests, a stub returns a canned string.
 */
export interface OrchSocketProvider {
  getSocketPath(): string;
}

/**
 * Resolves the absolute path to the bundled cyboflowPermissionBridge.js.
 * In production, this handles ASAR extraction and dev vs packaged build differences.
 * In tests, a stub returns a canned path.
 */
export interface BridgeScriptResolver {
  getScriptPath(): string;
}

/**
 * Resolves the path to the node executable.
 * In production, delegates to findExecutableInPath('node') with a fallback ladder.
 * In tests, a stub returns a canned path.
 */
export interface NodeResolver {
  getNodePath(): Promise<string>;
}

/**
 * Decouples RunLauncher from the Electron layer by accepting a plain publisher
 * interface instead of importing BrowserWindow directly.
 *
 * The concrete implementation lives in main/src/index.ts (initializeServices),
 * which is the only place that calls win.webContents.send for cyboflow stream
 * events.
 * Keeping this interface here preserves the standalone-typecheck invariant:
 * no electron imports inside main/src/orchestrator/.
 */
export interface StreamEventPublisher {
  publish(runId: string, event: StreamEnvelope): void;
}

/**
 * Narrow slice of TaskChangeRouter needed to wire in-process stage derivation
 * at launch. Keeping it as an injected interface (rather than reaching for
 * `TaskChangeRouter.getInstance()` directly) preserves the standalone-typecheck
 * invariant and the constructor-injection test ergonomics used everywhere else
 * in this module. The concrete TaskChangeRouter singleton satisfies this shape
 * structurally; the boot wiring in main/src/index.ts passes it in.
 *
 * Both task writes (entry-stage capture via applyChange, derived execution
 * stage via recomputeTaskExecutionStage) route through the chokepoint — this
 * file never UPDATEs the `tasks` table directly. Writes to `workflow_runs`
 * (task_id + triage columns) are NOT task-state writes and are done inline.
 */
export interface TaskStageDeriverLike {
  applyChange(
    projectId: number,
    change: TaskChange,
  ): Promise<{ taskId: string; event: { id: number; seq: number } }>;
  recomputeTaskExecutionStage(taskId: string): Promise<void>;
}

export class RunLauncher {
  constructor(
    private readonly db: DatabaseLike,
    private readonly workflowRegistry: WorkflowRegistry,
    private readonly worktreeManager: WorktreeManager,
    private readonly logger: LoggerLike,
    private readonly mcpConfigWriter: McpConfigWriter,
    private readonly orchSocketProvider: OrchSocketProvider,
    private readonly bridgeScriptResolver: BridgeScriptResolver,
    private readonly nodeResolver: NodeResolver,
    private readonly publisher?: StreamEventPublisher,
    private readonly runExecutor?: RunExecutor,
    private readonly runQueueRegistry?: RunQueueRegistry,
    /**
     * Optional native-task stage deriver (migration 014). When injected AND a
     * launch is given a `taskId`, the launcher records the run->task link,
     * captures the task's planning entry stage on first execution, and recomputes
     * the task's derived execution stage (-> In development). When absent (legacy
     * call sites, tests that predate native tasks, or a run launched with no task),
     * task derivation is silently skipped — backward-compatible.
     */
    private readonly taskStageDeriver?: TaskStageDeriverLike,
  ) {
    // Legacy-bridge collaborators are required only when no runExecutor is
    // supplied.  Under the SDK substrate, the PreToolUse hook gates permissions
    // in-process; the MCP permission-bridge file (writeForRun) is skipped.
    if (!runExecutor) {
      if (!mcpConfigWriter) throw new Error('RunLauncher: missing required collaborator mcpConfigWriter');
      if (!orchSocketProvider) throw new Error('RunLauncher: missing required collaborator orchSocketProvider');
      if (!bridgeScriptResolver) throw new Error('RunLauncher: missing required collaborator bridgeScriptResolver');
      if (!nodeResolver) throw new Error('RunLauncher: missing required collaborator nodeResolver');
    }
  }

  /**
   * Launch a workflow run:
   *   1. ensureGitignoreEntry — idempotent; adds `.cyboflow/worktrees/` if absent
   *   2. createRun — inserts workflow_runs row (status='queued')
   *   3. createDeterministicWorktree — creates the git worktree + branch
   *   4. UPDATE workflow_runs — sets worktree_path, branch_name, status='starting'
   *   5. (When a `taskId` is supplied AND a taskStageDeriver is injected)
   *      link the run to the task, capture base_branch/base_sha/steps_snapshot_json,
   *      capture the task's planning entry stage if not yet recorded, then recompute
   *      the task's derived execution stage (-> In development).
   *
   * `taskId` (migration 014) is OPTIONAL: runs may be launched with no task
   * (ad-hoc workflow runs predate native tasks). The task-derivation block is a
   * complete no-op when `taskId` is omitted or no deriver is wired.
   *
   * Returns the runId, worktreePath, branchName, and snapshotted permissionMode.
   */
  async launch(
    workflowId: string,
    projectPath: string,
    // The user's explicit per-run CLI substrate choice (IDEA-013 / TASK-812),
    // threaded down to the S1 resolver/stamp in WorkflowRegistry.createRun as the
    // highest-precedence override. OPTIONAL — when omitted the resolver ladder
    // falls through to env + the 'sdk' floor.
    substrate?: CliSubstrate,
    taskId?: string,
  ): Promise<{ runId: string; worktreePath: string; branchName: string; permissionMode: PermissionMode }> {
    await this.ensureGitignoreEntry(projectPath);

    const workflow = this.workflowRegistry.getById(workflowId);
    if (!workflow) throw new Error(`RunLauncher.launch: workflow ${workflowId} not found`);

    const { runId, permissionMode } = this.workflowRegistry.createRun(workflowId, substrate);

    try {
      const { worktreePath, branchName } = await this.worktreeManager.createDeterministicWorktree(
        projectPath,
        workflow.name,
        runId,
      );

      // Write the per-run .mcp.json into the worktree so Claude can discover
      // the cyboflow-permissions bridge.
      // Skipped when runExecutor is wired: the SDK substrate gates permissions
      // via PreToolUse in-process; the legacy Unix-socket bridge file is dead
      // code on every SDK-driven launch.
      if (!this.runExecutor) {
        const nodeExecutablePath = await this.nodeResolver.getNodePath();
        await this.mcpConfigWriter.writeForRun({
          runId,
          worktreePath,
          orchSocketPath: this.orchSocketProvider.getSocketPath(),
          bridgeScriptPath: this.bridgeScriptResolver.getScriptPath(),
          nodeExecutablePath,
        });
      }

      this.db
        .prepare(
          'UPDATE workflow_runs SET worktree_path = ?, branch_name = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        )
        .run(worktreePath, branchName, 'starting', runId);

      // Native-task linkage + in-process stage derivation (migration 014).
      // No-op when no taskId was supplied or no deriver is wired. Wrapped in its
      // own try/catch so a task-side failure never aborts the run launch: the run
      // is already created + worktree built; the task overlay is best-effort.
      if (taskId && this.taskStageDeriver) {
        try {
          await this.linkRunToTaskAndDerive(runId, taskId, workflow, projectPath, branchName);
        } catch (taskErr) {
          this.logger.warn('RunLauncher: task stage derivation failed (run launch unaffected)', {
            runId,
            taskId,
            error: taskErr instanceof Error ? taskErr.message : String(taskErr),
          });
        }
      }

      // KEEP: synthetic run_started emission; closes a 50-500ms 'Waiting for events...'
      // gap before the first real SDK event arrives. RunExecutor is now wired (see
      // main/src/index.ts:580-589); real SDK events follow. Retained as UI-bootstrap aid.
      this.publisher?.publish(runId, {
        type: 'run_started',
        payload: { type: 'run_started', runId, worktreePath, branchName },
        timestamp: new Date().toISOString(),
      });

      // Enqueue the RunExecutor onto the per-run PQueue (fire-and-forget).
      // The void prefix and inner try/catch are load-bearing: launch() must
      // not block on the SDK run, and errors must not propagate to the caller.
      if (this.runExecutor && this.runQueueRegistry) {
        const executor = this.runExecutor;
        const queue = this.runQueueRegistry.getOrCreate(runId);
        void queue.add(async () => {
          try {
            await executor.execute(runId);
          } catch (err) {
            this.logger.error('[RunLauncher] RunExecutor.execute failed', {
              runId,
              error: err instanceof Error ? (err.stack ?? err.message) : String(err),
            });
          }
        });
      }

      this.logger.info('RunLauncher: run started', {
        runId,
        workflowId,
        worktreePath,
        branchName,
      });

      return { runId, worktreePath, branchName, permissionMode };
    } catch (err) {
      const errMsg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
      try {
        this.db
          .prepare(
            "UPDATE workflow_runs SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          )
          .run(errMsg, runId);
      } catch (dbErr) {
        this.logger.error('RunLauncher: failed to mark run as failed after launch error', {
          runId,
          originalError: errMsg,
          dbError: dbErr instanceof Error ? dbErr.message : String(dbErr),
        });
      }
      this.logger.error('RunLauncher: launch failed', { runId, workflowId, error: errMsg });
      throw err;
    }
  }

  /**
   * Link a freshly-launched run to its native task, capture the run's launch
   * snapshot (base_branch / base_sha / steps_snapshot_json), capture the task's
   * planning entry stage the FIRST time it enters execution, then recompute the
   * task's derived execution stage.
   *
   * Ordering rationale:
   *   1. Resolve base_branch + the step->agent snapshot (best-effort; failures
   *      degrade to null, never abort the launch).
   *   2. UPDATE workflow_runs with task_id + the triage columns. This is a
   *      `workflow_runs` write (NOT a `tasks` write) so it is done inline — the
   *      no-direct-`tasks`-write invariant only governs the `tasks` table.
   *   3. If the task currently sits in an ASSERTED, non-terminal planning stage
   *      and has no entry_stage_id yet, capture it via applyChange (chokepoint),
   *      so a later revert (dismiss / all-runs-terminal) restores it.
   *   4. recomputeTaskExecutionStage — the derived-stage write, also via the
   *      chokepoint. At launch the run is `starting`; the executor's pre_spawn
   *      transition advances it to `running`, at which point the executor calls
   *      recompute again to land the task on `In development`.
   */
  private async linkRunToTaskAndDerive(
    runId: string,
    taskId: string,
    workflow: { name: string; spec_json?: string | null },
    projectPath: string,
    branchName: string,
  ): Promise<void> {
    const deriver = this.taskStageDeriver;
    if (!deriver) return;

    // (1) Best-effort launch snapshot. base_sha is a future-only triage field and
    // has no public WorktreeManager accessor exposed here, so it stays null for now.
    let baseBranch: string | null = null;
    try {
      baseBranch = await this.worktreeManager.getProjectMainBranch(projectPath);
    } catch (err) {
      this.logger.warn('RunLauncher: could not resolve base branch for task triage snapshot', {
        runId,
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const stepsSnapshotJson = this.buildStepsSnapshotJson(workflow);

    // (2) workflow_runs linkage + triage columns (NOT a `tasks` write).
    this.db
      .prepare(
        `UPDATE workflow_runs
            SET task_id = ?, base_branch = ?, base_sha = ?, steps_snapshot_json = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
      )
      .run(taskId, baseBranch, null, stepsSnapshotJson, runId);

    // (3) Entry-stage capture: only when the task is in an asserted, non-terminal
    // planning stage and entry_stage_id is still null. Routed through the chokepoint.
    const stageInfo = this.db
      .prepare(
        `SELECT t.project_id AS project_id, t.stage_id AS stage_id, t.entry_stage_id AS entry_stage_id,
                s.write_policy AS write_policy, s.is_terminal AS is_terminal
           FROM tasks t
           JOIN board_stages s ON s.id = t.stage_id
          WHERE t.id = ?`,
      )
      .get(taskId) as
      | {
          project_id: number;
          stage_id: string;
          entry_stage_id: string | null;
          write_policy: 'asserted' | 'derived';
          is_terminal: number;
        }
      | undefined;

    if (
      stageInfo &&
      stageInfo.entry_stage_id === null &&
      stageInfo.write_policy === 'asserted' &&
      stageInfo.is_terminal !== 1
    ) {
      await deriver.applyChange(stageInfo.project_id, {
        actor: 'orchestrator',
        taskId,
        runId,
        kind: 'entry-stage-capture',
        fields: { entryStageId: stageInfo.stage_id },
      });
    }

    // (4) Derived execution-stage recompute (chokepoint, actor='orchestrator').
    await deriver.recomputeTaskExecutionStage(taskId);

    this.logger.info('RunLauncher: linked run to task + derived execution stage', {
      runId,
      taskId,
      baseBranch,
      branchName,
    });
  }

  /**
   * Build the frozen step->agent map persisted in workflow_runs.steps_snapshot_json.
   * Resolves the effective WorkflowDefinition (edited spec_json wins, else the
   * built-in by name) and flattens all phase steps into `{ [stepId]: agent }`.
   * Returns null when no definition resolves (custom flow with a broken spec /
   * unknown name) — the overlay reader falls back to current_step_id then 'agent'.
   */
  private buildStepsSnapshotJson(workflow: { name: string; spec_json?: string | null }): string | null {
    const definition = resolveWorkflowDefinition(workflow.name, workflow.spec_json ?? null);
    if (!definition) return null;
    const map: Record<string, string> = {};
    for (const phase of definition.phases) {
      for (const step of phase.steps) {
        map[step.id] = step.agent;
      }
    }
    return JSON.stringify(map);
  }

  /**
   * Idempotently ensure `.cyboflow/worktrees/` is present in the project's
   * `.gitignore`.  Three cases:
   *   - File missing   → create it with the single entry
   *   - Entry absent   → append the entry (preserving existing content)
   *   - Entry present  → no-op
   */
  async ensureGitignoreEntry(projectPath: string): Promise<void> {
    const gitignorePath = path.join(projectPath, '.gitignore');
    const targetLine = '.cyboflow/worktrees/';

    let content = '';
    try {
      content = await fs.readFile(gitignorePath, 'utf-8');
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') throw e;
      // .gitignore does not exist — create it with just the target line
      await fs.writeFile(gitignorePath, targetLine + '\n', 'utf-8');
      this.logger.info(`RunLauncher: created ${gitignorePath} with .cyboflow/worktrees/ entry`);
      return;
    }

    // Match the line exactly (with or without trailing slash)
    const lines = content.split(/\r?\n/);
    const present = lines.some(
      (l) => l.trim() === '.cyboflow/worktrees/' || l.trim() === '.cyboflow/worktrees',
    );
    if (present) return;

    // Append — ensure there's a newline separator before the new line
    const suffix = content.endsWith('\n') || content === '' ? '' : '\n';
    await fs.writeFile(gitignorePath, content + suffix + targetLine + '\n', 'utf-8');
    this.logger.info(`RunLauncher: appended .cyboflow/worktrees/ to ${gitignorePath}`);
  }
}
