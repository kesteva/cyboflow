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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { RunLauncher } from '../runLauncher';
import type { OrchSocketProvider, BridgeScriptResolver, NodeResolver, StreamEventPublisher } from '../runLauncher';
import type { WorkflowRegistry } from '../workflowRegistry';
import type { WorktreeManager } from '../../services/worktreeManager';
import type { McpConfigWriter } from '../mcpConfigWriter';
import type { RunExecutor } from '../runExecutor';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';
import { withTempDir } from '../../__test_fixtures__/tmp';
import { createTestDb } from '../__test_fixtures__/orchestratorTestDb';
import type { CliSubstrate } from '../../../../shared/types/substrate';
import type { SessionAgentPermissionModeDeps } from '../sessionPermissionMode';

// Shared stubs for the 4 required MCP collaborators.
// All tests that construct RunLauncher must pass these (or equivalent stubs)
// now that the constructor throws if any are missing.

const fakeMcpConfigWriter: McpConfigWriter = {
  writeForRun: vi.fn().mockResolvedValue('/fake/.mcp.json'),
} as unknown as McpConfigWriter;

const fakeOrchSocketProvider: OrchSocketProvider = {
  getSocketPath: () => '/tmp/stub-orch.sock',
};

const fakeBridgeScriptResolver: BridgeScriptResolver = {
  getScriptPath: () => '/stub/bridge.js',
};

const fakeNodeResolver: NodeResolver = {
  getNodePath: async () => '/usr/local/bin/node',
};

// Reset all vi.fn() call history before each test so the module-level shared
// stubs (fakeMcpConfigWriter, etc.) do not accumulate state across tests.
beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// Session-hosted test helpers (permission-mode redesign slice 1b)
//
// Every run is now session-hosted: the session-less createDeterministicWorktree
// branch was removed and launch THROWS without a sessionId. These helpers build
// the session_id/base_sha columns + sessions table the launch path reads/writes,
// seed a session row whose worktree the run reuses, and stub a session-aware
// WorktreeManager (createDeterministicWorktree must NEVER fire — branch is read
// via getProjectMainBranch, base_sha via getHeadCommit). The dedicated Phase-1
// block below keeps its own near-identical makeSessionDb/makeSessionRegistry.
// ---------------------------------------------------------------------------

/** A session-hosted test DB: the columns + sessions table the launch path touches. */
function sessionHostedDb(): Database.Database {
  const db = createTestDb({ includeWorkflowRunTaskColumns: true });
  db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
  // Migration 034: seed_finding_ids is written by the compound launch path.
  db.exec('ALTER TABLE workflow_runs ADD COLUMN seed_finding_ids TEXT');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      worktree_path TEXT,
      base_branch TEXT,
      run_id TEXT,
      substrate TEXT,
      in_place BOOLEAN DEFAULT 0,
      is_main_repo BOOLEAN DEFAULT 0
    )
  `);
  return db;
}

/** Seed the session row whose EXISTING worktree the run will reuse. */
function seedSession(db: Database.Database, id: string, worktreePath: string, baseBranch = 'main'): void {
  db.prepare(
    'INSERT INTO sessions (id, worktree_path, base_branch, run_id) VALUES (?, ?, ?, NULL)',
  ).run(id, worktreePath, baseBranch);
}

/**
 * A session-aware WorktreeManager stub. createDeterministicWorktree is present
 * but must NEVER be called (asserted per test); the run reuses the session tree,
 * resolving its branch from getProjectMainBranch and base_sha from getHeadCommit.
 */
function sessionWorktreeStub(
  branchName: string,
  headSha = 'abc123def456',
): { worktree: WorktreeManager; createDeterministicWorktree: ReturnType<typeof vi.fn> } {
  const createDeterministicWorktree = vi.fn();
  const worktree = {
    createDeterministicWorktree,
    getProjectMainBranch: vi.fn().mockResolvedValue(branchName),
    getHeadCommit: vi.fn().mockResolvedValue(headSha),
  } as unknown as WorktreeManager;
  return { worktree, createDeterministicWorktree };
}

/**
 * A fake session-mode write chokepoint deps bag (permission-mode redesign §3e).
 * The launch picker writes the host session's mode through it when an explicit
 * requestedPermissionMode is supplied; `updateSession` is the spy under test.
 */
function makeFakeSessionPermDeps(): {
  deps: SessionAgentPermissionModeDeps;
  updateSession: ReturnType<typeof vi.fn>;
} {
  const updateSession = vi.fn(() => ({ id: 'sess-1' }));
  const deps: SessionAgentPermissionModeDeps = {
    databaseService: { updateSession },
    sessionManager: {
      getSession: vi.fn(() => ({ agentPermissionMode: 'default' as const })),
      emit: vi.fn(),
    },
  };
  return { deps, updateSession };
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
      const launcher = new RunLauncher(dbAdapter(db), fakeRegistry, fakeWorktree, makeSpyLogger(), fakeMcpConfigWriter, fakeOrchSocketProvider, fakeBridgeScriptResolver, fakeNodeResolver);

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
      const launcher = new RunLauncher(dbAdapter(db), fakeRegistry, fakeWorktree, makeSpyLogger(), fakeMcpConfigWriter, fakeOrchSocketProvider, fakeBridgeScriptResolver, fakeNodeResolver);

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
      const launcher = new RunLauncher(dbAdapter(db), fakeRegistry, fakeWorktree, makeSpyLogger(), fakeMcpConfigWriter, fakeOrchSocketProvider, fakeBridgeScriptResolver, fakeNodeResolver);

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
      const launcher = new RunLauncher(dbAdapter(db), fakeRegistry, fakeWorktree, makeSpyLogger(), fakeMcpConfigWriter, fakeOrchSocketProvider, fakeBridgeScriptResolver, fakeNodeResolver);

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
      const launcher = new RunLauncher(dbAdapter(db), fakeRegistry, fakeWorktree, makeSpyLogger(), fakeMcpConfigWriter, fakeOrchSocketProvider, fakeBridgeScriptResolver, fakeNodeResolver);

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
      const db = sessionHostedDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

      // Seed a workflow row so createRun can look it up
      const seedWorkflowId = randomUUID();
      db.prepare(
        "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES (?, 1, 'sprint', '/fake/path.md', 'default')",
      ).run(seedWorkflowId);

      interface IdRow { id: string }
      const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;

      // Canned values returned by the stubs. The run reuses the session worktree, so
      // the expected worktree_path is the SESSION's tree and the branch is what
      // getProjectMainBranch reports.
      const cannedRunId = randomUUID().replace(/-/g, '');
      const cannedWorktreePath = join(tmpDir, '.cyboflow', 'worktrees', 'sprint', cannedRunId.slice(0, 8));
      const cannedBranchName = `cyboflow/sprint/${cannedRunId.slice(0, 8)}`;
      seedSession(db, 'sess-1', cannedWorktreePath);

      // Mock WorkflowRegistry: use the real getById (reads from our in-memory db),
      // but stub createRun so the runId is predictable (and stamp session_id like
      // the real one does).
      const realRegistry = {
        getById: (id: string) => {
          const row = db.prepare('SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?').get(id);
          return row ?? null;
        },
        createRun: vi.fn((_id: string, substrate?: CliSubstrate, sessionId?: string) => {
          // Manually insert the row that the real createRun would insert
          db.prepare(
            "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id) VALUES (?, ?, ?, 'queued', 'default', ?)",
          ).run(cannedRunId, workflowId, 1, sessionId ?? null);
          return { runId: cannedRunId, permissionMode: 'default' as const, substrate: substrate ?? ('sdk' as const) };
        }),
      } as unknown as WorkflowRegistry;

      // Session-aware WorktreeManager: branch resolved from the session worktree.
      const { worktree: fakeWorktree, createDeterministicWorktree } = sessionWorktreeStub(cannedBranchName);

      const launcher = new RunLauncher(adapter, realRegistry, fakeWorktree, logger, fakeMcpConfigWriter, fakeOrchSocketProvider, fakeBridgeScriptResolver, fakeNodeResolver);

      const result = await launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, 'sess-1');

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

      // The run reuses the session worktree — NO dedicated worktree is ever created.
      expect(createDeterministicWorktree).not.toHaveBeenCalled();
    });
  });

  it('throws when no sessionId is supplied (run cannot be session-less, slice 1b invariant)', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = sessionHostedDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

      const seedWorkflowId = randomUUID();
      db.prepare(
        "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES (?, 1, 'sprint', '/fake/path.md', 'default')",
      ).run(seedWorkflowId);
      interface IdRow { id: string }
      const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;

      const createRunSpy = vi.fn();
      const realRegistry = {
        getById: (id: string) =>
          db.prepare('SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?').get(id) ?? null,
        createRun: createRunSpy,
      } as unknown as WorkflowRegistry;

      const { worktree: fakeWorktree, createDeterministicWorktree } = sessionWorktreeStub('main');

      const launcher = new RunLauncher(adapter, realRegistry, fakeWorktree, logger, fakeMcpConfigWriter, fakeOrchSocketProvider, fakeBridgeScriptResolver, fakeNodeResolver);

      // A valid workflow but NO sessionId — the launch-level guard fires (after the
      // sprint/finding validation, before the one-running guard binds sessionId).
      await expect(launcher.launch(workflowId, tmpDir)).rejects.toThrow(
        'RunLauncher.launch: sessionId is required (run cannot be session-less)',
      );

      // No run is created and no worktree is touched.
      expect(createRunSpy).not.toHaveBeenCalled();
      expect(createDeterministicWorktree).not.toHaveBeenCalled();
    });
  });

  it('threads the per-run substrate choice into WorkflowRegistry.createRun', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = sessionHostedDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

      const seedWorkflowId = randomUUID();
      db.prepare(
        "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES (?, 1, 'sprint', '/fake/path.md', 'default')",
      ).run(seedWorkflowId);
      interface IdRow { id: string }
      const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;

      seedSession(db, 'sess-1', join(tmpDir, 'wt'));

      const cannedRunId = randomUUID().replace(/-/g, '');
      const createRunSpy = vi.fn((_id: string, substrate?: CliSubstrate, sessionId?: string) => {
        db.prepare(
          "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id) VALUES (?, ?, ?, 'queued', 'default', ?)",
        ).run(cannedRunId, workflowId, 1, sessionId ?? null);
        return { runId: cannedRunId, permissionMode: 'default' as const, substrate: substrate ?? ('sdk' as const) };
      });
      const realRegistry = {
        getById: (id: string) =>
          db.prepare('SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?').get(id) ?? null,
        createRun: createRunSpy,
      } as unknown as WorkflowRegistry;

      const { worktree: fakeWorktree } = sessionWorktreeStub('cyboflow/sprint/x');

      const launcher = new RunLauncher(adapter, realRegistry, fakeWorktree, logger, fakeMcpConfigWriter, fakeOrchSocketProvider, fakeBridgeScriptResolver, fakeNodeResolver);

      await launcher.launch(workflowId, tmpDir, 'interactive', undefined, undefined, 'sess-1');

      // The explicit per-run substrate choice must be forwarded to createRun as
      // its 2nd argument (the bug: it was previously dropped as `_substrate`).
      // The 3rd arg is the (now-required) sessionId; the 4th (requestedPermissionMode)
      // is undefined on this no-permission-override launch; the 5th (the launch
      // projectId opts) is undefined when no projectId is threaded.
      expect(createRunSpy).toHaveBeenCalledWith(workflowId, 'interactive', 'sess-1', undefined, undefined);
    });
  });

  it('threads the per-run agent permission choice into WorkflowRegistry.createRun', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = sessionHostedDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

      const seedWorkflowId = randomUUID();
      db.prepare(
        "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES (?, 1, 'sprint', '/fake/path.md', 'default')",
      ).run(seedWorkflowId);
      interface IdRow { id: string }
      const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;

      seedSession(db, 'sess-1', join(tmpDir, 'wt'));

      const cannedRunId = randomUUID().replace(/-/g, '');
      const createRunSpy = vi.fn((_id: string, substrate?: CliSubstrate, sessionId?: string) => {
        db.prepare(
          "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id) VALUES (?, ?, ?, 'queued', 'auto', ?)",
        ).run(cannedRunId, workflowId, 1, sessionId ?? null);
        return { runId: cannedRunId, permissionMode: 'auto' as const, substrate: substrate ?? ('sdk' as const) };
      });
      const realRegistry = {
        getById: (id: string) =>
          db.prepare('SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?').get(id) ?? null,
        createRun: createRunSpy,
      } as unknown as WorkflowRegistry;

      const { worktree: fakeWorktree } = sessionWorktreeStub('cyboflow/sprint/x');

      const launcher = new RunLauncher(adapter, realRegistry, fakeWorktree, logger, fakeMcpConfigWriter, fakeOrchSocketProvider, fakeBridgeScriptResolver, fakeNodeResolver);

      // sessionId = 'sess-1' (6th positional), requestedPermissionMode = 'auto' (7th).
      await launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, 'sess-1', 'auto');

      // The explicit per-run permission choice must be forwarded to createRun as
      // its 4th argument (the highest-precedence `requestedMode` rung); the 3rd is
      // the now-required sessionId.
      expect(createRunSpy).toHaveBeenCalledWith(workflowId, undefined, 'sess-1', 'auto', undefined);
    });
  });

  it('threads the per-run model choice into WorkflowRegistry.createRun opts (migration 037)', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = sessionHostedDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

      const seedWorkflowId = randomUUID();
      db.prepare(
        "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES (?, 1, 'sprint', '/fake/path.md', 'default')",
      ).run(seedWorkflowId);
      interface IdRow { id: string }
      const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;

      // A run can NEVER be session-less (slice 1b invariant), so host it in a
      // real session and thread sessionId at the 6th launch slot.
      seedSession(db, 'sess-1', join(tmpDir, 'wt'));

      const cannedRunId = randomUUID().replace(/-/g, '');
      const createRunSpy = vi.fn((_id: string, substrate?: CliSubstrate, sessionId?: string) => {
        db.prepare(
          "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id) VALUES (?, ?, ?, 'queued', 'default', ?)",
        ).run(cannedRunId, workflowId, 1, sessionId ?? null);
        return { runId: cannedRunId, permissionMode: 'default' as const, substrate: substrate ?? ('sdk' as const) };
      });
      const realRegistry = {
        getById: (id: string) =>
          db.prepare('SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?').get(id) ?? null,
        createRun: createRunSpy,
      } as unknown as WorkflowRegistry;

      const { worktree: fakeWorktree } = sessionWorktreeStub('cyboflow/sprint/x');
      const { deps } = makeFakeSessionPermDeps();

      const launcher = new RunLauncher(
        adapter, realRegistry, fakeWorktree, logger, fakeMcpConfigWriter, fakeOrchSocketProvider,
        fakeBridgeScriptResolver, fakeNodeResolver,
        undefined, undefined, undefined, undefined, undefined, deps,
      );

      // requestedModel is the LAST positional launch arg (after findingIds); the
      // now-required sessionId rides the 6th slot. All other optionals undefined.
      await launcher.launch(
        workflowId, tmpDir,
        undefined, undefined, undefined, 'sess-1', undefined,
        undefined, undefined, undefined, undefined, undefined,
        'opus',
      );

      // The model choice rides into createRun's 5th arg (the opts bag) as
      // `requestedModel` — never a new positional (substrate/permission stay
      // undefined; sessionId is the 3rd).
      expect(createRunSpy).toHaveBeenCalledWith(
        workflowId,
        undefined,
        'sess-1',
        undefined,
        { requestedModel: 'opus' },
      );
    });
  });

  it('writes the HOST session mode through the chokepoint when an explicit mode is supplied (§3e)', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = sessionHostedDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

      const seedWorkflowId = randomUUID();
      db.prepare(
        "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES (?, 1, 'sprint', '/fake/path.md', 'default')",
      ).run(seedWorkflowId);
      interface IdRow { id: string }
      const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;

      seedSession(db, 'sess-1', join(tmpDir, 'wt'));

      const cannedRunId = randomUUID().replace(/-/g, '');
      const realRegistry = {
        getById: (id: string) =>
          db.prepare('SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?').get(id) ?? null,
        createRun: vi.fn((_id: string, substrate?: CliSubstrate, sessionId?: string) => {
          db.prepare(
            "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id) VALUES (?, ?, ?, 'queued', 'auto', ?)",
          ).run(cannedRunId, workflowId, 1, sessionId ?? null);
          return { runId: cannedRunId, permissionMode: 'auto' as const, substrate: substrate ?? ('sdk' as const) };
        }),
      } as unknown as WorkflowRegistry;

      const { worktree: fakeWorktree } = sessionWorktreeStub('cyboflow/sprint/x');
      const { deps, updateSession } = makeFakeSessionPermDeps();

      const launcher = new RunLauncher(
        adapter, realRegistry, fakeWorktree, logger, fakeMcpConfigWriter, fakeOrchSocketProvider,
        fakeBridgeScriptResolver, fakeNodeResolver,
        undefined, undefined, undefined, undefined, undefined, deps,
      );

      // sessionId = 'sess-1' (6th positional), requestedPermissionMode = 'auto' (7th).
      await launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, 'sess-1', 'auto');

      // The picker permanently sets the host session's mode via the shared chokepoint.
      expect(updateSession).toHaveBeenCalledWith('sess-1', { agent_permission_mode: 'auto' });
    });
  });

  it('leaves the session mode untouched when no explicit mode is supplied (§3e)', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = sessionHostedDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

      const seedWorkflowId = randomUUID();
      db.prepare(
        "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES (?, 1, 'sprint', '/fake/path.md', 'default')",
      ).run(seedWorkflowId);
      interface IdRow { id: string }
      const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;

      seedSession(db, 'sess-1', join(tmpDir, 'wt'));

      const cannedRunId = randomUUID().replace(/-/g, '');
      const realRegistry = {
        getById: (id: string) =>
          db.prepare('SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?').get(id) ?? null,
        createRun: vi.fn((_id: string, substrate?: CliSubstrate, sessionId?: string) => {
          db.prepare(
            "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id) VALUES (?, ?, ?, 'queued', 'default', ?)",
          ).run(cannedRunId, workflowId, 1, sessionId ?? null);
          return { runId: cannedRunId, permissionMode: 'default' as const, substrate: substrate ?? ('sdk' as const) };
        }),
      } as unknown as WorkflowRegistry;

      const { worktree: fakeWorktree } = sessionWorktreeStub('cyboflow/sprint/x');
      const { deps, updateSession } = makeFakeSessionPermDeps();

      const launcher = new RunLauncher(
        adapter, realRegistry, fakeWorktree, logger, fakeMcpConfigWriter, fakeOrchSocketProvider,
        fakeBridgeScriptResolver, fakeNodeResolver,
        undefined, undefined, undefined, undefined, undefined, deps,
      );

      // No requestedPermissionMode (7th positional omitted) → the chokepoint is
      // NEVER invoked, so the host session's mode is left untouched.
      await launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, 'sess-1');

      expect(updateSession).not.toHaveBeenCalled();
    });
  });

  it('throws when workflow does not exist', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = createTestDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

      const fakeRegistry = {
        getById: vi.fn().mockReturnValue(null),
        createRun: vi.fn(),
      } as unknown as WorkflowRegistry;

      const fakeWorktree = {} as WorktreeManager;

      const launcher = new RunLauncher(adapter, fakeRegistry, fakeWorktree, logger, fakeMcpConfigWriter, fakeOrchSocketProvider, fakeBridgeScriptResolver, fakeNodeResolver);

      await expect(launcher.launch('nonexistent-id', tmpDir)).rejects.toThrow('not found');
    });
  });

  it('writes per-run mcp config after worktree resolved, in the correct order', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = sessionHostedDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

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
      seedSession(db, 'sess-1', cannedWorktreePath);

      // Track call ordering via a sequence array
      const callOrder: string[] = [];

      const fakeRegistry = {
        getById: (id: string) => {
          const row = db.prepare('SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?').get(id);
          return row ?? null;
        },
        createRun: vi.fn((_id: string, substrate?: CliSubstrate, sessionId?: string) => {
          db.prepare(
            "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id) VALUES (?, ?, ?, 'queued', 'default', ?)",
          ).run(cannedRunId, workflowId, 1, sessionId ?? null);
          return { runId: cannedRunId, permissionMode: 'default' as const, substrate: substrate ?? ('sdk' as const) };
        }),
      } as unknown as WorkflowRegistry;

      // The session worktree is resolved (getProjectMainBranch) before the mcp.json
      // is written — record that ordering.
      const fakeWorktree = {
        createDeterministicWorktree: vi.fn(),
        getProjectMainBranch: vi.fn().mockImplementation(async () => {
          callOrder.push('resolveWorktree');
          return cannedBranchName;
        }),
        getHeadCommit: vi.fn().mockResolvedValue('abc123def456'),
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

      const result = await launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, 'sess-1');

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

      // The session worktree must be resolved BEFORE writeForRun
      const worktreeIdx = callOrder.indexOf('resolveWorktree');
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
      createRun: vi.fn((_id: string, substrate?: CliSubstrate, sessionId?: string) => {
        db.prepare(
          "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id) VALUES (?, ?, ?, 'queued', 'default', ?)",
        ).run(cannedRunId, workflowId, 1, sessionId ?? null);
        return { runId: cannedRunId, permissionMode: 'default' as const, substrate: substrate ?? ('sdk' as const) };
      }),
    } as unknown as WorkflowRegistry;

    return { workflowId, cannedRunId, fakeRegistry };
  }

  it('marks run failed when the session worktree HEAD snapshot throws', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = sessionHostedDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

      const { workflowId, cannedRunId, fakeRegistry } = makeErrorHandlingFixture(db);
      seedSession(db, 'sess-err', join(tmpDir, 'session-tree'));

      // The session worktree resolves, but snapshotting its HEAD (base_sha) throws.
      const fakeWorktree = {
        createDeterministicWorktree: vi.fn(),
        getProjectMainBranch: vi.fn().mockResolvedValue('main'),
        getHeadCommit: vi.fn().mockRejectedValue(new Error('git rev-parse failed')),
      } as unknown as WorktreeManager;

      const launcher = new RunLauncher(adapter, fakeRegistry, fakeWorktree, logger, fakeMcpConfigWriter, fakeOrchSocketProvider, fakeBridgeScriptResolver, fakeNodeResolver);

      await expect(
        launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, 'sess-err'),
      ).rejects.toThrow('git rev-parse failed');

      interface RunRow { status: string; error_message: string | null }
      const row = db.prepare('SELECT status, error_message FROM workflow_runs WHERE id = ?').get(cannedRunId) as RunRow;

      expect(row.status).toBe('failed');
      expect(row.error_message).not.toBeNull();
      expect(row.error_message).toContain('git rev-parse failed');
    });
  });

  it('marks run failed when mcpConfigWriter.writeForRun throws', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = sessionHostedDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

      const { workflowId, cannedRunId, fakeRegistry } = makeErrorHandlingFixture(db);

      const cannedWorktreePath = join(tmpDir, '.cyboflow', 'worktrees', 'sprint', cannedRunId.slice(0, 8));
      const cannedBranchName = `cyboflow/sprint/${cannedRunId.slice(0, 8)}`;
      seedSession(db, 'sess-err', cannedWorktreePath);

      const { worktree: fakeWorktree } = sessionWorktreeStub(cannedBranchName);

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

      await expect(
        launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, 'sess-err'),
      ).rejects.toThrow('mcp.json write denied');

      interface RunRow { status: string; error_message: string | null }
      const row = db.prepare('SELECT status, error_message FROM workflow_runs WHERE id = ?').get(cannedRunId) as RunRow;

      expect(row.status).toBe('failed');
      expect(row.error_message).not.toBeNull();
      expect(row.error_message).toContain('mcp.json write denied');
    });
  });

  it('does not orphan a row in queued state when worktree resolution fails', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = sessionHostedDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

      const { workflowId, cannedRunId, fakeRegistry } = makeErrorHandlingFixture(db);
      // Session row exists but has NO worktree_path → resolveSessionHostedWorktree
      // throws while the run is still 'queued'; the catch must mark it failed.
      db.prepare(
        "INSERT INTO sessions (id, worktree_path, base_branch, run_id) VALUES ('sess-err', NULL, 'main', NULL)",
      ).run();

      const fakeWorktree = {
        createDeterministicWorktree: vi.fn(),
        getProjectMainBranch: vi.fn(),
        getHeadCommit: vi.fn(),
      } as unknown as WorktreeManager;

      const launcher = new RunLauncher(adapter, fakeRegistry, fakeWorktree, logger, fakeMcpConfigWriter, fakeOrchSocketProvider, fakeBridgeScriptResolver, fakeNodeResolver);

      await expect(
        launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, 'sess-err'),
      ).rejects.toThrow(/no worktree_path/);

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
      const db = sessionHostedDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

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
      seedSession(db, 'sess-1', cannedWorktreePath);

      const fakeRegistry = {
        getById: (id: string) => {
          const row = db.prepare(
            'SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?',
          ).get(id);
          return row ?? null;
        },
        createRun: vi.fn((_id: string, substrate?: CliSubstrate, sessionId?: string) => {
          db.prepare(
            "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id) VALUES (?, ?, ?, 'queued', 'default', ?)",
          ).run(cannedRunId, workflowId, 1, sessionId ?? null);
          return { runId: cannedRunId, permissionMode: 'default' as const, substrate: substrate ?? ('sdk' as const) };
        }),
      } as unknown as WorkflowRegistry;

      const { worktree: fakeWorktree } = sessionWorktreeStub(cannedBranchName);

      // Spy publisher satisfying StreamEventPublisher interface
      const publishSpy = vi.fn();
      const spyPublisher: StreamEventPublisher = { publish: publishSpy };

      const launcher = new RunLauncher(
        adapter,
        fakeRegistry,
        fakeWorktree,
        logger,
        fakeMcpConfigWriter,
        fakeOrchSocketProvider,
        fakeBridgeScriptResolver,
        fakeNodeResolver,
        spyPublisher,
      );

      const result = await launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, 'sess-1');

      // publisher.publish must have been called at least once
      expect(publishSpy).toHaveBeenCalled();

      // The runId arg must match the returned runId
      const firstCall = publishSpy.mock.calls[0] as [
        string,
        { type: string; payload: Record<string, unknown>; timestamp: string },
      ];
      expect(firstCall[0]).toBe(result.runId);

      // The event must have type 'run_started'
      expect(firstCall[1].type).toBe('run_started');

      // The payload must include the inner type discriminant (RunStartedEvent contract).
      expect(firstCall[1].payload.type).toBe('run_started');

      // The payload must include the run coordinates so the renderer can
      // identify the run without a separate query.
      expect(firstCall[1].payload.runId).toBe(result.runId);
      expect(firstCall[1].payload.worktreePath).toBe(result.worktreePath);
      expect(firstCall[1].payload.branchName).toBe(result.branchName);

      // timestamp must be a non-empty ISO-8601 string
      expect(typeof firstCall[1].timestamp).toBe('string');
      expect(firstCall[1].timestamp.length).toBeGreaterThan(0);
      expect(() => new Date(firstCall[1].timestamp)).not.toThrow();
    });
  });

  it('launch succeeds without a publisher (publisher is optional)', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = sessionHostedDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

      const seedWorkflowId = randomUUID();
      db.prepare(
        "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES (?, 1, 'sprint', '/fake/path.md', 'default')",
      ).run(seedWorkflowId);

      interface IdRow { id: string }
      const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('sprint') as IdRow;

      const cannedRunId = randomUUID().replace(/-/g, '');
      const cannedWorktreePath = join(tmpDir, '.cyboflow', 'worktrees', 'sprint', cannedRunId.slice(0, 8));
      const cannedBranchName = `cyboflow/sprint/${cannedRunId.slice(0, 8)}`;
      seedSession(db, 'sess-1', cannedWorktreePath);

      const fakeRegistry = {
        getById: (id: string) => {
          const row = db.prepare(
            'SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?',
          ).get(id);
          return row ?? null;
        },
        createRun: vi.fn((_id: string, substrate?: CliSubstrate, sessionId?: string) => {
          db.prepare(
            "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id) VALUES (?, ?, ?, 'queued', 'default', ?)",
          ).run(cannedRunId, workflowId, 1, sessionId ?? null);
          return { runId: cannedRunId, permissionMode: 'default' as const, substrate: substrate ?? ('sdk' as const) };
        }),
      } as unknown as WorkflowRegistry;

      const { worktree: fakeWorktree } = sessionWorktreeStub(cannedBranchName);

      // No publisher passed — 9th arg omitted entirely (publisher is still optional)
      const launcher = new RunLauncher(adapter, fakeRegistry, fakeWorktree, logger, fakeMcpConfigWriter, fakeOrchSocketProvider, fakeBridgeScriptResolver, fakeNodeResolver);
      const result = await launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, 'sess-1');

      expect(result.runId).toBe(cannedRunId);
    });
  });
});

// ---------------------------------------------------------------------------
// RunLauncher constructor validation
// ---------------------------------------------------------------------------

describe('RunLauncher constructor validation', () => {
  function makeMinimalArgs() {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const fakeRegistry = {} as WorkflowRegistry;
    const fakeWorktree = {} as WorktreeManager;
    const logger = makeSpyLogger();
    return { adapter, fakeRegistry, fakeWorktree, logger };
  }

  it('throws when mcpConfigWriter is missing', () => {
    const { adapter, fakeRegistry, fakeWorktree, logger } = makeMinimalArgs();
    expect(
      () => new RunLauncher(
        adapter, fakeRegistry, fakeWorktree, logger,
        undefined as unknown as McpConfigWriter,
        fakeOrchSocketProvider, fakeBridgeScriptResolver, fakeNodeResolver,
      ),
    ).toThrow('RunLauncher: missing required collaborator mcpConfigWriter');
  });

  it('throws when orchSocketProvider is missing', () => {
    const { adapter, fakeRegistry, fakeWorktree, logger } = makeMinimalArgs();
    expect(
      () => new RunLauncher(
        adapter, fakeRegistry, fakeWorktree, logger,
        fakeMcpConfigWriter,
        undefined as unknown as OrchSocketProvider,
        fakeBridgeScriptResolver, fakeNodeResolver,
      ),
    ).toThrow('RunLauncher: missing required collaborator orchSocketProvider');
  });

  it('throws when bridgeScriptResolver is missing', () => {
    const { adapter, fakeRegistry, fakeWorktree, logger } = makeMinimalArgs();
    expect(
      () => new RunLauncher(
        adapter, fakeRegistry, fakeWorktree, logger,
        fakeMcpConfigWriter, fakeOrchSocketProvider,
        undefined as unknown as BridgeScriptResolver,
        fakeNodeResolver,
      ),
    ).toThrow('RunLauncher: missing required collaborator bridgeScriptResolver');
  });

  it('throws when nodeResolver is missing', () => {
    const { adapter, fakeRegistry, fakeWorktree, logger } = makeMinimalArgs();
    expect(
      () => new RunLauncher(
        adapter, fakeRegistry, fakeWorktree, logger,
        fakeMcpConfigWriter, fakeOrchSocketProvider, fakeBridgeScriptResolver,
        undefined as unknown as NodeResolver,
      ),
    ).toThrow('RunLauncher: missing required collaborator nodeResolver');
  });

  it('launch without runExecutor still calls mcpConfigWriter.writeForRun (legacy path regression guard)', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = sessionHostedDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

      const workflowId = randomUUID();
      db.prepare(
        "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES (?, 1, 'sprint', '/fake/path.md', 'default')",
      ).run(workflowId);

      const cannedRunId = randomUUID().replace(/-/g, '');
      const cannedWorktreePath = join(tmpDir, '.cyboflow', 'worktrees', 'sprint', cannedRunId.slice(0, 8));
      const cannedBranchName = `cyboflow/sprint/${cannedRunId.slice(0, 8)}`;
      seedSession(db, 'sess-1', cannedWorktreePath);

      const fakeRegistry = {
        getById: (id: string) => {
          const row = db.prepare(
            'SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?',
          ).get(id);
          return row ?? null;
        },
        createRun: vi.fn((_id: string, substrate?: CliSubstrate, sessionId?: string) => {
          db.prepare(
            "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id) VALUES (?, ?, ?, 'queued', 'default', ?)",
          ).run(cannedRunId, workflowId, 1, sessionId ?? null);
          return { runId: cannedRunId, permissionMode: 'default' as const, substrate: substrate ?? ('sdk' as const) };
        }),
      } as unknown as WorkflowRegistry;

      const { worktree: fakeWorktree } = sessionWorktreeStub(cannedBranchName);

      const writeForRunSpy = vi.fn().mockResolvedValue(join(cannedWorktreePath, '.mcp.json'));
      const spyMcpConfigWriter: McpConfigWriter = { writeForRun: writeForRunSpy } as unknown as McpConfigWriter;

      const launcher = new RunLauncher(
        adapter, fakeRegistry, fakeWorktree, logger,
        spyMcpConfigWriter, fakeOrchSocketProvider, fakeBridgeScriptResolver, fakeNodeResolver,
      );

      await launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, 'sess-1');

      // Must have been called — no runExecutor supplied, so legacy path is active
      expect(writeForRunSpy).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // SDK substrate guard — TASK-660
  // -------------------------------------------------------------------------

  /**
   * Shared fixture factory for the three TASK-660 SDK-guard tests.
   * Seeds a workflow row and returns a WorkflowRegistry stub + canned IDs.
   */
  async function makeSDKFixture(db: Database.Database, tmpDir: string) {
    const workflowId = randomUUID();
    db.prepare(
      "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES (?, 1, 'prune', '/fake/path.md', 'default')",
    ).run(workflowId);

    const cannedRunId = randomUUID().replace(/-/g, '');
    const cannedWorktreePath = join(tmpDir, '.cyboflow', 'worktrees', 'prune', cannedRunId.slice(0, 8));
    const cannedBranchName = `cyboflow/prune/${cannedRunId.slice(0, 8)}`;
    // Every run is session-hosted now — seed the owning session whose worktree the
    // run reuses, and hand the caller its id to thread into launch.
    const sessionId = 'sess-sdk';
    seedSession(db, sessionId, cannedWorktreePath);

    const fakeRegistry = {
      getById: (id: string) => {
        const row = db.prepare(
          'SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?',
        ).get(id);
        return row ?? null;
      },
      createRun: vi.fn((_id: string, substrate?: CliSubstrate, sid?: string) => {
        db.prepare(
          "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id) VALUES (?, ?, ?, 'queued', 'default', ?)",
        ).run(cannedRunId, workflowId, 1, sid ?? null);
        return { runId: cannedRunId, permissionMode: 'default' as const, substrate: substrate ?? ('sdk' as const) };
      }),
    } as unknown as WorkflowRegistry;

    const { worktree: fakeWorktree } = sessionWorktreeStub(cannedBranchName);

    // A RunExecutor stub — execute() resolves immediately (no real spawn)
    const fakeRunExecutor = {
      execute: vi.fn().mockResolvedValue(undefined),
    } as unknown as RunExecutor;

    return { workflowId, sessionId, cannedRunId, cannedWorktreePath, cannedBranchName, fakeRegistry, fakeWorktree, fakeRunExecutor };
  }

  it('launch with runExecutor skips mcpConfigWriter.writeForRun', async () => {
    await withTempDir('runlauncher-sdk-test-', async (tmpDir) => {
      const db = sessionHostedDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

      const { workflowId, sessionId, fakeRegistry, fakeWorktree, fakeRunExecutor } = await makeSDKFixture(db, tmpDir);

      const writeForRunSpy = vi.fn().mockResolvedValue('/fake/.mcp.json');
      const spyMcpConfigWriter: McpConfigWriter = { writeForRun: writeForRunSpy } as unknown as McpConfigWriter;

      // orchSocketProvider and bridgeScriptResolver omitted (undefined) to prove
      // they are never consulted when runExecutor is supplied.
      const launcher = new RunLauncher(
        adapter,
        fakeRegistry,
        fakeWorktree,
        logger,
        spyMcpConfigWriter,
        undefined as unknown as OrchSocketProvider,
        undefined as unknown as BridgeScriptResolver,
        undefined as unknown as NodeResolver,
        undefined,
        fakeRunExecutor,
      );

      await launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, sessionId);

      // writeForRun must NOT be called on the SDK path
      expect(writeForRunSpy).not.toHaveBeenCalled();
    });
  });

  it('launch with runExecutor skips orchSocketProvider.getSocketPath', async () => {
    await withTempDir('runlauncher-sdk-test-', async (tmpDir) => {
      const db = sessionHostedDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

      const { workflowId, sessionId, fakeRegistry, fakeWorktree, fakeRunExecutor } = await makeSDKFixture(db, tmpDir);

      // Sentinel: if getSocketPath() is called, the test fails immediately.
      const throwingOrchSocketProvider: OrchSocketProvider = {
        getSocketPath: () => {
          throw new Error('TEST FAILURE: orchSocketProvider.getSocketPath called on SDK path');
        },
      };

      const launcher = new RunLauncher(
        adapter,
        fakeRegistry,
        fakeWorktree,
        logger,
        fakeMcpConfigWriter,
        throwingOrchSocketProvider,
        undefined as unknown as BridgeScriptResolver,
        undefined as unknown as NodeResolver,
        undefined,
        fakeRunExecutor,
      );

      // Must not throw from the sentinel
      await expect(launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, sessionId)).resolves.not.toThrow();
    });
  });

  it('constructor accepts SDK substrate with no legacy collaborators when runExecutor is provided', () => {
    const db = createTestDb();
    const adapter = dbAdapter(db);
    const fakeRegistry = {} as WorkflowRegistry;
    const fakeWorktree = {} as WorktreeManager;
    const logger = makeSpyLogger();
    const fakeRunExecutor = { execute: vi.fn() } as unknown as RunExecutor;

    // Must NOT throw even though the four legacy collaborators are undefined
    expect(
      () => new RunLauncher(
        adapter,
        fakeRegistry,
        fakeWorktree,
        logger,
        undefined as unknown as McpConfigWriter,
        undefined as unknown as OrchSocketProvider,
        undefined as unknown as BridgeScriptResolver,
        undefined as unknown as NodeResolver,
        undefined,
        fakeRunExecutor,
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// RunLauncher.launch — ideaId seed (migration 017)
// ---------------------------------------------------------------------------

describe('RunLauncher.launch ideaId seed', () => {
  /**
   * Builds a launcher whose registry seeds a queued run row, plus a deriver spy.
   * Returns the launcher, db, deriver spies, and the canned runId.
   */
  function makeSeedFixture(db: Database.Database, tmpDir: string) {
    const adapter = dbAdapter(db);
    const logger = makeSpyLogger();

    const seedWorkflowId = randomUUID();
    db.prepare(
      "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES (?, 1, 'planner', '/fake/planner.md', 'default')",
    ).run(seedWorkflowId);

    interface IdRow { id: string }
    const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get('planner') as IdRow;

    const cannedRunId = randomUUID().replace(/-/g, '');
    const cannedWorktreePath = join(tmpDir, '.cyboflow', 'worktrees', 'planner', cannedRunId.slice(0, 8));
    const cannedBranchName = `cyboflow/planner/${cannedRunId.slice(0, 8)}`;
    const sessionId = 'sess-idea';
    seedSession(db, sessionId, cannedWorktreePath);

    const fakeRegistry = {
      getById: (id: string) => {
        const row = db.prepare(
          'SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?',
        ).get(id);
        return row ?? null;
      },
      createRun: vi.fn((_id: string, substrate?: CliSubstrate, sid?: string) => {
        db.prepare(
          "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id) VALUES (?, ?, ?, 'queued', 'default', ?)",
        ).run(cannedRunId, workflowId, 1, sid ?? null);
        return { runId: cannedRunId, permissionMode: 'default' as const, substrate: substrate ?? ('sdk' as const) };
      }),
    } as unknown as WorkflowRegistry;

    const { worktree: fakeWorktree } = sessionWorktreeStub(cannedBranchName);

    const recomputeSpy = vi.fn().mockResolvedValue(undefined);
    const applyChangeSpy = vi.fn();
    const deriver = { applyChange: applyChangeSpy, recomputeTaskExecutionStage: recomputeSpy };

    const launcher = new RunLauncher(
      adapter,
      fakeRegistry,
      fakeWorktree,
      logger,
      fakeMcpConfigWriter,
      fakeOrchSocketProvider,
      fakeBridgeScriptResolver,
      fakeNodeResolver,
      undefined, // publisher
      undefined, // runExecutor
      undefined, // runQueueRegistry
      deriver,   // taskStageDeriver (12th arg)
    );

    return { launcher, workflowId, sessionId, cannedRunId, recomputeSpy };
  }

  it('writes seed_idea_id directly and does NOT call the task-stage deriver', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = sessionHostedDb();
      const { launcher, workflowId, sessionId, cannedRunId, recomputeSpy } = makeSeedFixture(db, tmpDir);

      await launcher.launch(workflowId, tmpDir, undefined, undefined, 'IDEA-42', sessionId);

      interface SeedRow { seed_idea_id: string | null; task_id: string | null }
      const row = db
        .prepare('SELECT seed_idea_id, task_id FROM workflow_runs WHERE id = ?')
        .get(cannedRunId) as SeedRow;

      // seed_idea_id is written; task_id stays null (no task link from an ideaId).
      expect(row.seed_idea_id).toBe('IDEA-42');
      expect(row.task_id).toBeNull();
      // The seed idea participates in NO stage derivation.
      expect(recomputeSpy).not.toHaveBeenCalled();
    });
  });

  it('leaves seed_idea_id null when no ideaId is supplied', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = sessionHostedDb();
      const { launcher, workflowId, sessionId, cannedRunId } = makeSeedFixture(db, tmpDir);

      await launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, sessionId);

      const row = db
        .prepare('SELECT seed_idea_id FROM workflow_runs WHERE id = ?')
        .get(cannedRunId) as { seed_idea_id: string | null };

      expect(row.seed_idea_id).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// RunLauncher.launch — seedTaskIds (feat/parallel-sprint, single-run lane model)
//
// Every run is session-hosted (slice 1b): the fixture seeds a session whose
// worktree the run reuses. The sprint-lane store is a narrow spy (SprintLanesLike)
// — no real sprint_batches tables are needed. The seedTaskIds-validation rejection
// tests fire BEFORE the session guard, so they still launch session-less.
// ---------------------------------------------------------------------------

describe('RunLauncher.launch seedTaskIds (sprint lanes)', () => {
  /**
   * Build a launcher whose registry seeds a queued run row (createRun returns
   * the RESOLVED substrate, mirroring the real registry) plus a sprint-lane spy.
   * `workflowName` controls the sprint-only guard.
   */
  function makeSprintFixture(db: Database.Database, tmpDir: string, workflowName: string, opts?: { omitSprintLanes?: boolean }) {
    // batch_id (sprint lanes, migration 022) now comes from the shared fixture's
    // includeWorkflowRunTaskColumns block — no manual ALTER here.
    const adapter = dbAdapter(db);
    const logger = makeSpyLogger();

    const seedWorkflowId = randomUUID();
    db.prepare(
      "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES (?, 1, ?, '/fake/sprint.md', 'default')",
    ).run(seedWorkflowId, workflowName);

    const cannedRunId = randomUUID().replace(/-/g, '');
    const cannedWorktreePath = join(tmpDir, '.cyboflow', 'worktrees', workflowName, cannedRunId.slice(0, 8));
    const cannedBranchName = `cyboflow/${workflowName}/${cannedRunId.slice(0, 8)}`;
    const sessionId = 'sess-sprint';
    seedSession(db, sessionId, cannedWorktreePath);

    const createRunSpy = vi.fn((_id: string, substrate?: CliSubstrate, sid?: string) => {
      db.prepare(
        "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id) VALUES (?, ?, ?, 'queued', 'default', ?)",
      ).run(cannedRunId, seedWorkflowId, 1, sid ?? null);
      // Mirror the real registry: the RESOLVED substrate is returned (request
      // wins; floor 'sdk').
      return { runId: cannedRunId, permissionMode: 'default' as const, substrate: substrate ?? ('sdk' as const) };
    });

    const fakeRegistry = {
      getById: (id: string) =>
        db.prepare('SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?').get(id) ?? null,
      createRun: createRunSpy,
    } as unknown as WorkflowRegistry;

    const { worktree: fakeWorktree } = sessionWorktreeStub(cannedBranchName);

    const createForRunSpy = vi.fn((_projectId: number, _substrate: CliSubstrate, _taskIds: string[]) => ({
      batchId: 'batch-test-1',
    }));

    const launcher = new RunLauncher(
      adapter,
      fakeRegistry,
      fakeWorktree,
      logger,
      fakeMcpConfigWriter,
      fakeOrchSocketProvider,
      fakeBridgeScriptResolver,
      fakeNodeResolver,
      undefined, // publisher
      undefined, // runExecutor
      undefined, // runQueueRegistry
      undefined, // taskStageDeriver
      opts?.omitSprintLanes ? undefined : { createForRun: createForRunSpy }, // sprintLanes (13th arg)
    );

    return { launcher, workflowId: seedWorkflowId, sessionId, cannedRunId, createRunSpy, createForRunSpy };
  }

  it('creates the lanes via createForRun (project_id + RESOLVED substrate + taskIds) and stamps batch_id', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = sessionHostedDb();
      const { launcher, workflowId, sessionId, cannedRunId, createForRunSpy } = makeSprintFixture(db, tmpDir, 'sprint');

      await launcher.launch(
        workflowId,
        tmpDir,
        'interactive',
        undefined, // taskId
        undefined, // ideaId
        sessionId, // sessionId (required)
        undefined, // requestedPermissionMode
        undefined, // baseBranch
        ['TASK-1', 'TASK-2'], // seedTaskIds
      );

      // createForRun receives the workflows row's project_id and the run's
      // RESOLVED substrate (returned by createRun), not the raw request only.
      expect(createForRunSpy).toHaveBeenCalledTimes(1);
      expect(createForRunSpy).toHaveBeenCalledWith(1, 'interactive', ['TASK-1', 'TASK-2']);

      const row = db
        .prepare('SELECT batch_id FROM workflow_runs WHERE id = ?')
        .get(cannedRunId) as { batch_id: string | null };
      expect(row.batch_id).toBe('batch-test-1');
    });
  });

  it('rejects seedTaskIds for a non-sprint workflow BEFORE creating a run row', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = sessionHostedDb();
      const { launcher, workflowId, createRunSpy, createForRunSpy } = makeSprintFixture(db, tmpDir, 'planner');

      await expect(
        launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, undefined, undefined, undefined, ['TASK-1']),
      ).rejects.toThrow(/seedTaskIds is only valid for the 'sprint' workflow/);

      // The guard fires before createRun — no half-created run row.
      expect(createRunSpy).not.toHaveBeenCalled();
      expect(createForRunSpy).not.toHaveBeenCalled();
    });
  });

  it('rejects an empty seedTaskIds array', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = sessionHostedDb();
      const { launcher, workflowId, createRunSpy } = makeSprintFixture(db, tmpDir, 'sprint');

      await expect(
        launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, undefined, undefined, undefined, []),
      ).rejects.toThrow(/at least one task id/);
      expect(createRunSpy).not.toHaveBeenCalled();
    });
  });

  it('rejects seedTaskIds when no sprintLanes store is wired', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = sessionHostedDb();
      const { launcher, workflowId, createRunSpy } = makeSprintFixture(db, tmpDir, 'sprint', { omitSprintLanes: true });

      await expect(
        launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, undefined, undefined, undefined, ['TASK-1']),
      ).rejects.toThrow(/no sprintLanes store is wired/);
      expect(createRunSpy).not.toHaveBeenCalled();
    });
  });

  it('does not touch the lane store and leaves batch_id null when seedTaskIds is omitted', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = sessionHostedDb();
      const { launcher, workflowId, sessionId, cannedRunId, createForRunSpy } = makeSprintFixture(db, tmpDir, 'sprint');

      await launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, sessionId);

      expect(createForRunSpy).not.toHaveBeenCalled();
      const row = db
        .prepare('SELECT batch_id FROM workflow_runs WHERE id = ?')
        .get(cannedRunId) as { batch_id: string | null };
      expect(row.batch_id).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// RunLauncher.launch — findingIds (findings-triage redesign / migration 034)
//
// Every run is session-hosted (slice 1b): the fixture seeds a session whose
// worktree the run reuses. findingIds is the 12th (LAST) positional launch arg.
// The seed is a direct workflow_runs write — no store dependency — so the only
// collaborators are the registry + worktree stubs. seed_finding_ids comes from
// sessionHostedDb(). The findingIds-validation rejection tests fire BEFORE the
// session guard, so they still launch session-less.
// ---------------------------------------------------------------------------

describe('RunLauncher.launch findingIds (compound seed)', () => {
  /**
   * Build a launcher whose registry seeds a queued run row (createRun returns the
   * RESOLVED substrate, mirroring the real registry). `workflowName` controls the
   * compound-only guard. The DB gains the migration-034 seed_finding_ids column.
   */
  function makeFindingFixture(db: Database.Database, tmpDir: string, workflowName: string) {
    // seed_finding_ids (migration 034) is provided by sessionHostedDb() — no ALTER here.
    const adapter = dbAdapter(db);
    const logger = makeSpyLogger();

    const seedWorkflowId = randomUUID();
    db.prepare(
      "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES (?, 1, ?, '/fake/compound.md', 'default')",
    ).run(seedWorkflowId, workflowName);

    const cannedRunId = randomUUID().replace(/-/g, '');
    const cannedWorktreePath = join(tmpDir, '.cyboflow', 'worktrees', workflowName, cannedRunId.slice(0, 8));
    const cannedBranchName = `cyboflow/${workflowName}/${cannedRunId.slice(0, 8)}`;
    const sessionId = 'sess-finding';
    seedSession(db, sessionId, cannedWorktreePath);

    const createRunSpy = vi.fn((_id: string, substrate?: CliSubstrate, sid?: string) => {
      db.prepare(
        "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id) VALUES (?, ?, ?, 'queued', 'default', ?)",
      ).run(cannedRunId, seedWorkflowId, 1, sid ?? null);
      return { runId: cannedRunId, permissionMode: 'default' as const, substrate: substrate ?? ('sdk' as const) };
    });

    const fakeRegistry = {
      getById: (id: string) =>
        db.prepare('SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?').get(id) ?? null,
      createRun: createRunSpy,
    } as unknown as WorkflowRegistry;

    const { worktree: fakeWorktree } = sessionWorktreeStub(cannedBranchName);

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

    return { launcher, workflowId: seedWorkflowId, sessionId, cannedRunId, createRunSpy };
  }

  it('stamps seed_finding_ids = JSON.stringify(ids) for a compound launch', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = sessionHostedDb();
      const { launcher, workflowId, sessionId, cannedRunId } = makeFindingFixture(db, tmpDir, 'compound');

      await launcher.launch(
        workflowId,
        tmpDir,
        undefined, // substrate
        undefined, // taskId
        undefined, // ideaId
        sessionId, // sessionId (required)
        undefined, // requestedPermissionMode
        undefined, // baseBranch
        undefined, // seedTaskIds
        undefined, // projectId
        undefined, // requestedExecutionModel
        ['rvw_a', 'rvw_b'], // findingIds (12th, LAST)
      );

      const row = db
        .prepare('SELECT seed_finding_ids FROM workflow_runs WHERE id = ?')
        .get(cannedRunId) as { seed_finding_ids: string | null };
      expect(row.seed_finding_ids).toBe(JSON.stringify(['rvw_a', 'rvw_b']));
    });
  });

  it('rejects findingIds for a non-compound workflow BEFORE creating a run row', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = sessionHostedDb();
      const { launcher, workflowId, createRunSpy } = makeFindingFixture(db, tmpDir, 'sprint');

      await expect(
        launcher.launch(
          workflowId, tmpDir,
          undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
          ['rvw_a'],
        ),
      ).rejects.toThrow("findingIds is only valid for the 'compound' workflow");

      // The guard fires before createRun — no half-created run row.
      expect(createRunSpy).not.toHaveBeenCalled();
    });
  });

  it('rejects an empty findingIds array BEFORE creating a run row', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = sessionHostedDb();
      const { launcher, workflowId, createRunSpy } = makeFindingFixture(db, tmpDir, 'compound');

      await expect(
        launcher.launch(
          workflowId, tmpDir,
          undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
          [],
        ),
      ).rejects.toThrow('findingIds must contain at least one finding id');
      expect(createRunSpy).not.toHaveBeenCalled();
    });
  });

  it('leaves seed_finding_ids null when findingIds is omitted (legacy path byte-identical)', async () => {
    await withTempDir('runlauncher-test-', async (tmpDir) => {
      const db = sessionHostedDb();
      const { launcher, workflowId, sessionId, cannedRunId } = makeFindingFixture(db, tmpDir, 'compound');

      await launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, sessionId);

      const row = db
        .prepare('SELECT seed_finding_ids FROM workflow_runs WHERE id = ?')
        .get(cannedRunId) as { seed_finding_ids: string | null };
      expect(row.seed_finding_ids).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// RunLauncher.launch — session-hosted runs (session<->run restructure, Phase 1)
//
// When a sessionId is supplied, the run executes inside that session's EXISTING
// worktree instead of creating its own: createDeterministicWorktree is NOT called,
// worktree_path/branch_name come from the session, base_sha is snapshotted from
// the session worktree HEAD, session_id is stamped, and sessions.run_id is
// dual-written. A one-running-at-a-time guard rejects a 2nd concurrent run.
// ---------------------------------------------------------------------------

describe('RunLauncher.launch session-hosted (Phase 1)', () => {
  /**
   * Build a test DB that carries the columns + sessions table the session-hosted
   * path reads/writes: workflow_runs.session_id + base_sha (via the task-column
   * option) and a minimal sessions table (worktree_path / base_branch / run_id).
   */
  function makeSessionDb(): Database.Database {
    const db = createTestDb({ includeWorkflowRunTaskColumns: true });
    db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        worktree_path TEXT,
        base_branch TEXT,
        run_id TEXT,
        substrate TEXT,
        in_place BOOLEAN DEFAULT 0,
        is_main_repo BOOLEAN DEFAULT 0
      )
    `);
    return db;
  }

  /**
   * Seed a workflow row and return a registry whose createRun mirrors the real
   * one: it inserts a queued workflow_runs row stamping the supplied session_id.
   */
  function makeSessionRegistry(db: Database.Database, workflowName: string, cannedRunId: string): {
    registry: WorkflowRegistry;
    workflowId: string;
    createRunSpy: ReturnType<typeof vi.fn>;
  } {
    const seedWorkflowId = randomUUID();
    db.prepare(
      "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES (?, 1, ?, '/fake/path.md', 'default')",
    ).run(seedWorkflowId, workflowName);
    interface IdRow { id: string }
    const { id: workflowId } = db.prepare('SELECT id FROM workflows WHERE name = ?').get(workflowName) as IdRow;

    const createRunSpy = vi.fn((_id: string, substrate?: CliSubstrate, sessionId?: string) => {
      db.prepare(
        "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id) VALUES (?, ?, ?, 'queued', 'default', ?)",
      ).run(cannedRunId, workflowId, 1, sessionId ?? null);
      // Mirror the real registry: return the RESOLVED substrate (request → ladder
      // → 'sdk' floor) so the launcher's sessions.substrate stamp keys off it.
      return { runId: cannedRunId, permissionMode: 'default' as const, substrate: substrate ?? ('sdk' as const) };
    });
    const registry = {
      getById: (id: string) =>
        db.prepare('SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?').get(id) ?? null,
      createRun: createRunSpy,
    } as unknown as WorkflowRegistry;

    return { registry, workflowId, createRunSpy };
  }

  it('refuses to host a run in an in-place session (migration 046 guard)', async () => {
    await withTempDir('runlauncher-session-', async (tmpDir) => {
      const db = makeSessionDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

      const cannedRunId = randomUUID().replace(/-/g, '');
      // An in-place session carries a REAL worktree_path (the project checkout), so
      // it is the in_place flag — not a missing worktree — that must block the launch.
      db.prepare(
        "INSERT INTO sessions (id, worktree_path, base_branch, run_id, in_place) VALUES ('sess-inplace', ?, 'main', NULL, 1)",
      ).run(join(tmpDir, 'project-checkout'));

      const { registry, workflowId } = makeSessionRegistry(db, 'sprint', cannedRunId);

      const createDeterministicWorktree = vi.fn();
      const getProjectMainBranch = vi.fn().mockResolvedValue('main');
      const fakeWorktree = {
        createDeterministicWorktree,
        getProjectMainBranch,
        getHeadCommit: vi.fn().mockResolvedValue('abc123def456'),
      } as unknown as WorktreeManager;

      const launcher = new RunLauncher(
        adapter, registry, fakeWorktree, logger,
        fakeMcpConfigWriter, fakeOrchSocketProvider, fakeBridgeScriptResolver, fakeNodeResolver,
      );

      await expect(
        launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, 'sess-inplace'),
      ).rejects.toThrow(/works directly in the project checkout \(in-place\)/);

      // The guard fires inside resolveSessionHostedWorktree (after createRun queued
      // the row), so the run is marked failed and NO worktree is ever provisioned.
      interface RunRow { status: string }
      const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(cannedRunId) as RunRow;
      expect(row.status).toBe('failed');
      expect(createDeterministicWorktree).not.toHaveBeenCalled();
      // The guard is reached BEFORE the branch resolution.
      expect(getProjectMainBranch).not.toHaveBeenCalled();
    });
  });

  it('reuses the session worktree, stamps session_id + base_sha, dual-writes sessions.run_id, and does NOT create a worktree', async () => {
    await withTempDir('runlauncher-session-', async (tmpDir) => {
      const db = makeSessionDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

      const cannedRunId = randomUUID().replace(/-/g, '');
      const sessionWorktree = join(tmpDir, 'session-tree');
      db.prepare(
        "INSERT INTO sessions (id, worktree_path, base_branch, run_id) VALUES ('sess-1', ?, 'main', NULL)",
      ).run(sessionWorktree);

      const { registry, workflowId, createRunSpy } = makeSessionRegistry(db, 'sprint', cannedRunId);

      const createDeterministicWorktree = vi.fn();
      const fakeWorktree = {
        createDeterministicWorktree,
        // The session path resolves the branch from the worktree's current branch
        // and snapshots HEAD via getHeadCommit.
        getProjectMainBranch: vi.fn().mockResolvedValue('feature/session-branch'),
        getHeadCommit: vi.fn().mockResolvedValue('deadbeefcafef00d'),
      } as unknown as WorktreeManager;

      const launcher = new RunLauncher(
        adapter, registry, fakeWorktree, logger,
        fakeMcpConfigWriter, fakeOrchSocketProvider, fakeBridgeScriptResolver, fakeNodeResolver,
      );

      const result = await launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, 'sess-1');

      // createRun received the sessionId as its 3rd argument; the 4th
      // (requestedPermissionMode) and 5th (launch projectId opts) are undefined on
      // this no-override, no-projectId launch.
      expect(createRunSpy).toHaveBeenCalledWith(workflowId, undefined, 'sess-1', undefined, undefined);

      // NO dedicated worktree was created — the run reuses the session tree.
      expect(createDeterministicWorktree).not.toHaveBeenCalled();

      // Returned + persisted worktree_path is the session tree; branch resolved
      // from the session worktree's current branch.
      expect(result.worktreePath).toBe(sessionWorktree);
      expect(result.branchName).toBe('feature/session-branch');

      interface RunRow { worktree_path: string; branch_name: string; base_sha: string | null; session_id: string | null; status: string }
      const row = db
        .prepare('SELECT worktree_path, branch_name, base_sha, session_id, status FROM workflow_runs WHERE id = ?')
        .get(cannedRunId) as RunRow;
      expect(row.worktree_path).toBe(sessionWorktree);
      expect(row.branch_name).toBe('feature/session-branch');
      expect(row.base_sha).toBe('deadbeefcafef00d');
      expect(row.session_id).toBe('sess-1');
      expect(row.status).toBe('starting');

      // Legacy back-link dual-write: sessions.run_id now points at this run, and
      // the session's substrate is kept in lockstep with the run it hosts (the
      // resolved 'sdk' floor here, since this launch passed no substrate).
      const sessRow = db
        .prepare("SELECT run_id, substrate FROM sessions WHERE id = 'sess-1'")
        .get() as { run_id: string | null; substrate: string | null };
      expect(sessRow.run_id).toBe(cannedRunId);
      expect(sessRow.substrate).toBe('sdk');
    });
  });

  it('stamps sessions.substrate to the run substrate so the resting view stays PTY after cancel', async () => {
    await withTempDir('runlauncher-session-sub-', async (tmpDir) => {
      const db = makeSessionDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

      const cannedRunId = randomUUID().replace(/-/g, '');
      const sessionWorktree = join(tmpDir, 'session-tree');
      // Session was created on the SDK default (e.g. ensureSessionForLaunch),
      // then hosts an INTERACTIVE run — the mismatch that made cancel fall back
      // to the SDK resting view.
      db.prepare(
        "INSERT INTO sessions (id, worktree_path, base_branch, run_id, substrate) VALUES ('sess-pty', ?, 'main', NULL, 'sdk')",
      ).run(sessionWorktree);

      const { registry, workflowId } = makeSessionRegistry(db, 'sprint', cannedRunId);

      const fakeWorktree = {
        createDeterministicWorktree: vi.fn(),
        getProjectMainBranch: vi.fn().mockResolvedValue('feature/session-branch'),
        getHeadCommit: vi.fn().mockResolvedValue('deadbeefcafef00d'),
      } as unknown as WorktreeManager;

      const launcher = new RunLauncher(
        adapter, registry, fakeWorktree, logger,
        fakeMcpConfigWriter, fakeOrchSocketProvider, fakeBridgeScriptResolver, fakeNodeResolver,
      );

      // 3rd positional arg is the explicit per-run substrate.
      await launcher.launch(workflowId, tmpDir, 'interactive', undefined, undefined, 'sess-pty');

      const sessRow = db
        .prepare("SELECT run_id, substrate FROM sessions WHERE id = 'sess-pty'")
        .get() as { run_id: string | null; substrate: string | null };
      expect(sessRow.run_id).toBe(cannedRunId);
      // The session now reflects the interactive substrate the run actually used,
      // so the post-cancel resting ClaudePanel renders the PTY surface (not SDK).
      expect(sessRow.substrate).toBe('interactive');
    });
  });

  it('falls back to the session base_branch when the worktree branch cannot be read', async () => {
    await withTempDir('runlauncher-session-', async (tmpDir) => {
      const db = makeSessionDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

      const cannedRunId = randomUUID().replace(/-/g, '');
      const sessionWorktree = join(tmpDir, 'session-tree');
      db.prepare(
        "INSERT INTO sessions (id, worktree_path, base_branch, run_id) VALUES ('sess-fb', ?, 'develop', NULL)",
      ).run(sessionWorktree);

      const { registry, workflowId } = makeSessionRegistry(db, 'sprint', cannedRunId);

      const fakeWorktree = {
        createDeterministicWorktree: vi.fn(),
        getProjectMainBranch: vi.fn().mockRejectedValue(new Error('detached HEAD')),
        getHeadCommit: vi.fn().mockResolvedValue('abc123def456'),
      } as unknown as WorktreeManager;

      const launcher = new RunLauncher(
        adapter, registry, fakeWorktree, logger,
        fakeMcpConfigWriter, fakeOrchSocketProvider, fakeBridgeScriptResolver, fakeNodeResolver,
      );

      const result = await launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, 'sess-fb');

      // The live ref read failed → branch falls back to the session's base_branch.
      expect(result.branchName).toBe('develop');
    });
  });

  it('throws and does NOT create a run when the session worktree_path is missing', async () => {
    await withTempDir('runlauncher-session-', async (tmpDir) => {
      const db = makeSessionDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

      const cannedRunId = randomUUID().replace(/-/g, '');
      // A session row with a NULL worktree_path — must fail loudly.
      db.prepare(
        "INSERT INTO sessions (id, worktree_path, base_branch, run_id) VALUES ('sess-nowt', NULL, 'main', NULL)",
      ).run();

      const { registry, workflowId } = makeSessionRegistry(db, 'sprint', cannedRunId);

      const fakeWorktree = {
        createDeterministicWorktree: vi.fn(),
        getProjectMainBranch: vi.fn(),
        getHeadCommit: vi.fn(),
      } as unknown as WorktreeManager;

      const launcher = new RunLauncher(
        adapter, registry, fakeWorktree, logger,
        fakeMcpConfigWriter, fakeOrchSocketProvider, fakeBridgeScriptResolver, fakeNodeResolver,
      );

      await expect(
        launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, 'sess-nowt'),
      ).rejects.toThrow(/no worktree_path/);

      // The just-created run is marked failed (not left half-created in 'queued').
      const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(cannedRunId) as { status: string };
      expect(row.status).toBe('failed');
    });
  });

  it('one-running-at-a-time guard: rejects a 2nd concurrent run for the same session BEFORE creating it', async () => {
    await withTempDir('runlauncher-session-', async (tmpDir) => {
      const db = makeSessionDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

      const sessionWorktree = join(tmpDir, 'session-tree');
      db.prepare(
        "INSERT INTO sessions (id, worktree_path, base_branch, run_id) VALUES ('sess-busy', ?, 'main', NULL)",
      ).run(sessionWorktree);

      // An existing in-flight run already owns this session (status='running').
      db.prepare(
        "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES ('wf-existing', 1, 'sprint', '/fake/path.md', 'default')",
      ).run();
      db.prepare(
        "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id) VALUES ('run-existing', 'wf-existing', 1, 'running', 'default', 'sess-busy')",
      ).run();

      const cannedRunId = randomUUID().replace(/-/g, '');
      const { registry, workflowId, createRunSpy } = makeSessionRegistry(db, 'planner', cannedRunId);

      const fakeWorktree = {
        createDeterministicWorktree: vi.fn(),
        getProjectMainBranch: vi.fn(),
        getHeadCommit: vi.fn(),
      } as unknown as WorktreeManager;

      const launcher = new RunLauncher(
        adapter, registry, fakeWorktree, logger,
        fakeMcpConfigWriter, fakeOrchSocketProvider, fakeBridgeScriptResolver, fakeNodeResolver,
      );

      await expect(
        launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, 'sess-busy'),
      ).rejects.toThrow(/already has a running workflow/);

      // The guard fires BEFORE createRun, so no half-created run is left behind.
      expect(createRunSpy).not.toHaveBeenCalled();
      const count = db
        .prepare("SELECT COUNT(*) AS n FROM workflow_runs WHERE session_id = 'sess-busy'")
        .get() as { n: number };
      expect(count.n).toBe(1); // only the pre-existing run
    });
  });

  it('allows a new session-hosted run when the session has only terminal prior runs', async () => {
    await withTempDir('runlauncher-session-', async (tmpDir) => {
      const db = makeSessionDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

      const sessionWorktree = join(tmpDir, 'session-tree');
      db.prepare(
        "INSERT INTO sessions (id, worktree_path, base_branch, run_id) VALUES ('sess-free', ?, 'main', NULL)",
      ).run(sessionWorktree);

      // A prior run for this session that already completed — must NOT block a new run.
      db.prepare(
        "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES ('wf-done', 1, 'sprint', '/fake/path.md', 'default')",
      ).run();
      db.prepare(
        "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id) VALUES ('run-done', 'wf-done', 1, 'completed', 'default', 'sess-free')",
      ).run();

      const cannedRunId = randomUUID().replace(/-/g, '');
      const { registry, workflowId, createRunSpy } = makeSessionRegistry(db, 'planner', cannedRunId);

      const fakeWorktree = {
        createDeterministicWorktree: vi.fn(),
        getProjectMainBranch: vi.fn().mockResolvedValue('main'),
        getHeadCommit: vi.fn().mockResolvedValue('cafe1234'),
      } as unknown as WorktreeManager;

      const launcher = new RunLauncher(
        adapter, registry, fakeWorktree, logger,
        fakeMcpConfigWriter, fakeOrchSocketProvider, fakeBridgeScriptResolver, fakeNodeResolver,
      );

      const result = await launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, 'sess-free');

      expect(createRunSpy).toHaveBeenCalledOnce();
      expect(result.runId).toBe(cannedRunId);
      expect(result.worktreePath).toBe(sessionWorktree);
    });
  });

  it('allows a real workflow launch when the session\'s ONLY non-terminal run is a __quick__ sentinel', async () => {
    await withTempDir('runlauncher-session-', async (tmpDir) => {
      const db = makeSessionDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

      const sessionWorktree = join(tmpDir, 'session-tree');
      db.prepare(
        "INSERT INTO sessions (id, worktree_path, base_branch, run_id) VALUES ('sess-quick', ?, 'main', NULL)",
      ).run(sessionWorktree);

      // Seed the __quick__ SENTINEL: a workflows row named '__quick__' plus a
      // permanently-'running' workflow_runs row for this session. The Phase-1
      // guard MUST NOT count it, so launching a REAL workflow is still allowed.
      db.prepare(
        "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES ('wf-quick', 1, '__quick__', '/fake/quick.md', 'default')",
      ).run();
      db.prepare(
        "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id) VALUES ('run-quick', 'wf-quick', 1, 'running', 'default', 'sess-quick')",
      ).run();

      const cannedRunId = randomUUID().replace(/-/g, '');
      const { registry, workflowId, createRunSpy } = makeSessionRegistry(db, 'planner', cannedRunId);

      const createDeterministicWorktree = vi.fn();
      const fakeWorktree = {
        createDeterministicWorktree,
        getProjectMainBranch: vi.fn().mockResolvedValue('feature/session-branch'),
        getHeadCommit: vi.fn().mockResolvedValue('cafef00dbeef'),
      } as unknown as WorktreeManager;

      const launcher = new RunLauncher(
        adapter, registry, fakeWorktree, logger,
        fakeMcpConfigWriter, fakeOrchSocketProvider, fakeBridgeScriptResolver, fakeNodeResolver,
      );

      const result = await launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, 'sess-quick');

      // The sentinel did NOT block the launch: createRun ran and the run reuses
      // the session worktree (no dedicated worktree created).
      expect(createRunSpy).toHaveBeenCalledOnce();
      expect(createDeterministicWorktree).not.toHaveBeenCalled();
      expect(result.runId).toBe(cannedRunId);
      expect(result.worktreePath).toBe(sessionWorktree);
    });
  });

  it('still BLOCKS a 2nd real launch when the session has a REAL non-terminal run (sentinel exclusion does not weaken the guard)', async () => {
    await withTempDir('runlauncher-session-', async (tmpDir) => {
      const db = makeSessionDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

      const sessionWorktree = join(tmpDir, 'session-tree');
      db.prepare(
        "INSERT INTO sessions (id, worktree_path, base_branch, run_id) VALUES ('sess-realbusy', ?, 'main', NULL)",
      ).run(sessionWorktree);

      // A REAL (non-sentinel) in-flight run already owns this session.
      db.prepare(
        "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES ('wf-real', 1, 'sprint', '/fake/path.md', 'default')",
      ).run();
      db.prepare(
        "INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id) VALUES ('run-real', 'wf-real', 1, 'running', 'default', 'sess-realbusy')",
      ).run();

      const cannedRunId = randomUUID().replace(/-/g, '');
      const { registry, workflowId, createRunSpy } = makeSessionRegistry(db, 'planner', cannedRunId);

      const fakeWorktree = {
        createDeterministicWorktree: vi.fn(),
        getProjectMainBranch: vi.fn(),
        getHeadCommit: vi.fn(),
      } as unknown as WorktreeManager;

      const launcher = new RunLauncher(
        adapter, registry, fakeWorktree, logger,
        fakeMcpConfigWriter, fakeOrchSocketProvider, fakeBridgeScriptResolver, fakeNodeResolver,
      );

      await expect(
        launcher.launch(workflowId, tmpDir, undefined, undefined, undefined, 'sess-realbusy'),
      ).rejects.toThrow(/already has a running workflow/);

      // The guard fires BEFORE createRun, so no half-created run is left behind.
      expect(createRunSpy).not.toHaveBeenCalled();
      const count = db
        .prepare("SELECT COUNT(*) AS n FROM workflow_runs WHERE session_id = 'sess-realbusy'")
        .get() as { n: number };
      expect(count.n).toBe(1); // only the pre-existing real run
    });
  });
});
