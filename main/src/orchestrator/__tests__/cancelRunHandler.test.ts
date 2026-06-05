/**
 * Unit tests for the GIT-NEUTRAL cancelRunHandler (session<->run restructure,
 * Phase 4a).
 *
 * Verified contract:
 *   - terminal status        → noOp ('already_terminal'), stopLiveRun NOT called.
 *   - not found              → noOp ('not_found').
 *   - happy path            → clears approvals + questions, calls stopLiveRun once,
 *                              sets status='canceled' + outcome='canceled', emits
 *                              the run-status-changed signal, returns { success }.
 *   - stopLiveRun rejection  → DB write STILL applies (fail-soft) + returns success.
 *   - race (UPDATE changes=0) → noOp ('race').
 *   - GIT-NEUTRAL invariant   → the deps bag carries NO worktree/branch/merge
 *                              collaborator at all (structural assertion).
 *
 * Style mirrors cancelAndRestart.test.ts: real in-memory better-sqlite3 DB +
 * injected vi.fn() fakes, no tRPC wiring.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { RunQueueRegistry } from '../RunQueueRegistry';
import type { DatabaseLike } from '../types';
import { cancelRunHandler, type CancelRunDeps } from '../cancelRunHandler';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { createTestDb, seedRun } from '../__test_fixtures__/orchestratorTestDb';
import type { WorkflowRunStatus } from '../../../../shared/types/cyboflow';

// ---------------------------------------------------------------------------
// Spy helpers — order tracking
// ---------------------------------------------------------------------------

interface OrderSpy {
  calls: string[];
  clearPendingApprovalsForRun: ReturnType<typeof vi.fn>;
  clearPendingQuestionsForRun: ReturnType<typeof vi.fn>;
  stopLiveRun: ReturnType<typeof vi.fn>;
  emitRunStatusChanged: ReturnType<typeof vi.fn>;
}

function makeOrderSpy(): OrderSpy {
  const calls: string[] = [];
  return {
    calls,
    clearPendingApprovalsForRun: vi.fn((_runId: string) => {
      calls.push('clearPendingApprovalsForRun');
    }),
    clearPendingQuestionsForRun: vi.fn((_runId: string) => {
      calls.push('clearPendingQuestionsForRun');
    }),
    stopLiveRun: vi.fn(async (_runId: string) => {
      calls.push('stopLiveRun');
    }),
    emitRunStatusChanged: vi.fn((_runId: string, _status: 'canceled') => {
      calls.push('emitRunStatusChanged');
    }),
  };
}

function makeDeps(
  db: Database.Database,
  spy: OrderSpy,
  runQueues: RunQueueRegistry,
): CancelRunDeps {
  return {
    db: dbAdapter(db),
    runQueues,
    stopLiveRun: spy.stopLiveRun,
    clearPendingApprovalsForRun: spy.clearPendingApprovalsForRun,
    clearPendingQuestionsForRun: spy.clearPendingQuestionsForRun,
    emitRunStatusChanged: spy.emitRunStatusChanged,
  };
}

function getRun(db: Database.Database, runId: string): { status: string; outcome: string | null } {
  return db
    .prepare('SELECT status, outcome FROM workflow_runs WHERE id = ?')
    .get(runId) as { status: string; outcome: string | null };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cancelRunHandler (git-neutral run Cancel — Phase 4a)', () => {
  let db: Database.Database;
  let spy: OrderSpy;
  let runQueues: RunQueueRegistry;

  beforeEach(() => {
    // includeWorkflowRunTaskColumns adds the `outcome` column the handler stamps.
    db = createTestDb({ includeWorkflowRunTaskColumns: true });
    spy = makeOrderSpy();
    runQueues = new RunQueueRegistry();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // not_found
  // -------------------------------------------------------------------------

  it('returns noOp { reason: not_found } for an unknown run and never calls stopLiveRun', async () => {
    const result = await cancelRunHandler('no-such-run', makeDeps(db, spy, runQueues));

    expect(result).toEqual({ noOp: true, reason: 'not_found' });
    expect(spy.stopLiveRun).not.toHaveBeenCalled();
    expect(spy.clearPendingApprovalsForRun).not.toHaveBeenCalled();
    expect(spy.clearPendingQuestionsForRun).not.toHaveBeenCalled();
    expect(spy.emitRunStatusChanged).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // already_terminal (idempotent double-cancel)
  // -------------------------------------------------------------------------

  it.each<WorkflowRunStatus>(['canceled', 'failed', 'completed'])(
    'returns noOp { reason: already_terminal } for a %s run without calling stopLiveRun',
    async (status) => {
      const { runId } = seedRun(db, { status });

      const result = await cancelRunHandler(runId, makeDeps(db, spy, runQueues));

      expect(result).toEqual({ noOp: true, reason: 'already_terminal' });
      expect(spy.stopLiveRun).not.toHaveBeenCalled();
      expect(spy.clearPendingApprovalsForRun).not.toHaveBeenCalled();
      expect(spy.clearPendingQuestionsForRun).not.toHaveBeenCalled();
      expect(spy.emitRunStatusChanged).not.toHaveBeenCalled();
    },
  );

  // -------------------------------------------------------------------------
  // happy path
  // -------------------------------------------------------------------------

  it('happy path: clears approvals+questions, stops the live run once, sets canceled+outcome, emits changed', async () => {
    const { runId } = seedRun(db, { status: 'running' });

    const result = await cancelRunHandler(runId, makeDeps(db, spy, runQueues));

    expect(result).toEqual({ success: true });

    // Approvals + questions cleared BEFORE the kill.
    expect(spy.clearPendingApprovalsForRun).toHaveBeenCalledWith(runId);
    expect(spy.clearPendingQuestionsForRun).toHaveBeenCalledWith(runId);
    expect(spy.calls.indexOf('clearPendingApprovalsForRun')).toBeLessThan(spy.calls.indexOf('stopLiveRun'));
    expect(spy.calls.indexOf('clearPendingQuestionsForRun')).toBeLessThan(spy.calls.indexOf('stopLiveRun'));

    // Live run stopped exactly once with the runId.
    expect(spy.stopLiveRun).toHaveBeenCalledOnce();
    expect(spy.stopLiveRun).toHaveBeenCalledWith(runId);

    // DB: status='canceled' + outcome='canceled'.
    const row = getRun(db, runId);
    expect(row.status).toBe('canceled');
    expect(row.outcome).toBe('canceled');

    // Run-status-changed signal emitted AFTER the write.
    expect(spy.emitRunStatusChanged).toHaveBeenCalledWith(runId, 'canceled');
    expect(spy.calls.indexOf('stopLiveRun')).toBeLessThan(spy.calls.indexOf('emitRunStatusChanged'));
  });

  it.each<WorkflowRunStatus>(['queued', 'starting', 'running', 'awaiting_review', 'stuck'])(
    'cancels a run from non-terminal status %s',
    async (status) => {
      const { runId } = seedRun(db, { status });

      const result = await cancelRunHandler(runId, makeDeps(db, spy, runQueues));

      expect(result).toEqual({ success: true });
      expect(getRun(db, runId).status).toBe('canceled');
    },
  );

  it('does NOT clobber a pre-existing outcome (e.g. pr_open) — stamps canceled only when outcome IS NULL', async () => {
    const { runId } = seedRun(db, { status: 'awaiting_review' });
    db.prepare('UPDATE workflow_runs SET outcome = ? WHERE id = ?').run('pr_open', runId);

    const result = await cancelRunHandler(runId, makeDeps(db, spy, runQueues));

    expect(result).toEqual({ success: true });
    const row = getRun(db, runId);
    expect(row.status).toBe('canceled');
    expect(row.outcome).toBe('pr_open'); // preserved, not overwritten
  });

  // -------------------------------------------------------------------------
  // optional question clearer omitted
  // -------------------------------------------------------------------------

  it('works when clearPendingQuestionsForRun is omitted (optional dep)', async () => {
    const { runId } = seedRun(db, { status: 'running' });
    const deps: CancelRunDeps = {
      db: dbAdapter(db),
      runQueues,
      stopLiveRun: spy.stopLiveRun,
      clearPendingApprovalsForRun: spy.clearPendingApprovalsForRun,
      emitRunStatusChanged: spy.emitRunStatusChanged,
    };

    const result = await cancelRunHandler(runId, deps);

    expect(result).toEqual({ success: true });
    expect(getRun(db, runId).status).toBe('canceled');
  });

  // -------------------------------------------------------------------------
  // fail-soft: stopLiveRun rejection — DB write STILL applies
  // -------------------------------------------------------------------------

  it('still marks the run canceled when stopLiveRun rejects (fail-soft) and returns success', async () => {
    const { runId } = seedRun(db, { status: 'running' });

    const rejectingSpy = makeOrderSpy();
    rejectingSpy.stopLiveRun.mockRejectedValueOnce(new Error('PTY teardown failed'));

    const loggerErrors: Array<{ msg: string; ctx: Record<string, unknown> }> = [];
    const testLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn((msg: string, ctx?: Record<string, unknown>) => {
        loggerErrors.push({ msg, ctx: ctx ?? {} });
      }),
      debug: vi.fn(),
    };

    const deps: CancelRunDeps = {
      ...makeDeps(db, rejectingSpy, runQueues),
      logger: testLogger,
    };

    const result = await cancelRunHandler(runId, deps);

    expect(result).toEqual({ success: true });
    const row = getRun(db, runId);
    expect(row.status).toBe('canceled');
    expect(row.outcome).toBe('canceled');
    expect(rejectingSpy.emitRunStatusChanged).toHaveBeenCalledWith(runId, 'canceled');

    // The rejection was logged with the [cancelRun] prefix and runId.
    expect(loggerErrors.length).toBeGreaterThanOrEqual(1);
    expect(loggerErrors[0].msg).toContain('[cancelRun]');
    expect(loggerErrors[0].ctx['runId']).toBe(runId);
  });

  it('still cancels when stopLiveRun rejects and NO logger is provided', async () => {
    const { runId } = seedRun(db, { status: 'running' });
    const rejectingSpy = makeOrderSpy();
    rejectingSpy.stopLiveRun.mockRejectedValueOnce(new Error('no live process'));

    const result = await cancelRunHandler(runId, makeDeps(db, rejectingSpy, runQueues));

    expect(result).toEqual({ success: true });
    expect(getRun(db, runId).status).toBe('canceled');
  });

  // -------------------------------------------------------------------------
  // race: a concurrent terminal transition wins between guard and UPDATE
  // -------------------------------------------------------------------------

  it('returns noOp { reason: race } when the guarded UPDATE matches 0 rows', async () => {
    const { runId } = seedRun(db, { status: 'running' });

    // Wrap the real db but, on the guarded UPDATE, pre-cancel the run first so
    // the status-NOT-IN-terminal WHERE clause matches 0 rows.
    let intercepted = false;
    const racingDb: DatabaseLike = {
      prepare: (sql: string) => {
        const realStmt = db.prepare(sql);
        if (!intercepted && sql.includes("SET status = 'canceled'") && sql.includes('status NOT IN')) {
          intercepted = true;
          return {
            run: (...params: unknown[]) => {
              db.prepare(`UPDATE workflow_runs SET status = 'completed' WHERE id = ?`).run(runId);
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

    const result = await cancelRunHandler(runId, {
      db: racingDb,
      runQueues,
      stopLiveRun: spy.stopLiveRun,
      clearPendingApprovalsForRun: spy.clearPendingApprovalsForRun,
      clearPendingQuestionsForRun: spy.clearPendingQuestionsForRun,
      emitRunStatusChanged: spy.emitRunStatusChanged,
    });

    expect(result).toEqual({ noOp: true, reason: 'race' });
    // The race lost — no status-changed signal, and outcome was never stamped
    // 'canceled' (the concurrent write moved it to 'completed' with null outcome).
    expect(spy.emitRunStatusChanged).not.toHaveBeenCalled();
    const row = getRun(db, runId);
    expect(row.status).toBe('completed');
    expect(row.outcome).toBeNull();
  });

  // -------------------------------------------------------------------------
  // GIT-NEUTRAL invariant — the deps bag has NO git collaborator at all.
  // -------------------------------------------------------------------------

  it('GIT-NEUTRAL: the CancelRunDeps bag exposes no worktree/branch/merge collaborator', async () => {
    const { runId } = seedRun(db, { status: 'running' });
    const deps = makeDeps(db, spy, runQueues);

    await cancelRunHandler(runId, deps);

    // Structural assertion: none of the close-out (git-touching) collaborator
    // keys exist on the cancel deps bag — cancel can NEVER reach git.
    const keys = Object.keys(deps);
    for (const forbidden of [
      'worktreeManager',
      'removeWorktreeByPath',
      'deleteBranch',
      'squashAndMergeWorktreeToMain',
      'mergeWorktreeToMain',
      'gitPush',
      'taskStageDeriver',
      'assertNotSessionHosted',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    // The worktree row itself is untouched by cancel.
    const wt = db.prepare('SELECT worktree_path FROM workflow_runs WHERE id = ?').get(runId) as {
      worktree_path: string;
    };
    expect(wt.worktree_path).toBe('/tmp/test');
  });
});
