/**
 * Migration 078_verification_agent_requests.sql — schema + default integration tests.
 *
 * Applies 006 -> 011 -> 014 -> 015 -> 016 -> 055 -> 056 -> 078 against an
 * in-memory SQLite instance (mirrors migration056.test.ts EXACTLY, extended
 * through 056 since 078 ALTERs the same table 056 already widened). Proves:
 *   1. verification_requests gains task_json / report_json / delivery_state /
 *      snapshot_sha / enqueue_key, all TEXT and NULLABLE (additive, §5.8
 *      rollback posture).
 *   2. Existing (pre-078) rows read back all five as NULL.
 *   3. A dual-write row (task_json + snapshot_sha + enqueue_key set) round-trips.
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

const THROUGH_056 = [
  '006_cyboflow_schema.sql',
  '011_workflow_step_tracking.sql',
  '014_native_tasks.sql',
  '015_entity_model_rebuild.sql',
  '016_review_items.sql',
  '055_visual_verification.sql',
  '056_visual_verify_budget.sql',
];

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  seedProject(db);
  apply(db, [...THROUGH_056, '078_verification_agent_requests.sql']);
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

type ColInfo = { name: string; type: string; notnull: number; dflt_value: string | null };

describe('Migration 078: verification-agent dual-format request plumbing', () => {
  it('adds task_json / report_json / delivery_state / snapshot_sha / enqueue_key as NULLABLE TEXT', () => {
    const db = buildDb();
    const cols = db.prepare('PRAGMA table_info(verification_requests)').all() as ColInfo[];
    const byName = new Map(cols.map((c) => [c.name, c]));
    for (const name of ['task_json', 'report_json', 'delivery_state', 'snapshot_sha', 'enqueue_key']) {
      const col = byName.get(name);
      expect(col, `expected column ${name} to exist`).toBeDefined();
      expect(col?.type).toBe('TEXT');
      // Nullable (not NOT NULL) — additive rollback posture (§5.8).
      expect(col?.notnull).toBe(0);
      expect(col?.dflt_value).toBeNull();
    }
    db.close();
  });

  it('an existing (pre-078-shaped) row reads back all five new columns as NULL', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    db.prepare(
      `INSERT INTO verification_requests (id, run_id, project_id, verify_type, deliverable_json)
       VALUES ('vr_legacy', 'run-1', 1, 'static-render-snapshot', '{"intent":"x"}')`,
    ).run();
    const row = db
      .prepare(
        'SELECT task_json, report_json, delivery_state, snapshot_sha, enqueue_key FROM verification_requests WHERE id = ?',
      )
      .get('vr_legacy') as {
      task_json: string | null;
      report_json: string | null;
      delivery_state: string | null;
      snapshot_sha: string | null;
      enqueue_key: string | null;
    };
    expect(row.task_json).toBeNull();
    expect(row.report_json).toBeNull();
    expect(row.delivery_state).toBeNull();
    expect(row.snapshot_sha).toBeNull();
    expect(row.enqueue_key).toBeNull();
    db.close();
  });

  it('a dual-write row (task_json + snapshot_sha + enqueue_key set at enqueue) round-trips', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const taskJson = JSON.stringify({ version: 1, summary: 'check the button', behaviors: [] });
    db.prepare(
      `INSERT INTO verification_requests
         (id, run_id, project_id, verify_type, deliverable_json, task_json, snapshot_sha, enqueue_key)
       VALUES ('vr_dual', 'run-1', 1, 'static-render-snapshot', '{"intent":"check the button"}', ?, ?, ?)`,
    ).run(taskJson, 'abc123sha', 'run-1:TASK-008:1');
    const row = db
      .prepare('SELECT task_json, snapshot_sha, enqueue_key FROM verification_requests WHERE id = ?')
      .get('vr_dual') as { task_json: string | null; snapshot_sha: string | null; enqueue_key: string | null };
    expect(row.task_json).toBe(taskJson);
    expect(row.snapshot_sha).toBe('abc123sha');
    expect(row.enqueue_key).toBe('run-1:TASK-008:1');
    db.close();
  });

  it('is idempotent / re-run-guarded — re-applying raises the duplicate-column signal', () => {
    const db = buildDb();
    expect(() => apply(db, ['078_verification_agent_requests.sql'])).toThrow(/duplicate column name/i);
    db.close();
  });
});
