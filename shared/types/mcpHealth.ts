/**
 * McpServerHealth — cross-package type for the MCP server health snapshot.
 *
 * Shared between:
 *   - main/src/orchestrator/health.ts (IPC handler output)
 *   - main/src/ipc/cyboflow.ts (fallback constant type annotation)
 *   - frontend/src/hooks/useMcpHealth.ts (hook state type)
 *   - frontend/src/types/electron.d.ts (ElectronAPI typings)
 *
 * Canonical location: shared/types/mcpHealth.ts per CODE-PATTERNS.md §cross-package types.
 */
export interface McpServerHealth {
  status: 'starting' | 'running' | 'failed' | 'stopped';
  lastError?: string;
  restartAttempts: number;
}

/**
 * UI-side three-value collapse of McpServerHealth.status.
 * Maps:
 *   'running'  → 'healthy'
 *   'starting' → 'starting'
 *   'failed' | 'stopped' → 'error'
 *
 * Canonical UI status type — used by mcpHealthStore and any UI consumer.
 * Do NOT duplicate this union in individual stores or hooks.
 */
export type McpHealthUiStatus = 'healthy' | 'starting' | 'error';

/**
 * Safe fallback snapshot returned before the OrchestratorHealth singleton is
 * injected. Both the IPC handler (main/src/ipc/cyboflow.ts) and the tRPC
 * procedure (main/src/orchestrator/trpc/routers/health.ts) use this constant
 * so their pre-injection behaviour is identical and defined in one place.
 */
export const HEALTH_STARTING: Readonly<McpServerHealth> = Object.freeze({
  status: 'starting',
  restartAttempts: 0,
});

/**
 * Canonical raw-status → UI-status mapping. Single source of truth — both
 * mcpHealthStore and useMcpHealth (and any future surface) must use this.
 */
export function toUiStatus(raw: McpServerHealth['status']): McpHealthUiStatus {
  switch (raw) {
    case 'running':  return 'healthy';
    case 'starting': return 'starting';
    case 'failed':
    case 'stopped':  return 'error';
  }
}
