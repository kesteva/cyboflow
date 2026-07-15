import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

function apply(db: Database.Database, name: string): void {
  db.transaction(() => db.exec(readMigration(name)))();
}

function buildDbThrough043(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE
    );
  `);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj One', '/tmp/p1');
  apply(db, '006_cyboflow_schema.sql');
  apply(db, '043_run_evals.sql');
  db.prepare('INSERT INTO workflows (id, name, project_id) VALUES (?, ?, ?)').run('wf1', 'sprint', 1);
  db.prepare(
    'INSERT INTO workflow_runs (id, workflow_id, project_id, status) VALUES (?, ?, ?, ?)',
  ).run('run1', 'wf1', 1, 'awaiting_review');
  db.prepare(
    `INSERT INTO run_evals (run_id, rubric_version, snapshot_at, workflow_id, workflow_name)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('run1', '1.1', '2026-07-15T00:00:00Z', 'wf1', 'sprint');
  return db;
}

describe('Migration 068: run_evals jury provenance', () => {
  it('adds nullable jury_json and preserves legacy rows as NULL', () => {
    const db = buildDbThrough043();
    apply(db, '068_run_eval_jury.sql');
    const column = (db.prepare('PRAGMA table_info(run_evals)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
    }>).find((entry) => entry.name === 'jury_json');
    expect(column).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
    const row = db.prepare('SELECT jury_json FROM run_evals WHERE run_id = ?').get('run1') as {
      jury_json: string | null;
    };
    expect(row.jury_json).toBeNull();
    db.close();
  });

  it('round-trips provenance JSON and exposes the runner idempotency signal', () => {
    const db = buildDbThrough043();
    apply(db, '068_run_eval_jury.sql');
    const juryJson = JSON.stringify([
      { slot: 'claude-1', provider: 'claude', model: 'opus', status: 'ok', sampleIndex: 0 },
    ]);
    db.prepare('UPDATE run_evals SET jury_json = ? WHERE run_id = ?').run(juryJson, 'run1');
    expect(
      (db.prepare('SELECT jury_json FROM run_evals WHERE run_id = ?').get('run1') as {
        jury_json: string;
      }).jury_json,
    ).toBe(juryJson);
    expect(() => apply(db, '068_run_eval_jury.sql')).toThrow(/duplicate column name/i);
    db.close();
  });
});
