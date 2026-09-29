/**
 * Router-level tests for cyboflow.runs.interruptAndSend (TASK-301).
 *
 * Handler-level behavior (guard matrix, abort-then-redrive, the "Interrupted"
 * marker, lane scoping) is covered in
 * main/src/orchestrator/__tests__/interruptAndSendHandler.test.ts. These tests
 * cover the procedure's own thin wiring: the METHOD_NOT_SUPPORTED guard before
 * setInterruptAndSendDeps() is called, input validation (itemId passthrough),
 * and delegation to the real handler via a live in-memory DB.
 *
 * Kept in its OWN file (mirrors the codebase's convention for module-singleton
 * dep-bag tests, e.g. stuckDetectorParkedNoGate.test.ts) so the "deps not wired"
 * assertion — which depends on setInterruptAndSendDeps() never having been
 * called in this file's module instance — cannot be polluted by another test
 * file's wiring call (vitest gives each test FILE its own module registry).
 */
import { describe, it, expect, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import { createTestDb, seedRun } from '../../../__test_fixtures__/orchestratorTestDb';
import { RunQueueRegistry } from '../../../RunQueueRegistry';
import { setInterruptAndSendDeps } from '../runs';
import type { NudgeRunExecutorLike } from '../../../nudgeRunHandler';

function makeDb() {
  const db = createTestDb({ disableForeignKeys: true, includeSubstrate: true });
  db.exec('ALTER TABLE workflow_runs ADD COLUMN claude_session_id TEXT');
  return db;
}

describe('cyboflow.runs.interruptAndSend — deps-not-wired guard', () => {
  it('throws METHOD_NOT_SUPPORTED before setInterruptAndSendDeps() is ever called', async () => {
    const db = makeDb();
    try {
      const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
      await expect(
        caller.cyboflow.runs.interruptAndSend({ runId: 'run-x', text: 'hi' }),
      ).rejects.toThrow(TRPCError);
    } finally {
      db.close();
    }
  });
});

describe('cyboflow.runs.interruptAndSend — wired', () => {
  it('aborts the live run-level spawn and buffers the text via queueInput for the drain seam', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'running' });
    db.prepare('UPDATE workflow_runs SET claude_session_id = ? WHERE id = ?').run('sess-1', runId);

    const setPendingNudge = vi.fn<(runId: string, text: string) => void>();
    const execute = vi.fn<(runId: string) => Promise<void>>().mockResolvedValue(undefined);
    const queueInput = vi.fn<(runId: string, text: string) => void>();
    const runExecutor: NudgeRunExecutorLike = {
      setPendingNudge,
      execute,
      queueInput,
      hasActiveExecution: () => true,
    };
    const abortRunSpawn = vi.fn<(spawnKey: string) => Promise<void>>().mockResolvedValue(undefined);

    setInterruptAndSendDeps({
      db: dbAdapter(db),
      runQueues: new RunQueueRegistry(),
      runExecutor,
      abortRunSpawn,
      listLiveSpawnKeys: () => [runId],
    });

    try {
      const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
      const result = await caller.cyboflow.runs.interruptAndSend({ runId, text: 'stop and do this' });

      expect(result).toEqual({ delivered: true, interrupted: true });
      expect(queueInput).toHaveBeenCalledWith(runId, 'stop and do this');
      expect(abortRunSpawn).toHaveBeenCalledWith(runId);
      // Delivery is left to the aborted turn's own drain seam, not a direct
      // redrive from this mutation (blocker 1's fix).
      expect(setPendingNudge).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('threads itemId to target one lane spawn key, not the run-level one', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'running' });
    db.prepare('UPDATE workflow_runs SET claude_session_id = ? WHERE id = ?').run('sess-1', runId);

    const runExecutor: NudgeRunExecutorLike = {
      setPendingNudge: vi.fn(),
      execute: vi.fn().mockResolvedValue(undefined),
      queueInput: vi.fn(),
      hasActiveExecution: () => true,
    };
    const abortRunSpawn = vi.fn<(spawnKey: string) => Promise<void>>().mockResolvedValue(undefined);

    setInterruptAndSendDeps({
      db: dbAdapter(db),
      runQueues: new RunQueueRegistry(),
      runExecutor,
      abortRunSpawn,
      listLiveSpawnKeys: () => [`${runId}:task-a`, `${runId}:task-b`],
    });

    try {
      const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
      const result = await caller.cyboflow.runs.interruptAndSend({
        runId,
        text: 'lane message',
        itemId: 'task-a',
      });

      expect(result).toEqual({ delivered: true, interrupted: true });
      expect(abortRunSpawn).toHaveBeenCalledTimes(1);
      expect(abortRunSpawn).toHaveBeenCalledWith(`${runId}:task-a`);
      expect(abortRunSpawn).not.toHaveBeenCalledWith(`${runId}:task-b`);
      expect(abortRunSpawn).not.toHaveBeenCalledWith(runId);
    } finally {
      db.close();
    }
  });

  it('refuses a PROGRAMMATIC (Sprint fan-out) run with programmatic_unsupported, never aborting', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'running' });
    db.prepare('UPDATE workflow_runs SET claude_session_id = ? WHERE id = ?').run('sess-1', runId);
    db.prepare('UPDATE workflow_runs SET execution_model = ? WHERE id = ?').run('programmatic', runId);

    const abortRunSpawn = vi.fn<(spawnKey: string) => Promise<void>>().mockResolvedValue(undefined);
    setInterruptAndSendDeps({
      db: dbAdapter(db),
      runQueues: new RunQueueRegistry(),
      runExecutor: {
        setPendingNudge: vi.fn(),
        execute: vi.fn().mockResolvedValue(undefined),
        queueInput: vi.fn(),
        hasActiveExecution: () => true,
      },
      abortRunSpawn,
      listLiveSpawnKeys: () => [runId],
    });

    try {
      const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));
      const result = await caller.cyboflow.runs.interruptAndSend({ runId, text: 'stop the fan-out' });

      expect(result).toEqual({ noOp: true, reason: 'programmatic_unsupported' });
      expect(abortRunSpawn).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
