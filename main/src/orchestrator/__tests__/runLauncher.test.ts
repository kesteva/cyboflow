/**
 * Unit tests for RunLauncher.
 *
 * Behaviors covered (per TASK-352 test_strategy):
 * 1. ensureGitignoreEntry — append entry when missing
 * 2. ensureGitignoreEntry — idempotent when entry present
 * 3. ensureGitignoreEntry — creates .gitignore when file missing
 * 4. launch — updates workflow_runs row with worktree_path, branch_name, status='starting'
 *
 * Tests use os.tmpdir() + randomUUID() for filesystem isolation.
 * The launch test uses an in-memory SQLite DB for the workflow_runs assertion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { RunLauncher } from '../runLauncher';
import type { WorkflowRegistry } from '../workflowRegistry';
import type { WorktreeManager } from '../../services/worktreeManager';
import type { LoggerLike, DatabaseLike } from '../types';

// ---------------------------------------------------------------------------
// Schema (mirrors workflowRegistry.test.ts)
// ---------------------------------------------------------------------------

const REGISTRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  workflow_path TEXT NOT NULL,
  permission_mode TEXT NOT NULL DEFAULT 'default',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  permission_mode_snapshot TEXT NOT NULL,
  worktree_path TEXT,
  branch_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id)
);
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(REGISTRY_SCHEMA);
  return db;
}

function dbAdapter(db: Database.Database): DatabaseLike {
  return {
    prepare: (sql: string) => db.prepare(sql),
    transaction: <T>(fn: (...args: unknown[]) => T) =>
      db.transaction(fn as (...args: unknown[]) => T) as (...args: unknown[]) => T,
  };
}

function makeLogger(): LoggerLike {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** Create a temp dir unique per test. */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), `runlauncher-test-${randomUUID().slice(0, 8)}-`));
}

// ---------------------------------------------------------------------------
// ensureGitignoreEntry
// ---------------------------------------------------------------------------

describe('RunLauncher.ensureGitignoreEntry', () => {
  let launcher: RunLauncher;
  let tmpDir: string;

  beforeEach(() => {
    const db = createTestDb();
    const fakeRegistry = {} as WorkflowRegistry;
    const fakeWorktree = {} as WorktreeManager;
    launcher = new RunLauncher(dbAdapter(db), fakeRegistry, fakeWorktree, makeLogger());
    tmpDir = makeTempDir();
  });

  it('appends entry when missing from existing .gitignore', async () => {
    const gitignorePath = join(tmpDir, '.gitignore');
    writeFileSync(gitignorePath, 'node_modules\n', 'utf-8');

    await launcher.ensureGitignoreEntry(tmpDir);

    const content = readFileSync(gitignorePath, 'utf-8');
    expect(content).toContain('.cyboflow/worktrees/');
  });

  it('idempotent when entry already present (with trailing slash)', async () => {
    const gitignorePath = join(tmpDir, '.gitignore');
    const original = 'node_modules\n.cyboflow/worktrees/\n';
    writeFileSync(gitignorePath, original, 'utf-8');

    await launcher.ensureGitignoreEntry(tmpDir);

    const content = readFileSync(gitignorePath, 'utf-8');
    // Should not have a duplicate line
    const lines = content.split('\n').filter((l) => l.trim() === '.cyboflow/worktrees/');
    expect(lines).toHaveLength(1);
    expect(content).toBe(original);
  });

  it('idempotent when entry already present (without trailing slash)', async () => {
    const gitignorePath = join(tmpDir, '.gitignore');
    const original = '.cyboflow/worktrees\n';
    writeFileSync(gitignorePath, original, 'utf-8');

    await launcher.ensureGitignoreEntry(tmpDir);

    const content = readFileSync(gitignorePath, 'utf-8');
    // File should be unchanged
    expect(content).toBe(original);
  });

  it('creates .gitignore with the entry when file does not exist', async () => {
    const gitignorePath = join(tmpDir, '.gitignore');
    expect(existsSync(gitignorePath)).toBe(false);

    await launcher.ensureGitignoreEntry(tmpDir);

    expect(existsSync(gitignorePath)).toBe(true);
    const content = readFileSync(gitignorePath, 'utf-8');
    expect(content).toBe('.cyboflow/worktrees/\n');
  });

  it('appends without duplicating a newline when existing file ends with newline', async () => {
    const gitignorePath = join(tmpDir, '.gitignore');
    writeFileSync(gitignorePath, 'dist/\n', 'utf-8');

    await launcher.ensureGitignoreEntry(tmpDir);

    const content = readFileSync(gitignorePath, 'utf-8');
    // Should not have a blank line between dist/ and .cyboflow/worktrees/
    expect(content).toBe('dist/\n.cyboflow/worktrees/\n');
  });
});

// ---------------------------------------------------------------------------
// launch
// ---------------------------------------------------------------------------

describe('RunLauncher.launch', () => {
  it('updates workflow_runs row with worktree_path, branch_name, and status=starting', async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const logger = makeLogger();
    const tmpDir = makeTempDir();

    // Seed a workflow row so createRun can look it up
    db.prepare(
      "INSERT INTO workflows (project_id, name, workflow_path, permission_mode) VALUES (1, 'sprint', '/fake/path.md', 'default')",
    ).run();

    interface IdRow { id: number }
    const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;

    // Canned values returned by the stubs
    const cannedRunId = randomUUID().replace(/-/g, '');
    const cannedWorktreePath = join(tmpDir, '.cyboflow', 'worktrees', 'sprint', cannedRunId.slice(0, 8));
    const cannedBranchName = `cyboflow/sprint/${cannedRunId.slice(0, 8)}`;

    // Mock WorkflowRegistry: use the real getById (reads from our in-memory db),
    // but stub createRun so the runId is predictable
    const realRegistry = {
      getById: (id: number) => {
        const row = db.prepare('SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?').get(id);
        return row ?? null;
      },
      createRun: vi.fn(() => {
        // Manually insert the row that the real createRun would insert
        db.prepare(
          "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot) VALUES (?, ?, ?, 'queued', 'default')",
        ).run(cannedRunId, workflowId, 1);
        return { runId: cannedRunId, permissionMode: 'default' as const };
      }),
    } as unknown as WorkflowRegistry;

    // Mock WorktreeManager
    const fakeWorktree = {
      createDeterministicWorktree: vi.fn().mockResolvedValue({
        worktreePath: cannedWorktreePath,
        branchName: cannedBranchName,
        baseCommit: 'abc123',
        baseBranch: 'HEAD',
      }),
    } as unknown as WorktreeManager;

    const launcher = new RunLauncher(adapter, realRegistry, fakeWorktree, logger);

    const result = await launcher.launch(workflowId, tmpDir);

    // Verify return values
    expect(result.runId).toBe(cannedRunId);
    expect(result.worktreePath).toBe(cannedWorktreePath);
    expect(result.branchName).toBe(cannedBranchName);
    expect(result.permissionMode).toBe('default');

    // Verify the DB row was updated
    interface RunRow { worktree_path: string; branch_name: string; status: string }
    const row = db.prepare('SELECT worktree_path, branch_name, status FROM workflow_runs WHERE id = ?').get(cannedRunId) as RunRow;
    expect(row.worktree_path).toBe(cannedWorktreePath);
    expect(row.branch_name).toBe(cannedBranchName);
    expect(row.status).toBe('starting');

    // Verify worktree manager was called with correct args
    expect(fakeWorktree.createDeterministicWorktree).toHaveBeenCalledWith(tmpDir, 'sprint', cannedRunId);
  });

  it('throws when workflow does not exist', async () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const logger = makeLogger();
    const tmpDir = makeTempDir();

    const fakeRegistry = {
      getById: vi.fn().mockReturnValue(null),
      createRun: vi.fn(),
    } as unknown as WorkflowRegistry;

    const fakeWorktree = {} as WorktreeManager;

    const launcher = new RunLauncher(adapter, fakeRegistry, fakeWorktree, logger);

    await expect(launcher.launch(99999, tmpDir)).rejects.toThrow('not found');
  });
});
