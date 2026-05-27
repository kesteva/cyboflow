/**
 * Integration tests for the orchestrator tRPC approvals router (TASK-706).
 *
 * Tests exercise the live approvalsRouter procedures via createCaller, using
 * an in-memory SQLite database (GATE_SCHEMA), the dbAdapter fixture, and the
 * real ApprovalRouter singleton (reset between tests via _resetForTesting()).
 *
 * Tests:
 *  1. listPending: empty table returns []
 *  2. listPending: two pending rows ordered oldest-first (created_at ASC)
 *  3. approve(approvalId): resolves the in-flight decisionPromise with {behavior:'allow'}
 *  4. approve(unknownId): throws TRPCError code='NOT_FOUND'
 *  5. reject(approvalId, message): decisionPromise resolves to {behavior:'deny', message}
 *  6. reject(unknownId): throws TRPCError code='NOT_FOUND'
 *  7. approveRestOfRun(runId): returns { decided: N } for that run; other run untouched
 *  8. rejectRestOfRun(runId): returns { decided: N } for that run; other run untouched
 */
import { describe, it, expect, afterEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { ApprovalRouter } from '../../../approvalRouter';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import { createTestDb, seedRun, seedApproval } from '../../../__test_fixtures__/orchestratorTestDb';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  // Reset the ApprovalRouter singleton so each test starts fresh.
  ApprovalRouter._resetForTesting();
});

describe('cyboflow.approvals.listPending', () => {
  it('listPending returns [] when the approvals table is empty', async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));

    const result = await caller.cyboflow.approvals.listPending();
    expect(result).toEqual([]);
  });

  it('listPending returns shaped Approval[] rows oldest-first (created_at ASC)', async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);

    seedRun(db, { id: 'run-list-1' });
    seedRun(db, { id: 'run-list-2' });

    // Insert newer approval first so ordering by insertion is different from ORDER BY.
    const newerAt = '2026-01-01T00:00:02Z';
    const olderAt = '2026-01-01T00:00:01Z';
    seedApproval(db, { id: 'approval-newer', runId: 'run-list-1', toolName: 'Bash', toolInputJson: '{"cmd":"echo hi"}', createdAt: newerAt });
    seedApproval(db, { id: 'approval-older', runId: 'run-list-2', toolName: 'Bash', toolInputJson: '{"cmd":"echo hi"}', createdAt: olderAt });

    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const result = await caller.cyboflow.approvals.listPending();

    expect(result).toHaveLength(2);

    // Oldest first (created_at ASC).
    expect(result[0].id).toBe('approval-older');
    expect(result[1].id).toBe('approval-newer');

    // Check shaped fields on the first row.
    const first = result[0];
    expect(first.runId).toBe('run-list-2');
    expect(first.workflowName).toBe('test-workflow');
    expect(first.toolName).toBe('Bash');
    expect(first.payloadPreview).toBe('{"cmd":"echo hi"}');
    expect(first.rationale).toBeNull();
    expect(first.createdAt).toBe(new Date(olderAt).toISOString());
    expect(first.status).toBe('pending');
  });

  it('listPending truncates payloadPreview to 512 chars', async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);

    seedRun(db, { id: 'run-trunc' });
    const longInput = 'x'.repeat(600);
    seedApproval(db, { id: 'approval-trunc', runId: 'run-trunc', toolName: 'Bash', toolInputJson: longInput, createdAt: '2026-01-01T00:00:00Z' });

    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const [row] = await caller.cyboflow.approvals.listPending();
    expect(row.payloadPreview).toHaveLength(512);
    expect(row.payloadPreview).toBe(longInput.slice(0, 512));
  });
});

describe('cyboflow.approvals.approve', () => {
  it('approve(approvalId) resolves the in-flight decisionPromise with {behavior:"allow"}', async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    const router = ApprovalRouter.getInstance();

    seedRun(db, { id: 'run-approve' });

    // Register a pending approval — the promise will resolve when approve() is called.
    const decisionPromise = router.requestApproval(
      'run-approve',
      'Bash',
      { cmd: 'ls' },
      () => undefined,
    );

    // Retrieve the approval ID from the DB.
    const row = db
      .prepare(`SELECT id FROM approvals WHERE run_id = ? AND status = 'awaiting_review' OR status = 'pending' LIMIT 1`)
      .get('run-approve') as { id: string } | undefined;
    // The approvals row exists; the run is now awaiting_review.
    const runRow = db
      .prepare(`SELECT id FROM approvals WHERE run_id = ?`)
      .get('run-approve') as { id: string } | undefined;
    expect(runRow).toBeDefined();
    const approvalId = runRow!.id;

    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const approveResult = await caller.cyboflow.approvals.approve({ approvalId });
    expect(approveResult).toEqual({ success: true });

    // The decisionPromise should now be resolved.
    const decision = await decisionPromise;
    expect(decision).toEqual({ behavior: 'allow' });

    // DB row should reflect 'approved'.
    const dbRow = db
      .prepare(`SELECT status FROM approvals WHERE id = ?`)
      .get(approvalId) as { status: string };
    expect(dbRow.status).toBe('approved');

    // workflow_runs should be back to 'running'.
    const runStatus = db
      .prepare(`SELECT status FROM workflow_runs WHERE id = ?`)
      .get('run-approve') as { status: string };
    expect(runStatus.status).toBe('running');

    void row; // unused — suppress lint
  });

  it('approve(unknownId) throws TRPCError code=NOT_FOUND', async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);

    const caller = appRouter.createCaller(createContext({ db: adapter }));

    await expect(
      caller.cyboflow.approvals.approve({ approvalId: 'nonexistent-id' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND');
  });
});

describe('cyboflow.approvals.reject', () => {
  it('reject(approvalId, message) resolves the decisionPromise with {behavior:"deny", message}', async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    const approvalRouter = ApprovalRouter.getInstance();

    seedRun(db, { id: 'run-reject' });

    const decisionPromise = approvalRouter.requestApproval(
      'run-reject',
      'str_replace_editor',
      { path: '/tmp/test.txt' },
      () => undefined,
    );

    // Get the approval ID.
    const runRow = db
      .prepare(`SELECT id FROM approvals WHERE run_id = ?`)
      .get('run-reject') as { id: string } | undefined;
    expect(runRow).toBeDefined();
    const approvalId = runRow!.id;

    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const rejectResult = await caller.cyboflow.approvals.reject({
      approvalId,
      message: 'Too risky',
    });
    expect(rejectResult).toEqual({ success: true });

    const decision = await decisionPromise;
    expect(decision).toEqual({ behavior: 'deny', message: 'Too risky' });

    // DB row should reflect 'rejected'.
    const dbRow = db
      .prepare(`SELECT status FROM approvals WHERE id = ?`)
      .get(approvalId) as { status: string };
    expect(dbRow.status).toBe('rejected');

    // workflow_runs transitions back to 'running' so the agent can retry with
    // a different tool — denial is per-tool, not per-run.
    const runStatus = db
      .prepare(`SELECT status FROM workflow_runs WHERE id = ?`)
      .get('run-reject') as { status: string };
    expect(runStatus.status).toBe('running');
  });

  it('reject(unknownId) throws TRPCError code=NOT_FOUND', async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);

    const caller = appRouter.createCaller(createContext({ db: adapter }));

    await expect(
      caller.cyboflow.approvals.reject({ approvalId: 'nonexistent-id' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND');
  });
});

describe('cyboflow.approvals.approveRestOfRun', () => {
  it('approveRestOfRun returns { decided: N } and leaves other run untouched', async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);

    // Seed two runs with direct DB inserts (no ApprovalRouter needed here).
    seedRun(db, { id: 'run-arr-a' });
    seedRun(db, { id: 'run-arr-b' });

    // Insert 3 pending approvals for run-A and 2 for run-B.
    for (let i = 0; i < 3; i++) {
      seedApproval(db, { id: `arr-a-${i}`, runId: 'run-arr-a', toolName: 'Bash', toolInputJson: '{"cmd":"echo hi"}', createdAt: `2026-01-01T00:0${i}:00Z` });
    }
    for (let i = 0; i < 2; i++) {
      seedApproval(db, { id: `arr-b-${i}`, runId: 'run-arr-b', toolName: 'Bash', toolInputJson: '{"cmd":"echo hi"}', createdAt: `2026-01-01T00:0${i}:00Z` });
    }

    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const result = await caller.cyboflow.approvals.approveRestOfRun({ runId: 'run-arr-a' });
    expect(result).toEqual({ decided: 3 });

    // run-A's approvals are now 'approved'.
    for (let i = 0; i < 3; i++) {
      const row = db
        .prepare(`SELECT status FROM approvals WHERE id = ?`)
        .get(`arr-a-${i}`) as { status: string };
      expect(row.status).toBe('approved');
    }

    // run-B's approvals are still 'pending'.
    for (let i = 0; i < 2; i++) {
      const row = db
        .prepare(`SELECT status FROM approvals WHERE id = ?`)
        .get(`arr-b-${i}`) as { status: string };
      expect(row.status).toBe('pending');
    }
  });
});

describe('cyboflow.approvals.rejectRestOfRun', () => {
  it('rejectRestOfRun returns { decided: N } and leaves other run untouched', async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);

    seedRun(db, { id: 'run-rrr-a' });
    seedRun(db, { id: 'run-rrr-b' });

    for (let i = 0; i < 2; i++) {
      seedApproval(db, { id: `rrr-a-${i}`, runId: 'run-rrr-a', toolName: 'Bash', toolInputJson: '{"cmd":"echo hi"}', createdAt: `2026-01-01T00:0${i}:00Z` });
    }
    for (let i = 0; i < 3; i++) {
      seedApproval(db, { id: `rrr-b-${i}`, runId: 'run-rrr-b', toolName: 'Bash', toolInputJson: '{"cmd":"echo hi"}', createdAt: `2026-01-01T00:0${i}:00Z` });
    }

    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const result = await caller.cyboflow.approvals.rejectRestOfRun({ runId: 'run-rrr-a' });
    expect(result).toEqual({ decided: 2 });

    // run-A's approvals are 'rejected'.
    for (let i = 0; i < 2; i++) {
      const row = db
        .prepare(`SELECT status FROM approvals WHERE id = ?`)
        .get(`rrr-a-${i}`) as { status: string };
      expect(row.status).toBe('rejected');
    }

    // run-B's approvals are still 'pending'.
    for (let i = 0; i < 3; i++) {
      const row = db
        .prepare(`SELECT status FROM approvals WHERE id = ?`)
        .get(`rrr-b-${i}`) as { status: string };
      expect(row.status).toBe('pending');
    }
  });
});
