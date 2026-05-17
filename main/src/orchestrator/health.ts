/**
 * OrchestratorHealth — exposes the MCP server's runtime status for the
 * health-check IPC channel and the tRPC cyboflow.health.mcpServer procedure.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 *
 * See also: main/src/orchestrator/trpc/routers/health.ts (tRPC procedure).
 */
import type { McpServerLifecycle } from './mcpServer/mcpServerLifecycle';
import type { McpServerHealth } from '../../../shared/types/mcpHealth';

// Re-export so consumers that imported McpServerHealth from this module
// continue to compile without update.
export type { McpServerHealth } from '../../../shared/types/mcpHealth';

/**
 * Aggregates runtime health data for the cyboflow orchestrator subsystem.
 *
 * Usage (in main/src/ipc/cyboflow.ts):
 * ```ts
 * const health = new OrchestratorHealth(mcpLifecycle);
 * ipcMain.handle('cyboflow:mcp-health', () => health.getMcpServerStatus());
 * ```
 *
 * WARNING: The McpServerLifecycle default state is 'stopped', which is normally
 * never observed through a health snapshot in production. Either call
 * mcpLifecycle.start() before constructing OrchestratorHealth, or translate
 * any 'stopped' status → 'starting' until the lifecycle has been started at
 * least once, so the frontend dot stays yellow rather than showing an
 * unexpected red state at boot.
 */
export class OrchestratorHealth {
  private lastMcpError: string | undefined;

  /**
   * @param mcpLifecycle  The singleton MCP server lifecycle manager.
   *                      Injected so the health surface has no knowledge of
   *                      spawn details; it merely reads observable state.
   */
  constructor(private readonly mcpLifecycle: McpServerLifecycle) {}

  /**
   * Record an MCP-server-level error string.
   *
   * Call this from orchestrator catch blocks that handle lifecycle errors
   * (e.g. after mcpLifecycle.start() throws or status moves to 'failed').
   * The error string surfaces in the Sidebar tooltip so the user can read it
   * without opening DevTools.
   */
  setMcpError(err: string): void {
    this.lastMcpError = err;
  }

  /**
   * Returns a point-in-time snapshot of the MCP server's health.
   *
   * The status field is read directly from the lifecycle's state machine;
   * the lastError is the most recent error string captured via setMcpError().
   * restartAttempts reflects how many automatic restarts have been attempted
   * since the last manual start() call.
   */
  getMcpServerStatus(): McpServerHealth {
    return {
      status: this.mcpLifecycle.getStatus(),
      lastError: this.lastMcpError,
      restartAttempts: this.mcpLifecycle.getRestartAttempts(),
    };
  }
}
