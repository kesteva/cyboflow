/**
 * Integration tests for migration 019_workflow_run_session_id.sql
 * (session<->run restructure, Phase 0).
 *
 * Applies 006_cyboflow_schema.sql → 011_workflow_step_tracking.sql → a minimal
 * inline `sessions` table (006 does not create one, but the backfill UPDATE reads
 * sessions.id / sessions.run_id) → 019_workflow_run_session_id.sql against an
 * in-memory SQLite instance. This proves the SQL file itself is correct — not a
 * hard-coded inline string — and guards against column-type / index typos.
 *
 * Targets:
 *  1. Applying 006→011→sessions→019 adds session_id TEXT (nullable, no default) to workflow_runs.
 *  2. A row inserted WITHOUT a session_id reads back NULL (existing rows unaffected).
 *  3. An explicit session_id round-trips.
 *  4. BACKFILL — a run that an existing sessions.run_id points at gets that session's
 *     id copied forward into workflow_runs.session_id when 019 runs.
 *  5. The idx_workflow_runs_session_id index exists after 019.
 *  6. Re-executing 019 raises 'duplicate column name: session_id' SqliteError
 *     (the idempotency signal that runFileBasedMigrations uses to skip
 *     already-applied files).
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

/**
 * Minimal stand-in for the inherited `sessions` table — 006_cyboflow_schema.sql
 * declares only the orchestrator tables, but migration 019's backfill UPDATE reads
 * sessions.id and sessions.run_id (added in migration 009 against the legacy schema).
 */
function createSessionsTable(db: Database.Database): void {
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, run_id TEXT)');
}

/** Seed a workflow row so the workflow_runs FK is satisfied. */
function seedWorkflow(db: Database.Database): void {
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json)
     VALUES ('wf-1', 1, 'test-wf', '{}')`,
  ).run();
}

/**
 * Apply the schema up to (but NOT including) 019, plus a minimal sessions table.
 * Callers may seed rows before running 019 themselves (see the backfill case).
 */
function applyBase(): Database.Database {
  const db = new Database(':memory:');
  db.exec(readMigration('006_cyboflow_schema.sql'));
  db.exec(readMigration('011_workflow_step_tracking.sql'));
  createSessionsTable(db);
  return db;
}

/** Apply the full chain 006→011→sessions→019. */
function applyMigrations(): Database.Database {
  const db = applyBase();
  db.exec(readMigration('019_workflow_run_session_id.sql'));
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

interface IndexListRow {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

describe('Migration 019: session_id column on workflow_runs', () => {
  it('adds session_id TEXT (nullable, no default) to workflow_runs', () => {
    const db = applyMigrations();

    const rows = db
      .prepare('PRAGMA table_info(workflow_runs)')
      .all() as TableInfoRow[];

    const col = rows.find((r) => r.name === 'session_id');

    expect(col).toBeDefined();
    expect(String(col!.type).toUpperCase()).toBe('TEXT');
    // notnull=0 means the column is nullable
    expect(col!.notnull).toBe(0);
    // No default literal
    expect(col!.dflt_value).toBeNull();

    db.close();
  });

  it('a row inserted WITHOUT a session_id reads back NULL', () => {
    const db = applyMigrations();
    seedWorkflow(db);

    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
       VALUES ('wr-none', 'wf-1', 1, 'queued', 'default')`,
    ).run();

    const row = db
      .prepare('SELECT session_id FROM workflow_runs WHERE id = ?')
      .get('wr-none') as { session_id: string | null };

    expect(row.session_id).toBeNull();

    db.close();
  });

  it('round-trips an explicit session_id value', () => {
    const db = applyMigrations();
    seedWorkflow(db);

    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id)
       VALUES ('wr-seeded', 'wf-1', 1, 'queued', 'default', 'sess-abc-123')`,
    ).run();

    const row = db
      .prepare('SELECT session_id FROM workflow_runs WHERE id = ?')
      .get('wr-seeded') as { session_id: string | null };

    expect(row.session_id).toBe('sess-abc-123');

    db.close();
  });

  it('backfills session_id from an existing sessions.run_id back-reference', () => {
    // Seed the run + owning session BEFORE 019 runs so the backfill UPDATE has
    // something to copy forward.
    const db = applyBase();
    seedWorkflow(db);

    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
       VALUES ('wr-x', 'wf-1', 1, 'queued', 'default')`,
    ).run();
    db.prepare(`INSERT INTO sessions (id, run_id) VALUES ('sess-1', 'wr-x')`).run();

    db.exec(readMigration('019_workflow_run_session_id.sql'));

    const row = db
      .prepare('SELECT session_id FROM workflow_runs WHERE id = ?')
      .get('wr-x') as { session_id: string | null };

    expect(row.session_id).toBe('sess-1');

    db.close();
  });

  it('creates the idx_workflow_runs_session_id index', () => {
    const db = applyMigrations();

    const indexes = db
      .prepare('PRAGMA index_list(workflow_runs)')
      .all() as IndexListRow[];

    const idx = indexes.find((i) => i.name === 'idx_workflow_runs_session_id');

    expect(idx).toBeDefined();

    db.close();
  });

  it('re-executing migration 019 raises duplicate column name: session_id', () => {
    const db = applyMigrations();

    expect(() => {
      db.exec(readMigration('019_workflow_run_session_id.sql'));
    }).toThrow(/duplicate column name: session_id/i);

    db.close();
  });
});
