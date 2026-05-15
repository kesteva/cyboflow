/**
 * McpConfigWriter — writes a per-run .mcp.json into the worktree before Claude is spawned.
 *
 * The generated file declares exactly one MCP server, `cyboflow-permissions`, whose
 * `command` + `args` invoke the Cyboflow permission bridge subprocess with the
 * run-scoped CYBOFLOW_RUN_ID and CYBOFLOW_ORCH_SOCKET env vars.
 *
 * The actual bridge implementation lives in epic 7 (approval-router-and-permission-fix).
 * This module is only responsible for writing the JSON; the bridge script path is
 * injected by the caller (RunLauncher) so production and test can differ.
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron'
 * or any concrete service in main/src/services/*.
 */
import * as fs from 'fs/promises';
import * as path from 'path';

export interface McpConfigWriteOptions {
  /** The workflow run ID, written into args and env so the bridge can self-identify. */
  runId: string;
  /** Absolute path to the worktree root where `.mcp.json` will be written. */
  worktreePath: string;
  /** Unix socket path the bridge connects to in order to reach the orchestrator. */
  orchSocketPath: string;
  /** Resolved absolute path to the bundled cyboflowPermissionBridge.js script. */
  bridgeScriptPath: string;
  /** Resolved path to the node executable (e.g. /usr/local/bin/node). */
  nodeExecutablePath: string;
}

export class McpConfigWriter {
  /**
   * Write a per-run `.mcp.json` at `<worktreePath>/.mcp.json`.
   *
   * The file declares a single MCP server `cyboflow-permissions` whose subprocess
   * is invoked as:
   *   <nodeExecutablePath> <bridgeScriptPath> <runId> <orchSocketPath>
   *
   * Both argv and env carry the run-scoped identifiers (belt-and-suspenders):
   *   - argv: crystal's existing bridge reads ORCH_SOCKET from argv[3]
   *   - env:  epic 7's cyboflowPermissionBridge reads CYBOFLOW_RUN_ID and
   *           CYBOFLOW_ORCH_SOCKET from env as a forward-compat hook
   *
   * Returns the absolute path to the written file.
   */
  async writeForRun(opts: McpConfigWriteOptions): Promise<string> {
    const configPath = path.join(opts.worktreePath, '.mcp.json');

    const config = {
      mcpServers: {
        'cyboflow-permissions': {
          command: opts.nodeExecutablePath,
          args: [opts.bridgeScriptPath, opts.runId, opts.orchSocketPath],
          env: {
            CYBOFLOW_RUN_ID: opts.runId,
            CYBOFLOW_ORCH_SOCKET: opts.orchSocketPath,
          },
        },
      },
    };

    // Ensure the worktree directory exists (it will in production, but tests
    // may call writeForRun with a temp dir that hasn't been fully populated).
    await fs.mkdir(opts.worktreePath, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');

    return configPath;
  }
}
