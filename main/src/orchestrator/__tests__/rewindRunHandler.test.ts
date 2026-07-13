/**
 * Unit tests for rewindRunHandler — the monitor's PROGRAMMATIC-ONLY REWIND
 * power: revive a run at an EARLIER (or the current) step, purging downstream
 * step results and aborting a live walk first when one holds the run.
 *
 * Covers: the rewindable-state matrix (failed / running / paused /
 * live-gated awaiting_review accepted; wrong statuses → not_rewindable), the
 * directional guard (unknown_step / target_not_prior / target === current
 * allowed), the abort-first sole-writer contract (requestProgrammaticCancel
 * fires SYNCHRONOUSLY + stopLiveRun awaited BEFORE the queue task runs), the
 * downstream purge, the fan-out carve-out (all-lanes-integrated keeps the fanOut
 * step settled; failed lanes present re-dispatch it), unconditional batch reopen,
 * the guarded-revive race, and the gate sweep.
 *
 * Standalone: no electron / services imports. The DB is an in-memory SQLite via
 * createTestDb wrapped in the DatabaseLike adapter; the executor + queue are
 * lightweight fakes. Style mirrors retryRunHandler.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedRun } from '../__test_fixtures__/orchestratorTestDb';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { RunQueueRegistry } from '../RunQueueRegistry';
import { rewindRunHandler, type RewindRunExecutorLike, type RewindRunDeps } from '../rewindRunHandler';
import type { DatabaseLike, PreparedStatement } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Three plain steps (no fanOut) — the default rewind target space. */
const THREE_STEP_SPEC = JSON.stringify({
  id: 'test-wf-3',
  phases: [
    {
      id: 'phase-1',
      label: 'Phase 1',
      color: '#111111',
      steps: [
        { id: 'step-a', name: 'Step A', agent: 'agent-a' },
        { id: 'step-b', name: 'Step B', agent: 'agent-b' },
        { id: 'step-c', name: 'Step C', agent: 'agent-c' },
      ],
    },
  ],
});

/**
 * A prep step then a fan-out step across two phases — for the carve-out tests.
 * Rewinding to 'prep' puts the fanOut 'fan' step in the purge slice (after target).
 */
const FANOUT_SPEC = JSON.stringify({
  id: 'test-wf-fan',
  phases: [
    { id: 'p1', label: 'P1', color: '#111111', steps: [{ id: 'prep', name: 'Prep', agent: 'a' }] },
    {
      id: 'p2',
      label: 'P2',
      color: '#222222',
      steps: [
        {
          id: 'fan',
          name: 'Fan',
          agent: 'implement',
          fanOut: { over: 'tasks', inner: [{ id: 'implement', agent: 'implement', name: 'Implement' }] },
        },
      ],
    },
  ],
});

function makeDb(): Database.Database {
  return createTestDb({ includeSubstrate: true, includeWorkflowRunTaskColumns: true });
}

function setExecutionModel(db: Database.Database, runId: string, model: 'orchestrated' | 'programmatic'): void {
  db.prepare('UPDATE workflow_runs SET execution_model = ? WHERE id = ?').run(model, runId);
}
function setBatchId(db: Database.Database, runId: string, batchId: string | null): void {
  db.prepare('UPDATE workflow_runs SET batch_id = ? WHERE id = ?').run(batchId, runId);
}
function setCurrentStepId(db: Database.Database, runId: string, stepId: string | null): void {
  db.prepare('UPDATE workflow_runs SET current_step_id = ? WHERE id = ?').run(stepId, runId);
}
function setWorkflowSpec(db: Database.Database, workflowId: string, specJson: string): void {
  db.prepare('UPDATE workflows SET spec_json = ? WHERE id = ?').run(specJson, workflowId);
}

/** Seed a run + workflow wired up as a rewindable programmatic run by default. */
function seedProgrammaticRun(
  db: Database.Database,
  overrides?: {
    status?: 'failed' | 'awaiting_review' | 'running' | 'paused' | 'completed' | 'canceled' | 'starting';
    specJson?: string;
    currentStepId?: string | null;
    batchId?: string | null;
    workflowName?: string;
  },
): { runId: string; workflowId: string } {
  const { runId, workflowId } = seedRun(db, {
    status: overrides?.status ?? 'failed',
    workflowName: overrides?.workflowName ?? 'test-workflow',
  });
  setExecutionModel(db, runId, 'programmatic');
  setWorkflowSpec(db, workflowId, overrides?.specJson ?? THREE_STEP_SPEC);
  if (overrides?.currentStepId !== undefined) setCurrentStepId(db, runId, overrides.currentStepId);
  if (overrides?.batchId !== undefined) setBatchId(db, runId, overrides.batchId);
  return { runId, workflowId };
}

/** A fake executor recording setPendingResumeStep/setPendingCompletedSteps/execute/cancel calls. */
function makeFakeExecutor(opts?: {
  activeExecution?: boolean;
  executeRejects?: boolean;
}): RewindRunExecutorLike & {
  setPendingResumeStep: ReturnType<typeof vi.fn>;
  setPendingCompletedSteps: ReturnType<typeof vi.fn>;
  hasActiveExecution: ReturnType<typeof vi.fn>;
  requestProgrammaticCancel: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
} {
  const setPendingResumeStep = vi.fn<(runId: string, stepId: string) => void>();
  const setPendingCompletedSteps = vi.fn<(runId: string, stepIds: readonly string[]) => void>();
  const hasActiveExecution = vi
    .fn<(runId: string) => boolean>()
    .mockReturnValue(opts?.activeExecution ?? false);
  const requestProgrammaticCancel = vi.fn<(runId: string) => boolean>().mockReturnValue(true);
  const execute = vi.fn<(runId: string) => Promise<void>>().mockImplementation(async () => {
    if (opts?.executeRejects) throw new Error('boom');
  });
  return { setPendingResumeStep, setPendingCompletedSteps, hasActiveExecution, requestProgrammaticCancel, execute };
}

/** Build deps with an emit spy + the given executor + optional overrides. */
function makeDeps(
  db: DatabaseLike,
  executor: RewindRunExecutorLike,
  opts?: {
    runQueues?: RunQueueRegistry;
    stopLiveRun?: RewindRunDeps['stopLiveRun'];
    listStepResults?: (runId: string) => Array<{ stepId: string; outcome: string }>;
    deleteStepResults?: ReturnType<typeof vi.fn>;
    resetFailedLanes?: ReturnType<typeof vi.fn>;
    countRedispatchableLanes?: ReturnType<typeof vi.fn>;
    reopenBatch?: ReturnType<typeof vi.fn>;
    clearPendingGateItems?: ReturnType<typeof vi.fn>;
    clearPendingApprovalsForRun?: ReturnType<typeof vi.fn>;
    clearPendingQuestionsForRun?: ReturnType<typeof vi.fn>;
    logger?: RewindRunDeps['logger'];
  },
): RewindRunDeps & {
  emitRunStatusChanged: ReturnType<typeof vi.fn>;
  deleteStepResults: ReturnType<typeof vi.fn>;
} {
  const emitRunStatusChanged = vi.fn<(runId: string, status: 'starting') => void>();
  const deleteStepResults =
    opts?.deleteStepResults ?? vi.fn<(runId: string, stepIds: readonly string[]) => number>().mockReturnValue(0);
  return {
    db,
    runQueues: opts?.runQueues ?? new RunQueueRegistry(),
    runExecutor: executor,
    stopLiveRun: opts?.stopLiveRun,
    emitRunStatusChanged,
    listStepResults: opts?.listStepResults ?? (() => []),
    deleteStepResults,
    resetFailedLanes: opts?.resetFailedLanes,
    countRedispatchableLanes: opts?.countRedispatchableLanes,
    reopenBatch: opts?.reopenBatch,
    clearPendingGateItems: opts?.clearPendingGateItems,
    clearPendingApprovalsForRun: opts?.clearPendingApprovalsForRun,
    clearPendingQuestionsForRun: opts?.clearPendingQuestionsForRun,
    logger: opts?.logger,
  };
}

/** Wait for the fire-and-forget re-drive task to settle. */
async function waitForRedrive(runQueues: RunQueueRegistry, runId: string): Promise<void> {
  await runQueues.getOrCreate(runId).onIdle();
}

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// (1) failed-run rewind — the baseline happy path
// ---------------------------------------------------------------------------

describe('rewindRunHandler — failed-run rewind', () => {
  it('purges at/after target, revives to starting, arms resume + pre-target completed set, fires execute', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, {
      status: 'failed',
      specJson: THREE_STEP_SPEC,
      currentStepId: 'step-c',
    });
    const executor = makeFakeExecutor();
    // step-a + step-b done, step-c failed. Rewind target = step-b.
    const listStepResults = () => [
      { stepId: 'step-a', outcome: 'done' },
      { stepId: 'step-b', outcome: 'done' },
      { stepId: 'step-c', outcome: 'failed' },
    ];
    const deleteStepResults = vi.fn<(runId: string, stepIds: readonly string[]) => number>().mockReturnValue(2);
    const deps = makeDeps(dbAdapter(db), executor, { runQueues, listStepResults, deleteStepResults });

    const result = await rewindRunHandler(runId, 'step-b', deps);

    expect(result).toEqual({ delivered: true, stepId: 'step-b', abortedLiveWalk: false, fanOutKeptSettled: false });
    // Purged the target-and-after slice.
    expect(deleteStepResults).toHaveBeenCalledWith(runId, ['step-b', 'step-c']);
    // Revive landed.
    const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('starting');
    expect(deps.emitRunStatusChanged).toHaveBeenCalledWith(runId, 'starting');
    // Resume anchor + ONLY the strictly-earlier done row (step-a); target excluded.
    expect(executor.setPendingResumeStep).toHaveBeenCalledWith(runId, 'step-b');
    expect(executor.setPendingCompletedSteps).toHaveBeenCalledWith(runId, ['step-a']);
    await waitForRedrive(runQueues, runId);
    expect(executor.execute).toHaveBeenCalledWith(runId);
    db.close();
  });

  it('clears the revive terminal stamps (error_message / ended_at / outcome)', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'failed', currentStepId: 'step-b' });
    db.prepare('UPDATE workflow_runs SET error_message = ?, ended_at = ?, outcome = ? WHERE id = ?').run(
      'boom',
      '2026-01-01T00:00:00.000Z',
      'failed',
      runId,
    );
    const executor = makeFakeExecutor();
    const deps = makeDeps(dbAdapter(db), executor, { runQueues });

    const result = await rewindRunHandler(runId, 'step-a', deps);

    expect(result).toMatchObject({ delivered: true, stepId: 'step-a' });
    const row = db
      .prepare('SELECT status, error_message, ended_at, outcome FROM workflow_runs WHERE id = ?')
      .get(runId) as { status: string; error_message: string | null; ended_at: string | null; outcome: string | null };
    expect(row).toMatchObject({ status: 'starting', error_message: null, ended_at: null, outcome: null });
    await waitForRedrive(runQueues, runId);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// (2) running-run rewind — abort-first ordering
// ---------------------------------------------------------------------------

describe('rewindRunHandler — running-run rewind (abort first)', () => {
  it('fires requestProgrammaticCancel synchronously + awaits stopLiveRun BEFORE the queue task; accepts running', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'running', currentStepId: 'step-c' });
    const executor = makeFakeExecutor({ activeExecution: true });

    // Ordering probe: the guarded revive (queue task) must observe BOTH abort seams
    // already fired. We assert order via a shared call-log.
    const order: string[] = [];
    executor.requestProgrammaticCancel.mockImplementation(() => {
      order.push('cancel');
      return true;
    });
    const stopLiveRun = vi.fn<(runId: string) => Promise<void>>().mockImplementation(async () => {
      order.push('stopLiveRun');
    });
    const deleteStepResults = vi
      .fn<(runId: string, stepIds: readonly string[]) => number>()
      .mockImplementation(() => {
        order.push('purge');
        return 0;
      });
    const deps = makeDeps(dbAdapter(db), executor, { runQueues, stopLiveRun, deleteStepResults });

    const result = await rewindRunHandler(runId, 'step-b', deps);

    expect(result).toEqual({ delivered: true, stepId: 'step-b', abortedLiveWalk: true, fanOutKeptSettled: false });
    // cancel BEFORE stopLiveRun BEFORE the in-queue purge.
    expect(order).toEqual(['cancel', 'stopLiveRun', 'purge']);
    expect(executor.requestProgrammaticCancel).toHaveBeenCalledWith(runId);
    expect(stopLiveRun).toHaveBeenCalledWith(runId);
    // status-IN WHERE accepted 'running'.
    const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('starting');
    await waitForRedrive(runQueues, runId);
    db.close();
  });

  it('a stopLiveRun rejection is fail-soft (warned) and the rewind still lands', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'running', currentStepId: 'step-c' });
    const executor = makeFakeExecutor({ activeExecution: true });
    const stopLiveRun = vi.fn<(runId: string) => Promise<void>>().mockRejectedValue(new Error('no live process'));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const deps = makeDeps(dbAdapter(db), executor, { runQueues, stopLiveRun, logger });

    const result = await rewindRunHandler(runId, 'step-b', deps);

    expect(result).toMatchObject({ delivered: true, abortedLiveWalk: true });
    expect(logger.warn).toHaveBeenCalledWith(
      '[rewindRun] stopLiveRun rejected — proceeding to rewind',
      expect.objectContaining({ runId }),
    );
    await waitForRedrive(runQueues, runId);
    db.close();
  });

  it('does NOT abort when there is no active execution (resting failed run)', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'failed', currentStepId: 'step-c' });
    const executor = makeFakeExecutor({ activeExecution: false });
    const stopLiveRun = vi.fn<(runId: string) => Promise<void>>();
    const deps = makeDeps(dbAdapter(db), executor, { runQueues, stopLiveRun });

    const result = await rewindRunHandler(runId, 'step-a', deps);

    expect(result).toMatchObject({ delivered: true, abortedLiveWalk: false });
    expect(executor.requestProgrammaticCancel).not.toHaveBeenCalled();
    expect(stopLiveRun).not.toHaveBeenCalled();
    await waitForRedrive(runQueues, runId);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// (3)-(6) Guard matrix
// ---------------------------------------------------------------------------

describe('rewindRunHandler — guard matrix', () => {
  it('missing run → { noOp: not_found }', async () => {
    const db = makeDb();
    const executor = makeFakeExecutor();
    const result = await rewindRunHandler('no-such-run', 'step-a', makeDeps(dbAdapter(db), executor));
    expect(result).toEqual({ noOp: true, reason: 'not_found' });
    expect(executor.execute).not.toHaveBeenCalled();
    db.close();
  });

  it('orchestrated run → { noOp: not_programmatic }', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'failed' }); // execution_model defaults to orchestrated
    const executor = makeFakeExecutor();
    const result = await rewindRunHandler(runId, 'step-a', makeDeps(dbAdapter(db), executor));
    expect(result).toEqual({ noOp: true, reason: 'not_programmatic' });
    db.close();
  });

  it.each(['completed', 'canceled', 'starting'] as const)(
    'status=%s → { noOp: not_rewindable }',
    async (status) => {
      const db = makeDb();
      const { runId } = seedProgrammaticRun(db, { status, currentStepId: 'step-b' });
      const executor = makeFakeExecutor();
      const result = await rewindRunHandler(runId, 'step-a', makeDeps(dbAdapter(db), executor));
      expect(result).toEqual({ noOp: true, reason: 'not_rewindable' });
      expect(executor.execute).not.toHaveBeenCalled();
      db.close();
    },
  );

  it('(3) unknown step id → { noOp: unknown_step }', async () => {
    const db = makeDb();
    const { runId } = seedProgrammaticRun(db, { status: 'failed', currentStepId: 'step-b' });
    const executor = makeFakeExecutor();
    const result = await rewindRunHandler(runId, 'no-such-step', makeDeps(dbAdapter(db), executor));
    expect(result).toEqual({ noOp: true, reason: 'unknown_step' });
    // Run never flipped.
    const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('failed');
    db.close();
  });

  it('(4) target AFTER current_step_id → { noOp: target_not_prior }', async () => {
    const db = makeDb();
    const { runId } = seedProgrammaticRun(db, { status: 'running', currentStepId: 'step-a' });
    const executor = makeFakeExecutor({ activeExecution: true });
    // Target step-c is AFTER current step-a → forward = refused.
    const result = await rewindRunHandler(runId, 'step-c', makeDeps(dbAdapter(db), executor));
    expect(result).toEqual({ noOp: true, reason: 'target_not_prior' });
    // Refused in pre-flight — no abort fired.
    expect(executor.requestProgrammaticCancel).not.toHaveBeenCalled();
    db.close();
  });

  it('(5) target === current_step_id is ALLOWED (restart the current step live)', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'running', currentStepId: 'step-b' });
    const executor = makeFakeExecutor({ activeExecution: true });
    const deps = makeDeps(dbAdapter(db), executor, { runQueues });

    const result = await rewindRunHandler(runId, 'step-b', deps);

    expect(result).toMatchObject({ delivered: true, stepId: 'step-b', abortedLiveWalk: true });
    expect(executor.setPendingResumeStep).toHaveBeenCalledWith(runId, 'step-b');
    await waitForRedrive(runQueues, runId);
    db.close();
  });

  it('(6a) paused source is accepted (queue already free — no abort)', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'paused', currentStepId: 'step-c' });
    const executor = makeFakeExecutor({ activeExecution: false });
    const deps = makeDeps(dbAdapter(db), executor, { runQueues });

    const result = await rewindRunHandler(runId, 'step-a', deps);

    expect(result).toMatchObject({ delivered: true, stepId: 'step-a', abortedLiveWalk: false });
    const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('starting');
    await waitForRedrive(runQueues, runId);
    db.close();
  });

  it('(6b) awaiting_review WITH an active executor (live gate) goes through the abort arm and delivers', async () => {
    // Contrast retryRunHandler, which REFUSES this case (not_retryable) — rewind
    // accepts it because it aborts the live walk first.
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'awaiting_review', currentStepId: 'step-c' });
    const executor = makeFakeExecutor({ activeExecution: true });
    const stopLiveRun = vi.fn<(runId: string) => Promise<void>>();
    const deps = makeDeps(dbAdapter(db), executor, { runQueues, stopLiveRun });

    const result = await rewindRunHandler(runId, 'step-a', deps);

    expect(result).toMatchObject({ delivered: true, stepId: 'step-a', abortedLiveWalk: true });
    expect(executor.requestProgrammaticCancel).toHaveBeenCalledWith(runId);
    expect(stopLiveRun).toHaveBeenCalledWith(runId);
    await waitForRedrive(runQueues, runId);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// (7) Fan-out carve-out
// ---------------------------------------------------------------------------

describe('rewindRunHandler — fan-out carve-out', () => {
  it('all lanes integrated → the fanOut step is kept OUT of the purge, fanOutKeptSettled true, and seeded into the completed set', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, {
      status: 'failed',
      specJson: FANOUT_SPEC,
      currentStepId: 'fan',
      batchId: 'batch-1',
    });
    const executor = makeFakeExecutor();
    const resetFailedLanes = vi.fn<(batchId: string) => number>().mockReturnValue(0);
    // Every lane integrated ⇒ nothing re-dispatchable.
    const countRedispatchableLanes = vi.fn<(batchId: string) => number>().mockReturnValue(0);
    const deleteStepResults = vi.fn<(runId: string, stepIds: readonly string[]) => number>().mockReturnValue(1);
    // 'prep' + 'fan' both done pre-rewind.
    const listStepResults = () => [
      { stepId: 'prep', outcome: 'done' },
      { stepId: 'fan', outcome: 'done' },
    ];
    const deps = makeDeps(dbAdapter(db), executor, {
      runQueues,
      resetFailedLanes,
      countRedispatchableLanes,
      deleteStepResults,
      listStepResults,
    });

    // Rewind to 'prep' — the fanOut 'fan' step is AFTER the target (in the purge slice).
    const result = await rewindRunHandler(runId, 'prep', deps);

    expect(result).toEqual({ delivered: true, stepId: 'prep', abortedLiveWalk: false, fanOutKeptSettled: true });
    expect(countRedispatchableLanes).toHaveBeenCalledWith('batch-1');
    // Nothing is re-dispatchable, so the failed-lane reset is NOT called — the
    // count is a pure read and the keep-settled path mutates no lanes.
    expect(resetFailedLanes).not.toHaveBeenCalled();
    // 'fan' is EXCLUDED from the purge — only 'prep' is deleted.
    expect(deleteStepResults).toHaveBeenCalledWith(runId, ['prep']);
    // The kept-settled 'fan' step is added back into the completed set so the
    // re-driven walk SKIPS it (instead of the zero-item single-agent fall-through).
    expect(executor.setPendingCompletedSteps).toHaveBeenCalledWith(runId, ['fan']);
    await waitForRedrive(runQueues, runId);
    db.close();
  });

  it('failed lanes present → resetFailedLanes called and the fanOut step IS purged (re-dispatched)', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, {
      status: 'failed',
      specJson: FANOUT_SPEC,
      currentStepId: 'fan',
      batchId: 'batch-1',
    });
    const executor = makeFakeExecutor();
    const resetFailedLanes = vi.fn<(batchId: string) => number>().mockReturnValue(2);
    // 2 lanes re-dispatchable ⇒ NO carve-out.
    const countRedispatchableLanes = vi.fn<(batchId: string) => number>().mockReturnValue(2);
    const deleteStepResults = vi.fn<(runId: string, stepIds: readonly string[]) => number>().mockReturnValue(2);
    const deps = makeDeps(dbAdapter(db), executor, {
      runQueues,
      resetFailedLanes,
      countRedispatchableLanes,
      deleteStepResults,
    });

    const result = await rewindRunHandler(runId, 'prep', deps);

    expect(result).toEqual({ delivered: true, stepId: 'prep', abortedLiveWalk: false, fanOutKeptSettled: false });
    expect(resetFailedLanes).toHaveBeenCalledWith('batch-1');
    // 'fan' IS purged along with 'prep' — it will re-dispatch its failed lanes.
    expect(deleteStepResults).toHaveBeenCalledWith(runId, ['prep', 'fan']);
    await waitForRedrive(runQueues, runId);
    db.close();
  });

  it('target IS a fully-integrated fanOut step → refused fanout_settled with NO mutation', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, {
      status: 'failed',
      specJson: FANOUT_SPEC,
      currentStepId: 'fan',
      batchId: 'batch-1',
    });
    const executor = makeFakeExecutor();
    const resetFailedLanes = vi.fn<(batchId: string) => number>().mockReturnValue(0);
    // Every lane integrated ⇒ nothing would re-run at the 'fan' target.
    const countRedispatchableLanes = vi.fn<(batchId: string) => number>().mockReturnValue(0);
    const deleteStepResults = vi.fn<(runId: string, stepIds: readonly string[]) => number>().mockReturnValue(0);
    const reopenBatch = vi.fn<(batchId: string) => number>().mockReturnValue(0);
    const deps = makeDeps(dbAdapter(db), executor, {
      runQueues,
      resetFailedLanes,
      countRedispatchableLanes,
      deleteStepResults,
      reopenBatch,
    });

    // Rewind TO the settled fanOut step itself.
    const result = await rewindRunHandler(runId, 'fan', deps);

    expect(result).toEqual({ noOp: true, reason: 'fanout_settled' });
    // The refusal path is side-effect free: no lane reset, no purge, no batch
    // reopen, no revive, no re-drive.
    expect(resetFailedLanes).not.toHaveBeenCalled();
    expect(deleteStepResults).not.toHaveBeenCalled();
    expect(reopenBatch).not.toHaveBeenCalled();
    expect(executor.setPendingResumeStep).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
    const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('failed');
    db.close();
  });

  it('target IS a fanOut step with re-dispatchable lanes → delivered; target purged and lanes reset', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, {
      status: 'failed',
      specJson: FANOUT_SPEC,
      currentStepId: 'fan',
      batchId: 'batch-1',
    });
    const executor = makeFakeExecutor();
    const resetFailedLanes = vi.fn<(batchId: string) => number>().mockReturnValue(1);
    const countRedispatchableLanes = vi.fn<(batchId: string) => number>().mockReturnValue(1);
    const deleteStepResults = vi.fn<(runId: string, stepIds: readonly string[]) => number>().mockReturnValue(1);
    const deps = makeDeps(dbAdapter(db), executor, {
      runQueues,
      resetFailedLanes,
      countRedispatchableLanes,
      deleteStepResults,
    });

    const result = await rewindRunHandler(runId, 'fan', deps);

    expect(result).toEqual({ delivered: true, stepId: 'fan', abortedLiveWalk: false, fanOutKeptSettled: false });
    expect(resetFailedLanes).toHaveBeenCalledWith('batch-1');
    // The target fanOut step's own row is purged — it genuinely re-runs.
    expect(deleteStepResults).toHaveBeenCalledWith(runId, ['fan']);
    expect(executor.setPendingResumeStep).toHaveBeenCalledWith(runId, 'fan');
    await waitForRedrive(runQueues, runId);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// (8) Batch reopen — unconditional whenever batch_id
// ---------------------------------------------------------------------------

describe('rewindRunHandler — batch reopen', () => {
  it('calls reopenBatch whenever the run carries a batch_id (even with no fanOut in the purge slice)', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, {
      status: 'failed',
      specJson: THREE_STEP_SPEC,
      currentStepId: 'step-c',
      batchId: 'batch-9',
    });
    const executor = makeFakeExecutor();
    const reopenBatch = vi.fn<(batchId: string) => number>().mockReturnValue(1);
    const resetFailedLanes = vi.fn<(batchId: string) => number>().mockReturnValue(0);
    const deps = makeDeps(dbAdapter(db), executor, { runQueues, reopenBatch, resetFailedLanes });

    const result = await rewindRunHandler(runId, 'step-a', deps);

    expect(result).toMatchObject({ delivered: true, stepId: 'step-a' });
    expect(reopenBatch).toHaveBeenCalledWith('batch-9');
    // No fanOut step in this spec → the lane reset is NOT called, but reopen still is.
    expect(resetFailedLanes).not.toHaveBeenCalled();
    await waitForRedrive(runQueues, runId);
    db.close();
  });

  it('does NOT call reopenBatch when batch_id is absent', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'failed', currentStepId: 'step-c' });
    const executor = makeFakeExecutor();
    const reopenBatch = vi.fn<(batchId: string) => number>().mockReturnValue(0);
    const deps = makeDeps(dbAdapter(db), executor, { runQueues, reopenBatch });

    const result = await rewindRunHandler(runId, 'step-a', deps);

    expect(result).toMatchObject({ delivered: true });
    expect(reopenBatch).not.toHaveBeenCalled();
    await waitForRedrive(runQueues, runId);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// (9) Race — the guarded revive matches 0 rows
// ---------------------------------------------------------------------------

describe('rewindRunHandler — guarded-revive race', () => {
  it('status moves out of the rewindable set between phases → { noOp: race }, no re-drive', async () => {
    // The row is ACTUALLY 'completed' (so the real guarded UPDATE's status-IN WHERE
    // changes 0 rows), but the pre-flight + Phase-1 guard SELECT is faked to observe
    // 'failed' — simulating a concurrent transition landing between the guard read
    // and the UPDATE.
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'completed', currentStepId: 'step-c' });

    const real = dbAdapter(db);
    const adapter: DatabaseLike = {
      prepare: (sql: string): PreparedStatement => {
        const stmt = real.prepare(sql);
        // Intercept ONLY the handler's guard SELECT (run columns incl.
        // execution_model + batch_id) — the frozen-spec resolution reads pass
        // through to the real rows.
        if (sql.includes('execution_model') && sql.includes('batch_id') && sql.trimStart().startsWith('SELECT')) {
          return {
            run: (...params: unknown[]) => stmt.run(...params),
            get: () => ({
              status: 'failed',
              execution_model: 'programmatic',
              current_step_id: 'step-c',
              batch_id: null,
            }),
            all: (...params: unknown[]) => stmt.all(...params),
          };
        }
        return stmt;
      },
      transaction: real.transaction.bind(real),
    };

    const executor = makeFakeExecutor();
    const deps = makeDeps(adapter, executor, { runQueues });
    const result = await rewindRunHandler(runId, 'step-b', deps);

    expect(result).toEqual({ noOp: true, reason: 'race' });
    expect(executor.execute).not.toHaveBeenCalled();
    expect(deps.emitRunStatusChanged).not.toHaveBeenCalled();
    // Row untouched by the revive.
    const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('completed');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// (10) Gate sweep — pending-gate + approval + question deps invoked
// ---------------------------------------------------------------------------

describe('rewindRunHandler — gate sweep', () => {
  it('invokes clearPendingGateItems / clearPendingApprovalsForRun / clearPendingQuestionsForRun after the revive', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'awaiting_review', currentStepId: 'step-c' });
    const executor = makeFakeExecutor({ activeExecution: true });
    const clearPendingGateItems = vi.fn<(runId: string) => Promise<number>>().mockResolvedValue(2);
    const clearPendingApprovalsForRun = vi.fn<(runId: string) => void>();
    const clearPendingQuestionsForRun = vi.fn<(runId: string) => void>();
    const deps = makeDeps(dbAdapter(db), executor, {
      runQueues,
      clearPendingGateItems,
      clearPendingApprovalsForRun,
      clearPendingQuestionsForRun,
    });

    const result = await rewindRunHandler(runId, 'step-a', deps);

    expect(result).toMatchObject({ delivered: true });
    expect(clearPendingGateItems).toHaveBeenCalledWith(runId);
    expect(clearPendingApprovalsForRun).toHaveBeenCalledWith(runId);
    expect(clearPendingQuestionsForRun).toHaveBeenCalledWith(runId);
    await waitForRedrive(runQueues, runId);
    db.close();
  });

  it('a clearPendingGateItems rejection is fail-soft (errored) and does not un-do the revive', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'failed', currentStepId: 'step-c' });
    const executor = makeFakeExecutor();
    const clearPendingGateItems = vi.fn<(runId: string) => Promise<number>>().mockRejectedValue(new Error('gate boom'));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const deps = makeDeps(dbAdapter(db), executor, { runQueues, clearPendingGateItems, logger });

    const result = await rewindRunHandler(runId, 'step-a', deps);

    expect(result).toMatchObject({ delivered: true });
    const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('starting');
    expect(logger.error).toHaveBeenCalledWith(
      '[rewindRun] clearPendingGateItems rejected (fail-soft)',
      expect.objectContaining({ runId }),
    );
    await waitForRedrive(runQueues, runId);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Delivery mechanics — fire-and-forget execute rejection is swallowed
// ---------------------------------------------------------------------------

describe('rewindRunHandler — delivery mechanics', () => {
  it('execute() rejection is logged but does NOT reject the handler — result still delivered', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'failed', currentStepId: 'step-c' });
    const executor = makeFakeExecutor({ executeRejects: true });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const deps = makeDeps(dbAdapter(db), executor, { runQueues, logger });

    const result = await rewindRunHandler(runId, 'step-a', deps);

    expect(result).toMatchObject({ delivered: true, stepId: 'step-a' });
    await waitForRedrive(runQueues, runId);
    expect(executor.execute).toHaveBeenCalledWith(runId);
    expect(logger.error).toHaveBeenCalledWith(
      '[rewindRun] execute() rejected after rewind flip',
      expect.objectContaining({ runId }),
    );
    db.close();
  });

  it('refuses WITHOUT enqueueing on the run queue for a pre-flight refusal (not_rewindable)', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const getOrCreateSpy = vi.spyOn(runQueues, 'getOrCreate');
    const { runId } = seedProgrammaticRun(db, { status: 'completed', currentStepId: 'step-c' });
    const executor = makeFakeExecutor();
    const deps = makeDeps(dbAdapter(db), executor, { runQueues });

    const result = await rewindRunHandler(runId, 'step-a', deps);

    expect(result).toEqual({ noOp: true, reason: 'not_rewindable' });
    expect(getOrCreateSpy).not.toHaveBeenCalled();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Frozen-spec resolution — targets validate against the run's FROZEN revision,
// never the live workflows.spec_json (docs/CODE-PATTERNS.md reader rule;
// pattern mirrors stepTransitionBridge.frozenSpec.test.ts)
// ---------------------------------------------------------------------------

describe('rewindRunHandler — frozen-spec resolution', () => {
  /** Two steps present ONLY in the run's frozen variant revision. */
  const VARIANT_SPEC = JSON.stringify({
    id: 'test-wf-variant',
    phases: [
      {
        id: 'phase-1',
        label: 'Phase 1',
        color: '#111111',
        steps: [
          { id: 'var-a', name: 'Var A', agent: 'agent-a' },
          { id: 'var-b', name: 'Var B', agent: 'agent-b' },
        ],
      },
    ],
  });

  /** Live spec = THREE_STEP_SPEC (step-a..c); the run's frozen revision = VARIANT_SPEC. */
  function seedVariantRun(db: Database.Database): { runId: string } {
    const { runId, workflowId } = seedProgrammaticRun(db, {
      status: 'failed',
      specJson: THREE_STEP_SPEC,
      currentStepId: 'var-b',
    });
    db.exec('ALTER TABLE workflow_runs ADD COLUMN spec_hash TEXT');
    db.exec(`
      CREATE TABLE workflow_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL, spec_hash TEXT NOT NULL,
        spec_json TEXT NOT NULL, UNIQUE(workflow_id, spec_hash)
      );
    `);
    db.prepare('UPDATE workflow_runs SET spec_hash = ? WHERE id = ?').run('variant-hash', runId);
    db.prepare('INSERT INTO workflow_revisions (workflow_id, spec_hash, spec_json) VALUES (?, ?, ?)').run(
      workflowId,
      'variant-hash',
      VARIANT_SPEC,
    );
    return { runId };
  }

  it('ACCEPTS a target present only in the frozen variant revision', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedVariantRun(db);
    const executor = makeFakeExecutor();
    const deps = makeDeps(dbAdapter(db), executor, { runQueues });

    const result = await rewindRunHandler(runId, 'var-a', deps);

    expect(result).toMatchObject({ delivered: true, stepId: 'var-a' });
    // The purge slice is computed from the FROZEN graph too.
    expect(deps.deleteStepResults).toHaveBeenCalledWith(runId, ['var-a', 'var-b']);
    await waitForRedrive(runQueues, runId);
    db.close();
  });

  it('REJECTS a target present only in the LIVE workflow spec (unknown_step)', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedVariantRun(db);
    const executor = makeFakeExecutor();
    const deps = makeDeps(dbAdapter(db), executor, { runQueues });

    const result = await rewindRunHandler(runId, 'step-a', deps);

    expect(result).toEqual({ noOp: true, reason: 'unknown_step' });
    expect(deps.deleteStepResults).not.toHaveBeenCalled();
    db.close();
  });
});
