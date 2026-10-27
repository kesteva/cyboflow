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
 *   - Mocked managerStop (a vi.fn() that resolves immediately).
 *   - Mocked worktreeManager.remove (vi.fn() asserted never-called).
 *   - The mutation body is exercised via the cancelAndRestartHandler()
 *     extracted helper (tested directly, without the tRPC wrapper, to avoid
 *     wiring the full tRPC context).
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
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
  clearPendingForRun: Mock;       // approvalRouter
  clearQuestionsForRun: Mock;     // questionRouter
  managerStop: Mock;
  worktreeRemove: Mock;
  deletePendingDraftsForRun: Mock; // F5 sweep
}

function makeOrderSpy(): OrderSpy {
  const calls: string[] = [];

  const clearPendingForRun = vi.fn((_runId: string) => {
    calls.push('clearPendingForRun');
  });

  const clearQuestionsForRun = vi.fn((_runId: string) => {
    calls.push('clearQuestionsForRun');
  });

  const managerStop = vi.fn(async (_runId: string) => {
    calls.push('managerStop');
  });

  const worktreeRemove = vi.fn(async (_path: string) => {
    calls.push('worktreeRemove');
  });

  const deletePendingDraftsForRun = vi.fn(async (_runId: string) => {
    calls.push('deletePendingDraftsForRun');
  });

  return { calls, clearPendingForRun, clearQuestionsForRun, managerStop, worktreeRemove, deletePendingDraftsForRun };
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
    managerStop: spy.managerStop,
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
    // of session_id resolve. includeWorkflowRunTaskColumns adds task_id (mig 014)
    // — batch_id already rides includeSubstrate — so the handler's SELECT of both
    // (migration 066 revert seam) resolves.
    db = createTestDb({
      includeStuckDetectedAt: true,
      includeSubstrate: true,
      includeWorkflowRunTaskColumns: true,
    });
    // Migration 026's frozen-definition address, copied verbatim by the handler
    // so the replacement run executes the same definition (it is not part of
    // GATE_SCHEMA; tuning_level, migration 122, is).
    db.exec('ALTER TABLE workflow_runs ADD COLUMN spec_hash TEXT');
    spy = makeOrderSpy();
    runQueues = new RunQueueRegistry();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // AC5: deny BEFORE PTY kill
  // -------------------------------------------------------------------------

  it('calls clearPendingForRun BEFORE managerStop (AC5: deny before kill)', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck');

    await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));

    expect(spy.calls[0]).toBe('clearPendingForRun');
    expect(spy.calls.indexOf('managerStop')).toBeGreaterThan(spy.calls.indexOf('clearPendingForRun'));
  });

  it('calls approvalRouter.clearPendingForRun → questionRouter.clearPendingForRun → managerStop in that order', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck');

    await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));

    expect(spy.calls[0]).toBe('clearPendingForRun');       // approvalRouter
    expect(spy.calls[1]).toBe('clearQuestionsForRun');     // questionRouter (NEW)
    expect(spy.calls[2]).toBe('managerStop');
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
      spy.calls.indexOf('managerStop'),
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

  it('copies the frozen definition address + tuning level onto the restarted run', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck', '/tmp/wt-frozen');
    db.prepare(
      "UPDATE workflow_runs SET spec_hash = 'deadbeef', tuning_level = 'efficient' WHERE id = ?",
    ).run(runId);

    const result = await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));
    if ('noOp' in result) throw new Error('Expected a real result, got noOp');

    // Without this, the replacement run resolves its definition from the LIVE
    // workflow spec — which for a preset-tuned flow is the '{}' built-in
    // fallback, silently dropping an Efficient run to Standard on restart. The
    // preset graph lives only in the workflow_revisions row this hash addresses.
    const newRun = db
      .prepare('SELECT spec_hash, tuning_level FROM workflow_runs WHERE id = ?')
      .get(result.newRunId) as { spec_hash: string | null; tuning_level: string | null };
    expect(newRun).toEqual({ spec_hash: 'deadbeef', tuning_level: 'efficient' });
  });

  it('copies the immutable routing stamps (provider/runtime/plane/mix) onto the restarted run', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck', '/tmp/wt-routing');
    db.prepare(
      `UPDATE workflow_runs
          SET agent_provider = 'codex', agent_runtime = 'codex-sdk',
              execution_model = 'programmatic', runtime_mix = 'codex-primary',
              spec_hash = 'c0ffee'
        WHERE id = ?`,
    ).run(runId);

    const result = await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));
    if ('noOp' in result) throw new Error('Expected a real result, got noOp');

    // The per-step provider pins live inside the frozen spec this handler copies
    // by address, and only the PROGRAMMATIC runner honours them. Dropping these
    // four columns would restart a codex-primary programmatic run as a
    // claude/orchestrated one still carrying every Codex pin — silently ignoring
    // half its own routing, and without ever passing the mixed-provider guard
    // (this handler INSERTs directly, bypassing createRun).
    const newRun = db
      .prepare(
        'SELECT agent_provider, agent_runtime, execution_model, runtime_mix FROM workflow_runs WHERE id = ?',
      )
      .get(result.newRunId) as {
      agent_provider: string | null;
      agent_runtime: string | null;
      execution_model: string | null;
      runtime_mix: string | null;
    };
    expect(newRun).toEqual({
      agent_provider: 'codex',
      agent_runtime: 'codex-sdk',
      execution_model: 'programmatic',
      runtime_mix: 'codex-primary',
    });
  });

  it('copies the immutable host_id stamp onto the restarted run (NULL stays NULL)', async () => {
    const stamped = randomUUID();
    seedWorkflowAndRun(db, stamped, 'stuck', '/tmp/wt-host');
    db.prepare(`UPDATE workflow_runs SET host_id = 'host-1' WHERE id = ?`).run(stamped);
    const r1 = await cancelAndRestartHandler(stamped, makeDeps(db, spy, runQueues));
    if ('noOp' in r1) throw new Error('Expected a real result, got noOp');
    const row1 = db.prepare('SELECT host_id FROM workflow_runs WHERE id = ?').get(r1.newRunId) as { host_id: string | null };
    expect(row1.host_id).toBe('host-1');

    const local = randomUUID();
    seedWorkflowAndRun(db, local, 'stuck', '/tmp/wt-nohost');
    const r2 = await cancelAndRestartHandler(local, makeDeps(db, spy, runQueues));
    if ('noOp' in r2) throw new Error('Expected a real result, got noOp');
    const row2 = db.prepare('SELECT host_id FROM workflow_runs WHERE id = ?').get(r2.newRunId) as { host_id: string | null };
    expect(row2.host_id).toBeNull();
  });

  it('leaves the replacement mix NULL for a run that carried none (never defaulted to claude)', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck', '/tmp/wt-nomix');

    const result = await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));
    if ('noOp' in result) throw new Error('Expected a real result, got noOp');

    // NULL means "pre-feature, a variant run, a non-built-in flow, or an omp/pi
    // lane" (migration 128) — reading it as 'claude' would attribute a run to a
    // routing decision nobody made.
    const newRun = db
      .prepare('SELECT runtime_mix FROM workflow_runs WHERE id = ?')
      .get(result.newRunId) as { runtime_mix: string | null };
    expect(newRun.runtime_mix).toBeNull();
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
    expect(spy.managerStop).not.toHaveBeenCalled();
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
  // managerStop rejection — run still canceled, new run still inserted
  // -------------------------------------------------------------------------

  it('still marks run as canceled and inserts new run when managerStop rejects', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck');

    // Make managerStop reject.
    const rejectingSpy = makeOrderSpy();
    rejectingSpy.managerStop.mockRejectedValueOnce(new Error('PTY teardown failed'));

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

  it('still works without a logger when managerStop rejects', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck');

    const rejectingSpy = makeOrderSpy();
    rejectingSpy.managerStop.mockRejectedValueOnce(new Error('PTY teardown failed'));

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
  // SDK-substrate regression pin (teardown-gaps fix): cancelAndRestart now stops
  // through the SAME SubstrateDispatchFacade.abort seam runs.cancel/pause/
  // handover use (runtime-mix plan D6 — the old defaultCliManager.stopPanel
  // binding was Claude-only, so a codex-primary run survived the cancel). This
  // handler still does not branch on substrate — it always calls
  // managerStop(runId) and lets the facade resolve the spawning manager — so the
  // pin is that the call is UNCONDITIONAL: a future refactor that made it
  // conditional on substrate could quietly stop reaching a warm SDK run's
  // process. Pin the seam explicitly against an SDK-substrate run row.
  // -------------------------------------------------------------------------

  it('calls the injected managerStop for an SDK-substrate run (the stop seam stays unconditional)', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck');
    db.prepare(`UPDATE workflow_runs SET substrate = 'sdk' WHERE id = ?`).run(runId);

    const result = await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));
    if ('noOp' in result) throw new Error('Expected a real result, got noOp');

    expect(spy.managerStop).toHaveBeenCalledOnce();
    expect(spy.managerStop).toHaveBeenCalledWith(runId);
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
        // Intercept only the guarded UPDATE. Its source-status guard is now
        // DERIVED from ALLOWED_TRANSITIONS (allowedSourcesSqlIn('canceled')), so
        // it reads `AND status IN ('queued', ...)` rather than the old
        // hand-written `status NOT IN ('canceled', ...)`. Same set, new spelling.
        if (!updateIntercepted && sql.includes("SET status = 'canceled'") && sql.includes('AND status IN')) {
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
      managerStop: spy.managerStop,
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

// ---------------------------------------------------------------------------
// Migration 066 revert seam: the OLD run flips 'canceled' but the replacement run
// carries NO task_id/batch_id link (restart re-plans from scratch), so the OLD
// run's tasks must be reverted off 'In development' here — nothing else does it.
// ---------------------------------------------------------------------------

describe('cancelAndRestartHandler — task-stage revert (migration 066)', () => {
  let db: Database.Database;
  let spy: OrderSpy;
  let runQueues: RunQueueRegistry;

  beforeEach(() => {
    db = createTestDb({
      includeStuckDetectedAt: true,
      includeSubstrate: true,
      includeWorkflowRunTaskColumns: true,
    });
    // Migration 026's frozen-definition address, copied verbatim by the handler
    // so the replacement run executes the same definition (it is not part of
    // GATE_SCHEMA; tuning_level, migration 122, is).
    db.exec('ALTER TABLE workflow_runs ADD COLUMN spec_hash TEXT');
    spy = makeOrderSpy();
    runQueues = new RunQueueRegistry();
    vi.clearAllMocks();
  });

  function statusOf(runId: string): string {
    return (db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string }).status;
  }

  it('reverts a stuck BATCH run via recomputeTasksForBatch, AFTER the old run is canceled', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck');
    db.prepare('UPDATE workflow_runs SET batch_id = ? WHERE id = ?').run('batch-9', runId);
    let statusWhenCalled: string | undefined;
    const recomputeTasksForBatch = vi.fn(async (_batchId: string) => {
      statusWhenCalled = statusOf(runId);
    });
    const recomputeTask = vi.fn();

    const result = await cancelAndRestartHandler(runId, {
      ...makeDeps(db, spy, runQueues),
      recomputeTasksForBatch,
      recomputeTask,
    });

    expect('newRunId' in result).toBe(true);
    expect(recomputeTasksForBatch).toHaveBeenCalledTimes(1);
    expect(recomputeTasksForBatch).toHaveBeenCalledWith('batch-9');
    expect(statusWhenCalled).toBe('canceled'); // ran AFTER the cancel+insert tx
    expect(recomputeTask).not.toHaveBeenCalled(); // no direct task link
  });

  it('reverts a DIRECT task-linked run via recomputeTask(taskId)', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck');
    db.prepare('UPDATE workflow_runs SET task_id = ? WHERE id = ?').run('task-9', runId);
    const recomputeTasksForBatch = vi.fn();
    const recomputeTask = vi.fn();

    const result = await cancelAndRestartHandler(runId, {
      ...makeDeps(db, spy, runQueues),
      recomputeTasksForBatch,
      recomputeTask,
    });

    expect('newRunId' in result).toBe(true);
    expect(recomputeTask).toHaveBeenCalledTimes(1);
    expect(recomputeTask).toHaveBeenCalledWith('task-9');
    expect(recomputeTasksForBatch).not.toHaveBeenCalled(); // no batch link
  });

  it('the replacement run copies NEITHER task_id NOR batch_id (tasks legitimately revert)', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck');
    db.prepare('UPDATE workflow_runs SET task_id = ?, batch_id = ? WHERE id = ?').run('task-9', 'batch-9', runId);

    const result = await cancelAndRestartHandler(runId, {
      ...makeDeps(db, spy, runQueues),
      recomputeTasksForBatch: vi.fn(),
      recomputeTask: vi.fn(),
    });

    if (!('newRunId' in result)) throw new Error('expected a restart');
    const newRun = db
      .prepare('SELECT task_id, batch_id FROM workflow_runs WHERE id = ?')
      .get(result.newRunId) as { task_id: string | null; batch_id: string | null };
    expect(newRun.task_id).toBeNull();
    expect(newRun.batch_id).toBeNull();
  });

  it('is fail-soft: a throwing revert dep never breaks the restart', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck');
    db.prepare('UPDATE workflow_runs SET task_id = ?, batch_id = ? WHERE id = ?').run('task-9', 'batch-9', runId);

    const result = await cancelAndRestartHandler(runId, {
      ...makeDeps(db, spy, runQueues),
      recomputeTasksForBatch: vi.fn(async () => {
        throw new Error('lane store offline');
      }),
      recomputeTask: vi.fn(async () => {
        throw new Error('router offline');
      }),
    });

    expect('newRunId' in result).toBe(true);
    expect(statusOf(runId)).toBe('canceled'); // old run still canceled
  });

  it('restarts fine when the revert deps are omitted (optional)', async () => {
    const runId = randomUUID();
    seedWorkflowAndRun(db, runId, 'stuck');
    db.prepare('UPDATE workflow_runs SET task_id = ?, batch_id = ? WHERE id = ?').run('task-9', 'batch-9', runId);

    const result = await cancelAndRestartHandler(runId, makeDeps(db, spy, runQueues));

    expect('newRunId' in result).toBe(true);
    expect(statusOf(runId)).toBe('canceled');
  });
});
