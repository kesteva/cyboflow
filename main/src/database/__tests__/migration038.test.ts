/**
 * Integration tests for migration 038_agent_mcp_access.sql.
 *
 * Adds `enabled_mcps_json TEXT NOT NULL DEFAULT '[]'` to agent_overrides
 * (per-agent MCP scoping). Applies 029 first (the base table), then 038.
 *
 * Targets: column shape (NOT NULL + '[]' default), a pre-existing override row
 * reads back the empty-array default, the JSON round-trips, the
 * UNIQUE(project_id, agent_key) constraint is STILL enforced after the ADD
 * COLUMN, and a re-run raises the "duplicate column name" idempotency signal.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

function insertOverride(db: Database.Database, id: string, projectId: number, agentKey: string): void {
  db.prepare(
    `INSERT INTO agent_overrides
       (id, project_id, agent_key, name, description, system_prompt, tools_json)
     VALUES (?, ?, ?, ?, 'desc', 'body', '[]')`,
  ).run(id, projectId, agentKey, `cyboflow-${agentKey}`);
}

/** 029 (base) + a seeded override row, THEN 038 — the upgrade-install order. */
function upgraded(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)');
  db.prepare('INSERT INTO projects (id, name) VALUES (1, ?)').run('P');
  db.exec(readMigration('029_agent_overrides.sql'));
  insertOverride(db, 'ago_1', 1, 'implement'); // pre-existing row before 038
  db.exec(readMigration('038_agent_mcp_access.sql'));
  return db;
}

interface Col {
  name: string;
  notnull: number;
  dflt_value: unknown;
}

describe('Migration 038: agent_overrides.enabled_mcps_json', () => {
  it('adds a NOT NULL column defaulting to an empty JSON array', () => {
    const db = upgraded();
    const col = (db.prepare('PRAGMA table_info(agent_overrides)').all() as Col[]).find(
      (c) => c.name === 'enabled_mcps_json',
    );
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(1);
    expect(String(col!.dflt_value).replace(/'/g, '')).toBe('[]');
    db.close();
  });

  it('backfills the pre-existing override row to [] (parses as an empty array)', () => {
    const db = upgraded();
    const row = db.prepare("SELECT enabled_mcps_json AS j FROM agent_overrides WHERE id='ago_1'").get() as {
      j: string;
    };
    expect(JSON.parse(row.j)).toEqual([]);
    db.close();
  });

  it('round-trips a JSON string[] of server names', () => {
    const db = upgraded();
    db.prepare("UPDATE agent_overrides SET enabled_mcps_json=? WHERE id='ago_1'").run(
      JSON.stringify(['fal-ai', 'context7']),
    );
    const row = db.prepare("SELECT enabled_mcps_json AS j FROM agent_overrides WHERE id='ago_1'").get() as {
      j: string;
    };
    expect(JSON.parse(row.j)).toEqual(['fal-ai', 'context7']);
    db.close();
  });

  it('still enforces UNIQUE(project_id, agent_key) after the ADD COLUMN', () => {
    const db = upgraded();
    expect(() => insertOverride(db, 'ago_dup', 1, 'implement')).toThrow(/UNIQUE/i);
    db.close();
  });

  it('re-running raises duplicate column name (the idempotency signal)', () => {
    const db = upgraded();
    expect(() => db.exec(readMigration('038_agent_mcp_access.sql'))).toThrow(
      /duplicate column name: enabled_mcps_json/i,
    );
    db.close();
  });
});
