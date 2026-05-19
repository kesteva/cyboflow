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
        `INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode)
         VALUES ('wf-test', 1, 'Test Workflow', '/tmp/wf.md', 'default')`
      )
      .run();

    const wfRow = freshDb.prepare('SELECT id FROM workflows LIMIT 1').get() as { id: string };

    // Now try to insert a workflow_runs row with an invalid status
    expect(() => {
      freshDb
        .prepare(
          `INSERT INTO workflow_runs
             (id, workflow_id, project_id, status, permission_mode_snapshot)
           VALUES ('wr-1', ?, 1, 'foo', 'default')`
        )
        .run(wfRow.id);
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
          `INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode)
           VALUES ('wf-test', 1, 'Test Workflow', '/tmp/wf.md', 'default')`
        )
        .run();

      const wfRow = freshDb.prepare('SELECT id FROM workflows LIMIT 1').get() as { id: string };

      expect(() => {
        freshDb
          .prepare(
            `INSERT INTO workflow_runs
               (id, workflow_id, project_id, status, permission_mode_snapshot)
             VALUES ('wr-1', ?, 1, ?, 'default')`
          )
          .run(wfRow.id, status);
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
        `INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode)
         VALUES ('wf-test', 1, 'Test Workflow', '/tmp/wf.md', 'default')`
      )
      .run();

    const wfRow1 = freshDb.prepare('SELECT id FROM workflows LIMIT 1').get() as { id: string };

    freshDb
      .prepare(
        `INSERT INTO workflow_runs
           (id, workflow_id, project_id, status, permission_mode_snapshot)
         VALUES ('wr-1', ?, 1, 'running', 'default')`
      )
      .run(wfRow1.id);

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
        `INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode)
         VALUES ('wf-test', 1, 'Test Workflow', '/tmp/wf.md', 'default')`
      )
      .run();

    const wfRow2 = freshDb.prepare('SELECT id FROM workflows LIMIT 1').get() as { id: string };

    freshDb
      .prepare(
        `INSERT INTO workflow_runs
           (id, workflow_id, project_id, status, permission_mode_snapshot)
         VALUES ('wr-1', ?, 1, 'running', 'default')`
      )
      .run(wfRow2.id);

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
          `INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode)
           VALUES ('wf-test', 1, 'Test Workflow', '/tmp/wf.md', 'default')`
        )
        .run();

      const wfRow3 = freshDb.prepare('SELECT id FROM workflows LIMIT 1').get() as { id: string };

      freshDb
        .prepare(
          `INSERT INTO workflow_runs
             (id, workflow_id, project_id, status, permission_mode_snapshot)
           VALUES ('wr-1', ?, 1, 'running', 'default')`
        )
        .run(wfRow3.id);

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

// ---------------------------------------------------------------------------
// 7a. Post-006 reconciler: workflow_runs schema drift from in-place 006 edits.
//
// Mirrors the existing workflows-table reconciler (database.ts:reconcileWorkflowsSchema)
// but for workflow_runs. Reproduces the bug where an installed user's DB had
// `file_migration_applied:006_cyboflow_schema.sql = true` but the table was missing
// permission_mode_snapshot / branch_name / error_message because their install ran
// 006 BEFORE those columns were added to the file in-place.
// ---------------------------------------------------------------------------

describe('006_cyboflow_schema — workflow_runs reconciler (post-006 in-place edits)', () => {
  let tmpDbDir: string;

  afterEach(() => {
    rmSync(tmpDbDir, { recursive: true, force: true });
  });

  it('adds permission_mode_snapshot, branch_name, error_message when a pre-edit 006 install re-initializes', () => {
    tmpDbDir = mkdtempSync(join(tmpdir(), 'cyboflow-schema-runs-reconcile-'));
    const dbPath = join(tmpDbDir, 'test.db');
    const realMigrationsDir = join(__dirname, '..', 'migrations');

    // Step 1: First initialize applies current (post-edit) 006 — all columns
    // present. We then mutate the DB to simulate a pre-edit install.
    const svc1 = new DatabaseService(dbPath);
    svc1.setMigrationsDirForTesting(realMigrationsDir);
    svc1.initialize();

    const rawDb = new Database(dbPath);
    rawDb.exec(`
      BEGIN;
      DROP TABLE workflow_runs;
      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        project_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        worktree_path TEXT,
        policy_json TEXT,
        stuck_at DATETIME,
        stuck_reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME,
        ended_at DATETIME,
        FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
      );
      COMMIT;
    `);
    rawDb.close();

    // Sanity: confirm the simulated pre-edit shape is missing the 3 columns.
    const probe = new Database(dbPath);
    interface ColInfo { name: string }
    const colsBefore = probe.prepare("PRAGMA table_info(workflow_runs)").all() as ColInfo[];
    const colNamesBefore = colsBefore.map((c) => c.name);
    expect(colNamesBefore).not.toContain('permission_mode_snapshot');
    expect(colNamesBefore).not.toContain('branch_name');
    expect(colNamesBefore).not.toContain('error_message');
    probe.close();

    // Step 2: Re-initialize. The reconciler must add all 3 missing columns.
    const svc2 = new DatabaseService(dbPath);
    svc2.setMigrationsDirForTesting(realMigrationsDir);
    svc2.initialize();

    const finalDb = new Database(dbPath);
    const colsAfter = finalDb.prepare("PRAGMA table_info(workflow_runs)").all() as ColInfo[];
    const colNamesAfter = colsAfter.map((c) => c.name);
    expect(colNamesAfter).toContain('permission_mode_snapshot');
    expect(colNamesAfter).toContain('branch_name');
    expect(colNamesAfter).toContain('error_message');

    // Inserting a workflow + workflow_runs row with permission_mode_snapshot
    // must succeed end-to-end — this was the failing path that motivated the fix.
    finalDb.exec(`
      INSERT INTO workflows (id, project_id, name, spec_json)
        VALUES ('wf-reconcile', 1, 'test', '{}');
      INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
        VALUES ('run-reconcile', 'wf-reconcile', 1, 'queued', 'acceptEdits');
    `);
    interface Row { permission_mode_snapshot: string }
    const row = finalDb
      .prepare("SELECT permission_mode_snapshot FROM workflow_runs WHERE id = 'run-reconcile'")
      .get() as Row;
    expect(row.permission_mode_snapshot).toBe('acceptEdits');
    finalDb.close();
  });

  it('rebuilds the table when worktree_path is NOT NULL (canonical is nullable) or stuck_detected_at orphan column exists', () => {
    tmpDbDir = mkdtempSync(join(tmpdir(), 'cyboflow-schema-runs-tier2-'));
    const dbPath = join(tmpDbDir, 'test.db');
    const realMigrationsDir = join(__dirname, '..', 'migrations');

    // Step 1: bootstrap canonical 006 then mutate to a pre-edit drifted shape.
    const svc1 = new DatabaseService(dbPath);
    svc1.setMigrationsDirForTesting(realMigrationsDir);
    svc1.initialize();

    const rawDb = new Database(dbPath);
    // FK refs need to be off here because we'd otherwise need to cascade-handle approvals/raw_events.
    rawDb.exec(`
      PRAGMA foreign_keys=OFF;
      BEGIN;
      DROP TABLE workflow_runs;
      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        project_id INTEGER NOT NULL,
        worktree_path TEXT NOT NULL,
        status TEXT NOT NULL,
        policy_json TEXT,
        stuck_at DATETIME,
        stuck_reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME,
        ended_at DATETIME,
        stuck_detected_at INTEGER,
        FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
      );
      COMMIT;
      PRAGMA foreign_keys=ON;
    `);
    // Seed a workflow + a workflow_runs row so we can verify data preservation.
    rawDb.exec(`
      INSERT INTO workflows (id, project_id, name, spec_json)
        VALUES ('wf-preserve', 1, 'preserve test', '{}');
      INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, status)
        VALUES ('run-preserve', 'wf-preserve', 1, '/tmp/preserve-worktree', 'completed');
    `);
    rawDb.close();

    // Step 2: re-initialize. Tier 1 adds permission_mode_snapshot/branch_name/error_message,
    // Tier 2 rebuilds to drop the NOT NULL on worktree_path and remove stuck_detected_at.
    const svc2 = new DatabaseService(dbPath);
    svc2.setMigrationsDirForTesting(realMigrationsDir);
    svc2.initialize();

    interface ColInfo { name: string; notnull: number; dflt_value: unknown }
    const finalDb = new Database(dbPath);
    const cols = finalDb.prepare("PRAGMA table_info(workflow_runs)").all() as ColInfo[];
    const colByName = (n: string): ColInfo | undefined => cols.find((c) => c.name === n);

    // worktree_path must now be nullable.
    expect(colByName('worktree_path')?.notnull).toBe(0);

    // stuck_detected_at orphan column must be gone.
    expect(cols.some((c) => c.name === 'stuck_detected_at')).toBe(false);

    // permission_mode_snapshot must default to 'default' per canonical 006.
    const pms = colByName('permission_mode_snapshot');
    expect(pms?.notnull).toBe(1);
    expect(String(pms?.dflt_value)).toContain("'default'");

    // Existing row must survive the rebuild.
    interface PreservedRow { id: string; worktree_path: string; status: string; permission_mode_snapshot: string }
    const preserved = finalDb
      .prepare("SELECT id, worktree_path, status, permission_mode_snapshot FROM workflow_runs WHERE id = 'run-preserve'")
      .get() as PreservedRow | undefined;
    expect(preserved).toBeDefined();
    expect(preserved?.worktree_path).toBe('/tmp/preserve-worktree');
    expect(preserved?.status).toBe('completed');
    expect(preserved?.permission_mode_snapshot).toBe('default');

    // INSERT without worktree_path must succeed (the failing path that motivated Tier 2).
    finalDb.exec(`
      INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
        VALUES ('run-no-worktree', 'wf-preserve', 1, 'queued', 'acceptEdits');
    `);
    interface CheckRow { worktree_path: string | null }
    const noWorktree = finalDb
      .prepare("SELECT worktree_path FROM workflow_runs WHERE id = 'run-no-worktree'")
      .get() as CheckRow;
    expect(noWorktree.worktree_path).toBeNull();

    finalDb.close();
  });

  it('is a no-op on a fresh install where all columns already exist', () => {
    tmpDbDir = mkdtempSync(join(tmpdir(), 'cyboflow-schema-runs-noop-'));
    const dbPath = join(tmpDbDir, 'test.db');
    const realMigrationsDir = join(__dirname, '..', 'migrations');

    const errorSpy = vi.spyOn(console, 'error');
    const svc = new DatabaseService(dbPath);
    svc.setMigrationsDirForTesting(realMigrationsDir);
    svc.initialize();

    // Re-initialize to exercise the reconciler against an already-canonical shape.
    const svc2 = new DatabaseService(dbPath);
    svc2.setMigrationsDirForTesting(realMigrationsDir);
    svc2.initialize();

    expect(errorSpy.mock.calls).toHaveLength(0);
    errorSpy.mockRestore();
  });
});

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
