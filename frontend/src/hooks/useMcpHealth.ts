import { useEffect, useState } from 'react';

export interface McpHealth {
  status: 'starting' | 'running' | 'failed' | 'stopped';
  lastError?: string;
  restartAttempts: number;
}

/**
 * Polls the MCP server health every 5 seconds via the cyboflow:mcp-health
 * IPC channel.
 *
 * Initial state: { status: 'starting', restartAttempts: 0 }
 * This ensures the Sidebar dot starts yellow (not red) before the first
 * poll resolves, and stays yellow if the IPC channel is not yet available
 * (orchestrator not yet ready).
 *
 * The hook is safe to mount before the main process has wired the health
 * singleton — errors from invoke() are swallowed and the default 'starting'
 * state is preserved.
 */
export function useMcpHealth(): McpHealth {
  const [health, setHealth] = useState<McpHealth>({ status: 'starting', restartAttempts: 0 });

  useEffect(() => {
    let alive = true;

    const tick = async () => {
      try {
        const res = await window.electronAPI.invoke('cyboflow:mcp-health') as McpHealth | null;
        if (alive && res) {
          setHealth(res);
        }
      } catch (_e) {
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
