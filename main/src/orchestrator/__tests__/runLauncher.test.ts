/**
 * Unit tests for RunLauncher.
 *
 * Behaviors covered (per TASK-352 test_strategy):
 * 1. ensureGitignoreEntry — append entry when missing
 * 2. ensureGitignoreEntry — idempotent when entry present
 * 3. ensureGitignoreEntry — creates .gitignore when file missing
 * 4. launch — updates workflow_runs row with worktree_path, branch_name, status='starting'
 *
 * Tests use withTempDir for filesystem isolation (auto-cleanup on exit).
 * The launch test uses an in-memory SQLite DB for the workflow_runs assertion.
 */
import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import Database from 'better-sqlite3';
import { RunLauncher } from '../runLauncher';
import type { OrchSocketProvider, BridgeScriptResolver, NodeResolver, StreamEventPublisher } from '../runLauncher';
import type { WorkflowRegistry } from '../workflowRegistry';
import type { WorktreeManager } from '../../services/worktreeManager';
import type { LoggerLike } from '../types';
import type { McpConfigWriter } from '../mcpConfigWriter';
import { REGISTRY_SCHEMA } from '../../database/__test_fixtures__/registrySchema';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { withTempDir } from '../../__test_fixtures__/tmp';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(REGISTRY_SCHEMA);
  return db;
}

function makeLogger(): LoggerLike {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// ensureGitignoreEntry
// ---------------------------------------------------------------------------

describe('RunLauncher.ensureGitignoreEntry', () => {
  it('appends entry when missing from existing .gitignore', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = createTestDb();
      const fakeRegistry = {} as WorkflowRegistry;
      const fakeWorktree = {} as WorktreeManager;
      const launcher = new RunLauncher(dbAdapter(db), fakeRegistry, fakeWorktree, makeLogger());

      const gitignorePath = join(tmpDir, '.gitignore');
      writeFileSync(gitignorePath, 'node_modules\n', 'utf-8');

      await launcher.ensureGitignoreEntry(tmpDir);

      const content = readFileSync(gitignorePath, 'utf-8');
      expect(content).toContain('.cyboflow/worktrees/');
    });
  });

  it('idempotent when entry already present (with trailing slash)', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = createTestDb();
      const fakeRegistry = {} as WorkflowRegistry;
      const fakeWorktree = {} as WorktreeManager;
      const launcher = new RunLauncher(dbAdapter(db), fakeRegistry, fakeWorktree, makeLogger());

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
  });

  it('idempotent when entry already present (without trailing slash)', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = createTestDb();
      const fakeRegistry = {} as WorkflowRegistry;
      const fakeWorktree = {} as WorktreeManager;
      const launcher = new RunLauncher(dbAdapter(db), fakeRegistry, fakeWorktree, makeLogger());

      const gitignorePath = join(tmpDir, '.gitignore');
      const original = '.cyboflow/worktrees\n';
      writeFileSync(gitignorePath, original, 'utf-8');

      await launcher.ensureGitignoreEntry(tmpDir);

      const content = readFileSync(gitignorePath, 'utf-8');
      // File should be unchanged
      expect(content).toBe(original);
    });
  });

  it('creates .gitignore with the entry when file does not exist', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = createTestDb();
      const fakeRegistry = {} as WorkflowRegistry;
      const fakeWorktree = {} as WorktreeManager;
      const launcher = new RunLauncher(dbAdapter(db), fakeRegistry, fakeWorktree, makeLogger());

      const gitignorePath = join(tmpDir, '.gitignore');
      expect(existsSync(gitignorePath)).toBe(false);

      await launcher.ensureGitignoreEntry(tmpDir);

      expect(existsSync(gitignorePath)).toBe(true);
      const content = readFileSync(gitignorePath, 'utf-8');
      expect(content).toBe('.cyboflow/worktrees/\n');
    });
  });

  it('appends without duplicating a newline when existing file ends with newline', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = createTestDb();
      const fakeRegistry = {} as WorkflowRegistry;
      const fakeWorktree = {} as WorktreeManager;
      const launcher = new RunLauncher(dbAdapter(db), fakeRegistry, fakeWorktree, makeLogger());

      const gitignorePath = join(tmpDir, '.gitignore');
      writeFileSync(gitignorePath, 'dist/\n', 'utf-8');

      await launcher.ensureGitignoreEntry(tmpDir);

      const content = readFileSync(gitignorePath, 'utf-8');
      // Should not have a blank line between dist/ and .cyboflow/worktrees/
      expect(content).toBe('dist/\n.cyboflow/worktrees/\n');
    });
  });
});

// ---------------------------------------------------------------------------
// launch
// ---------------------------------------------------------------------------

describe('RunLauncher.launch', () => {
  it('updates workflow_runs row with worktree_path, branch_name, and status=starting', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = createTestDb();
      const adapter = dbAdapter(db);
      const logger = makeLogger();

      // Seed a workflow row so createRun can look it up
      const seedWorkflowId = randomUUID();
      db.prepare(
        "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES (?, 1, 'sprint', '/fake/path.md', 'default')",
      ).run(seedWorkflowId);

      interface IdRow { id: string }
      const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;

      // Canned values returned by the stubs
      const cannedRunId = randomUUID().replace(/-/g, '');
      const cannedWorktreePath = join(tmpDir, '.cyboflow', 'worktrees', 'sprint', cannedRunId.slice(0, 8));
      const cannedBranchName = `cyboflow/sprint/${cannedRunId.slice(0, 8)}`;

      // Mock WorkflowRegistry: use the real getById (reads from our in-memory db),
      // but stub createRun so the runId is predictable
      const realRegistry = {
        getById: (id: string) => {
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
  });

  it('throws when workflow does not exist', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = createTestDb();
      const adapter = dbAdapter(db);
      const logger = makeLogger();

      const fakeRegistry = {
        getById: vi.fn().mockReturnValue(null),
        createRun: vi.fn(),
      } as unknown as WorkflowRegistry;

      const fakeWorktree = {} as WorktreeManager;

      const launcher = new RunLauncher(adapter, fakeRegistry, fakeWorktree, logger);

      await expect(launcher.launch('nonexistent-id', tmpDir)).rejects.toThrow('not found');
    });
  });

  it('writes per-run mcp config after worktree created, in the correct order', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = createTestDb();
      const adapter = dbAdapter(db);
      const logger = makeLogger();

      // Seed a workflow
      const seedWorkflowId2 = randomUUID();
      db.prepare(
        "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES (?, 1, 'sprint', '/fake/path.md', 'default')",
      ).run(seedWorkflowId2);

      interface IdRow { id: string }
      const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;

      const cannedRunId = randomUUID().replace(/-/g, '');
      const cannedWorktreePath = join(tmpDir, '.cyboflow', 'worktrees', 'sprint', cannedRunId.slice(0, 8));
      const cannedBranchName = `cyboflow/sprint/${cannedRunId.slice(0, 8)}`;

      // Track call ordering via a sequence array
      const callOrder: string[] = [];

      const fakeRegistry = {
        getById: (id: string) => {
          const row = db.prepare('SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?').get(id);
          return row ?? null;
        },
        createRun: vi.fn(() => {
          db.prepare(
            "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot) VALUES (?, ?, ?, 'queued', 'default')",
          ).run(cannedRunId, workflowId, 1);
          return { runId: cannedRunId, permissionMode: 'default' as const };
        }),
      } as unknown as WorkflowRegistry;

      const fakeWorktree = {
        createDeterministicWorktree: vi.fn().mockImplementation(async () => {
          callOrder.push('createDeterministicWorktree');
          return {
            worktreePath: cannedWorktreePath,
            branchName: cannedBranchName,
            baseCommit: 'abc123',
            baseBranch: 'HEAD',
          };
        }),
      } as unknown as WorktreeManager;

      const writeForRunSpy = vi.fn().mockImplementation(async () => {
        callOrder.push('writeForRun');
        return join(cannedWorktreePath, '.mcp.json');
      });

      const fakeMcpConfigWriter = {
        writeForRun: writeForRunSpy,
      } as unknown as McpConfigWriter;

      const fakeOrchSocketProvider: OrchSocketProvider = {
        getSocketPath: () => 'stub-socket-path',
      };

      const fakeBridgeScriptResolver: BridgeScriptResolver = {
        getScriptPath: () => '/stub/bridge.js',
      };

      const fakeNodeResolver: NodeResolver = {
        getNodePath: async () => '/usr/local/bin/node',
      };

      const launcher = new RunLauncher(
        adapter,
        fakeRegistry,
        fakeWorktree,
        logger,
        fakeMcpConfigWriter,
        fakeOrchSocketProvider,
        fakeBridgeScriptResolver,
        fakeNodeResolver,
      );

      const result = await launcher.launch(workflowId, tmpDir);

      // writeForRun must have been called exactly once
      expect(writeForRunSpy).toHaveBeenCalledOnce();

      // Verify the args passed to writeForRun
      const callArgs = writeForRunSpy.mock.calls[0][0] as {
        runId: string;
        worktreePath: string;
        orchSocketPath: string;
        bridgeScriptPath: string;
        nodeExecutablePath: string;
      };
      expect(callArgs.runId).toBe(cannedRunId);
      expect(callArgs.worktreePath).toBe(cannedWorktreePath);
      expect(callArgs.orchSocketPath).toBe('stub-socket-path');
      expect(callArgs.bridgeScriptPath).toBe('/stub/bridge.js');
      expect(callArgs.nodeExecutablePath).toBe('/usr/local/bin/node');

      // createDeterministicWorktree must be called BEFORE writeForRun
      const worktreeIdx = callOrder.indexOf('createDeterministicWorktree');
      const writeIdx = callOrder.indexOf('writeForRun');
      expect(worktreeIdx).toBeGreaterThanOrEqual(0);
      expect(writeIdx).toBeGreaterThan(worktreeIdx);

      // launch return values must still be correct
      expect(result.runId).toBe(cannedRunId);
      expect(result.worktreePath).toBe(cannedWorktreePath);
    });
  });
});

// ---------------------------------------------------------------------------
// launch — error handling
// ---------------------------------------------------------------------------

describe('RunLauncher.launch error handling', () => {
  /**
   * Builds a minimal workflow + run seed and returns the workflowId and cannedRunId.
   * The registry stub manually inserts the workflow_runs row (mimicking createRun).
   */
  function makeErrorHandlingFixture(db: Database.Database) {
    const workflowId = randomUUID();
    db.prepare(
      "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES (?, 1, 'sprint', '/fake/path.md', 'default')",
    ).run(workflowId);

    const cannedRunId = randomUUID().replace(/-/g, '');

    const fakeRegistry = {
      getById: (id: string) => {
        const row = db.prepare(
          'SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?',
        ).get(id);
        return row ?? null;
      },
      createRun: vi.fn(() => {
        db.prepare(
          "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot) VALUES (?, ?, ?, 'queued', 'default')",
        ).run(cannedRunId, workflowId, 1);
        return { runId: cannedRunId, permissionMode: 'default' as const };
      }),
    } as unknown as WorkflowRegistry;

    return { workflowId, cannedRunId, fakeRegistry };
  }

  it('marks run failed when createDeterministicWorktree throws', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = createTestDb();
      const adapter = dbAdapter(db);
      const logger = makeLogger();

      const { workflowId, cannedRunId, fakeRegistry } = makeErrorHandlingFixture(db);

      const fakeWorktree = {
        createDeterministicWorktree: vi.fn().mockRejectedValue(new Error('git worktree add failed')),
      } as unknown as WorktreeManager;

      const launcher = new RunLauncher(adapter, fakeRegistry, fakeWorktree, logger);

      await expect(launcher.launch(workflowId, tmpDir)).rejects.toThrow('git worktree add failed');

      interface RunRow { status: string; error_message: string | null }
      const row = db.prepare('SELECT status, error_message FROM workflow_runs WHERE id = ?').get(cannedRunId) as RunRow;

      expect(row.status).toBe('failed');
      expect(row.error_message).not.toBeNull();
      expect(row.error_message).toContain('git worktree add failed');
    });
  });

  it('marks run failed when mcpConfigWriter.writeForRun throws', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = createTestDb();
      const adapter = dbAdapter(db);
      const logger = makeLogger();

      const { workflowId, cannedRunId, fakeRegistry } = makeErrorHandlingFixture(db);

      const cannedWorktreePath = join(tmpDir, '.cyboflow', 'worktrees', 'sprint', cannedRunId.slice(0, 8));
      const cannedBranchName = `cyboflow/sprint/${cannedRunId.slice(0, 8)}`;

      const fakeWorktree = {
        createDeterministicWorktree: vi.fn().mockResolvedValue({
          worktreePath: cannedWorktreePath,
          branchName: cannedBranchName,
          baseCommit: 'abc123',
          baseBranch: 'HEAD',
        }),
      } as unknown as WorktreeManager;

      const fakeMcpConfigWriter = {
        writeForRun: vi.fn().mockRejectedValue(new Error('mcp.json write denied')),
      } as unknown as McpConfigWriter;

      const fakeOrchSocketProvider: OrchSocketProvider = { getSocketPath: () => 'stub-socket' };
      const fakeBridgeScriptResolver: BridgeScriptResolver = { getScriptPath: () => '/stub/bridge.js' };
      const fakeNodeResolver: NodeResolver = { getNodePath: async () => '/usr/local/bin/node' };

      const launcher = new RunLauncher(
        adapter,
        fakeRegistry,
        fakeWorktree,
        logger,
        fakeMcpConfigWriter,
        fakeOrchSocketProvider,
        fakeBridgeScriptResolver,
        fakeNodeResolver,
      );

      await expect(launcher.launch(workflowId, tmpDir)).rejects.toThrow('mcp.json write denied');

      interface RunRow { status: string; error_message: string | null }
      const row = db.prepare('SELECT status, error_message FROM workflow_runs WHERE id = ?').get(cannedRunId) as RunRow;

      expect(row.status).toBe('failed');
      expect(row.error_message).not.toBeNull();
      expect(row.error_message).toContain('mcp.json write denied');
    });
  });

  it('does not orphan a row in queued state when worktree creation fails', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = createTestDb();
      const adapter = dbAdapter(db);
      const logger = makeLogger();

      const { workflowId, cannedRunId, fakeRegistry } = makeErrorHandlingFixture(db);

      const fakeWorktree = {
        createDeterministicWorktree: vi.fn().mockRejectedValue(new Error('disk full')),
      } as unknown as WorktreeManager;

      const launcher = new RunLauncher(adapter, fakeRegistry, fakeWorktree, logger);

      await expect(launcher.launch(workflowId, tmpDir)).rejects.toThrow('disk full');

      interface RunRow { status: string; error_message: string | null }
      const row = db.prepare('SELECT status, error_message FROM workflow_runs WHERE id = ?').get(cannedRunId) as RunRow;

      // Must not remain orphaned in 'queued' or 'starting'
      expect(row.status).not.toBe('queued');
      expect(row.status).not.toBe('starting');
      expect(row.status).toBe('failed');
      expect(row.error_message).not.toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// RunLauncher.launch — StreamEventPublisher integration
// ---------------------------------------------------------------------------

describe('RunLauncher.launch publisher', () => {
  it('calls publisher.publish with run_started event after status update', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = createTestDb();
      const adapter = dbAdapter(db);
      const logger = makeLogger();

      // Seed a workflow row
      const seedWorkflowId = randomUUID();
      db.prepare(
        "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES (?, 1, 'sprint', '/fake/path.md', 'default')",
      ).run(seedWorkflowId);

      interface IdRow { id: string }
      const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;

      const cannedRunId = randomUUID().replace(/-/g, '');
      const cannedWorktreePath = join(tmpDir, '.cyboflow', 'worktrees', 'sprint', cannedRunId.slice(0, 8));
      const cannedBranchName = `cyboflow/sprint/${cannedRunId.slice(0, 8)}`;

      const fakeRegistry = {
        getById: (id: string) => {
          const row = db.prepare(
            'SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?',
          ).get(id);
          return row ?? null;
        },
        createRun: vi.fn(() => {
          db.prepare(
            "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot) VALUES (?, ?, ?, 'queued', 'default')",
          ).run(cannedRunId, workflowId, 1);
          return { runId: cannedRunId, permissionMode: 'default' as const };
        }),
      } as unknown as WorkflowRegistry;

      const fakeWorktree = {
        createDeterministicWorktree: vi.fn().mockResolvedValue({
          worktreePath: cannedWorktreePath,
          branchName: cannedBranchName,
          baseCommit: 'abc123',
          baseBranch: 'HEAD',
        }),
      } as unknown as WorktreeManager;

      // Spy publisher satisfying StreamEventPublisher interface
      const publishSpy = vi.fn();
      const spyPublisher: StreamEventPublisher = { publish: publishSpy };

      const launcher = new RunLauncher(
        adapter,
        fakeRegistry,
        fakeWorktree,
        logger,
        undefined, // mcpConfigWriter
        undefined, // orchSocketProvider
        undefined, // bridgeScriptResolver
        undefined, // nodeResolver
        spyPublisher,
      );

      const result = await launcher.launch(workflowId, tmpDir);

      // publisher.publish must have been called at least once
      expect(publishSpy).toHaveBeenCalled();

      // The runId arg must match the returned runId
      const firstCall = publishSpy.mock.calls[0] as [string, { type: string; payload: unknown; timestamp: string }];
      expect(firstCall[0]).toBe(result.runId);

      // The event must have type 'run_started'
      expect(firstCall[1].type).toBe('run_started');
    });
  });

  it('launch succeeds without a publisher (publisher is optional)', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = createTestDb();
      const adapter = dbAdapter(db);
      const logger = makeLogger();

      const seedWorkflowId = randomUUID();
      db.prepare(
        "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES (?, 1, 'sprint', '/fake/path.md', 'default')",
      ).run(seedWorkflowId);

      interface IdRow { id: string }
      const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;

      const cannedRunId = randomUUID().replace(/-/g, '');
      const cannedWorktreePath = join(tmpDir, '.cyboflow', 'worktrees', 'sprint', cannedRunId.slice(0, 8));
      const cannedBranchName = `cyboflow/sprint/${cannedRunId.slice(0, 8)}`;

      const fakeRegistry = {
        getById: (id: string) => {
          const row = db.prepare(
            'SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?',
          ).get(id);
          return row ?? null;
        },
        createRun: vi.fn(() => {
          db.prepare(
            "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot) VALUES (?, ?, ?, 'queued', 'default')",
          ).run(cannedRunId, workflowId, 1);
          return { runId: cannedRunId, permissionMode: 'default' as const };
        }),
      } as unknown as WorkflowRegistry;

      const fakeWorktree = {
        createDeterministicWorktree: vi.fn().mockResolvedValue({
          worktreePath: cannedWorktreePath,
          branchName: cannedBranchName,
          baseCommit: 'abc123',
          baseBranch: 'HEAD',
        }),
      } as unknown as WorktreeManager;

      // No publisher passed — 9th arg omitted entirely
      const launcher = new RunLauncher(adapter, fakeRegistry, fakeWorktree, logger);
      const result = await launcher.launch(workflowId, tmpDir);

      expect(result.runId).toBe(cannedRunId);
    });
  });
});
