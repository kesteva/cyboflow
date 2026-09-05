/**
 * Unit tests for the approveRestOfRun and rejectRestOfRun handler functions.
 *
 * Tests exercise `approveRestOfRunHandler` / `rejectRestOfRunHandler` directly
 * with an in-memory better-sqlite3 instance — no tRPC wrapping, no Electron,
 * no MCP bridge.
 *
 * This file was migrated from main/src/trpc/__tests__/approvals.test.ts in
 * TASK-717 (legacy-tree deletion).  The handlers now live in
 * main/src/orchestrator/trpc/routers/approvals.ts.
 *
 * For tRPC-level integration tests (listPending, approve, reject,
 * approveRestOfRun, rejectRestOfRun via createCaller) see
 * main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts.
 *
 * Test cases:
 *  1. approveRestOfRun decides all pending approvals for the given runId and
 *     does NOT affect approvals from other runs.
 *  2. approveRestOfRun with a nonexistent runId returns { decided: 0 } and
 *     does not throw.
 *  3. Sweep: grep confirms no global approve-all symbol exists in the codebase.
 *  4. rejectRestOfRun decides all pending approvals for the given runId and
 *     does NOT affect approvals from other runs.
 *  5. rejectRestOfRun with a nonexistent runId returns { decided: 0 } and
 *     does not throw.
 *  6. Sweep: grep confirms no global reject-all symbol exists in the codebase.
 *  7. approve branch — UPDATE failure logs with [approveRestOfRun] prefix.
 *  8. reject branch — UPDATE failure logs with [rejectRestOfRun] prefix.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync, readFileSync, type Dirent } from 'fs';
import { join } from 'path';
import { approveRestOfRunHandler, rejectRestOfRunHandler } from '../routers/approvals';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { createTestDb, seedRun, seedApproval } from '../../__test_fixtures__/orchestratorTestDb';

/**
 * Sweep the repo's source trees for any of `patterns` and return the matches
 * (a `file:line:line-text` report, one per line, like grep -n).
 *
 * Pure Node rather than an external grep binary (absent on Windows) or
 * `git grep` (a linked worktree's .git pointer can carry a gitdir path that
 * only the creating host resolves, so a subprocess git cannot be assumed to
 * work here). Walks main/src, frontend/src and shared/types, skipping
 * `__tests__` trees (this file's own assertion strings would self-match) and
 * `excludeFiles` (repo-relative POSIX paths). Returns '' when nothing matches.
 */
function sweepSourceFor(patterns: string[], excludeFiles: string[] = []): string {
  const repoRoot = join(process.cwd(), '..');
  const excluded = new Set(excludeFiles);
  const matches: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = `${rel}${rel ? '/' : ''}${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(join(dir, entry.name), relPath);
        continue;
      }
      if (entry.isFile() && /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(entry.name)) {
        if (excluded.has(relPath)) continue;
        const text = readFileSync(join(dir, entry.name), 'utf8');
        text.split('\n').forEach((line, i) => {
          if (patterns.some((p) => line.includes(p))) {
            matches.push(`${relPath}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }
  };
  for (const dir of ['main/src', 'frontend/src', 'shared/types']) {
    walk(join(repoRoot, ...dir.split('/')), dir);
  }
  return matches.join('\n');
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
    seedRun(db, { id: 'run-A' });
    const runAIds = [0, 1, 2].map((i) => {
      const id = `run-A-approval-${i}`;
      seedApproval(db, { id, runId: 'run-A', toolName: 'Bash' });
      return id;
    });
    seedRun(db, { id: 'run-B' });
    const runBIds = [0, 1].map((i) => {
      const id = `run-B-approval-${i}`;
      seedApproval(db, { id, runId: 'run-B', toolName: 'Bash' });
      return id;
    });

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
    // The --exclude-dir=__tests__ flag prevents this test file's own assertion
    // strings from triggering a false positive.
    const result = sweepSourceFor(['approveAll', 'approve_all', 'approveGlobal']);

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
    seedRun(db, { id: 'run-A' });
    const runAIds = [0, 1, 2].map((i) => {
      const id = `run-A-approval-${i}`;
      seedApproval(db, { id, runId: 'run-A', toolName: 'Bash' });
      return id;
    });
    seedRun(db, { id: 'run-B' });
    const runBIds = [0, 1].map((i) => {
      const id = `run-B-approval-${i}`;
      seedApproval(db, { id, runId: 'run-B', toolName: 'Bash' });
      return id;
    });

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
    const result = sweepSourceFor(
      ['rejectAll', 'reject_all', 'rejectGlobal'],
      ['main/src/orchestrator/mcpServer/cyboflowMcpServer.ts'],
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
    seedRun(db, { id: 'run-err-approve' });
    const ids = [0, 1].map((i) => {
      const id = `run-err-approve-approval-${i}`;
      seedApproval(db, { id, runId: 'run-err-approve', toolName: 'Bash' });
      return id;
    });

    // Wrap db.prepare so the second UPDATE call (for ids[1]) throws.
    let updateCallCount = 0;
    const realPrepare = db.prepare.bind(db);
    const wrappedDb = {
      prepare: (sql: string) => {
        const stmt = realPrepare(sql);
        if (sql.includes('SET status = ?')) {
          return {
            all: (...params: unknown[]) => stmt.all(...params),
            get: (...params: unknown[]) => stmt.get(...params),
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
      transaction: db.transaction.bind(db),
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
    seedRun(db, { id: 'run-err-reject' });
    const ids = [0, 1].map((i) => {
      const id = `run-err-reject-approval-${i}`;
      seedApproval(db, { id, runId: 'run-err-reject', toolName: 'Bash' });
      return id;
    });

    // Wrap db.prepare so the second UPDATE call (for ids[1]) throws.
    let updateCallCount = 0;
    const realPrepare = db.prepare.bind(db);
    const wrappedDb = {
      prepare: (sql: string) => {
        const stmt = realPrepare(sql);
        if (sql.includes('SET status = ?')) {
          return {
            all: (...params: unknown[]) => stmt.all(...params),
            get: (...params: unknown[]) => stmt.get(...params),
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
      transaction: db.transaction.bind(db),
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
