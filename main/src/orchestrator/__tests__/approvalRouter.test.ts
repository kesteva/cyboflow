/**
 * Unit tests for ApprovalRouter.
 *
 * Five cases per the test_strategy in the TASK-302 plan + TASK-302 code-review:
 *
 * 1. requestApproval inserts an approvals row (status='pending') and updates
 *    workflow_runs to status='awaiting_review' in a single transaction.
 *
 * 2. respond after run is canceled: status guard returns changes=0, socket
 *    reply is NOT invoked with 'allow'.
 *
 * 3. Two concurrent requestApproval calls for the same runId are serialized
 *    by the per-run p-queue — ordering preserved, no overlapping transactions.
 *
 * 4. respond with behavior='deny' updates approvals.status='rejected' and does
 *    NOT change workflow_runs.status (stays in awaiting_review).
 *
 * 5. Two concurrent respond(id, deny) calls — socketReply invoked exactly once
 *    (exactly-once contract, TASK-302 code-review fix).
 *
 * All tests use an in-memory better-sqlite3 instance and a real PQueue per
 * runId so transaction semantics and queue serialization are exercised
 * end-to-end without spinning up Electron or the MCP bridge.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import PQueue from 'p-queue';
import { ApprovalRouter, RunNotRunningError, type ApprovalDecision } from '../approvalRouter';
import type { DatabaseLike } from '../types';

// ---------------------------------------------------------------------------
// Test-database helpers
// ---------------------------------------------------------------------------

// Vitest transforms TS via Vite; in CJS mode __dirname resolves to the
// vitest runner's working directory (project root), not the source file
// directory.  Resolve the schema relative to process.cwd() which is
// always the main/ workspace root.
const SCHEMA_PATH = join(
  process.cwd(),
  'src/database/migrations/006_cyboflow_schema.sql',
);

/** Creates a fresh in-memory SQLite database with the cyboflow schema applied. */
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // The schema creates several tables; run it as-is.
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

/**
 * Build a DatabaseLike adapter over a better-sqlite3 instance.
 * This mirrors the inline adapter in main/src/index.ts.
 */
function dbAdapter(db: Database.Database): DatabaseLike {
  return {
    prepare: (sql) => db.prepare(sql),
    // The DatabaseLike.transaction<T> generic cannot be inferred from the
    // concrete better-sqlite3 Transaction return.  We satisfy the type with a
    // cast at the adapter boundary; the runtime behaviour is identical — both
    // return a callable that wraps fn in a BEGIN…COMMIT block.
    transaction: <T>(fn: (...args: unknown[]) => T) =>
      db.transaction(fn as (...args: unknown[]) => T) as (...args: unknown[]) => T,
  };
}

/** Seed a workflow_runs row so requestApproval has something to UPDATE. */
function seedRun(
  db: Database.Database,
  id: string,
  status: 'running' | 'awaiting_review' | 'canceled' | 'completed' | 'failed',
): void {
  // Insert a placeholder workflow first (FK constraint).
  const workflowId = `workflow-${id}`;
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json)
     VALUES (?, 1, 'test-workflow', '{}')`,
  ).run(workflowId);

  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, worktree_path, status, policy_json)
     VALUES (?, ?, 1, '/tmp/test', ?, '{}')`,
  ).run(id, workflowId, status);
}

// ---------------------------------------------------------------------------
// Per-run queue registry (real PQueue — no mocks)
// ---------------------------------------------------------------------------

function makeQueueFactory(): { getOrCreate: (runId: string) => PQueue; queues: Map<string, PQueue> } {
  const queues = new Map<string, PQueue>();
  return {
    queues,
    getOrCreate(runId: string): PQueue {
      let q = queues.get(runId);
      if (!q) {
        q = new PQueue({ concurrency: 1 });
        queues.set(runId, q);
      }
      return q;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ApprovalRouter', () => {
  // Reset the singleton between tests so each test gets a clean instance.
  afterEach(() => {
    ApprovalRouter._resetForTesting();
  });

  // -------------------------------------------------------------------------
  // Case 1: requestApproval inserts approvals row + updates workflow_runs
  //         inside a single transaction
  // -------------------------------------------------------------------------
  it('requestApproval inserts approvals (pending) and sets workflow_runs to awaiting_review', async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const qf = makeQueueFactory();
    const noopSocketReply = vi.fn<(decision: ApprovalDecision) => void>();

    const router = ApprovalRouter.initialize(adapter, qf.getOrCreate.bind(qf));

    const runId = 'run-001';
    seedRun(db, runId, 'running');

    // Fire requestApproval — do NOT await the full decision; we just want the
    // transaction to have committed so we can inspect DB state.
    const approvalPromise = router.requestApproval(runId, 'bash', { cmd: 'ls' }, noopSocketReply);

    // Wait for the queue task to complete (transaction committed) by yielding
    // a few microtask ticks, then inspect the DB.  We wait until the queue
    // for this run is idle to be deterministic.
    await qf.getOrCreate(runId).onIdle();

    // --- Assert: workflow_runs updated ---
    const run = db
      .prepare("SELECT status FROM workflow_runs WHERE id = ?")
      .get(runId) as { status: string };
    expect(run.status).toBe('awaiting_review');

    // --- Assert: approvals row created ---
    const approval = db
      .prepare("SELECT tool_name, status FROM approvals WHERE run_id = ?")
      .get(runId) as { tool_name: string; status: string } | undefined;
    expect(approval).toBeDefined();
    expect(approval?.tool_name).toBe('bash');
    expect(approval?.status).toBe('pending');

    // Resolve the pending decision so the test can clean up.
    const approvalId = (db
      .prepare("SELECT id FROM approvals WHERE run_id = ?")
      .get(runId) as { id: string }).id;
    await router.respond(approvalId, { behavior: 'allow' });
    await approvalPromise;
  });

  // -------------------------------------------------------------------------
  // Case 2: respond after run is canceled → status guard (changes=0),
  //         socketReply NOT called with 'allow'
  // -------------------------------------------------------------------------
  it('respond (allow) after run is canceled does NOT call socketReply with allow', async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const qf = makeQueueFactory();
    const socketReply = vi.fn<(decision: ApprovalDecision) => void>();

    const router = ApprovalRouter.initialize(adapter, qf.getOrCreate.bind(qf));

    const runId = 'run-002';
    seedRun(db, runId, 'running');

    // Start the approval request (does not block on decision — the returned
    // promise resolves only when respond() is called).
    const approvalPromise = router.requestApproval(runId, 'write_file', { path: '/tmp/x' }, socketReply);

    // Wait for the queue to be idle so the transaction has committed.
    await qf.getOrCreate(runId).onIdle();

    // --- Simulate a concurrent cancel OUTSIDE the queue ---
    // This is the race: the run is canceled between requestApproval and respond.
    // We bypass the queue here (just like a cancel handler would) to test the
    // status guard in respond().
    db.prepare(
      `UPDATE workflow_runs SET status = 'canceled', updated_at = datetime('now')
       WHERE id = ?`,
    ).run(runId);

    // Verify cancel took effect.
    const runAfterCancel = db
      .prepare("SELECT status FROM workflow_runs WHERE id = ?")
      .get(runId) as { status: string };
    expect(runAfterCancel.status).toBe('canceled');

    // --- Retrieve the approvalId from DB ---
    const approvalId = (db
      .prepare("SELECT id FROM approvals WHERE run_id = ?")
      .get(runId) as { id: string }).id;

    // --- Respond with allow — the status guard should block the socket write ---
    await router.respond(approvalId, { behavior: 'allow' });

    // The promise should resolve with a synthetic deny (not hang).
    const finalDecision = await approvalPromise;
    expect(finalDecision.behavior).toBe('deny');

    // socketReply MUST NOT have been called with allow.
    for (const call of socketReply.mock.calls) {
      expect(call[0].behavior).not.toBe('allow');
    }

    // The approvals row should be marked 'rejected' (superseded → rejected in schema).
    const approval = db
      .prepare("SELECT status FROM approvals WHERE id = ?")
      .get(approvalId) as { status: string };
    expect(approval.status).toBe('rejected');
  });

  // -------------------------------------------------------------------------
  // Case 3: Two concurrent requestApproval calls for the same runId are
  //         serialized by the per-run p-queue — ordering preserved
  // -------------------------------------------------------------------------
  it('two concurrent requestApproval calls for the same runId are serialized by the queue', async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const qf = makeQueueFactory();

    // Track call order inside the transaction to confirm serialization.
    const transactionOrder: number[] = [];

    // Wrap the prepare so we can spy on UPDATE workflow_runs calls.
    // We do this by creating two separate runs and confirming each finishes
    // before the next starts (via queue ordering).
    const router = ApprovalRouter.initialize(adapter, qf.getOrCreate.bind(qf));

    const runId = 'run-003'; // Same runId for both requests.
    seedRun(db, runId, 'running');

    // Collect socket reply calls to track call order.
    const replyOrder: number[] = [];
    const socketReply1 = vi.fn<(decision: ApprovalDecision) => void>(() => { replyOrder.push(1); });
    const socketReply2 = vi.fn<(decision: ApprovalDecision) => void>(() => { replyOrder.push(2); });

    // Fire both requestApprovals concurrently (don't await).
    // The first call will transition run-003 to 'awaiting_review'.
    // The second call should fail with RunNotRunningError (since the first already
    // moved it out of 'running') — this is the correct serialized behavior.
    const promise1 = router.requestApproval(runId, 'tool_a', {}, socketReply1);
    const promise2 = router.requestApproval(runId, 'tool_b', {}, socketReply2);

    // Wait for both queue tasks to drain.
    await qf.getOrCreate(runId).onIdle();

    // promise1 is waiting for respond(); promise2 should have thrown.
    // Retrieve approval ID for the first (successful) request.
    const approvalRows = db
      .prepare("SELECT id, tool_name FROM approvals WHERE run_id = ?")
      .all(runId) as { id: string; tool_name: string }[];

    // Only one approval row should have been inserted (the second was blocked).
    expect(approvalRows).toHaveLength(1);
    expect(approvalRows[0].tool_name).toBe('tool_a');

    // Resolve the first approval.
    await router.respond(approvalRows[0].id, { behavior: 'allow' });
    await promise1;

    // promise2 should have rejected with RunNotRunningError.
    await expect(promise2).rejects.toBeInstanceOf(RunNotRunningError);
  });

  // -------------------------------------------------------------------------
  // Case 4: respond with behavior='deny' updates approvals to 'rejected'
  //         and does NOT change workflow_runs.status
  // -------------------------------------------------------------------------
  it("respond deny updates approvals to 'rejected' and does NOT touch workflow_runs.status", async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const qf = makeQueueFactory();
    const socketReply = vi.fn<(decision: ApprovalDecision) => void>();

    const router = ApprovalRouter.initialize(adapter, qf.getOrCreate.bind(qf));

    const runId = 'run-004';
    seedRun(db, runId, 'running');

    const approvalPromise = router.requestApproval(runId, 'dangerous_tool', { force: true }, socketReply);

    // Wait for the transaction to commit.
    await qf.getOrCreate(runId).onIdle();

    // Confirm run is now awaiting_review.
    const runAfterRequest = db
      .prepare("SELECT status FROM workflow_runs WHERE id = ?")
      .get(runId) as { status: string };
    expect(runAfterRequest.status).toBe('awaiting_review');

    // Get the approvalId.
    const approvalId = (db
      .prepare("SELECT id FROM approvals WHERE run_id = ?")
      .get(runId) as { id: string }).id;

    // Respond with deny.
    await router.respond(approvalId, { behavior: 'deny', message: 'Not allowed' });
    const decision = await approvalPromise;
    expect(decision.behavior).toBe('deny');

    // socketReply should have been called with the deny decision.
    expect(socketReply).toHaveBeenCalledOnce();
    expect(socketReply.mock.calls[0][0].behavior).toBe('deny');

    // approvals row should be 'rejected'.
    const approval = db
      .prepare("SELECT status FROM approvals WHERE id = ?")
      .get(approvalId) as { status: string };
    expect(approval.status).toBe('rejected');

    // workflow_runs.status must NOT have changed back to 'running' (stays awaiting_review).
    const runAfterDeny = db
      .prepare("SELECT status FROM workflow_runs WHERE id = ?")
      .get(runId) as { status: string };
    expect(runAfterDeny.status).toBe('awaiting_review');
  });

  // -------------------------------------------------------------------------
  // Case 5: Two concurrent respond(id, deny) calls — socketReply exactly once
  //         (TASK-302 code-review fix: reservation must happen inside the queue)
  // -------------------------------------------------------------------------
  it('two concurrent respond(deny) calls invoke socketReply exactly once', async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const qf = makeQueueFactory();
    const socketReply = vi.fn<(decision: ApprovalDecision) => void>();

    const router = ApprovalRouter.initialize(adapter, qf.getOrCreate.bind(qf));

    const runId = 'run-005';
    seedRun(db, runId, 'running');

    // Start the approval request.
    const approvalPromise = router.requestApproval(runId, 'shell', { cmd: 'rm -rf /' }, socketReply);

    // Wait for the transaction to commit so the approval is in pending.
    await qf.getOrCreate(runId).onIdle();

    // Retrieve the approvalId.
    const approvalId = (db
      .prepare("SELECT id FROM approvals WHERE run_id = ?")
      .get(runId) as { id: string }).id;

    // Fire TWO concurrent respond(deny) calls without awaiting either.
    // One must win; the other must be a silent no-op (not throw, not double-call).
    const [result1, result2] = await Promise.allSettled([
      router.respond(approvalId, { behavior: 'deny', message: 'concurrent-1' }),
      router.respond(approvalId, { behavior: 'deny', message: 'concurrent-2' }),
    ]);

    // Both settle — the second may resolve (silent no-op) or reject if it hits
    // the fast-path guard before the first even starts.  Either is acceptable;
    // what matters is that socketReply was called exactly once.
    // If the second respond() raced past the fast-path guard and entered the
    // queue, it finds the entry already deleted and returns as a no-op (fulfilled).
    // If the first respond() completed before the second even called pending.get(),
    // the second hits the fast-path and throws ApprovalNotFoundError (rejected).
    // Assert that at least one settled as fulfilled.
    const fulfilledCount = [result1, result2].filter((r) => r.status === 'fulfilled').length;
    expect(fulfilledCount).toBeGreaterThanOrEqual(1);

    // The load-bearing assertion: socketReply must have been called exactly once.
    expect(socketReply).toHaveBeenCalledTimes(1);
    expect(socketReply.mock.calls[0][0].behavior).toBe('deny');

    // The approvals row must be 'rejected'.
    const approval = db
      .prepare("SELECT status FROM approvals WHERE id = ?")
      .get(approvalId) as { status: string };
    expect(approval.status).toBe('rejected');

    // Await the original requestApproval promise — should resolve with 'deny'.
    const finalDecision = await approvalPromise;
    expect(finalDecision.behavior).toBe('deny');
  });

  // -------------------------------------------------------------------------
  // Case 6: respond(allow) happy path — approvals set to 'approved',
  //         workflow_runs back to 'running', socketReply called with allow
  // -------------------------------------------------------------------------
  it("respond(allow) on a non-canceled run marks approvals 'approved', run 'running', calls socketReply with allow", async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const qf = makeQueueFactory();
    const socketReply = vi.fn<(decision: ApprovalDecision) => void>();

    const router = ApprovalRouter.initialize(adapter, qf.getOrCreate.bind(qf));

    const runId = 'run-006';
    seedRun(db, runId, 'running');

    const approvalPromise = router.requestApproval(runId, 'read_file', { path: '/etc/hosts' }, socketReply);
    await qf.getOrCreate(runId).onIdle();

    // Confirm intermediate state.
    const runMid = db
      .prepare("SELECT status FROM workflow_runs WHERE id = ?")
      .get(runId) as { status: string };
    expect(runMid.status).toBe('awaiting_review');

    const approvalId = (db
      .prepare("SELECT id FROM approvals WHERE run_id = ?")
      .get(runId) as { id: string }).id;

    // Respond with allow (run not canceled — changes > 0 path).
    await router.respond(approvalId, { behavior: 'allow' });
    const decision = await approvalPromise;

    // The returned decision must be allow.
    expect(decision.behavior).toBe('allow');

    // socketReply must have been called exactly once with allow.
    expect(socketReply).toHaveBeenCalledOnce();
    expect(socketReply.mock.calls[0][0].behavior).toBe('allow');

    // approvals row must be 'approved'.
    const approval = db
      .prepare("SELECT status FROM approvals WHERE id = ?")
      .get(approvalId) as { status: string };
    expect(approval.status).toBe('approved');

    // workflow_runs must be back to 'running'.
    const runAfter = db
      .prepare("SELECT status FROM workflow_runs WHERE id = ?")
      .get(runId) as { status: string };
    expect(runAfter.status).toBe('running');
  });

  // -------------------------------------------------------------------------
  // Case 7: getPending() reflects in-flight approvals and clears after respond
  // -------------------------------------------------------------------------
  it('getPending returns in-flight approvals and is empty after respond', async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const qf = makeQueueFactory();
    const socketReply = vi.fn<(decision: ApprovalDecision) => void>();

    const router = ApprovalRouter.initialize(adapter, qf.getOrCreate.bind(qf));

    const runId = 'run-007';
    seedRun(db, runId, 'running');

    // Before any request, pending list is empty.
    expect(router.getPending()).toHaveLength(0);

    const approvalPromise = router.requestApproval(runId, 'write_file', { path: '/tmp/out' }, socketReply);
    await qf.getOrCreate(runId).onIdle();

    // After transaction commits, one entry should be visible.
    const pending = router.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].runId).toBe(runId);
    expect(pending[0].toolName).toBe('write_file');

    // After respond, the entry must be removed.
    await router.respond(pending[0].id, { behavior: 'deny' });
    await approvalPromise;

    expect(router.getPending()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Case 8: 'approvalCreated' event is emitted after the transaction commits
  // -------------------------------------------------------------------------
  // (Case 8 below — Cases 9-11 cover clearPendingForRun)
  it("emits 'approvalCreated' event after requestApproval transaction commits", async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const qf = makeQueueFactory();
    const socketReply = vi.fn<(decision: ApprovalDecision) => void>();

    const router = ApprovalRouter.initialize(adapter, qf.getOrCreate.bind(qf));

    const runId = 'run-008';
    seedRun(db, runId, 'running');

    const emittedRequests: unknown[] = [];
    router.on('approvalCreated', (req) => { emittedRequests.push(req); });

    const approvalPromise = router.requestApproval(runId, 'bash', { cmd: 'echo hi' }, socketReply);
    await qf.getOrCreate(runId).onIdle();

    // One event should have fired after the transaction committed.
    expect(emittedRequests).toHaveLength(1);
    const emitted = emittedRequests[0] as { runId: string; toolName: string };
    expect(emitted.runId).toBe(runId);
    expect(emitted.toolName).toBe('bash');

    // Clean up.
    const approvalId = (db
      .prepare("SELECT id FROM approvals WHERE run_id = ?")
      .get(runId) as { id: string }).id;
    await router.respond(approvalId, { behavior: 'allow' });
    await approvalPromise;
  });

  // -------------------------------------------------------------------------
  // Case 9: clearPendingForRun resolves in-flight entry with deny,
  //         socketReply NOT called, DB row updated to 'rejected'
  // -------------------------------------------------------------------------
  it('clearPendingForRun resolves in-flight pending entry with deny; socketReply NOT called; DB row rejected', async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const qf = makeQueueFactory();
    const socketReply = vi.fn<(decision: ApprovalDecision) => void>();

    const router = ApprovalRouter.initialize(adapter, qf.getOrCreate.bind(qf));

    const runId = 'run-009';
    seedRun(db, runId, 'running');

    // Start an approval request — do not await the decision yet.
    const approvalPromise = router.requestApproval(runId, 'bash', { cmd: 'echo hi' }, socketReply);

    // Wait for the transaction to commit so the entry is in this.pending.
    await qf.getOrCreate(runId).onIdle();

    // Confirm the entry is in-flight.
    expect(router.getPending()).toHaveLength(1);

    // Simulate run termination.
    router.clearPendingForRun(runId);

    // The awaiting promise must resolve (not hang) with a deny-shaped decision.
    const decision = await approvalPromise;
    expect(decision.behavior).toBe('deny');
    expect(decision.message).toMatch(/terminated/i);

    // socketReply must NOT have been called.
    expect(socketReply.mock.calls).toHaveLength(0);

    // getPending() must be empty.
    expect(router.getPending()).toHaveLength(0);

    // DB row must be 'rejected' with decided_by='system'.
    const approvalId = (db
      .prepare("SELECT id FROM approvals WHERE run_id = ?")
      .get(runId) as { id: string }).id;
    const approval = db
      .prepare("SELECT status, decided_by FROM approvals WHERE id = ?")
      .get(approvalId) as { status: string; decided_by: string };
    expect(approval.status).toBe('rejected');
    expect(approval.decided_by).toBe('system');
  });

  // -------------------------------------------------------------------------
  // Case 10: clearPendingForRun on a runId with zero pending entries is a
  //          silent no-op
  // -------------------------------------------------------------------------
  it('clearPendingForRun on a runId with no pending entries is a silent no-op', () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const qf = makeQueueFactory();

    const router = ApprovalRouter.initialize(adapter, qf.getOrCreate.bind(qf));

    // No entries in pending — clearPendingForRun must not throw and must be
    // a no-op (no DB writes, no errors).
    expect(() => router.clearPendingForRun('run-nonexistent')).not.toThrow();
    expect(router.getPending()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Case 11: Two pending entries for different runIds — clearPendingForRun
  //          only clears the targeted run; the other entry remains intact
  // -------------------------------------------------------------------------
  it('clearPendingForRun only clears the targeted runId; unrelated entries remain intact', async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const qf = makeQueueFactory();
    const socketReplyA = vi.fn<(decision: ApprovalDecision) => void>();
    const socketReplyB = vi.fn<(decision: ApprovalDecision) => void>();

    const router = ApprovalRouter.initialize(adapter, qf.getOrCreate.bind(qf));

    const runIdA = 'run-101A';
    const runIdB = 'run-101B';
    seedRun(db, runIdA, 'running');
    seedRun(db, runIdB, 'running');

    // Register two approval requests for two DIFFERENT runs.
    const promiseA = router.requestApproval(runIdA, 'tool_a', {}, socketReplyA);
    const promiseB = router.requestApproval(runIdB, 'tool_b', {}, socketReplyB);

    // Wait for both queue tasks to commit.
    await Promise.all([
      qf.getOrCreate(runIdA).onIdle(),
      qf.getOrCreate(runIdB).onIdle(),
    ]);

    expect(router.getPending()).toHaveLength(2);

    // Clear only run-101A.
    router.clearPendingForRun(runIdA);

    // promiseA should resolve with deny.
    const decisionA = await promiseA;
    expect(decisionA.behavior).toBe('deny');
    expect(decisionA.message).toMatch(/terminated/i);

    // socketReplyA must NOT have been called.
    expect(socketReplyA.mock.calls).toHaveLength(0);

    // run-101B entry must still be in-flight.
    const stillPending = router.getPending();
    expect(stillPending).toHaveLength(1);
    expect(stillPending[0].runId).toBe(runIdB);

    // DB row for run-101A must be rejected.
    const approvalA = db
      .prepare("SELECT status FROM approvals WHERE run_id = ?")
      .get(runIdA) as { status: string };
    expect(approvalA.status).toBe('rejected');

    // DB row for run-101B must still be pending.
    const approvalB = db
      .prepare("SELECT status FROM approvals WHERE run_id = ?")
      .get(runIdB) as { status: string };
    expect(approvalB.status).toBe('pending');

    // socketReplyB also not called (no decision yet).
    expect(socketReplyB.mock.calls).toHaveLength(0);

    // Clean up: resolve run-101B so the test can finish.
    const approvalIdB = (db
      .prepare("SELECT id FROM approvals WHERE run_id = ?")
      .get(runIdB) as { id: string }).id;
    await router.respond(approvalIdB, { behavior: 'deny' });
    await promiseB;
  });

  // -------------------------------------------------------------------------
  // Case 12: Two pending entries for the SAME runId — clearPendingForRun
  //          rejects both (exercises the loop in clearPendingForRun).
  //
  //  Production code prevents two simultaneous requestApproval calls from
  //  landing in this.pending for the same runId (the second throws
  //  RunNotRunningError because the run is already in 'awaiting_review').
  //  To reach the multi-entry path we manually reset the workflow_run status
  //  between the two requests, bypassing the guard — a valid unit-test
  //  technique since clearPendingForRun must handle whatever is in the Map.
  // -------------------------------------------------------------------------
  it('clearPendingForRun with two pending entries for the same runId rejects both', async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const qf = makeQueueFactory();
    const socketReply1 = vi.fn<(decision: ApprovalDecision) => void>();
    const socketReply2 = vi.fn<(decision: ApprovalDecision) => void>();

    const router = ApprovalRouter.initialize(adapter, qf.getOrCreate.bind(qf));

    const runId = 'run-012';
    seedRun(db, runId, 'running');

    // First requestApproval — moves run to 'awaiting_review'.
    const promise1 = router.requestApproval(runId, 'tool_x', {}, socketReply1);
    await qf.getOrCreate(runId).onIdle();

    // Manually reset the run back to 'running' so a second requestApproval can
    // succeed (bypasses the production guard — intentional for this unit test).
    db.prepare(
      `UPDATE workflow_runs SET status = 'running' WHERE id = ?`,
    ).run(runId);

    // Second requestApproval — also lands in this.pending.
    const promise2 = router.requestApproval(runId, 'tool_y', {}, socketReply2);
    await qf.getOrCreate(runId).onIdle();

    // Two entries should be in-flight.
    expect(router.getPending()).toHaveLength(2);

    // Simulate run termination.
    router.clearPendingForRun(runId);

    // Both promises must resolve with deny.
    const [decision1, decision2] = await Promise.all([promise1, promise2]);
    expect(decision1.behavior).toBe('deny');
    expect(decision1.message).toMatch(/terminated/i);
    expect(decision2.behavior).toBe('deny');
    expect(decision2.message).toMatch(/terminated/i);

    // Neither socketReply must have been called.
    expect(socketReply1.mock.calls).toHaveLength(0);
    expect(socketReply2.mock.calls).toHaveLength(0);

    // getPending() must be empty.
    expect(router.getPending()).toHaveLength(0);

    // Both DB rows must be 'rejected' with decided_by='system'.
    const approvals = db
      .prepare("SELECT status, decided_by FROM approvals WHERE run_id = ? ORDER BY created_at")
      .all(runId) as { status: string; decided_by: string }[];
    expect(approvals).toHaveLength(2);
    for (const row of approvals) {
      expect(row.status).toBe('rejected');
      expect(row.decided_by).toBe('system');
    }
  });

  // -------------------------------------------------------------------------
  // Case 13: DB error during clearPendingForRun is swallowed — the method
  //          does NOT throw and the awaiting Promise still resolves with deny.
  //
  //  The clearPendingForRun body wraps the DB UPDATE in try/catch and logs a
  //  console.warn instead of re-throwing.  This invariant is critical:
  //  termination must not propagate a DB error up into the runSdkQuery
  //  finally block and corrupt the cleanup chain.
  // -------------------------------------------------------------------------
  it('clearPendingForRun swallows a DB error and still resolves the pending promise with deny', async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const qf = makeQueueFactory();
    const socketReply = vi.fn<(decision: ApprovalDecision) => void>();

    // Inject a DB adapter whose prepare() throws for UPDATE approvals statements
    // but delegates everything else to the real DB so requestApproval can seed
    // the entry normally.
    const faultyAdapter: DatabaseLike = {
      prepare(sql: string) {
        // Throw only on the guarded UPDATE issued by clearPendingForRun.
        if (
          sql.includes("SET status = 'rejected'") &&
          sql.includes("decided_by = 'system'")
        ) {
          throw new Error('simulated DB failure in clearPendingForRun');
        }
        return db.prepare(sql);
      },
      transaction: <T>(fn: (...args: unknown[]) => T) =>
        db.transaction(fn as (...args: unknown[]) => T) as (...args: unknown[]) => T,
    };

    const router = ApprovalRouter.initialize(faultyAdapter, qf.getOrCreate.bind(qf));

    const runId = 'run-013';
    seedRun(db, runId, 'running');

    const approvalPromise = router.requestApproval(runId, 'bash', { cmd: 'echo test' }, socketReply);
    await qf.getOrCreate(runId).onIdle();

    expect(router.getPending()).toHaveLength(1);

    // clearPendingForRun must not throw even though the DB call throws.
    expect(() => router.clearPendingForRun(runId)).not.toThrow();

    // The approval promise must still resolve with deny (not hang, not reject).
    const decision = await approvalPromise;
    expect(decision.behavior).toBe('deny');
    expect(decision.message).toMatch(/terminated/i);

    // The entry must have been removed from pending despite the DB error.
    expect(router.getPending()).toHaveLength(0);

    // socketReply must NOT have been called.
    expect(socketReply.mock.calls).toHaveLength(0);
  });
});
