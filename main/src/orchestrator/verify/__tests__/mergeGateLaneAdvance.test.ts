/**
 * Unit tests for mergeGateLaneAdvance — the visual MERGE-GATE lane driver
 * (locked decision #2). Two layers:
 *
 *  A. decideMergeGate — the PURE loopback policy (no DB). Mirrors the task-verify
 *     3× cap: PASS / low_confidence → advance-integrated; FAIL under the cap →
 *     loopback-implement with a bumped attempt; FAIL at/over the cap → mark-failed;
 *     skipped/timeout → noop.
 *
 *  B. applyMergeGateVerdict — the WRITE side, against a migration-backed in-memory
 *     DB + the real SprintLaneStore chokepoint. Verifies run→batch→lane attribution
 *     (single-lane, taskRef in a multi-lane batch, ambiguous-no-ref skip, non-sprint
 *     run no-op), the actual lane writes (integrated / implement-loopback / failed),
 *     the monotonic-forward terminal-lane guard, and the sprintLaneEvents emission.
 *
 * Uses the same migration chain as sprintLaneStore.test.ts (006 → 011 → 014 → 015
 * → 022 → 023 → 025) so workflow_runs (006) + batch_id (022) + sprint_batch_tasks
 * (022/023/025) + tasks (015) all exist.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SprintLaneStore,
  sprintLaneEvents,
  sprintLaneChannel,
} from '../../sprintLaneStore';
import {
  decideMergeGate,
  applyMergeGateVerdict,
  isMergeGateBlocking,
  MERGE_GATE_ATTEMPT_CAP,
} from '../mergeGateLaneAdvance';
import type { VerdictV1 } from '../../../../../shared/types/visualVerification';
import type { SprintLaneChangedEvent } from '../../../../../shared/types/sprintBatch';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

/** Insert a workflow_runs row, optionally stamped with a batch_id (sprint run). */
function seedRun(db: Database.Database, runId: string, batchId: string | null): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, batch_id)
     VALUES (?, 'wf-1', 1, 'running', ?)`,
  ).run(runId, batchId);
}

function passVerdict(): VerdictV1 {
  return {
    status: 'pass',
    confidence: 0.9,
    issues: [],
    feedback: 'looks right',
    judgedFileNames: ['home.png'],
    baselineUsed: false,
    model: 'test',
  };
}

function failVerdict(): VerdictV1 {
  return {
    status: 'fail',
    confidence: 0.9,
    issues: [{ severity: 'high', description: 'button missing', fileName: 'home.png' }],
    feedback: 'add the submit button',
    judgedFileNames: ['home.png'],
    baselineUsed: false,
    model: 'test',
  };
}

// ---------------------------------------------------------------------------
// A. decideMergeGate (pure)
// ---------------------------------------------------------------------------

describe('decideMergeGate (pure loopback policy)', () => {
  it('PASS advances the lane to integrated', () => {
    expect(decideMergeGate({ status: 'passed', verdict: passVerdict(), currentAttempts: 0 })).toEqual({
      kind: 'advance-integrated',
    });
  });

  it('low_confidence advances the lane (advisory; never an auto-loop)', () => {
    expect(decideMergeGate({ status: 'low_confidence', verdict: undefined, currentAttempts: 0 })).toEqual({
      kind: 'advance-integrated',
    });
  });

  it('FAIL on a fresh lane (attempts 0) loops back to implement at attempt 2', () => {
    expect(decideMergeGate({ status: 'failed', verdict: failVerdict(), currentAttempts: 0 })).toEqual({
      kind: 'loopback-implement',
      nextAttempt: 2,
    });
  });

  it('FAIL on a once-looped lane (attempts 2) loops back at attempt 3', () => {
    expect(decideMergeGate({ status: 'failed', verdict: failVerdict(), currentAttempts: 2 })).toEqual({
      kind: 'loopback-implement',
      nextAttempt: 3,
    });
  });

  it('FAIL at the 3× cap (attempts 3) marks the lane failed (no 4th loop)', () => {
    expect(decideMergeGate({ status: 'failed', verdict: failVerdict(), currentAttempts: MERGE_GATE_ATTEMPT_CAP })).toEqual({
      kind: 'mark-failed',
    });
  });

  it('FAIL with no verdict (capture-fail) still loops back (no feedback to thread)', () => {
    expect(decideMergeGate({ status: 'failed', verdict: undefined, currentAttempts: 0 })).toEqual({
      kind: 'loopback-implement',
      nextAttempt: 2,
    });
  });

  it('skipped / timeout are no-ops (a missing precondition never wedges a lane)', () => {
    expect(decideMergeGate({ status: 'skipped', verdict: undefined, currentAttempts: 0 })).toEqual({
      kind: 'noop',
      reason: 'skipped',
    });
    expect(decideMergeGate({ status: 'timeout', verdict: undefined, currentAttempts: 1 })).toEqual({
      kind: 'noop',
      reason: 'timeout',
    });
  });

  it('isMergeGateBlocking: loopback + failed BLOCK; advance/noop do not', () => {
    expect(isMergeGateBlocking({ kind: 'loopback-implement', nextAttempt: 2 })).toBe(true);
    expect(isMergeGateBlocking({ kind: 'mark-failed' })).toBe(true);
    expect(isMergeGateBlocking({ kind: 'advance-integrated' })).toBe(false);
    expect(isMergeGateBlocking({ kind: 'noop', reason: 'x' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B. applyMergeGateVerdict (write side)
// ---------------------------------------------------------------------------

describe('applyMergeGateVerdict (lane write side)', () => {
  let db: Database.Database;
  let store: SprintLaneStore;

  beforeEach(() => {
    db = buildDb();
    store = SprintLaneStore.initialize(dbAdapter(db));
  });

  afterEach(() => {
    SprintLaneStore._resetForTesting();
    sprintLaneEvents.removeAllListeners();
    db.close();
  });

  /** Read a single lane's status / step / attempts directly from the table. */
  function readLane(batchId: string, taskId: string): { status: string; step: string | null; attempts: number } {
    const row = db
      .prepare('SELECT status, current_step_id AS step, attempts FROM sprint_batch_tasks WHERE batch_id = ? AND task_id = ?')
      .get(batchId, taskId) as { status: string; step: string | null; attempts: number };
    return row;
  }

  it('PASS advances a single-lane batch to integrated (no taskRef needed)', () => {
    seedTask(db, 'tsk_a', 'TASK-001', 'A');
    const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);
    seedRun(db, 'run-1', batchId);
    // Park the lane at awaiting-verify first.
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', status: 'running', currentStepId: 'awaiting-verify' });

    const action = applyMergeGateVerdict({ db: dbAdapter(db), runId: 'run-1', status: 'passed', verdict: passVerdict() });
    expect(action).toEqual({ kind: 'advance-integrated' });
    expect(readLane(batchId, 'tsk_a')).toEqual({ status: 'integrated', step: 'visual-verify', attempts: 0 });
  });

  it('FAIL loops a single lane back to implement with attempt 2', () => {
    seedTask(db, 'tsk_a', 'TASK-001', 'A');
    const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);
    seedRun(db, 'run-1', batchId);
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', status: 'running', currentStepId: 'awaiting-verify' });

    const action = applyMergeGateVerdict({ db: dbAdapter(db), runId: 'run-1', status: 'failed', verdict: failVerdict() });
    expect(action).toEqual({ kind: 'loopback-implement', nextAttempt: 2 });
    expect(readLane(batchId, 'tsk_a')).toEqual({ status: 'running', step: 'implement', attempts: 2 });
  });

  it('FAIL at the cap marks the lane failed', () => {
    seedTask(db, 'tsk_a', 'TASK-001', 'A');
    const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);
    seedRun(db, 'run-1', batchId);
    // Lane already re-implemented to attempt 3, parked again at awaiting-verify.
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', status: 'running', currentStepId: 'awaiting-verify', attempt: MERGE_GATE_ATTEMPT_CAP });

    const action = applyMergeGateVerdict({ db: dbAdapter(db), runId: 'run-1', status: 'failed', verdict: failVerdict() });
    expect(action).toEqual({ kind: 'mark-failed' });
    const lane = readLane(batchId, 'tsk_a');
    expect(lane.status).toBe('failed');
    expect(lane.attempts).toBe(MERGE_GATE_ATTEMPT_CAP);
  });

  it('attributes the verdict to the right lane via taskRef in a multi-lane batch', () => {
    seedTask(db, 'tsk_a', 'TASK-001', 'A');
    seedTask(db, 'tsk_b', 'TASK-002', 'B');
    const { batchId } = store.createForRun(1, 'sdk', ['tsk_a', 'tsk_b']);
    seedRun(db, 'run-1', batchId);
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', status: 'running', currentStepId: 'awaiting-verify' });
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_b', status: 'running', currentStepId: 'awaiting-verify' });

    // taskRef = the display ref of lane B → only B advances; A stays parked.
    const action = applyMergeGateVerdict({ db: dbAdapter(db), runId: 'run-1', status: 'passed', verdict: passVerdict(), taskRef: 'TASK-002' });
    expect(action).toEqual({ kind: 'advance-integrated' });
    expect(readLane(batchId, 'tsk_b').status).toBe('integrated');
    expect(readLane(batchId, 'tsk_a').status).toBe('running');
  });

  it('accepts the opaque task id as taskRef too', () => {
    seedTask(db, 'tsk_a', 'TASK-001', 'A');
    seedTask(db, 'tsk_b', 'TASK-002', 'B');
    const { batchId } = store.createForRun(1, 'sdk', ['tsk_a', 'tsk_b']);
    seedRun(db, 'run-1', batchId);
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', status: 'running', currentStepId: 'awaiting-verify' });

    const action = applyMergeGateVerdict({ db: dbAdapter(db), runId: 'run-1', status: 'passed', verdict: passVerdict(), taskRef: 'tsk_a' });
    expect(action).toEqual({ kind: 'advance-integrated' });
    expect(readLane(batchId, 'tsk_a').status).toBe('integrated');
  });

  it('skips (noop) a multi-lane batch with no taskRef — never guesses', () => {
    seedTask(db, 'tsk_a', 'TASK-001', 'A');
    seedTask(db, 'tsk_b', 'TASK-002', 'B');
    const { batchId } = store.createForRun(1, 'sdk', ['tsk_a', 'tsk_b']);
    seedRun(db, 'run-1', batchId);
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', status: 'running', currentStepId: 'awaiting-verify' });

    const action = applyMergeGateVerdict({ db: dbAdapter(db), runId: 'run-1', status: 'passed', verdict: passVerdict() });
    expect(action).toEqual({ kind: 'noop', reason: 'lane-unresolved' });
    expect(readLane(batchId, 'tsk_a').status).toBe('running'); // untouched
  });

  it('no-ops for a non-sprint run (workflow_runs.batch_id NULL)', () => {
    seedRun(db, 'run-quick', null);
    const action = applyMergeGateVerdict({ db: dbAdapter(db), runId: 'run-quick', status: 'failed', verdict: failVerdict() });
    expect(action).toEqual({ kind: 'noop', reason: 'lane-unresolved' });
  });

  it('never resurrects a terminal lane (already integrated)', () => {
    seedTask(db, 'tsk_a', 'TASK-001', 'A');
    const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);
    seedRun(db, 'run-1', batchId);
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', status: 'integrated', currentStepId: 'visual-verify' });

    const action = applyMergeGateVerdict({ db: dbAdapter(db), runId: 'run-1', status: 'failed', verdict: failVerdict() });
    expect(action).toEqual({ kind: 'noop', reason: 'lane-terminal:integrated' });
    expect(readLane(batchId, 'tsk_a').status).toBe('integrated');
  });

  it('skipped/timeout verdicts touch no lane', () => {
    seedTask(db, 'tsk_a', 'TASK-001', 'A');
    const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);
    seedRun(db, 'run-1', batchId);
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', status: 'running', currentStepId: 'awaiting-verify' });

    expect(applyMergeGateVerdict({ db: dbAdapter(db), runId: 'run-1', status: 'skipped', verdict: undefined })).toEqual({
      kind: 'noop',
      reason: 'skipped',
    });
    expect(readLane(batchId, 'tsk_a').status).toBe('running');
  });

  it('emits a SprintLaneChangedEvent on the run channel when it drives a lane', () => {
    seedTask(db, 'tsk_a', 'TASK-001', 'A');
    const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);
    seedRun(db, 'run-1', batchId);
    store.updateLane({ runId: 'run-1', batchId, taskId: 'tsk_a', status: 'running', currentStepId: 'awaiting-verify' });

    const events: SprintLaneChangedEvent[] = [];
    sprintLaneEvents.on(sprintLaneChannel('run-1'), (e: SprintLaneChangedEvent) => events.push(e));

    applyMergeGateVerdict({ db: dbAdapter(db), runId: 'run-1', status: 'passed', verdict: passVerdict() });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ runId: 'run-1', taskId: 'tsk_a', status: 'integrated', currentStepId: 'visual-verify' });
  });

  it('no-ops cleanly when SprintLaneStore is not initialized', () => {
    SprintLaneStore._resetForTesting();
    const action = applyMergeGateVerdict({ db: dbAdapter(db), runId: 'run-1', status: 'passed', verdict: passVerdict() });
    expect(action).toEqual({ kind: 'noop', reason: 'store-uninitialized' });
  });
});
