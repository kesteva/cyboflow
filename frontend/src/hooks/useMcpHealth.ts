import { useMcpHealthStore } from '../stores/mcpHealthStore';
import type { McpServerHealth } from '../../../shared/types/mcpHealth';

// Re-export so existing callers (`import type { McpHealth } from '../hooks/useMcpHealth'`)
// continue to compile without update.
export type { McpServerHealth as McpHealth } from '../../../shared/types/mcpHealth';

/**
 * @deprecated Prefer useMcpHealthStore directly. This hook is preserved as a
 * thin adapter over the store for any remaining 4-value consumers.
 *
 * The polling loop previously living in this hook has been moved to
 * mcpHealthStore.subscribeToMcpHealth (single polling source). This hook
 * now reads from the store and maps the 3-value UI status back to a
 * McpServerHealth shape for backward-compatible consumers.
 *
 * Lossy mapping: the store collapses both 'failed' and 'stopped' → 'error'.
 * When converting back, 'error' maps to 'failed' (closest approximation).
 * If a consumer needs to distinguish 'failed' from 'stopped', use the
 * underlying IPC channel directly.
 *
 * @cyboflow-hidden Sidebar MCP indicator was removed in TASK-626. This hook
 * is kept as a deprecated adapter; it will be deleted once no production
 * importer remains.
 */
export function useMcpHealth(): McpServerHealth {
  const status = useMcpHealthStore((s) => s.status);
  const lastError = useMcpHealthStore((s) => s.lastError ?? undefined);
  // Map UI status back to a raw McpServerHealth shape. Lossy: 'error'
  // collapses to 'failed' (closest of failed/stopped — both surface a red dot).
  const rawStatus: McpServerHealth['status'] =
    status === 'healthy'  ? 'running'  :
    status === 'starting' ? 'starting' :
                            'failed';
  return { status: rawStatus, lastError, restartAttempts: 0 };
}
