/**
 * Integration tests for migration 059_session_plugins_default_null.sql.
 *
 * Migration 039 declared `enabled_plugins_json TEXT NOT NULL DEFAULT '[]'`, which
 * made the NULL/inherit sentinel unreachable — every untouched session fell to '[]'
 * and had ALL plugins force-disabled at spawn (overriding the user's file-enabled
 * plugins, e.g. codex). 059 rebuilds the column so its default is NULL (inherit) and
 * backfills legacy '[]' → NULL.
 *
 * A minimal inline `sessions` table stands in for the post-039 schema.
 *
 * Targets:
 *  1. The column becomes nullable with a NULL default; a fresh INSERT that omits it
 *     reads back NULL (an untouched session now inherits).
 *  2. A legacy '[]' row is backfilled to NULL.
 *  3. A genuine non-empty selection is preserved verbatim.
 *  4. Resolver bridge: the NULL a fresh session stores resolves to `undefined`
 *     (inherit) through buildExclusiveEnabledPluginsMap — so codex, enabled in the
 *     user's settings.json, is NOT force-disabled for that session.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildExclusiveEnabledPluginsMap } from '../../orchestrator/integrations/installedPlugins';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

/** Minimal stand-in for the post-039 `sessions` shape (NOT NULL DEFAULT '[]'). */
function upgraded(): Database.Database {
  const db = new Database(':memory:');
  db.exec(
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, enabled_plugins_json TEXT NOT NULL DEFAULT '[]')",
  );
  // s1: untouched session that fell to the '[]' default (should become NULL).
  db.prepare("INSERT INTO sessions (id) VALUES ('s1')").run();
  // s2: a deliberate non-empty selection (should be preserved verbatim).
  db.prepare("INSERT INTO sessions (id, enabled_plugins_json) VALUES ('s2', ?)").run(
    JSON.stringify(['codex@openai-codex']),
  );
  db.exec(readMigration('059_session_plugins_default_null.sql'));
  return db;
}

interface Col {
  name: string;
  notnull: number;
  dflt_value: unknown;
}

describe('Migration 059: sessions.enabled_plugins_json default → NULL (inherit)', () => {
  it('makes the column nullable with a NULL default; a fresh INSERT reads back NULL', () => {
    const db = upgraded();
    const col = (db.prepare('PRAGMA table_info(sessions)').all() as Col[]).find(
      (c) => c.name === 'enabled_plugins_json',
    );
    expect(col, 'enabled_plugins_json column missing after 059').toBeDefined();
    expect(col!.notnull).toBe(0); // nullable now
    // PRAGMA reports a DEFAULT NULL column's dflt_value as the literal token "NULL"
    // (not JS null); the key point is it's no longer the '[]' disable-all sentinel.
    // The behavioural proof is the fresh INSERT below reading back SQL NULL.
    expect(String(col!.dflt_value).replace(/'/g, '')).not.toBe('[]');

    db.prepare("INSERT INTO sessions (id) VALUES ('fresh')").run();
    const fresh = db
      .prepare("SELECT enabled_plugins_json AS e FROM sessions WHERE id='fresh'")
      .get() as { e: string | null };
    expect(fresh.e).toBeNull();
    db.close();
  });

  it("backfills a legacy '[]' row to NULL (inherit)", () => {
    const db = upgraded();
    const row = db
      .prepare("SELECT enabled_plugins_json AS e FROM sessions WHERE id='s1'")
      .get() as { e: string | null };
    expect(row.e).toBeNull();
    db.close();
  });

  it('preserves a deliberate non-empty selection verbatim', () => {
    const db = upgraded();
    const row = db
      .prepare("SELECT enabled_plugins_json AS e FROM sessions WHERE id='s2'")
      .get() as { e: string | null };
    expect(row.e).not.toBeNull();
    expect(JSON.parse(row.e!)).toEqual(['codex@openai-codex']);
    db.close();
  });

  it('resolver bridge: the NULL an untouched session stores → undefined (inherits codex)', () => {
    const db = upgraded();
    db.prepare("INSERT INTO sessions (id) VALUES ('untouched')").run();
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
