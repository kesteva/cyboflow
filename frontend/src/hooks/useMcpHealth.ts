import { useEffect, useState } from 'react';
import type { McpServerHealth } from '../../../shared/types/mcpHealth';
import { getMcpHealth } from '../utils/cyboflowApi';

// Re-export so existing callers (`import type { McpHealth } from '../hooks/useMcpHealth'`)
// continue to compile without update.
export type { McpServerHealth as McpHealth } from '../../../shared/types/mcpHealth';

/**
 * Polls the MCP server health every 5 seconds via the cyboflow:mcp-health
 * IPC channel (routed through the typed cyboflowApi wrapper).
 *
 * Initial state: { status: 'starting', restartAttempts: 0 }
 * This ensures the Sidebar dot starts yellow (not red) before the first
 * poll resolves, and stays yellow if the IPC channel is not yet available
 * (orchestrator not yet ready).
 *
 * The hook is safe to mount before the main process has wired the health
 * singleton — errors from getMcpHealth() are swallowed and the default
 * 'starting' state is preserved.
 */
export function useMcpHealth(): McpServerHealth {
  const [health, setHealth] = useState<McpServerHealth>({ status: 'starting', restartAttempts: 0 });

  useEffect(() => {
    let alive = true;

    const tick = async () => {
      try {
        const res = await getMcpHealth();
        if (alive && res) {
          setHealth(res);
        }
      } catch {
        // Orchestrator not ready yet — stay 'starting'
      }
    };

    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return health;
}
