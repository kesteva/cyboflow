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
import type { ClaudeSpawnerLike, WorkflowRegistryLike, ClaudeSpawnerOptions, WorkflowPromptReaderLike, ProgrammaticRunner, ProgrammaticRunContext } from '../runExecutor';
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
    spec_json: '{}',
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

describe('RunExecutor.execute — execution-model branch (Stage 1)', () => {
  function makeRunner(): ProgrammaticRunner & { run: ReturnType<typeof vi.fn> } {
    return { run: vi.fn<(ctx: ProgrammaticRunContext) => Promise<void>>().mockResolvedValue(undefined) };
  }

  /** Construct a TestableRunExecutor with the programmatic runner in slot 13. */
  function makeExecutor(
    spawner: ClaudeSpawnerLike,
    registry: WorkflowRegistryLike,
    runner?: ProgrammaticRunner,
  ): TestableRunExecutor {
    return new TestableRunExecutor(
      spawner,
      registry,
      makeSpyLogger(),
      undefined, // promptReader
      undefined, // lifecycleTransitions
      undefined, // publisher
      undefined, // db
      undefined, // source
      undefined, // stepEmitter
      undefined, // taskStageDeriver
      undefined, // ideaBodyReader
      undefined, // sprintLaneTaskIds
      runner, // programmaticRunner (slot 13)
    );
  }

  it('delegates a programmatic run to the injected runner and does NOT spawn an orchestrator turn', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/wt', execution_model: 'programmatic' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const runner = makeRunner();
    const executor = makeExecutor(spawner, registry, runner);

    await executor.execute(run.id);

    expect(runner.run).toHaveBeenCalledOnce();
    const ctx = runner.run.mock.calls[0][0] as ProgrammaticRunContext;
    expect(ctx).toMatchObject({
      runId: run.id,
      panelId: run.id,
      sessionId: run.id,
      worktreePath: '/wt',
    });
    expect(ctx.run).toBe(run);
    expect(ctx.workflow).toBe(workflow);
    // The orchestrated spawn path is NOT taken.
    expect(spawner.spawnCliProcess).not.toHaveBeenCalled();
  });

  it('re-throws when the programmatic runner fails (drives the failed lifecycle arm)', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/wt', execution_model: 'programmatic' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const runner = makeRunner();
    runner.run.mockRejectedValueOnce(new Error('phase boom'));
    const executor = makeExecutor(makeSpawner(), registry, runner);

    await expect(executor.execute(run.id)).rejects.toThrow('phase boom');
  });

  it('requestProgrammaticCancel aborts the in-flight controller signal and is a no-op for unknown/orchestrated runs', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/wt', execution_model: 'programmatic' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    let captured: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const runner: ProgrammaticRunner = {
      run: vi.fn((ctx: ProgrammaticRunContext) => {
        captured = ctx.signal;
        return new Promise<void>((r) => {
          release = r;
        });
      }),
    };
    const executor = makeExecutor(makeSpawner(), registry, runner);

    // Unknown run before any execute → false.
    expect(executor.requestProgrammaticCancel('nope')).toBe(false);

    const p = executor.execute(run.id);
    // executeProgrammatic awaits bridgeEvents + pre_spawn before runner.run — flush
    // the queue until the runner has been invoked (bounded spin).
    for (let i = 0; i < 20 && captured === undefined; i++) await new Promise((r) => setTimeout(r, 0));
    expect(captured?.aborted).toBe(false);

    expect(executor.requestProgrammaticCancel(run.id)).toBe(true);
    expect(captured?.aborted).toBe(true);

    release?.();
    await p;

    // After teardown the controller is gone → no-op again.
    expect(executor.requestProgrammaticCancel(run.id)).toBe(false);
  });

  it('falls through to the orchestrated spawn when stamped programmatic but no runner is injected', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/wt', execution_model: 'programmatic' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const executor = makeExecutor(spawner, registry, undefined); // no runner

    await executor.execute(run.id);

    // Liveness preserved: the agent walks the same DAG via the orchestrated spawn.
    expect(spawner.spawnCliProcess).toHaveBeenCalledOnce();
  });

  it('takes the orchestrated spawn path (NOT the runner) for an orchestrated run even when a runner is injected', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/wt', execution_model: 'orchestrated' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const runner = makeRunner();
    const executor = makeExecutor(spawner, registry, runner);

    await executor.execute(run.id);

    expect(spawner.spawnCliProcess).toHaveBeenCalledOnce();
    expect(runner.run).not.toHaveBeenCalled();
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
// and agentPermissionMode threading.
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

describe('RunExecutor.buildOptionsOverrides — agentPermissionMode threading', () => {
  it('(iv) threads agentPermissionMode from run.permission_mode_snapshot ("default")', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree', permission_mode_snapshot: 'default' });
    // Live workflow.permission_mode intentionally DIFFERS from the snapshot to
    // prove buildOptionsOverrides reads the immutable snapshot, not the live row.
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

    expect(capturedOverrides).not.toBeNull();
    // The snapshot value wins, NOT the live workflow.permission_mode.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(capturedOverrides!.agentPermissionMode).toBe('default');
    // The dead preToolUseHook wire is gone — no hook is threaded.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect('preToolUseHook' in capturedOverrides!).toBe(false);
  });

  it('(iv-b) threads agentPermissionMode "dontAsk" straight from the snapshot', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree', permission_mode_snapshot: 'dontAsk' });
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

    expect(capturedOverrides).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(capturedOverrides!.agentPermissionMode).toBe('dontAsk');
  });

  it('(iv-c) threads agentPermissionMode "auto" from the snapshot (native auto)', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree', permission_mode_snapshot: 'auto' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
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

    expect(capturedOverrides).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(capturedOverrides!.agentPermissionMode).toBe('auto');
  });
});

// ---------------------------------------------------------------------------
// TASK-661: New tests for WorkflowPromptReaderLike wiring and systemPromptAppend
// ---------------------------------------------------------------------------

/**
 * Stub reader backed by an in-memory map for unit tests. Keyed by
 * `workflow.workflow_path` (built-in / edited built-in flows). A row with a null
 * `workflow_path` (custom flow) has no entry and throws — mirroring the real
 * adapter, which never resolves a custom flow through this path-keyed stub.
 */
function makeStubReader(entries: Record<string, { prompt: string; systemPromptAppend: string }>): WorkflowPromptReaderLike {
  return {
    read: (workflow: WorkflowRow) => {
      const key = workflow.workflow_path ?? '';
      const entry = entries[key];
      if (!entry) {
        const err = new Error(`WorkflowPromptReadError: no entry for ${key}`);
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

  // Custom-flow routing (workflow_path === null): getPrompt no longer throws on a
  // null path — it passes the full WorkflowRow to the reader, which renders the
  // custom-flow prompt. Proves the reader receives the row (not a path string) and
  // that the no-throw path reaches spawnCliProcess.
  it('getPrompt does NOT throw on a null workflow_path — routes the row through the reader', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: null, name: 'my-custom-flow' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    // Row-typed reader that branches on workflow_path like the real adapter.
    const reader: WorkflowPromptReaderLike = {
      read: (wf: WorkflowRow) =>
        wf.workflow_path === null
          ? { prompt: 'CUSTOM FLOW PROMPT', systemPromptAppend: 'custom-append' }
          : { prompt: 'BUILT-IN', systemPromptAppend: '' },
    };
    const executor = new RunExecutor(spawner, registry, makeSpyLogger(), reader);

    await expect(executor.execute(run.id)).resolves.not.toThrow();

    expect(spawner.spawnCliProcess).toHaveBeenCalledOnce();
    const opts = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions;
    expect(opts.prompt).toBe('CUSTOM FLOW PROMPT');
    expect(opts.systemPromptAppend).toBe('custom-append');
  });

  // Downstream injection branches still apply for a null-workflow_path (custom)
  // run: a pending resume short-circuits to the CONTINUE prompt exactly as it does
  // for a built-in run — proving the custom-flow change left the downstream seam
  // untouched.
  it('downstream resume branch still applies for a null-workflow_path run', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: null, name: 'my-custom-flow' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const reader: WorkflowPromptReaderLike = {
      read: () => ({ prompt: 'CUSTOM FLOW PROMPT', systemPromptAppend: '' }),
    };
    const executor = new RunExecutor(spawner, registry, makeSpyLogger(), reader);
    // Stage a pending resume so getPrompt's resume branch must win.
    executor.setPendingResume(run.id);

    await executor.execute(run.id);

    expect(spawner.spawnCliProcess).toHaveBeenCalledOnce();
    const opts = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions;
    // The base custom prompt is NOT re-sent on a resumed turn.
    expect(opts.prompt).not.toBe('CUSTOM FLOW PROMPT');
    expect(opts.prompt).toBe(RESUME_CONTINUE_PROMPT);
  });
});

// ---------------------------------------------------------------------------
// Migration 017 (Piece A): getPrompt seed-idea injection
// ---------------------------------------------------------------------------

import type { IdeaBodyReaderLike } from '../runExecutor';

/** Stub idea-body reader backed by an in-memory map. */
function makeIdeaReader(
  entries: Record<string, NonNullable<ReturnType<IdeaBodyReaderLike['read']>>>,
): IdeaBodyReaderLike {
  return {
    read: (id: string) => entries[id] ?? null,
  };
}

/** Build a base RunExecutor with the idea-body reader in the trailing (11th) slot. */
function makeSeedExecutor(
  spawner: ClaudeSpawnerLike,
  registry: WorkflowRegistryLike,
  reader: WorkflowPromptReaderLike,
  ideaReader?: IdeaBodyReaderLike,
): RunExecutor {
  return new RunExecutor(
    spawner,
    registry,
    makeSpyLogger(),
    reader,
    undefined, // lifecycleTransitions
    undefined, // publisher
    undefined, // db
    undefined, // source
    undefined, // stepEmitter
    undefined, // taskStageDeriver
    ideaReader, // ideaBodyReader (11th arg)
  );
}

function spawnedPrompt(spawner: ClaudeSpawnerLike): string {
  const opts = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions;
  return opts.prompt;
}

describe('RunExecutor.getPrompt — seed-idea injection (migration 017)', () => {
  it('prepends a `# Selected idea` block when run.seed_idea_id resolves a body', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree', seed_idea_id: 'IDEA-1' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/planner.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const reader = makeStubReader({ '/fake/planner.md': { prompt: 'PLAN BODY', systemPromptAppend: '' } });
    const ideaReader = makeIdeaReader({
      'IDEA-1': { type: 'idea', title: 'My idea', summary: 'A short summary', body: 'The idea body.', scope: 'small' },
    });
    const executor = makeSeedExecutor(spawner, registry, reader, ideaReader);

    await executor.execute(run.id);

    const prompt = spawnedPrompt(spawner);
    expect(prompt.startsWith('# Selected idea')).toBe(true);
    expect(prompt).toContain('## My idea');
    expect(prompt).toContain('A short summary');
    expect(prompt).toContain('The idea body.');
    // The base prompt is preserved after the injected block.
    expect(prompt).toContain('PLAN BODY');
    expect(prompt.indexOf('# Selected idea')).toBeLessThan(prompt.indexOf('PLAN BODY'));
  });

  it('lists attachment paths in the `# Selected idea` block when the idea has images (migration 028)', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/w', seed_idea_id: 'IDEA-ATT' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/planner.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const reader = makeStubReader({ '/fake/planner.md': { prompt: 'PLAN BODY', systemPromptAppend: '' } });
    const ideaReader = makeIdeaReader({
      'IDEA-ATT': {
        type: 'idea',
        title: 'Idea with images',
        summary: null,
        body: 'Body.',
        scope: null,
        attachments: [
          { name: 'mock.png', path: '/cy/artifacts/ideas/IDEA-ATT/att_1.png' },
          { name: 'flow.jpg', path: '/cy/artifacts/ideas/IDEA-ATT/att_2.jpg' },
        ],
      },
    });
    const executor = makeSeedExecutor(spawner, registry, reader, ideaReader);

    await executor.execute(run.id);

    const prompt = spawnedPrompt(spawner);
    expect(prompt).toContain('### Attached images');
    expect(prompt).toContain('- mock.png: /cy/artifacts/ideas/IDEA-ATT/att_1.png');
    expect(prompt).toContain('- flow.jpg: /cy/artifacts/ideas/IDEA-ATT/att_2.jpg');
    // Still a valid Selected-idea block with the base prompt preserved after it.
    expect(prompt.startsWith('# Selected idea')).toBe(true);
    expect(prompt.indexOf('### Attached images')).toBeLessThan(prompt.indexOf('PLAN BODY'));
  });

  it('omits the summary line when the idea has no summary', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/w', seed_idea_id: 'IDEA-2' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/planner.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const reader = makeStubReader({ '/fake/planner.md': { prompt: 'PLAN BODY', systemPromptAppend: '' } });
    const ideaReader = makeIdeaReader({
      'IDEA-2': { type: 'idea', title: 'Bare idea', summary: null, body: 'Just a body.', scope: null },
    });
    const executor = makeSeedExecutor(spawner, registry, reader, ideaReader);

    await executor.execute(run.id);

    const prompt = spawnedPrompt(spawner);
    expect(prompt).toContain('## Bare idea');
    expect(prompt).toContain('Just a body.');
  });

  it('returns the base prompt verbatim when the run has no seed_idea_id', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/w' }); // no seed_idea_id
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/planner.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const reader = makeStubReader({ '/fake/planner.md': { prompt: 'PLAN BODY', systemPromptAppend: '' } });
    const ideaReader = makeIdeaReader({});
    const executor = makeSeedExecutor(spawner, registry, reader, ideaReader);

    await executor.execute(run.id);

    expect(spawnedPrompt(spawner)).toBe('PLAN BODY');
  });

  it('returns the base prompt verbatim when the reader resolves no entity', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/w', seed_idea_id: 'MISSING' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/planner.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const reader = makeStubReader({ '/fake/planner.md': { prompt: 'PLAN BODY', systemPromptAppend: '' } });
    const ideaReader = makeIdeaReader({}); // 'MISSING' resolves to null
    const executor = makeSeedExecutor(spawner, registry, reader, ideaReader);

    await executor.execute(run.id);

    expect(spawnedPrompt(spawner)).toBe('PLAN BODY');
  });

  it('prepends a title-only block when summary+body are empty (the title IS the idea)', async () => {
    // Regression: a free-text idea entered as just a title (empty body/summary)
    // must still be injected — previously the empty-body guard suppressed it and
    // the planner saw no `# Selected idea` block.
    const run = makeWorkflowRunRow({ worktree_path: '/w', seed_idea_id: 'IDEA-TITLE-ONLY' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/planner.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const reader = makeStubReader({ '/fake/planner.md': { prompt: 'PLAN BODY', systemPromptAppend: '' } });
    const ideaReader = makeIdeaReader({
      'IDEA-TITLE-ONLY': { type: 'idea', title: 'Create a website for tester', summary: '', body: '   \n  ', scope: null },
    });
    const executor = makeSeedExecutor(spawner, registry, reader, ideaReader);

    await executor.execute(run.id);

    const prompt = spawnedPrompt(spawner);
    expect(prompt.startsWith('# Selected idea')).toBe(true);
    expect(prompt).toContain('## Create a website for tester');
    expect(prompt).toContain('PLAN BODY');
    expect(prompt.indexOf('# Selected idea')).toBeLessThan(prompt.indexOf('PLAN BODY'));
  });

  it('returns the base prompt verbatim when title, summary AND body are all empty/whitespace', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/w', seed_idea_id: 'IDEA-BLANK' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/planner.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const reader = makeStubReader({ '/fake/planner.md': { prompt: 'PLAN BODY', systemPromptAppend: '' } });
    const ideaReader = makeIdeaReader({
      'IDEA-BLANK': { type: 'idea', title: '   ', summary: '', body: '  \n ', scope: null },
    });
    const executor = makeSeedExecutor(spawner, registry, reader, ideaReader);

    await executor.execute(run.id);

    expect(spawnedPrompt(spawner)).toBe('PLAN BODY');
  });

  it('returns the base prompt verbatim when no ideaBodyReader is injected', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/w', seed_idea_id: 'IDEA-1' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/planner.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const reader = makeStubReader({ '/fake/planner.md': { prompt: 'PLAN BODY', systemPromptAppend: '' } });
    // No ideaReader passed → seed-idea branch is inert.
    const executor = makeSeedExecutor(spawner, registry, reader);

    await executor.execute(run.id);

    expect(spawnedPrompt(spawner)).toBe('PLAN BODY');
  });
});

// ---------------------------------------------------------------------------
// feat/parallel-sprint: getPrompt seed-tasks injection (single-run lane model)
// ---------------------------------------------------------------------------

import type { SprintLaneTaskIdsLike } from '../runExecutor';

/** Build a RunExecutor with the sprint-lane task-id reader in the 12th slot. */
function makeSprintExecutor(
  spawner: ClaudeSpawnerLike,
  registry: WorkflowRegistryLike,
  reader: WorkflowPromptReaderLike,
  ideaReader?: IdeaBodyReaderLike,
  laneTaskIds?: SprintLaneTaskIdsLike,
): RunExecutor {
  return new RunExecutor(
    spawner,
    registry,
    makeSpyLogger(),
    reader,
    undefined, // lifecycleTransitions
    undefined, // publisher
    undefined, // db
    undefined, // source
    undefined, // stepEmitter
    undefined, // taskStageDeriver
    ideaReader, // ideaBodyReader (11th arg)
    laneTaskIds, // sprintLaneTaskIds (12th arg)
  );
}

describe('RunExecutor.getPrompt — sprint seed-tasks injection (feat/parallel-sprint)', () => {
  const sprintReader = () =>
    makeStubReader({ '/fake/sprint.md': { prompt: 'SPRINT BODY', systemPromptAppend: '' } });

  it('prepends a `# Sprint tasks` block (count line + per-task `## <ref>: <title>` sections) when run.batch_id resolves lanes', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/w', batch_id: 'batch-1' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/sprint.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const ideaReader = makeIdeaReader({
      't-1': { type: 'task', title: 'First task', summary: 'Sum 1', body: 'Body 1', scope: null, ref: 'TASK-1' },
      't-2': { type: 'task', title: 'Second task', summary: null, body: null, scope: null, ref: 'TASK-2' },
    });
    const laneTaskIds: SprintLaneTaskIdsLike = { listLaneTaskIds: vi.fn().mockReturnValue(['t-1', 't-2']) };
    const executor = makeSprintExecutor(spawner, registry, sprintReader(), ideaReader, laneTaskIds);

    await executor.execute(run.id);

    const prompt = spawnedPrompt(spawner);
    expect(prompt.startsWith('# Sprint tasks')).toBe(true);
    expect(prompt).toContain('This sprint covers 2 tasks');
    expect(prompt).toContain('## TASK-1: First task');
    expect(prompt).toContain('Sum 1');
    expect(prompt).toContain('Body 1');
    expect(prompt).toContain('## TASK-2: Second task');
    // The base prompt is preserved after the injected block.
    expect(prompt).toContain('SPRINT BODY');
    expect(prompt.indexOf('# Sprint tasks')).toBeLessThan(prompt.indexOf('SPRINT BODY'));
    expect(laneTaskIds.listLaneTaskIds).toHaveBeenCalledWith('batch-1');
  });

  it('falls back to the raw task id in the heading when ref is absent', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/w', batch_id: 'batch-1' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/sprint.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const ideaReader = makeIdeaReader({
      't-noref': { type: 'task', title: 'Refless task', summary: null, body: null, scope: null },
    });
    const laneTaskIds: SprintLaneTaskIdsLike = { listLaneTaskIds: () => ['t-noref'] };
    const executor = makeSprintExecutor(spawner, registry, sprintReader(), ideaReader, laneTaskIds);

    await executor.execute(run.id);

    expect(spawnedPrompt(spawner)).toContain('## t-noref: Refless task');
  });

  it('skips an unresolvable task id fail-soft and still renders the rest', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/w', batch_id: 'batch-1' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/sprint.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const ideaReader = makeIdeaReader({
      't-ok': { type: 'task', title: 'Good task', summary: null, body: 'Body', scope: null, ref: 'TASK-9' },
      // 't-missing' resolves to null
    });
    const laneTaskIds: SprintLaneTaskIdsLike = { listLaneTaskIds: () => ['t-missing', 't-ok'] };
    const executor = makeSprintExecutor(spawner, registry, sprintReader(), ideaReader, laneTaskIds);

    await executor.execute(run.id);

    const prompt = spawnedPrompt(spawner);
    expect(prompt).toContain('## TASK-9: Good task');
    expect(prompt).toContain('This sprint covers 1 task.');
    expect(prompt).not.toContain('t-missing');
  });

  it('returns the base prompt verbatim when the run has no batch_id', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/w' }); // no batch_id
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/sprint.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const ideaReader = makeIdeaReader({});
    const laneTaskIds: SprintLaneTaskIdsLike = { listLaneTaskIds: vi.fn().mockReturnValue([]) };
    const executor = makeSprintExecutor(spawner, registry, sprintReader(), ideaReader, laneTaskIds);

    await executor.execute(run.id);

    expect(spawnedPrompt(spawner)).toBe('SPRINT BODY');
    expect(laneTaskIds.listLaneTaskIds).not.toHaveBeenCalled();
  });

  it('returns the base prompt verbatim when the lane listing throws (fail-soft)', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/w', batch_id: 'batch-broken' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/sprint.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const ideaReader = makeIdeaReader({});
    const laneTaskIds: SprintLaneTaskIdsLike = {
      listLaneTaskIds: () => {
        throw new Error('boom');
      },
    };
    const executor = makeSprintExecutor(spawner, registry, sprintReader(), ideaReader, laneTaskIds);

    await executor.execute(run.id);

    expect(spawnedPrompt(spawner)).toBe('SPRINT BODY');
  });

  it('returns the base prompt verbatim when no sprintLaneTaskIds reader is injected', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/w', batch_id: 'batch-1' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/sprint.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const executor = makeSprintExecutor(spawner, registry, sprintReader(), makeIdeaReader({}));

    await executor.execute(run.id);

    expect(spawnedPrompt(spawner)).toBe('SPRINT BODY');
  });

  it('a pending nudge wins — the resumed turn does NOT re-send the seed-tasks block', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/w', batch_id: 'batch-1', claude_session_id: 'sess-1' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/sprint.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const ideaReader = makeIdeaReader({
      't-1': { type: 'task', title: 'First task', summary: null, body: 'Body 1', scope: null, ref: 'TASK-1' },
    });
    const laneTaskIds: SprintLaneTaskIdsLike = { listLaneTaskIds: vi.fn().mockReturnValue(['t-1']) };
    const executor = makeSprintExecutor(spawner, registry, sprintReader(), ideaReader, laneTaskIds);

    executor.setPendingNudge(run.id, 'the nudge');
    await executor.execute(run.id);

    expect(spawnedPrompt(spawner)).toBe('the nudge');
    expect(spawnedPrompt(spawner)).not.toContain('# Sprint tasks');
    expect(laneTaskIds.listLaneTaskIds).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Migration 018 (Piece C): getPrompt nudge branch + resumeSessionId threading
// ---------------------------------------------------------------------------

/** Read the full options object passed to the (first) spawnCliProcess call. */
function spawnedOpts(spawner: ClaudeSpawnerLike): ClaudeSpawnerOptions {
  return (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions;
}

describe('RunExecutor — idle-chat nudge (migration 018)', () => {
  it('getPrompt returns JUST the trimmed nudge text (no planner.md) when a nudge is pending', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/w', claude_session_id: 'sess-1' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/planner.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const reader = makeStubReader({ '/fake/planner.md': { prompt: 'PLAN BODY', systemPromptAppend: '' } });
    const executor = makeSeedExecutor(spawner, registry, reader);

    executor.setPendingNudge(run.id, '  please also handle the edge case  ');
    await executor.execute(run.id);

    // The prompt is the trimmed nudge verbatim — planner.md ('PLAN BODY') is NOT re-sent.
    expect(spawnedPrompt(spawner)).toBe('please also handle the edge case');
    expect(spawnedPrompt(spawner)).not.toContain('PLAN BODY');
  });

  it('nudge text wins over the seed-idea branch on a resumed turn', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/w', seed_idea_id: 'IDEA-1', claude_session_id: 'sess-1' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/planner.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const reader = makeStubReader({ '/fake/planner.md': { prompt: 'PLAN BODY', systemPromptAppend: '' } });
    const ideaReader = makeIdeaReader({
      'IDEA-1': { type: 'idea', title: 'My idea', summary: null, body: 'The idea body.', scope: null },
    });
    const executor = makeSeedExecutor(spawner, registry, reader, ideaReader);

    executor.setPendingNudge(run.id, 'the nudge');
    await executor.execute(run.id);

    expect(spawnedPrompt(spawner)).toBe('the nudge');
    expect(spawnedPrompt(spawner)).not.toContain('# Selected idea');
  });

  it('threads resumeSessionId = claude_session_id into spawn options when a nudge is pending', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/w', claude_session_id: 'sess-xyz' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/planner.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const reader = makeStubReader({ '/fake/planner.md': { prompt: 'PLAN BODY', systemPromptAppend: '' } });
    const executor = makeSeedExecutor(spawner, registry, reader);

    executor.setPendingNudge(run.id, 'follow up');
    await executor.execute(run.id);

    expect(spawnedOpts(spawner).resumeSessionId).toBe('sess-xyz');
  });

  it('does NOT thread resumeSessionId when a nudge is pending but no claude_session_id exists', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/w' }); // no claude_session_id
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/planner.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const reader = makeStubReader({ '/fake/planner.md': { prompt: 'PLAN BODY', systemPromptAppend: '' } });
    const executor = makeSeedExecutor(spawner, registry, reader);

    executor.setPendingNudge(run.id, 'follow up');
    await executor.execute(run.id);

    expect(spawnedOpts(spawner).resumeSessionId).toBeUndefined();
  });

  it('a fresh run (no pending nudge) sends byte-identical options — no resumeSessionId', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/w', claude_session_id: 'sess-1' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/planner.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const reader = makeStubReader({ '/fake/planner.md': { prompt: 'PLAN BODY', systemPromptAppend: '' } });
    const executor = makeSeedExecutor(spawner, registry, reader);

    // No setPendingNudge call → fresh run floor.
    await executor.execute(run.id);

    expect(spawnedPrompt(spawner)).toBe('PLAN BODY');
    expect(spawnedOpts(spawner).resumeSessionId).toBeUndefined();
  });

  it('teardownRun clears the pending nudge — a second execute() is a clean fresh turn', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/w', claude_session_id: 'sess-1' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/planner.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const reader = makeStubReader({ '/fake/planner.md': { prompt: 'PLAN BODY', systemPromptAppend: '' } });
    const executor = makeSeedExecutor(spawner, registry, reader);

    // First turn: nudge delivered.
    executor.setPendingNudge(run.id, 'the nudge');
    await executor.execute(run.id);
    expect(
      ((spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions).prompt,
    ).toBe('the nudge');

    // Second turn (no new nudge): teardown cleared the stash → base prompt + no resume.
    await executor.execute(run.id);
    const secondOpts = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[1][0] as ClaudeSpawnerOptions;
    expect(secondOpts.prompt).toBe('PLAN BODY');
    expect(secondOpts.resumeSessionId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 4b (SDK-only Pause/Resume): getPrompt CONTINUE branch + resumeSessionId
// threading in resume mode (setPendingResume — no human text).
// ---------------------------------------------------------------------------

import { RESUME_CONTINUE_PROMPT } from '../runExecutor';

describe('RunExecutor — SDK-only Resume (Phase 4b)', () => {
  it('getPrompt returns the minimal CONTINUE prompt (not the base prompt) when resume is pending', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/w', claude_session_id: 'sess-1' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/planner.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const reader = makeStubReader({ '/fake/planner.md': { prompt: 'PLAN BODY', systemPromptAppend: '' } });
    const executor = makeSeedExecutor(spawner, registry, reader);

    executor.setPendingResume(run.id);
    await executor.execute(run.id);

    // The prompt is the CONTINUE sentinel — the base prompt ('PLAN BODY') is NOT re-sent.
    expect(spawnedPrompt(spawner)).toBe(RESUME_CONTINUE_PROMPT);
    expect(spawnedPrompt(spawner)).not.toContain('PLAN BODY');
  });

  it('threads resumeSessionId = claude_session_id into spawn options in resume mode', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/w', claude_session_id: 'sess-resume' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/planner.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const reader = makeStubReader({ '/fake/planner.md': { prompt: 'PLAN BODY', systemPromptAppend: '' } });
    const executor = makeSeedExecutor(spawner, registry, reader);

    executor.setPendingResume(run.id);
    await executor.execute(run.id);

    expect(spawnedOpts(spawner).resumeSessionId).toBe('sess-resume');
  });

  it('does NOT thread resumeSessionId in resume mode when no claude_session_id exists', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/w' }); // no claude_session_id
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/planner.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const reader = makeStubReader({ '/fake/planner.md': { prompt: 'PLAN BODY', systemPromptAppend: '' } });
    const executor = makeSeedExecutor(spawner, registry, reader);

    executor.setPendingResume(run.id);
    await executor.execute(run.id);

    // getPrompt still returns the CONTINUE sentinel, but no resume id is threaded.
    expect(spawnedPrompt(spawner)).toBe(RESUME_CONTINUE_PROMPT);
    expect(spawnedOpts(spawner).resumeSessionId).toBeUndefined();
  });

  it('a pending nudge WINS over a pending resume (nudge text, not the CONTINUE sentinel)', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/w', claude_session_id: 'sess-1' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/planner.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const reader = makeStubReader({ '/fake/planner.md': { prompt: 'PLAN BODY', systemPromptAppend: '' } });
    const executor = makeSeedExecutor(spawner, registry, reader);

    executor.setPendingNudge(run.id, 'the nudge');
    executor.setPendingResume(run.id);
    await executor.execute(run.id);

    expect(spawnedPrompt(spawner)).toBe('the nudge');
    expect(spawnedPrompt(spawner)).not.toBe(RESUME_CONTINUE_PROMPT);
  });

  it('teardownRun clears the resume flag — a second execute() is a clean fresh turn', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/w', claude_session_id: 'sess-1' });
    const workflow = makeWorkflowRow({ id: run.workflow_id, workflow_path: '/fake/planner.md' });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner();
    const reader = makeStubReader({ '/fake/planner.md': { prompt: 'PLAN BODY', systemPromptAppend: '' } });
    const executor = makeSeedExecutor(spawner, registry, reader);

    // First turn: resume.
    executor.setPendingResume(run.id);
    await executor.execute(run.id);
    expect(
      ((spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions).prompt,
    ).toBe(RESUME_CONTINUE_PROMPT);

    // Second turn (no new resume): teardown cleared the flag → base prompt + no resume.
    await executor.execute(run.id);
    const secondOpts = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[1][0] as ClaudeSpawnerOptions;
    expect(secondOpts.prompt).toBe('PLAN BODY');
    expect(secondOpts.resumeSessionId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TASK-662: Lifecycle transition tests
// ---------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import type { LifecycleTransitionsLike } from '../runExecutor';

function makeLifecycleTransitions(): { mock: LifecycleTransitionsLike } & {
  running: ReturnType<typeof vi.fn>;
  restAwaitingReview: ReturnType<typeof vi.fn>;
  failed: ReturnType<typeof vi.fn>;
  canceled: ReturnType<typeof vi.fn>;
} {
  const running = vi.fn<(runId: string) => void>();
  const restAwaitingReview = vi.fn<(runId: string) => void>();
  const failed = vi.fn<(runId: string, fromStatus: 'starting' | 'running' | 'awaiting_review' | 'stuck', errorMessage: string) => void>();
  const canceled = vi.fn<(runId: string) => void>();
  const mock: LifecycleTransitionsLike = { running, restAwaitingReview, failed, canceled };
  return { mock, running, restAwaitingReview, failed, canceled };
}

describe('lifecycle transitions', () => {
  // -------------------------------------------------------------------------
  // (i) onLifecycleTransition routes each phase to the right transition helper
  // -------------------------------------------------------------------------
  it('onLifecycleTransition routes each phase to the right transition helper', async () => {
    const { mock: lt, running, restAwaitingReview, canceled } = makeLifecycleTransitions();

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

    // 'drained' is the SDK-iterator-drain phase: the executor NEVER completes;
    // it RESTS the run in awaiting_review via restAwaitingReview().
    await executor.testLifecycleTransition(run.id, 'drained');
    expect(restAwaitingReview).toHaveBeenCalledOnce();
    expect(restAwaitingReview).toHaveBeenCalledWith(run.id);

    await executor.testLifecycleTransition(run.id, 'canceled');
    expect(canceled).toHaveBeenCalledOnce();
    expect(canceled).toHaveBeenCalledWith(run.id);

    // pre_spawn also calls running() (it advances starting → running before
    // the SDK spawns so ApprovalRouter sees the run as 'running' when PreToolUse
    // fires).  post_spawn is a true no-op.
    await executor.testLifecycleTransition(run.id, 'pre_spawn');
    await executor.testLifecycleTransition(run.id, 'post_spawn');
    expect(running).toHaveBeenCalledTimes(2); // once for sdk_initialized, once for pre_spawn
    expect(restAwaitingReview).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // (ii) execute() rests the run in awaiting_review on normal terminate —
  // it must NEVER auto-complete. `completed` is set only by a user accept.
  // -------------------------------------------------------------------------
  it('execute() rests the run in awaiting_review on normal terminate (never completes)', async () => {
    const { mock: lt, restAwaitingReview } = makeLifecycleTransitions();

    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };
    const spawner = makeSpawner(); // resolves successfully

    const executor = new TestableRunExecutor(spawner, registry, makeSpyLogger(), undefined, lt);
    await executor.execute(run.id);

    expect(restAwaitingReview).toHaveBeenCalledOnce();
    expect(restAwaitingReview).toHaveBeenCalledWith(run.id);
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
// REST-on-drain: on a clean SDK iterator drain the executor RESTS the run in
// awaiting_review (running -> awaiting_review). It NEVER auto-completes — the
// `completed` status is set only by an explicit user accept (Merge / Create-PR).
// ---------------------------------------------------------------------------

describe('RunExecutor.execute — rests in awaiting_review on drain', () => {
  // (i) clean drain rests the run in awaiting_review.
  it('calls restAwaitingReview() once on a clean drain', async () => {
    const { mock: lt, restAwaitingReview } = makeLifecycleTransitions();
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree', status: 'running' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };

    const executor = new TestableRunExecutor(makeSpawner(), registry, makeSpyLogger(), undefined, lt);
    await executor.execute(run.id);

    expect(restAwaitingReview).toHaveBeenCalledOnce();
    expect(restAwaitingReview).toHaveBeenCalledWith(run.id);
  });

  // (ii) a rejected rest transition (run already parked) is swallowed, not escalated.
  // restAwaitingReview is guarded on status='running', so when the run already moved
  // to awaiting_review (open approval gate) the transition throws and the executor
  // logs + swallows it. execute() must still resolve cleanly.
  it('swallows a rejected rest transition (run already parked in awaiting_review)', async () => {
    const { mock: lt, restAwaitingReview } = makeLifecycleTransitions();
    (restAwaitingReview as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('not in running state');
    });
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree', status: 'awaiting_review' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };

    const executor = new TestableRunExecutor(makeSpawner(), registry, makeSpyLogger(), undefined, lt);
    await expect(executor.execute(run.id)).resolves.toBeUndefined();
    expect(restAwaitingReview).toHaveBeenCalledOnce();
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
    const { mock: lt, running, restAwaitingReview } = makeLifecycleTransitions();

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

    // execute() drained normally → the run RESTS in awaiting_review (never completes).
    expect(restAwaitingReview).toHaveBeenCalledOnce();
    expect(restAwaitingReview).toHaveBeenCalledWith(run.id);

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

// ---------------------------------------------------------------------------
// IDEA-030 / TASK-818: event-driven rest for the persistent interactive
// substrate.
//
// For an interactive run the spawnCliProcess promise stays PENDING across turns
// (it resolves only on explicit end-session / kill). Each assistant turn-end
// emits a 'turn-end' event on the `source` EventEmitter (interactive manager ->
// SubstrateDispatchFacade -> RunExecutor) that rests the run in awaiting_review
// via restAwaitingReview WITHOUT resolving the spawn promise. An SDK run never
// receives the event (the facade only fans in the interactive manager) and
// drains via the iterator -> the unchanged 'drained' arm.
// ---------------------------------------------------------------------------

/** A spawner whose spawnCliProcess promise can be resolved externally (mimics a
 *  persistent interactive REPL that settles only on explicit termination). */
function makeControllableSpawner(): {
  spawner: ClaudeSpawnerLike;
  resolveSpawn: () => void;
  spawnStarted: Promise<void>;
} {
  let resolveSpawn!: () => void;
  let markStarted!: () => void;
  const spawnStarted = new Promise<void>((r) => {
    markStarted = r;
  });
  const spawner: ClaudeSpawnerLike = {
    spawnCliProcess: vi.fn<(options: ClaudeSpawnerOptions) => Promise<void>>().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSpawn = resolve;
          markStarted();
        }),
    ),
    abort: vi.fn<(panelId: string) => Promise<void>>().mockResolvedValue(undefined),
  };
  return { spawner, resolveSpawn: () => resolveSpawn(), spawnStarted };
}

describe('RunExecutor — event-driven rest (persistent interactive substrate)', () => {
  it('turn-end event rests the run in awaiting_review while the spawn promise stays pending; a second event re-rests', async () => {
    const { mock: lt, restAwaitingReview } = makeLifecycleTransitions();

    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree', status: 'running', substrate: 'interactive' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };

    const source = new EventEmitter();
    const { spawner, resolveSpawn, spawnStarted } = makeControllableSpawner();

    const executor = new TestableRunExecutor(
      spawner,
      registry,
      makeSpyLogger(),
      undefined,
      lt,
      undefined,
      undefined,
      source, // 8th arg: source EventEmitter (the facade in production)
    );

    // Kick off execute() — it will register the turn-end listener, spawn, and
    // then BLOCK on the still-pending spawn promise (REPL alive). Track whether
    // execute() has returned so we can assert it stays pending across turns.
    let executeSettled = false;
    const executePromise = executor.execute(run.id).then(() => {
      executeSettled = true;
    });
    await spawnStarted;

    // No rest yet — the run is running with no turn-end.
    expect(restAwaitingReview).not.toHaveBeenCalled();

    // Fire a turn-end event: the run rests in awaiting_review WITHOUT resolving
    // the spawn promise.
    source.emit('turn-end', { panelId: run.id, sessionId: run.id, runId: run.id });
    await new Promise((r) => setTimeout(r, 0));
    expect(restAwaitingReview).toHaveBeenCalledTimes(1);
    expect(restAwaitingReview).toHaveBeenCalledWith(run.id);

    // The spawn promise is STILL pending — execute() has not returned.
    expect(executeSettled).toBe(false);

    // A SECOND turn-end re-rests (re-armable, not one-shot).
    source.emit('turn-end', { panelId: run.id, sessionId: run.id, runId: run.id });
    await new Promise((r) => setTimeout(r, 0));
    expect(restAwaitingReview).toHaveBeenCalledTimes(2);
    expect(executeSettled).toBe(false);

    // Explicit termination: resolve the spawn promise so execute() unblocks.
    resolveSpawn();
    await executePromise;
    expect(executeSettled).toBe(true);
  });

  it('ignores a turn-end event whose runId does not match', async () => {
    const { mock: lt, restAwaitingReview } = makeLifecycleTransitions();

    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree', status: 'running', substrate: 'interactive' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };

    const source = new EventEmitter();
    const { spawner, resolveSpawn, spawnStarted } = makeControllableSpawner();

    const executor = new TestableRunExecutor(
      spawner, registry, makeSpyLogger(), undefined, lt, undefined, undefined, source,
    );

    const executePromise = executor.execute(run.id);
    await spawnStarted;

    // A turn-end for a DIFFERENT run must not rest this run.
    source.emit('turn-end', { panelId: 'other-run', sessionId: 'other-run', runId: 'other-run' });
    await new Promise((r) => setTimeout(r, 0));
    expect(restAwaitingReview).not.toHaveBeenCalled();

    resolveSpawn();
    await executePromise;
  });

  it('SDK run: no event-driven rest — drains at spawn resolution via the unchanged drained arm', async () => {
    const { mock: lt, restAwaitingReview } = makeLifecycleTransitions();

    // substrate omitted/undefined -> SDK (the floor).
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree', status: 'running' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };

    const source = new EventEmitter();
    const spawner = makeSpawner(); // resolves immediately at iterator drain

    const executor = new TestableRunExecutor(
      spawner, registry, makeSpyLogger(), undefined, lt, undefined, undefined, source,
    );

    await executor.execute(run.id);

    // An SDK run never registers a turn-end listener; emitting one is a no-op.
    source.emit('turn-end', { panelId: run.id, sessionId: run.id, runId: run.id });
    await new Promise((r) => setTimeout(r, 0));

    // restAwaitingReview fired EXACTLY once — via the 'drained' arm at spawn
    // resolution, NOT via an event-driven rest (the SDK never receives one).
    expect(restAwaitingReview).toHaveBeenCalledTimes(1);
    expect(restAwaitingReview).toHaveBeenCalledWith(run.id);
  });

  it('teardownRun (bridge dispose) does NOT fire while the interactive REPL is alive; fires only on explicit termination', async () => {
    const run = makeWorkflowRunRow({ worktree_path: '/my/worktree', status: 'running', substrate: 'interactive' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(run),
      getById: vi.fn().mockReturnValue(workflow),
    };

    const source = new EventEmitter();
    const { spawner, resolveSpawn, spawnStarted } = makeControllableSpawner();

    // A bridge handle whose dispose() we can observe.
    const dispose = vi.fn();
    class BridgeExecutor extends TestableRunExecutor {
      protected override async bridgeEvents(_runId: string, _panelId: string): Promise<RunEventBridge> {
        return { dispose } as unknown as RunEventBridge;
      }
    }

    const executor = new BridgeExecutor(
      spawner, registry, makeSpyLogger(), undefined, undefined, undefined, undefined, source,
    );

    const executePromise = executor.execute(run.id);
    await spawnStarted;

    // Several turn-ends fire while the REPL is alive — the bridge must NOT be
    // disposed (teardownRun is deferred until the spawn promise settles).
    source.emit('turn-end', { panelId: run.id, sessionId: run.id, runId: run.id });
    source.emit('turn-end', { panelId: run.id, sessionId: run.id, runId: run.id });
    await new Promise((r) => setTimeout(r, 0));
    expect(dispose).not.toHaveBeenCalled();

    // Explicit termination: the spawn promise resolves, execute() returns, and
    // the finally block disposes the bridge exactly once.
    resolveSpawn();
    await executePromise;
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
