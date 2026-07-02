/**
 * B2 — cancelRunHandler.clearPendingHumanGatesForRun seam.
 *
 * cancelRunHandler.test.ts covers the core cancel contract (terminal/not-found
 * guards, stop-then-write ordering, fail-soft, race, batch close-out). This file
 * pins the OPTIONAL clearPendingHumanGatesForRun dep, which the base file never
 * wires: it must be called with the right runId, AFTER stopLiveRun resolves, and
 * AWAITED (a slow dep delays completion); omitting it must not break cancel.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { RunQueueRegistry } from '../RunQueueRegistry';
import { cancelRunHandler, type CancelRunDeps } from '../cancelRunHandler';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { createTestDb, seedRun } from '../__test_fixtures__/orchestratorTestDb';

function getStatus(db: Database.Database, runId: string): string {
  return (db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string }).status;
}

describe('cancelRunHandler — clearPendingHumanGatesForRun', () => {
  let db: Database.Database;
  let runQueues: RunQueueRegistry;
  const calls: string[] = [];

  beforeEach(() => {
    db = createTestDb({ includeWorkflowRunTaskColumns: true });
    runQueues = new RunQueueRegistry();
    calls.length = 0;
    vi.clearAllMocks();
  });

  function baseDeps(overrides: Partial<CancelRunDeps> = {}): CancelRunDeps {
    return {
      db: dbAdapter(db),
      runQueues,
      stopLiveRun: vi.fn(async () => {
        calls.push('stopLiveRun');
      }),
      clearPendingApprovalsForRun: vi.fn(() => {
        calls.push('clearPendingApprovalsForRun');
      }),
      emitRunStatusChanged: vi.fn(() => {
        calls.push('emitRunStatusChanged');
      }),
      ...overrides,
    };
  }

  it('calls clearPendingHumanGatesForRun with the runId AFTER stopLiveRun resolves', async () => {
    const { runId } = seedRun(db, { status: 'running' });
    const clearPendingHumanGatesForRun = vi.fn(async (id: string) => {
      calls.push(`clearGates:${id}`);
    });

    const result = await cancelRunHandler(runId, baseDeps({ clearPendingHumanGatesForRun }));

    expect(result).toEqual({ success: true });
    expect(clearPendingHumanGatesForRun).toHaveBeenCalledTimes(1);
    expect(clearPendingHumanGatesForRun).toHaveBeenCalledWith(runId);
    // Ordering: the gate dismissal runs strictly AFTER the kill (the in-memory
    // gate Promise is settled by the abort, so this is pure DB/queue cleanup).
    expect(calls.indexOf('stopLiveRun')).toBeLessThan(calls.indexOf(`clearGates:${runId}`));
  });

  it('AWAITS the gate clearer — a slow dep delays handler completion', async () => {
    const { runId } = seedRun(db, { status: 'running' });
    let released = false;
    let resolveGate!: () => void;
    const gatePromise = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    const clearPendingHumanGatesForRun = vi.fn(() =>
      gatePromise.then(() => {
        released = true;
      }),
    );

    const handlerPromise = cancelRunHandler(runId, baseDeps({ clearPendingHumanGatesForRun }));

    // Give the microtask/queue chain a tick — the handler must still be pending
    // because it is awaiting the (unresolved) gate clearer.
    await Promise.resolve();
    await Promise.resolve();
    expect(released).toBe(false);

    resolveGate();
    const result = await handlerPromise;
    expect(result).toEqual({ success: true });
    expect(released).toBe(true);
  });

  it('fail-soft: a throwing gate clearer never blocks the cancel (run still canceled)', async () => {
    const { runId } = seedRun(db, { status: 'running' });
    const clearPendingHumanGatesForRun = vi.fn(async () => {
      throw new Error('gate cleanup exploded');
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const result = await cancelRunHandler(runId, baseDeps({ clearPendingHumanGatesForRun, logger }));

    expect(result).toEqual({ success: true });
    expect(getStatus(db, runId)).toBe('canceled');
    expect(logger.error).toHaveBeenCalled();
  });

  it('omitting the gate clearer does not throw and cancel still completes', async () => {
    const { runId } = seedRun(db, { status: 'running' });
    // No clearPendingHumanGatesForRun on the deps bag (optional dep).
    const result = await cancelRunHandler(runId, baseDeps());
    expect(result).toEqual({ success: true });
    expect(getStatus(db, runId)).toBe('canceled');
  });

  it('is NOT called when cancel no-ops on an already-terminal run', async () => {
    const { runId } = seedRun(db, { status: 'canceled' });
    const clearPendingHumanGatesForRun = vi.fn(async () => {});

    const result = await cancelRunHandler(runId, baseDeps({ clearPendingHumanGatesForRun }));

    expect(result).toEqual({ noOp: true, reason: 'already_terminal' });
    expect(clearPendingHumanGatesForRun).not.toHaveBeenCalled();
  });
});
