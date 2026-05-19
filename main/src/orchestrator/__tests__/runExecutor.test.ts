/**
 * Unit + integration tests for RunExecutor and RunLauncher's optional enqueue
 * branch (TASK-640 acceptance criteria).
 *
 * Behaviors covered:
 *   a. RunExecutor.execute throws when workflow_runs row is missing
 *   b. RunExecutor.execute throws when workflow row is missing
 *   c. RunExecutor.execute throws when worktree_path is null
 *   d. Default RunExecutor.getPrompt throws NOT_IMPLEMENTED (sentinel contract)
 *   e. RunExecutor.execute synthesises panelId/sessionId and calls spawnCliProcess
 *   f. RunLauncher.launch enqueues execute() via RunQueueRegistry AFTER publish
 *   g. RunLauncher.launch does NOT call execute() synchronously; queue.add does
 *   h. RunLauncher.launch with executor/registry omitted still returns correct shape
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { join } from 'path';
import Database from 'better-sqlite3';
import { RunExecutor } from '../runExecutor';
import type { ClaudeSpawnerLike, WorkflowRegistryLike, ClaudeSpawnerOptions } from '../runExecutor';
import { RunQueueRegistry } from '../RunQueueRegistry';
import { RunLauncher } from '../runLauncher';
import type {
  OrchSocketProvider,
  BridgeScriptResolver,
  NodeResolver,
  StreamEventPublisher,
} from '../runLauncher';
import type { WorkflowRow, WorkflowRunRow } from '../../../../shared/types/workflows';
import type { WorkflowRegistry } from '../workflowRegistry';
import type { WorktreeManager } from '../../services/worktreeManager';
import type { LoggerLike } from '../types';
import type { McpConfigWriter } from '../mcpConfigWriter';
import { REGISTRY_SCHEMA } from '../../database/__test_fixtures__/registrySchema';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { withTempDir } from '../../__test_fixtures__/tmp';

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

function makeLogger(): LoggerLike {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeSpawner(): ClaudeSpawnerLike {
  return {
    spawnCliProcess: vi.fn<(options: ClaudeSpawnerOptions) => Promise<void>>().mockResolvedValue(undefined),
  };
}

function makeWorkflowRow(overrides?: Partial<WorkflowRow>): WorkflowRow {
  return {
    id: randomUUID(),
    project_id: 1,
    name: 'sprint',
    workflow_path: '/fake/sprint.md',
    permission_mode: 'default',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeWorkflowRunRow(overrides?: Partial<WorkflowRunRow>): WorkflowRunRow {
  const runId = randomUUID();
  return {
    id: runId,
    workflow_id: randomUUID(),
    project_id: 1,
    status: 'starting',
    permission_mode_snapshot: 'default',
    worktree_path: '/fake/worktree',
    branch_name: `cyboflow/sprint/${runId.slice(0, 8)}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * A subclass of RunExecutor that overrides getPrompt() to return a canned
 * prompt, so execute() can complete without hitting NOT_IMPLEMENTED.
 */
class TestableRunExecutor extends RunExecutor {
  protected override async getPrompt(_workflow: WorkflowRow): Promise<string> {
    return 'test prompt';
  }
}

// Shared stubs for RunLauncher (MCP collaborators).
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

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// RunExecutor unit tests
// ---------------------------------------------------------------------------

describe('RunExecutor.execute — missing rows', () => {
  it('(a) throws when workflow_runs row is missing', async () => {
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(null),
      getById: vi.fn().mockReturnValue(null),
    };
    const executor = new TestableRunExecutor(makeSpawner(), registry, makeLogger());

    await expect(executor.execute('missing-run-id')).rejects.toThrow(
      'workflow_runs row not found for runId=missing-run-id',
    );
  });

  it('(b) throws when workflow row is missing', async () => {
    const run = makeWorkflowRunRow();
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(null),
    };
    const executor = new TestableRunExecutor(makeSpawner(), registry, makeLogger());

    await expect(executor.execute(run.id)).rejects.toThrow('workflow row not found for workflowId=');
  });

  it('(c) throws when worktree_path is null', async () => {
    const run = makeWorkflowRunRow({ worktree_path: null });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const executor = new TestableRunExecutor(makeSpawner(), registry, makeLogger());

    await expect(executor.execute(run.id)).rejects.toThrow('worktree_path is null');
  });
});

describe('RunExecutor.execute — default getPrompt sentinel', () => {
  it('(d) default getPrompt throws NOT_IMPLEMENTED', async () => {
    const run = makeWorkflowRunRow();
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    // Use base RunExecutor (no getPrompt override) to confirm sentinel
    const executor = new RunExecutor(makeSpawner(), registry, makeLogger());

    await expect(executor.execute(run.id)).rejects.toThrow('NOT_IMPLEMENTED: getPrompt');
  });
});

describe('RunExecutor.execute — happy path (panelId/sessionId synthesis)', () => {
  it('(e) synthesises panelId/sessionId from runId and calls spawnCliProcess', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const executor = new TestableRunExecutor(spawner, registry, makeLogger());

    await executor.execute(run.id);

    expect(spawner.spawnCliProcess).toHaveBeenCalledOnce();
    const opts = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions;
    expect(opts.panelId).toBe(`run-${run.id}`);
    expect(opts.sessionId).toBe(`run-${run.id}`);
    expect(opts.worktreePath).toBe('/my/worktree');
    expect(opts.prompt).toBe('test prompt');
  });

  /**
   * Regression test: bridgeEvents must be called BEFORE spawnCliProcess so that
   * no SDK-initialization events are lost when the iterator starts.
   * The code-reviewer fix-up reordered bridgeEvents ahead of spawnCliProcess;
   * this test locks in that ordering to prevent future regressions.
   */
  it('(e2) bridgeEvents is called BEFORE spawnCliProcess (event-bridge ordering regression)', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();

    // Track the relative call order of bridgeEvents and spawnCliProcess.
    const callOrder: string[] = [];

    class OrderTrackingExecutor extends RunExecutor {
      protected override async getPrompt(_workflow: WorkflowRow): Promise<string> {
        return 'order-tracking prompt';
      }

      protected override async bridgeEvents(_runId: string, _panelId: string): Promise<void> {
        callOrder.push('bridgeEvents');
      }
    }

    // Capture spawnCliProcess call in the order array via a wrapper spy.
    const originalSpawn = spawner.spawnCliProcess.bind(spawner);
    (spawner as { spawnCliProcess: (opts: ClaudeSpawnerOptions) => Promise<void> }).spawnCliProcess = vi.fn(
      async (opts: ClaudeSpawnerOptions) => {
        callOrder.push('spawnCliProcess');
        return originalSpawn(opts);
      },
    );

    const executor = new OrderTrackingExecutor(spawner, registry, makeLogger());
    await executor.execute(run.id);

    expect(callOrder).toContain('bridgeEvents');
    expect(callOrder).toContain('spawnCliProcess');
    // bridgeEvents must appear before spawnCliProcess
    expect(callOrder.indexOf('bridgeEvents')).toBeLessThan(callOrder.indexOf('spawnCliProcess'));
  });
});

// ---------------------------------------------------------------------------
// RunLauncher integration tests
// ---------------------------------------------------------------------------

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(REGISTRY_SCHEMA);
  return db;
}

describe('RunLauncher.launch — RunExecutor enqueue integration', () => {
  it('(f) enqueues execute() via RunQueueRegistry AFTER publisher.publish run_started', async () => {
    await withTempDir('runexecutor-test-', async (tmpDir) => {
      const db = createTestDb();
      const adapter = dbAdapter(db);
      const logger = makeLogger();

      // Seed workflow
      const workflowId = randomUUID();
      db.prepare(
        "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES (?, 1, 'sprint', '/fake/path.md', 'default')",
      ).run(workflowId);

      const cannedRunId = randomUUID().replace(/-/g, '');
      const cannedWorktreePath = join(tmpDir, '.cyboflow', 'worktrees', 'sprint', cannedRunId.slice(0, 8));
      const cannedBranchName = `cyboflow/sprint/${cannedRunId.slice(0, 8)}`;

      const fakeRegistry = {
        getById: (id: string) => {
          const row = db
            .prepare(
              'SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?',
            )
            .get(id);
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

      // Track call ordering
      const callOrder: string[] = [];

      const publishSpy = vi.fn(() => {
        callOrder.push('publish');
      });
      const spyPublisher: StreamEventPublisher = { publish: publishSpy };

      // Build a WorkflowRegistryLike for RunExecutor that returns the right rows
      // (worktree_path is set by RunLauncher's UPDATE, but here we stub directly)
      const runRow = makeWorkflowRunRow({
        id: cannedRunId,
        workflow_id: workflowId,
        worktree_path: cannedWorktreePath,
        branch_name: cannedBranchName,
      });
      const workflowRow = makeWorkflowRow({ id: workflowId });

      const executorRegistry: WorkflowRegistryLike = {
        getRunById: vi.fn().mockReturnValue(runRow),
        getById: vi.fn().mockReturnValue(workflowRow),
      };

      const spawner: ClaudeSpawnerLike = {
        spawnCliProcess: vi.fn<(options: ClaudeSpawnerOptions) => Promise<void>>().mockImplementation(async () => {
          callOrder.push('spawnCliProcess');
        }),
      };

      const runQueueRegistry = new RunQueueRegistry();

      // Spy on RunQueueRegistry.getOrCreate to verify it is called
      const getOrCreateSpy = vi.spyOn(runQueueRegistry, 'getOrCreate');

      // TestableRunExecutor so getPrompt() returns a real string
      const executor = new TestableRunExecutor(spawner, executorRegistry, logger);

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
        executor,
        runQueueRegistry,
      );

      const result = await launcher.launch(workflowId, tmpDir);

      // launch() must have returned before execute() ran (fire-and-forget)
      expect(result.runId).toBe(cannedRunId);

      // getOrCreate must have been called with the runId
      expect(getOrCreateSpy).toHaveBeenCalledWith(cannedRunId);

      // Drain the queue so the enqueued task actually runs
      await runQueueRegistry.getOrCreate(cannedRunId).onIdle();

      // publish must have been called before spawnCliProcess
      const publishIdx = callOrder.indexOf('publish');
      const spawnIdx = callOrder.indexOf('spawnCliProcess');
      expect(publishIdx).toBeGreaterThanOrEqual(0);
      expect(spawnIdx).toBeGreaterThan(publishIdx);
    });
  });

  it('(g) execute() is NOT called synchronously — only after queue.add fires it', async () => {
    await withTempDir('runexecutor-test-', async (tmpDir) => {
      const db = createTestDb();
      const adapter = dbAdapter(db);
      const logger = makeLogger();

      const workflowId = randomUUID();
      db.prepare(
        "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES (?, 1, 'sprint', '/fake/path.md', 'default')",
      ).run(workflowId);

      const cannedRunId = randomUUID().replace(/-/g, '');
      const cannedWorktreePath = join(tmpDir, '.cyboflow', 'worktrees', 'sprint', cannedRunId.slice(0, 8));
      const cannedBranchName = `cyboflow/sprint/${cannedRunId.slice(0, 8)}`;

      const fakeRegistry = {
        getById: (id: string) => {
          const row = db
            .prepare(
              'SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?',
            )
            .get(id);
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

      let executeCalled = false;

      const runRow = makeWorkflowRunRow({
        id: cannedRunId,
        workflow_id: workflowId,
        worktree_path: cannedWorktreePath,
        branch_name: cannedBranchName,
      });
      const workflowRow = makeWorkflowRow({ id: workflowId });

      const executorRegistry: WorkflowRegistryLike = {
        getRunById: vi.fn().mockReturnValue(runRow),
        getById: vi.fn().mockReturnValue(workflowRow),
      };

      const spawner: ClaudeSpawnerLike = {
        spawnCliProcess: vi.fn<(options: ClaudeSpawnerOptions) => Promise<void>>().mockImplementation(async () => {
          executeCalled = true;
        }),
      };

      const runQueueRegistry = new RunQueueRegistry();
      const executor = new TestableRunExecutor(spawner, executorRegistry, logger);

      const launcher = new RunLauncher(
        adapter,
        fakeRegistry,
        fakeWorktree,
        logger,
        fakeMcpConfigWriter,
        fakeOrchSocketProvider,
        fakeBridgeScriptResolver,
        fakeNodeResolver,
        undefined,
        executor,
        runQueueRegistry,
      );

      // Before the queue drains, execute() must not have been called yet
      await launcher.launch(workflowId, tmpDir);
      // execute() could have been called synchronously — it should NOT be
      // (the queue schedules it asynchronously on the microtask queue)
      // We check that it hasn't run at this synchronous point:
      // (queue.add schedules via Promise, so executeCalled is still false here)
      expect(executeCalled).toBe(false);

      // After draining, it must have been called
      await runQueueRegistry.getOrCreate(cannedRunId).onIdle();
      expect(executeCalled).toBe(true);
    });
  });

  it('(h) launch() returns correct shape when executor/registry omitted (backward-compat)', async () => {
    await withTempDir('runexecutor-test-', async (tmpDir) => {
      const db = createTestDb();
      const adapter = dbAdapter(db);
      const logger = makeLogger();

      const workflowId = randomUUID();
      db.prepare(
        "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES (?, 1, 'sprint', '/fake/path.md', 'default')",
      ).run(workflowId);

      const cannedRunId = randomUUID().replace(/-/g, '');
      const cannedWorktreePath = join(tmpDir, '.cyboflow', 'worktrees', 'sprint', cannedRunId.slice(0, 8));
      const cannedBranchName = `cyboflow/sprint/${cannedRunId.slice(0, 8)}`;

      const fakeRegistry = {
        getById: (id: string) => {
          const row = db
            .prepare(
              'SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?',
            )
            .get(id);
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

      // No executor or runQueueRegistry — backward-compat mode
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

      expect(result.runId).toBe(cannedRunId);
      expect(result.worktreePath).toBe(cannedWorktreePath);
      expect(result.branchName).toBe(cannedBranchName);
      expect(result.permissionMode).toBe('default');
    });
  });

  it('executor error is caught and logged, launch return value is unaffected', async () => {
    await withTempDir('runexecutor-test-', async (tmpDir) => {
      const db = createTestDb();
      const adapter = dbAdapter(db);
      const logger = makeLogger();

      const workflowId = randomUUID();
      db.prepare(
        "INSERT INTO workflows (id, project_id, name, workflow_path, permission_mode) VALUES (?, 1, 'sprint', '/fake/path.md', 'default')",
      ).run(workflowId);

      const cannedRunId = randomUUID().replace(/-/g, '');
      const cannedWorktreePath = join(tmpDir, '.cyboflow', 'worktrees', 'sprint', cannedRunId.slice(0, 8));
      const cannedBranchName = `cyboflow/sprint/${cannedRunId.slice(0, 8)}`;

      const fakeRegistry = {
        getById: (id: string) => {
          const row = db
            .prepare(
              'SELECT id, project_id, name, workflow_path, permission_mode, created_at FROM workflows WHERE id = ?',
            )
            .get(id);
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

      // Executor that always throws (e.g. NOT_IMPLEMENTED from base class)
      const runRow = makeWorkflowRunRow({
        id: cannedRunId,
        workflow_id: workflowId,
        worktree_path: cannedWorktreePath,
      });
      const workflowRow = makeWorkflowRow({ id: workflowId });

      const executorRegistry: WorkflowRegistryLike = {
        getRunById: vi.fn().mockReturnValue(runRow),
        getById: vi.fn().mockReturnValue(workflowRow),
      };

      // Use the base RunExecutor so getPrompt() throws NOT_IMPLEMENTED
      const spawner = makeSpawner();
      const failingExecutor = new RunExecutor(spawner, executorRegistry, logger);

      const runQueueRegistry = new RunQueueRegistry();

      const launcher = new RunLauncher(
        adapter,
        fakeRegistry,
        fakeWorktree,
        logger,
        fakeMcpConfigWriter,
        fakeOrchSocketProvider,
        fakeBridgeScriptResolver,
        fakeNodeResolver,
        undefined,
        failingExecutor,
        runQueueRegistry,
      );

      // launch() must succeed despite executor error
      const result = await launcher.launch(workflowId, tmpDir);
      expect(result.runId).toBe(cannedRunId);

      // Drain the queue — error is swallowed
      await runQueueRegistry.getOrCreate(cannedRunId).onIdle();

      // logger.error must have been called with the executor failure
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('RunExecutor.execute failed'),
        expect.objectContaining({ runId: cannedRunId }),
      );
    });
  });
});
