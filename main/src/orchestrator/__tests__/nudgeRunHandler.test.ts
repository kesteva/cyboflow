/**
 * Unit tests for nudgeRunHandler (Piece C — idle-chat nudge / conversation resume).
 *
 * Covers the full guard matrix (empty / not_found / terminal / not_idle /
 * blocked / no_session / race) plus the happy-path delivery (status flips to
 * running, setPendingNudge + execute fire) and the execute_failed fallback.
 *
 * Standalone: no electron / services imports. The DB is an in-memory SQLite via
 * createTestDb wrapped in the DatabaseLike adapter; the executor + queue are
 * lightweight fakes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedRun } from '../__test_fixtures__/orchestratorTestDb';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { RunQueueRegistry } from '../RunQueueRegistry';
import { nudgeRunHandler, type NudgeRunExecutorLike } from '../nudgeRunHandler';
import type { DatabaseLike, PreparedStatement } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fake executor that records setPendingNudge + execute calls. */
function makeFakeExecutor(opts?: { executeRejects?: boolean }): NudgeRunExecutorLike & {
  setPendingNudge: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
} {
  const setPendingNudge = vi.fn<(runId: string, text: string) => void>();
  const execute = vi.fn<(runId: string) => Promise<void>>().mockImplementation(async () => {
    if (opts?.executeRejects) throw new Error('boom');
  });
  return { setPendingNudge, execute };
}

/**
 * Build a test DB with the claude_session_id column layered on. FK enforcement
 * is OFF so the optional review_items seed (which FKs projects + workflow_runs)
 * can be inserted without seeding a projects row.
 */
function makeDb(): Database.Database {
  const db = createTestDb({ disableForeignKeys: true });
  db.exec('ALTER TABLE workflow_runs ADD COLUMN claude_session_id TEXT');
  return db;
}

/** Set a run's claude_session_id directly (the SDK init capture is out of scope here). */
function setSession(db: Database.Database, runId: string, sessionId: string | null): void {
  db.prepare('UPDATE workflow_runs SET claude_session_id = ? WHERE id = ?').run(sessionId, runId);
}

/** Layer the review_items table (migration 016) and insert one pending blocking item. */
function seedBlockingReviewItem(db: Database.Database, runId: string): void {
  const fs = require('node:fs') as typeof import('fs'); // eslint-disable-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('path'); // eslint-disable-line @typescript-eslint/no-require-imports
  const sql = fs.readFileSync(path.resolve(__dirname, '../../database/migrations/016_review_items.sql'), 'utf8');
  db.exec(sql);
  db.prepare(
    `INSERT INTO review_items (id, project_id, run_id, kind, status, blocking, title)
     VALUES (?, 1, ?, 'decision', 'pending', 1, 'gate')`,
  ).run(`rvw-${runId}`, runId);
}

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// Guard matrix
// ---------------------------------------------------------------------------

describe('nudgeRunHandler — guard matrix', () => {
  it('empty text → { noOp: empty } (never touches the queue / DB)', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'awaiting_review' });
    setSession(db, runId, 'sess-1');
    const executor = makeFakeExecutor();

    const result = await nudgeRunHandler(runId, '   ', {
      db: dbAdapter(db),
      runQueues: new RunQueueRegistry(),
      runExecutor: executor,
    });

    expect(result).toEqual({ noOp: true, reason: 'empty' });
    expect(executor.setPendingNudge).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
    db.close();
  });

  it('missing run → { noOp: not_found }', async () => {
    const db = makeDb();
    const result = await nudgeRunHandler('no-such-run', 'hi', {
      db: dbAdapter(db),
      runQueues: new RunQueueRegistry(),
      runExecutor: makeFakeExecutor(),
    });
    expect(result).toEqual({ noOp: true, reason: 'not_found' });
    db.close();
  });

  it('terminal status → { noOp: terminal }', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'completed' });
    setSession(db, runId, 'sess-1');
    const result = await nudgeRunHandler(runId, 'hi', {
      db: dbAdapter(db),
      runQueues: new RunQueueRegistry(),
      runExecutor: makeFakeExecutor(),
    });
    expect(result).toEqual({ noOp: true, reason: 'terminal' });
    db.close();
  });

  it('non-idle status (running) → { noOp: not_idle }', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'running' });
    setSession(db, runId, 'sess-1');
    const result = await nudgeRunHandler(runId, 'hi', {
      db: dbAdapter(db),
      runQueues: new RunQueueRegistry(),
      runExecutor: makeFakeExecutor(),
    });
    expect(result).toEqual({ noOp: true, reason: 'not_idle' });
    db.close();
  });

  it('pending blocking review item → { noOp: blocked }', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'awaiting_review' });
    setSession(db, runId, 'sess-1');
    seedBlockingReviewItem(db, runId);
    const result = await nudgeRunHandler(runId, 'hi', {
      db: dbAdapter(db),
      runQueues: new RunQueueRegistry(),
      runExecutor: makeFakeExecutor(),
    });
    expect(result).toEqual({ noOp: true, reason: 'blocked' });
    db.close();
  });

  it('no captured claude_session_id → { noOp: no_session }', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'awaiting_review' });
    // claude_session_id stays NULL.
    const result = await nudgeRunHandler(runId, 'hi', {
      db: dbAdapter(db),
      runQueues: new RunQueueRegistry(),
      runExecutor: makeFakeExecutor(),
    });
    expect(result).toEqual({ noOp: true, reason: 'no_session' });
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Happy path + race + execute failure
// ---------------------------------------------------------------------------

describe('nudgeRunHandler — delivery', () => {
  it('happy path → flips to running, stashes the trimmed nudge, calls execute, returns delivered', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'awaiting_review' });
    setSession(db, runId, 'sess-1');
    const executor = makeFakeExecutor();

    const result = await nudgeRunHandler(runId, '  please continue  ', {
      db: dbAdapter(db),
      runQueues: new RunQueueRegistry(),
      runExecutor: executor,
    });

    expect(result).toEqual({ delivered: true });
    // Status was flipped to running by the guarded UPDATE.
    const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('running');
    // The trimmed nudge was stashed and execute() fired with the runId.
    expect(executor.setPendingNudge).toHaveBeenCalledWith(runId, 'please continue');
    expect(executor.execute).toHaveBeenCalledWith(runId);
    db.close();
  });

  it('race: guard SELECT sees awaiting_review but the guarded UPDATE matches 0 rows → { noOp: race }', async () => {
    // Simulate the concurrency window: the run is ACTUALLY parked in 'stuck'
    // (so the guarded `WHERE status='awaiting_review'` UPDATE changes 0 rows),
    // but the guard SELECT is made to observe 'awaiting_review' (as if a
    // concurrent transition moved the row between the SELECT and the UPDATE).
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'stuck' });
    setSession(db, runId, 'sess-1');

    const real = dbAdapter(db);
    const adapter: DatabaseLike = {
      prepare: (sql: string): PreparedStatement => {
        const stmt = real.prepare(sql);
        if (sql.includes('SELECT id, status, claude_session_id')) {
          // Override only .get() to report awaiting_review; .run()/.all() delegate
          // to the real statement so the guarded UPDATE still hits the actual row.
          return {
            run: (...params: unknown[]) => stmt.run(...params),
            get: () => ({ id: runId, status: 'awaiting_review', claude_session_id: 'sess-1' }),
            all: (...params: unknown[]) => stmt.all(...params),
          };
        }
        return stmt;
      },
      transaction: real.transaction.bind(real),
    };

    const executor = makeFakeExecutor();
    const result = await nudgeRunHandler(runId, 'hi', {
      db: adapter,
      runQueues: new RunQueueRegistry(),
      runExecutor: executor,
    });

    expect(result).toEqual({ noOp: true, reason: 'race' });
    expect(executor.execute).not.toHaveBeenCalled();
    db.close();
  });

  it('execute() rejection after the flip → { noOp: execute_failed }', async () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'awaiting_review' });
    setSession(db, runId, 'sess-1');
    const executor = makeFakeExecutor({ executeRejects: true });

    const result = await nudgeRunHandler(runId, 'hi', {
      db: dbAdapter(db),
      runQueues: new RunQueueRegistry(),
      runExecutor: executor,
    });

    expect(result).toEqual({ noOp: true, reason: 'execute_failed' });
    // The run was still flipped to running (the executor owns the terminal state).
    const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('running');
    db.close();
  });
});
