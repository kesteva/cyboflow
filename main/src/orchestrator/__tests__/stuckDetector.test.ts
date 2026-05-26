/**
 * Unit tests for StuckDetector.
 *
 * Test targets per the task plan:
 *
 * 1. Scheduling: 60s interval fires scan; stop() cancels it.
 * 2. 5-minute filter: only approvals older than 5 min reach classifyStaleApproval.
 * 3. Classification variants: orphan_pty, stale_socket, self_deadlock, cross_run_deadlock.
 * 4. Status guard: run already canceled — no stuck transition fires.
 * 5. Idempotency: three scan ticks, only one 'runs:stuck' event.
 * 6. Error isolation: classifier throws on tick 1, scan continues on tick 2.
 * 7. Event emission shape: payload matches StuckDetectedEvent.
 *
 * All DB tests use in-memory better-sqlite3 with 006 + 007 migrations applied.
 * Migration runner is called twice in setup to verify idempotency (AC §1).
 * Interval tests use vi.useFakeTimers().
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import type Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import {
  StuckDetector,
  type ClaudeManagerLike,
  type PermissionServerLike,
  type StuckDetectorDeps,
} from '../stuckDetector';
import type { StuckDetectedEvent } from '../../../../shared/types/stuckDetection';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';
import { createTestDb, seedApproval } from '../__test_fixtures__/orchestratorTestDb';

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

/** Insert a workflow row (FK dependency for workflow_runs). */
function seedWorkflow(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json)
     VALUES (?, 1, 'test-workflow', '{}')`,
  ).run(id);
}

/**
 * Rebuilds workflow_runs with the 9-status CHECK constraint including
 * 'awaiting_input'. Use this in tests that need to seed a run in
 * 'awaiting_input' status — the GATE_SCHEMA fixture uses the pre-010
 * 8-status CHECK and rejects 'awaiting_input' inserts without this helper.
 *
 * Do NOT modify GATE_SCHEMA or orchestratorTestDb.ts — those are shared
 * fixtures intentionally mirroring the pre-010 state.
 */
function widenWorkflowRunsCheckToNineStatuses(db: Database.Database): void {
  db.exec(`
    PRAGMA foreign_keys=OFF;
    CREATE TABLE workflow_runs_wide (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      project_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'starting', 'running', 'awaiting_review', 'stuck', 'completed', 'failed', 'canceled', 'awaiting_input')),
      permission_mode_snapshot TEXT NOT NULL DEFAULT 'default',
      worktree_path TEXT,
      branch_name TEXT,
      policy_json TEXT,
      stuck_at DATETIME,
      stuck_reason TEXT,
      stuck_detected_at INTEGER,
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      ended_at DATETIME,
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
    );
    INSERT INTO workflow_runs_wide (
      id, workflow_id, project_id, status, permission_mode_snapshot,
      worktree_path, branch_name, policy_json, stuck_at, stuck_reason,
      stuck_detected_at, error_message, created_at, updated_at, started_at, ended_at
    )
    SELECT
      id, workflow_id, project_id, status, permission_mode_snapshot,
      worktree_path, branch_name, policy_json, stuck_at, stuck_reason,
      stuck_detected_at, error_message, created_at, updated_at, started_at, ended_at
    FROM workflow_runs;
    DROP TABLE workflow_runs;
    ALTER TABLE workflow_runs_wide RENAME TO workflow_runs;
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_created ON workflow_runs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_stuck_at ON workflow_runs(status, stuck_detected_at);
    PRAGMA foreign_keys=ON;
  `);
}

/** Insert a workflow_runs row. */
function seedRun(
  db: Database.Database,
  runId: string,
  status: 'running' | 'awaiting_review' | 'canceled' | 'completed' | 'failed' | 'stuck' | 'awaiting_input',
): void {
  const workflowId = `workflow-for-${runId}`;
  seedWorkflow(db, workflowId);
  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, worktree_path, status, policy_json)
     VALUES (?, ?, 1, '/tmp/test', ?, '{}')`,
  ).run(runId, workflowId, status);
}

/** Convert an age in milliseconds to an ISO timestamp relative to now. */
const ageMsToIso = (ageMs: number): string => new Date(Date.now() - ageMs).toISOString();

// ---------------------------------------------------------------------------
// Fake implementations
// ---------------------------------------------------------------------------

function makeClaudeManager(activeRunIds: Set<string> = new Set()): ClaudeManagerLike {
  return {
    hasActiveRunForId: (runId) => activeRunIds.has(runId),
  };
}

function makePermissionServer(connectedRunIds: Set<string> = new Set()): PermissionServerLike {
  return {
    hasClientForRun: (runId) => connectedRunIds.has(runId),
  };
}

// ---------------------------------------------------------------------------
// TEST 1: Scheduling — 60s interval fires scan; stop() cancels it
// ---------------------------------------------------------------------------

describe('StuckDetector scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not fire scan before start()', async () => {
    const rawDb = createTestDb({ includeStuckDetectedAt: true });
    const db = dbAdapter(rawDb);
    const emitter = new EventEmitter();
    const logger = makeSpyLogger();

    const detector = new StuckDetector({
      db,
      claudeManager: makeClaudeManager(),
      emitter,
      logger,
    });

    const scanSpy = vi.spyOn(detector, 'scan');

    // Advance 59 seconds — no scan should fire (detector not started)
    await vi.advanceTimersByTimeAsync(59_000);
    expect(scanSpy).not.toHaveBeenCalled();

    rawDb.close();
  });

  it('fires scan once after 60001ms', async () => {
    const rawDb = createTestDb({ includeStuckDetectedAt: true });
    const db = dbAdapter(rawDb);
    const emitter = new EventEmitter();
    const logger = makeSpyLogger();

    const detector = new StuckDetector({
      db,
      claudeManager: makeClaudeManager(),
      emitter,
      logger,
    });

    const scanSpy = vi.spyOn(detector, 'scan');

    detector.start();

    // Should not have fired yet
    expect(scanSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_001);
    expect(scanSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(scanSpy).toHaveBeenCalledTimes(2);

    detector.stop();
    rawDb.close();
  });

  it('stop() clears the interval and no further scans fire', async () => {
    const rawDb = createTestDb({ includeStuckDetectedAt: true });
    const db = dbAdapter(rawDb);
    const emitter = new EventEmitter();
    const logger = makeSpyLogger();

    const detector = new StuckDetector({
      db,
      claudeManager: makeClaudeManager(),
      emitter,
      logger,
    });

    const scanSpy = vi.spyOn(detector, 'scan');

    detector.start();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(scanSpy).toHaveBeenCalledTimes(1);

    detector.stop();

    // No more scans after stop
    await vi.advanceTimersByTimeAsync(120_000);
    expect(scanSpy).toHaveBeenCalledTimes(1);

    rawDb.close();
  });
});

// ---------------------------------------------------------------------------
// TEST 2: 5-minute filter
// ---------------------------------------------------------------------------

describe('StuckDetector 5-minute filter', () => {
  it('only evaluates approvals older than 5 minutes', async () => {
    const rawDb = createTestDb({ includeStuckDetectedAt: true });
    const db = dbAdapter(rawDb);
    const emitter = new EventEmitter();
    const logger = makeSpyLogger();

    // Two runs — both awaiting_review
    seedRun(rawDb, 'run-young', 'awaiting_review');
    seedRun(rawDb, 'run-old', 'awaiting_review');

    // young approval: 4 minutes old — should NOT be evaluated
    seedApproval(rawDb, { id: 'approval-young', runId: 'run-young', toolName: 'Bash', createdAt: ageMsToIso(4 * 60 * 1000) });
    // old approval: 6 minutes old — SHOULD be evaluated
    seedApproval(rawDb, { id: 'approval-old', runId: 'run-old', toolName: 'Bash', createdAt: ageMsToIso(6 * 60 * 1000) });

    // claudeManager: run-old is active (so orphan_pty doesn't fire),
    // cross_run_deadlock will match because run-young is in awaiting_review
    const activeRuns = new Set(['run-young', 'run-old']);
    const connectedRuns = new Set(['run-young', 'run-old']);

    const classifySpy = vi.spyOn(
      StuckDetector.prototype,
      'classifyStaleApproval',
    );

    const detector = new StuckDetector({
      db,
      claudeManager: makeClaudeManager(activeRuns),
      permissionServer: makePermissionServer(connectedRuns),
      emitter,
      logger,
    });

    await detector.scan();

    // classifyStaleApproval should only have been called once (for the 6-min-old approval)
    expect(classifySpy).toHaveBeenCalledTimes(1);
    const calledWith = classifySpy.mock.calls[0][0] as { id: string };
    expect(calledWith.id).toBe('approval-old');

    classifySpy.mockRestore();
    detector.stop();
    rawDb.close();
  });
});

// ---------------------------------------------------------------------------
// TEST 3a: Classification — orphan_pty
// ---------------------------------------------------------------------------

describe('StuckDetector classification: orphan_pty', () => {
  it('returns orphan_pty when claudeManager has no active run', () => {
    const rawDb = createTestDb({ includeStuckDetectedAt: true });
    const db = dbAdapter(rawDb);
    const emitter = new EventEmitter();
    const logger = makeSpyLogger();

    seedRun(rawDb, 'run-orphan', 'awaiting_review');
    seedApproval(rawDb, { id: 'approval-orphan', runId: 'run-orphan', toolName: 'Bash', createdAt: ageMsToIso(6 * 60 * 1000) });

    // No active runs — triggers orphan_pty
    const detector = new StuckDetector({
      db,
      claudeManager: makeClaudeManager(new Set()), // empty — no active runs
      permissionServer: makePermissionServer(new Set(['run-orphan'])),
      emitter,
      logger,
    });

    const row = rawDb
      .prepare("SELECT id, run_id, status, created_at FROM approvals WHERE id = 'approval-orphan'")
      .get() as { id: string; run_id: string; status: string; created_at: string };

    const reason = detector.classifyStaleApproval(row);
    expect(reason).toEqual({ kind: 'orphan_pty' });

    rawDb.close();
  });
});

// ---------------------------------------------------------------------------
// TEST 3b: Classification — stale_socket
// ---------------------------------------------------------------------------

describe('StuckDetector classification: stale_socket', () => {
  it('returns stale_socket when permissionServer has no connected client', () => {
    const rawDb = createTestDb({ includeStuckDetectedAt: true });
    const db = dbAdapter(rawDb);
    const emitter = new EventEmitter();
    const logger = makeSpyLogger();

    seedRun(rawDb, 'run-socket', 'awaiting_review');
    seedApproval(rawDb, { id: 'approval-socket', runId: 'run-socket', toolName: 'Bash', createdAt: ageMsToIso(6 * 60 * 1000) });

    // Run is active (no orphan_pty), but no socket client (stale_socket)
    const detector = new StuckDetector({
      db,
      claudeManager: makeClaudeManager(new Set(['run-socket'])),
      permissionServer: makePermissionServer(new Set()), // no connected clients
      emitter,
      logger,
    });

    const row = rawDb
      .prepare("SELECT id, run_id, status, created_at FROM approvals WHERE id = 'approval-socket'")
      .get() as { id: string; run_id: string; status: string; created_at: string };

    const reason = detector.classifyStaleApproval(row);
    expect(reason).toEqual({ kind: 'stale_socket' });

    rawDb.close();
  });
});

// ---------------------------------------------------------------------------
// TEST 3c: Classification — self_deadlock
// ---------------------------------------------------------------------------

describe('StuckDetector classification: self_deadlock', () => {
  it('returns self_deadlock when the same run has another pending approval', () => {
    const rawDb = createTestDb({ includeStuckDetectedAt: true });
    const db = dbAdapter(rawDb);
    const emitter = new EventEmitter();
    const logger = makeSpyLogger();

    seedRun(rawDb, 'run-self', 'awaiting_review');
    // Two pending approvals for the same run
    seedApproval(rawDb, { id: 'approval-self-1', runId: 'run-self', toolName: 'Bash', createdAt: ageMsToIso(6 * 60 * 1000) });
    seedApproval(rawDb, { id: 'approval-self-2', runId: 'run-self', toolName: 'Bash', createdAt: ageMsToIso(7 * 60 * 1000) });

    // Run is active and socket is connected — only self_deadlock should match
    const detector = new StuckDetector({
      db,
      claudeManager: makeClaudeManager(new Set(['run-self'])),
      permissionServer: makePermissionServer(new Set(['run-self'])),
      emitter,
      logger,
    });

    const row = rawDb
      .prepare("SELECT id, run_id, status, created_at FROM approvals WHERE id = 'approval-self-1'")
      .get() as { id: string; run_id: string; status: string; created_at: string };

    const reason = detector.classifyStaleApproval(row);
    expect(reason).toEqual({ kind: 'self_deadlock' });

    rawDb.close();
  });
});

// ---------------------------------------------------------------------------
// TEST 3d: Classification — cross_run_deadlock
// ---------------------------------------------------------------------------

describe('StuckDetector classification: cross_run_deadlock', () => {
  it('returns cross_run_deadlock when another run is awaiting_review', () => {
    const rawDb = createTestDb({ includeStuckDetectedAt: true });
    const db = dbAdapter(rawDb);
    const emitter = new EventEmitter();
    const logger = makeSpyLogger();

    seedRun(rawDb, 'run-cross-1', 'awaiting_review');
    seedRun(rawDb, 'run-cross-2', 'awaiting_review'); // conflicting run
    seedApproval(rawDb, { id: 'approval-cross', runId: 'run-cross-1', toolName: 'Bash', createdAt: ageMsToIso(6 * 60 * 1000) });

    // Both runs active, both have sockets, no self_deadlock on run-cross-1
    const detector = new StuckDetector({
      db,
      claudeManager: makeClaudeManager(new Set(['run-cross-1', 'run-cross-2'])),
      permissionServer: makePermissionServer(new Set(['run-cross-1', 'run-cross-2'])),
      emitter,
      logger,
    });

    const row = rawDb
      .prepare("SELECT id, run_id, status, created_at FROM approvals WHERE id = 'approval-cross'")
      .get() as { id: string; run_id: string; status: string; created_at: string };

    const reason = detector.classifyStaleApproval(row);
    expect(reason).not.toBeNull();
    expect(reason?.kind).toBe('cross_run_deadlock');
    if (reason !== null && reason.kind === 'cross_run_deadlock') {
      expect(reason.conflictingRunId).toBe('run-cross-2');
    }

    rawDb.close();
  });
});

// ---------------------------------------------------------------------------
// TEST 4: Status guard — canceled run not transitioned
// ---------------------------------------------------------------------------

describe('StuckDetector status guard', () => {
  it('does not transition a run that is already canceled', async () => {
    const rawDb = createTestDb({ includeStuckDetectedAt: true });
    const db = dbAdapter(rawDb);
    const emitter = new EventEmitter();
    const logger = makeSpyLogger();
    const stuckEvents: StuckDetectedEvent[] = [];
    emitter.on('runs:stuck', (e: StuckDetectedEvent) => stuckEvents.push(e));

    // Insert the run in 'awaiting_review' first (needed for approval FK / scan logic)
    // then immediately update to 'canceled' to simulate concurrent cancellation.
    seedRun(rawDb, 'run-canceled', 'awaiting_review');
    rawDb
      .prepare(`UPDATE workflow_runs SET status = 'canceled' WHERE id = 'run-canceled'`)
      .run();

    // Approval is stale — 6 minutes old
    seedApproval(rawDb, { id: 'approval-canceled', runId: 'run-canceled', toolName: 'Bash', createdAt: ageMsToIso(6 * 60 * 1000) });

    // claudeManager: run not active — orphan_pty would fire classification
    const detector = new StuckDetector({
      db,
      claudeManager: makeClaudeManager(new Set()), // no active runs
      emitter,
      logger,
    });

    await detector.scan();

    // The transaction UPDATE ... WHERE id = ? AND status = 'awaiting_review'
    // should return changes === 0 because the run is 'canceled'.
    expect(stuckEvents).toHaveLength(0);

    // Verify run is still 'canceled'
    const run = rawDb
      .prepare("SELECT status FROM workflow_runs WHERE id = 'run-canceled'")
      .get() as { status: string };
    expect(run.status).toBe('canceled');

    rawDb.close();
  });
});

// ---------------------------------------------------------------------------
// TEST 5: Idempotency — 3 scan ticks, only 1 'runs:stuck' event
// ---------------------------------------------------------------------------

describe('StuckDetector idempotency', () => {
  it('emits runs:stuck exactly once across three scan ticks', async () => {
    const rawDb = createTestDb({ includeStuckDetectedAt: true });
    const db = dbAdapter(rawDb);
    const emitter = new EventEmitter();
    const logger = makeSpyLogger();
    const stuckEvents: StuckDetectedEvent[] = [];
    emitter.on('runs:stuck', (e: StuckDetectedEvent) => stuckEvents.push(e));

    seedRun(rawDb, 'run-idempotent', 'awaiting_review');
    seedApproval(rawDb, { id: 'approval-idempotent', runId: 'run-idempotent', toolName: 'Bash', createdAt: ageMsToIso(6 * 60 * 1000) });

    // No active run — orphan_pty classification
    const detector = new StuckDetector({
      db,
      claudeManager: makeClaudeManager(new Set()),
      emitter,
      logger,
    });

    // Three scan ticks
    await detector.scan();
    await detector.scan();
    await detector.scan();

    // Only one event should have fired (the transition guard prevents re-firing)
    expect(stuckEvents).toHaveLength(1);

    rawDb.close();
  });
});

// ---------------------------------------------------------------------------
// TEST 6: Error isolation — classifier throws, next scan still runs
// ---------------------------------------------------------------------------

describe('StuckDetector error isolation', () => {
  it('a scan error does not stop subsequent scans', async () => {
    const rawDb = createTestDb({ includeStuckDetectedAt: true });
    const db = dbAdapter(rawDb);
    const emitter = new EventEmitter();
    const logger = makeSpyLogger();

    seedRun(rawDb, 'run-error', 'awaiting_review');
    seedApproval(rawDb, { id: 'approval-error', runId: 'run-error', toolName: 'Bash', createdAt: ageMsToIso(6 * 60 * 1000) });

    let callCount = 0;
    // Classifier throws on first call, returns a reason on subsequent calls
    const claudeManager: ClaudeManagerLike = {
      hasActiveRunForId: (runId) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('simulated classifier error');
        }
        // Second call: run not active → orphan_pty
        return false;
      },
    };

    const detector = new StuckDetector({
      db,
      claudeManager,
      emitter,
      logger,
    });

    // Tick 1: should throw internally, scan catches it
    await detector.scan();

    // Logger should have been warned
    const warnCalls = logger.calls.filter((c) => c.level === 'warn');
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    expect(warnCalls.some((c) => c.message.includes('[StuckDetector]'))).toBe(true);

    // Tick 2: should succeed (second call returns false → orphan_pty)
    await detector.scan();

    // Two calls to hasActiveRunForId (one per scan tick)
    expect(callCount).toBe(2);

    rawDb.close();
  });
});

// ---------------------------------------------------------------------------
// TEST 7: Event emission shape
// ---------------------------------------------------------------------------

describe('StuckDetector event emission shape', () => {
  it('emits runs:stuck with the correct StuckDetectedEvent payload', async () => {
    const rawDb = createTestDb({ includeStuckDetectedAt: true });
    const db = dbAdapter(rawDb);
    const emitter = new EventEmitter();
    const logger = makeSpyLogger();
    const stuckEvents: StuckDetectedEvent[] = [];
    emitter.on('runs:stuck', (e: StuckDetectedEvent) => stuckEvents.push(e));

    seedRun(rawDb, 'run-event', 'awaiting_review');
    seedApproval(rawDb, { id: 'approval-event', runId: 'run-event', toolName: 'Bash', createdAt: ageMsToIso(6 * 60 * 1000) });

    // No active run — orphan_pty
    const detector = new StuckDetector({
      db,
      claudeManager: makeClaudeManager(new Set()),
      emitter,
      logger,
    });

    const beforeScan = Date.now();
    await detector.scan();
    const afterScan = Date.now();

    expect(stuckEvents).toHaveLength(1);
    const event = stuckEvents[0];

    // Shape validation
    expect(event.runId).toBe('run-event');
    expect(event.approvalId).toBe('approval-event');
    expect(event.reason).toEqual({ kind: 'orphan_pty' });
    expect(typeof event.detectedAt).toBe('number');
    expect(event.detectedAt).toBeGreaterThanOrEqual(beforeScan);
    expect(event.detectedAt).toBeLessThanOrEqual(afterScan);

    // Verify the DB row was also updated correctly
    const run = rawDb
      .prepare('SELECT status, stuck_reason, stuck_detected_at FROM workflow_runs WHERE id = ?')
      .get('run-event') as {
      status: string;
      stuck_reason: string;
      stuck_detected_at: number;
    };
    expect(run.status).toBe('stuck');
    expect(run.stuck_reason).toBe('orphan_pty');
    expect(run.stuck_detected_at).toBe(event.detectedAt);

    rawDb.close();
  });
});

// ---------------------------------------------------------------------------
// TEST 8: awaiting_input exemption — stale approval does NOT cause stuck transition
// ---------------------------------------------------------------------------

describe('StuckDetector awaiting_input exemption', () => {
  it('does NOT classify awaiting_input runs as stuck even when an associated approval is stale', async () => {
    const rawDb = createTestDb({ includeStuckDetectedAt: true });
    const db = dbAdapter(rawDb);
    const emitter = new EventEmitter();
    const logger = makeSpyLogger();
    const events: StuckDetectedEvent[] = [];
    emitter.on('runs:stuck', (e: StuckDetectedEvent) => events.push(e));

    // Widen the CHECK constraint to accept 'awaiting_input' — GATE_SCHEMA uses
    // the pre-010 8-status CHECK and would reject the seedRun insert below.
    widenWorkflowRunsCheckToNineStatuses(rawDb);

    // Seed an awaiting_input run + a stale pending approval.
    seedRun(rawDb, 'run-ai', 'awaiting_input');
    rawDb
      .prepare(
        `INSERT INTO approvals (id, run_id, tool_name, tool_input_json, tool_use_id, status, created_at)
         VALUES ('a-stale', 'run-ai', 'Bash', '{}', 'tu-1', 'pending', ?)`,
      )
      .run(ageMsToIso(10 * 60_000));

    // claudeManager: hasActiveRunForId returns false → orphan_pty classification.
    // But the UPDATE `WHERE id = ? AND status = 'awaiting_review'` won't match
    // (the run is in 'awaiting_input'), so changes === 0 and no event fires.
    const detector = new StuckDetector({
      db,
      claudeManager: makeClaudeManager(),
      emitter,
      logger,
    });
    await detector.scan();

    expect(events).toHaveLength(0);

    // workflow_runs row stays in awaiting_input.
    const row = rawDb
      .prepare('SELECT status FROM workflow_runs WHERE id = ?')
      .get('run-ai') as { status: string };
    expect(row.status).toBe('awaiting_input');

    rawDb.close();
  });
});

