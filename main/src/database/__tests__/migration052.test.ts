/**
 * Integration tests for migration 052_experiment_promoted_variant.sql (A/B testing).
 *
 * 052 adds the variant-outcome promotion verdict to `experiments`
 * (promoted_variant_id / promoted_arm / promoted_at), separate from the existing
 * winner_run_id/winner_arm/decided_at "changes decision" columns. It applies
 * against a base `experiments` table (created inline here, mirroring the shape
 * from migration 049) via the production transaction wrapper, and asserts: the
 * chain applies cleanly, all three columns exist (PRAGMA table_info), the
 * promoted_arm CHECK rejects a value outside (A,B), and NULL is allowed for all
 * three (the default, pre-promotion state).
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

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // Minimal `experiments` table shape (migration 049) — 052 only ALTERs it.
  db.exec(`CREATE TABLE experiments (
    id TEXT PRIMARY KEY,
    project_id INTEGER NOT NULL,
    workflow_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'side_by_side',
    base_branch TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    variant_a_id TEXT NOT NULL,
    variant_b_id TEXT NOT NULL,
    run_a_id TEXT,
    run_b_id TEXT,
    session_a_id TEXT,
    session_b_id TEXT,
    seed_idea_id TEXT,
    seed_idea_clone_a_id TEXT,
    seed_idea_clone_b_id TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    winner_run_id TEXT,
    winner_arm TEXT,
    merge_sha TEXT,
    decided_at TEXT,
    rerun_of_experiment_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
  db.prepare(
    `INSERT INTO experiments (id, project_id, workflow_id, base_branch, base_sha, variant_a_id, variant_b_id)
     VALUES ('exp1', 1, 'wf', 'main', 'sha0', 'vA', 'vB')`,
  ).run();
  return db;
}

describe('Migration 052: experiments.promoted_variant_id/promoted_arm/promoted_at', () => {
  it('applies cleanly', () => {
    const db = buildDb();
    expect(() =>
      runMigrationViaProductionPath(db, readMigration('052_experiment_promoted_variant.sql')),
    ).not.toThrow();
    db.close();
  });

  it('adds all three columns (PRAGMA table_info)', () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration('052_experiment_promoted_variant.sql'));
    const cols = (db.prepare('PRAGMA table_info(experiments)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toEqual(
      expect.arrayContaining(['promoted_variant_id', 'promoted_arm', 'promoted_at']),
    );
    db.close();
  });

  it('leaves all three columns NULL on a pre-existing row (fully backward compatible)', () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration('052_experiment_promoted_variant.sql'));
    const row = db
      .prepare('SELECT promoted_variant_id, promoted_arm, promoted_at FROM experiments WHERE id = ?')
      .get('exp1') as { promoted_variant_id: unknown; promoted_arm: unknown; promoted_at: unknown };
    expect(row.promoted_variant_id).toBeNull();
    expect(row.promoted_arm).toBeNull();
    expect(row.promoted_at).toBeNull();
    db.close();
  });

  it('rejects a promoted_arm value outside (A,B)', () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration('052_experiment_promoted_variant.sql'));
    expect(() =>
      db.prepare("UPDATE experiments SET promoted_arm = 'C' WHERE id = 'exp1'").run(),
    ).toThrow();
    db.close();
  });

  it('accepts a full promotion write (variant id + A/B arm + ISO timestamp)', () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration('052_experiment_promoted_variant.sql'));
    const now = new Date().toISOString();
    expect(() =>
      db
        .prepare(
          `UPDATE experiments SET promoted_variant_id = ?, promoted_arm = ?, promoted_at = ? WHERE id = 'exp1'`,
        )
        .run('wfv_abc', 'A', now),
    ).not.toThrow();
    const row = db
      .prepare('SELECT promoted_variant_id, promoted_arm, promoted_at FROM experiments WHERE id = ?')
      .get('exp1') as { promoted_variant_id: string; promoted_arm: string; promoted_at: string };
    expect(row.promoted_variant_id).toBe('wfv_abc');
    expect(row.promoted_arm).toBe('A');
    expect(row.promoted_at).toBe(now);
    db.close();
  });

  it('accepts the __baseline__ sentinel as promoted_variant_id', () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration('052_experiment_promoted_variant.sql'));
    expect(() =>
      db
        .prepare(
          `UPDATE experiments SET promoted_variant_id = '__baseline__', promoted_arm = 'B', promoted_at = ? WHERE id = 'exp1'`,
        )
        .run(new Date().toISOString()),
    ).not.toThrow();
    db.close();
  });
});
