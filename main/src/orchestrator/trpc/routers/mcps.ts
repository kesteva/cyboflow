/**
 * cyboflow.mcps sub-router — READ-ONLY catalogue of MCP servers configured in
 * the Claude Code CLI (`~/.claude.json` `mcpServers`, global + per-project).
 *
 * No DB / registry / chokepoint — a pure disk read adapted to `McpEntry[]`. A
 * missing or malformed config yields an empty list (never throws), so the
 * gallery section renders an empty-state rather than erroring.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*. (node builtins fs/os/path are permitted — used across
 * this subtree, e.g. workflowRegistry.ts / permissionRules.ts.)
 */
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { router, protectedProcedure } from '../trpc';
import type { McpEntry } from '../../../../../shared/types/integrations';

/** Adapt one raw `mcpServers` value into an `McpEntry`, or null when unusable. */
function adaptServer(name: string, def: unknown, scope: string): McpEntry | null {
  if (typeof def !== 'object' || def === null) return null;
  const d = def as Record<string, unknown>;
  const type = typeof d.type === 'string' ? d.type : 'stdio';
  const transport: McpEntry['transport'] =
    type === 'http' ? 'http' : type === 'sse' ? 'sse' : 'stdio';
  return {
    name,
    transport,
    url: typeof d.url === 'string' ? d.url : null,
    command: typeof d.command === 'string' ? d.command : null,
    args: Array.isArray(d.args) ? d.args.filter((a): a is string => typeof a === 'string') : [],
    scope,
  };
}

/** Parse ~/.claude.json's global + per-project `mcpServers` maps into McpEntry[]. */
export function readMcpEntries(): McpEntry[] {
  const file = path.join(os.homedir(), '.claude.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return []; // No CLI config on disk / malformed — empty catalogue.
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const root = parsed as Record<string, unknown>;
  const out: McpEntry[] = [];

  const globalMap = root.mcpServers;
  if (typeof globalMap === 'object' && globalMap !== null) {
    for (const [name, def] of Object.entries(globalMap)) {
      const e = adaptServer(name, def, 'global');
      if (e !== null) out.push(e);
    }
  }

  const projects = root.projects;
  if (typeof projects === 'object' && projects !== null) {
    for (const [projPath, projDef] of Object.entries(projects)) {
      if (typeof projDef !== 'object' || projDef === null) continue;
      const pm = (projDef as Record<string, unknown>).mcpServers;
      if (typeof pm !== 'object' || pm === null) continue;
      for (const [name, def] of Object.entries(pm)) {
        const e = adaptServer(name, def, projPath);
        if (e !== null) out.push(e);
      }
    }
  }
  return out;
}

export const mcpsRouter = router({
  /** List every MCP server configured in the CLI (global + per-project). Read-only. */
  list: protectedProcedure.query(async (): Promise<McpEntry[]> => readMcpEntries()),
});
