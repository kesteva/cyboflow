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
});
