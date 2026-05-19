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
import type { ClaudeSpawnerLike, WorkflowRegistryLike, ClaudeSpawnerOptions, WorkflowPromptReaderLike } from '../runExecutor';
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
    abort: vi.fn<(panelId: string) => Promise<void>>().mockResolvedValue(undefined),
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
  protected override async getPrompt(_runId: string, _workflow: WorkflowRow): Promise<string> {
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
  it('(d) default getPrompt throws NOT_IMPLEMENTED when no promptReader injected', async () => {
    const run = makeWorkflowRunRow();
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    // Use base RunExecutor with no promptReader — confirms sentinel still fires
    const executor = new RunExecutor(makeSpawner(), registry, makeLogger());

    await expect(executor.execute(run.id)).rejects.toThrow('RunExecutor.getPrompt: no WorkflowPromptReaderLike injected');
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
      protected override async getPrompt(_runId: string, _workflow: WorkflowRow): Promise<string> {
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
// TASK-650: New tests for cancel surface, bridge handle, ExecutionPhase,
// and preToolUseHook threading.
// ---------------------------------------------------------------------------

import type { RunEventBridge } from '../runEventBridge';

describe('RunExecutor.execute — bridgeEvents handle is stored and teardown fires dispose', () => {
  it('(i) execute() stores a real RunEventBridge handle and disposes it on completion (teardownRun via finally)', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();

    const disposeSpy = vi.fn();
    const fakeBridge: RunEventBridge = { dispose: disposeSpy };

    class BridgeReturningExecutor extends RunExecutor {
      protected override async getPrompt(_runId: string, _workflow: WorkflowRow): Promise<string> {
        return 'test prompt';
      }

      protected override async bridgeEvents(_runId: string, _panelId: string): Promise<RunEventBridge | void> {
        return fakeBridge;
      }
    }

    const executor = new BridgeReturningExecutor(spawner, registry, makeLogger());

    await executor.execute(run.id);

    // After execute() completes, teardownRun should have called dispose() once.
    expect(disposeSpy).toHaveBeenCalledOnce();
  });
});

describe('RunExecutor.cancel — aborts spawner and disposes bridge', () => {
  it('(ii) cancel() calls spawner.abort with synthetic panelId AND fires bridge.dispose()', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();

    const disposeSpy = vi.fn();
    const fakeBridge: RunEventBridge = { dispose: disposeSpy };

    // Latch to control when spawnCliProcess resolves — so cancel() runs while execute() is in-flight.
    let resolveSpawn!: () => void;
    const spawnBlocked = new Promise<void>((resolve) => {
      resolveSpawn = resolve;
    });

    (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await spawnBlocked;
    });

    class BridgeReturningExecutor extends RunExecutor {
      protected override async getPrompt(_runId: string, _workflow: WorkflowRow): Promise<string> {
        return 'test prompt';
      }

      protected override async bridgeEvents(_runId: string, _panelId: string): Promise<RunEventBridge | void> {
        return fakeBridge;
      }
    }

    const executor = new BridgeReturningExecutor(spawner, registry, makeLogger());

    // Start execute() in background — it blocks on spawnCliProcess.
    const executePromise = executor.execute(run.id);

    // Give microtasks a chance to register the panelId in activePanelIds
    // (bridgeEvents and panelId storage run before spawnCliProcess).
    await new Promise((r) => setTimeout(r, 0));

    // Cancel while execute() is still blocked.
    await executor.cancel();

    // Verify abort was called with the synthetic panelId.
    expect(spawner.abort).toHaveBeenCalledOnce();
    expect(spawner.abort).toHaveBeenCalledWith(`run-${run.id}`);

    // Verify bridge.dispose() was called by cancel() via teardownRun.
    expect(disposeSpy).toHaveBeenCalledOnce();

    // Unblock execute() so it can finish (it may throw because abort was called).
    resolveSpawn();
    // We don't care about execute()'s final state — cancel already cleaned up.
    await executePromise.catch(() => {});
  });

  it('(ii-b) double-cancel is idempotent — abort called once, dispose called once', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();

    const disposeSpy = vi.fn();
    const fakeBridge: RunEventBridge = { dispose: disposeSpy };

    let resolveSpawn!: () => void;
    const spawnBlocked = new Promise<void>((resolve) => {
      resolveSpawn = resolve;
    });

    (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await spawnBlocked;
    });

    class BridgeReturningExecutor extends RunExecutor {
      protected override async getPrompt(_runId: string, _workflow: WorkflowRow): Promise<string> {
        return 'test prompt';
      }

      protected override async bridgeEvents(_runId: string, _panelId: string): Promise<RunEventBridge | void> {
        return fakeBridge;
      }
    }

    const executor = new BridgeReturningExecutor(spawner, registry, makeLogger());
    const executePromise = executor.execute(run.id);

    await new Promise((r) => setTimeout(r, 0));

    // Cancel twice.
    await executor.cancel();
    await executor.cancel(); // second cancel — no-op

    expect(spawner.abort).toHaveBeenCalledOnce();
    expect(disposeSpy).toHaveBeenCalledOnce();

    resolveSpawn();
    await executePromise.catch(() => {});
  });
});

describe('RunExecutor.execute — terminal phase triggers teardownRun via finally', () => {
  it('(iii) bridge.dispose() fires when execute() completes normally (finally arm)', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();

    const disposeSpy = vi.fn();
    const fakeBridge: RunEventBridge = { dispose: disposeSpy };

    class BridgeReturningExecutor extends RunExecutor {
      protected override async getPrompt(_runId: string, _workflow: WorkflowRow): Promise<string> {
        return 'test prompt';
      }

      protected override async bridgeEvents(_runId: string, _panelId: string): Promise<RunEventBridge | void> {
        return fakeBridge;
      }
    }

    const executor = new BridgeReturningExecutor(spawner, registry, makeLogger());
    await executor.execute(run.id);

    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it('(iii-b) bridge.dispose() fires even when spawnCliProcess throws (finally arm on error path)', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('spawn failed'));

    const disposeSpy = vi.fn();
    const fakeBridge: RunEventBridge = { dispose: disposeSpy };

    class BridgeReturningExecutor extends RunExecutor {
      protected override async getPrompt(_runId: string, _workflow: WorkflowRow): Promise<string> {
        return 'test prompt';
      }

      protected override async bridgeEvents(_runId: string, _panelId: string): Promise<RunEventBridge | void> {
        return fakeBridge;
      }
    }

    const executor = new BridgeReturningExecutor(spawner, registry, makeLogger());
    await expect(executor.execute(run.id)).rejects.toThrow('spawn failed');

    // Despite the error, dispose() must have been called.
    expect(disposeSpy).toHaveBeenCalledOnce();
  });
});

describe('RunExecutor.buildOptionsOverrides — preToolUseHook threading', () => {
  it('(iv) returns { preToolUseHook } when workflow.permission_mode is "default"', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, permission_mode: 'default' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };

    let capturedOverrides: Partial<ClaudeSpawnerOptions> | null = null;
    const spawner = makeSpawner();
    (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mockImplementation(
      async (opts: ClaudeSpawnerOptions) => {
        capturedOverrides = opts;
      },
    );

    const executor = new TestableRunExecutor(spawner, registry, makeLogger());
    await executor.execute(run.id);

    // The spawner should have been called with a preToolUseHook function.
    expect(capturedOverrides).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(typeof capturedOverrides!.preToolUseHook).toBe('function');
  });

  it('(iv-b) returns {} (no preToolUseHook) when permission_mode is "dontAsk"', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, permission_mode: 'dontAsk' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };

    let capturedOverrides: Partial<ClaudeSpawnerOptions> | null = null;
    const spawner = makeSpawner();
    (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mockImplementation(
      async (opts: ClaudeSpawnerOptions) => {
        capturedOverrides = opts;
      },
    );

    const executor = new TestableRunExecutor(spawner, registry, makeLogger());
    await executor.execute(run.id);

    // For 'dontAsk', buildPreToolUseHook returns undefined so no hook is set.
    expect(capturedOverrides).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(capturedOverrides!.preToolUseHook).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TASK-661: New tests for WorkflowPromptReaderLike wiring and systemPromptAppend
// ---------------------------------------------------------------------------

/** Stub reader backed by an in-memory map for unit tests. */
function makeStubReader(entries: Record<string, { prompt: string; systemPromptAppend: string }>): WorkflowPromptReaderLike {
  return {
    read: (workflowPath: string) => {
      const entry = entries[workflowPath];
      if (!entry) {
        const err = new Error(`WorkflowPromptReadError: no entry for ${workflowPath}`);
        err.name = 'WorkflowPromptReadError';
        throw err;
      }
      return entry;
    },
  };
}

describe('RunExecutor — getPrompt reads workflow file via injected reader', () => {
  it('getPrompt reads workflow file via injected reader', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/sprint.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const reader = makeStubReader({
      '/fake/sprint.md': { prompt: 'do the sprint', systemPromptAppend: '' },
    });
    const executor = new RunExecutor(spawner, registry, makeLogger(), reader);

    await executor.execute(run.id);

    expect(spawner.spawnCliProcess).toHaveBeenCalledOnce();
    const opts = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions;
    expect(opts.prompt).toBe('do the sprint');
  });

  it('getPrompt throws WorkflowPromptReadError when file is missing — error bubbles up from execute()', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/missing/file.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const reader = makeStubReader({}); // empty — will throw on any read
    const executor = new RunExecutor(makeSpawner(), registry, makeLogger(), reader);

    await expect(executor.execute(run.id)).rejects.toThrow('WorkflowPromptReadError');
  });

  it('buildOptionsOverrides includes systemPromptAppend from frontmatter', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/sprint.md', permission_mode: 'dontAsk' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const reader = makeStubReader({
      '/fake/sprint.md': { prompt: 'do the sprint', systemPromptAppend: 'always use TypeScript' },
    });
    const executor = new RunExecutor(spawner, registry, makeLogger(), reader);

    await executor.execute(run.id);

    expect(spawner.spawnCliProcess).toHaveBeenCalledOnce();
    const opts = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions;
    expect(opts.systemPromptAppend).toBe('always use TypeScript');
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
        abort: vi.fn<(panelId: string) => Promise<void>>().mockResolvedValue(undefined),
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
        abort: vi.fn<(panelId: string) => Promise<void>>().mockResolvedValue(undefined),
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
