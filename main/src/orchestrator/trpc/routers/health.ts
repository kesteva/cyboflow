/**
 * tRPC health sub-router — exposes `cyboflow.health.mcpServer` as a query
 * procedure, merged into the root cyboflow router via
 * main/src/orchestrator/trpc/router.ts.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 *
 * Pattern: the procedure accesses the OrchestratorHealth instance via
 * a module-level setter so the health singleton can be injected at boot
 * without coupling this module to the full dependency graph.
 */
import { router, publicProcedure } from '../trpc';
import type { OrchestratorHealth } from '../../health';
import { HEALTH_STARTING } from '../../../../../shared/types/mcpHealth';

// ---------------------------------------------------------------------------
// Module-level injectable singleton (set once at app boot via setHealthProvider)
// ---------------------------------------------------------------------------

let _health: OrchestratorHealth | null = null;

/**
 * Inject the OrchestratorHealth instance.
 * Call this from the IPC wiring layer (main/src/ipc/cyboflow.ts or index.ts)
 * before the tRPC server starts handling requests.
 */
export function setHealthProvider(health: OrchestratorHealth): void {
  _health = health;
}

// ---------------------------------------------------------------------------
// health sub-router
// ---------------------------------------------------------------------------

export const healthRouter = router({
  /**
   * cyboflow.health.mcpServer
   *
   * Returns a point-in-time snapshot of the MCP server health.
   * Falls back to { status: 'starting', restartAttempts: 0 } when the health
   * provider has not been injected yet (safe during early boot).
   */
  mcpServer: publicProcedure.query(() => {
    if (_health === null) {
      return HEALTH_STARTING;
    }
    return _health.getMcpServerStatus();
  }),
});
