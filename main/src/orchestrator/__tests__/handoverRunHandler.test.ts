/**
 * Unit tests for handoverRunHandler — converting a PROGRAMMATIC run to the
 * ORCHESTRATED plane mid-run (the monitor-requested "hand this over" seam).
 *
 * Covers the pre-flight guard matrix (not_found / not_programmatic /
 * not_switchable) decided WITHOUT enqueueing on the held per-run queue; the
 * live-walk abort ordering (requestProgrammaticCancel + stopLiveRun BEFORE the
 * guarded flip); the sanctioned one-way execution_model flip + terminal-stamp
 * clears; the model+status-guarded race; and the happy-path delivery mechanics
 * (pending-gate sweep, seeded handover brief, fire-and-forget execute, emit).
 * The pure composeHandoverPrompt is unit-tested separately (remaining-step
 * markers, null prompt body, per-line truncation).
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
import {
  handoverRunHandler,
  composeHandoverPrompt,
  type HandoverRunExecutorLike,
  type HandoverRunDeps,
} from '../handoverRunHandler';
import type { DatabaseLike, PreparedStatement } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal but structurally-valid WorkflowDefinition (two plain steps). */
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

function setExecutionModel(
  db: Database.Database,
  runId: string,
  model: 'orchestrated' | 'programmatic',
): void {
  db.prepare('UPDATE workflow_runs SET execution_model = ? WHERE id = ?').run(model, runId);
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

/** Seed a run + workflow wired up as a switchable programmatic run by default. */
function seedProgrammaticRun(
  db: Database.Database,
  overrides?: {
    status?: 'failed' | 'awaiting_review' | 'running' | 'completed' | 'canceled' | 'starting';
    specJson?: string;
    workflowName?: string;
  },
): { runId: string; workflowId: string } {
  const { runId, workflowId } = seedRun(db, {
    status: overrides?.status ?? 'failed',
    workflowName: overrides?.workflowName ?? 'test-workflow',
  });
  setExecutionModel(db, runId, 'programmatic');
  setWorkflowSpec(db, workflowId, overrides?.specJson ?? BASIC_SPEC);
  return { runId, workflowId };
}

type StepResult = { stepId: string; outcome: string; summary?: string | null; error?: string | null };

/** A fake executor recording hasActiveExecution/requestProgrammaticCancel/setPendingNudge/execute. */
function makeFakeExecutor(opts?: {
  activeExecution?: boolean;
  executeRejects?: boolean;
}): HandoverRunExecutorLike & {
  hasActiveExecution: ReturnType<typeof vi.fn>;
  requestProgrammaticCancel: ReturnType<typeof vi.fn>;
  setPendingNudge: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
} {
  const hasActiveExecution = vi
    .fn<(runId: string) => boolean>()
    .mockReturnValue(opts?.activeExecution ?? false);
  const requestProgrammaticCancel = vi.fn<(runId: string) => boolean>().mockReturnValue(true);
  const setPendingNudge = vi.fn<(runId: string, text: string) => void>();
  const execute = vi.fn<(runId: string) => Promise<void>>().mockImplementation(async () => {
    if (opts?.executeRejects) throw new Error('boom');
  });
  return { hasActiveExecution, requestProgrammaticCancel, setPendingNudge, execute };
}

/** Build deps with spies + the given executor + optional overrides. */
function makeDeps(
  db: DatabaseLike,
  executor: HandoverRunExecutorLike,
  opts?: {
    runQueues?: RunQueueRegistry;
    clearPendingGateItems?: (runId: string) => Promise<number>;
    stopLiveRun?: (runId: string) => Promise<void>;
    readWorkflowPrompt?: (workflowId: string) => string | null;
    listStepResults?: (runId: string) => StepResult[];
    logger?: HandoverRunDeps['logger'];
  },
): HandoverRunDeps & {
  emitRunStatusChanged: ReturnType<typeof vi.fn>;
  clearPendingGateItems: (runId: string) => Promise<number>;
  disposeMonitor: ReturnType<typeof vi.fn>;
} {
  const emitRunStatusChanged = vi.fn<(runId: string, status: 'starting') => void>();
  const clearPendingGateItems =
    opts?.clearPendingGateItems ?? vi.fn<(runId: string) => Promise<number>>().mockResolvedValue(0);
  const disposeMonitor = vi.fn<(runId: string) => void>();
  return {
    db,
    runQueues: opts?.runQueues ?? new RunQueueRegistry(),
    runExecutor: executor,
    emitRunStatusChanged,
    clearPendingGateItems,
    stopLiveRun: opts?.stopLiveRun,
    disposeMonitor,
    readWorkflowPrompt: opts?.readWorkflowPrompt ?? (() => 'PROMPT BODY VERBATIM'),
    listStepResults: opts?.listStepResults ?? (() => []),
    logger: opts?.logger,
  };
}

/** Wait for the fire-and-forget re-drive task to settle. */
async function waitForRedrive(runQueues: RunQueueRegistry, runId: string): Promise<void> {
  await runQueues.getOrCreate(runId).onIdle();
}

function getRow(
  db: Database.Database,
  runId: string,
): { status: string; execution_model: string; error_message: string | null; ended_at: string | null; outcome: string | null } {
  return db
    .prepare('SELECT status, execution_model, error_message, ended_at, outcome FROM workflow_runs WHERE id = ?')
    .get(runId) as {
    status: string;
    execution_model: string;
    error_message: string | null;
    ended_at: string | null;
    outcome: string | null;
  };
}

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// Pre-flight guard matrix (no enqueue)
// ---------------------------------------------------------------------------

describe('handoverRunHandler — pre-flight guard matrix', () => {
  it('missing run → { noOp: not_found }, WITHOUT enqueueing', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const getOrCreateSpy = vi.spyOn(runQueues, 'getOrCreate');
    const executor = makeFakeExecutor();
    const result = await handoverRunHandler(
      'no-such-run',
      'take over',
      makeDeps(dbAdapter(db), executor, { runQueues }),
    );
    expect(result).toEqual({ noOp: true, reason: 'not_found' });
    expect(getOrCreateSpy).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
    db.close();
  });

  it('orchestrated run → { noOp: not_programmatic }, WITHOUT enqueueing', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const getOrCreateSpy = vi.spyOn(runQueues, 'getOrCreate');
    const { runId } = seedRun(db, { status: 'failed' });
    // execution_model defaults to 'orchestrated' (GATE_SCHEMA default) — no override.
    const executor = makeFakeExecutor();
    const deps = makeDeps(dbAdapter(db), executor, { runQueues });
    const result = await handoverRunHandler(runId, 'take over', deps);
    expect(result).toEqual({ noOp: true, reason: 'not_programmatic' });
    expect(getOrCreateSpy).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
    // A refused handover must NOT tear down the monitor — the run stays programmatic.
    expect(deps.disposeMonitor).not.toHaveBeenCalled();
    db.close();
  });

  it.each(['completed', 'canceled', 'starting'] as const)(
    'status=%s → { noOp: not_switchable }, WITHOUT enqueueing',
    async (status) => {
      const db = makeDb();
      const runQueues = new RunQueueRegistry();
      const getOrCreateSpy = vi.spyOn(runQueues, 'getOrCreate');
      const { runId } = seedProgrammaticRun(db, { status });
      const executor = makeFakeExecutor();
      const result = await handoverRunHandler(
        runId,
        'take over',
        makeDeps(dbAdapter(db), executor, { runQueues }),
      );
      expect(result).toEqual({ noOp: true, reason: 'not_switchable' });
      expect(getOrCreateSpy).not.toHaveBeenCalled();
      expect(executor.execute).not.toHaveBeenCalled();
      db.close();
    },
  );
});

// ---------------------------------------------------------------------------
// Live-walk abort ordering
// ---------------------------------------------------------------------------

describe('handoverRunHandler — live-walk abort', () => {
  it('aborts (requestProgrammaticCancel + stopLiveRun) BEFORE the guarded flip', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'running' });
    const executor = makeFakeExecutor({ activeExecution: true });

    // stopLiveRun observes the row's status at call time — it must still be
    // 'running' (the flip runs strictly AFTER the abort completes).
    const observedAtStop: string[] = [];
    const stopLiveRun = vi.fn<(runId: string) => Promise<void>>().mockImplementation(async () => {
      observedAtStop.push(getRow(db, runId).status);
    });

    const deps = makeDeps(dbAdapter(db), executor, { runQueues, stopLiveRun });
    const result = await handoverRunHandler(runId, 'take over the stuck run', deps);

    expect(result).toEqual({ delivered: true });
    expect(executor.requestProgrammaticCancel).toHaveBeenCalledWith(runId);
    expect(stopLiveRun).toHaveBeenCalledWith(runId);
    // Ordering: cancel BEFORE stop, and stop observed the pre-flip status.
    expect(executor.requestProgrammaticCancel.mock.invocationCallOrder[0]).toBeLessThan(
      stopLiveRun.mock.invocationCallOrder[0],
    );
    expect(observedAtStop).toEqual(['running']);
    // The flip landed after the abort.
    expect(getRow(db, runId)).toMatchObject({ status: 'starting', execution_model: 'orchestrated' });
    await waitForRedrive(runQueues, runId);
    db.close();
  });

  it('a resting run (no active executor) does NOT abort', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'failed' });
    const executor = makeFakeExecutor({ activeExecution: false });
    const stopLiveRun = vi.fn<(runId: string) => Promise<void>>().mockResolvedValue(undefined);
    const deps = makeDeps(dbAdapter(db), executor, { runQueues, stopLiveRun });

    const result = await handoverRunHandler(runId, 'take over', deps);

    expect(result).toEqual({ delivered: true });
    expect(executor.requestProgrammaticCancel).not.toHaveBeenCalled();
    expect(stopLiveRun).not.toHaveBeenCalled();
    await waitForRedrive(runQueues, runId);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Guarded flip + terminal-stamp clears
// ---------------------------------------------------------------------------

describe('handoverRunHandler — guarded execution_model flip', () => {
  it('flips execution_model=orchestrated + status=starting and clears error stamps', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'failed' });
    setErrorTerminalStamp(db, runId, {
      errorMessage: 'boom from the walk',
      endedAt: '2026-01-01T00:00:00.000Z',
      outcome: 'failed',
    });
    const executor = makeFakeExecutor();
    const deps = makeDeps(dbAdapter(db), executor, { runQueues });

    const result = await handoverRunHandler(runId, 'take over', deps);

    expect(result).toEqual({ delivered: true });
    const row = getRow(db, runId);
    expect(row.status).toBe('starting');
    expect(row.execution_model).toBe('orchestrated');
    expect(row.error_message).toBeNull();
    expect(row.ended_at).toBeNull();
    expect(row.outcome).toBeNull();
    await waitForRedrive(runQueues, runId);
    db.close();
  });

  it('race: guard SELECT observes a switchable status but the guarded UPDATE matches 0 rows → { noOp: race }', async () => {
    // The row is ACTUALLY 'completed' (so the guarded UPDATE's
    // `WHERE status IN ('failed','awaiting_review','running')` changes 0 rows), but
    // the JOIN SELECT is faked to observe 'running' — simulating a concurrent
    // transition landing between the pre-flight read and the guarded flip.
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'completed' });

    const real = dbAdapter(db);
    const adapter: DatabaseLike = {
      prepare: (sql: string): PreparedStatement => {
        const stmt = real.prepare(sql);
        if (sql.includes('FROM workflow_runs r') && sql.includes('JOIN workflows w')) {
          return {
            run: (...params: unknown[]) => stmt.run(...params),
            get: () => ({
              status: 'running',
              execution_model: 'programmatic',
              current_step_id: null,
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
    const deps = makeDeps(adapter, executor, { runQueues });
    const result = await handoverRunHandler(runId, 'take over', deps);

    expect(result).toEqual({ noOp: true, reason: 'race' });
    expect(executor.setPendingNudge).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
    expect(deps.emitRunStatusChanged).not.toHaveBeenCalled();
    // The run was NOT converted — still completed + programmatic.
    expect(getRow(db, runId)).toMatchObject({ status: 'completed', execution_model: 'programmatic' });
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Happy-path delivery mechanics
// ---------------------------------------------------------------------------

describe('handoverRunHandler — delivery mechanics', () => {
  it('sweeps pending gates, seeds a handover brief, fires execute, emits starting', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'awaiting_review' });
    const executor = makeFakeExecutor();
    const clearPendingGateItems = vi.fn<(runId: string) => Promise<number>>().mockResolvedValue(3);
    const reason = 'The user wants to pivot the whole implementation strategy';
    const listStepResults = (): StepResult[] => [
      { stepId: 'step-a', outcome: 'done', summary: 'did A' },
      { stepId: 'step-b', outcome: 'failed', error: 'boom in B' },
    ];
    const deps = makeDeps(dbAdapter(db), executor, {
      runQueues,
      clearPendingGateItems,
      listStepResults,
      readWorkflowPrompt: () => 'FULL WORKFLOW PROMPT',
    });

    const result = await handoverRunHandler(runId, reason, deps);

    expect(result).toEqual({ delivered: true });
    expect(clearPendingGateItems).toHaveBeenCalledWith(runId);
    expect(deps.emitRunStatusChanged).toHaveBeenCalledWith(runId, 'starting');
    // The monitor is torn down on handover (orchestrated runs have no monitor), and
    // BEFORE the status emit so the frontend's status-keyed re-probe sees it gone.
    expect(deps.disposeMonitor).toHaveBeenCalledWith(runId);
    expect(deps.disposeMonitor.mock.invocationCallOrder[0]).toBeLessThan(
      deps.emitRunStatusChanged.mock.invocationCallOrder[0],
    );

    // The seeded brief carries the reason verbatim + a completed line + a remaining line.
    expect(executor.setPendingNudge).toHaveBeenCalledTimes(1);
    const [nudgeRunId, promptArg] = executor.setPendingNudge.mock.calls[0];
    expect(nudgeRunId).toBe(runId);
    expect(promptArg).toContain(reason);
    expect(promptArg).toContain('- step-a: done — did A');
    expect(promptArg).toContain('- step-b — Step B (previously failed)');
    expect(promptArg).toContain('FULL WORKFLOW PROMPT');

    await waitForRedrive(runQueues, runId);
    expect(executor.execute).toHaveBeenCalledWith(runId);
    db.close();
  });

  it('execute() rejection is logged but does NOT reject the handler — result is still delivered', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'failed' });
    const executor = makeFakeExecutor({ executeRejects: true });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const deps = makeDeps(dbAdapter(db), executor, { runQueues, logger });

    const result = await handoverRunHandler(runId, 'take over', deps);

    expect(result).toEqual({ delivered: true });
    await waitForRedrive(runQueues, runId);
    expect(executor.execute).toHaveBeenCalledWith(runId);
    expect(logger.error).toHaveBeenCalledWith(
      '[handoverRun] execute() rejected after handover flip',
      expect.objectContaining({ runId }),
    );
    db.close();
  });

  it('a clearPendingGateItems rejection is fail-soft — the handover still delivers', async () => {
    const db = makeDb();
    const runQueues = new RunQueueRegistry();
    const { runId } = seedProgrammaticRun(db, { status: 'failed' });
    const executor = makeFakeExecutor();
    const clearPendingGateItems = vi
      .fn<(runId: string) => Promise<number>>()
      .mockRejectedValue(new Error('sweep boom'));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const deps = makeDeps(dbAdapter(db), executor, { runQueues, clearPendingGateItems, logger });

    const result = await handoverRunHandler(runId, 'take over', deps);

    expect(result).toEqual({ delivered: true });
    // The flip still landed and the conversation was still seeded.
    expect(getRow(db, runId)).toMatchObject({ status: 'starting', execution_model: 'orchestrated' });
    expect(executor.setPendingNudge).toHaveBeenCalledTimes(1);
    await waitForRedrive(runQueues, runId);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// composeHandoverPrompt (pure)
// ---------------------------------------------------------------------------

describe('composeHandoverPrompt', () => {
  it('lists a skipped step as remaining with the (previously skipped) marker, and omits done steps', () => {
    const out = composeHandoverPrompt({
      runId: 'run-1',
      workflowName: 'sprint',
      promptBody: 'BODY',
      steps: [
        { id: 'step-a', name: 'Step A' },
        { id: 'step-b', name: 'Step B' },
      ],
      stepResults: [
        { stepId: 'step-a', outcome: 'done' },
        { stepId: 'step-b', outcome: 'skipped' },
      ],
      reason: 'please change course',
    });

    // Extract just the Remaining-steps section.
    const remaining = out.slice(
      out.indexOf('## Remaining steps'),
      out.indexOf('## Workflow instructions'),
    );
    expect(remaining).toContain('- step-b — Step B (previously skipped)');
    // step-a is done → NOT listed as remaining.
    expect(remaining).not.toContain('step-a');
  });

  it('notes an unavailable prompt body when promptBody is null', () => {
    const out = composeHandoverPrompt({
      runId: 'run-1',
      workflowName: 'planner',
      promptBody: null,
      steps: [{ id: 'step-a', name: 'Step A' }],
      stepResults: [],
      reason: 'go',
    });
    expect(out).toContain('The workflow prompt body was unavailable');
    // Empty step-results renders the placeholder, not a stray blank line.
    expect(out).toContain('- (no steps recorded yet)');
  });

  it('renders the reason verbatim followed by the address-first directive', () => {
    const reason = 'The user wants to abandon step 3 and do X instead';
    const out = composeHandoverPrompt({
      runId: 'run-9',
      workflowName: 'ship',
      promptBody: 'BODY',
      steps: [],
      stepResults: [],
      reason,
    });
    expect(out).toContain(
      `## The user's request that triggered this handover\n\n${reason}\n\nAddress this request first, then continue the remaining workflow steps.`,
    );
    // Preamble names the run + workflow.
    expect(out).toContain('# Workflow handover');
    expect(out).toContain('run-9');
    expect(out).toContain('ship');
  });

  it('truncates an over-long completed-so-far line to ~200 chars with an ellipsis', () => {
    const longSummary = 'x'.repeat(300);
    const out = composeHandoverPrompt({
      runId: 'run-1',
      workflowName: 'sprint',
      promptBody: 'BODY',
      steps: [{ id: 'step-a', name: 'Step A' }],
      stepResults: [{ stepId: 'step-a', outcome: 'done', summary: longSummary }],
      reason: 'go',
    });
    const completedLine = out
      .split('\n')
      .find((line) => line.startsWith('- step-a: done'));
    expect(completedLine).toBeDefined();
    expect(completedLine!.length).toBeLessThanOrEqual(200);
    expect(completedLine!.endsWith('…')).toBe(true);
  });
});
