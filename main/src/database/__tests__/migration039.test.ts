/**
 * Integration tests for migration 039_session_mcp_plugins.sql.
 *
 * Adds TWO columns to `sessions`, both NOT NULL DEFAULT '[]':
 *   disabled_mcp_servers_json (a DENY list) and enabled_plugins_json (an ALLOW
 *   list). A minimal inline `sessions` table stands in for the legacy schema.
 *
 * Targets: both columns exist with the '[]' default, a pre-existing row reads
 * back both as empty arrays, each JSON round-trips independently, and a re-run
 * raises the "duplicate column name" idempotency signal (the FIRST ALTER of the
 * two-statement file re-throws on the already-present column).
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

function upgraded(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare("INSERT INTO sessions (id, name) VALUES ('s1', 'legacy')").run();
  db.exec(readMigration('039_session_mcp_plugins.sql'));
  return db;
}

interface Col {
  name: string;
  notnull: number;
  dflt_value: unknown;
}

describe('Migration 039: sessions MCP-disable / plugin-enable toggles', () => {
  it('adds both NOT NULL columns defaulting to an empty JSON array', () => {
    const db = upgraded();
    const cols = db.prepare('PRAGMA table_info(sessions)').all() as Col[];
    for (const name of ['disabled_mcp_servers_json', 'enabled_plugins_json']) {
      const col = cols.find((c) => c.name === name);
      expect(col, `missing column ${name}`).toBeDefined();
      expect(col!.notnull).toBe(1);
      expect(String(col!.dflt_value).replace(/'/g, '')).toBe('[]');
    }
    db.close();
  });

  it('backfills a pre-existing session to [] on both columns', () => {
    const db = upgraded();
    const row = db
      .prepare(
        "SELECT disabled_mcp_servers_json AS d, enabled_plugins_json AS e FROM sessions WHERE id='s1'",
      )
      .get() as { d: string; e: string };
    expect(JSON.parse(row.d)).toEqual([]);
    expect(JSON.parse(row.e)).toEqual([]);
    db.close();
  });

  it('round-trips each JSON string[] independently', () => {
    const db = upgraded();
    db.prepare(
      "UPDATE sessions SET disabled_mcp_servers_json=?, enabled_plugins_json=? WHERE id='s1'",
    ).run(JSON.stringify(['playwright']), JSON.stringify(['my-plugin@market']));
    const row = db
      .prepare(
        "SELECT disabled_mcp_servers_json AS d, enabled_plugins_json AS e FROM sessions WHERE id='s1'",
      )
      .get() as { d: string; e: string };
    expect(JSON.parse(row.d)).toEqual(['playwright']);
    expect(JSON.parse(row.e)).toEqual(['my-plugin@market']);
    db.close();
  });

  it('re-running raises duplicate column name (the idempotency signal)', () => {
    const db = upgraded();
    expect(() => db.exec(readMigration('039_session_mcp_plugins.sql'))).toThrow(
      /duplicate column name/i,
    );
    db.close();
  });
});
