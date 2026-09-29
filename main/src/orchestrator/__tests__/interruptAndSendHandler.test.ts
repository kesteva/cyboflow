/**
 * Unit tests for interruptAndSendHandler (TASK-301 — interrupt & send parity).
 *
 * Covers: the empty/not_found/terminal/interactive_unsupported/
 * programmatic_unsupported guards, the happy-path abort→queue-for-drain, the
 * "Interrupted" transcript marker, the idle no-op-interrupt-but-still-deliver
 * case (direct nudgeRunHandler path), the lane-scoping contract (constraint #3)
 * — a fan-out run's OTHER live lanes are never touched — and the abort-then-
 * redrive race (constraint #1): queueInput is called BEFORE abortRunSpawn so a
 * still-live `hasActiveExecution` at redrive time can never drop the message.
 *
 * Standalone: no electron / services imports. The DB is an in-memory SQLite via
 * createTestDb wrapped in the DatabaseLike adapter; the executor + queue are
 * lightweight fakes (mirrors nudgeRunHandler.test.ts's fixtures).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedRun } from '../__test_fixtures__/orchestratorTestDb';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { RunQueueRegistry } from '../RunQueueRegistry';
import { interruptAndSendHandler, type InterruptAndSendDeps } from '../interruptAndSendHandler';
import type { NudgeRunExecutorLike } from '../nudgeRunHandler';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFakeExecutor(opts?: { hasActiveExecution?: boolean }): NudgeRunExecutorLike & {
  setPendingNudge: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  queueInput: ReturnType<typeof vi.fn>;
} {
  const setPendingNudge = vi.fn<(runId: string, text: string) => void>();
  const execute = vi.fn<(runId: string) => Promise<void>>().mockResolvedValue(undefined);
  const queueInput = vi.fn<(runId: string, text: string) => void>();
  return {
    setPendingNudge,
    execute,
    queueInput,
    hasActiveExecution: () => opts?.hasActiveExecution ?? false,
  };
}

function makeDb(): Database.Database {
  // includeSubstrate layers BOTH `substrate` and `execution_model` (migrations
  // 013 + 031) — see orchestratorTestDb.ts's header note on that option.
  const db = createTestDb({ disableForeignKeys: true, includeSubstrate: true });
  db.exec('ALTER TABLE workflow_runs ADD COLUMN claude_session_id TEXT');
  return db;
}

function setSession(db: Database.Database, runId: string, sessionId: string | null): void {
  db.prepare('UPDATE workflow_runs SET claude_session_id = ? WHERE id = ?').run(sessionId, runId);
}

function setSubstrate(db: Database.Database, runId: string, substrate: 'sdk' | 'interactive'): void {
  db.prepare('UPDATE workflow_runs SET substrate = ? WHERE id = ?').run(substrate, runId);
}

function setExecutionModel(
  db: Database.Database,
  runId: string,
  executionModel: 'orchestrated' | 'programmatic',
): void {
  db.prepare('UPDATE workflow_runs SET execution_model = ? WHERE id = ?').run(executionModel, runId);
}

function readInterruptedMarkers(db: Database.Database, runId: string): unknown[] {
  return db
    .prepare(`SELECT payload_json FROM raw_events WHERE run_id = ? AND event_type = 'system'`)
    .all(runId)
    .map((r) => JSON.parse((r as { payload_json: string }).payload_json));
}

/** Build a deps bag; `live` is the fixed set of live spawn keys for the run. */
function makeDeps(
  db: Database.Database,
  runExecutor: NudgeRunExecutorLike,
  live: string[],
): InterruptAndSendDeps & {
  abortRunSpawn: ReturnType<typeof vi.fn>;
  listLiveSpawnKeys: ReturnType<typeof vi.fn>;
} {
  const abortRunSpawn = vi.fn<(spawnKey: string) => Promise<void>>().mockResolvedValue(undefined);
  const listLiveSpawnKeys = vi.fn<(runId: string) => string[]>().mockReturnValue(live);
  return {
    db: dbAdapter(db),
    runQueues: new RunQueueRegistry(),
    runExecutor,
    abortRunSpawn,
    listLiveSpawnKeys,
  };
}

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// Guard matrix
// ---------------------------------------------------------------------------

describe('interruptAndSendHandler — guard matrix', () => {
  it('empty text → { noOp: empty } (never touches abort or the queue)', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'running' });
    const executor = makeFakeExecutor();
    const deps = makeDeps(db, executor, [runId]);

    const result = await interruptAndSendHandler(runId, '   ', deps);

    expect(result).toEqual({ noOp: true, reason: 'empty' });
    expect(deps.abortRunSpawn).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
    db.close();
  });

  it('missing run → { noOp: not_found }', async () => {
    const db = makeDb();
    const deps = makeDeps(db, makeFakeExecutor(), []);
    const result = await interruptAndSendHandler('no-such-run', 'hi', deps);
    expect(result).toEqual({ noOp: true, reason: 'not_found' });
    db.close();
  });

  it('terminal status → { noOp: terminal } (never aborts)', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'completed' });
    const deps = makeDeps(db, makeFakeExecutor(), [runId]);
    const result = await interruptAndSendHandler(runId, 'hi', deps);
    expect(result).toEqual({ noOp: true, reason: 'terminal' });
    expect(deps.abortRunSpawn).not.toHaveBeenCalled();
    db.close();
  });

  it('interactive (PTY) substrate → { noOp: interactive_unsupported }, never aborts', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'running' });
    setSubstrate(db, runId, 'interactive');
    const deps = makeDeps(db, makeFakeExecutor(), [runId]);
    const result = await interruptAndSendHandler(runId, 'hi', deps);
    expect(result).toEqual({ noOp: true, reason: 'interactive_unsupported' });
    expect(deps.abortRunSpawn).not.toHaveBeenCalled();
    db.close();
  });

  it('programmatic (Sprint fan-out) run → { noOp: programmatic_unsupported }, never aborts (blocker 2a)', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'running' });
    setExecutionModel(db, runId, 'programmatic');
    // Even a live spawn key must not be touched — the guard fires BEFORE the
    // abort decision.
    const deps = makeDeps(db, makeFakeExecutor(), [runId]);

    const result = await interruptAndSendHandler(runId, 'stop the fan-out', deps);

    expect(result).toEqual({ noOp: true, reason: 'programmatic_unsupported' });
    expect(deps.abortRunSpawn).not.toHaveBeenCalled();
    expect(deps.listLiveSpawnKeys).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Happy path: LIVE spawn → queue-for-drain (blocker 1 fix), vs. idle → direct
// nudgeRunHandler redrive.
// ---------------------------------------------------------------------------

describe('interruptAndSendHandler — abort + queue-for-drain', () => {
  it('aborts the run-level spawn, buffers the text via queueInput BEFORE the abort, and records the "Interrupted" marker', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'running' });
    setSession(db, runId, 'sess-1');
    const executor = makeFakeExecutor({ hasActiveExecution: true });
    const deps = makeDeps(db, executor, [runId]);

    const order: string[] = [];
    executor.queueInput.mockImplementation(() => order.push('queueInput'));
    deps.abortRunSpawn.mockImplementation(async () => {
      order.push('abortRunSpawn');
    });

    const result = await interruptAndSendHandler(runId, 'stop and do this instead', deps);

    expect(executor.queueInput).toHaveBeenCalledWith(runId, 'stop and do this instead');
    expect(deps.abortRunSpawn).toHaveBeenCalledTimes(1);
    expect(deps.abortRunSpawn).toHaveBeenCalledWith(runId);
    // queueInput happens BEFORE the abort is requested (blocker 1's ordering fix).
    expect(order).toEqual(['queueInput', 'abortRunSpawn']);
    // This handler does NOT itself redrive — delivery is left to the aborted
    // turn's own drain seam (RunExecutor.drainQueuedInputAtRest), never a
    // second, direct nudge call here.
    expect(executor.setPendingNudge).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
    expect(result).toEqual({ delivered: true, interrupted: true });

    const markers = readInterruptedMarkers(db, runId);
    expect(markers).toEqual([{ type: 'system', subtype: 'assistant_interrupted' }]);
    db.close();
  });

  it('a genuine abort failure is fail-soft — the buffered text still awaits delivery at drain', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'running' });
    setSession(db, runId, 'sess-1');
    const executor = makeFakeExecutor({ hasActiveExecution: true });
    const deps = makeDeps(db, executor, [runId]);
    deps.abortRunSpawn.mockRejectedValueOnce(new Error('spawner unreachable'));

    const result = await interruptAndSendHandler(runId, 'still send this', deps);

    expect(result).toEqual({ delivered: true, interrupted: true });
    // queueInput ran regardless of the abort's outcome — the text is not lost.
    expect(executor.queueInput).toHaveBeenCalledWith(runId, 'still send this');
    db.close();
  });

  it('the abort-then-redrive race (blocker 1): a live spawn key still delivers even when hasActiveExecution NEVER flips false within this call', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'running' });
    setSession(db, runId, 'sess-1');
    // hasActiveExecution stays TRUE throughout — simulates the abort resolving
    // before RunExecutor.execute()'s aborted turn has reached its drained arm
    // (onLifecycleTransition('drained') -> teardownRun -> drainQueuedInputAtRest
    // has not run yet). Before the fix, a direct nudgeRunHandler call here would
    // see this and refuse `not_idle`, silently dropping the message.
    const executor = makeFakeExecutor({ hasActiveExecution: true });
    const deps = makeDeps(db, executor, [runId]);

    const result = await interruptAndSendHandler(runId, 'do not drop me', deps);

    // The text made it into the buffer — safe for the eventual real drain to
    // pick up, regardless of hasActiveExecution's timing.
    expect(executor.queueInput).toHaveBeenCalledWith(runId, 'do not drop me');
    expect(deps.abortRunSpawn).toHaveBeenCalledWith(runId);
    // Never the old failure mode: this call must not itself observe/return
    // `not_idle` — it never asks nudgeRunHandler (or hasActiveExecution) at all
    // for this branch.
    expect(result).toEqual({ delivered: true, interrupted: true });
    expect(result).not.toEqual({ noOp: true, reason: 'not_idle' });
    db.close();
  });

  it('idle run (nothing live) → interrupt is a no-op but the message still delivers via the direct nudgeRunHandler path', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'awaiting_review' });
    setSession(db, runId, 'sess-1');
    const executor = makeFakeExecutor();
    // Nothing live for this run at all.
    const deps = makeDeps(db, executor, []);

    const result = await interruptAndSendHandler(runId, 'nudge me instead', deps);

    expect(deps.abortRunSpawn).not.toHaveBeenCalled();
    // Nothing to drain later, so this DOES fall through to the direct nudge path.
    expect(executor.queueInput).not.toHaveBeenCalled();
    expect(executor.setPendingNudge).toHaveBeenCalledWith(runId, 'nudge me instead');
    expect(executor.execute).toHaveBeenCalledWith(runId);
    expect(result).toEqual({ delivered: true, interrupted: false });
    // No abort attempted → no "Interrupted" marker recorded.
    expect(readInterruptedMarkers(db, runId)).toEqual([]);
    db.close();
  });

  it('passes nudgeRunHandler noOp reasons straight through on the idle (nothing-live) path (e.g. no_session)', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'running' });
    // No claude_session_id captured, and nothing live → falls through to the
    // direct nudgeRunHandler path, which owns this guard.
    const executor = makeFakeExecutor({ hasActiveExecution: false });
    const deps = makeDeps(db, executor, []);

    const result = await interruptAndSendHandler(runId, 'hello', deps);

    expect(result).toEqual({ noOp: true, reason: 'no_session' });
    expect(deps.abortRunSpawn).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Lane scoping (constraint #3): never abort more than the ONE targeted spawn key
// ---------------------------------------------------------------------------

describe('interruptAndSendHandler — fan-out lane scoping', () => {
  it('defaults to the run-level spawn key and leaves every lane spawn untouched', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'running' });
    setSession(db, runId, 'sess-1');
    const executor = makeFakeExecutor({ hasActiveExecution: false });
    // A fan-out batch: the run-level key is NOT live, but two lanes are.
    const deps = makeDeps(db, executor, [`${runId}:task-a`, `${runId}:task-b`]);

    const result = await interruptAndSendHandler(runId, 'run-level message', deps);

    // No itemId supplied → only the run-level key is ever considered; it is not
    // live, so nothing is aborted — and critically, neither lane key is either.
    expect(deps.abortRunSpawn).not.toHaveBeenCalled();
    expect(result).toEqual({ delivered: true, interrupted: false });
    db.close();
  });

  it('itemId targets exactly ONE lane — the other live lane survives untouched', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'running' });
    setSession(db, runId, 'sess-1');
    const executor = makeFakeExecutor({ hasActiveExecution: false });
    const deps = makeDeps(db, executor, [`${runId}:task-a`, `${runId}:task-b`]);

    const result = await interruptAndSendHandler(runId, 'lane-a message', deps, { itemId: 'task-a' });

    expect(deps.abortRunSpawn).toHaveBeenCalledTimes(1);
    expect(deps.abortRunSpawn).toHaveBeenCalledWith(`${runId}:task-a`);
    // task-b's spawn key is NEVER passed to abortRunSpawn.
    expect(deps.abortRunSpawn).not.toHaveBeenCalledWith(`${runId}:task-b`);
    expect(result).toEqual({ delivered: true, interrupted: true });
    db.close();
  });

  it('itemId for a lane that is NOT live → interrupt no-op, message still delivers', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'running' });
    setSession(db, runId, 'sess-1');
    const executor = makeFakeExecutor({ hasActiveExecution: false });
    const deps = makeDeps(db, executor, [`${runId}:task-b`]);

    const result = await interruptAndSendHandler(runId, 'targeting an idle lane', deps, { itemId: 'task-a' });

    expect(deps.abortRunSpawn).not.toHaveBeenCalled();
    expect(result).toEqual({ delivered: true, interrupted: false });
    db.close();
  });
});
