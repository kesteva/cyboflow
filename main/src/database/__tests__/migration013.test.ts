/**
 * Integration tests for migration 013_workflow_run_substrate.sql (TASK-806).
 *
 * Applies 006_cyboflow_schema.sql → 011_workflow_step_tracking.sql →
 * 013_workflow_run_substrate.sql against an in-memory SQLite instance. This
 * proves the SQL file itself is correct — not a hard-coded inline string — and
 * guards against column-type, default, or CHECK-domain typos.
 *
 * The test_strategy.targets from the plan frontmatter:
 *  1. Applying 006→011→013 adds substrate TEXT NOT NULL DEFAULT 'sdk' with the
 *     CHECK domain to workflow_runs.
 *  2. A row inserted WITHOUT a substrate value reads back 'sdk' (legacy rows).
 *  3. Inserting 'interactive' round-trips; inserting an out-of-domain value
 *     (e.g. 'gemini') is rejected by the CHECK constraint.
 *  4. Re-executing 013 raises 'duplicate column name: substrate' SqliteError
 *     (the idempotency signal that runFileBasedMigrations uses to skip
 *     already-applied files).
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Helper: open a fresh in-memory DB and apply migrations 006, 011, and 013
// ---------------------------------------------------------------------------

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

function applyMigrations(): Database.Database {
  const db = new Database(':memory:');
  db.exec(readMigration('006_cyboflow_schema.sql'));
  db.exec(readMigration('011_workflow_step_tracking.sql'));
  db.exec(readMigration('013_workflow_run_substrate.sql'));
  return db;
}

/** Seed a workflow row so the workflow_runs FK is satisfied. */
function seedWorkflow(db: Database.Database): void {
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json)
     VALUES ('wf-1', 1, 'test-wf', '{}')`,
  ).run();
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

describe('Migration 013: substrate column on workflow_runs', () => {
  it("adds substrate TEXT NOT NULL DEFAULT 'sdk' to workflow_runs", () => {
    const db = applyMigrations();

    const rows = db
      .prepare('PRAGMA table_info(workflow_runs)')
      .all() as TableInfoRow[];

    const col = rows.find((r) => r.name === 'substrate');

    expect(col).toBeDefined();
    expect(String(col!.type).toUpperCase()).toBe('TEXT');
    // notnull=1 means the column is NOT NULL
    expect(col!.notnull).toBe(1);
    // The default literal is stored as the quoted string 'sdk'
    expect(col!.dflt_value).toBe("'sdk'");

    db.close();
  });

  it("a row inserted WITHOUT a substrate value reads back 'sdk' (legacy default)", () => {
    const db = applyMigrations();
    seedWorkflow(db);

    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
       VALUES ('wr-default', 'wf-1', 1, 'queued', 'default')`,
    ).run();

    const row = db
      .prepare('SELECT substrate FROM workflow_runs WHERE id = ?')
      .get('wr-default') as { substrate: string };

    expect(row.substrate).toBe('sdk');

    db.close();
  });

  it("round-trips an explicit 'interactive' value", () => {
    const db = applyMigrations();
    seedWorkflow(db);

    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, substrate)
       VALUES ('wr-interactive', 'wf-1', 1, 'queued', 'default', 'interactive')`,
    ).run();

    const row = db
      .prepare('SELECT substrate FROM workflow_runs WHERE id = ?')
      .get('wr-interactive') as { substrate: string };

    expect(row.substrate).toBe('interactive');

    db.close();
  });

  it("rejects an out-of-domain substrate value via the CHECK constraint", () => {
    const db = applyMigrations();
    seedWorkflow(db);

    expect(() => {
      db.prepare(
        `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, substrate)
         VALUES ('wr-bad', 'wf-1', 1, 'queued', 'default', 'gemini')`,
      ).run();
    }).toThrow(/CHECK constraint failed/i);

    db.close();
  });

  it("re-executing migration 013 raises duplicate column name: substrate", () => {
    const db = applyMigrations();

    // SQLite raises this error when ALTER TABLE ADD COLUMN names an already-existing
    // column. runFileBasedMigrations catches this message as the idempotency signal.
    expect(() => {
      db.exec(readMigration('013_workflow_run_substrate.sql'));
    }).toThrow(/duplicate column name: substrate/i);

    db.close();
  });
});
