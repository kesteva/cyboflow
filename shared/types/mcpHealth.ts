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
