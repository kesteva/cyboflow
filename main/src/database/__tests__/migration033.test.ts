/**
 * Integration tests for migration 033_step_results.sql.
 *
 * Creates the `step_results` table (one row per (run_id, step_id)) with a
 * CHECK on outcome and the idx_step_results_run index. Self-contained — the
 * migration creates its own table.
 *
 * Targets: table + PK present, CHECK rejects an invalid outcome, INSERT OR
 * REPLACE overwrites the latest settle for a (run_id, step_id) pair, the index
 * exists, and the CREATE TABLE IF NOT EXISTS re-run is a silent no-op.
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
  db.exec(readMigration('033_step_results.sql'));
  return db;
}

function insertResult(
  db: Database.Database,
  runId: string,
  stepId: string,
  outcome: string,
  attempts = 1,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO step_results (run_id, step_id, outcome, attempts)
     VALUES (?, ?, ?, ?)`,
  ).run(runId, stepId, outcome, attempts);
}

describe('Migration 033: step_results table', () => {
  it('creates the table with a composite primary key', () => {
    const db = applied();
    const pkCols = (
      db.prepare('PRAGMA table_info(step_results)').all() as Array<{ name: string; pk: number }>
    )
      .filter((c) => c.pk > 0)
      .map((c) => c.name);
    expect(pkCols.sort()).toEqual(['run_id', 'step_id']);
    db.close();
  });

  it('rejects an out-of-domain outcome via CHECK', () => {
    const db = applied();
    expect(() => insertResult(db, 'r1', 's1', 'exploded')).toThrow(/CHECK constraint failed/i);
    // A valid outcome writes fine.
    expect(() => insertResult(db, 'r1', 's1', 'done')).not.toThrow();
    db.close();
  });

  it('lets a looped-back step OVERWRITE its prior row (INSERT OR REPLACE on the PK)', () => {
    const db = applied();
    insertResult(db, 'r1', 's1', 'failed', 1);
    insertResult(db, 'r1', 's1', 'done', 2); // re-run of the same step

    const rows = db.prepare("SELECT outcome, attempts FROM step_results WHERE run_id='r1'").all() as Array<{
      outcome: string;
      attempts: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('done');
    expect(rows[0].attempts).toBe(2);
    db.close();
  });

  it('exposes the per-run index', () => {
    const db = applied();
    const idx = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='step_results'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(idx).toContain('idx_step_results_run');
    db.close();
  });

  it('re-running the CREATE TABLE IF NOT EXISTS is a silent no-op', () => {
    const db = applied();
    insertResult(db, 'r1', 's1', 'done');
    expect(() => db.exec(readMigration('033_step_results.sql'))).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM step_results").get()).toEqual({ n: 1 });
    db.close();
  });
});
