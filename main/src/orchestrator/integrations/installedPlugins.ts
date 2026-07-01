/**
 * Standalone reader for the installed Claude Code plugin catalogue
 * (`~/.claude/plugins/installed_plugins.json`).
 *
 * A pure disk read consumed by BOTH the `cyboflow.plugins` tRPC router (the
 * read-only catalogue UI) AND `ClaudeCodeManager` at spawn (to build the
 * deterministic EXCLUSIVE `enabledPlugins` map — selected plugins on, every
 * other installed plugin off). Kept as a standalone leaf module (only
 * node:fs/os/path + a type import) so the low-level manager does not have to
 * import the tRPC router layer, and so `plugins.ts` keeps its standalone-
 * typecheck invariant (no 'electron' / 'better-sqlite3' / services imports).
 */
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginEntry } from '../../../../shared/types/integrations';

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

/**
 * The UNIQUE installed plugin ids (`"<name>@<marketplace>"`), deduped across
 * the per-scope / per-project install records. This is the universe of plugins
 * that could be enabled via inherited settings — the manager sets every id not
 * in the session's allow-list to `false` to make the session deterministic.
 * A missing/malformed catalogue yields [] (→ additive fallback: nothing to
 * disable, so the resolver emits only the selected `true` entries).
 */
export function readInstalledPluginIds(): string[] {
  return Array.from(new Set(readPluginEntries().map((p) => p.id)));
}

/**
 * Build the DETERMINISTIC (EXCLUSIVE) `enabledPlugins` map for a session from its
 * raw `enabled_plugins_json` allow-list and the installed plugin universe.
 *
 * Every SELECTED plugin → `true`; every OTHER installed plugin → `false`. Cyboflow
 * injects this at the `flag` precedence tier (user < project < local < flag <
 * policy), so a `false` here overrides a file-enabled `true` and the session runs
 * EXACTLY the selected set. Verified on BOTH substrates: the SDK Settings schema
 * types the value `boolean` and documents `false` = disable, and the interactive
 * `--settings` CLI was confirmed empirically to drop a plugin's contributions when
 * passed `{ id: false }` at the flag tier.
 *
 * Returns `undefined` when the allow-list is missing/empty/malformed (→ no
 * enabledPlugins key emitted; inherited plugins untouched). When `installedIds` is
 * empty it degrades to additive (only the selected `true` entries — nothing to
 * disable). A selected id absent from `installedIds` is still force-enabled.
 */
export function buildExclusiveEnabledPluginsMap(
  raw: string | null | undefined,
  installedIds: readonly string[],
): Record<string, boolean> | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const selected = parsed.filter((x): x is string => typeof x === 'string');
  if (selected.length === 0) return undefined;
  const selectedSet = new Set(selected);
  const map: Record<string, boolean> = {};
  for (const id of installedIds) map[id] = selectedSet.has(id);
  for (const id of selected) map[id] = true;
  return map;
}
