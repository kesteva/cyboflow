/**
 * Integration tests for migration 011_workflow_step_tracking.sql (TASK-764).
 *
 * Applies 006_cyboflow_schema.sql then 011_workflow_step_tracking.sql against
 * an in-memory SQLite instance. This proves the SQL file itself is correct —
 * not a hard-coded inline string — and guards against column-type or name typos.
 *
 * The three test_strategy.targets from the plan frontmatter:
 *  1. Applying 006 then 011 adds current_step_id TEXT (nullable) to workflow_runs.
 *  2. current_step_id accepts NULL and string values (round-trip insert/select).
 *  3. Re-executing 011 raises 'duplicate column name: current_step_id' SqliteError
 *     (the idempotency signal that runFileBasedMigrations uses to skip already-applied files).
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Helper: open a fresh in-memory DB and apply migrations 006 and 011
// ---------------------------------------------------------------------------

function applyMigrations006And011(): Database.Database {
  const db = new Database(':memory:');

  const sql006 = readFileSync(
    join(__dirname, '..', 'migrations', '006_cyboflow_schema.sql'),
    'utf-8'
  );
  db.exec(sql006);

  const sql011 = readFileSync(
    join(__dirname, '..', 'migrations', '011_workflow_step_tracking.sql'),
    'utf-8'
  );
  db.exec(sql011);

  return db;
}

// ---------------------------------------------------------------------------
// PRAGMA table_info row shape returned by better-sqlite3
// ---------------------------------------------------------------------------

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Migration 011: current_step_id column on workflow_runs', () => {
  it('adds current_step_id TEXT (nullable) to workflow_runs', () => {
    const db = applyMigrations006And011();

    const rows = db
      .prepare('PRAGMA table_info(workflow_runs)')
      .all() as TableInfoRow[];

    const col = rows.find((r) => r.name === 'current_step_id');

    expect(col).toBeDefined();
    expect(String(col!.type).toUpperCase()).toBe('TEXT');
    // notnull=0 means the column is nullable
    expect(col!.notnull).toBe(0);

    db.close();
  });

  it('round-trips NULL and string values for current_step_id', () => {
    const db = applyMigrations006And011();

    // Seed a workflow to satisfy the FK on workflow_runs.workflow_id
    db.prepare(
      `INSERT INTO workflows (id, project_id, name, spec_json)
       VALUES ('wf-1', 1, 'test-wf', '{}')`
    ).run();

    // Insert a run with current_step_id = NULL
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, current_step_id)
       VALUES ('wr-null', 'wf-1', 1, 'queued', 'default', NULL)`
    ).run();

    // Insert a run with a concrete dotted-string step id
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, current_step_id)
       VALUES ('wr-step', 'wf-1', 1, 'running', 'default', 'execute.implement')`
    ).run();

    const rowNull = db
      .prepare('SELECT current_step_id FROM workflow_runs WHERE id = ?')
      .get('wr-null') as { current_step_id: string | null };

    const rowStep = db
      .prepare('SELECT current_step_id FROM workflow_runs WHERE id = ?')
      .get('wr-step') as { current_step_id: string | null };

    expect(rowNull.current_step_id).toBeNull();
    expect(rowStep.current_step_id).toBe('execute.implement');

    db.close();
  });

  it('re-executing migration 011 raises duplicate column name: current_step_id', () => {
    const db = applyMigrations006And011();

    const sql011 = readFileSync(
      join(__dirname, '..', 'migrations', '011_workflow_step_tracking.sql'),
      'utf-8'
    );

    // SQLite raises this error when ALTER TABLE ADD COLUMN names an already-existing column.
    // runFileBasedMigrations catches this message as the idempotency signal.
    expect(() => {
      db.exec(sql011);
    }).toThrow(/duplicate column name: current_step_id/i);

    db.close();
  });
});
