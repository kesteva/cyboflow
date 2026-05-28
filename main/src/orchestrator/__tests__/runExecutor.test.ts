/**
 * Unit + integration tests for RunExecutor and RunLauncher's optional enqueue
 * branch (TASK-640 acceptance criteria).
 *
 * Behaviors covered:
 *   a. RunExecutor.execute throws when workflow_runs row is missing
 *   b. RunExecutor.execute throws when workflow row is missing
 *   c. RunExecutor.execute throws when worktree_path is null
 *   d. Default RunExecutor.getPrompt throws NOT_IMPLEMENTED (sentinel contract)
 *   e. RunExecutor.execute assigns panelId/sessionId from runId (invariant: panelId === runId === sessionId) and calls spawnCliProcess
 *   f. RunLauncher.launch enqueues execute() via RunQueueRegistry AFTER publish
 *   g. RunLauncher.launch does NOT call execute() synchronously; queue.add does
 *   h. RunLauncher.launch with executor/registry omitted still returns correct shape
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { join } from 'path';
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
import type { McpConfigWriter } from '../mcpConfigWriter';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';
import { withTempDir } from '../../__test_fixtures__/tmp';
import { createTestDb } from '../__test_fixtures__/orchestratorTestDb';

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

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
  /**
   * Quick-session boundary regression test (IDEA-024 / TASK-743 / TASK-745).
   *
   * When a quick-session id (no matching workflow_runs row) is passed to
   * execute(), the executor MUST throw a clear 'workflow_runs row not found'
   * error.  This is the intended loud-failure mode — it surfaces a broken
   * call site rather than silently no-oping.
   */
  it('(a0) throws "workflow_runs row not found" when given a quick-session id (no workflow_runs row)', async () => {
    const quickSessionId = 'quick-session-0000';
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(null), // no workflow_runs row
      getById: vi.fn().mockReturnValue(null),
    };
    const executor = new TestableRunExecutor(makeSpawner(), registry, makeSpyLogger());

    await expect(executor.execute(quickSessionId)).rejects.toThrow(
      `workflow_runs row not found for runId=${quickSessionId}`,
    );
  });

  it('(a) throws when workflow_runs row is missing', async () => {
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(null),
      getById: vi.fn().mockReturnValue(null),
    };
    const executor = new TestableRunExecutor(makeSpawner(), registry, makeSpyLogger());

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
    const executor = new TestableRunExecutor(makeSpawner(), registry, makeSpyLogger());

    await expect(executor.execute(run.id)).rejects.toThrow('workflow row not found for workflowId=');
  });

  it('(c) throws when worktree_path is null', async () => {
    const run = makeWorkflowRunRow({ worktree_path: null });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const executor = new TestableRunExecutor(makeSpawner(), registry, makeSpyLogger());

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
    const executor = new RunExecutor(makeSpawner(), registry, makeSpyLogger());

    await expect(executor.execute(run.id)).rejects.toThrow('RunExecutor.getPrompt: no WorkflowPromptReaderLike injected');
  });
});

describe('RunExecutor.execute — happy path (panelId/sessionId alignment)', () => {
  it('(e) assigns panelId/sessionId from runId (invariant: panelId === runId === sessionId) and calls spawnCliProcess', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const executor = new TestableRunExecutor(spawner, registry, makeSpyLogger());

    await executor.execute(run.id);

    expect(spawner.spawnCliProcess).toHaveBeenCalledOnce();
    const opts = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions;
    expect(opts.panelId).toBe(run.id);
    expect(opts.sessionId).toBe(run.id);
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

    const executor = new OrderTrackingExecutor(spawner, registry, makeSpyLogger());
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
import type { StepTransitionEmitterLike } from '../runExecutor';

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

    const executor = new BridgeReturningExecutor(spawner, registry, makeSpyLogger());

    await executor.execute(run.id);

    // After execute() completes, teardownRun should have called dispose() once.
    expect(disposeSpy).toHaveBeenCalledOnce();
  });
});

describe('RunExecutor.cancel — aborts spawner and disposes bridge', () => {
  it('(ii) cancel() calls spawner.abort with the runId (invariant: panelId === runId) AND fires bridge.dispose()', async () => {
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

    const executor = new BridgeReturningExecutor(spawner, registry, makeSpyLogger());

    // Start execute() in background — it blocks on spawnCliProcess.
    const executePromise = executor.execute(run.id);

    // Give microtasks a chance to register the panelId in activePanelIds
    // (bridgeEvents and panelId storage run before spawnCliProcess).
    await new Promise((r) => setTimeout(r, 0));

    // Cancel while execute() is still blocked.
    await executor.cancel();

    // Verify abort was called with the runId (invariant: panelId === runId).
    expect(spawner.abort).toHaveBeenCalledOnce();
    expect(spawner.abort).toHaveBeenCalledWith(run.id);

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

    const executor = new BridgeReturningExecutor(spawner, registry, makeSpyLogger());
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

    const executor = new BridgeReturningExecutor(spawner, registry, makeSpyLogger());
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

    const executor = new BridgeReturningExecutor(spawner, registry, makeSpyLogger());
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

    const executor = new TestableRunExecutor(spawner, registry, makeSpyLogger());
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

    const executor = new TestableRunExecutor(spawner, registry, makeSpyLogger());
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
    const executor = new RunExecutor(spawner, registry, makeSpyLogger(), reader);

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
    const executor = new RunExecutor(makeSpawner(), registry, makeSpyLogger(), reader);

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
    const executor = new RunExecutor(spawner, registry, makeSpyLogger(), reader);

    await executor.execute(run.id);

    expect(spawner.spawnCliProcess).toHaveBeenCalledOnce();
    const opts = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions;
    expect(opts.systemPromptAppend).toBe('always use TypeScript');
  });
});

// ---------------------------------------------------------------------------
// TASK-662: Lifecycle transition tests
// ---------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import type { LifecycleTransitionsLike } from '../runExecutor';

function makeLifecycleTransitions(): { mock: LifecycleTransitionsLike } & {
  running: ReturnType<typeof vi.fn>;
  completed: ReturnType<typeof vi.fn>;
  failed: ReturnType<typeof vi.fn>;
  canceled: ReturnType<typeof vi.fn>;
} {
  const running = vi.fn<(runId: string) => void>();
  const completed = vi.fn<(runId: string, fromStatus: 'running') => void>();
  const failed = vi.fn<(runId: string, fromStatus: 'starting' | 'running' | 'awaiting_review' | 'stuck', errorMessage: string) => void>();
  const canceled = vi.fn<(runId: string) => void>();
  const mock: LifecycleTransitionsLike = { running, completed, failed, canceled };
  return { mock, running, completed, failed, canceled };
}

describe('lifecycle transitions', () => {
  // -------------------------------------------------------------------------
  // (i) onLifecycleTransition routes each phase to the right transition helper
  // -------------------------------------------------------------------------
  it('onLifecycleTransition routes each phase to the right transition helper', async () => {
    const { mock: lt, running, completed, failed, canceled } = makeLifecycleTransitions();

    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    // Use base RunExecutor with lifecycleTransitions injected.
    // We access onLifecycleTransition via a subclass for testing.
    class LifecycleTestExecutor extends RunExecutor {
      protected override async getPrompt(_runId: string, _workflow: WorkflowRow): Promise<string> {
        return 'test prompt';
      }

      // Expose the protected method for testing.
      public async testLifecycleTransition(runId: string, phase: import('../runExecutor').ExecutionPhase): Promise<void> {
        return this.onLifecycleTransition(runId, phase);
      }
    }

    const executor = new LifecycleTestExecutor(makeSpawner(), registry, makeSpyLogger(), undefined, lt);

    await executor.testLifecycleTransition(run.id, 'sdk_initialized');
    expect(running).toHaveBeenCalledOnce();
    expect(running).toHaveBeenCalledWith(run.id);

    await executor.testLifecycleTransition(run.id, 'completed');
    expect(completed).toHaveBeenCalledOnce();
    expect(completed).toHaveBeenCalledWith(run.id, 'running');

    await executor.testLifecycleTransition(run.id, 'canceled');
    expect(canceled).toHaveBeenCalledOnce();
    expect(canceled).toHaveBeenCalledWith(run.id);

    // pre_spawn also calls running() (it advances starting → running before
    // the SDK spawns so ApprovalRouter sees the run as 'running' when PreToolUse
    // fires).  post_spawn is a true no-op.
    await executor.testLifecycleTransition(run.id, 'pre_spawn');
    await executor.testLifecycleTransition(run.id, 'post_spawn');
    expect(running).toHaveBeenCalledTimes(2); // once for sdk_initialized, once for pre_spawn
    expect(completed).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // (ii) execute() fires completed phase on normal terminate
  // -------------------------------------------------------------------------
  it('execute() fires completed phase on normal terminate', async () => {
    const { mock: lt, completed } = makeLifecycleTransitions();

    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner(); // resolves successfully

    const executor = new TestableRunExecutor(spawner, registry, makeSpyLogger(), undefined, lt);
    await executor.execute(run.id);

    expect(completed).toHaveBeenCalledOnce();
    expect(completed).toHaveBeenCalledWith(run.id, 'running');
  });

  // -------------------------------------------------------------------------
  // (iii) execute() fires failed phase with error message on spawner reject
  // -------------------------------------------------------------------------
  it('execute() fires failed phase with error message on spawner reject', async () => {
    const { mock: lt, failed } = makeLifecycleTransitions();

    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('SDK spawn failed with exit code 1'),
    );

    const executor = new TestableRunExecutor(spawner, registry, makeSpyLogger(), undefined, lt);
    await expect(executor.execute(run.id)).rejects.toThrow('SDK spawn failed with exit code 1');

    expect(failed).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledWith(run.id, 'running', 'SDK spawn failed with exit code 1');
  });
});

// ---------------------------------------------------------------------------
// GAP-A: a run must NOT be marked 'completed' while it has a pending approval
// or question (or is parked awaiting human work) when the SDK iterator drains.
// ---------------------------------------------------------------------------

import type { PendingWorkProbeLike } from '../runExecutor';

function makePendingProbe(
  overrides?: Partial<PendingWorkProbeLike>,
): PendingWorkProbeLike {
  return {
    hasPendingApproval: vi.fn().mockReturnValue(false),
    hasPendingQuestion: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

describe('RunExecutor.execute — GAP-A completion guard', () => {
  // (i) drain with a pending approval does NOT complete.
  it('does NOT complete when the run has a pending approval at iterator drain', async () => {
    const { mock: lt, completed } = makeLifecycleTransitions();
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const probe = makePendingProbe({ hasPendingApproval: vi.fn().mockReturnValue(true) });

    const executor = new TestableRunExecutor(
      makeSpawner(),
      registry,
      makeSpyLogger(),
      undefined, // promptReader
      lt,
      undefined, // publisher
      undefined, // db
      undefined, // source
      undefined, // stepEmitter
      probe,
    );
    await executor.execute(run.id);

    expect(probe.hasPendingApproval).toHaveBeenCalledWith(run.id);
    expect(completed).not.toHaveBeenCalled();
  });

  // (i') drain with a pending question does NOT complete.
  it('does NOT complete when the run has a pending question at iterator drain', async () => {
    const { mock: lt, completed } = makeLifecycleTransitions();
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const probe = makePendingProbe({ hasPendingQuestion: vi.fn().mockReturnValue(true) });

    const executor = new TestableRunExecutor(
      makeSpawner(),
      registry,
      makeSpyLogger(),
      undefined,
      lt,
      undefined,
      undefined,
      undefined,
      undefined,
      probe,
    );
    await executor.execute(run.id);

    expect(completed).not.toHaveBeenCalled();
  });

  // (i'') drain while the run is parked awaiting_review (DB-status guard) does
  // NOT complete, even with no pending-work probe injected.
  it('does NOT complete when the live run status is awaiting_review at drain (no probe)', async () => {
    const { mock: lt, completed } = makeLifecycleTransitions();
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree', status: 'awaiting_review' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };

    const executor = new TestableRunExecutor(makeSpawner(), registry, makeSpyLogger(), undefined, lt);
    await executor.execute(run.id);

    expect(completed).not.toHaveBeenCalled();
  });

  // (ii) drain with NO pending work DOES complete (existing behavior preserved).
  it('DOES complete when the run has no pending work at iterator drain', async () => {
    const { mock: lt, completed } = makeLifecycleTransitions();
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree', status: 'running' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const probe = makePendingProbe(); // both false

    const executor = new TestableRunExecutor(
      makeSpawner(),
      registry,
      makeSpyLogger(),
      undefined,
      lt,
      undefined,
      undefined,
      undefined,
      undefined,
      probe,
    );
    await executor.execute(run.id);

    expect(completed).toHaveBeenCalledOnce();
    expect(completed).toHaveBeenCalledWith(run.id, 'running');
  });
});

// ---------------------------------------------------------------------------
// TASK-662 follow-up: source EventEmitter arg wires onFirstMessage → running()
// ---------------------------------------------------------------------------

import { EventRouter, RawEventsSink } from '../../services/streamParser';
import { makeRawEventsDb, countRawEvents } from '../__test_fixtures__/rawEvents';

/**
 * Emit a synthetic 'output' event matching the ClaudeCodeManager contract
 * (panelId must equal runId; type must be 'json').
 */
function emitOutputEvent(source: EventEmitter, runId: string, data: unknown): void {
  source.emit('output', {
    panelId: runId,
    sessionId: runId,
    type: 'json',
    data,
    timestamp: new Date(),
  });
}

describe('RunExecutor.bridgeEvents — source arg integration', () => {
  /**
   * End-to-end wire test: when a real `source` EventEmitter is injected along
   * with publisher/db/lifecycleTransitions, an 'output' event on the source
   * flows through bridgeEventsImpl → onFirstMessage →
   * onLifecycleTransition('sdk_initialized') → lifecycleTransitions.running().
   *
   * This pins the fix introduced in the follow-up commit (9539688) which replaced
   * `this.spawner as unknown as EventEmitter` with `this.source` — ensuring the
   * real EventEmitter is used rather than the spawner adapter.
   */
  it('source arg: lifecycleTransitions.running() fires when source emits output event', async () => {
    const { mock: lt, running, completed } = makeLifecycleTransitions();

    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();

    // Use a real in-memory DB so the CCM-style pipeline can INSERT raw_events rows.
    const db = makeRawEventsDb();

    // Simulate CCM's own EventRouter + RawEventsSink pipeline — this is the sole
    // persistence path when the bridge has skipPersistence: true (TASK-664).
    // In production, ClaudeCodeManager.runSdkQuery constructs and wires these;
    // here we wire them to the same source EventEmitter so that when the mock
    // spawnCliProcess emits an 'output' event, both the bridge and the CCM-style
    // sink see it simultaneously.
    const ccmRouter = new EventRouter();
    const ccmSink = new RawEventsSink(db);

    // The publisher collects envelopes — presence confirms the bridge fired.
    const publishedTypes: string[] = [];
    const publisher: StreamEventPublisher = {
      publish(_runId, envelope) {
        publishedTypes.push((envelope as { type: string }).type);
      },
    };

    // source is the EventEmitter that will carry 'output' events.
    const source = new EventEmitter();

    // Wire CCM-style sink BEFORE the bridge so ordering matches production.
    // The CCM-side narrowing is done inline here (simulating runSdkQuery:341).
    const { TypedEventNarrowing: TEN } = await import('../../services/streamParser');
    const ccmNarrowing = new TEN();
    ccmSink.attachToRouter(ccmRouter, run.id);
    source.on('output', (payload: unknown) => {
      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('panelId' in payload) ||
        !('type' in payload) ||
        !('data' in payload)
      ) return;
      const p = payload as { panelId: string; type: string; data: unknown };
      if (p.panelId !== run.id || p.type !== 'json') return;
      const typed = ccmNarrowing.narrow(p.data);
      ccmRouter.emitForRun(run.id, typed);
    });

    // Inject source as the 8th constructor arg.
    const executor = new TestableRunExecutor(
      spawner,
      registry,
      makeSpyLogger(),
      undefined,
      lt,
      publisher,
      db,
      source,
    );

    // spawnCliProcess emits one output event on the source to simulate the SDK
    // delivering its first message, then resolves normally.
    // The bridge filters on panelId === runId (invariant: panelId === runId === sessionId
    // throughout the orchestrator surface — see runExecutor.ts JSDoc).
    (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      emitOutputEvent(source, run.id, {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-test',
        cwd: '/tmp',
        model: 'claude-opus',
        tools: [],
        mcp_servers: [],
        permissionMode: 'default',
      });
    });

    await executor.execute(run.id);

    // The bridge must have forwarded the event to the publisher.
    expect(publishedTypes).toContain('system');

    // running() is called twice: once by pre_spawn (before spawnCliProcess) and
    // once by onFirstMessage → sdk_initialized (when the source emits the output event).
    // In production both paths call transitionToRunning() which is idempotent; in tests
    // the mock records both calls.
    expect(running).toHaveBeenCalledTimes(2);
    expect(running).toHaveBeenCalledWith(run.id);

    // execute() completed normally → completed() fires too.
    expect(completed).toHaveBeenCalledOnce();
    expect(completed).toHaveBeenCalledWith(run.id, 'running');

    // TASK-664 cross-task interlock: exactly 1 raw_events row must exist.
    // The CCM-style pipeline inserts 1 row; the bridge with skipPersistence: true
    // contributes 0 additional rows. If this assertion fails with cnt=2, the
    // skipPersistence flag is missing from RunExecutor.bridgeEvents(). If it
    // fails with cnt=0, the CCM-style pipeline listener is broken.
    //
    // Sibling: runEventBridge.test.ts "dual-pipeline single-INSERT guarantee"
    // tests this same invariant in isolation (bridgeEvents() only). Both must
    // be updated together if the storage contract changes.
    const cnt = countRawEvents(db, run.id);
    expect(cnt).toBe(1);
  });

  /**
   * Backward-compat: when source is absent, bridgeEvents() short-circuits and the
   * bridge's onFirstMessage path does NOT call running().  However, execute() still
   * calls onLifecycleTransition('pre_spawn') before spawnCliProcess, so running()
   * IS called exactly once via the pre_spawn arm.
   */
  it('source absent: bridgeEvents short-circuits; running() is not called', async () => {
    const { mock: lt, running } = makeLifecycleTransitions();

    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const db = makeRawEventsDb();
    const publisher: StreamEventPublisher = { publish: vi.fn() };

    // No source — 8th arg omitted.
    const executor = new TestableRunExecutor(
      makeSpawner(),
      registry,
      makeSpyLogger(),
      undefined,
      lt,
      publisher,
      db,
      // source intentionally absent
    );

    await executor.execute(run.id);

    // running() is called once by the pre_spawn arm of onLifecycleTransition
    // (execute() calls pre_spawn before spawnCliProcess regardless of whether a
    // source is present).  The bridge's onFirstMessage path is silent because
    // bridgeEvents() short-circuits when source is absent — so there is no 2nd call.
    expect(running).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// RunLauncher integration tests
// ---------------------------------------------------------------------------

describe('RunLauncher.launch — RunExecutor enqueue integration', () => {
  it('(f) enqueues execute() via RunQueueRegistry AFTER publisher.publish run_started', async () => {
    await withTempDir('runexecutor-test-', async (tmpDir) => {
      const db = createTestDb();
      const adapter = dbAdapter(db);
      const logger = makeSpyLogger();

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
      const logger = makeSpyLogger();

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
      const logger = makeSpyLogger();

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
      const logger = makeSpyLogger();

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

// ---------------------------------------------------------------------------
// TASK-663: panelId/runId alignment — integration with RunEventBridge
// ---------------------------------------------------------------------------

describe('panelId/runId alignment — integration with RunEventBridge', () => {
  /**
   * Negative: if panelId had the old "run-<runId>" prefix (pre-TASK-663), the bridge would
   * silently drop the event and running() would never be called.
   * This test locks in the failure mode so any future regression is immediately visible.
   */
  it('bridge drops output event when panelId has run- prefix (old broken behaviour)', async () => {
    const { mock: lt, running } = makeLifecycleTransitions();

    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };

    const db = makeRawEventsDb();

    const publisher: StreamEventPublisher = { publish: vi.fn() };
    const source = new EventEmitter();

    // Hoist spawner before construction so the mock is installed directly (matches
    // the dominant pattern in this file, e.g. lines 181, 462, 487 above).
    const spawner = makeSpawner();
    const executor = new TestableRunExecutor(
      spawner,
      registry,
      makeSpyLogger(),
      undefined,
      lt,
      publisher,
      db,
      source,
    );

    // Emit with the WRONG panelId (old "run-<runId>" prefix) — bridge must drop it.
    (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      source.emit('output', {
        panelId: `run-${run.id}`,
        sessionId: `run-${run.id}`,
        type: 'json',
        data: {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-prefix-test',
          cwd: '/tmp',
          model: 'claude-opus',
          tools: [],
          mcp_servers: [],
          permissionMode: 'default',
        },
        timestamp: new Date(),
      });
    });

    await executor.execute(run.id);

    // The bridge drops the mismatched event (wrong panelId prefix), so the
    // sdk_initialized path does NOT call running().  However, execute() calls
    // onLifecycleTransition('pre_spawn') before spawnCliProcess regardless, so
    // running() IS called exactly once via the pre_spawn arm.
    expect(running).toHaveBeenCalledOnce();

    // raw_events row must also not exist.
    const cnt = countRawEvents(db, run.id);
    expect(cnt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TASK-765: stepEmitter lifecycle hook tests
// ---------------------------------------------------------------------------

function makeStepEmitter(): StepTransitionEmitterLike & { calls: Array<{ runId: string; status: string }> } {
  const calls: Array<{ runId: string; status: string }> = [];
  const emit = vi.fn((runId: string, status: 'pending' | 'running' | 'done') => {
    calls.push({ runId, status });
  });
  return { emit, calls };
}

describe('RunExecutor.execute — stepEmitter lifecycle hook (TASK-765)', () => {
  it('(step-1) stepEmitter.emit is called with running at run start and done at run end (happy path)', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const stepEmitter = makeStepEmitter();

    // TestableRunExecutor + stepEmitter as 9th arg
    const executor = new TestableRunExecutor(
      spawner, registry, makeSpyLogger(),
      undefined, undefined, undefined, undefined, undefined,
      stepEmitter,
    );

    await executor.execute(run.id);

    // Should emit 'running' then 'done'
    expect(stepEmitter.emit).toHaveBeenCalledTimes(2);
    expect(stepEmitter.calls[0]).toEqual({ runId: run.id, status: 'running' });
    expect(stepEmitter.calls[1]).toEqual({ runId: run.id, status: 'done' });
  });

  it('(step-2) stepEmitter.emit fires done on spawner failure path', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('sdk spawn failed'));
    const stepEmitter = makeStepEmitter();

    const executor = new TestableRunExecutor(
      spawner, registry, makeSpyLogger(),
      undefined, undefined, undefined, undefined, undefined,
      stepEmitter,
    );

    await expect(executor.execute(run.id)).rejects.toThrow('sdk spawn failed');

    // Should still emit 'running' then 'done' even on failure
    expect(stepEmitter.emit).toHaveBeenCalledTimes(2);
    expect(stepEmitter.calls[0]).toEqual({ runId: run.id, status: 'running' });
    expect(stepEmitter.calls[1]).toEqual({ runId: run.id, status: 'done' });
  });

  it('(step-3) a throwing stepEmitter does not crash execute() — fail-soft, warn logged', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const spyLogger = makeSpyLogger();

    const throwingStepEmitter: StepTransitionEmitterLike = {
      emit: vi.fn(() => { throw new Error('step emitter exploded'); }),
    };

    const executor = new TestableRunExecutor(
      spawner, registry, spyLogger,
      undefined, undefined, undefined, undefined, undefined,
      throwingStepEmitter,
    );

    // execute() must NOT throw even though stepEmitter throws.
    await expect(executor.execute(run.id)).resolves.toBeUndefined();

    // logger.warn must have been called with the emitter error.
    expect(spyLogger.warn).toHaveBeenCalled();
    const warnCalls = (spyLogger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const stepEmitterWarn = warnCalls.find(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('stepEmitter.emit threw'),
    );
    expect(stepEmitterWarn).toBeDefined();
  });
});
