/**
 * Integration tests for migration 006_cyboflow_schema.sql (TASK-152).
 *
 * These tests apply the migration SQL directly against an in-memory SQLite
 * instance (no dependency on TASK-151's file-based runner). This proves the
 * schema is correct — correct CHECK constraints, correct table set, correct
 * indexes — independent of the migration runner integration.
 *
 * The four test_strategy.targets from the plan frontmatter:
 *  1. All 5 tables exist after applying the migration.
 *  2. All 4 day-1 indexes exist after applying the migration.
 *  3. INSERTing a workflow_runs row with status='foo' fails CHECK constraint.
 *  4. INSERTing an approvals row with status='maybe' fails CHECK constraint.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Helper: open a fresh in-memory DB and apply the migration
// ---------------------------------------------------------------------------

function applyMigration(): Database.Database {
  const db = new Database(':memory:');

  const migrationPath = join(
    __dirname,
    '..',
    'migrations',
    '006_cyboflow_schema.sql'
  );
  const sql = readFileSync(migrationPath, 'utf-8');

  // SQLite's db.exec() handles multi-statement SQL natively
  db.exec(sql);

  return db;
}

// ---------------------------------------------------------------------------
// Shared DB instance for read-only assertions (tables / indexes)
// ---------------------------------------------------------------------------

let db: Database.Database;

beforeAll(() => {
  db = applyMigration();
});

// ---------------------------------------------------------------------------
// 1. All 5 tables exist
// ---------------------------------------------------------------------------

describe('006_cyboflow_schema — table presence', () => {
  it('creates all 5 expected tables', () => {
    const expectedTables = new Set([
      'workflows',
      'workflow_runs',
      'raw_events',
      'messages',
      'approvals',
    ]);

    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('workflows','workflow_runs','raw_events','messages','approvals')`
      )
      .all() as Array<{ name: string }>;

    const actualTables = new Set(rows.map((r) => r.name));
    expect(actualTables).toEqual(expectedTables);
  });
});

// ---------------------------------------------------------------------------
// 2. All 4 day-1 indexes exist
// ---------------------------------------------------------------------------

describe('006_cyboflow_schema — index presence', () => {
  it('creates all 4 day-1 indexes', () => {
    const expectedIndexes = new Set([
      'idx_raw_events_run_id',
      'idx_raw_events_type_run',
      'idx_approvals_status_created',
      'idx_workflow_runs_status_created',
    ]);

    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index'
           AND name LIKE 'idx_%'`
      )
      .all() as Array<{ name: string }>;

    const actualIndexes = new Set(rows.map((r) => r.name));

    for (const idx of expectedIndexes) {
      expect(actualIndexes).toContain(idx);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. workflow_runs.status CHECK constraint rejects invalid values
// ---------------------------------------------------------------------------

describe('006_cyboflow_schema — workflow_runs CHECK constraint', () => {
  it('rejects an invalid status value (foo) via CHECK constraint', () => {
    const freshDb = applyMigration();

    // Insert a parent workflow row first so the FK chain is satisfied
    freshDb
      .prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json)
         VALUES ('wf-1', 1, 'Test Workflow', '{}')`
      )
      .run();

    // Now try to insert a workflow_runs row with an invalid status
    expect(() => {
      freshDb
        .prepare(
          `INSERT INTO workflow_runs
             (id, workflow_id, project_id, worktree_path, status, policy_json)
           VALUES ('wr-1', 'wf-1', 1, '/tmp/worktree', 'foo', '{}')`
        )
        .run();
    }).toThrow(/CHECK constraint failed/);

    freshDb.close();
  });

  it('accepts all 8 valid status values', () => {
    const validStatuses = [
      'queued',
      'starting',
      'running',
      'awaiting_review',
      'stuck',
      'completed',
      'failed',
      'canceled',
    ] as const;

    for (const status of validStatuses) {
      const freshDb = applyMigration();

      freshDb
        .prepare(
          `INSERT INTO workflows (id, project_id, name, spec_json)
           VALUES ('wf-1', 1, 'Test Workflow', '{}')`
        )
        .run();

      expect(() => {
        freshDb
          .prepare(
            `INSERT INTO workflow_runs
               (id, workflow_id, project_id, worktree_path, status, policy_json)
             VALUES ('wr-1', 'wf-1', 1, '/tmp/worktree', ?, '{}')`
          )
          .run(status);
      }).not.toThrow();

      freshDb.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. approvals.status CHECK constraint rejects invalid values
// ---------------------------------------------------------------------------

describe('006_cyboflow_schema — approvals CHECK constraint', () => {
  it('rejects an invalid approval status (maybe) via CHECK constraint', () => {
    const freshDb = applyMigration();

    // Set up the FK chain: workflows → workflow_runs → approvals
    freshDb
      .prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json)
         VALUES ('wf-1', 1, 'Test Workflow', '{}')`
      )
      .run();

    freshDb
      .prepare(
        `INSERT INTO workflow_runs
           (id, workflow_id, project_id, worktree_path, status, policy_json)
         VALUES ('wr-1', 'wf-1', 1, '/tmp/worktree', 'running', '{}')`
      )
      .run();

    // Now try to insert an approvals row with an invalid status
    expect(() => {
      freshDb
        .prepare(
          `INSERT INTO approvals
             (id, run_id, tool_name, tool_input_json, tool_use_id, status)
           VALUES ('ap-1', 'wr-1', 'bash', '{}', 'tu-1', 'maybe')`
        )
        .run();
    }).toThrow(/CHECK constraint failed/);

    freshDb.close();
  });

  it('defaults approvals.status to pending when omitted', () => {
    const freshDb = applyMigration();

    freshDb
      .prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json)
         VALUES ('wf-1', 1, 'Test Workflow', '{}')`
      )
      .run();

    freshDb
      .prepare(
        `INSERT INTO workflow_runs
           (id, workflow_id, project_id, worktree_path, status, policy_json)
         VALUES ('wr-1', 'wf-1', 1, '/tmp/worktree', 'running', '{}')`
      )
      .run();

    // Insert without specifying status — should default to 'pending'
    freshDb
      .prepare(
        `INSERT INTO approvals
           (id, run_id, tool_name, tool_input_json, tool_use_id)
         VALUES ('ap-1', 'wr-1', 'bash', '{}', 'tu-1')`
      )
      .run();

    const row = freshDb
      .prepare(`SELECT status FROM approvals WHERE id = 'ap-1'`)
      .get() as { status: string };

    expect(row.status).toBe('pending');

    freshDb.close();
  });

  it('accepts all 4 valid approval status values', () => {
    const validStatuses = ['pending', 'approved', 'rejected', 'timed_out'] as const;

    for (const status of validStatuses) {
      const freshDb = applyMigration();

      freshDb
        .prepare(
          `INSERT INTO workflows (id, project_id, name, spec_json)
           VALUES ('wf-1', 1, 'Test Workflow', '{}')`
        )
        .run();

      freshDb
        .prepare(
          `INSERT INTO workflow_runs
             (id, workflow_id, project_id, worktree_path, status, policy_json)
           VALUES ('wr-1', 'wf-1', 1, '/tmp/worktree', 'running', '{}')`
        )
        .run();

      expect(() => {
        freshDb
          .prepare(
            `INSERT INTO approvals
               (id, run_id, tool_name, tool_input_json, tool_use_id, status)
             VALUES ('ap-1', 'wr-1', 'bash', '{}', 'tu-1', ?)`
          )
          .run(status);
      }).not.toThrow();

      freshDb.close();
    }
  });
});
