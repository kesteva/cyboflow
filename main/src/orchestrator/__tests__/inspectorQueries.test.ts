/**
 * Integration tests for getStuckInspectionHandler.
 *
 * Happy-path coverage per the test_strategy in the TASK-504 plan:
 * 15 raw_events rows inserted for a stuck run + one pending approval.
 * Call getStuckInspectionHandler. Assert:
 *   (a) recentEvents.length === 10
 *   (b) events are in descending id order
 *   (c) pendingApproval matches the inserted approval
 *   (d) stuckReason matches the run's column value
 *
 * All tests use an in-memory better-sqlite3 instance with migrations 006
 * plus an inline stub for the stuck_detected_at column that migration 007
 * will add (TASK-501 owns that migration; this test applies it inline so
 * the handler can be exercised independently).
 *
 * Note: Principal-scoping tests were removed by TASK-739 when the
 * `ctx.userId !== 'local'` guards were dropped from runs.ts in favor of
 * the load-bearing `isAuthed` middleware on `protectedProcedure`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { getStuckInspectionHandler } from '../inspectorQueries';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { createTestDb, seedApproval } from '../__test_fixtures__/orchestratorTestDb';

/** Seed a workflow + workflow_runs row with stuck status. */
function seedStuckRun(
  db: Database.Database,
  runId: string,
  stuckReason: string,
): void {
  const workflowId = `workflow-${runId}`;
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json)
     VALUES (?, 1, 'test-workflow', '{}')`,
  ).run(workflowId);

  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, worktree_path, status, policy_json,
        stuck_reason, stuck_detected_at)
     VALUES (?, ?, 1, '/tmp/test', 'stuck', '{}', ?, datetime('now'))`,
  ).run(runId, workflowId, stuckReason);
}

/** Insert N raw_events rows for a run, returning the inserted ids. */
function seedRawEvents(
  db: Database.Database,
  runId: string,
  count: number,
): number[] {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const result = db.prepare(
      `INSERT INTO raw_events (run_id, event_type, payload_json)
       VALUES (?, 'sdk_message', ?)`,
    ).run(runId, JSON.stringify({ index: i }));
    ids.push(Number(result.lastInsertRowid));
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getStuckInspectionHandler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb({ includeStuckDetectedAt: true });
  });

  // -------------------------------------------------------------------------
  // Case 1: happy path — 15 events, 1 pending approval, stuck run
  // -------------------------------------------------------------------------
  it('returns 10 most recent events in descending order with correct metadata', () => {
    const runId = 'run-inspect-01';
    const stuckReason = 'no_progress';

    seedStuckRun(db, runId, stuckReason);
    seedApproval(db, { id: `approval-${runId}`, runId, toolName: 'bash', toolInputJson: JSON.stringify({ cmd: 'echo hi' }), toolUseId: 'use-1' });
    const allIds = seedRawEvents(db, runId, 15);

    const adapter = dbAdapter(db);
    const result = getStuckInspectionHandler(adapter, runId);

    expect(result).not.toBeNull();
    if (!result) throw new Error('result is null');

    // (a) Exactly 10 events returned.
    expect(result.recentEvents).toHaveLength(10);

    // (b) Descending id order — first item has highest id.
    const returnedIds = result.recentEvents.map((e) => e.id);
    const sortedDesc = [...returnedIds].sort((a, b) => b - a);
    expect(returnedIds).toEqual(sortedDesc);

    // The returned ids should be the top 10 of the 15 inserted.
    const top10Ids = [...allIds].sort((a, b) => b - a).slice(0, 10);
    expect(returnedIds).toEqual(top10Ids);

    // (c) pendingApproval matches inserted approval.
    expect(result.pendingApproval).not.toBeNull();
    expect(result.pendingApproval?.toolName).toBe('bash');
    expect(result.pendingApproval?.input).toEqual({ cmd: 'echo hi' });

    // (d) stuckReason matches run column.
    expect(result.stuckReason).toBe(stuckReason);
    expect(result.runId).toBe(runId);
  });

  // -------------------------------------------------------------------------
  // Case 1b: fewer than 10 events — returns all of them
  // -------------------------------------------------------------------------
  it('returns all events when fewer than 10 exist', () => {
    const runId = 'run-inspect-02';
    seedStuckRun(db, runId, 'orphan_pty');
    seedRawEvents(db, runId, 5);

    const adapter = dbAdapter(db);
    const result = getStuckInspectionHandler(adapter, runId);

    expect(result).not.toBeNull();
    expect(result?.recentEvents).toHaveLength(5);
  });

  // -------------------------------------------------------------------------
  // Case 1c: no pending approval — pendingApproval is null
  // -------------------------------------------------------------------------
  it('returns null pendingApproval when no pending approval exists', () => {
    const runId = 'run-inspect-03';
    seedStuckRun(db, runId, 'stale_socket');
    seedRawEvents(db, runId, 3);

    const adapter = dbAdapter(db);
    const result = getStuckInspectionHandler(adapter, runId);

    expect(result?.pendingApproval).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Case 1d: run does not exist — returns null
  // -------------------------------------------------------------------------
  it('returns null for a non-existent runId', () => {
    const adapter = dbAdapter(db);
    const result = getStuckInspectionHandler(adapter, 'nonexistent-run');
    expect(result).toBeNull();
  });

});
