/**
 * Idempotent, shape-guarded rebuild of `sessions.enabled_plugins_json` from the
 * legacy migration-039 shape (`TEXT NOT NULL DEFAULT '[]'`) to a nullable
 * `DEFAULT NULL`.
 *
 * WHY A RECONCILER, NOT A PLAIN FILE MIGRATION.
 * buildExclusiveEnabledPluginsMap (orchestrator/integrations/installedPlugins.ts)
 * reads the stored value as a three-way sentinel: NULL → inherit the user's
 * ~/.claude/settings.json plugins; present-but-empty '[]' → disable EVERY installed
 * plugin; a non-empty array → exclusive selection. The 039 default of '[]' made the
 * NULL/inherit state unreachable, so every untouched session force-disabled all
 * file-enabled plugins (e.g. codex). The fix flips the default to NULL and backfills
 * legacy '[]' → NULL.
 *
 * That backfill is VALUE-KEYED (`NULLIF(x, '[]')`), which a numbered .sql migration
 * cannot express safely: the ADD/DROP/RENAME swap renames the temp column away, so a
 * re-run (marker lost/reset) does NOT trip the runner's "duplicate column name"
 * idempotency signal — it succeeds again and re-applies NULLIF, silently converting a
 * DELIBERATE post-fix '[]' ("disable everything for this session") back to inherit.
 * A shape guard fixes this cleanly: we only rebuild while the column is still the old
 * NOT NULL shape, so once reconciled this is a pure no-op regardless of any marker,
 * and a deliberate '[]' is never re-touched.
 *
 * Mirrors reconcileWorkflowRunsSchema in database.ts. No index/trigger/view/generated
 * column references enabled_plugins_json, so DROP COLUMN is safe; the whole swap is
 * one transaction, so a failure rolls back to the pre-run shape (no partial state).
 *
 * @returns true if it rebuilt the column, false if it no-op'd (already reconciled,
 *   or the column/table is absent).
 */
import type Database from 'better-sqlite3';

interface SqliteColumn {
  name: string;
  notnull: number;
}

export function reconcileSessionsPluginsColumn(db: Database.Database): boolean {
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
    .get();
  if (!tableExists) return false;

  const cols = db.prepare('PRAGMA table_info(sessions)').all() as SqliteColumn[];
  const col = cols.find((c) => c.name === 'enabled_plugins_json');
  // Only the legacy NOT NULL shape needs work. Absent column (pre-039) or an
  // already-nullable column (already reconciled) → nothing to do, so re-runs and
  // fresh boots against a migrated DB are true no-ops.
  if (!col || col.notnull !== 1) return false;

  const rebuild = db.transaction(() => {
    // A leftover temp column from a crashed prior attempt cannot persist (the swap
    // is transactional), but drop it defensively in case of a hand-corrupted DB so
    // the ADD below cannot throw "duplicate column name".
    const hasTemp = (db.prepare('PRAGMA table_info(sessions)').all() as SqliteColumn[]).some(
      (c) => c.name === 'enabled_plugins_json_v2',
    );
    if (hasTemp) db.prepare('ALTER TABLE sessions DROP COLUMN enabled_plugins_json_v2').run();

    db.prepare('ALTER TABLE sessions ADD COLUMN enabled_plugins_json_v2 TEXT DEFAULT NULL').run();
    // NULLIF maps '[]' → NULL and preserves real selections (and any existing NULL).
    // Exact-match is correct: the broken default and the app writers both store the
    // canonical JSON.stringify([]) === '[]'.
    db.prepare("UPDATE sessions SET enabled_plugins_json_v2 = NULLIF(enabled_plugins_json, '[]')").run();
    db.prepare('ALTER TABLE sessions DROP COLUMN enabled_plugins_json').run();
    db.prepare('ALTER TABLE sessions RENAME COLUMN enabled_plugins_json_v2 TO enabled_plugins_json').run();
  });
  rebuild();
  return true;
}
