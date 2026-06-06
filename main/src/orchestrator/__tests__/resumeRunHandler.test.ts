/**
 * Unit tests for the SDK-ONLY resumeRunHandler (session<->run restructure, Phase 4b).
 *
 * Covers the full guard matrix (not_found / interactive_unsupported / not_paused /
 * no_session / race) plus the happy-path delivery (status flips paused -> running,
 * setPendingResume + execute fire, run-status-changed emitted) and the
 * execute_failed fallback. A dedicated test pins the queue-split contract:
 * setPendingResume + execute run OUTSIDE the held per-run PQueue (mirrors
 * nudgeRunHandler so execute()'s re-entrant lifecycle transitions don't deadlock).
 *
 * Standalone: no electron / services imports. The DB is an in-memory SQLite via
 * createTestDb wrapped in the DatabaseLike adapter; the executor + queue are
 * lightweight fakes. Style mirrors nudgeRunHandler.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedRun } from '../__test_fixtures__/orchestratorTestDb';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { RunQueueRegistry } from '../RunQueueRegistry';
import { resumeRunHandler, type ResumeRunExecutorLike, type ResumeRunDeps } from '../resumeRunHandler';
import type { DatabaseLike, PreparedStatement } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fake executor that records setPendingResume + execute calls. */
function makeFakeExecutor(opts?: { executeRejects?: boolean }): ResumeRunExecutorLike & {
  setPendingResume: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
} {
  const setPendingResume = vi.fn<(runId: string) => void>();
  const execute = vi.fn<(runId: string) => Promise<void>>().mockImplementation(async () => {
    if (opts?.executeRejects) throw new Error('boom');
  });
  return { setPendingResume, execute };
}

/**
 * Build a test DB with `substrate` + `claude_session_id` columns layered on (the
 * handler SELECTs both). includeSubstrate adds `substrate`;
 * includeWorkflowRunTaskColumns adds `claude_session_id`.
 */
function makeDb(): Database.Database {
  return createTestDb({ includeSubstrate: true, includeWorkflowRunTaskColumns: true });
}

function setSubstrate(db: Database.Database, runId: string, substrate: 'sdk' | 'interactive'): void {
  db.prepare('UPDATE workflow_runs SET substrate = ? WHERE id = ?').run(substrate, runId);
}

function setSession(db: Database.Database, runId: string, sessionId: string | null): void {
  db.prepare('UPDATE workflow_runs SET claude_session_id = ? WHERE id = ?').run(sessionId, runId);
}

/** Build deps with an emit spy + the given executor. */
function makeDeps(
  db: DatabaseLike,
  executor: ResumeRunExecutorLike,
  runQueues = new RunQueueRegistry(),
): ResumeRunDeps & { emitRunStatusChanged: ReturnType<typeof vi.fn> } {
  const emitRunStatusChanged = vi.fn<(runId: string, status: 'running') => void>();
  return { db, runQueues, runExecutor: executor, emitRunStatusChanged };
}

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// Guard matrix
// ---------------------------------------------------------------------------

describe('resumeRunHandler — guard matrix', () => {
  it('missing run → { noOp: not_found }', async () => {
    const db = makeDb();
    const executor = makeFakeExecutor();
    const result = await resumeRunHandler('no-such-run', makeDeps(dbAdapter(db), executor));
    expect(result).toEqual({ noOp: true, reason: 'not_found' });
    expect(executor.setPendingResume).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
    db.close();
  });

  it('interactive substrate → { noOp: interactive_unsupported }', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'paused' });
    setSubstrate(db, runId, 'interactive');
    setSession(db, runId, 'sess-1');
    const executor = makeFakeExecutor();

    const result = await resumeRunHandler(runId, makeDeps(dbAdapter(db), executor));

    expect(result).toEqual({ noOp: true, reason: 'interactive_unsupported' });
    expect(executor.execute).not.toHaveBeenCalled();
    // The run stays paused — interactive runs are never resumed by this handler.
    expect((db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string }).status).toBe('paused');
    db.close();
  });

  it('non-paused status (running) → { noOp: not_paused }', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'running' });
    setSubstrate(db, runId, 'sdk');
    setSession(db, runId, 'sess-1');
    const executor = makeFakeExecutor();

    const result = await resumeRunHandler(runId, makeDeps(dbAdapter(db), executor));

    expect(result).toEqual({ noOp: true, reason: 'not_paused' });
    expect(executor.execute).not.toHaveBeenCalled();
    db.close();
  });

  it('no captured claude_session_id → { noOp: no_session }', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'paused' });
    setSubstrate(db, runId, 'sdk');
    // claude_session_id stays NULL.
    const executor = makeFakeExecutor();

    const result = await resumeRunHandler(runId, makeDeps(dbAdapter(db), executor));

    expect(result).toEqual({ noOp: true, reason: 'no_session' });
    expect(executor.execute).not.toHaveBeenCalled();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Happy path + race + execute failure
// ---------------------------------------------------------------------------

describe('resumeRunHandler — delivery', () => {
  it('happy path → flips paused to running, marks resume, calls execute, emits, returns delivered', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'paused' });
    setSubstrate(db, runId, 'sdk');
    setSession(db, runId, 'sess-1');
    const executor = makeFakeExecutor();
    const deps = makeDeps(dbAdapter(db), executor);

    const result = await resumeRunHandler(runId, deps);

    expect(result).toEqual({ delivered: true });
    // Status was flipped to running by the guarded UPDATE.
    const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('running');
    // Resume was marked (no human text) and execute() fired with the runId.
    expect(executor.setPendingResume).toHaveBeenCalledWith(runId);
    expect(executor.execute).toHaveBeenCalledWith(runId);
    // The status-changed signal was emitted with 'running'.
    expect(deps.emitRunStatusChanged).toHaveBeenCalledWith(runId, 'running');
    db.close();
  });

  it('queue-split: setPendingResume + execute run OUTSIDE the held per-run PQueue', async () => {
    // If setPendingResume/execute ran INSIDE the per-run queue, a fresh task added
    // to the SAME queue during execute() would deadlock (no-recursive-enqueue). We
    // assert the opposite: by the time execute() runs, the per-run queue is idle
    // (size 0, pending 0) — proving the guard task already released it.
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'paused' });
    setSubstrate(db, runId, 'sdk');
    setSession(db, runId, 'sess-1');

    const runQueues = new RunQueueRegistry();
    let queueIdleDuringExecute = false;
    const executor = makeFakeExecutor();
    executor.execute.mockImplementation(async () => {
      const q = runQueues.getOrCreate(runId);
      queueIdleDuringExecute = q.size === 0 && q.pending === 0;
    });

    const result = await resumeRunHandler(runId, makeDeps(dbAdapter(db), executor, runQueues));

    expect(result).toEqual({ delivered: true });
    expect(queueIdleDuringExecute).toBe(true);
    db.close();
  });

  it('race: guard SELECT sees paused but the guarded UPDATE matches 0 rows → { noOp: race }', async () => {
    // Simulate the concurrency window: the run is ACTUALLY 'canceled' (so the
    // guarded `WHERE status='paused'` UPDATE changes 0 rows), but the guard SELECT
    // is made to observe 'paused' (as if a concurrent transition moved the row
    // between the SELECT and the UPDATE).
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'canceled' });
    setSubstrate(db, runId, 'sdk');
    setSession(db, runId, 'sess-1');

    const real = dbAdapter(db);
    const adapter: DatabaseLike = {
      prepare: (sql: string): PreparedStatement => {
        const stmt = real.prepare(sql);
        if (sql.includes('SELECT status, substrate, claude_session_id')) {
          return {
            run: (...params: unknown[]) => stmt.run(...params),
            get: () => ({ status: 'paused', substrate: 'sdk', claude_session_id: 'sess-1' }),
            all: (...params: unknown[]) => stmt.all(...params),
          };
        }
        return stmt;
      },
      transaction: real.transaction.bind(real),
    };

    const executor = makeFakeExecutor();
    const deps = makeDeps(adapter, executor);
    const result = await resumeRunHandler(runId, deps);

    expect(result).toEqual({ noOp: true, reason: 'race' });
    expect(executor.execute).not.toHaveBeenCalled();
    expect(deps.emitRunStatusChanged).not.toHaveBeenCalled();
    db.close();
  });

  it('execute() rejection after the flip → { noOp: execute_failed }', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'paused' });
    setSubstrate(db, runId, 'sdk');
    setSession(db, runId, 'sess-1');
    const executor = makeFakeExecutor({ executeRejects: true });

    const result = await resumeRunHandler(runId, makeDeps(dbAdapter(db), executor));

    expect(result).toEqual({ noOp: true, reason: 'execute_failed' });
    // The run was still flipped to running (the executor owns the terminal state).
    const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('running');
    db.close();
  });
});
