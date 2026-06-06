/**
 * Unit tests for the SDK-ONLY pauseRunHandler (session<->run restructure, Phase 4b).
 *
 * Verified contract:
 *   - not found                  → noOp ('not_found'), stopLiveRun NOT called.
 *   - interactive substrate      → noOp ('interactive_unsupported'), NO kill / NO write.
 *   - non-pausable status        → noOp ('not_pausable'), NO kill / NO write.
 *   - null claude_session_id     → noOp ('no_session'), NO kill / NO write.
 *   - happy path (running)        → clears approvals + questions, aborts the SDK turn
 *                                   once, sets status='paused', PRESERVES
 *                                   claude_session_id / current_step_id / ended_at,
 *                                   emits the run-status-changed signal, returns success.
 *   - happy path (awaiting_review)→ same; pause is valid from an idle rest too.
 *   - stopLiveRun rejection       → DB write STILL applies (fail-soft) + returns success.
 *   - race (UPDATE changes=0)     → noOp ('race').
 *   - GIT-NEUTRAL invariant       → the deps bag carries NO worktree/branch/merge
 *                                   collaborator at all (structural assertion).
 *
 * Style mirrors cancelRunHandler.test.ts: real in-memory better-sqlite3 DB +
 * injected vi.fn() fakes, no tRPC wiring.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { RunQueueRegistry } from '../RunQueueRegistry';
import type { DatabaseLike } from '../types';
import { pauseRunHandler, type PauseRunDeps } from '../pauseRunHandler';
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
    emitRunStatusChanged: vi.fn((_runId: string, _status: 'paused') => {
      calls.push('emitRunStatusChanged');
    }),
  };
}

function makeDeps(
  db: Database.Database,
  spy: OrderSpy,
  runQueues: RunQueueRegistry,
): PauseRunDeps {
  return {
    db: dbAdapter(db),
    runQueues,
    stopLiveRun: spy.stopLiveRun,
    clearPendingApprovalsForRun: spy.clearPendingApprovalsForRun,
    clearPendingQuestionsForRun: spy.clearPendingQuestionsForRun,
    emitRunStatusChanged: spy.emitRunStatusChanged,
  };
}

/**
 * Build a test DB with `substrate` + `claude_session_id` + `current_step_id`
 * columns layered on (the handler SELECTs substrate + claude_session_id; the
 * preservation assertions read current_step_id).
 */
function makeDb(): Database.Database {
  // includeSubstrate adds `substrate` (+ session_id); includeWorkflowRunTaskColumns
  // adds `current_step_id` + `claude_session_id` (+ outcome, etc.).
  return createTestDb({ includeSubstrate: true, includeWorkflowRunTaskColumns: true });
}

/** Stamp a run's substrate (defaults to 'sdk' from the column DEFAULT otherwise). */
function setSubstrate(db: Database.Database, runId: string, substrate: 'sdk' | 'interactive'): void {
  db.prepare('UPDATE workflow_runs SET substrate = ? WHERE id = ?').run(substrate, runId);
}

function setSession(db: Database.Database, runId: string, sessionId: string | null): void {
  db.prepare('UPDATE workflow_runs SET claude_session_id = ? WHERE id = ?').run(sessionId, runId);
}

function getRun(
  db: Database.Database,
  runId: string,
): { status: string; ended_at: string | null; claude_session_id: string | null; current_step_id: string | null } {
  return db
    .prepare('SELECT status, ended_at, claude_session_id, current_step_id FROM workflow_runs WHERE id = ?')
    .get(runId) as { status: string; ended_at: string | null; claude_session_id: string | null; current_step_id: string | null };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pauseRunHandler (SDK-only run Pause — Phase 4b)', () => {
  let db: Database.Database;
  let spy: OrderSpy;
  let runQueues: RunQueueRegistry;

  beforeEach(() => {
    db = makeDb();
    spy = makeOrderSpy();
    runQueues = new RunQueueRegistry();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // not_found
  // -------------------------------------------------------------------------

  it('returns noOp { reason: not_found } for an unknown run and never calls stopLiveRun', async () => {
    const result = await pauseRunHandler('no-such-run', makeDeps(db, spy, runQueues));

    expect(result).toEqual({ noOp: true, reason: 'not_found' });
    expect(spy.stopLiveRun).not.toHaveBeenCalled();
    expect(spy.clearPendingApprovalsForRun).not.toHaveBeenCalled();
    expect(spy.emitRunStatusChanged).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // interactive_unsupported (SDK-only guard)
  // -------------------------------------------------------------------------

  it('returns noOp { reason: interactive_unsupported } for an interactive run and never kills / writes', async () => {
    const { runId } = seedRun(db, { status: 'running' });
    setSubstrate(db, runId, 'interactive');
    setSession(db, runId, 'sess-1');

    const result = await pauseRunHandler(runId, makeDeps(db, spy, runQueues));

    expect(result).toEqual({ noOp: true, reason: 'interactive_unsupported' });
    expect(spy.stopLiveRun).not.toHaveBeenCalled();
    expect(spy.clearPendingApprovalsForRun).not.toHaveBeenCalled();
    expect(spy.emitRunStatusChanged).not.toHaveBeenCalled();
    // The run is untouched — still running.
    expect(getRun(db, runId).status).toBe('running');
  });

  // -------------------------------------------------------------------------
  // not_pausable (wrong source status)
  // -------------------------------------------------------------------------

  it.each<WorkflowRunStatus>(['queued', 'starting', 'awaiting_input', 'stuck', 'paused', 'completed', 'failed', 'canceled'])(
    'returns noOp { reason: not_pausable } for a %s run without calling stopLiveRun',
    async (status) => {
      const { runId } = seedRun(db, { status });
      setSubstrate(db, runId, 'sdk');
      setSession(db, runId, 'sess-1');

      const result = await pauseRunHandler(runId, makeDeps(db, spy, runQueues));

      expect(result).toEqual({ noOp: true, reason: 'not_pausable' });
      expect(spy.stopLiveRun).not.toHaveBeenCalled();
      expect(spy.emitRunStatusChanged).not.toHaveBeenCalled();
    },
  );

  // -------------------------------------------------------------------------
  // no_session (cannot resume later)
  // -------------------------------------------------------------------------

  it('returns noOp { reason: no_session } when claude_session_id is null', async () => {
    const { runId } = seedRun(db, { status: 'running' });
    setSubstrate(db, runId, 'sdk');
    // claude_session_id stays NULL.

    const result = await pauseRunHandler(runId, makeDeps(db, spy, runQueues));

    expect(result).toEqual({ noOp: true, reason: 'no_session' });
    expect(spy.stopLiveRun).not.toHaveBeenCalled();
    expect(spy.emitRunStatusChanged).not.toHaveBeenCalled();
    expect(getRun(db, runId).status).toBe('running');
  });

  // -------------------------------------------------------------------------
  // happy path — running
  // -------------------------------------------------------------------------

  it('happy path (running): clears approvals+questions, aborts once, sets paused, PRESERVES session/step/ended_at, emits', async () => {
    const { runId } = seedRun(db, { status: 'running' });
    setSubstrate(db, runId, 'sdk');
    setSession(db, runId, 'sess-1');
    db.prepare('UPDATE workflow_runs SET current_step_id = ? WHERE id = ?').run('step-2', runId);

    const result = await pauseRunHandler(runId, makeDeps(db, spy, runQueues));

    expect(result).toEqual({ success: true });

    // Approvals + questions cleared BEFORE the abort.
    expect(spy.clearPendingApprovalsForRun).toHaveBeenCalledWith(runId);
    expect(spy.clearPendingQuestionsForRun).toHaveBeenCalledWith(runId);
    expect(spy.calls.indexOf('clearPendingApprovalsForRun')).toBeLessThan(spy.calls.indexOf('stopLiveRun'));
    expect(spy.calls.indexOf('clearPendingQuestionsForRun')).toBeLessThan(spy.calls.indexOf('stopLiveRun'));

    // SDK turn aborted exactly once with the runId.
    expect(spy.stopLiveRun).toHaveBeenCalledOnce();
    expect(spy.stopLiveRun).toHaveBeenCalledWith(runId);

    // DB: status='paused' and the resume anchors are PRESERVED + ended_at stays null.
    const row = getRun(db, runId);
    expect(row.status).toBe('paused');
    expect(row.claude_session_id).toBe('sess-1');
    expect(row.current_step_id).toBe('step-2');
    expect(row.ended_at).toBeNull();

    // Run-status-changed signal emitted AFTER the write.
    expect(spy.emitRunStatusChanged).toHaveBeenCalledWith(runId, 'paused');
    expect(spy.calls.indexOf('stopLiveRun')).toBeLessThan(spy.calls.indexOf('emitRunStatusChanged'));
  });

  // -------------------------------------------------------------------------
  // happy path — awaiting_review
  // -------------------------------------------------------------------------

  it('happy path (awaiting_review): pause is valid from an idle rest', async () => {
    const { runId } = seedRun(db, { status: 'awaiting_review' });
    setSubstrate(db, runId, 'sdk');
    setSession(db, runId, 'sess-2');

    const result = await pauseRunHandler(runId, makeDeps(db, spy, runQueues));

    expect(result).toEqual({ success: true });
    const row = getRun(db, runId);
    expect(row.status).toBe('paused');
    expect(row.claude_session_id).toBe('sess-2');
    expect(spy.emitRunStatusChanged).toHaveBeenCalledWith(runId, 'paused');
  });

  // -------------------------------------------------------------------------
  // optional question clearer omitted
  // -------------------------------------------------------------------------

  it('works when clearPendingQuestionsForRun is omitted (optional dep)', async () => {
    const { runId } = seedRun(db, { status: 'running' });
    setSubstrate(db, runId, 'sdk');
    setSession(db, runId, 'sess-1');
    const deps: PauseRunDeps = {
      db: dbAdapter(db),
      runQueues,
      stopLiveRun: spy.stopLiveRun,
      clearPendingApprovalsForRun: spy.clearPendingApprovalsForRun,
      emitRunStatusChanged: spy.emitRunStatusChanged,
    };

    const result = await pauseRunHandler(runId, deps);

    expect(result).toEqual({ success: true });
    expect(getRun(db, runId).status).toBe('paused');
  });

  // -------------------------------------------------------------------------
  // fail-soft: stopLiveRun rejection — DB write STILL applies
  // -------------------------------------------------------------------------

  it('still pauses the run when stopLiveRun rejects (fail-soft) and returns success', async () => {
    const { runId } = seedRun(db, { status: 'running' });
    setSubstrate(db, runId, 'sdk');
    setSession(db, runId, 'sess-1');

    const rejectingSpy = makeOrderSpy();
    rejectingSpy.stopLiveRun.mockRejectedValueOnce(new Error('SDK abort failed'));

    const loggerErrors: Array<{ msg: string; ctx: Record<string, unknown> }> = [];
    const testLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn((msg: string, ctx?: Record<string, unknown>) => {
        loggerErrors.push({ msg, ctx: ctx ?? {} });
      }),
      debug: vi.fn(),
    };

    const deps: PauseRunDeps = {
      ...makeDeps(db, rejectingSpy, runQueues),
      logger: testLogger,
    };

    const result = await pauseRunHandler(runId, deps);

    expect(result).toEqual({ success: true });
    const row = getRun(db, runId);
    expect(row.status).toBe('paused');
    expect(row.claude_session_id).toBe('sess-1');
    expect(rejectingSpy.emitRunStatusChanged).toHaveBeenCalledWith(runId, 'paused');

    // The rejection was logged with the [pauseRun] prefix and runId.
    expect(loggerErrors.length).toBeGreaterThanOrEqual(1);
    expect(loggerErrors[0].msg).toContain('[pauseRun]');
    expect(loggerErrors[0].ctx['runId']).toBe(runId);
  });

  it('still pauses when stopLiveRun rejects and NO logger is provided', async () => {
    const { runId } = seedRun(db, { status: 'running' });
    setSubstrate(db, runId, 'sdk');
    setSession(db, runId, 'sess-1');
    const rejectingSpy = makeOrderSpy();
    rejectingSpy.stopLiveRun.mockRejectedValueOnce(new Error('no live process'));

    const result = await pauseRunHandler(runId, makeDeps(db, rejectingSpy, runQueues));

    expect(result).toEqual({ success: true });
    expect(getRun(db, runId).status).toBe('paused');
  });

  // -------------------------------------------------------------------------
  // race: a concurrent transition wins between guard and UPDATE
  // -------------------------------------------------------------------------

  it('returns noOp { reason: race } when the guarded UPDATE matches 0 rows', async () => {
    const { runId } = seedRun(db, { status: 'running' });
    setSubstrate(db, runId, 'sdk');
    setSession(db, runId, 'sess-1');

    // Wrap the real db but, on the guarded paused UPDATE, pre-cancel the run first
    // so the status-IN-('running','awaiting_review') WHERE clause matches 0 rows.
    let intercepted = false;
    const racingDb: DatabaseLike = {
      prepare: (sql: string) => {
        const realStmt = db.prepare(sql);
        if (!intercepted && sql.includes("SET status = 'paused'") && sql.includes('status IN')) {
          intercepted = true;
          return {
            run: (...params: unknown[]) => {
              db.prepare(`UPDATE workflow_runs SET status = 'canceled' WHERE id = ?`).run(runId);
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

    const result = await pauseRunHandler(runId, {
      db: racingDb,
      runQueues,
      stopLiveRun: spy.stopLiveRun,
      clearPendingApprovalsForRun: spy.clearPendingApprovalsForRun,
      clearPendingQuestionsForRun: spy.clearPendingQuestionsForRun,
      emitRunStatusChanged: spy.emitRunStatusChanged,
    });

    expect(result).toEqual({ noOp: true, reason: 'race' });
    // The race lost — no status-changed signal; the concurrent write moved it terminal.
    expect(spy.emitRunStatusChanged).not.toHaveBeenCalled();
    expect(getRun(db, runId).status).toBe('canceled');
  });

  // -------------------------------------------------------------------------
  // GIT-NEUTRAL invariant — the deps bag has NO git collaborator at all.
  // -------------------------------------------------------------------------

  it('GIT-NEUTRAL: the PauseRunDeps bag exposes no worktree/branch/merge collaborator', async () => {
    const { runId } = seedRun(db, { status: 'running' });
    setSubstrate(db, runId, 'sdk');
    setSession(db, runId, 'sess-1');
    const deps = makeDeps(db, spy, runQueues);

    await pauseRunHandler(runId, deps);

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
    // The worktree row itself is untouched by pause.
    const wt = db.prepare('SELECT worktree_path FROM workflow_runs WHERE id = ?').get(runId) as {
      worktree_path: string;
    };
    expect(wt.worktree_path).toBe('/tmp/test');
  });
});
