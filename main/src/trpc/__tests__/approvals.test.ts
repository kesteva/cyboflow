/**
 * Unit tests for the approveRestOfRun tRPC handler (TASK-406).
 *
 * Tests exercise `approveRestOfRunHandler` directly with an in-memory
 * better-sqlite3 instance — no tRPC wrapping, no Electron, no MCP bridge.
 *
 * Test cases:
 *  1. approveRestOfRun decides all pending approvals for the given runId and
 *     does NOT affect approvals from other runs.
 *  2. approveRestOfRun with a nonexistent runId returns { decided: 0 } and
 *     does not throw.
 *  3. Sweep: grep confirms no global approve-all symbol exists in the codebase.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { join } from 'path';
import { approveRestOfRunHandler, rejectRestOfRunHandler } from '../routers/approvals';
import { dbAdapter } from '../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb, seedRun, seedApproval } from '../../orchestrator/__test_fixtures__/orchestratorTestDb';

// ---------------------------------------------------------------------------
// Test-database helpers
// ---------------------------------------------------------------------------

/**
 * Seed helper: insert a workflow + workflow_run + N pending approvals.
 *
 * Returns the array of inserted approval IDs.
 */
function seedPendingApprovals(
  db: ReturnType<typeof createTestDb>,
  runId: string,
  count: number,
): string[] {
  seedRun(db, { id: runId });

  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const approvalId = `${runId}-approval-${i}`;
    ids.push(approvalId);
    seedApproval(db, { id: approvalId, runId, toolName: 'Bash' });
  }

  return ids;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('approveRestOfRun handler', () => {
  // -------------------------------------------------------------------------
  // Test 1: decides all pending for runId, does not affect other run's approvals
  // -------------------------------------------------------------------------
  it('approves all pending for run-A and leaves run-B pending', async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);

    // Seed 3 pending approvals in run-A and 2 in run-B.
    const runAIds = seedPendingApprovals(db, 'run-A', 3);
    const runBIds = seedPendingApprovals(db, 'run-B', 2);

    // Call approveRestOfRun for run-A only.
    const result = await approveRestOfRunHandler(adapter, 'run-A');
    expect(result).toEqual({ decided: 3 });

    // --- Assert: run-A's 3 approvals are now 'approved' ---
    for (const id of runAIds) {
      const row = db
        .prepare(`SELECT status FROM approvals WHERE id = ?`)
        .get(id) as { status: string };
      expect(row.status).toBe('approved');
    }

    // --- Assert: run-B's 2 approvals are still 'pending' ---
    for (const id of runBIds) {
      const row = db
        .prepare(`SELECT status FROM approvals WHERE id = ?`)
        .get(id) as { status: string };
      expect(row.status).toBe('pending');
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: nonexistent runId returns { decided: 0 } without throwing
  // -------------------------------------------------------------------------
  it('returns { decided: 0 } for a nonexistent runId without throwing', async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);

    const result = await approveRestOfRunHandler(adapter, 'nonexistent-run');
    expect(result).toEqual({ decided: 0 });
  });

  // -------------------------------------------------------------------------
  // Test 3: sweep — no global approve-all symbol in production source
  // -------------------------------------------------------------------------
  it('codebase contains no global approve-all symbol (sweep)', () => {
    // Run grep from the project root (process.cwd() in the main workspace is
    // the main/ package directory; we need to go one level up to the repo root).
    // The --exclude-dir=__tests__ flag prevents this test file's own assertion
    // strings from triggering a false positive.
    const repoRoot = join(process.cwd(), '..');
    const result = execSync(
      `grep -rn "approveAll\\|approve_all\\|approveGlobal" ` +
      `"${repoRoot}/main/src" "${repoRoot}/frontend/src" "${repoRoot}/shared/types" ` +
      `--exclude-dir=__tests__ || true`,
      { encoding: 'utf8' },
    );

    // The grep should return empty output (no matches outside test files).
    expect(result.trim()).toBe('');
  });
});

describe('rejectRestOfRun handler', () => {
  // -------------------------------------------------------------------------
  // Test 1: decides all pending for runId, does not affect other run's approvals
  // -------------------------------------------------------------------------
  it('rejects all pending for run-A and leaves run-B pending', async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);

    // Seed 3 pending approvals in run-A and 2 in run-B.
    const runAIds = seedPendingApprovals(db, 'run-A', 3);
    const runBIds = seedPendingApprovals(db, 'run-B', 2);

    // Call rejectRestOfRun for run-A only.
    const result = await rejectRestOfRunHandler(adapter, 'run-A');
    expect(result).toEqual({ decided: 3 });

    // --- Assert: run-A's 3 approvals are now 'rejected' ---
    for (const id of runAIds) {
      const row = db
        .prepare(`SELECT status FROM approvals WHERE id = ?`)
        .get(id) as { status: string };
      expect(row.status).toBe('rejected');
    }

    // --- Assert: run-B's 2 approvals are still 'pending' ---
    for (const id of runBIds) {
      const row = db
        .prepare(`SELECT status FROM approvals WHERE id = ?`)
        .get(id) as { status: string };
      expect(row.status).toBe('pending');
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: nonexistent runId returns { decided: 0 } without throwing
  // -------------------------------------------------------------------------
  it('returns { decided: 0 } for a nonexistent runId without throwing', async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);

    const result = await rejectRestOfRunHandler(adapter, 'nonexistent-run');
    expect(result).toEqual({ decided: 0 });
  });

  // -------------------------------------------------------------------------
  // Test 3: sweep — no global reject-all symbol in production source
  // -------------------------------------------------------------------------
  it('codebase contains no global reject-all symbol (sweep)', () => {
    // Run grep from the project root (process.cwd() in the main workspace is
    // the main/ package directory; we need to go one level up to the repo root).
    // The --exclude-dir=__tests__ flag prevents this test file's own assertion
    // strings from triggering a false positive.
    // cyboflowMcpServer.ts is excluded: its `rejectAllPending` function rejects
    // IPC socket requests — unrelated to the approvals system and predates this task.
    const repoRoot = join(process.cwd(), '..');
    const result = execSync(
      `grep -rn "rejectAll\\|reject_all\\|rejectGlobal" ` +
      `"${repoRoot}/main/src" "${repoRoot}/frontend/src" "${repoRoot}/shared/types" ` +
      `--exclude-dir=__tests__ --exclude=cyboflowMcpServer.ts || true`,
      { encoding: 'utf8' },
    );

    // The grep should return empty output (no matches outside test files).
    expect(result.trim()).toBe('');
  });
});

describe('decideRestOfRunHandler error logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test: approve branch — UPDATE failure logs with [approveRestOfRun] prefix
  // -------------------------------------------------------------------------
  it('logs [approveRestOfRun] prefix when UPDATE throws during approve', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const db = createTestDb();
    // Seed 2 pending approvals so we can force the second UPDATE to throw.
    const ids = seedPendingApprovals(db, 'run-err-approve', 2);

    // Wrap db.prepare so the second UPDATE call (for ids[1]) throws.
    let updateCallCount = 0;
    const realPrepare = db.prepare.bind(db);
    const wrappedDb = {
      prepare: (sql: string) => {
        const stmt = realPrepare(sql);
        if (sql.includes('SET status = ?')) {
          return {
            all: (...params: unknown[]) => stmt.all(...params),
            run: (...params: unknown[]) => {
              updateCallCount++;
              if (updateCallCount === 2) {
                throw new Error('simulated UPDATE failure');
              }
              return stmt.run(...params);
            },
          };
        }
        return stmt;
      },
    };

    const result = await approveRestOfRunHandler(wrappedDb, 'run-err-approve');

    // First approval succeeded, second threw — decided should be 1.
    expect(result).toEqual({ decided: 1 });

    // console.error was called once with the [approveRestOfRun] prefix.
    expect(errorSpy).toHaveBeenCalledOnce();
    const [msg] = errorSpy.mock.calls[0];
    expect(msg).toContain('[approveRestOfRun]');
    expect(msg).toContain(`Failed to approve ${ids[1]}`);
  });

  // -------------------------------------------------------------------------
  // Test: reject branch — UPDATE failure logs with [rejectRestOfRun] prefix
  // -------------------------------------------------------------------------
  it('logs [rejectRestOfRun] prefix when UPDATE throws during reject', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const db = createTestDb();
    // Seed 2 pending approvals so we can force the second UPDATE to throw.
    const ids = seedPendingApprovals(db, 'run-err-reject', 2);

    // Wrap db.prepare so the second UPDATE call (for ids[1]) throws.
    let updateCallCount = 0;
    const realPrepare = db.prepare.bind(db);
    const wrappedDb = {
      prepare: (sql: string) => {
        const stmt = realPrepare(sql);
        if (sql.includes('SET status = ?')) {
          return {
            all: (...params: unknown[]) => stmt.all(...params),
            run: (...params: unknown[]) => {
              updateCallCount++;
              if (updateCallCount === 2) {
                throw new Error('simulated UPDATE failure');
              }
              return stmt.run(...params);
            },
          };
        }
        return stmt;
      },
    };

    const result = await rejectRestOfRunHandler(wrappedDb, 'run-err-reject');

    // First approval succeeded, second threw — decided should be 1.
    expect(result).toEqual({ decided: 1 });

    // console.error was called once with the [rejectRestOfRun] prefix.
    expect(errorSpy).toHaveBeenCalledOnce();
    const [msg] = errorSpy.mock.calls[0];
    expect(msg).toContain('[rejectRestOfRun]');
    expect(msg).toContain(`Failed to reject ${ids[1]}`);
  });
});
