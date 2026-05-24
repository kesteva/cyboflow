/**
 * OrchestratorHealth — exposes the MCP server's runtime status for the
 * health-check IPC channel and the tRPC cyboflow.health.mcpServer procedure.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 *
 * See also: main/src/orchestrator/trpc/routers/health.ts (tRPC procedure).
 */
import type { McpServerHealth } from '../../../shared/types/mcpHealth';

// Re-export so consumers that imported McpServerHealth from this module
// continue to compile without update.
export type { McpServerHealth } from '../../../shared/types/mcpHealth';

/**
 * Narrow observable interface required by OrchestratorHealth.
 *
 * Accepts the concrete McpServerLifecycle (structural match) as well as any
 * stub or sentinel that satisfies these two methods — useful at boot when the
 * real lifecycle is not yet wired (e.g. epic 7 permissionIpcServer pending).
 */
export interface McpLifecycleReadable {
  getStatus(): 'starting' | 'running' | 'failed' | 'stopped';
  getRestartAttempts(): number;
}

/**
 * Aggregates runtime health data for the cyboflow orchestrator subsystem.
 *
 * Usage (in main/src/index.ts):
 * ```ts
 * const health = new OrchestratorHealth(mcpLifecycle);
 * setHealthProvider(health); // wires the tRPC cyboflow.health.mcpServer procedure
 * ```
 *
 * The constructor accepts any McpLifecycleReadable, so a sentinel can be
 * passed at boot before the real McpServerLifecycle is available (epic 7).
 */
export class OrchestratorHealth {
  private lastMcpError: string | undefined;

  /**
   * @param mcpLifecycle  Any object satisfying McpLifecycleReadable.
   *                      Typically the real McpServerLifecycle singleton;
   *                      a sentinel stub is acceptable at boot.
   */
  constructor(private readonly mcpLifecycle: McpLifecycleReadable) {}

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
