/**
 * Unit tests for retryRunHandler — the PROGRAMMATIC-ONLY `runs.retryStep`
 * mutation (user-facing "retry a failed programmatic run from a step").
 *
 * Covers the full guard matrix (not_found / not_programmatic / not_retryable
 * for both wrong-status runs AND an awaiting_review run parked at a LIVE
 * gate / no_target_step / unknown_step / race), target-step resolution order
 * (explicit param > last failed step_results row > current_step_id), the
 * completed-set exclusion that lets a retry re-run a SKIPPED step, the
 * fan-out lane reset gating (batch_id present AND target step declares
 * fanOut), the fire-and-forget re-drive (execute() rejection is logged but
 * never surfaces to the caller), and the revive UPDATE's field clears.
 *
 * Standalone: no electron / services imports. The DB is an in-memory SQLite
 * via createTestDb wrapped in the DatabaseLike adapter; the executor + queue
 * are lightweight fakes. Style mirrors resumeRunHandler.test.ts /
 * reopenRunHandler.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedRun } from '../__test_fixtures__/orchestratorTestDb';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { RunQueueRegistry } from '../RunQueueRegistry';
import {
  retryRunHandler,
  type RetryRunExecutorLike,
  type RetryRunDeps,
} from '../retryRunHandler';
import type { DatabaseLike, PreparedStatement } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal but structurally-valid WorkflowDefinition (two plain steps, no fanOut). */
const BASIC_SPEC = JSON.stringify({
  id: 'test-wf',
  phases: [
    {
      id: 'phase-1',
      label: 'Phase 1',
      color: '#111111',
      steps: [
        { id: 'step-a', name: 'Step A', agent: 'agent-a' },
        { id: 'step-b', name: 'Step B', agent: 'agent-b' },
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

function setErrorTerminalStamp(
  db: Database.Database,
  runId: string,
  fields: { errorMessage?: string; endedAt?: string; outcome?: string },
): void {
  db.prepare('UPDATE workflow_runs SET error_message = ?, ended_at = ?, outcome = ? WHERE id = ?').run(
    fields.errorMessage ?? null,
    fields.endedAt ?? null,
    fields.outcome ?? null,
    runId,
  );
}

/** Seed a run + workflow wired up as a retryable programmatic run by default. */
function seedProgrammaticRun(
  db: Database.Database,
  overrides?: {
    status?: 'failed' | 'awaiting_review' | 'running' | 'completed' | 'canceled';
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
  setWorkflowSpec(db, workflowId, overrides?.specJson ?? BASIC_SPEC);
  if (overrides?.currentStepId !== undefined) setCurrentStepId(db, runId, overrides.currentStepId);
  if (overrides?.batchId !== undefined) setBatchId(db, runId, overrides.batchId);
  return { runId, workflowId };
}

/** A fake executor that records setPendingResumeStep/setPendingCompletedSteps/execute calls. */
function makeFakeExecutor(opts?: {
  activeExecution?: boolean;
  executeRejects?: boolean;
}): RetryRunExecutorLike & {
  setPendingResumeStep: ReturnType<typeof vi.fn>;
  setPendingCompletedSteps: ReturnType<typeof vi.fn>;
  hasActiveExecution: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
} {
  const setPendingResumeStep = vi.fn<(runId: string, stepId: string) => void>();
  const setPendingCompletedSteps = vi.fn<(runId: string, stepIds: readonly string[]) => void>();
  const hasActiveExecution = vi.fn<(runId: string) => boolean>().mockReturnValue(opts?.activeExecution ?? false);
  const execute = vi.fn<(runId: string) => Promise<void>>().mockImplementation(async () => {
    if (opts?.executeRejects) throw new Error('boom');
  });
  return { setPendingResumeStep, setPendingCompletedSteps, hasActiveExecution, execute };
}

/** Build deps with an emit spy + the given executor + optional overrides. */
function makeDeps(
  db: DatabaseLike,
  executor: RetryRunExecutorLike,
  opts?: {
    runQueues?: RunQueueRegistry;
    completedStepIds?: (runId: string) => string[];
    listStepResults?: (runId: string) => Array<{ stepId: string; outcome: string }>;
    resetFailedLanes?: ReturnType<typeof vi.fn>;
    logger?: RetryRunDeps['logger'];
  },
): RetryRunDeps & { emitRunStatusChanged: ReturnType<typeof vi.fn> } {
  const emitRunStatusChanged = vi.fn<(runId: string, status: 'starting') => void>();
  return {
    db,
    runQueues: opts?.runQueues ?? new RunQueueRegistry(),
    runExecutor: executor,
    emitRunStatusChanged,
    completedStepIds: opts?.completedStepIds ?? (() => []),
    listStepResults: opts?.listStepResults ?? (() => []),
    resetFailedLanes: opts?.resetFailedLanes,
    logger: opts?.logger,
  };
}

/** Wait for the fire-and-forget re-drive task (queued inside retryRunHandler) to settle. */
async function waitForRedrive(runQueues: RunQueueRegistry, runId: string): Promise<void> {
  await runQueues.getOrCreate(runId).onIdle();
}

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// Guard matrix
// ---------------------------------------------------------------------------

describe('retryRunHandler — guard matrix', () => {
  it('missing run → { noOp: not_found }', async () => {
    const db = makeDb();
    const executor = makeFakeExecutor();
    const result = await retryRunHandler('no-such-run', undefined, makeDeps(dbAdapter(db), executor));
    expect(result).toEqual({ noOp: true, reason: 'not_found' });
    expect(executor.execute).not.toHaveBeenCalled();
    db.close();
  });

  it('orchestrated run → { noOp: not_programmatic }', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'failed' });
    // execution_model defaults to 'orchestrated' (GATE_SCHEMA default) — no override.
    const executor = makeFakeExecutor();
    const result = await retryRunHandler(runId, undefined, makeDeps(dbAdapter(db), executor));
    expect(result).toEqual({ noOp: true, reason: 'not_programmatic' });
    expect(executor.execute).not.toHaveBeenCalled();
    db.close();
  });

  it.each(['running', 'completed', 'canceled'] as const)(
    'status=%s (non-resting) → { noOp: not_retryable }',
    async (status) => {
      const db = makeDb();
      const { runId } = seedProgrammaticRun(db, { status });
      const executor = makeFakeExecutor();
      const result = await retryRunHandler(runId, undefined, makeDeps(dbAdapter(db), executor));
      expect(result).toEqual({ noOp: true, reason: 'not_retryable' });
      expect(executor.execute).not.toHaveBeenCalled();
      db.close();
    },
  );

  it('awaiting_review with an ACTIVE executor (live gate) → { noOp: not_retryable }', async () => {
    const db = makeDb();
    const { runId } = seedProgrammaticRun(db, { status: 'awaiting_review', currentStepId: 'step-a' });
    const executor = makeFakeExecutor({ activeExecution: true });
    const result = await retryRunHandler(runId, undefined, makeDeps(dbAdapter(db), executor));
    expect(result).toEqual({ noOp: true, reason: 'not_retryable' });
    expect(executor.hasActiveExecution).toHaveBeenCalledWith(runId);
    expect(executor.execute).not.toHaveBeenCalled();
    db.close();
  });

  it('awaiting_review with NO active executor (resting walk) → delivered', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'awaiting_review', currentStepId: 'step-a' });
    const executor = makeFakeExecutor({ activeExecution: false });
    const deps = makeDeps(dbAdapter(db), executor, { runQueues });

    const result = await retryRunHandler(runId, undefined, deps);

    expect(result).toEqual({ delivered: true, stepId: 'step-a' });
    await waitForRedrive(runQueues, runId);
    expect(executor.execute).toHaveBeenCalledWith(runId);
    db.close();
  });

  it('explicit stepId not in the resolved definition → { noOp: unknown_step }', async () => {
    const db = makeDb();
    const { runId } = seedProgrammaticRun(db, { status: 'failed' });
    const executor = makeFakeExecutor();
    const result = await retryRunHandler(runId, 'no-such-step', makeDeps(dbAdapter(db), executor));
    expect(result).toEqual({ noOp: true, reason: 'unknown_step' });
    expect(executor.execute).not.toHaveBeenCalled();
    // Run was never flipped.
    const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('failed');
    db.close();
  });

  it('no explicit stepId, no failed step_results, no current_step_id → { noOp: no_target_step }', async () => {
    const db = makeDb();
    const { runId } = seedProgrammaticRun(db, { status: 'failed', currentStepId: null });
    const executor = makeFakeExecutor();
    const result = await retryRunHandler(runId, undefined, makeDeps(dbAdapter(db), executor));
    expect(result).toEqual({ noOp: true, reason: 'no_target_step' });
    expect(executor.execute).not.toHaveBeenCalled();
    db.close();
  });

  it('race: guard SELECT observes a retryable status but the guarded UPDATE matches 0 rows → { noOp: race }', async () => {
    // The row is ACTUALLY 'running' (so the real guarded UPDATE's
    // `WHERE status IN ('failed','awaiting_review')` changes 0 rows), but the
    // guard SELECT is faked to observe 'failed' — simulating a concurrent
    // transition landing between the SELECT and the UPDATE.
    const db = makeDb();
    const { runId } = seedProgrammaticRun(db, { status: 'running', currentStepId: 'step-a' });

    const real = dbAdapter(db);
    const adapter: DatabaseLike = {
      prepare: (sql: string): PreparedStatement => {
        const stmt = real.prepare(sql);
        if (sql.includes('FROM workflow_runs r') && sql.includes('JOIN workflows w')) {
          return {
            run: (...params: unknown[]) => stmt.run(...params),
            get: () => ({
              status: 'failed',
              execution_model: 'programmatic',
              current_step_id: 'step-a',
              batch_id: null,
              workflow_name: 'test-workflow',
              spec_json: BASIC_SPEC,
            }),
            all: (...params: unknown[]) => stmt.all(...params),
          };
        }
        return stmt;
      },
      transaction: real.transaction.bind(real),
    };

    const executor = makeFakeExecutor();
    const deps = makeDeps(adapter, executor);
    const result = await retryRunHandler(runId, undefined, deps);

    expect(result).toEqual({ noOp: true, reason: 'race' });
    expect(executor.execute).not.toHaveBeenCalled();
    expect(deps.emitRunStatusChanged).not.toHaveBeenCalled();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Target-step resolution
// ---------------------------------------------------------------------------

describe('retryRunHandler — target-step resolution', () => {
  it('default target = the LAST failed step_results row', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'failed', currentStepId: 'step-a' });
    const executor = makeFakeExecutor();
    const deps = makeDeps(dbAdapter(db), executor, {
      runQueues,
      listStepResults: () => [
        { stepId: 'step-a', outcome: 'done' },
        { stepId: 'step-b', outcome: 'failed' },
      ],
    });

    const result = await retryRunHandler(runId, undefined, deps);

    expect(result).toEqual({ delivered: true, stepId: 'step-b' });
    expect(executor.setPendingResumeStep).toHaveBeenCalledWith(runId, 'step-b');
    await waitForRedrive(runQueues, runId);
    db.close();
  });

  it('fallback to current_step_id when there is no failed step_results row', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'failed', currentStepId: 'step-a' });
    const executor = makeFakeExecutor();
    const deps = makeDeps(dbAdapter(db), executor, {
      runQueues,
      listStepResults: () => [{ stepId: 'step-a', outcome: 'done' }],
    });

    const result = await retryRunHandler(runId, undefined, deps);

    expect(result).toEqual({ delivered: true, stepId: 'step-a' });
    expect(executor.setPendingResumeStep).toHaveBeenCalledWith(runId, 'step-a');
    await waitForRedrive(runQueues, runId);
    db.close();
  });

  it('explicit stepId wins over both step_results and current_step_id', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'failed', currentStepId: 'step-a' });
    const executor = makeFakeExecutor();
    const deps = makeDeps(dbAdapter(db), executor, {
      runQueues,
      listStepResults: () => [{ stepId: 'step-a', outcome: 'failed' }],
    });

    const result = await retryRunHandler(runId, 'step-b', deps);

    expect(result).toEqual({ delivered: true, stepId: 'step-b' });
    await waitForRedrive(runQueues, runId);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Completed-set exclusion (retrying a SKIPPED step re-runs it)
// ---------------------------------------------------------------------------

describe('retryRunHandler — completed-set exclusion', () => {
  it('the completed set passed to setPendingCompletedSteps EXCLUDES the target step', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'failed', currentStepId: 'step-b' });
    const executor = makeFakeExecutor();
    const deps = makeDeps(dbAdapter(db), executor, {
      runQueues,
      completedStepIds: () => ['step-a', 'step-b'],
    });

    const result = await retryRunHandler(runId, undefined, deps);

    expect(result).toEqual({ delivered: true, stepId: 'step-b' });
    expect(executor.setPendingCompletedSteps).toHaveBeenCalledWith(runId, ['step-a']);
    await waitForRedrive(runQueues, runId);
    db.close();
  });

  it('setPendingCompletedSteps is NOT called when the filtered completed set is empty', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'failed', currentStepId: 'step-b' });
    const executor = makeFakeExecutor();
    const deps = makeDeps(dbAdapter(db), executor, {
      runQueues,
      completedStepIds: () => ['step-b'],
    });

    const result = await retryRunHandler(runId, undefined, deps);

    expect(result).toEqual({ delivered: true, stepId: 'step-b' });
    expect(executor.setPendingCompletedSteps).not.toHaveBeenCalled();
    await waitForRedrive(runQueues, runId);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Fan-out lane reset gating
// ---------------------------------------------------------------------------

describe('retryRunHandler — fan-out lane reset gating', () => {
  it('calls resetFailedLanes when batch_id is present AND the target step declares fanOut', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    // spec_json stays '{}' (seedRun default) + workflowName 'sprint' → resolveWorkflowDefinition
    // falls back to the built-in WORKFLOW_DEFINITIONS.sprint, whose 'execute-tasks' step
    // declares fanOut.
    const { runId } = seedRun(db, { status: 'failed', workflowName: 'sprint' });
    setExecutionModel(db, runId, 'programmatic');
    setBatchId(db, runId, 'batch-1');
    setCurrentStepId(db, runId, 'execute-tasks');

    const executor = makeFakeExecutor();
    const resetFailedLanes = vi.fn<(batchId: string) => number>().mockReturnValue(2);
    const deps = makeDeps(dbAdapter(db), executor, { runQueues, resetFailedLanes });

    const result = await retryRunHandler(runId, undefined, deps);

    expect(result).toEqual({ delivered: true, stepId: 'execute-tasks' });
    expect(resetFailedLanes).toHaveBeenCalledWith('batch-1');
    await waitForRedrive(runQueues, runId);
    db.close();
  });

  it('does NOT call resetFailedLanes when batch_id is absent', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedRun(db, { status: 'failed', workflowName: 'sprint' });
    setExecutionModel(db, runId, 'programmatic');
    setCurrentStepId(db, runId, 'execute-tasks');
    // batch_id left NULL.

    const executor = makeFakeExecutor();
    const resetFailedLanes = vi.fn<(batchId: string) => number>().mockReturnValue(0);
    const deps = makeDeps(dbAdapter(db), executor, { runQueues, resetFailedLanes });

    const result = await retryRunHandler(runId, undefined, deps);

    expect(result).toEqual({ delivered: true, stepId: 'execute-tasks' });
    expect(resetFailedLanes).not.toHaveBeenCalled();
    await waitForRedrive(runQueues, runId);
    db.close();
  });

  it('does NOT call resetFailedLanes when the target step has no fanOut (even with batch_id set)', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'failed', currentStepId: 'step-a', batchId: 'batch-1' });

    const executor = makeFakeExecutor();
    const resetFailedLanes = vi.fn<(batchId: string) => number>().mockReturnValue(0);
    const deps = makeDeps(dbAdapter(db), executor, { runQueues, resetFailedLanes });

    const result = await retryRunHandler(runId, undefined, deps);

    expect(result).toEqual({ delivered: true, stepId: 'step-a' });
    expect(resetFailedLanes).not.toHaveBeenCalled();
    await waitForRedrive(runQueues, runId);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Delivery mechanics: emit, fire-and-forget execute, revive field clears
// ---------------------------------------------------------------------------

describe('retryRunHandler — delivery mechanics', () => {
  it('emits run-status-changed(starting) and flips the row to starting', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'failed', currentStepId: 'step-a' });
    const executor = makeFakeExecutor();
    const deps = makeDeps(dbAdapter(db), executor, { runQueues });

    const result = await retryRunHandler(runId, undefined, deps);

    expect(result).toEqual({ delivered: true, stepId: 'step-a' });
    expect(deps.emitRunStatusChanged).toHaveBeenCalledWith(runId, 'starting');
    const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('starting');
    await waitForRedrive(runQueues, runId);
    db.close();
  });

  it('the revive UPDATE clears error_message, ended_at, and outcome', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'failed', currentStepId: 'step-a' });
    setErrorTerminalStamp(db, runId, {
      errorMessage: 'boom from last attempt',
      endedAt: '2026-01-01T00:00:00.000Z',
      outcome: 'failed',
    });
    const executor = makeFakeExecutor();
    const deps = makeDeps(dbAdapter(db), executor, { runQueues });

    const result = await retryRunHandler(runId, undefined, deps);

    expect(result).toEqual({ delivered: true, stepId: 'step-a' });
    const row = db
      .prepare('SELECT status, error_message, ended_at, outcome FROM workflow_runs WHERE id = ?')
      .get(runId) as { status: string; error_message: string | null; ended_at: string | null; outcome: string | null };
    expect(row.status).toBe('starting');
    expect(row.error_message).toBeNull();
    expect(row.ended_at).toBeNull();
    expect(row.outcome).toBeNull();
    await waitForRedrive(runQueues, runId);
    db.close();
  });

  it('execute() rejection is logged but does NOT reject the handler — result is still delivered', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'failed', currentStepId: 'step-a' });
    const executor = makeFakeExecutor({ executeRejects: true });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const deps = makeDeps(dbAdapter(db), executor, { runQueues, logger });

    const result = await retryRunHandler(runId, undefined, deps);

    // Delivered immediately — the handler does not await execute().
    expect(result).toEqual({ delivered: true, stepId: 'step-a' });

    await waitForRedrive(runQueues, runId);
    expect(executor.execute).toHaveBeenCalledWith(runId);
    expect(logger.error).toHaveBeenCalledWith(
      '[retryRun] execute() rejected after starting flip',
      expect.objectContaining({ runId }),
    );
    db.close();
  });
});
