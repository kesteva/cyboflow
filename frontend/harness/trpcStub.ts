/**
 * Harness-only stub for `src/trpc/client` — the smoke page has no Electron
 * preload/electronTRPC, so the ONE tRPC surface the inspector touches
 * (mcps.list, via useMcpOptions) resolves from a fixture. The 'cyboflow'
 * entry is deliberately present: the real hook must FILTER it out
 * (single-writer invariant), so its absence from the rendered MCP chips is
 * part of the smoke.
 */
import type { McpEntry } from '../../shared/types/integrations';

const MCPS: McpEntry[] = [
  { name: 'filesystem', transport: 'stdio', url: null, command: 'npx', args: [], scope: 'global' },
  { name: 'git', transport: 'stdio', url: null, command: 'npx', args: [], scope: 'global' },
  { name: 'context7', transport: 'http', url: 'https://ctx7.example', command: null, args: [], scope: 'global' },
  { name: 'cyboflow', transport: 'stdio', url: null, command: 'node', args: [], scope: 'global' },
];

export const trpc = {
  cyboflow: {
    mcps: {
      list: {
        query: async (): Promise<McpEntry[]> => MCPS,
      },
    },
  },
};
