/**
 * cyboflow.plugins sub-router — READ-ONLY catalogue of installed Claude Code
 * plugins (`~/.claude/plugins/installed_plugins.json`).
 *
 * No DB / registry / chokepoint — a pure disk read adapted to `PluginEntry[]`.
 * One plugin id can have multiple install records (per scope / project); each
 * record yields its own `PluginEntry`. A missing/malformed file yields [].
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*.
 */
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { router, protectedProcedure } from '../trpc';
import type { PluginEntry } from '../../../../../shared/types/integrations';

/** Parse installed_plugins.json (`{ version, plugins: { "<id>": [record…] } }`). */
export function readPluginEntries(): PluginEntry[] {
  const file = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const plugins = (parsed as Record<string, unknown>).plugins;
  if (typeof plugins !== 'object' || plugins === null) return [];

  const out: PluginEntry[] = [];
  for (const [id, records] of Object.entries(plugins as Record<string, unknown>)) {
    if (!Array.isArray(records)) continue;
    const atIdx = id.lastIndexOf('@');
    const name = atIdx > 0 ? id.slice(0, atIdx) : id;
    const marketplace = atIdx > 0 ? id.slice(atIdx + 1) : '';
    for (const rec of records) {
      if (typeof rec !== 'object' || rec === null) continue;
      const r = rec as Record<string, unknown>;
      out.push({
        id,
        name,
        marketplace,
        scope: typeof r.scope === 'string' ? r.scope : 'user',
        version: typeof r.version === 'string' ? r.version : 'unknown',
        lastUpdated: typeof r.lastUpdated === 'string' ? r.lastUpdated : null,
        projectPath: typeof r.projectPath === 'string' ? r.projectPath : null,
      });
    }
  }
  return out;
}

export const pluginsRouter = router({
  /** List every installed plugin record (one per scope/project). Read-only. */
  list: protectedProcedure.query(async (): Promise<PluginEntry[]> => readPluginEntries()),
});
