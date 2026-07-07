/**
 * Integration tests for migration 048_workflow_variants.sql (A/B testing).
 *
 * 048 creates the workflow_variants table (FK workflow_id → workflows ON DELETE
 * CASCADE, UNIQUE(workflow_id, label)) AND four nullable workflow_runs tagging
 * columns (experiment_id / experiment_arm / variant_id / variant_label).
 *
 * Applies 006 (workflows + workflow_runs base) against an in-memory SQLite, then
 * applies the real 048 SQL via the production transaction wrapper and asserts:
 * the chain applies cleanly, the table + columns exist, the UNIQUE(label) rejects
 * a duplicate, status defaults to 'draft', and the workflow FK cascades.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

function runMigrationViaProductionPath(db: Database.Database, sql: string): void {
  const txn = db.transaction(() => {
    db.exec(sql);
  });
  txn();
}

function buildDbThrough006(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj One', '/tmp/p1');
  db.exec(readMigration('006_cyboflow_schema.sql'));
  db.prepare('INSERT INTO workflows (id, name, project_id) VALUES (?, ?, ?)').run('wf1', 'planner', 1);
  db.prepare('INSERT INTO workflow_runs (id, workflow_id, project_id, status) VALUES (?, ?, ?, ?)').run(
    'run1',
    'wf1',
    1,
    'completed',
  );
  return db;
}

interface TableInfoRow {
  name: string;
  dflt_value: unknown;
}

describe('Migration 048: workflow_variants + run tagging columns', () => {
  it('applies cleanly and creates the workflow_variants table', () => {
    const db = buildDbThrough006();
    runMigrationViaProductionPath(db, readMigration('048_workflow_variants.sql'));
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_variants'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe('workflow_variants');
    db.close();
  });

  it('adds the four nullable workflow_runs tagging columns', () => {
    const db = buildDbThrough006();
    runMigrationViaProductionPath(db, readMigration('048_workflow_variants.sql'));
    const cols = (db.prepare('PRAGMA table_info(workflow_runs)').all() as TableInfoRow[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['experiment_id', 'experiment_arm', 'variant_id', 'variant_label']));
    db.close();
  });

  it('defaults status to \'draft\' and weight to 1', () => {
    const db = buildDbThrough006();
    runMigrationViaProductionPath(db, readMigration('048_workflow_variants.sql'));
    db.prepare("INSERT INTO workflow_variants (id, workflow_id, label) VALUES ('wfv_1', 'wf1', 'v1')").run();
    const row = db.prepare('SELECT status, weight FROM workflow_variants WHERE id = ?').get('wfv_1') as {
      status: string;
      weight: number;
    };
    expect(row.status).toBe('draft');
    expect(row.weight).toBe(1);
    db.close();
  });

  it('enforces UNIQUE(workflow_id, label)', () => {
    const db = buildDbThrough006();
    runMigrationViaProductionPath(db, readMigration('048_workflow_variants.sql'));
    db.prepare("INSERT INTO workflow_variants (id, workflow_id, label) VALUES ('wfv_1', 'wf1', 'dup')").run();
    expect(() =>
      db.prepare("INSERT INTO workflow_variants (id, workflow_id, label) VALUES ('wfv_2', 'wf1', 'dup')").run(),
    ).toThrow();
    db.close();
  });

  it('cascades variant deletion when the workflow is deleted', () => {
    const db = buildDbThrough006();
    runMigrationViaProductionPath(db, readMigration('048_workflow_variants.sql'));
    // Remove the run first so the workflow FK from workflow_runs does not block delete.
    db.prepare('DELETE FROM workflow_runs WHERE workflow_id = ?').run('wf1');
    db.prepare("INSERT INTO workflow_variants (id, workflow_id, label) VALUES ('wfv_1', 'wf1', 'v1')").run();
    db.prepare('DELETE FROM workflows WHERE id = ?').run('wf1');
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM workflow_variants').get() as { n: number };
    expect(remaining.n).toBe(0);
    db.close();
  });
});
