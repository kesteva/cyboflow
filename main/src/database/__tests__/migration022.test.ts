/**
 * Integration tests for migration 022_sprint_batches.sql (feat/parallel-sprint).
 *
 * Applies 006_cyboflow_schema.sql → 022_sprint_batches.sql against an in-memory
 * SQLite instance. Proves the SQL file is correct (not a hard-coded inline string)
 * and guards against column-type / index / CHECK typos.
 *
 * Targets:
 *  1. sprint_batches + sprint_batch_tasks tables created with the expected columns.
 *  2. workflow_runs gains a nullable batch_id TEXT column (existing rows unaffected).
 *  3. The status CHECK constraints reject an out-of-domain value.
 *  4. The UNIQUE(batch_id, task_id) constraint rejects a duplicate membership.
 *  5. The three new indexes exist.
 *  6. Re-executing 022 raises 'duplicate column name: batch_id' (the idempotency
 *     signal runFileBasedMigrations uses to skip already-applied files).
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

function applyBase(): Database.Database {
  const db = new Database(':memory:');
  db.exec(readMigration('006_cyboflow_schema.sql'));
  return db;
}

function applyMigrations(): Database.Database {
  const db = applyBase();
  db.exec(readMigration('022_sprint_batches.sql'));
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

function columns(db: Database.Database, table: string): TableInfoRow[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[];
}

function indexNames(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

describe('Migration 022: sprint batches', () => {
  it('creates sprint_batches with the expected columns', () => {
    const db = applyMigrations();
    const cols = columns(db, 'sprint_batches').map((c) => c.name);
    for (const expected of [
      'id',
      'project_id',
      'substrate',
      'status',
      'integration_branch',
      'base_branch',
      'base_sha',
      'concurrency',
      'init_run_id',
      'finalize_run_id',
      'completed_at',
    ]) {
      expect(cols).toContain(expected);
    }
    db.close();
  });

  it('creates sprint_batch_tasks with the expected columns + UNIQUE(batch_id, task_id)', () => {
    const db = applyMigrations();
    const cols = columns(db, 'sprint_batch_tasks').map((c) => c.name);
    for (const expected of ['id', 'batch_id', 'task_id', 'status', 'run_id', 'integrated_at']) {
      expect(cols).toContain(expected);
    }

    db.prepare("INSERT INTO sprint_batches (id, project_id) VALUES ('b1', 1)").run();
    db.prepare("INSERT INTO sprint_batch_tasks (batch_id, task_id) VALUES ('b1', 't1')").run();
    expect(() =>
      db.prepare("INSERT INTO sprint_batch_tasks (batch_id, task_id) VALUES ('b1', 't1')").run(),
    ).toThrow(/UNIQUE/i);
    db.close();
  });

  it('adds a nullable batch_id TEXT column to workflow_runs', () => {
    const db = applyMigrations();
    const col = columns(db, 'workflow_runs').find((c) => c.name === 'batch_id');
    expect(col).toBeDefined();
    expect(String(col!.type).toUpperCase()).toBe('TEXT');
    expect(col!.notnull).toBe(0);
    expect(col!.dflt_value).toBeNull();
    db.close();
  });

  it('rejects an out-of-domain sprint_batches.status', () => {
    const db = applyMigrations();
    expect(() =>
      db.prepare("INSERT INTO sprint_batches (id, project_id, status) VALUES ('b2', 1, 'bogus')").run(),
    ).toThrow(/CHECK/i);
    db.close();
  });

  it('rejects an out-of-domain sprint_batch_tasks.status', () => {
    const db = applyMigrations();
    db.prepare("INSERT INTO sprint_batches (id, project_id) VALUES ('b3', 1)").run();
    expect(() =>
      db
        .prepare("INSERT INTO sprint_batch_tasks (batch_id, task_id, status) VALUES ('b3', 't1', 'bogus')")
        .run(),
    ).toThrow(/CHECK/i);
    db.close();
  });

  it('creates the new indexes', () => {
    const db = applyMigrations();
    expect(indexNames(db, 'sprint_batches')).toContain('idx_sprint_batches_status');
    expect(indexNames(db, 'sprint_batch_tasks')).toContain('idx_sprint_batch_tasks_batch');
    expect(indexNames(db, 'workflow_runs')).toContain('idx_workflow_runs_batch_id');
    db.close();
  });

  it('re-executing migration 022 raises duplicate column name: batch_id', () => {
    const db = applyMigrations();
    expect(() => {
      db.exec(readMigration('022_sprint_batches.sql'));
    }).toThrow(/duplicate column name: batch_id/i);
    db.close();
  });
});
