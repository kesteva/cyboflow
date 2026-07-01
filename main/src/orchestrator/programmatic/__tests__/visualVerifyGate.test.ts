/**
 * SchedulerVisualVerifyGate — the production programmatic visual merge-gate
 * resolver. Tests the actuation path that closes the prose-only boundary: park,
 * await the async verdict, resolve the controller outcome from the lane the
 * merge-gate wrote.
 *
 * Covers:
 *  - isActive reads the run's verify_enabled stamp (true / false / missing run).
 *  - disabled run → 'advance' immediately (never parks).
 *  - no request fired for the lane → 'advance' (race-closer: nothing to wait for).
 *  - request ALREADY terminal (verdict landed before subscribe): passed→advance,
 *    failed→loopback(attempt), failed-at-cap→failed, skipped(lane parked)→advance.
 *  - non-terminal request → awaits the verificationEvents terminal event, then
 *    resolves from the (merge-gate-written) lane state.
 *  - abort → 'aborted' + listener cleanup.
 *  - multi-lane taskRef attribution.
 *
 * Migration chain = the merge-gate test's (006→011→014→015→022→023→025) PLUS 036
 * for verification_requests + the workflow_runs verify_* columns the gate reads.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SprintLaneStore, sprintLaneEvents } from '../../sprintLaneStore';
import {
  verificationEvents,
  verificationChannel,
  type VerificationTerminalEvent,
} from '../../verify/verificationScheduler';
import { SchedulerVisualVerifyGate } from '../visualVerifyGate';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import type { RequestStatus } from '../../../../../shared/types/visualVerification';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');
  const migDir = join(__dirname, '..', '..', '..', 'database', 'migrations');
  for (const f of [
    '006_cyboflow_schema.sql',
    '011_workflow_step_tracking.sql',
    '014_native_tasks.sql',
    '015_entity_model_rebuild.sql',
    '022_sprint_batches.sql',
    '023_sprint_lane_step.sql',
    '025_sprint_lane_attempts.sql',
    '036_visual_verification.sql',
  ]) {
    db.exec(readFileSync(join(migDir, f), 'utf-8'));
  }
  return db;
}

function seedTask(db: Database.Database, id: string, ref: string, title: string): void {
  db.prepare(
    `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id)
     VALUES (?, 1, ?, ?, 'board-1-default', 'stage-board-1-default-5')`,
  ).run(id, ref, title);
}

function seedRun(db: Database.Database, runId: string, batchId: string | null, verifyEnabled: boolean): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, batch_id, verify_enabled)
     VALUES (?, 'wf-1', 1, 'running', ?, ?)`,
  ).run(runId, batchId, verifyEnabled ? 1 : 0);
}

function seedRequest(
  db: Database.Database,
  opts: { id: string; runId: string; status: RequestStatus; taskRef?: string },
): void {
  const input = { intent: 'looks right', ...(opts.taskRef ? { taskRef: opts.taskRef } : {}) };
  db.prepare(
    `INSERT INTO verification_requests
       (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, attempt)
     VALUES (?, ?, 1, ?, 'static-render-snapshot', ?, '["capturePage"]', 0)`,
  ).run(opts.id, opts.runId, opts.status, JSON.stringify(input));
}

function gate(db: Database.Database): SchedulerVisualVerifyGate {
  return new SchedulerVisualVerifyGate({
    db: dbAdapter(db),
    events: verificationEvents,
    channelFor: verificationChannel,
  });
}

describe('SchedulerVisualVerifyGate', () => {
  let db: Database.Database;
  let store: SprintLaneStore;

  beforeEach(() => {
    db = buildDb();
    store = SprintLaneStore.initialize(dbAdapter(db));
  });

  afterEach(() => {
    SprintLaneStore._resetForTesting();
    sprintLaneEvents.removeAllListeners();
    verificationEvents.removeAllListeners();
    db.close();
  });

  /** Park a single-lane batch at awaiting-verify; return the batchId. */
  function singleLaneParked(runId: string, verifyEnabled = true): { batchId: string } {
    seedTask(db, 'tsk_a', 'TASK-001', 'A');
    const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);
    seedRun(db, runId, batchId, verifyEnabled);
    store.updateLane({ runId, batchId, taskId: 'tsk_a', status: 'running', currentStepId: 'awaiting-verify' });
    return { batchId };
  }

  it('isActive reflects the run verify_enabled stamp', () => {
    seedRun(db, 'run-on', null, true);
    seedRun(db, 'run-off', null, false);
    const g = gate(db);
    expect(g.isActive('run-on')).toBe(true);
    expect(g.isActive('run-off')).toBe(false);
    expect(g.isActive('missing')).toBe(false);
  });

  it('a disabled run advances immediately (never parks)', async () => {
    singleLaneParked('run-1', /* verifyEnabled */ false);
    await expect(gate(db).awaitVerdict({ runId: 'run-1', itemId: 'tsk_a' })).resolves.toEqual({ kind: 'advance' });
  });

  it('advances when no request was fired for the lane (nothing to wait for)', async () => {
    singleLaneParked('run-1');
    // No verification_requests row → advance.
    await expect(gate(db).awaitVerdict({ runId: 'run-1', itemId: 'tsk_a' })).resolves.toEqual({ kind: 'advance' });
  });

  it('race-closer: an already-PASSED request + integrated lane → advance', async () => {
    const { batchId } = singleLaneParked('run-1');
    seedRequest(db, { id: 'vr1', runId: 'run-1', status: 'passed', taskRef: 'TASK-001' });
    // The merge-gate already advanced the lane.
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', status: 'integrated', currentStepId: 'visual-verify' });
    await expect(gate(db).awaitVerdict({ runId: 'run-1', itemId: 'tsk_a' })).resolves.toEqual({ kind: 'advance' });
  });

  it('race-closer: an already-FAILED request + looped-back lane → loopback(attempt)', async () => {
    const { batchId } = singleLaneParked('run-1');
    seedRequest(db, { id: 'vr1', runId: 'run-1', status: 'failed', taskRef: 'TASK-001' });
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', status: 'running', currentStepId: 'implement', attempt: 2 });
    await expect(gate(db).awaitVerdict({ runId: 'run-1', itemId: 'tsk_a' })).resolves.toEqual({
      kind: 'loopback',
      attempt: 2,
    });
  });

  it('race-closer: a FAILED request + failed lane (cap) → failed', async () => {
    const { batchId } = singleLaneParked('run-1');
    seedRequest(db, { id: 'vr1', runId: 'run-1', status: 'failed', taskRef: 'TASK-001' });
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', status: 'failed', currentStepId: 'awaiting-verify' });
    await expect(gate(db).awaitVerdict({ runId: 'run-1', itemId: 'tsk_a' })).resolves.toEqual({ kind: 'failed' });
  });

  it('a SKIPPED request leaves the lane parked → advance (never wedge)', async () => {
    singleLaneParked('run-1');
    seedRequest(db, { id: 'vr1', runId: 'run-1', status: 'skipped', taskRef: 'TASK-001' });
    // Lane still at awaiting-verify (merge-gate no-op for skipped).
    await expect(gate(db).awaitVerdict({ runId: 'run-1', itemId: 'tsk_a' })).resolves.toEqual({ kind: 'advance' });
  });

  it('awaits the terminal event for a non-terminal request, then resolves from the lane', async () => {
    const { batchId } = singleLaneParked('run-1');
    seedRequest(db, { id: 'vr1', runId: 'run-1', status: 'running', taskRef: 'TASK-001' });

    const pending = gate(db).awaitVerdict({ runId: 'run-1', itemId: 'tsk_a' });

    // Simulate the scheduler delivering a FAIL: the merge-gate loops the lane back,
    // then the terminal event fires.
    db.prepare(`UPDATE verification_requests SET status = 'failed' WHERE id = 'vr1'`).run();
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', status: 'running', currentStepId: 'implement', attempt: 2 });
    const event: VerificationTerminalEvent = {
      runId: 'run-1',
      requestId: 'vr1',
      projectId: 1,
      status: 'failed',
      type: 'static-render-snapshot',
      taskRef: 'TASK-001',
    };
    verificationEvents.emit(verificationChannel('run-1'), event);

    await expect(pending).resolves.toEqual({ kind: 'loopback', attempt: 2 });
    // Listener cleaned up.
    expect(verificationEvents.listenerCount(verificationChannel('run-1'))).toBe(0);
  });

  it('aborts cleanly when the run signal fires while awaiting', async () => {
    singleLaneParked('run-1');
    seedRequest(db, { id: 'vr1', runId: 'run-1', status: 'running', taskRef: 'TASK-001' });
    const ac = new AbortController();
    const pending = gate(db).awaitVerdict({ runId: 'run-1', itemId: 'tsk_a', signal: ac.signal });
    ac.abort();
    await expect(pending).resolves.toEqual({ kind: 'aborted' });
    expect(verificationEvents.listenerCount(verificationChannel('run-1'))).toBe(0);
  });

  it('attributes a multi-lane event to the right lane via taskRef', async () => {
    seedTask(db, 'tsk_a', 'TASK-001', 'A');
    seedTask(db, 'tsk_b', 'TASK-002', 'B');
    const { batchId } = store.createForRun(1, 'sdk', ['tsk_a', 'tsk_b']);
    seedRun(db, 'run-1', batchId, true);
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', status: 'running', currentStepId: 'awaiting-verify' });
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_b', status: 'running', currentStepId: 'awaiting-verify' });
    seedRequest(db, { id: 'vr_a', runId: 'run-1', status: 'running', taskRef: 'TASK-001' });
    seedRequest(db, { id: 'vr_b', runId: 'run-1', status: 'running', taskRef: 'TASK-002' });

    const pendingA = gate(db).awaitVerdict({ runId: 'run-1', itemId: 'tsk_a' });

    // An event for lane B must NOT resolve lane A's gate.
    verificationEvents.emit(verificationChannel('run-1'), {
      runId: 'run-1',
      requestId: 'vr_b',
      projectId: 1,
      status: 'passed',
      type: 'static-render-snapshot',
      taskRef: 'TASK-002',
    } satisfies VerificationTerminalEvent);

    // Now resolve A: mark its request passed, advance its lane, emit A's event.
    db.prepare(`UPDATE verification_requests SET status = 'passed' WHERE id = 'vr_a'`).run();
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', status: 'integrated', currentStepId: 'visual-verify' });
    verificationEvents.emit(verificationChannel('run-1'), {
      runId: 'run-1',
      requestId: 'vr_a',
      projectId: 1,
      status: 'passed',
      type: 'static-render-snapshot',
      taskRef: 'TASK-001',
    } satisfies VerificationTerminalEvent);

    await expect(pendingA).resolves.toEqual({ kind: 'advance' });
  });

  // --------------------------------------------------------------------------
  // R3 gate-integrity regressions
  // --------------------------------------------------------------------------

  it('finding #1: a FAIL whose loopback lane write was CLOBBERED by the park still resolves loopback (not advance)', async () => {
    const { batchId } = singleLaneParked('run-1');
    seedRequest(db, { id: 'vr1', runId: 'run-1', status: 'failed', taskRef: 'TASK-001' });
    // The merge-gate looped the lane back to implement (attempt 2) — then the
    // controller's later park write CLOBBERED currentStepId back to awaiting-verify
    // (status='running' + attempts=2 survive; only the step id is overwritten).
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', status: 'running', currentStepId: 'implement', attempt: 2 });
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', currentStepId: 'awaiting-verify' });
    // Old code keyed the outcome on currentStepId (=awaiting-verify → 'advance', a
    // silent gate bypass); the fix keys on the terminal STATUS (=failed → loopback).
    await expect(gate(db).awaitVerdict({ runId: 'run-1', itemId: 'tsk_a' })).resolves.toEqual({
      kind: 'loopback',
      attempt: 2,
    });
  });

  it('finding #1 (event path): a FAIL event whose loopback write was clobbered still resolves loopback', async () => {
    const { batchId } = singleLaneParked('run-1');
    seedRequest(db, { id: 'vr1', runId: 'run-1', status: 'running', taskRef: 'TASK-001' });
    const pending = gate(db).awaitVerdict({ runId: 'run-1', itemId: 'tsk_a' });

    // Merge-gate loops the lane back, park clobbers the step id, THEN the event fires.
    db.prepare(`UPDATE verification_requests SET status = 'failed' WHERE id = 'vr1'`).run();
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', status: 'running', currentStepId: 'implement', attempt: 2 });
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', currentStepId: 'awaiting-verify' });
    verificationEvents.emit(verificationChannel('run-1'), {
      runId: 'run-1',
      requestId: 'vr1',
      projectId: 1,
      status: 'failed',
      type: 'static-render-snapshot',
      taskRef: 'TASK-001',
    } satisfies VerificationTerminalEvent);

    await expect(pending).resolves.toEqual({ kind: 'loopback', attempt: 2 });
  });

  it('PASS verdict before the park → advance (unchanged happy path)', async () => {
    const { batchId } = singleLaneParked('run-1');
    seedRequest(db, { id: 'vr1', runId: 'run-1', status: 'passed', taskRef: 'TASK-001' });
    // PASS integrated the lane; a stray park clobber cannot turn it into a loopback.
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', status: 'integrated', currentStepId: 'visual-verify' });
    await expect(gate(db).awaitVerdict({ runId: 'run-1', itemId: 'tsk_a' })).resolves.toEqual({ kind: 'advance' });
  });

  /** Park a 2-lane batch at awaiting-verify; return the batchId. */
  function twoLanesParked(runId: string): { batchId: string } {
    seedTask(db, 'tsk_a', 'TASK-001', 'A');
    seedTask(db, 'tsk_b', 'TASK-002', 'B');
    const { batchId } = store.createForRun(1, 'sdk', ['tsk_a', 'tsk_b']);
    seedRun(db, runId, batchId, true);
    store.updateLane({ runId, batchId, taskId: 'tsk_a', status: 'running', currentStepId: 'awaiting-verify' });
    store.updateLane({ runId, batchId, taskId: 'tsk_b', status: 'running', currentStepId: 'awaiting-verify' });
    return { batchId };
  }

  it('finding #2: a taskRef-less terminal event in a multi-lane run matches NO gate', async () => {
    const { batchId } = twoLanesParked('run-1');
    seedRequest(db, { id: 'vr_a', runId: 'run-1', status: 'running', taskRef: 'TASK-001' });
    seedRequest(db, { id: 'vr_b', runId: 'run-1', status: 'running', taskRef: 'TASK-002' });

    const pendingA = gate(db).awaitVerdict({ runId: 'run-1', itemId: 'tsk_a' });
    const pendingB = gate(db).awaitVerdict({ runId: 'run-1', itemId: 'tsk_b' });

    // A taskRef-LESS FAIL event (an agent omitted task_ref) must NOT resolve any lane.
    verificationEvents.emit(verificationChannel('run-1'), {
      runId: 'run-1',
      requestId: 'vr_x',
      projectId: 1,
      status: 'failed',
      type: 'static-render-snapshot',
    } satisfies VerificationTerminalEvent);

    const stillPending = new Promise((r) => setTimeout(() => r('still-pending'), 15));
    await expect(Promise.race([pendingA, pendingB, stillPending])).resolves.toBe('still-pending');

    // Each lane still resolves off ITS OWN taskRef'd event.
    db.prepare(`UPDATE verification_requests SET status = 'passed' WHERE id IN ('vr_a','vr_b')`).run();
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', status: 'integrated', currentStepId: 'visual-verify' });
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_b', status: 'integrated', currentStepId: 'visual-verify' });
    for (const [rid, ref] of [['vr_a', 'TASK-001'], ['vr_b', 'TASK-002']] as const) {
      verificationEvents.emit(verificationChannel('run-1'), {
        runId: 'run-1',
        requestId: rid,
        projectId: 1,
        status: 'passed',
        type: 'static-render-snapshot',
        taskRef: ref,
      } satisfies VerificationTerminalEvent);
    }
    await expect(pendingA).resolves.toEqual({ kind: 'advance' });
    await expect(pendingB).resolves.toEqual({ kind: 'advance' });
  });

  it('single-lane run: a taskRef-less terminal event still matches (backward compatible)', async () => {
    const { batchId } = singleLaneParked('run-1');
    seedRequest(db, { id: 'vr1', runId: 'run-1', status: 'running' /* no taskRef */ });
    const pending = gate(db).awaitVerdict({ runId: 'run-1', itemId: 'tsk_a' });

    db.prepare(`UPDATE verification_requests SET status = 'passed' WHERE id = 'vr1'`).run();
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', status: 'integrated', currentStepId: 'visual-verify' });
    verificationEvents.emit(verificationChannel('run-1'), {
      runId: 'run-1',
      requestId: 'vr1',
      projectId: 1,
      status: 'passed',
      type: 'static-render-snapshot',
    } satisfies VerificationTerminalEvent);

    await expect(pending).resolves.toEqual({ kind: 'advance' });
  });

  it('finding #3: a lane with no attributable request in a multi-lane run advances immediately (no park, no hang)', async () => {
    twoLanesParked('run-1');
    // Only lane A fired a request; lane B's subagent declared SKIPPED in-band.
    seedRequest(db, { id: 'vr_a', runId: 'run-1', status: 'running', taskRef: 'TASK-001' });
    // Old code bound the run's sole request to lane B (rows.length===1 fallback) and
    // parked B forever; the fix requires a strict taskRef match in a multi-lane run,
    // so B has NO attributable request → advance immediately.
    await expect(gate(db).awaitVerdict({ runId: 'run-1', itemId: 'tsk_b' })).resolves.toEqual({ kind: 'advance' });
  });

  it('finding #3: the sole-request fallback no longer binds a sibling in a multi-lane run', async () => {
    const { batchId } = twoLanesParked('run-1');
    // A single terminal FAIL request exists (taskRef=A). Lane B must not inherit it.
    seedRequest(db, { id: 'vr_a', runId: 'run-1', status: 'failed', taskRef: 'TASK-001' });
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', status: 'running', currentStepId: 'implement', attempt: 2 });
    await expect(gate(db).awaitVerdict({ runId: 'run-1', itemId: 'tsk_b' })).resolves.toEqual({ kind: 'advance' });
    // Lane A itself still resolves the FAIL to a loopback.
    await expect(gate(db).awaitVerdict({ runId: 'run-1', itemId: 'tsk_a' })).resolves.toEqual({ kind: 'loopback', attempt: 2 });
  });
});
