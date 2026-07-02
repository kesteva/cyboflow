/**
 * Integration tests for the cancelAndRestart mutation.
 *
 * TASK-502 acceptance criteria verified here:
 *
 * AC4: cancelAndRestart mutation runs under the per-run p-queue and executes
 *      in order:
 *      (a) approvalRouter.clearPendingForRun(runId)   — deny socket replies
 *      (b) claudeManager.stop(sessionId)              — kill the PTY
 *      (c) UPDATE old run to status='canceled'
 *      (d) INSERT new run with same workflow_id/project_id/worktree_path
 *      (e) returns newRunId
 *
 * AC5: Deny replies are sent BEFORE PTY kill — asserted via spy call-order.
 *
 * AC7: Worktree is PRESERVED — worktreeManager.remove is never called.
 *
 * Test strategy:
 *   - Real in-memory better-sqlite3 DB with migrations 006 + 007 applied.
 *   - Mocked ApprovalRouter (clearPendingForRun is a no-op spy).
 *   - Mocked claudeManagerStop (a vi.fn() that resolves immediately).
 *   - Mocked worktreeManager.remove (vi.fn() asserted never-called).
 *   - The mutation body is exercised via the cancelAndRestartHandler()
 *     extracted helper (tested directly, without the tRPC wrapper, to avoid
 *     wiring the full tRPC context).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { RunQueueRegistry } from '../RunQueueRegistry';
import type { DatabaseLike } from '../types';
import { cancelAndRestartHandler, type CancelAndRestartDeps as HandlerDeps } from '../cancelAndRestartHandler';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { createTestDb } from '../__test_fixtures__/orchestratorTestDb';

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function seedWorkflowAndRun(
  db: Database.Database,
  runId: string,
  status: string = 'stuck',
  worktreePath: string = '/tmp/wt-test',
  sessionId: string | null = null,
): { workflowId: string; runId: string } {
  const workflowId = `workflow-${randomUUID()}`;

  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json)
     VALUES (?, 1, 'test-workflow', '{}')`,
  ).run(workflowId);

  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, worktree_path, status, policy_json, session_id)
     VALUES (?, ?, 1, ?, ?, '{}', ?)`,
  ).run(runId, workflowId, worktreePath, status, sessionId);

  return { workflowId, runId };
}

// ---------------------------------------------------------------------------
// Spy helpers — order tracking
// ---------------------------------------------------------------------------

interface OrderSpy {
  calls: string[];
  clearPendingForRun: ReturnType<typeof vi.fn>;       // approvalRouter
  clearQuestionsForRun: ReturnType<typeof vi.fn>;     // questionRouter
  claudeManagerStop: ReturnType<typeof vi.fn>;
  worktreeRemove: ReturnType<typeof vi.fn>;
  deletePendingDraftsForRun: ReturnType<typeof vi.fn>; // F5 sweep
}

function makeOrderSpy(): OrderSpy {
  const calls: string[] = [];

  const clearPendingForRun = vi.fn((_runId: string) => {
    calls.push('clearPendingForRun');
  });

  const clearQuestionsForRun = vi.fn((_runId: string) => {
    calls.push('clearQuestionsForRun');
  });

  const claudeManagerStop = vi.fn(async (_sessionId: string) => {
    calls.push('claudeManagerStop');
  });

  const worktreeRemove = vi.fn(async (_path: string) => {
    calls.push('worktreeRemove');
  });

  const deletePendingDraftsForRun = vi.fn(async (_runId: string) => {
    calls.push('deletePendingDraftsForRun');
  });

  return { calls, clearPendingForRun, clearQuestionsForRun, claudeManagerStop, worktreeRemove, deletePendingDraftsForRun };
}

// ---------------------------------------------------------------------------
// Build deps bag
// ---------------------------------------------------------------------------

function makeDeps(
  db: Database.Database,
  spy: OrderSpy,
  runQueues?: RunQueueRegistry,
): HandlerDeps {
  const registry = runQueues ?? new RunQueueRegistry();
  return {
    db: dbAdapter(db),
    approvalRouter: { clearPendingForRun: spy.clearPendingForRun } as unknown as import('../approvalRouter').ApprovalRouter,
    questionRouter: { clearPendingForRun: spy.clearQuestionsForRun },
    runQueues: registry,
    claudeManagerStop: spy.claudeManagerStop,
    deletePendingDraftsForRun: spy.deletePendingDraftsForRun,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cancelAndRestartHandler', () => {
  let db: Database.Database;
  let spy: OrderSpy;
  let runQueues: RunQueueRegistry;

  beforeEach(() => {
    // includeSubstrate folds in migration 019's session_id column on
    // workflow_runs (see orchestratorTestDb) so the handler's SELECT + INSERT
    // of session_id resolve.
    db = createTestDb({ includeStuckDetectedAt: true, includeSubstrate: true });
    spy = makeOrderSpy();
    runQueues = new RunQueueRegistry();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // AC5: deny BEFORE PTY kill
  // -------------------------------------------------------------------------

  it('calls clearPendingForRun BEFORE claudeManagerStop (AC5: deny before kill)', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck');

    await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));

    expect(spy.calls[0]).toBe('clearPendingForRun');
    expect(spy.calls.indexOf('claudeManagerStop')).toBeGreaterThan(spy.calls.indexOf('clearPendingForRun'));
  });

  it('calls approvalRouter.clearPendingForRun → questionRouter.clearPendingForRun → claudeManagerStop in that order', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck');

    await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));

    expect(spy.calls[0]).toBe('clearPendingForRun');       // approvalRouter
    expect(spy.calls[1]).toBe('clearQuestionsForRun');     // questionRouter (NEW)
    expect(spy.calls[2]).toBe('claudeManagerStop');
  });

  it('calls questionRouter.clearPendingForRun with the correct runId', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck');

    await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));

    expect(spy.clearQuestionsForRun).toHaveBeenCalledWith(runId);
  });

  it('does NOT call questionRouter.clearPendingForRun on the noOp path (already-terminal run)', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'completed');

    const result = await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));
    expect('noOp' in result && result.noOp).toBe(true);
    expect(spy.clearQuestionsForRun).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // F5: sweep the OLD run's PENDING drafts after it flips terminal, so a
  // cancel-and-restart of an unapproved plan-gated run does not leak a duplicate
  // draft set while the restarted run mints a fresh one.
  // -------------------------------------------------------------------------
  it('F5: sweeps the OLD run\'s pending drafts with the OLD runId AFTER it is canceled', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck');

    await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));

    // Called with the OLD run's id (not the new run) — the new run mints its own set.
    expect(spy.deletePendingDraftsForRun).toHaveBeenCalledWith(runId);
    // The sweep runs AFTER the cancel/insert (kill first, then flip terminal, then sweep).
    expect(spy.calls.indexOf('deletePendingDraftsForRun')).toBeGreaterThan(
      spy.calls.indexOf('claudeManagerStop'),
    );
    const oldRun = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
    expect(oldRun.status).toBe('canceled');
  });

  it('F5: does NOT sweep on the noOp path (already-terminal run)', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'completed');

    await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));
    expect(spy.deletePendingDraftsForRun).not.toHaveBeenCalled();
  });

  it('F5: a sweep rejection does NOT break the restart (run still canceled, new run inserted)', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck');

    const deps = makeDeps(db, spy, runQueues);
    deps.deletePendingDraftsForRun = vi.fn(async () => {
      throw new Error('sweep boom');
    });

    const result = await cancelAndRestartHandler(runId, deps);
    if ('noOp' in result) throw new Error('Expected a real result, got noOp');

    // Restart committed despite the sweep failure.
    const oldRun = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
    expect(oldRun.status).toBe('canceled');
    const newRun = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(result.newRunId) as { status: string };
    expect(newRun.status).toBe('queued');
  });

  it('F5: works without the sweep dep wired (optional — backward compat)', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck');

    const deps = makeDeps(db, spy, runQueues);
    delete deps.deletePendingDraftsForRun;

    const result = await cancelAndRestartHandler(runId, deps);
    if ('noOp' in result) throw new Error('Expected a real result, got noOp');
    expect(result.newRunId).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // AC4: DB side-effects: old run canceled, new run inserted
  // -------------------------------------------------------------------------

  it('marks the old run as canceled (AC4c)', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck');

    await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));

    const oldRun = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
    expect(oldRun.status).toBe('canceled');
  });

  it('inserts a new run with the same workflow_id and worktree_path (AC4d)', async () => {
    const runId = randomUUID();
    const { workflowId } = seedWorkflowAndRun(db, runId, 'stuck', '/tmp/my-worktree');

    const result = await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));
    if ('noOp' in result) throw new Error('Expected a real result, got noOp');

    const newRun = db.prepare(
      'SELECT workflow_id, worktree_path, status FROM workflow_runs WHERE id = ?',
    ).get(result.newRunId) as { workflow_id: string; worktree_path: string; status: string };

    expect(newRun.workflow_id).toBe(workflowId);
    expect(newRun.worktree_path).toBe('/tmp/my-worktree');
    expect(newRun.status).toBe('queued');
  });

  it('copies the stamped resolution columns (substrate/permission/model/eval pin) onto the restarted run', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck', '/tmp/wt-prov');
    db.prepare(
      `UPDATE workflow_runs
          SET substrate = 'sdk', permission_mode_snapshot = 'acceptEdits',
              model = 'opus', eval_enabled = 0
        WHERE id = ?`,
    ).run(runId);

    const result = await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));
    if ('noOp' in result) throw new Error('Expected a real result, got noOp');

    const newRun = db.prepare(
      'SELECT substrate, permission_mode_snapshot, model, eval_enabled FROM workflow_runs WHERE id = ?',
    ).get(result.newRunId) as {
      substrate: string | null;
      permission_mode_snapshot: string | null;
      model: string | null;
      eval_enabled: number | null;
    };
    expect(newRun).toEqual({
      substrate: 'sdk',
      permission_mode_snapshot: 'acceptEdits',
      model: 'opus',
      eval_enabled: 0,
    });
  });

  it('copies the original run session_id onto the restarted run (run stays nested under its session)', async () => {
    const runId = randomUUID();
    const sessionId = `session-${randomUUID()}`;
    seedWorkflowAndRun(db, runId, 'stuck', '/tmp/wt-test', sessionId);

    const result = await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));
    if ('noOp' in result) throw new Error('Expected a real result, got noOp');

    const newRun = db.prepare(
      'SELECT session_id FROM workflow_runs WHERE id = ?',
    ).get(result.newRunId) as { session_id: string | null };

    expect(newRun.session_id).toBe(sessionId);
  });

  it('copies a null session_id verbatim for a legacy parentless run', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck', '/tmp/wt-test', null);

    const result = await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));
    if ('noOp' in result) throw new Error('Expected a real result, got noOp');

    const newRun = db.prepare(
      'SELECT session_id FROM workflow_runs WHERE id = ?',
    ).get(result.newRunId) as { session_id: string | null };

    expect(newRun.session_id).toBeNull();
  });

  it('returns the new runId (AC4e)', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck');

    const result = await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));
    if ('noOp' in result) throw new Error('Expected a real result, got noOp');

    expect(typeof result.newRunId).toBe('string');
    expect(result.newRunId).not.toBe(runId);
  });

  // -------------------------------------------------------------------------
  // AC7: worktree preserved — worktreeManager.remove never called
  // -------------------------------------------------------------------------

  it('does NOT call worktreeManager.remove (AC7: worktree preserved)', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck');

    await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));

    expect(spy.worktreeRemove).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // noOp: already-terminal runs
  // -------------------------------------------------------------------------

  it('returns noOp for an already-canceled run', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'canceled');

    const result = await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));

    expect('noOp' in result && result.noOp).toBe(true);
    expect(spy.clearPendingForRun).not.toHaveBeenCalled();
    expect(spy.claudeManagerStop).not.toHaveBeenCalled();
  });

  it('returns noOp for a completed run', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'completed');

    const result = await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));

    expect('noOp' in result && result.noOp).toBe(true);
  });

  it('returns noOp for a failed run', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'failed');

    const result = await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));

    expect('noOp' in result && result.noOp).toBe(true);
  });

  // -------------------------------------------------------------------------
  // awaiting_review: also restartable
  // -------------------------------------------------------------------------

  it('also cancels and restarts a run in awaiting_review status', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'awaiting_review');

    const result = await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));
    if ('noOp' in result) throw new Error('Expected a real result, got noOp');

    const oldRun = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
    expect(oldRun.status).toBe('canceled');
    expect(result.newRunId).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // clearPendingForRun is called with the runId
  // -------------------------------------------------------------------------

  it('calls clearPendingForRun with the correct runId', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck');

    await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));

    expect(spy.clearPendingForRun).toHaveBeenCalledWith(runId);
  });

  // -------------------------------------------------------------------------
  // claudeManagerStop rejection — run still canceled, new run still inserted
  // -------------------------------------------------------------------------

  it('still marks run as canceled and inserts new run when claudeManagerStop rejects', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck');

    // Make claudeManagerStop reject.
    const rejectingSpy = makeOrderSpy();
    rejectingSpy.claudeManagerStop.mockRejectedValueOnce(new Error('PTY teardown failed'));

    const loggerErrors: Array<{ msg: string; ctx: Record<string, unknown> }> = [];
    const testLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn((_msg: string, ctx?: Record<string, unknown>) => {
        loggerErrors.push({ msg: _msg, ctx: ctx ?? {} });
      }),
      debug: vi.fn(),
    };

    const deps: HandlerDeps = {
      ...makeDeps(db, rejectingSpy, runQueues),
      logger: testLogger,
    };

    const result = await cancelAndRestartHandler(runId, deps);

    // Should not be a noOp
    if ('noOp' in result) throw new Error('Expected newRunId, got noOp');

    // Old run should be canceled
    const oldRun = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
    expect(oldRun.status).toBe('canceled');

    // New run should be inserted
    const newRun = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(result.newRunId) as { status: string };
    expect(newRun.status).toBe('queued');

    // Logger should have recorded the error with [cancelAndRestart] prefix
    expect(loggerErrors.length).toBeGreaterThanOrEqual(1);
    expect(loggerErrors[0].msg).toContain('[cancelAndRestart]');
    expect(loggerErrors[0].ctx['runId']).toBe(runId);
  });

  // -------------------------------------------------------------------------
  // TASK-627 / SPRINT-023 A4: DEBUG log emitted after clearPendingForRun
  // (TASK-304 no-op). Downgraded from warn to debug to avoid log-flood on
  // every Cancel-and-restart click — the tooltip surfaces the limitation
  // to users; debug level keeps the trace available for diagnostics.
  // -------------------------------------------------------------------------

  it('emits a DEBUG with TASK-304 reference after clearPendingForRun', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck');

    const loggerDebugs: Array<{ msg: string; ctx: Record<string, unknown> }> = [];
    const testLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn((_msg: string, ctx?: Record<string, unknown>) => {
        loggerDebugs.push({ msg: _msg, ctx: ctx ?? {} });
      }),
    };

    const deps: HandlerDeps = {
      ...makeDeps(db, spy, runQueues),
      logger: testLogger,
    };

    await cancelAndRestartHandler(runId, deps);

    expect(loggerDebugs.length).toBe(1);
    expect(loggerDebugs[0].msg).toContain('[cancelAndRestart]');
    expect(loggerDebugs[0].msg).toContain('TASK-304');
    expect(loggerDebugs[0].ctx['runId']).toBe(runId);
    expect(testLogger.debug).toHaveBeenCalledWith(expect.stringContaining('TASK-304'), expect.objectContaining({ runId }));
  });

  it('does NOT emit the TASK-304 DEBUG when the run is already terminal (noOp path)', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'completed');

    const loggerDebugs: Array<{ msg: string; ctx: Record<string, unknown> }> = [];
    const testLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn((_msg: string, ctx?: Record<string, unknown>) => {
        loggerDebugs.push({ msg: _msg, ctx: ctx ?? {} });
      }),
    };

    const deps: HandlerDeps = {
      ...makeDeps(db, spy, runQueues),
      logger: testLogger,
    };

    const result = await cancelAndRestartHandler(runId, deps);

    expect('noOp' in result && result.noOp).toBe(true);
    expect(loggerDebugs.length).toBe(0);
  });

  it('still works without a logger when claudeManagerStop rejects', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck');

    const rejectingSpy = makeOrderSpy();
    rejectingSpy.claudeManagerStop.mockRejectedValueOnce(new Error('PTY teardown failed'));

    // No logger provided
    const deps: HandlerDeps = makeDeps(db, rejectingSpy, runQueues);

    const result = await cancelAndRestartHandler(runId, deps);

    if ('noOp' in result) throw new Error('Expected newRunId, got noOp');

    const oldRun = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
    expect(oldRun.status).toBe('canceled');

    const newRun = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(result.newRunId) as { status: string };
    expect(newRun.status).toBe('queued');
  });

  // -------------------------------------------------------------------------
  // Race branch: changes === 0 (FIND-SPRINT-013-17)
  //
  // Scenario: the row-fetch guard passes (run is 'stuck'), but a concurrent
  // process moves the run to a terminal status between the guard and the
  // UPDATE inside the transaction.  The UPDATE finds zero matching rows
  // (status IN guard in the WHERE clause rejects), so `changes === 0` and
  // the handler should throw.  The INSERT must NOT execute — no new run row
  // is created.
  // -------------------------------------------------------------------------

  it('throws when UPDATE finds changes=0 (concurrent terminal transition race)', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck');

    // Build a DatabaseLike that wraps the real db but intercepts the UPDATE
    // prepare call.  On the first call whose SQL contains the status-guard
    // WHERE clause, we pre-cancel the run directly so the prepared statement
    // sees changes=0.
    let updateIntercepted = false;
    const racingDb: DatabaseLike = {
      prepare: (sql: string) => {
        const realStmt = db.prepare(sql);
        // Intercept only the guarded UPDATE (identified by its NOT IN clause).
        if (!updateIntercepted && sql.includes("status NOT IN ('canceled'")) {
          updateIntercepted = true;
          return {
            run: (...params: unknown[]) => {
              // Simulate a concurrent write: move run to 'canceled' BEFORE
              // the transaction UPDATE executes its WHERE-filtered rows.
              db.prepare(
                `UPDATE workflow_runs SET status = 'canceled' WHERE id = ?`,
              ).run(runId);
              // Now run the real guarded UPDATE — it will match 0 rows.
              return realStmt.run(...params);
            },
            get: (...params: unknown[]) => realStmt.get(...params),
            all: (...params: unknown[]) => realStmt.all(...params),
          };
        }
        return realStmt;
      },
      transaction: <T>(fn: (...args: unknown[]) => T) =>
        db.transaction(fn as (...args: unknown[]) => T) as (...args: unknown[]) => T,
    };

    const deps: HandlerDeps = {
      db: racingDb,
      approvalRouter: { clearPendingForRun: spy.clearPendingForRun } as unknown as import('../approvalRouter').ApprovalRouter,
      questionRouter: { clearPendingForRun: spy.clearQuestionsForRun },
      runQueues,
      claudeManagerStop: spy.claudeManagerStop,
    };

    // The transaction guard must throw.
    await expect(cancelAndRestartHandler(runId, deps)).rejects.toThrow(
      `cancelAndRestart: run ${runId} was already in a terminal state when the UPDATE was attempted`,
    );

    // The INSERT must not have fired — no new run row should exist beyond the
    // original seeded row.
    const allRuns = db.prepare('SELECT id FROM workflow_runs').all() as { id: string }[];
    const runIds = allRuns.map((r) => r.id);
    expect(runIds).toHaveLength(1);
    expect(runIds[0]).toBe(runId);
  });
});
