/**
 * Unit tests for the SDK-ONLY reopenRunHandler (session reopen-on-timeout follow-up).
 *
 * Covers the guard matrix (empty / not_found / interactive_unsupported /
 * not_failed / no_session / race), the happy-path delivery (status flips failed ->
 * running, failure stamp cleared, setPendingNudge + execute fire, run-status
 * emitted), the execute_failed fallback, and the queue-split contract. Style
 * mirrors resumeRunHandler.test.ts / nudgeRunHandler.test.ts.
 *
 * Standalone: no electron / services imports. In-memory SQLite via createTestDb
 * wrapped in DatabaseLike; the executor + queue are lightweight fakes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedRun } from '../__test_fixtures__/orchestratorTestDb';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { RunQueueRegistry } from '../RunQueueRegistry';
import { reopenRunHandler, type ReopenRunExecutorLike, type ReopenRunDeps } from '../reopenRunHandler';
import type { DatabaseLike, PreparedStatement } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fake executor that records setPendingNudge + execute calls. */
function makeFakeExecutor(opts?: { executeRejects?: boolean }): ReopenRunExecutorLike & {
  setPendingNudge: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
} {
  const setPendingNudge = vi.fn<(runId: string, text: string) => void>();
  const execute = vi.fn<(runId: string) => Promise<void>>().mockImplementation(async () => {
    if (opts?.executeRejects) throw new Error('boom');
  });
  return { setPendingNudge, execute };
}

/** Build a test DB with `substrate` + `claude_session_id` columns (the handler SELECTs both). */
function makeDb(): Database.Database {
  return createTestDb({ includeSubstrate: true, includeWorkflowRunTaskColumns: true });
}

function setSubstrate(db: Database.Database, runId: string, substrate: 'sdk' | 'interactive'): void {
  db.prepare('UPDATE workflow_runs SET substrate = ? WHERE id = ?').run(substrate, runId);
}

function setSession(db: Database.Database, runId: string, sessionId: string | null): void {
  db.prepare('UPDATE workflow_runs SET claude_session_id = ? WHERE id = ?').run(sessionId, runId);
}

/** Seed a failed sdk run with a captured session + a failure stamp. */
function seedFailedRun(db: Database.Database): string {
  const { runId } = seedRun(db, { status: 'failed' });
  setSubstrate(db, runId, 'sdk');
  setSession(db, runId, 'sess-1');
  db.prepare("UPDATE workflow_runs SET error_message = 'boom', ended_at = '2026-06-23T00:00:00Z' WHERE id = ?").run(runId);
  return runId;
}

/** Build deps with an emit spy + the given executor. */
function makeDeps(
  db: DatabaseLike,
  executor: ReopenRunExecutorLike,
  runQueues = new RunQueueRegistry(),
): ReopenRunDeps & { emitRunStatusChanged: ReturnType<typeof vi.fn> } {
  const emitRunStatusChanged = vi.fn<(runId: string, status: 'running') => void>();
  return { db, runQueues, runExecutor: executor, emitRunStatusChanged };
}

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// Guard matrix
// ---------------------------------------------------------------------------

describe('reopenRunHandler — guard matrix', () => {
  it('blank text → { noOp: empty } (no DB touch)', async () => {
    const db = makeDb();
    const runId = seedFailedRun(db);
    const executor = makeFakeExecutor();

    const result = await reopenRunHandler(runId, '   ', makeDeps(dbAdapter(db), executor));

    expect(result).toEqual({ noOp: true, reason: 'empty' });
    expect(executor.execute).not.toHaveBeenCalled();
    expect((db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string }).status).toBe('failed');
    db.close();
  });

  it('missing run → { noOp: not_found }', async () => {
    const db = makeDb();
    const executor = makeFakeExecutor();
    const result = await reopenRunHandler('no-such-run', 'go', makeDeps(dbAdapter(db), executor));
    expect(result).toEqual({ noOp: true, reason: 'not_found' });
    expect(executor.execute).not.toHaveBeenCalled();
    db.close();
  });

  it('interactive substrate → { noOp: interactive_unsupported }', async () => {
    const db = makeDb();
    const runId = seedFailedRun(db);
    setSubstrate(db, runId, 'interactive');
    const executor = makeFakeExecutor();

    const result = await reopenRunHandler(runId, 'go', makeDeps(dbAdapter(db), executor));

    expect(result).toEqual({ noOp: true, reason: 'interactive_unsupported' });
    expect(executor.execute).not.toHaveBeenCalled();
    expect((db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string }).status).toBe('failed');
    db.close();
  });

  it('non-failed status (awaiting_review) → { noOp: not_failed }', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'awaiting_review' });
    setSubstrate(db, runId, 'sdk');
    setSession(db, runId, 'sess-1');
    const executor = makeFakeExecutor();

    const result = await reopenRunHandler(runId, 'go', makeDeps(dbAdapter(db), executor));

    expect(result).toEqual({ noOp: true, reason: 'not_failed' });
    expect(executor.execute).not.toHaveBeenCalled();
    db.close();
  });

  it('no captured claude_session_id → { noOp: no_session }', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'failed' });
    setSubstrate(db, runId, 'sdk');
    // claude_session_id stays NULL.
    const executor = makeFakeExecutor();

    const result = await reopenRunHandler(runId, 'go', makeDeps(dbAdapter(db), executor));

    expect(result).toEqual({ noOp: true, reason: 'no_session' });
    expect(executor.execute).not.toHaveBeenCalled();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Happy path + race + execute failure
// ---------------------------------------------------------------------------

describe('reopenRunHandler — delivery', () => {
  it('happy path → flips failed to running, clears failure stamp, marks nudge, calls execute, emits, delivered', async () => {
    const db = makeDb();
    const runId = seedFailedRun(db);
    const executor = makeFakeExecutor();
    const deps = makeDeps(dbAdapter(db), executor);

    const result = await reopenRunHandler(runId, 'pick it back up', deps);

    expect(result).toEqual({ delivered: true });
    const row = db
      .prepare('SELECT status, error_message, ended_at FROM workflow_runs WHERE id = ?')
      .get(runId) as { status: string; error_message: string | null; ended_at: string | null };
    expect(row.status).toBe('running');
    expect(row.error_message).toBeNull();
    expect(row.ended_at).toBeNull();
    expect(executor.setPendingNudge).toHaveBeenCalledWith(runId, 'pick it back up');
    expect(executor.execute).toHaveBeenCalledWith(runId);
    expect(deps.emitRunStatusChanged).toHaveBeenCalledWith(runId, 'running');
    db.close();
  });

  it('queue-split: setPendingNudge + execute run OUTSIDE the held per-run PQueue', async () => {
    const db = makeDb();
    const runId = seedFailedRun(db);

    const runQueues = new RunQueueRegistry();
    let queueIdleDuringExecute = false;
    const executor = makeFakeExecutor();
    executor.execute.mockImplementation(async () => {
      const q = runQueues.getOrCreate(runId);
      queueIdleDuringExecute = q.size === 0 && q.pending === 0;
    });

    const result = await reopenRunHandler(runId, 'go', makeDeps(dbAdapter(db), executor, runQueues));

    expect(result).toEqual({ delivered: true });
    expect(queueIdleDuringExecute).toBe(true);
    db.close();
  });

  it('race: guard SELECT sees failed but the guarded UPDATE matches 0 rows → { noOp: race }', async () => {
    // The run is ACTUALLY 'canceled' (so the guarded `WHERE status='failed'` UPDATE
    // changes 0 rows), but the guard SELECT is made to observe 'failed'.
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
            get: () => ({ status: 'failed', substrate: 'sdk', claude_session_id: 'sess-1' }),
            all: (...params: unknown[]) => stmt.all(...params),
          };
        }
        return stmt;
      },
      transaction: real.transaction.bind(real),
    };

    const executor = makeFakeExecutor();
    const deps = makeDeps(adapter, executor);
    const result = await reopenRunHandler(runId, 'go', deps);

    expect(result).toEqual({ noOp: true, reason: 'race' });
    expect(executor.execute).not.toHaveBeenCalled();
    expect(deps.emitRunStatusChanged).not.toHaveBeenCalled();
    db.close();
  });

  it('execute() rejection after the flip → { noOp: execute_failed }', async () => {
    const db = makeDb();
    const runId = seedFailedRun(db);
    const executor = makeFakeExecutor({ executeRejects: true });

    const result = await reopenRunHandler(runId, 'go', makeDeps(dbAdapter(db), executor));

    expect(result).toEqual({ noOp: true, reason: 'execute_failed' });
    // The run was still flipped to running (the executor owns the terminal state).
    const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('running');
    db.close();
  });
});
