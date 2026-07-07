/**
 * Migration 056_visual_verify_budget.sql — schema + default integration tests.
 *
 * Applies 006 -> 011 -> 014 -> 015 -> 016 -> 055 -> 056 against an in-memory
 * SQLite instance (mirrors migration055.test.ts EXACTLY). Proves:
 *   1. projects gains visual_verify_budget_calls (INTEGER, NULLABLE = unlimited).
 *   2. verification_requests gains judge_calls_used (INTEGER NOT NULL DEFAULT 0).
 *   3. Existing rows read back the spec defaults (budget NULL, judge_calls_used 0).
 *   4. The file is idempotent / re-run-guarded: re-applying raises the
 *      'duplicate column name' signal runFileBasedMigrations() uses to skip it.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIG_DIR = join(__dirname, '..', 'migrations');

function seedProject(db: Database.Database): void {
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
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');
}

function apply(db: Database.Database, files: string[]): void {
  for (const f of files) db.exec(readFileSync(join(MIG_DIR, f), 'utf-8'));
}

const THROUGH_055 = [
  '006_cyboflow_schema.sql',
  '011_workflow_step_tracking.sql',
  '014_native_tasks.sql',
  '015_entity_model_rebuild.sql',
  '016_review_items.sql',
  '055_visual_verification.sql',
];

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  seedProject(db);
  apply(db, [...THROUGH_055, '056_visual_verify_budget.sql']);
  return db;
}

function seedRun(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'planner', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES (?, 'wf-1', 1, 'running', 'default')`,
  ).run(runId);
}

describe('Migration 049: visual-verify per-project budget + telemetry columns', () => {
  it('adds projects.visual_verify_budget_calls as a NULLABLE INTEGER (= unlimited)', () => {
    const db = buildDb();
    const cols = db.prepare('PRAGMA table_info(projects)').all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const budget = new Map(cols.map((c) => [c.name, c])).get('visual_verify_budget_calls');
    expect(budget).toBeDefined();
    expect(budget?.type).toBe('INTEGER');
    // Nullable (not NOT NULL) so an absent value means "unlimited".
    expect(budget?.notnull).toBe(0);
    expect(budget?.dflt_value).toBeNull();
    db.close();
  });

  it('adds verification_requests.judge_calls_used as INTEGER NOT NULL DEFAULT 0', () => {
    const db = buildDb();
    const cols = db.prepare('PRAGMA table_info(verification_requests)').all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const counter = new Map(cols.map((c) => [c.name, c])).get('judge_calls_used');
    expect(counter).toBeDefined();
    expect(counter?.type).toBe('INTEGER');
    expect(counter?.notnull).toBe(1);
    expect(counter?.dflt_value).toBe('0');
    db.close();
  });

  it('existing projects read back visual_verify_budget_calls = NULL (unlimited)', () => {
    const db = buildDb();
    const row = db
      .prepare('SELECT visual_verify_budget_calls FROM projects WHERE id = 1')
      .get() as { visual_verify_budget_calls: number | null };
    expect(row.visual_verify_budget_calls).toBeNull();
    db.close();
  });

  it('a new verification_requests row defaults judge_calls_used to 0', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    db.prepare(
      `INSERT INTO verification_requests (id, run_id, project_id, verify_type, deliverable_json)
       VALUES ('vr_def', 'run-1', 1, 'static-render-snapshot', '{"intent":"x"}')`,
    ).run();
    const row = db
      .prepare('SELECT judge_calls_used FROM verification_requests WHERE id = ?')
      .get('vr_def') as { judge_calls_used: number };
    expect(row.judge_calls_used).toBe(0);
    db.close();
  });

  it('the budget can be set + judge_calls_used incremented; SUM aggregates per project', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    db.prepare('UPDATE projects SET visual_verify_budget_calls = 3 WHERE id = 1').run();
    for (const [id, used] of [
      ['vr_a', 1],
      ['vr_b', 2],
    ] as const) {
      db.prepare(
        `INSERT INTO verification_requests (id, run_id, project_id, verify_type, deliverable_json, judge_calls_used)
         VALUES (?, 'run-1', 1, 'static-render-snapshot', '{"intent":"x"}', ?)`,
      ).run(id, used);
    }
    const budget = (
      db.prepare('SELECT visual_verify_budget_calls AS b FROM projects WHERE id = 1').get() as {
        b: number | null;
      }
    ).b;
    const usedSum = (
      db
        .prepare('SELECT COALESCE(SUM(judge_calls_used), 0) AS n FROM verification_requests WHERE project_id = 1')
        .get() as { n: number }
    ).n;
    expect(budget).toBe(3);
    expect(usedSum).toBe(3);
    db.close();
  });

  it('is idempotent / re-run-guarded — re-applying raises the duplicate-column signal', () => {
    const db = buildDb();
    // Re-running the same file MUST raise 'duplicate column name' (the signal
    // runFileBasedMigrations uses to skip an already-applied file), proving the
    // ALTERs are not silently re-runnable / corrupting.
    expect(() => apply(db, ['056_visual_verify_budget.sql'])).toThrow(/duplicate column name/i);
    db.close();
  });
});
