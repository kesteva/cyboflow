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
import { recoverActiveStateOrphans } from '../runRecovery';
import { RunQueueRegistry } from '../RunQueueRegistry';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { createTestDb, seedRun, seedApproval } from '../__test_fixtures__/orchestratorTestDb';

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
    seedRun(db, { id: runId, status: 'running' });

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
    seedRun(db, { id: runId, status: 'starting' });

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
    seedRun(db, { id: runId, status: 'running' });

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
    seedRun(db, { id: runId, status: 'running' });

    const approvalId = 'approval-D1';
    seedApproval(db, { id: approvalId, runId });

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
  // Case F (Phase 4b): "paused runs survive boot recovery"
  //
  // A paused run (SDK-only Pause) is NON-terminal but must NOT be force-failed to
  // 'app_restart' on boot — it retains claude_session_id + current_step_id so
  // Resume can re-drive via --resume. recoverActiveStateOrphans only sweeps
  // 'starting'/'running', so a paused row is left untouched.
  // -------------------------------------------------------------------------
  it('does NOT recover paused runs (they survive restart)', () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const runQueues = new RunQueueRegistry();

    const runId = 'run-F1';
    seedRun(db, { id: runId, status: 'paused' });

    const result = recoverActiveStateOrphans(adapter, runQueues);

    // Nothing recovered — paused is not in the sweep set.
    expect(result).toEqual({ runningRecovered: 0, startingRecovered: 0, approvalsCanceled: 0 });

    // The row must remain 'paused' — not force-failed.
    const row = db
      .prepare('SELECT status, error_message FROM workflow_runs WHERE id = ?')
      .get(runId) as { status: string; error_message: string | null };
    expect(row.status).toBe('paused');
    expect(row.error_message).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Case E: "ignores already-terminal rows"
  // -------------------------------------------------------------------------
  it('ignores already-terminal rows', () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const runQueues = new RunQueueRegistry();

    seedRun(db, { id: 'run-E1', status: 'completed' });
    seedRun(db, { id: 'run-E2', status: 'failed' });

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
