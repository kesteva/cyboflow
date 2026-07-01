/**
 * Integration tests for migration 043_run_evals.sql.
 *
 * Migration 043 creates the run_evals table — one durable LLM-judge evaluation
 * rollup per (workflow_run, rubric_version). It is a NEW, forward-only table with
 * a composite PRIMARY KEY (run_id, rubric_version) and a hard FK
 * run_id -> workflow_runs(id) ON DELETE CASCADE (mirrors run_usage in 026).
 *
 * Applies 006 (workflows + workflow_runs base) against an in-memory SQLite
 * instance, seeds a workflow + run, then applies the real 043 SQL via the
 * production transaction wrapper and asserts: chain applies cleanly, the table
 * exists with the expected columns, the composite PK rejects a duplicate
 * (run_id, rubric_version), and the FK cascades on run delete.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

/**
 * Apply a migration the way the production runner does — wrapped in a single
 * transaction (mirrors runFileBasedMigrations() / migration042.test.ts). 043
 * contains no FK-pragma toggle, so only the transaction wrapper matters.
 */
function runMigrationViaProductionPath(db: Database.Database, sql: string): void {
  const txn = db.transaction(() => {
    db.exec(sql);
  });
  txn();
}

/** Build the pre-043 chain (006) with a workflow + run seeded for the FK parent. */
function buildDbThrough006(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj One', '/tmp/p1');

  // 006 creates workflows + workflow_runs (the run_evals FK parent).
  db.exec(readMigration('006_cyboflow_schema.sql'));

  db.prepare('INSERT INTO workflows (id, name, project_id) VALUES (?, ?, ?)').run('wf1', 'sprint', 1);
  db.prepare(
    'INSERT INTO workflow_runs (id, workflow_id, project_id, status) VALUES (?, ?, ?, ?)',
  ).run('run1', 'wf1', 1, 'awaiting_review');

  return db;
}

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

const EXPECTED_COLUMNS = [
  'run_id',
  'rubric_version',
  'eval_status',
  'base_sha',
  'diff_text',
  'diff_stats_json',
  'gate_results_json',
  'human_influenced',
  'snapshot_at',
  'overall_score',
  'band',
  'ci_low',
  'ci_high',
  'gated',
  'security_flag',
  'dimensions_json',
  'per_sample_json',
  'judge_model',
  'sample_count',
  'prompt_hash',
  'judge_build_id',
  'workflow_id',
  'workflow_name',
  'spec_hash',
  'run_model',
  'subagent_models_json',
  'difficulty_proxy_prerun',
  'error',
  'created_at',
  'updated_at',
].sort();

function insertEval(
  db: Database.Database,
  runId: string,
  rubricVersion: string,
): void {
  db.prepare(
    `INSERT INTO run_evals (run_id, rubric_version, snapshot_at, workflow_id, workflow_name)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(runId, rubricVersion, '2026-07-01T00:00:00Z', 'wf1', 'sprint');
}

describe('Migration 043: run_evals LLM-judge rollup table', () => {
  it('creates run_evals with exactly the expected columns', () => {
    const db = buildDbThrough006();
    runMigrationViaProductionPath(db, readMigration('043_run_evals.sql'));

    const cols = (db.prepare('PRAGMA table_info(run_evals)').all() as TableInfoRow[])
      .map((r) => r.name)
      .sort();
    expect(cols).toEqual(EXPECTED_COLUMNS);
    db.close();
  });

  it('sets the composite PRIMARY KEY on (run_id, rubric_version)', () => {
    const db = buildDbThrough006();
    runMigrationViaProductionPath(db, readMigration('043_run_evals.sql'));

    const pkCols = (db.prepare('PRAGMA table_info(run_evals)').all() as TableInfoRow[])
      .filter((r) => r.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((r) => r.name);
    expect(pkCols).toEqual(['run_id', 'rubric_version']);
    db.close();
  });

  it('rejects a duplicate (run_id, rubric_version) but allows a different rubric_version', () => {
    const db = buildDbThrough006();
    runMigrationViaProductionPath(db, readMigration('043_run_evals.sql'));

    insertEval(db, 'run1', '1.1');
    // Same (run_id, rubric_version) -> PK violation (the re-fire dedup guard).
    expect(() => insertEval(db, 'run1', '1.1')).toThrow(/UNIQUE|PRIMARY/i);
    // Same run, different rubric version -> allowed.
    expect(() => insertEval(db, 'run1', '2.0')).not.toThrow();

    const n = db.prepare('SELECT COUNT(*) AS n FROM run_evals').get() as { n: number };
    expect(n.n).toBe(2);
    db.close();
  });

  it('INSERT OR IGNORE is a no-op on the second re-fire of the same key', () => {
    const db = buildDbThrough006();
    runMigrationViaProductionPath(db, readMigration('043_run_evals.sql'));

    const stmt = db.prepare(
      `INSERT OR IGNORE INTO run_evals (run_id, rubric_version, snapshot_at, workflow_id, workflow_name)
       VALUES (?, ?, ?, ?, ?)`,
    );
    expect(stmt.run('run1', '1.1', 't0', 'wf1', 'sprint').changes).toBe(1);
    expect(stmt.run('run1', '1.1', 't1', 'wf1', 'sprint').changes).toBe(0);
    db.close();
  });

  it('defaults eval_status to pending and enforces the status CHECK', () => {
    const db = buildDbThrough006();
    runMigrationViaProductionPath(db, readMigration('043_run_evals.sql'));

    insertEval(db, 'run1', '1.1');
    const row = db.prepare('SELECT eval_status, human_influenced, gated, security_flag FROM run_evals').get() as {
      eval_status: string;
      human_influenced: number;
      gated: number;
      security_flag: number;
    };
    expect(row.eval_status).toBe('pending');
    expect(row.human_influenced).toBe(0);
    expect(row.gated).toBe(0);
    expect(row.security_flag).toBe(0);

    expect(() =>
      db
        .prepare(
          `INSERT INTO run_evals (run_id, rubric_version, eval_status, snapshot_at, workflow_id, workflow_name)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('run1', '2.0', 'bogus', 't', 'wf1', 'sprint'),
    ).toThrow(/CHECK/i);
    db.close();
  });

  it('cascades on run delete (FK run_id -> workflow_runs ON DELETE CASCADE)', () => {
    const db = buildDbThrough006();
    runMigrationViaProductionPath(db, readMigration('043_run_evals.sql'));

    insertEval(db, 'run1', '1.1');
    db.prepare('DELETE FROM workflow_runs WHERE id = ?').run('run1');
    const n = db.prepare('SELECT COUNT(*) AS n FROM run_evals').get() as { n: number };
    expect(n.n).toBe(0);
    db.close();
  });

  it('rejects a run_id with no parent workflow_runs row', () => {
    const db = buildDbThrough006();
    runMigrationViaProductionPath(db, readMigration('043_run_evals.sql'));

    expect(() => insertEval(db, 'ghost', '1.1')).toThrow(/FOREIGN KEY/i);
    db.close();
  });

  it('applies idempotently (re-running the file is a no-op via IF NOT EXISTS)', () => {
    const db = buildDbThrough006();
    const sql = readMigration('043_run_evals.sql');
    runMigrationViaProductionPath(db, sql);
    insertEval(db, 'run1', '1.1');
    // Re-run the same file: CREATE TABLE IF NOT EXISTS leaves the data intact.
    runMigrationViaProductionPath(db, sql);
    const n = db.prepare('SELECT COUNT(*) AS n FROM run_evals').get() as { n: number };
    expect(n.n).toBe(1);
    db.close();
  });
});
