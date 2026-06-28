/**
 * Integration tests for the orchestrator tRPC verificationRequests router (S7/L6).
 *
 * Exercises the live verificationRequestsRouter.list procedure via createCaller,
 * using an in-memory SQLite DB built from projects + migrations
 * 006/011/014/015/016/036/037 (so workflow_runs + verification_requests +
 * judge_calls_used all exist), the shared dbAdapter fixture, and a real
 * DatabaseLike — mirroring the verificationScheduler test's DB harness.
 *
 * Tests:
 *  1. list filters by projectId (rows from another project are excluded).
 *  2. optional runId filter narrows to a single run.
 *  3. optional status filter narrows to a single lifecycle status.
 *  4. runId + status filters compose.
 *  5. results are ordered by enqueued_at DESC (newest first).
 *  6. each row matches the VerificationRequestRow shape (chain_json NULL -> '[]').
 *  7. an empty projectId result returns [].
 *  8. zod rejects projectId 0 / negative + an out-of-domain status.
 *  9. PRECONDITION_FAILED when ctx.db is missing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { TRPCError } from '@trpc/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import type { DatabaseLike } from '../../../types';
import type { RequestStatus } from '../../../../../../shared/types/visualVerification';

// ---------------------------------------------------------------------------
// Test DB: projects + 006 + 011 + 014 + 015 + 016 + 036 + 037.
// ---------------------------------------------------------------------------

const MIG_DIR = join(__dirname, '..', '..', '..', '..', 'database', 'migrations');
const MIGRATIONS = [
  '006_cyboflow_schema.sql',
  '011_workflow_step_tracking.sql',
  '014_native_tasks.sql',
  '015_entity_model_rebuild.sql',
  '016_review_items.sql',
  '036_visual_verification.sql',
  '037_visual_verify_budget.sql',
];

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('ProjA', '/tmp/p1');
  db.prepare('INSERT INTO projects (id, name, path) VALUES (2, ?, ?)').run('ProjB', '/tmp/p2');
  for (const f of MIGRATIONS) db.exec(readFileSync(join(MIG_DIR, f), 'utf-8'));
  return db;
}

function seedRun(db: Database.Database, runId: string, projectId: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES (?, ?, 'sprint', '{}')`,
  ).run(`wf-${projectId}`, projectId);
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES (?, ?, ?, 'running', 'default')`,
  ).run(runId, `wf-${projectId}`, projectId);
}

/** Insert one verification_requests row with explicit fields. */
function seedRequest(
  db: Database.Database,
  opts: {
    id: string;
    runId: string;
    projectId: number;
    status: RequestStatus;
    verifyType?: string;
    deliverableJson?: string;
    chainJson?: string | null;
    currentBackend?: string | null;
    attempt?: number;
    verdictJson?: string | null;
    errorMessage?: string | null;
    enqueuedAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO verification_requests
       (id, run_id, project_id, status, verify_type, deliverable_json, chain_json,
        current_backend, attempt, verdict_json, error_message, enqueued_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.runId,
    opts.projectId,
    opts.status,
    opts.verifyType ?? 'static-render-snapshot',
    opts.deliverableJson ?? JSON.stringify({ intent: 'looks right' }),
    opts.chainJson === undefined ? JSON.stringify(['capturePage']) : opts.chainJson,
    opts.currentBackend ?? null,
    opts.attempt ?? 0,
    opts.verdictJson ?? null,
    opts.errorMessage ?? null,
    opts.enqueuedAt,
  );
}

function buildCaller(): {
  caller: ReturnType<typeof appRouter.createCaller>;
  db: Database.Database;
  adapter: DatabaseLike;
} {
  const db = buildDb();
  const adapter = dbAdapter(db);
  const caller = appRouter.createCaller(createContext({ db: adapter }));
  return { caller, db, adapter };
}

let openDb: Database.Database | null = null;

afterEach(() => {
  openDb?.close();
  openDb = null;
});

describe('cyboflow.verificationRequests.list', () => {
  it('filters by projectId (excludes other projects)', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRun(db, 'run-b', 2);
    seedRequest(db, { id: 'vr-1', runId: 'run-a', projectId: 1, status: 'queued', enqueuedAt: '2026-06-28T00:00:01.000Z' });
    seedRequest(db, { id: 'vr-2', runId: 'run-b', projectId: 2, status: 'queued', enqueuedAt: '2026-06-28T00:00:02.000Z' });

    const result = await caller.cyboflow.verificationRequests.list({ projectId: 1 });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('vr-1');
    expect(result[0].project_id).toBe(1);
  });

  it('narrows to a single run via the optional runId filter', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRun(db, 'run-c', 1);
    seedRequest(db, { id: 'vr-1', runId: 'run-a', projectId: 1, status: 'queued', enqueuedAt: '2026-06-28T00:00:01.000Z' });
    seedRequest(db, { id: 'vr-2', runId: 'run-c', projectId: 1, status: 'queued', enqueuedAt: '2026-06-28T00:00:02.000Z' });

    const result = await caller.cyboflow.verificationRequests.list({ projectId: 1, runId: 'run-c' });

    expect(result.map((r) => r.id)).toEqual(['vr-2']);
  });

  it('narrows to a single status via the optional status filter', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRequest(db, { id: 'vr-1', runId: 'run-a', projectId: 1, status: 'queued', enqueuedAt: '2026-06-28T00:00:01.000Z' });
    seedRequest(db, { id: 'vr-2', runId: 'run-a', projectId: 1, status: 'passed', enqueuedAt: '2026-06-28T00:00:02.000Z' });

    const result = await caller.cyboflow.verificationRequests.list({ projectId: 1, status: 'passed' });

    expect(result.map((r) => r.id)).toEqual(['vr-2']);
    expect(result[0].status).toBe('passed');
  });

  it('composes the runId + status filters', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRun(db, 'run-c', 1);
    seedRequest(db, { id: 'vr-1', runId: 'run-a', projectId: 1, status: 'failed', enqueuedAt: '2026-06-28T00:00:01.000Z' });
    seedRequest(db, { id: 'vr-2', runId: 'run-c', projectId: 1, status: 'failed', enqueuedAt: '2026-06-28T00:00:02.000Z' });
    seedRequest(db, { id: 'vr-3', runId: 'run-c', projectId: 1, status: 'passed', enqueuedAt: '2026-06-28T00:00:03.000Z' });

    const result = await caller.cyboflow.verificationRequests.list({
      projectId: 1,
      runId: 'run-c',
      status: 'failed',
    });

    expect(result.map((r) => r.id)).toEqual(['vr-2']);
  });

  it('orders by enqueued_at DESC (newest first)', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRequest(db, { id: 'vr-old', runId: 'run-a', projectId: 1, status: 'queued', enqueuedAt: '2026-06-28T00:00:01.000Z' });
    seedRequest(db, { id: 'vr-new', runId: 'run-a', projectId: 1, status: 'queued', enqueuedAt: '2026-06-28T00:00:09.000Z' });
    seedRequest(db, { id: 'vr-mid', runId: 'run-a', projectId: 1, status: 'queued', enqueuedAt: '2026-06-28T00:00:05.000Z' });

    const result = await caller.cyboflow.verificationRequests.list({ projectId: 1 });

    expect(result.map((r) => r.id)).toEqual(['vr-new', 'vr-mid', 'vr-old']);
  });

  it('returns rows matching the VerificationRequestRow shape (chain_json NULL -> "[]")', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRequest(db, {
      id: 'vr-1',
      runId: 'run-a',
      projectId: 1,
      status: 'running',
      verifyType: 'interactive-web-behavior',
      deliverableJson: JSON.stringify({ intent: 'click works' }),
      chainJson: null, // unresolved chain -> normalized to '[]'
      currentBackend: 'playwright',
      attempt: 1,
      verdictJson: null,
      errorMessage: null,
      enqueuedAt: '2026-06-28T00:00:01.000Z',
    });

    const [row] = await caller.cyboflow.verificationRequests.list({ projectId: 1 });

    expect(row).toEqual({
      id: 'vr-1',
      run_id: 'run-a',
      project_id: 1,
      status: 'running',
      verify_type: 'interactive-web-behavior',
      deliverable_json: JSON.stringify({ intent: 'click works' }),
      chain_json: '[]',
      current_backend: 'playwright',
      attempt: 1,
      verdict_json: null,
      error_message: null,
      enqueued_at: '2026-06-28T00:00:01.000Z',
      leased_at: null,
      ended_at: null,
    });
    // chain_json is always a parseable VisualBackendId[] for the renderer.
    expect(() => JSON.parse(row.chain_json)).not.toThrow();
  });

  it('returns [] when the project has no requests', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    const result = await caller.cyboflow.verificationRequests.list({ projectId: 1 });
    expect(result).toEqual([]);
  });

  it('rejects projectId 0 without querying', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    await expect(
      caller.cyboflow.verificationRequests.list({ projectId: 0 }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
  });

  it('rejects a negative projectId', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    await expect(
      caller.cyboflow.verificationRequests.list({ projectId: -2 }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
  });

  it('rejects an out-of-domain status', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    await expect(
      // @ts-expect-error — 'bogus' is not a RequestStatus; the zod enum rejects it.
      caller.cyboflow.verificationRequests.list({ projectId: 1, status: 'bogus' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
  });

  it('throws PRECONDITION_FAILED when ctx.db is missing', async () => {
    const caller = appRouter.createCaller(createContext());
    await expect(
      caller.cyboflow.verificationRequests.list({ projectId: 1 }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
  });
});
