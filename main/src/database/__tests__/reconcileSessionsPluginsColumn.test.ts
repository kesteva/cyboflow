/**
 * Unit tests for reconcileSessionsPluginsColumn — the shape-guarded rebuild of
 * sessions.enabled_plugins_json from migration 039's `NOT NULL DEFAULT '[]'` to a
 * nullable `DEFAULT NULL` (so untouched sessions inherit the user's file-enabled
 * plugins instead of force-disabling all of them; see buildExclusiveEnabledPluginsMap).
 *
 * Runs against an in-memory SQLite instance in the two relevant shapes.
 *
 * Targets:
 *  1. Old shape → rebuild: column becomes nullable (NULL default), legacy '[]' → NULL,
 *     a real selection is preserved, a fresh INSERT reads back NULL (inherit).
 *  2. Idempotency / the Finding-1 regression: a SECOND reconcile is a no-op and does
 *     NOT re-fire the NULLIF backfill, so a DELIBERATE post-fix '[]' (disable-all) is
 *     NEVER silently converted back to inherit.
 *  3. Shape guard: an already-nullable column and a pre-039 (absent) column both no-op.
 *  4. Resolver bridge: the NULL a reconciled untouched session stores → undefined
 *     (inherit) through buildExclusiveEnabledPluginsMap — codex is not force-disabled.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { reconcileSessionsPluginsColumn } from '../reconcileSessionsPluginsColumn';
import { buildExclusiveEnabledPluginsMap } from '../../orchestrator/integrations/installedPlugins';

interface Col {
  name: string;
  notnull: number;
}

/** A `sessions` table in the legacy post-039 shape (NOT NULL DEFAULT '[]'). */
function legacyDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, enabled_plugins_json TEXT NOT NULL DEFAULT '[]')",
  );
  db.prepare("INSERT INTO sessions (id) VALUES ('untouched')").run(); // fell to '[]' default
  db.prepare("INSERT INTO sessions (id, enabled_plugins_json) VALUES ('picked', ?)").run(
    JSON.stringify(['codex@openai-codex']),
  );
  return db;
}

function pluginCol(db: Database.Database): Col | undefined {
  return (db.prepare('PRAGMA table_info(sessions)').all() as Col[]).find(
    (c) => c.name === 'enabled_plugins_json',
  );
}

describe('reconcileSessionsPluginsColumn', () => {
  it('rebuilds the old NOT NULL shape → nullable, backfills [] → NULL, preserves selections', () => {
    const db = legacyDb();
    expect(reconcileSessionsPluginsColumn(db)).toBe(true);

    expect(pluginCol(db)!.notnull).toBe(0); // nullable now

    const untouched = db
      .prepare("SELECT enabled_plugins_json AS e FROM sessions WHERE id='untouched'")
      .get() as { e: string | null };
    expect(untouched.e).toBeNull(); // legacy '[]' → NULL (inherit)

    const picked = db
      .prepare("SELECT enabled_plugins_json AS e FROM sessions WHERE id='picked'")
      .get() as { e: string | null };
    expect(JSON.parse(picked.e!)).toEqual(['codex@openai-codex']); // preserved verbatim

    db.prepare("INSERT INTO sessions (id) VALUES ('fresh')").run();
    const fresh = db
      .prepare("SELECT enabled_plugins_json AS e FROM sessions WHERE id='fresh'")
      .get() as { e: string | null };
    expect(fresh.e).toBeNull(); // new untouched session inherits
    db.close();
  });

  it('is idempotent: a re-run no-ops and NEVER re-converts a deliberate [] to NULL', () => {
    const db = legacyDb();
    reconcileSessionsPluginsColumn(db); // first run: real rebuild

    // Post-fix, a user deliberately disables ALL plugins for one session → stores '[]'
    // (unambiguous now that the default is NULL).
    db.prepare("INSERT INTO sessions (id, enabled_plugins_json) VALUES ('disable-all', '[]')").run();

    // A second reconcile (e.g. next boot, or migration marker lost) must be inert.
    expect(reconcileSessionsPluginsColumn(db)).toBe(false);

    const row = db
      .prepare("SELECT enabled_plugins_json AS e FROM sessions WHERE id='disable-all'")
      .get() as { e: string | null };
    expect(row.e).toBe('[]'); // survives — NOT silently reverted to inherit
    db.close();
  });

  it('no-ops when the column is already nullable (already reconciled)', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, enabled_plugins_json TEXT DEFAULT NULL)');
    expect(reconcileSessionsPluginsColumn(db)).toBe(false);
    db.close();
  });

  it('no-ops when the column is absent (pre-039 schema) and when the table is missing', () => {
    const noColumn = new Database(':memory:');
    noColumn.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
    expect(reconcileSessionsPluginsColumn(noColumn)).toBe(false);
    noColumn.close();

    const noTable = new Database(':memory:');
    expect(reconcileSessionsPluginsColumn(noTable)).toBe(false);
    noTable.close();
  });

  it('resolver bridge: the NULL a reconciled untouched session stores → undefined (inherits codex)', () => {
    const db = legacyDb();
    reconcileSessionsPluginsColumn(db);
    const { e: raw } = db
      .prepare("SELECT enabled_plugins_json AS e FROM sessions WHERE id='untouched'")
      .get() as { e: string | null };

    const installed = ['codex@openai-codex', 'context7@claude-plugins-official'];
    // undefined → no enabledPlugins injected at the flag tier → the CLI reads the
    // user's settings.json (codex enabled), so codex is NOT force-disabled.
    expect(buildExclusiveEnabledPluginsMap(raw, installed)).toBeUndefined();
    db.close();
  });
});
