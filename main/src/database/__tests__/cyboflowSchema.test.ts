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
 *
 * Additional integration tests added by TASK-155 (migration runner ordering):
 *  5. Fresh-install: DatabaseService.initialize() applies 006 exactly once and
 *     records the file_migration_applied ledger marker (idempotency).
 *  6. Existing-install: auto-flags 003/004/005 as applied and then applies 006.
 *  7. EXPLAIN QUERY PLAN for the canonical raw_events tail-read uses
 *     idx_raw_events_run_id (not a full table scan).
 */

import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../database';

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

// ---------------------------------------------------------------------------
// 5. Fresh-install path: DatabaseService.initialize() applies 006 exactly once
//    and records the file_migration_applied ledger marker (TASK-155 AC-1/AC-2)
// ---------------------------------------------------------------------------

describe('006_cyboflow_schema — fresh-install migration runner integration', () => {
  let tmpDbDir: string;

  afterEach(() => {
    rmSync(tmpDbDir, { recursive: true, force: true });
  });

  it('applies 006_cyboflow_schema.sql exactly once and records the ledger marker', () => {
    // Use a real temp-file DB (not :memory:) so we can re-open it for the
    // idempotency check (a second DatabaseService on the same file).
    tmpDbDir = mkdtempSync(join(tmpdir(), 'cyboflow-schema-fresh-'));
    const dbPath = join(tmpDbDir, 'test.db');

    // The migrations dir override points to the real migrations directory so
    // 006_cyboflow_schema.sql is the only new file to apply. No need to copy
    // files — we point at the actual directory used by the service.
    const realMigrationsDir = join(__dirname, '..', 'migrations');

    // --- First initialize (fresh install) ---
    const svc1 = new DatabaseService(dbPath);
    svc1.setMigrationsDirForTesting(realMigrationsDir);

    const logSpy = vi.spyOn(console, 'log');
    svc1.initialize();

    // (a) All 5 Cyboflow tables must exist
    const rawDb1 = new Database(dbPath);
    const tableRows = rawDb1
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('workflows','workflow_runs','raw_events','messages','approvals')`
      )
      .all() as Array<{ name: string }>;
    expect(tableRows).toHaveLength(5);

    // (b) The ledger marker for 006 must be present
    const ledgerRow = rawDb1
      .prepare(
        "SELECT value FROM user_preferences WHERE key = 'file_migration_applied:006_cyboflow_schema.sql'"
      )
      .get() as { value: string } | undefined;
    expect(ledgerRow).toBeDefined();
    expect(ledgerRow?.value).toBe('true');
    rawDb1.close();

    // (c) The "Applied file migration" log appeared at least once for 006
    const applied006Calls = logSpy.mock.calls.filter(
      (args) =>
        args.some(
          (arg) => typeof arg === 'string' && arg.includes('006_cyboflow_schema.sql')
        )
    );
    expect(applied006Calls.length).toBeGreaterThanOrEqual(1);
    logSpy.mockClear();

    // --- Second initialize (idempotency check) ---
    const svc2 = new DatabaseService(dbPath);
    svc2.setMigrationsDirForTesting(realMigrationsDir);
    svc2.initialize();

    // The log should NOT mention 006 again (already recorded in ledger)
    const applied006Again = logSpy.mock.calls.filter(
      (args) =>
        args.some(
          (arg) =>
            typeof arg === 'string' &&
            arg.includes('006_cyboflow_schema.sql') &&
            arg.includes('Applied')
        )
    );
    expect(applied006Again).toHaveLength(0);

    logSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 6. Existing-install path: auto-flags 003/004/005 and applies 006 (TASK-155 AC-2)
//
// Simulates upgrading from a pre-TASK-151 build where inline migrations 003/004/005
// already ran. DatabaseService.initialize() must detect their markers, backfill the
// file_migration_applied:003/004/005 entries without re-executing those files, then
// apply 006 exactly once with no console.error calls.
//
// Isolation requirement (FIND-SPRINT-005-2): the 003/004/005 file_migration_applied
// ledger flags must NOT be present when svc2.initialize() is called, so that the
// backfillLegacyFileMigrationFlags() write path is actually exercised — not merely
// read and skipped because svc1 already wrote them.
// ---------------------------------------------------------------------------

describe('006_cyboflow_schema — existing-install migration runner integration', () => {
  let tmpDbDir: string;

  afterEach(() => {
    rmSync(tmpDbDir, { recursive: true, force: true });
  });

  it('auto-flags 003/004/005 and applies 006 exactly once with no errors', () => {
    tmpDbDir = mkdtempSync(join(tmpdir(), 'cyboflow-schema-existing-'));
    const dbPath = join(tmpDbDir, 'test.db');

    // Step 1: Bootstrap a DB whose inline migrations have already run.
    //   Pointing at the real migrations dir causes initialize() to run all
    //   inline migrations (003-005 create tool_panels etc.) AND then apply 006.
    //   This simulates the state a pre-TASK-151 user would be in after upgrading.
    const realMigrationsDir = join(__dirname, '..', 'migrations');

    const svc1 = new DatabaseService(dbPath);
    svc1.setMigrationsDirForTesting(realMigrationsDir);
    svc1.initialize();

    // Simulate pre-TASK-151 state by rolling back to the point-in-time just
    // before TASK-151's file-based runner was introduced:
    //   - The tool_panels table (003 inline marker) is present.
    //   - The claude_panels_migrated preference (004 inline marker) is present.
    //   - The unified_panel_settings_migrated preference (005 inline marker) is present.
    //   - NO file_migration_applied:003/004/005/006 ledger entries exist.
    //   - The five Cyboflow tables (added by 006) do NOT exist.
    const rawDb = new Database(dbPath);

    // Drop the Cyboflow tables added by 006 to truly reset to pre-006 state.
    rawDb.exec(`
      DROP TABLE IF EXISTS approvals;
      DROP TABLE IF EXISTS messages;
      DROP TABLE IF EXISTS raw_events;
      DROP TABLE IF EXISTS workflow_runs;
      DROP TABLE IF EXISTS workflows;
    `);

    // Remove ALL file_migration_applied:* ledger entries so that svc2's
    // backfillLegacyFileMigrationFlags() must actually write the 003/004/005
    // entries — not find them pre-written by svc1.
    rawDb
      .prepare(
        "DELETE FROM user_preferences WHERE key LIKE 'file_migration_applied:%'"
      )
      .run();
    rawDb.close();

    // Confirm isolation: 003/004/005 flags are gone before svc2 runs.
    const probe = new Database(dbPath);
    const flagsBefore = probe
      .prepare(
        "SELECT key FROM user_preferences WHERE key LIKE 'file_migration_applied:%'"
      )
      .all() as Array<{ key: string }>;
    expect(flagsBefore).toHaveLength(0);
    probe.close();

    // Step 2: Run initialize() — the backfill code path must detect the inline
    // markers (tool_panels table, claude_panels_migrated, unified_panel_settings_migrated)
    // and write the 003/004/005 ledger entries. Then 006 must be applied because
    // it is absent from the ledger.
    const errorSpy = vi.spyOn(console, 'error');

    const svc2 = new DatabaseService(dbPath);
    svc2.setMigrationsDirForTesting(realMigrationsDir);
    svc2.initialize();

    // (a) 003/004/005 ledger markers must be present
    const rawDb2 = new Database(dbPath);

    const flag003 = rawDb2
      .prepare(
        "SELECT value FROM user_preferences WHERE key = 'file_migration_applied:003_add_tool_panels.sql'"
      )
      .get() as { value: string } | undefined;
    const flag004 = rawDb2
      .prepare(
        "SELECT value FROM user_preferences WHERE key = 'file_migration_applied:004_claude_panels.sql'"
      )
      .get() as { value: string } | undefined;
    const flag005 = rawDb2
      .prepare(
        "SELECT value FROM user_preferences WHERE key = 'file_migration_applied:005_unified_panel_settings.sql'"
      )
      .get() as { value: string } | undefined;

    expect(flag003?.value).toBe('true');
    expect(flag004?.value).toBe('true');
    expect(flag005?.value).toBe('true');

    // (b) 006 ledger marker must now also be present
    const flag006 = rawDb2
      .prepare(
        "SELECT value FROM user_preferences WHERE key = 'file_migration_applied:006_cyboflow_schema.sql'"
      )
      .get() as { value: string } | undefined;
    expect(flag006?.value).toBe('true');

    // (c) All 5 Cyboflow tables must exist
    const tableRows = rawDb2
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('workflows','workflow_runs','raw_events','messages','approvals')`
      )
      .all() as Array<{ name: string }>;
    expect(tableRows).toHaveLength(5);

    rawDb2.close();

    // (d) No console.error calls during the second initialize()
    expect(errorSpy.mock.calls).toHaveLength(0);
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 7. EXPLAIN QUERY PLAN: canonical raw_events tail-read uses idx_raw_events_run_id
//    (TASK-155 AC-3)
//
// Verifies that the SQLite query planner chooses the day-1 composite index
// for the canonical tail-read pattern instead of a full table scan.
//
// NOTE: The assertion is an intentional tight string-match on the index name
// as rendered by EXPLAIN QUERY PLAN. If a future better-sqlite3 / SQLite upgrade
// changes the EXPLAIN format, the test failure is the signal to re-verify that
// the index is still being chosen (see TASK-155 plan §Lowest Confidence Area).
// better-sqlite3 version at time of writing: ^11.7.0 (ships SQLite 3.x).
// ---------------------------------------------------------------------------

describe('006_cyboflow_schema — EXPLAIN QUERY PLAN uses idx_raw_events_run_id', () => {
  it('EXPLAIN QUERY PLAN for the canonical raw_events tail-read uses idx_raw_events_run_id', () => {
    // Use an in-memory DB with the migration applied directly — no need for
    // DatabaseService here; we are testing SQLite's planner, not the runner.
    const explainDb = applyMigration();

    // The canonical tail-read query: fetch the last 100 events for a given run.
    const rows = explainDb
      .prepare(
        'EXPLAIN QUERY PLAN SELECT * FROM raw_events WHERE run_id = ? ORDER BY id DESC LIMIT 100'
      )
      .all('test-run-id') as Array<{ id: number; parent: number; notused: number; detail: string }>;

    const planText = rows.map((r) => r.detail).join(' ');

    // The plan must mention our composite index — not a full table scan.
    // If this assertion fails, either (a) the index was dropped/renamed in the SQL,
    // or (b) SQLite's EXPLAIN format changed — check the raw planText value first.
    expect(planText).toContain('idx_raw_events_run_id');

    explainDb.close();
  });
});
