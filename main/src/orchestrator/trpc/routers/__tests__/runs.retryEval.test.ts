import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { TRPCError } from '@trpc/server';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import type { DatabaseLike } from '../../../types';

const evalWorkerMocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
}));

vi.mock('../../../eval/evalWorker', () => ({
  EvalWorker: {
    getInstance: () => ({ enqueue: evalWorkerMocks.enqueue }),
  },
}));

function createEvalDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE run_evals (
      run_id TEXT NOT NULL,
      rubric_version TEXT NOT NULL,
      eval_status TEXT NOT NULL,
      human_influenced INTEGER NOT NULL DEFAULT 0,
      snapshot_at TEXT NOT NULL DEFAULT '2026-07-01T00:00:00.000Z',
      error TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, rubric_version)
    );
  `);
  return db;
}

function seedEval(
  db: Database.Database,
  status: 'pending' | 'running' | 'complete' | 'failed',
  runId = 'run-1',
  opts: { rubricVersion?: string; humanInfluenced?: 0 | 1; snapshotAt?: string } = {},
): void {
  db.prepare(
    `INSERT INTO run_evals (run_id, rubric_version, eval_status, human_influenced, snapshot_at, error, updated_at)
     VALUES (?, ?, ?, ?, ?, 'judge failed', '2026-07-01T00:00:00.000Z')`,
  ).run(
    runId,
    opts.rubricVersion ?? '1.1',
    status,
    opts.humanInfluenced ?? 0,
    opts.snapshotAt ?? '2026-07-01T00:00:00.000Z',
  );
}

describe('cyboflow.runs.retryEval', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createEvalDb();
    evalWorkerMocks.enqueue.mockReset();
  });

  afterEach(() => {
    db.close();
  });

  it('moves a failed eval to pending, clears its error, and enqueues the original rubric', async () => {
    seedEval(db, 'failed');
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

    await caller.cyboflow.runs.retryEval({ runId: 'run-1' });

    const row = db
      .prepare('SELECT eval_status, error, updated_at FROM run_evals WHERE run_id = ?')
      .get('run-1') as { eval_status: string; error: string | null; updated_at: string };
    expect(row.eval_status).toBe('pending');
    expect(row.error).toBeNull();
    expect(row.updated_at).not.toBe('2026-07-01T00:00:00.000Z');
    expect(evalWorkerMocks.enqueue).toHaveBeenCalledTimes(1);
    expect(evalWorkerMocks.enqueue).toHaveBeenCalledWith('run-1', '1.1');
  });

  it('targets the SAME canonical row getRunEval displays on a multi-rubric run', async () => {
    // Canonical row (per insightsQueries.getRunEval's ORDER BY human_influenced
    // ASC, snapshot_at ASC): the pristine earliest snapshot — rubric 1.0 here.
    seedEval(db, 'failed', 'run-1', { rubricVersion: '1.0', humanInfluenced: 0, snapshotAt: '2026-07-01T00:00:00.000Z' });
    seedEval(db, 'failed', 'run-1', { rubricVersion: '1.1', humanInfluenced: 1, snapshotAt: '2026-07-02T00:00:00.000Z' });
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

    await caller.cyboflow.runs.retryEval({ runId: 'run-1' });

    // The displayed (canonical) row was updated + enqueued…
    const canonical = db
      .prepare("SELECT eval_status FROM run_evals WHERE run_id = 'run-1' AND rubric_version = '1.0'")
      .get() as { eval_status: string };
    expect(canonical.eval_status).toBe('pending');
    expect(evalWorkerMocks.enqueue).toHaveBeenCalledWith('run-1', '1.0');
    // …and the other rubric row was left untouched.
    const other = db
      .prepare("SELECT eval_status FROM run_evals WHERE run_id = 'run-1' AND rubric_version = '1.1'")
      .get() as { eval_status: string };
    expect(other.eval_status).toBe('failed');
  });

  it('throws NOT_FOUND and does not enqueue when the eval row is absent', async () => {
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

    await expect(caller.cyboflow.runs.retryEval({ runId: 'missing' })).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND',
    );
    expect(evalWorkerMocks.enqueue).not.toHaveBeenCalled();
  });

  it('rejects an empty run id before enqueueing an eval', async () => {
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

    await expect(caller.cyboflow.runs.retryEval({ runId: '' })).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST',
    );
    expect(evalWorkerMocks.enqueue).not.toHaveBeenCalled();
  });

  it.each(['pending', 'running', 'complete'] as const)(
    'throws PRECONDITION_FAILED and does not enqueue a %s eval',
    async (status) => {
      seedEval(db, status);
      const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

      await expect(caller.cyboflow.runs.retryEval({ runId: 'run-1' })).rejects.toSatisfy(
        (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
      );
      expect(evalWorkerMocks.enqueue).not.toHaveBeenCalled();
    },
  );

  it('does not enqueue when the guarded update loses a concurrent retry race', async () => {
    let updateSql: string | undefined;
    const raceDb: DatabaseLike = {
      prepare: (sql) => {
        if (sql.startsWith('UPDATE')) updateSql = sql;
        return {
          get: () =>
            sql.startsWith('SELECT')
              ? { eval_status: 'failed', rubric_version: '1.1' }
              : undefined,
          run: () => ({ changes: 0, lastInsertRowid: 0 }),
          all: () => [],
        };
      },
      transaction: <T>(fn: (...args: unknown[]) => T) => fn,
    };
    const caller = appRouter.createCaller(createContext({ db: raceDb }));

    await expect(caller.cyboflow.runs.retryEval({ runId: 'run-1' })).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
    expect(updateSql?.replace(/\s+/g, ' ')).toContain(
      "WHERE run_id = ? AND rubric_version = ? AND eval_status = 'failed'",
    );
    expect(evalWorkerMocks.enqueue).not.toHaveBeenCalled();
  });

  it('throws PRECONDITION_FAILED when the database is unavailable', async () => {
    const caller = appRouter.createCaller(createContext());

    await expect(caller.cyboflow.runs.retryEval({ runId: 'run-1' })).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
    expect(evalWorkerMocks.enqueue).not.toHaveBeenCalled();
  });
});
