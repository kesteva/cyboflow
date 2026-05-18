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
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { approveRestOfRunHandler, rejectRestOfRunHandler } from '../routers/approvals';

// ---------------------------------------------------------------------------
// Test-database helpers
// ---------------------------------------------------------------------------

const SCHEMA_PATH = join(
  process.cwd(),
  'src/database/migrations/006_cyboflow_schema.sql',
);

/** Creates a fresh in-memory SQLite database with the cyboflow schema applied. */
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

/** Narrow DatabaseLike adapter for approveRestOfRunHandler. */
function dbAdapter(db: Database.Database): {
  prepare: (sql: string) => {
    all: (...params: unknown[]) => unknown[];
    run: (...params: unknown[]) => void;
  };
} {
  return {
    prepare: (sql: string) => {
      const stmt = db.prepare(sql);
      return {
        all: (...params: unknown[]) => stmt.all(...params),
        run: (...params: unknown[]) => { stmt.run(...params); },
      };
    },
  };
}

/**
 * Seed helper: insert a workflow + workflow_run + N pending approvals.
 *
 * Returns the array of inserted approval IDs.
 */
function seedPendingApprovals(
  db: Database.Database,
  runId: string,
  count: number,
): string[] {
  const workflowId = `workflow-${runId}`;
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json)
     VALUES (?, 1, 'test-workflow', '{}')`,
  ).run(workflowId);

  db.prepare(
    `INSERT OR IGNORE INTO workflow_runs
       (id, workflow_id, project_id, worktree_path, status, policy_json)
     VALUES (?, ?, 1, '/tmp/test', 'running', '{}')`,
  ).run(runId, workflowId);

  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const approvalId = `${runId}-approval-${i}`;
    ids.push(approvalId);
    db.prepare(
      `INSERT INTO approvals
         (id, run_id, tool_name, tool_input_json, tool_use_id, status, created_at)
       VALUES (?, ?, 'Bash', '{}', ?, 'pending', datetime('now'))`,
    ).run(approvalId, runId, approvalId);
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
