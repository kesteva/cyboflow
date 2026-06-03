/**
 * Integration tests for migration 018_run_claude_session.sql (idle-chat nudge / resume).
 *
 * Applies 006_cyboflow_schema.sql → 011_workflow_step_tracking.sql →
 * 018_run_claude_session.sql against an in-memory SQLite instance. This proves the SQL
 * file itself is correct — not a hard-coded inline string — and guards against
 * column-type typos.
 *
 * Targets:
 *  1. Applying 006→011→018 adds claude_session_id TEXT (nullable, no default) to workflow_runs.
 *  2. A row inserted WITHOUT a claude_session_id reads back NULL (existing rows unaffected).
 *  3. An explicit claude_session_id round-trips.
 *  4. Re-executing 018 raises 'duplicate column name: claude_session_id' SqliteError
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

function applyMigrations(): Database.Database {
  const db = new Database(':memory:');
  db.exec(readMigration('006_cyboflow_schema.sql'));
  db.exec(readMigration('011_workflow_step_tracking.sql'));
  db.exec(readMigration('018_run_claude_session.sql'));
  return db;
}

/** Seed a workflow row so the workflow_runs FK is satisfied. */
function seedWorkflow(db: Database.Database): void {
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json)
     VALUES ('wf-1', 1, 'test-wf', '{}')`,
  ).run();
}

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

describe('Migration 018: claude_session_id column on workflow_runs', () => {
  it('adds claude_session_id TEXT (nullable, no default) to workflow_runs', () => {
    const db = applyMigrations();

    const rows = db
      .prepare('PRAGMA table_info(workflow_runs)')
      .all() as TableInfoRow[];

    const col = rows.find((r) => r.name === 'claude_session_id');

    expect(col).toBeDefined();
    expect(String(col!.type).toUpperCase()).toBe('TEXT');
    // notnull=0 means the column is nullable
    expect(col!.notnull).toBe(0);
    // No default literal
    expect(col!.dflt_value).toBeNull();

    db.close();
  });

  it('a row inserted WITHOUT a claude_session_id reads back NULL', () => {
    const db = applyMigrations();
    seedWorkflow(db);

    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
       VALUES ('wr-none', 'wf-1', 1, 'queued', 'default')`,
    ).run();

    const row = db
      .prepare('SELECT claude_session_id FROM workflow_runs WHERE id = ?')
      .get('wr-none') as { claude_session_id: string | null };

    expect(row.claude_session_id).toBeNull();

    db.close();
  });

  it('round-trips an explicit claude_session_id value', () => {
    const db = applyMigrations();
    seedWorkflow(db);

    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, claude_session_id)
       VALUES ('wr-seeded', 'wf-1', 1, 'queued', 'default', 'sess-abc-123')`,
    ).run();

    const row = db
      .prepare('SELECT claude_session_id FROM workflow_runs WHERE id = ?')
      .get('wr-seeded') as { claude_session_id: string | null };

    expect(row.claude_session_id).toBe('sess-abc-123');

    db.close();
  });

  it('re-executing migration 018 raises duplicate column name: claude_session_id', () => {
    const db = applyMigrations();

    expect(() => {
      db.exec(readMigration('018_run_claude_session.sql'));
    }).toThrow(/duplicate column name: claude_session_id/i);

    db.close();
  });
});
