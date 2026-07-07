/**
 * Integration tests for migration 051_experiment_seed_tasks.sql (A/B testing).
 *
 * 051 creates the experiment_seed_tasks table — the per-arm (original -> clone)
 * task-clone mapping backing a SPRINT experiment. It is NOT an entity table (no
 * FK clauses; the sandbox tag on the clone `tasks` row is the real link), with a
 * CHECK on arm, UNIQUE(experiment_id, arm, original_task_id), and UNIQUE(clone).
 *
 * 051 is self-contained (no FK clauses — the sandbox tag on the clone `tasks` row
 * is the real link), so this applies the real 051 SQL via the production
 * transaction wrapper against a bare in-memory DB and asserts: the chain applies
 * cleanly, the table + index exist, the arm CHECK and both UNIQUE constraints
 * reject violations, and created_at defaults.
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
  // 051 is self-contained (no FK clauses) — no dependency migrations needed.
  return db;
}

describe('Migration 051: experiment_seed_tasks', () => {
  it('applies cleanly and creates the table + experiment index', () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration('051_experiment_seed_tasks.sql'));
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='experiment_seed_tasks'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe('experiment_seed_tasks');
    const index = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_experiment_seed_tasks_experiment'")
      .get() as { name: string } | undefined;
    expect(index?.name).toBe('idx_experiment_seed_tasks_experiment');
    db.close();
  });

  it('defaults created_at and accepts a valid A/B row', () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration('051_experiment_seed_tasks.sql'));
    db.prepare(
      "INSERT INTO experiment_seed_tasks (experiment_id, arm, original_task_id, clone_task_id) VALUES ('exp1', 'A', 'o1', 'c1')",
    ).run();
    const row = db
      .prepare('SELECT arm, created_at FROM experiment_seed_tasks WHERE clone_task_id = ?')
      .get('c1') as { arm: string; created_at: string };
    expect(row.arm).toBe('A');
    expect(typeof row.created_at).toBe('string');
    expect(row.created_at.length).toBeGreaterThan(0);
    db.close();
  });

  it('rejects an arm outside (A,B)', () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration('051_experiment_seed_tasks.sql'));
    expect(() =>
      db
        .prepare(
          "INSERT INTO experiment_seed_tasks (experiment_id, arm, original_task_id, clone_task_id) VALUES ('exp1', 'C', 'o1', 'c1')",
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it('enforces UNIQUE(experiment_id, arm, original_task_id)', () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration('051_experiment_seed_tasks.sql'));
    db.prepare(
      "INSERT INTO experiment_seed_tasks (experiment_id, arm, original_task_id, clone_task_id) VALUES ('exp1', 'A', 'o1', 'c1')",
    ).run();
    // Same (experiment, arm, original) but a different clone id → rejected.
    expect(() =>
      db
        .prepare(
          "INSERT INTO experiment_seed_tasks (experiment_id, arm, original_task_id, clone_task_id) VALUES ('exp1', 'A', 'o1', 'c2')",
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it('enforces UNIQUE(clone_task_id)', () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration('051_experiment_seed_tasks.sql'));
    db.prepare(
      "INSERT INTO experiment_seed_tasks (experiment_id, arm, original_task_id, clone_task_id) VALUES ('exp1', 'A', 'o1', 'c1')",
    ).run();
    // A clone id can only belong to one mapping row (even across arms/experiments).
    expect(() =>
      db
        .prepare(
          "INSERT INTO experiment_seed_tasks (experiment_id, arm, original_task_id, clone_task_id) VALUES ('exp1', 'B', 'o1', 'c1')",
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it('allows the SAME original task cloned once per arm (A and B)', () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration('051_experiment_seed_tasks.sql'));
    db.prepare(
      "INSERT INTO experiment_seed_tasks (experiment_id, arm, original_task_id, clone_task_id) VALUES ('exp1', 'A', 'o1', 'cA1')",
    ).run();
    // Same original, other arm, distinct clone → allowed (one clone per arm).
    expect(() =>
      db
        .prepare(
          "INSERT INTO experiment_seed_tasks (experiment_id, arm, original_task_id, clone_task_id) VALUES ('exp1', 'B', 'o1', 'cB1')",
        )
        .run(),
    ).not.toThrow();
    const n = db.prepare("SELECT COUNT(*) AS n FROM experiment_seed_tasks WHERE experiment_id = 'exp1'").get() as {
      n: number;
    };
    expect(n.n).toBe(2);
    db.close();
  });
});
