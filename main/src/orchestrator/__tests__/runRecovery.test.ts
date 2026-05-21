/**
 * Integration tests for recoverActiveStateOrphans.
 *
 * Five cases per the test_strategy in the TASK-708 plan:
 *
 * A. "recovers running orphans": orphan with status='running' and no live
 *    RunQueueRegistry entry transitions to status='failed' with
 *    error_message='app_restart'.
 *
 * B. "recovers starting orphans": symmetric for status='starting'.
 *
 * C. "skips live runs": row with status='running' AND runQueues.has(runId)===true
 *    is SKIPPED (status stays 'running').
 *
 * D. "cancels pending approvals for recovered runs": pending approvals belonging
 *    to recovered runs are flipped from 'pending' to 'timed_out'.
 *
 * E. "ignores already-terminal rows": rows with status='completed' or
 *    status='failed' are left untouched.
 *
 * All tests use in-memory better-sqlite3 + dbAdapter + real RunQueueRegistry —
 * no mocks, exercises real SQL and real registry semantics.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { recoverActiveStateOrphans } from '../runRecovery';
import { RunQueueRegistry } from '../RunQueueRegistry';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';

// ---------------------------------------------------------------------------
// Test-database helpers
// ---------------------------------------------------------------------------

// Resolve the schema relative to process.cwd() which is always the main/
// workspace root when running via vitest.
const SCHEMA_PATH = join(
  process.cwd(),
  'src/database/migrations/006_cyboflow_schema.sql',
);

/** Creates a fresh in-memory SQLite database with the cyboflow schema applied. */
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

/** Seed a workflow + workflow_runs row with the given status. */
function seedRun(
  db: Database.Database,
  id: string,
  status: 'queued' | 'starting' | 'running' | 'awaiting_review' | 'stuck' | 'completed' | 'failed' | 'canceled',
): void {
  const workflowId = `workflow-${id}`;
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json)
     VALUES (?, 1, 'test-workflow', '{}')`,
  ).run(workflowId);

  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, worktree_path, status)
     VALUES (?, ?, 1, '/tmp/test', ?)`,
  ).run(id, workflowId, status);
}

/** Seed an approvals row with status='pending' for a given run. */
function seedPendingApproval(
  db: Database.Database,
  approvalId: string,
  runId: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO approvals
       (id, run_id, tool_name, tool_input_json, tool_use_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(approvalId, runId, 'bash', '{}', approvalId, now);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recoverActiveStateOrphans', () => {
  // -------------------------------------------------------------------------
  // Case A: "recovers running orphans"
  // -------------------------------------------------------------------------
  it('recovers running orphans', () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const runQueues = new RunQueueRegistry();

    const runId = 'run-A1';
    seedRun(db, runId, 'running');

    const result = recoverActiveStateOrphans(adapter, runQueues);

    // Return value: 1 running recovered, nothing else.
    expect(result).toEqual({ runningRecovered: 1, startingRecovered: 0, approvalsCanceled: 0 });

    // The row must be transitioned to 'failed' with error_message='app_restart'.
    const row = db
      .prepare('SELECT status, error_message FROM workflow_runs WHERE id = ?')
      .get(runId) as { status: string; error_message: string };
    expect(row.status).toBe('failed');
    expect(row.error_message).toBe('app_restart');
  });

  // -------------------------------------------------------------------------
  // Case B: "recovers starting orphans"
  // -------------------------------------------------------------------------
  it('recovers starting orphans', () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const runQueues = new RunQueueRegistry();

    const runId = 'run-B1';
    seedRun(db, runId, 'starting');

    const result = recoverActiveStateOrphans(adapter, runQueues);

    // Return value: 1 starting recovered, nothing else.
    expect(result).toEqual({ runningRecovered: 0, startingRecovered: 1, approvalsCanceled: 0 });

    // The row must be transitioned to 'failed' with error_message='app_restart'.
    const row = db
      .prepare('SELECT status, error_message FROM workflow_runs WHERE id = ?')
      .get(runId) as { status: string; error_message: string };
    expect(row.status).toBe('failed');
    expect(row.error_message).toBe('app_restart');
  });

  // -------------------------------------------------------------------------
  // Case C: "skips live runs"
  // -------------------------------------------------------------------------
  it('skips live runs', () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const runQueues = new RunQueueRegistry();

    const runId = 'run-C1';
    seedRun(db, runId, 'running');

    // Register a live entry in the registry (simulates an active executor).
    runQueues.getOrCreate(runId);
    expect(runQueues.has(runId)).toBe(true);

    const result = recoverActiveStateOrphans(adapter, runQueues);

    // Nothing should be recovered.
    expect(result).toEqual({ runningRecovered: 0, startingRecovered: 0, approvalsCanceled: 0 });

    // The row must remain 'running' — not touched.
    const row = db
      .prepare('SELECT status FROM workflow_runs WHERE id = ?')
      .get(runId) as { status: string };
    expect(row.status).toBe('running');
  });

  // -------------------------------------------------------------------------
  // Case D: "cancels pending approvals for recovered runs"
  // -------------------------------------------------------------------------
  it('cancels pending approvals for recovered runs', () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const runQueues = new RunQueueRegistry();

    const runId = 'run-D1';
    seedRun(db, runId, 'running');

    const approvalId = 'approval-D1';
    seedPendingApproval(db, approvalId, runId);

    const result = recoverActiveStateOrphans(adapter, runQueues);

    // 1 running recovered, 1 approval canceled.
    expect(result).toEqual({ runningRecovered: 1, startingRecovered: 0, approvalsCanceled: 1 });

    // The approval row must be 'timed_out' with decided_at set and decided_by='system'.
    const approval = db
      .prepare('SELECT status, decided_at, decided_by FROM approvals WHERE id = ?')
      .get(approvalId) as { status: string; decided_at: string | null; decided_by: string };
    expect(approval.status).toBe('timed_out');
    expect(approval.decided_at).not.toBeNull();
    expect(approval.decided_by).toBe('system');
  });

  // -------------------------------------------------------------------------
  // Case E: "ignores already-terminal rows"
  // -------------------------------------------------------------------------
  it('ignores already-terminal rows', () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const runQueues = new RunQueueRegistry();

    seedRun(db, 'run-E1', 'completed');
    seedRun(db, 'run-E2', 'failed');

    const result = recoverActiveStateOrphans(adapter, runQueues);

    // Nothing should be recovered.
    expect(result).toEqual({ runningRecovered: 0, startingRecovered: 0, approvalsCanceled: 0 });

    // Both rows must remain untouched.
    const e1 = db
      .prepare('SELECT status FROM workflow_runs WHERE id = ?')
      .get('run-E1') as { status: string };
    expect(e1.status).toBe('completed');

    const e2 = db
      .prepare('SELECT status FROM workflow_runs WHERE id = ?')
      .get('run-E2') as { status: string };
    expect(e2.status).toBe('failed');
  });
});
