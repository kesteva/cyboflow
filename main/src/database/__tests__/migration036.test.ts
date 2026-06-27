/**
 * Migration 036_visual_verification.sql — schema + constraint integration tests.
 *
 * Applies 006 -> 011 -> 014 -> 015 -> 016 -> 036 against an in-memory SQLite
 * instance. Proves:
 *   1. workflow_runs gains the 3 immutable verify_* stamp columns with the spec'd
 *      defaults (verify_enabled=0, verify_type=NULL, verify_chain=NULL).
 *   2. verification_requests exists with every spec'd column + both indexes.
 *   3. The status CHECK rejects a bogus status and accepts every REQUEST_STATUS value.
 *   4. run_id FK CASCADEs: deleting a run deletes its verification_requests.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REQUEST_STATUS } from '../../../../shared/types/visualVerification';

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

const THROUGH_016 = [
  '006_cyboflow_schema.sql',
  '011_workflow_step_tracking.sql',
  '014_native_tasks.sql',
  '015_entity_model_rebuild.sql',
  '016_review_items.sql',
];

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  seedProject(db);
  apply(db, [...THROUGH_016, '036_visual_verification.sql']);
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

function insertRequest(
  db: Database.Database,
  id: string,
  overrides: Partial<{ runId: string; status: string; verifyType: string }> = {},
): void {
  db.prepare(
    `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json)
     VALUES (?, ?, 1, ?, ?, ?)`,
  ).run(
    id,
    overrides.runId ?? 'run-1',
    overrides.status ?? 'queued',
    overrides.verifyType ?? 'static-render-snapshot',
    '{"intent":"looks right"}',
  );
}

describe('Migration 036: verify run-stamp columns + verification_requests', () => {
  it('adds the 3 verify_* columns to workflow_runs with the spec defaults', () => {
    const db = buildDb();
    const cols = db.prepare('PRAGMA table_info(workflow_runs)').all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const byName = new Map(cols.map((c) => [c.name, c]));

    const enabled = byName.get('verify_enabled');
    expect(enabled).toBeDefined();
    expect(enabled?.type).toBe('INTEGER');
    expect(enabled?.notnull).toBe(1);
    expect(enabled?.dflt_value).toBe('0');

    const vtype = byName.get('verify_type');
    expect(vtype).toBeDefined();
    expect(vtype?.type).toBe('TEXT');
    expect(vtype?.notnull).toBe(0);
    expect(vtype?.dflt_value).toBeNull();

    const vchain = byName.get('verify_chain');
    expect(vchain).toBeDefined();
    expect(vchain?.type).toBe('TEXT');
    expect(vchain?.notnull).toBe(0);
    expect(vchain?.dflt_value).toBeNull();

    db.close();
  });

  it('legacy rows read back verify_enabled=0, verify_type=NULL, verify_chain=NULL', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const row = db
      .prepare('SELECT verify_enabled, verify_type, verify_chain FROM workflow_runs WHERE id = ?')
      .get('run-1') as {
      verify_enabled: number;
      verify_type: string | null;
      verify_chain: string | null;
    };
    expect(row.verify_enabled).toBe(0);
    expect(row.verify_type).toBeNull();
    expect(row.verify_chain).toBeNull();
    db.close();
  });

  it('creates verification_requests with the spec columns', () => {
    const db = buildDb();
    const cols = (db.prepare('PRAGMA table_info(verification_requests)').all() as { name: string }[])
      .map((r) => r.name)
      .sort();
    expect(cols).toEqual(
      [
        'id', 'run_id', 'project_id', 'status', 'verify_type', 'deliverable_json',
        'chain_json', 'current_backend', 'attempt', 'verdict_json', 'error_message',
        'enqueued_at', 'leased_at', 'ended_at',
      ].sort(),
    );
    db.close();
  });

  it('creates both documented indexes', () => {
    const db = buildDb();
    const idx = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'verification_requests'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(idx).toContain('idx_verification_requests_status');
    expect(idx).toContain('idx_verification_requests_run');
    db.close();
  });

  it('status defaults to queued and attempt to 0', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    db.prepare(
      `INSERT INTO verification_requests (id, run_id, project_id, verify_type, deliverable_json)
       VALUES ('vr_def', 'run-1', 1, 'static-render-snapshot', '{"intent":"x"}')`,
    ).run();
    const row = db
      .prepare('SELECT status, attempt FROM verification_requests WHERE id = ?')
      .get('vr_def') as { status: string; attempt: number };
    expect(row.status).toBe('queued');
    expect(row.attempt).toBe(0);
    db.close();
  });

  it('status CHECK rejects a bogus status, accepts every REQUEST_STATUS value', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    expect(() => insertRequest(db, 'vr_bad', { status: 'nonsense' })).toThrow(/CHECK/i);
    REQUEST_STATUS.forEach((s, i) => {
      expect(() => insertRequest(db, `vr_ok_${i}`, { status: s })).not.toThrow();
    });
    db.close();
  });

  it('run_id FK CASCADEs — deleting a run deletes its verification_requests', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    insertRequest(db, 'vr_c', {});
    db.prepare("DELETE FROM workflow_runs WHERE id = 'run-1'").run();
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM verification_requests').get() as { n: number }).n,
    ).toBe(0);
    db.close();
  });
});
