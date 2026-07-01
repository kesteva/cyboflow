/**
 * cyboflow.plugins sub-router — READ-ONLY catalogue of installed Claude Code
 * plugins (`~/.claude/plugins/installed_plugins.json`).
 *
 * No DB / registry / chokepoint — a pure disk read adapted to `PluginEntry[]`.
 * One plugin id can have multiple install records (per scope / project); each
 * record yields its own `PluginEntry`. A missing/malformed file yields [].
 *
 * The disk read itself lives in the standalone `installedPlugins` leaf module
 * (shared with ClaudeCodeManager's spawn-time exclusive-map builder). It is
 * re-exported here so existing importers (`readPluginEntries` from '../plugins')
 * keep working.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*.
 */
import { router, protectedProcedure } from '../trpc';
import { readPluginEntries } from '../../integrations/installedPlugins';
import type { PluginEntry } from '../../../../../shared/types/integrations';

export { readPluginEntries } from '../../integrations/installedPlugins';

export const pluginsRouter = router({
  /** List every installed plugin record (one per scope/project). Read-only. */
  list: protectedProcedure.query(async (): Promise<PluginEntry[]> => readPluginEntries()),
});
