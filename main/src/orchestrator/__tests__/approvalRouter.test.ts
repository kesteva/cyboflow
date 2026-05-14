/**
 * Unit tests for ApprovalRouter.
 *
 * Four cases per the test_strategy in the TASK-302 plan:
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
});
