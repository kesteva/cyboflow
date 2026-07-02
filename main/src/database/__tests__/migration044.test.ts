/**
 * Integration tests for migration 044_workflow_run_eval_enabled.sql
 * (per-run code-review-eval override — the per-run sibling to the global
 * codeReviewEvalEnabled app-config toggle).
 *
 * Applies 006_cyboflow_schema.sql (workflows + workflow_runs) against an in-memory
 * SQLite instance, then applies the real 044 SQL via the production transaction
 * wrapper and asserts:
 *   1. ADD COLUMN — workflow_runs.eval_enabled is created (nullable, default NULL).
 *   2. NULL default — an existing row (inserted before the ALTER) reads back NULL
 *      (inherit-the-global, byte-identical behavior).
 *   3. 0/1/NULL round-trip — the column accepts an explicit 0, 1, and NULL.
 *   4. Idempotent re-apply — a second ALTER surfaces the "duplicate column name"
 *      SQLite error the production runner swallows as idempotent-ok.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

/** Apply a migration the way the production runner does (single transaction). */
function runMigrationViaProductionPath(db: Database.Database, sql: string): void {
  const txn = db.transaction(() => {
    db.exec(sql);
  });
  txn();
}

/** Build the pre-044 chain (006) with a project + workflow + run seeded. */
function buildDbThrough006(): Database.Database {
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
  db.exec(readMigration('006_cyboflow_schema.sql'));
  db.prepare('INSERT INTO workflows (id, name, project_id) VALUES (?, ?, ?)').run('wf1', 'sprint', 1);
  db.prepare(
    'INSERT INTO workflow_runs (id, workflow_id, project_id, status) VALUES (?, ?, ?, ?)',
  ).run('run1', 'wf1', 1, 'awaiting_review');
  return db;
}

describe('Migration 044: workflow_runs.eval_enabled per-run override', () => {
  it('adds the eval_enabled column (nullable, default NULL)', () => {
    const db = buildDbThrough006();
    runMigrationViaProductionPath(db, readMigration('044_workflow_run_eval_enabled.sql'));

    const cols = db.prepare('PRAGMA table_info(workflow_runs)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
    }>;
    const col = cols.find((c) => c.name === 'eval_enabled');
    expect(col).toBeTruthy();
    expect(col?.type).toBe('INTEGER');
    expect(col?.notnull).toBe(0); // nullable
    expect(col?.dflt_value).toBeNull(); // no default → NULL
    db.close();
  });

  it('reads back NULL for a row that existed before the ALTER (inherit the global)', () => {
    const db = buildDbThrough006();
    runMigrationViaProductionPath(db, readMigration('044_workflow_run_eval_enabled.sql'));

    const row = db
      .prepare('SELECT eval_enabled FROM workflow_runs WHERE id = ?')
      .get('run1') as { eval_enabled: number | null };
    expect(row.eval_enabled).toBeNull();
    db.close();
  });

  it('round-trips an explicit 0, 1, and NULL', () => {
    const db = buildDbThrough006();
    runMigrationViaProductionPath(db, readMigration('044_workflow_run_eval_enabled.sql'));

    const upd = db.prepare('UPDATE workflow_runs SET eval_enabled = ? WHERE id = ?');
    const read = () =>
      (db.prepare('SELECT eval_enabled FROM workflow_runs WHERE id = ?').get('run1') as {
        eval_enabled: number | null;
      }).eval_enabled;

    upd.run(0, 'run1');
    expect(read()).toBe(0);
    upd.run(1, 'run1');
    expect(read()).toBe(1);
    upd.run(null, 'run1');
    expect(read()).toBeNull();
    db.close();
  });

  it('is idempotent at the runner level (re-applying surfaces "duplicate column name")', () => {
    const db = buildDbThrough006();
    const sql = readMigration('044_workflow_run_eval_enabled.sql');
    runMigrationViaProductionPath(db, sql);
    // The production runFileBasedMigrations() catches this as idempotent-ok; here
    // we simply assert the second apply throws the recognizable duplicate error.
    expect(() => runMigrationViaProductionPath(db, sql)).toThrow(/duplicate column name/i);
    db.close();
  });
});
