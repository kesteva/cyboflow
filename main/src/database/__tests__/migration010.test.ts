/**
 * Integration tests for migration 010_questions.sql (TASK-757).
 *
 * Applies 006_cyboflow_schema.sql + 007_add_stuck_reason.sql + 010_questions.sql
 * in order against an in-memory SQLite instance. This proves the SQL contract:
 *
 * 1. The `questions` table is created with the documented column set.
 * 2. `questions.status` CHECK rejects invalid values.
 * 3. `workflow_runs.status` accepts 'awaiting_input' after migration 010.
 * 4. `workflow_runs.status` still accepts all 8 original status values.
 * 5. All three pre-existing workflow_runs indexes are preserved after the rebuild.
 * 6. The new idx_questions_status_created index is created.
 * 7. FK-bound child rows (approvals, messages, raw_events) survive migration 010
 *    when the migration is applied via the production-path transaction wrapper.
 *
 * NOTE: 008 and 009 migrations affect unrelated tables (sessions run_id, etc.)
 * and are intentionally skipped here — migration 010's logic does not depend on
 * them. The fileMigrationRunner integration is covered by fileMigrationRunner.test.ts.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Helper: open a fresh in-memory DB and apply migrations 006, 007, and 010
// ---------------------------------------------------------------------------

function applyMigrations006To010(): Database.Database {
  const db = new Database(':memory:');
  for (const n of ['006_cyboflow_schema.sql', '007_add_stuck_reason.sql', '010_questions.sql']) {
    db.exec(readFileSync(join(__dirname, '..', 'migrations', n), 'utf-8'));
  }
  return db;
}

// ---------------------------------------------------------------------------
// Helper: apply a single migration SQL the same way the production runner does.
//
// runFileBasedMigrations() wraps every file in `this.transaction(() => db.exec(sql))`.
// SQLite's documented behaviour: PRAGMA foreign_keys toggles are no-ops INSIDE
// a transaction. The production fix (database.ts) therefore toggles the pragma
// OUTSIDE the transaction wrapper. This helper mirrors that exact path so the
// regression test below exercises the real code flow, not the autocommit path
// used by db.exec() directly.
// ---------------------------------------------------------------------------

function runMigrationViaProductionPath(db: Database.Database, sql: string): void {
  const needsFkOff = sql.includes('PRAGMA foreign_keys=OFF');
  if (needsFkOff) db.pragma('foreign_keys = OFF');
  try {
    const txn = db.transaction(() => {
      db.exec(sql);
    });
    txn();
  } finally {
    if (needsFkOff) db.pragma('foreign_keys = ON');
  }
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

describe('Migration 010: questions table + workflow_runs awaiting_input CHECK', () => {
  it('creates questions table with expected columns', () => {
    const db = applyMigrations006To010();

    const cols = db.prepare('PRAGMA table_info(questions)').all() as TableInfoRow[];
    const names = new Set(cols.map((c) => c.name));

    expect(names).toEqual(
      new Set([
        'id',
        'run_id',
        'tool_use_id',
        'questions_json',
        'answer_json',
        'status',
        'created_at',
        'answered_at',
      ]),
    );

    db.close();
  });

  it('questions.status CHECK rejects invalid values', () => {
    const db = applyMigrations006To010();

    // Seed a workflow + workflow_run so FK for questions.run_id is satisfied
    db.prepare(
      `INSERT INTO workflows (id, project_id, name, spec_json)
       VALUES ('wf-1', 1, 'test', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
       VALUES ('wr-1', 'wf-1', 1, 'queued', 'default')`,
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO questions (id, run_id, tool_use_id, questions_json, status)
           VALUES ('q-1', 'wr-1', 'tu-1', '[]', 'maybe')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);

    db.close();
  });

  it('workflow_runs accepts awaiting_input after migration 010', () => {
    const db = applyMigrations006To010();

    db.prepare(
      `INSERT INTO workflows (id, project_id, name, spec_json)
       VALUES ('wf-1', 1, 'test', '{}')`,
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
           VALUES ('wr-ai', 'wf-1', 1, 'awaiting_input', 'default')`,
        )
        .run(),
    ).not.toThrow();

    db.close();
  });

  it('workflow_runs still accepts all 8 original status values', () => {
    for (const status of [
      'queued',
      'starting',
      'running',
      'awaiting_review',
      'stuck',
      'completed',
      'failed',
      'canceled',
    ]) {
      const db = applyMigrations006To010();

      db.prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json)
         VALUES ('wf-1', 1, 'test', '{}')`,
      ).run();

      expect(() =>
        db
          .prepare(
            `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
             VALUES ('wr-1', 'wf-1', 1, ?, 'default')`,
          )
          .run(status),
      ).not.toThrow();

      db.close();
    }
  });

  it('preserves all three pre-existing workflow_runs indexes', () => {
    const db = applyMigrations006To010();

    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='workflow_runs'",
      )
      .all() as Array<{ name: string }>;
    const names = new Set(rows.map((r) => r.name));

    expect(names).toContain('idx_workflow_runs_status_created');
    expect(names).toContain('idx_workflow_runs_workflow_id');
    expect(names).toContain('idx_workflow_runs_status_stuck_at');

    db.close();
  });

  it('creates idx_questions_status_created index', () => {
    const db = applyMigrations006To010();

    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_questions_status_created'",
      )
      .all() as Array<{ name: string }>;

    expect(rows).toHaveLength(1);

    db.close();
  });

  // ---------------------------------------------------------------------------
  // Regression test: FK children survive the workflow_runs table-recreation
  // when migration 010 is run via the production-path transaction wrapper.
  //
  // Production bug this guards: `PRAGMA foreign_keys=OFF` inside a transaction
  // is a no-op (SQLite docs). If the pragma is not toggled OUTSIDE the
  // transaction, the DROP TABLE workflow_runs CASCADE-deletes every row in
  // approvals, messages, and raw_events. This test mirrors the exact production
  // runner path (see runMigrationViaProductionPath helper above).
  // ---------------------------------------------------------------------------

  it('FK-bound child rows (approvals, messages, raw_events) survive migration 010 via the production-path transaction wrapper', () => {
    const db = new Database(':memory:');
    // Apply 006 and 007 without the production wrapper (no PRAGMA involved).
    for (const n of ['006_cyboflow_schema.sql', '007_add_stuck_reason.sql']) {
      db.exec(readFileSync(join(__dirname, '..', 'migrations', n), 'utf-8'));
    }

    // Seed the parent rows required for FK constraints.
    db.prepare(
      `INSERT INTO workflows (id, project_id, name, spec_json)
       VALUES ('wf-seed', 1, 'seed-wf', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
       VALUES ('wr-seed', 'wf-seed', 1, 'running', 'default')`,
    ).run();

    // Seed one child row in each FK-bound table.
    db.prepare(
      `INSERT INTO approvals
         (id, run_id, tool_name, tool_input_json, tool_use_id, status)
       VALUES ('ap-1', 'wr-seed', 'Bash', '{}', 'tu-ap-1', 'pending')`,
    ).run();
    db.prepare(
      `INSERT INTO messages
         (id, run_id, role, content_json)
       VALUES ('msg-1', 'wr-seed', 'assistant', '"hello"')`,
    ).run();
    db.prepare(
      `INSERT INTO raw_events
         (run_id, event_type, payload_json)
       VALUES ('wr-seed', 'sdk_message', '{}')`,
    ).run();

    // Verify seed is in place before running migration 010.
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number }).n,
    ).toBe(1);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n,
    ).toBe(1);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM raw_events').get() as { n: number }).n,
    ).toBe(1);

    // Apply migration 010 via the production-path wrapper (pragma OUTSIDE txn).
    const sql010 = readFileSync(
      join(__dirname, '..', 'migrations', '010_questions.sql'),
      'utf-8',
    );
    runMigrationViaProductionPath(db, sql010);

    // Child rows MUST still exist after the workflow_runs table rebuild.
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number }).n,
    ).toBe(1);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n,
    ).toBe(1);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM raw_events').get() as { n: number }).n,
    ).toBe(1);

    db.close();
  });
});
