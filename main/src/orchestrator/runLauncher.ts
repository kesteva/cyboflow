/**
 * RunLauncher — orchestrates the launch sequence for a single workflow run.
 *
 * Responsibilities:
 *   1. Ensure `.cyboflow/worktrees/` is in the project's `.gitignore`
 *   2. Create a new `workflow_runs` row via WorkflowRegistry.createRun
 *   3. Create a deterministic worktree via WorktreeManager.createDeterministicWorktree
 *   4. UPDATE the `workflow_runs` row with worktree_path, branch_name, status='starting'
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron'
 * or any concrete service in main/src/services/*.  All collaborators are
 * injected via the constructor.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import type { WorkflowRegistry } from './workflowRegistry';
import type { WorktreeManager } from '../services/worktreeManager';
import type { DatabaseLike, LoggerLike } from './types';
import type { PermissionMode } from '../../../shared/types/workflows';
import type { McpConfigWriter } from './mcpConfigWriter';

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

export class RunLauncher {
  constructor(
    private readonly db: DatabaseLike,
    private readonly workflowRegistry: WorkflowRegistry,
    private readonly worktreeManager: WorktreeManager,
    private readonly logger: LoggerLike,
    private readonly mcpConfigWriter?: McpConfigWriter,
    private readonly orchSocketProvider?: OrchSocketProvider,
    private readonly bridgeScriptResolver?: BridgeScriptResolver,
    private readonly nodeResolver?: NodeResolver,
  ) {}

  /**
   * Launch a workflow run:
   *   1. ensureGitignoreEntry — idempotent; adds `.cyboflow/worktrees/` if absent
   *   2. createRun — inserts workflow_runs row (status='queued')
   *   3. createDeterministicWorktree — creates the git worktree + branch
   *   4. UPDATE workflow_runs — sets worktree_path, branch_name, status='starting'
   *
   * Returns the runId, worktreePath, branchName, and snapshotted permissionMode.
   */
  async launch(
    workflowId: string,
    projectPath: string,
  ): Promise<{ runId: string; worktreePath: string; branchName: string; permissionMode: PermissionMode }> {
    await this.ensureGitignoreEntry(projectPath);

    const workflow = this.workflowRegistry.getById(workflowId);
    if (!workflow) throw new Error(`RunLauncher.launch: workflow ${workflowId} not found`);

    const { runId, permissionMode } = this.workflowRegistry.createRun(workflowId);

    const { worktreePath, branchName } = await this.worktreeManager.createDeterministicWorktree(
      projectPath,
      workflow.name,
      runId,
    );

    // Write the per-run .mcp.json into the worktree so Claude can discover
    // the cyboflow-permissions bridge.  Only executed when all four collaborators
    // are injected (they are optional to preserve backward-compat with existing
    // tests and call-sites that pre-date this task).
    if (
      this.mcpConfigWriter &&
      this.orchSocketProvider &&
      this.bridgeScriptResolver &&
      this.nodeResolver
    ) {
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

    this.logger.info('RunLauncher: run started', {
      runId,
      workflowId,
      worktreePath,
      branchName,
    });

    return { runId, worktreePath, branchName, permissionMode };
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
