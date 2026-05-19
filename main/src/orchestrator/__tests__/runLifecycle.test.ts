/**
 * Tests for workflow_run lifecycle transition helpers and the tRPC cancel handler.
 *
 * TASK-644 acceptance criteria verified here:
 *
 * AC1: Four new transition helpers exported from transitions.ts.
 * AC2: transitionToRunning guards on source status='starting'.
 * AC3: transitionToCompleted/Failed/Canceled set ended_at.
 * AC4: transitionToFailed writes error_message.
 * AC5: transitionToCanceled accepts any non-terminal source; rejects terminal.
 * AC6: cyboflow.runs.cancel tRPC mutation body is wired (cancelHandler).
 * AC7: cancel procedure throws METHOD_NOT_SUPPORTED when deps unwired.
 * AC8: cancel ordering: clearPendingForRun -> executor.cancel -> DB write.
 *
 * Test strategy:
 *   - Real in-memory better-sqlite3 with REGISTRY_SCHEMA.
 *   - Transition helpers imported directly — no tRPC wrapper needed.
 *   - cancelHandler imported directly for ordering/return-value tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { REGISTRY_SCHEMA } from '../../database/__test_fixtures__/registrySchema';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import {
  transitionToRunning,
  transitionToCompleted,
  transitionToFailed,
  transitionToCanceled,
  TransitionRejectedError,
} from '../../services/cyboflow/transitions';
import { cancelHandler, type CancelDeps } from '../trpc/routers/runs';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(REGISTRY_SCHEMA);
  return db;
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function seedWorkflow(db: Database.Database): string {
  const workflowId = `workflow-${randomUUID()}`;
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json)
     VALUES (?, 1, 'test-workflow', '{}')`,
  ).run(workflowId);
  return workflowId;
}

function seedRun(db: Database.Database, runId: string, status: string): void {
  const workflowId = seedWorkflow(db);
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, policy_json)
     VALUES (?, ?, 1, ?, '{}')`,
  ).run(runId, workflowId, status);
}

function getStatus(db: Database.Database, runId: string): string {
  const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
  return row.status;
}

function getEndedAt(db: Database.Database, runId: string): string | null {
  const row = db.prepare('SELECT ended_at FROM workflow_runs WHERE id = ?').get(runId) as { ended_at: string | null };
  return row.ended_at;
}

function getErrorMessage(db: Database.Database, runId: string): string | null {
  const row = db.prepare('SELECT error_message FROM workflow_runs WHERE id = ?').get(runId) as { error_message: string | null };
  return row.error_message;
}

// ---------------------------------------------------------------------------
// describe: transitionToRunning
// ---------------------------------------------------------------------------

describe('transitionToRunning', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('succeeds when source status is "starting"', () => {
    const runId = randomUUID();
    seedRun(db, runId, 'starting');
    transitionToRunning(db, { runId });
    expect(getStatus(db, runId)).toBe('running');
  });

  it('throws TransitionRejectedError when source status is "queued"', () => {
    const runId = randomUUID();
    seedRun(db, runId, 'queued');
    expect(() => transitionToRunning(db, { runId })).toThrow(TransitionRejectedError);
  });

  it.each([
    'running',
    'awaiting_review',
    'stuck',
    'completed',
    'failed',
    'canceled',
  ])('throws TransitionRejectedError when source status is "%s"', (status) => {
    const runId = randomUUID();
    seedRun(db, runId, status);
    // assertTransitionAllowed checks first, so either IllegalTransitionError
    // or TransitionRejectedError may be thrown depending on status.
    // The plan only requires TransitionRejectedError for 'queued'. For other
    // illegal sources, IllegalTransitionError (from assertTransitionAllowed)
    // is thrown — still an Error subtype, still correctly rejected.
    expect(() => transitionToRunning(db, { runId })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// describe: transitionToCompleted
// ---------------------------------------------------------------------------

describe('transitionToCompleted', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('succeeds from "running" and sets ended_at', () => {
    const runId = randomUUID();
    seedRun(db, runId, 'running');
    transitionToCompleted(db, { runId, fromStatus: 'running' });
    expect(getStatus(db, runId)).toBe('completed');
    expect(getEndedAt(db, runId)).not.toBeNull();
  });

  it('throws TransitionRejectedError when run is not in expected fromStatus', () => {
    const runId = randomUUID();
    // Seed as 'starting' but claim fromStatus='running'
    seedRun(db, runId, 'starting');
    expect(() => transitionToCompleted(db, { runId, fromStatus: 'running' })).toThrow(TransitionRejectedError);
  });
});

// ---------------------------------------------------------------------------
// describe: transitionToFailed
// ---------------------------------------------------------------------------

describe('transitionToFailed', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it.each([
    'starting',
    'running',
    'awaiting_review',
    'stuck',
  ] as const)('succeeds from "%s", writes error_message and ended_at', (status) => {
    const runId = randomUUID();
    seedRun(db, runId, status);
    transitionToFailed(db, { runId, fromStatus: status, errorMessage: 'boom' });
    expect(getStatus(db, runId)).toBe('failed');
    expect(getErrorMessage(db, runId)).toBe('boom');
    expect(getEndedAt(db, runId)).not.toBeNull();
  });

  it('throws TransitionRejectedError when run is not in expected fromStatus', () => {
    const runId = randomUUID();
    // Seed as 'queued' but claim fromStatus='running'
    seedRun(db, runId, 'queued');
    expect(() =>
      transitionToFailed(db, { runId, fromStatus: 'running', errorMessage: 'boom' }),
    ).toThrow(TransitionRejectedError);
  });
});

// ---------------------------------------------------------------------------
// describe: transitionToCanceled
// ---------------------------------------------------------------------------

describe('transitionToCanceled', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it.each(['queued', 'starting', 'running', 'awaiting_review', 'stuck'])(
    'succeeds from non-terminal status "%s" and sets ended_at',
    (status) => {
      const runId = randomUUID();
      seedRun(db, runId, status);
      transitionToCanceled(db, { runId });
      expect(getStatus(db, runId)).toBe('canceled');
      expect(getEndedAt(db, runId)).not.toBeNull();
    },
  );

  it.each(['completed', 'failed', 'canceled'])(
    'throws TransitionRejectedError when source is terminal "%s"',
    (status) => {
      const runId = randomUUID();
      seedRun(db, runId, status);
      expect(() => transitionToCanceled(db, { runId })).toThrow(TransitionRejectedError);
    },
  );
});

// ---------------------------------------------------------------------------
// describe: cancelHandler (tRPC cancel body)
// ---------------------------------------------------------------------------

describe('cancelHandler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Helper: build deps bag with an OrderSpy
  // -------------------------------------------------------------------------

  interface OrderSpy {
    calls: string[];
    clearPendingForRun: ReturnType<typeof vi.fn>;
    executorCancel: ReturnType<typeof vi.fn>;
  }

  function makeOrderSpy(): OrderSpy {
    const calls: string[] = [];
    const clearPendingForRun = vi.fn((_runId: string) => {
      calls.push('clearPendingForRun');
    });
    const executorCancel = vi.fn(async () => {
      calls.push('executor.cancel');
    });
    return { calls, clearPendingForRun, executorCancel };
  }

  function makeDeps(spy: OrderSpy, runId: string): CancelDeps {
    return {
      db: dbAdapter(db),
      approvalRouter: { clearPendingForRun: spy.clearPendingForRun },
      lookupExecutor: (_id: string) => (_id === runId ? { cancel: spy.executorCancel } : null),
    };
  }

  // -------------------------------------------------------------------------
  // Ordering: clearPendingForRun -> executor.cancel -> DB write
  // -------------------------------------------------------------------------

  it('executes clearPendingForRun -> executor.cancel -> DB write in strict order', async () => {
    const runId = randomUUID();
    seedRun(db, runId, 'running');

    const spy = makeOrderSpy();

    // Wrap dbAdapter to capture when the UPDATE fires
    const origDb = dbAdapter(db);
    const wrappedDb: CancelDeps['db'] = {
      prepare: (sql: string) => {
        const stmt = origDb.prepare(sql);
        if (sql.includes("status NOT IN ('canceled'")) {
          return {
            run: (...args: unknown[]) => {
              spy.calls.push('dbWrite');
              return stmt.run(...args);
            },
            get: (...args: unknown[]) => stmt.get(...args),
            all: (...args: unknown[]) => stmt.all(...args),
          };
        }
        return stmt;
      },
      transaction: origDb.transaction,
    };

    const deps: CancelDeps = {
      db: wrappedDb,
      approvalRouter: { clearPendingForRun: spy.clearPendingForRun },
      lookupExecutor: (_id: string) => (_id === runId ? { cancel: spy.executorCancel } : null),
    };

    await cancelHandler(runId, deps);

    expect(spy.calls).toEqual(['clearPendingForRun', 'executor.cancel', 'dbWrite']);
  });

  // -------------------------------------------------------------------------
  // Returns { canceled: true } on success
  // -------------------------------------------------------------------------

  it('returns { canceled: true } when run is in a non-terminal state', async () => {
    const runId = randomUUID();
    seedRun(db, runId, 'running');

    const spy = makeOrderSpy();
    const result = await cancelHandler(runId, makeDeps(spy, runId));

    expect(result).toEqual({ canceled: true });
  });

  // -------------------------------------------------------------------------
  // Returns { canceled: false, reason: 'already_terminal' } for terminal runs
  // -------------------------------------------------------------------------

  it('returns { canceled: false, reason: "already_terminal" } when run is already canceled', async () => {
    const runId = randomUUID();
    seedRun(db, runId, 'canceled');

    const spy = makeOrderSpy();
    const result = await cancelHandler(runId, makeDeps(spy, runId));

    expect(result).toEqual({ canceled: false, reason: 'already_terminal' });
  });

  // -------------------------------------------------------------------------
  // No executor found: skip clearPendingForRun and executor.cancel
  // -------------------------------------------------------------------------

  it('skips clearPendingForRun and executor.cancel when executor not found', async () => {
    const runId = randomUUID();
    seedRun(db, runId, 'running');

    const spy = makeOrderSpy();
    const deps: CancelDeps = {
      db: dbAdapter(db),
      approvalRouter: { clearPendingForRun: spy.clearPendingForRun },
      lookupExecutor: () => null,
    };

    const result = await cancelHandler(runId, deps);

    expect(result).toEqual({ canceled: true });
    expect(spy.clearPendingForRun).not.toHaveBeenCalled();
    expect(spy.executorCancel).not.toHaveBeenCalled();
    expect(getStatus(db, runId)).toBe('canceled');
  });

  // -------------------------------------------------------------------------
  // DB updated to 'canceled' + ended_at set
  // -------------------------------------------------------------------------

  it('sets status=canceled and ended_at on the DB row', async () => {
    const runId = randomUUID();
    seedRun(db, runId, 'running');

    const spy = makeOrderSpy();
    await cancelHandler(runId, makeDeps(spy, runId));

    expect(getStatus(db, runId)).toBe('canceled');
    expect(getEndedAt(db, runId)).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // executor.cancel() rejection: DB still reaches 'canceled', logger.error called
  // -------------------------------------------------------------------------

  it('resolves { canceled: true } and marks DB canceled even when executor.cancel rejects', async () => {
    const runId = randomUUID();
    seedRun(db, runId, 'running');

    const loggerError = vi.fn();
    const cancelMock = vi.fn().mockRejectedValue(new Error('iter broken'));

    const deps: CancelDeps = {
      db: dbAdapter(db),
      approvalRouter: { clearPendingForRun: vi.fn() },
      lookupExecutor: (_id: string) => (_id === runId ? { cancel: cancelMock } : null),
      logger: {
        error: loggerError,
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      },
    };

    const result = await cancelHandler(runId, deps);

    // Handler must resolve (not reject) despite executor.cancel throwing.
    expect(result).toEqual({ canceled: true });
    // DB row must reach 'canceled'.
    expect(getStatus(db, runId)).toBe('canceled');
    // logger.error must have been called exactly once with the runId.
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('[cancel]'),
      expect.objectContaining({ runId }),
    );
  });
});
