/**
 * Integration tests for migration 029_agent_overrides.sql.
 *
 * Creates the `agent_overrides` table (per-project builtin shadows + custom
 * agents) with UNIQUE(project_id, agent_key), a projects FK ON DELETE CASCADE,
 * and the idx_agent_overrides_project index. A minimal `projects` table stands
 * in for the FK target.
 *
 * Targets: table + columns present, UNIQUE(project_id, agent_key) enforced,
 * per-project index present, projects FK cascades, and the CREATE TABLE IF NOT
 * EXISTS re-run is a silent no-op (not a throw).
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

function applied(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)');
  db.prepare('INSERT INTO projects (id, name) VALUES (1, ?)').run('P');
  db.prepare('INSERT INTO projects (id, name) VALUES (2, ?)').run('P2');
  db.exec(readMigration('029_agent_overrides.sql'));
  return db;
}

function insertOverride(db: Database.Database, id: string, projectId: number, agentKey: string): void {
  db.prepare(
    `INSERT INTO agent_overrides
       (id, project_id, agent_key, name, description, system_prompt, tools_json)
     VALUES (?, ?, ?, ?, 'desc', 'body', '[]')`,
  ).run(id, projectId, agentKey, `cyboflow-${agentKey}`);
}

describe('Migration 029: agent_overrides table', () => {
  it('creates the table with its documented columns', () => {
    const db = applied();
    const cols = (db.prepare('PRAGMA table_info(agent_overrides)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    for (const c of [
      'id',
      'project_id',
      'agent_key',
      'base_agent_key',
      'name',
      'description',
      'system_prompt',
      'tools_json',
      'is_custom',
      'version',
    ]) {
      expect(cols, `missing column ${c}`).toContain(c);
    }
    db.close();
  });

  it('enforces UNIQUE(project_id, agent_key) but allows the same key across projects', () => {
    const db = applied();
    insertOverride(db, 'ago_1', 1, 'implement');
    // Same (project, key) → UNIQUE violation.
    expect(() => insertOverride(db, 'ago_2', 1, 'implement')).toThrow(/UNIQUE/i);
    // Same key, DIFFERENT project → allowed.
    expect(() => insertOverride(db, 'ago_3', 2, 'implement')).not.toThrow();
    db.close();
  });

  it('exposes the per-project index', () => {
    const db = applied();
    const idx = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_overrides'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(idx).toContain('idx_agent_overrides_project');
    db.close();
  });

  it('cascades away a project’s overrides when the project is deleted', () => {
    const db = applied();
    insertOverride(db, 'ago_1', 1, 'implement');
    db.prepare('DELETE FROM projects WHERE id=1').run();
    expect(db.prepare("SELECT id FROM agent_overrides WHERE id='ago_1'").get()).toBeUndefined();
    db.close();
  });

  it('re-running the CREATE TABLE IF NOT EXISTS is a silent no-op', () => {
    const db = applied();
    insertOverride(db, 'ago_1', 1, 'implement');
    expect(() => db.exec(readMigration('029_agent_overrides.sql'))).not.toThrow();
    // Data survives the idempotent re-run.
    expect(db.prepare("SELECT id FROM agent_overrides WHERE id='ago_1'").get()).toBeDefined();
    db.close();
  });
});
