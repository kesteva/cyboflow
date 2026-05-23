/**
 * Integration tests for the orchestrator tRPC runs procedures.
 *
 * Covers:
 *
 * runs.getStuckInspection (TASK-709):
 *  Tests exercise the live runsRouter.getStuckInspection procedure via
 *  createCaller, using an in-memory SQLite database (GATE_SCHEMA + migration 007
 *  stub), the dbAdapter fixture, and the real getStuckInspectionHandler.
 *  (a) Happy path: stuck run + pending approval + 15 raw events → returns
 *      correct shaped result with 10 most recent events.
 *  (b) Unknown runId → TRPCError NOT_FOUND.
 *  (c) Non-'local' userId → TRPCError FORBIDDEN.
 *  (d) Missing ctx.db → TRPCError PRECONDITION_FAILED.
 *
 * runs.list (TASK-710 — wrapper-layer guard coverage):
 *  Tests exercise the tRPC FORBIDDEN/PRECONDITION_FAILED guards that sit around
 *  the listRunsHandler call. Handler-level behavior (ordering, scoping,
 *  policy_json exclusion) is covered in
 *  main/src/orchestrator/__tests__/listRunsHandler.test.ts.
 *  (a) Happy path: seeded runs return the correct list for the given projectId.
 *  (b) Non-'local' userId → TRPCError FORBIDDEN.
 *  (c) Missing ctx.db → TRPCError PRECONDITION_FAILED.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { TRPCError } from '@trpc/server';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import { GATE_SCHEMA } from '../../../../database/__test_fixtures__/registrySchema';
import { seedRun } from '../../../__test_fixtures__/orchestratorTestDb';

// ---------------------------------------------------------------------------
// Test-database setup
// ---------------------------------------------------------------------------

/**
 * Creates a fresh in-memory SQLite database with GATE_SCHEMA plus an inline
 * application of migration 007 (stuck_detected_at column on workflow_runs).
 */
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(GATE_SCHEMA);
  // Apply migration 007 inline (adds stuck_detected_at INTEGER to workflow_runs).
  db.exec(`ALTER TABLE workflow_runs ADD COLUMN stuck_detected_at INTEGER;`);
  return db;
}

// ---------------------------------------------------------------------------
// Seed helpers (inlined — small, out of scope to extract to shared fixture)
// ---------------------------------------------------------------------------

/** Seed a workflow + workflow_run row with status='stuck'. */
function seedStuckRun(
  db: Database.Database,
  runId: string,
  stuckReason: string,
): void {
  const workflowId = `workflow-${runId}`;
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json)
     VALUES (?, 1, 'test-workflow', '{}')`,
  ).run(workflowId);

  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, worktree_path, status, policy_json,
        stuck_reason, stuck_detected_at)
     VALUES (?, ?, 1, '/tmp/test', 'stuck', '{}', ?, unixepoch('now') * 1000)`,
  ).run(runId, workflowId, stuckReason);
}

/** Seed a pending approval row for a run. */
function seedPendingApproval(
  db: Database.Database,
  runId: string,
  approvalId: string,
  toolName: string,
  toolInputJson: string,
): void {
  db.prepare(
    `INSERT INTO approvals
       (id, run_id, tool_name, tool_input_json, tool_use_id, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
  ).run(approvalId, runId, toolName, toolInputJson, `use-${approvalId}`);
}

/** Seed N raw_events rows for a run. Returns inserted row ids. */
function seedRawEvents(
  db: Database.Database,
  runId: string,
  count: number,
): number[] {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const result = db.prepare(
      `INSERT INTO raw_events (run_id, event_type, payload_json)
       VALUES (?, 'sdk_message', ?)`,
    ).run(runId, JSON.stringify({ index: i })) as { lastInsertRowid: number | bigint };
    ids.push(Number(result.lastInsertRowid));
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cyboflow.runs.getStuckInspection', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  // -------------------------------------------------------------------------
  // (a) Happy path
  // -------------------------------------------------------------------------
  it('(a) happy path: returns StuckInspectionResult with 10 most recent events', async () => {
    const runId = 'run-gsi-happy';
    seedStuckRun(db, runId, 'no_progress');
    seedPendingApproval(db, runId, 'approval-gsi-1', 'Bash', JSON.stringify({ cmd: 'echo hi' }));
    const allIds = seedRawEvents(db, runId, 15);

    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const result = await caller.cyboflow.runs.getStuckInspection({ runId });

    expect(result.runId).toBe(runId);
    expect(result.stuckReason).toBe('no_progress');
    expect(result.stuckDetectedAt).not.toBeNull();

    // Exactly 10 events returned.
    expect(result.recentEvents).toHaveLength(10);

    // Descending id order.
    const returnedIds = result.recentEvents.map((e) => e.id);
    const sortedDesc = [...returnedIds].sort((a, b) => b - a);
    expect(returnedIds).toEqual(sortedDesc);

    // Top 10 of 15 inserted ids.
    const top10Ids = [...allIds].sort((a, b) => b - a).slice(0, 10);
    expect(returnedIds).toEqual(top10Ids);

    // Pending approval is present.
    expect(result.pendingApproval).not.toBeNull();
    expect(result.pendingApproval?.toolName).toBe('Bash');
    expect(result.pendingApproval?.input).toEqual({ cmd: 'echo hi' });
  });

  // -------------------------------------------------------------------------
  // (b) Unknown runId → NOT_FOUND
  // -------------------------------------------------------------------------
  it('(b) unknown runId → TRPCError NOT_FOUND', async () => {
    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));

    await expect(
      caller.cyboflow.runs.getStuckInspection({ runId: 'nonexistent-run-id' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND',
    );
  });

  // -------------------------------------------------------------------------
  // (c) Non-'local' userId → FORBIDDEN
  // -------------------------------------------------------------------------
  it('(c) non-local userId → TRPCError FORBIDDEN', async () => {
    const adapter = dbAdapter(db);
    // Bypass createContext by constructing the context object directly so we
    // can inject a non-'local' userId. The type cast is required because
    // createContext always returns userId: 'local' — here we test the guard.
    const ctx = {
      userId: 'someone-else' as 'local',
      setDockBadge: () => undefined,
      db: adapter,
    };
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.cyboflow.runs.getStuckInspection({ runId: 'any-run-id' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'FORBIDDEN',
    );
  });

  // -------------------------------------------------------------------------
  // (d) Missing ctx.db → PRECONDITION_FAILED
  // -------------------------------------------------------------------------
  it('(d) missing ctx.db → TRPCError PRECONDITION_FAILED', async () => {
    // createContext without db — db will be undefined.
    const caller = appRouter.createCaller(createContext());

    await expect(
      caller.cyboflow.runs.getStuckInspection({ runId: 'any-run-id' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
  });
});

// ---------------------------------------------------------------------------
// runs.list wrapper-layer integration tests (TASK-710)
//
// These tests target the tRPC-layer guards (FORBIDDEN, PRECONDITION_FAILED)
// that wrap the listRunsHandler call. Handler-level contracts (ordering,
// projectId scoping, policy_json exclusion) are covered by the unit tests in
// main/src/orchestrator/__tests__/listRunsHandler.test.ts.
// ---------------------------------------------------------------------------

describe('cyboflow.runs.list', () => {
  let db: Database.Database;

  beforeEach(() => {
    // createTestDb applies GATE_SCHEMA (migration 006 equivalent) with FK ON.
    db = createTestDb();
  });

  // -------------------------------------------------------------------------
  // (a) Happy path — seeded runs for projectId=1 are returned
  // -------------------------------------------------------------------------
  it('(a) happy path: returns seeded runs for the given projectId', async () => {
    seedRun(db, { id: 'run-list-1', projectId: 1 });
    seedRun(db, { id: 'run-list-2', projectId: 1 });
    // A run for a different project — must NOT appear.
    seedRun(db, { id: 'run-other-proj', projectId: 2 });

    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const result = await caller.cyboflow.runs.list({ projectId: 1 });

    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.id);
    expect(ids).toContain('run-list-1');
    expect(ids).toContain('run-list-2');
    expect(ids).not.toContain('run-other-proj');

    // policy_json must not appear on any returned row.
    for (const row of result) {
      expect(Object.keys(row)).not.toContain('policy_json');
    }
  });

  // -------------------------------------------------------------------------
  // (b) Non-'local' userId → FORBIDDEN
  // -------------------------------------------------------------------------
  it('(b) non-local userId → TRPCError FORBIDDEN', async () => {
    const adapter = dbAdapter(db);
    // Bypass createContext to inject a non-'local' userId; the type cast
    // mirrors the pattern used in the getStuckInspection FORBIDDEN test.
    const ctx = {
      userId: 'someone-else' as 'local',
      setDockBadge: () => undefined,
      db: adapter,
    };
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.cyboflow.runs.list({ projectId: 1 }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'FORBIDDEN',
    );
  });

  // -------------------------------------------------------------------------
  // (c) Missing ctx.db → PRECONDITION_FAILED
  // -------------------------------------------------------------------------
  it('(c) missing ctx.db → TRPCError PRECONDITION_FAILED', async () => {
    // createContext without db — db will be undefined.
    const caller = appRouter.createCaller(createContext());

    await expect(
      caller.cyboflow.runs.list({ projectId: 1 }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
  });
});
