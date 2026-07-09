/**
 * Integration tests for migration 058_rotation_experiments.sql (A/B testing).
 *
 * 058 makes ROTATIONS first-class experiment records: it rebuilds `experiments`
 * with a widened kind CHECK ('side_by_side','rotation'), a widened status CHECK
 * (adds 'superseded'), and relaxed NOT NULLs on
 * project_id/base_branch/base_sha/variant_a_id/variant_b_id; adds the
 * `experiment_rotation_arms` arm-set snapshot table; and adds
 * `workflow_runs.rotation_experiment_id` (SEPARATE from experiment_id per the
 * migration's CRITICAL INVARIANT).
 *
 * buildDb() constructs the PRE-058 shape by hand (experiments exactly per 049+052,
 * a minimal workflow_runs) and applies the migration via the production transaction
 * wrapper — the PRAGMA foreign_keys toggle is handled OUTSIDE the transaction by
 * database.ts in production, so this harness (matching migration054.test.ts) does
 * not fire it; the in-memory DB defaults to foreign_keys OFF, which is exactly the
 * state the rebuild recipe assumes.
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

/** The pre-058 experiments shape — 049 columns in order + 052's three appended. */
function buildDb(): Database.Database {
  const db = new Database(':memory:');
  // Minimal workflow_runs (only the columns the migration's ALTER touches matter).
  db.exec(
    `CREATE TABLE workflow_runs (
       id           TEXT PRIMARY KEY,
       workflow_id  TEXT NOT NULL,
       status       TEXT NOT NULL DEFAULT 'running'
     );`,
  );
  // experiments EXACTLY as 049 created it + 052's three ALTER columns appended.
  db.exec(
    `CREATE TABLE experiments (
       id                    TEXT PRIMARY KEY,
       project_id            INTEGER NOT NULL,
       workflow_id           TEXT NOT NULL,
       kind                  TEXT NOT NULL DEFAULT 'side_by_side'
                               CHECK (kind IN ('side_by_side')),
       base_branch           TEXT NOT NULL,
       base_sha              TEXT NOT NULL,
       variant_a_id          TEXT NOT NULL,
       variant_b_id          TEXT NOT NULL,
       run_a_id              TEXT,
       run_b_id              TEXT,
       session_a_id          TEXT,
       session_b_id          TEXT,
       seed_idea_id          TEXT,
       seed_idea_clone_a_id  TEXT,
       seed_idea_clone_b_id  TEXT,
       status                TEXT NOT NULL DEFAULT 'running'
                               CHECK (status IN ('running','grading','decided','abandoned')),
       winner_run_id         TEXT,
       winner_arm            TEXT CHECK (winner_arm IN ('A','B')),
       merge_sha             TEXT,
       decided_at            TEXT,
       rerun_of_experiment_id TEXT,
       created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
       promoted_variant_id   TEXT,
       promoted_arm          TEXT CHECK (promoted_arm IN ('A','B')),
       promoted_at           TEXT
     );
     CREATE INDEX idx_experiments_project ON experiments(project_id);
     CREATE INDEX idx_experiments_status  ON experiments(status);`,
  );
  return db;
}

/** Seed three side-by-side rows spanning distinct statuses. */
function seedExperiments(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT INTO experiments
       (id, project_id, workflow_id, kind, base_branch, base_sha, variant_a_id, variant_b_id,
        run_a_id, run_b_id, status, winner_run_id, winner_arm, decided_at,
        promoted_variant_id, promoted_arm, promoted_at, created_at, updated_at)
     VALUES (@id, @project_id, @workflow_id, 'side_by_side', @base_branch, @base_sha,
             @variant_a_id, @variant_b_id, @run_a_id, @run_b_id, @status, @winner_run_id,
             @winner_arm, @decided_at, @promoted_variant_id, @promoted_arm, @promoted_at,
             @created_at, @updated_at)`,
  );
  insert.run({
    id: 'exp_running', project_id: 1, workflow_id: 'wf-1', base_branch: 'main', base_sha: 'sha1',
    variant_a_id: '__baseline__', variant_b_id: 'wfv_a', run_a_id: null, run_b_id: null,
    status: 'running', winner_run_id: null, winner_arm: null, decided_at: null,
    promoted_variant_id: null, promoted_arm: null, promoted_at: null,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  });
  insert.run({
    id: 'exp_decided', project_id: 2, workflow_id: 'wf-2', base_branch: 'main', base_sha: 'sha2',
    variant_a_id: 'wfv_x', variant_b_id: 'wfv_y', run_a_id: 'run-a', run_b_id: 'run-b',
    status: 'decided', winner_run_id: 'run-a', winner_arm: 'A', decided_at: '2026-01-02T00:00:00.000Z',
    promoted_variant_id: 'wfv_x', promoted_arm: 'A', promoted_at: '2026-01-02T01:00:00.000Z',
    created_at: '2026-01-02T00:00:00.000Z', updated_at: '2026-01-02T01:00:00.000Z',
  });
  insert.run({
    id: 'exp_abandoned', project_id: 1, workflow_id: 'wf-1', base_branch: 'dev', base_sha: 'sha3',
    variant_a_id: 'wfv_p', variant_b_id: '__baseline__', run_a_id: null, run_b_id: null,
    status: 'abandoned', winner_run_id: null, winner_arm: null, decided_at: null,
    promoted_variant_id: null, promoted_arm: null, promoted_at: null,
    created_at: '2026-01-03T00:00:00.000Z', updated_at: '2026-01-03T00:00:00.000Z',
  });
}

const MIGRATION = '058_rotation_experiments.sql';

describe('Migration 058: rotation experiments', () => {
  it('(a) applies cleanly through the production transaction wrapper', () => {
    const db = buildDb();
    seedExperiments(db);
    expect(() => runMigrationViaProductionPath(db, readMigration(MIGRATION))).not.toThrow();
    db.close();
  });

  it('(b) preserves pre-existing rows with every column value identical', () => {
    const db = buildDb();
    seedExperiments(db);
    const before = db.prepare('SELECT * FROM experiments ORDER BY id').all();
    runMigrationViaProductionPath(db, readMigration(MIGRATION));
    const after = db.prepare('SELECT * FROM experiments ORDER BY id').all();
    expect(after).toEqual(before);
    db.close();
  });

  it('(c) accepts a rotation row with NULL relaxed columns + an UPDATE to superseded', () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration(MIGRATION));
    expect(() =>
      db
        .prepare(
          `INSERT INTO experiments
             (id, project_id, workflow_id, kind, base_branch, base_sha, variant_a_id, variant_b_id, status)
           VALUES ('exp_rot', NULL, 'wf-global', 'rotation', NULL, NULL, NULL, NULL, 'running')`,
        )
        .run(),
    ).not.toThrow();
    const row = db
      .prepare('SELECT project_id, base_branch, base_sha, variant_a_id, variant_b_id, kind FROM experiments WHERE id = ?')
      .get('exp_rot') as {
      project_id: number | null;
      base_branch: string | null;
      base_sha: string | null;
      variant_a_id: string | null;
      variant_b_id: string | null;
      kind: string;
    };
    expect(row).toEqual({
      project_id: null, base_branch: null, base_sha: null,
      variant_a_id: null, variant_b_id: null, kind: 'rotation',
    });
    db.prepare("UPDATE experiments SET status = 'superseded' WHERE id = ?").run('exp_rot');
    const status = db.prepare('SELECT status FROM experiments WHERE id = ?').get('exp_rot') as { status: string };
    expect(status.status).toBe('superseded');
    db.close();
  });

  it('(d) still rejects bogus kind and status values via the CHECKs', () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration(MIGRATION));
    expect(() =>
      db
        .prepare(
          `INSERT INTO experiments (id, workflow_id, kind, status) VALUES ('bad_kind', 'wf', 'bogus', 'running')`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO experiments (id, workflow_id, kind, status) VALUES ('bad_status', 'wf', 'rotation', 'bogus')`,
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it('(e) creates experiment_rotation_arms with the expected columns + composite-PK dedupe', () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration(MIGRATION));
    const cols = (db.prepare('PRAGMA table_info(experiment_rotation_arms)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toEqual(['experiment_id', 'variant_id', 'label', 'weight_at_open', 'created_at']);
    db.prepare(
      `INSERT INTO experiment_rotation_arms (experiment_id, variant_id, label, weight_at_open)
       VALUES ('exp_rot', '__baseline__', 'Baseline', 2)`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO experiment_rotation_arms (experiment_id, variant_id, label, weight_at_open)
           VALUES ('exp_rot', '__baseline__', 'Baseline dup', 3)`,
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it('(f) adds workflow_runs.rotation_experiment_id and it is writable', () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration(MIGRATION));
    const cols = (db.prepare('PRAGMA table_info(workflow_runs)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('rotation_experiment_id');
    db.prepare("INSERT INTO workflow_runs (id, workflow_id, status) VALUES ('r1', 'wf-1', 'running')").run();
    db.prepare("UPDATE workflow_runs SET rotation_experiment_id = 'exp_rot' WHERE id = 'r1'").run();
    const row = db.prepare('SELECT rotation_experiment_id AS rid FROM workflow_runs WHERE id = ?').get('r1') as {
      rid: string | null;
    };
    expect(row.rid).toBe('exp_rot');
    db.close();
  });

  it('(g) recreates all three experiments indexes', () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration(MIGRATION));
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'experiments'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain('idx_experiments_project');
    expect(indexes).toContain('idx_experiments_status');
    expect(indexes).toContain('idx_experiments_workflow_kind');
    db.close();
  });
});
