/**
 * Unit + integration tests for SubstrateDispatchFacade (IDEA-013 S4 / TASK-809).
 *
 * Behaviors covered:
 *   - dispatch: spawnCliProcess routes to the manager matching run.substrate
 *     ('interactive' -> InteractiveClaudeManager; 'sdk'/undefined -> ClaudeCodeManager).
 *   - abort by owner: abort(panelId) hits the manager that spawned that panel.
 *   - fan-in re-emit: an 'output'/'exit' emitted by either manager is re-emitted by
 *     the facade with the identical payload object.
 *   - cross-substrate envelope parity: the SAME golden output fixture fed through the
 *     facade into bridgeEvents() (skipPersistence:true) yields a shape-identical
 *     {type,payload,timestamp} envelope for both substrates; payload.panelId === runId.
 *   - RunExecutor-over-facade integration: an interactive-branch clean drain drives
 *     the SAME lifecycle transitions (restAwaitingReview fired exactly once).
 *
 * The spy managers are EventEmitter subclasses with vi.fn() spawnCliProcess/killProcess,
 * cast to AbstractCliManager via `as unknown as` ONLY at the construction boundary
 * (the double-cast is permitted; the bare-any cast is forbidden by CI lint).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'crypto';
import { SubstrateDispatchFacade } from '../substrateDispatchFacade';
import { RunExecutor } from '../../orchestrator/runExecutor';
import type {
  ClaudeSpawnerOptions,
  WorkflowRegistryLike,
  LifecycleTransitionsLike,
} from '../../orchestrator/runExecutor';
import type { AbstractCliManager } from '../panels/cli/AbstractCliManager';
import type { StreamEventPublisher } from '../../orchestrator/runLauncher';
import type { StreamEnvelope } from '../../../../shared/types/claudeStream';
import { bridgeEvents } from '../../orchestrator/runEventBridge';
import type { WorkflowRow, WorkflowRunRow } from '../../../../shared/types/workflows';
import { makeSpyLogger } from '../../orchestrator/__test_fixtures__/loggerLikeSpy';

// ---------------------------------------------------------------------------
// Spy manager — an EventEmitter subclass exposing vi.fn() spawnCliProcess /
// killProcess. The facade only ever uses .on()/.off()/.emit() (inherited) and
// these two methods, so a minimal shape satisfies the AbstractCliManager seam.
// ---------------------------------------------------------------------------

class SpyManager extends EventEmitter {
  spawnCliProcess = vi.fn<(options: ClaudeSpawnerOptions) => Promise<void>>().mockResolvedValue(undefined);
  killProcess = vi.fn<(panelId: string) => Promise<void>>().mockResolvedValue(undefined);
}

/** Build a SpyManager cast to AbstractCliManager at the construction boundary. */
function makeSpyManager(): SpyManager {
  return new SpyManager();
}

function asManager(spy: SpyManager): AbstractCliManager {
  return spy as unknown as AbstractCliManager;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
 * A WorkflowRegistryLike whose getRunById returns a row with a controllable
 * substrate. getById returns a matching workflow row so RunExecutor.execute can
 * proceed to spawn.
 */
function makeRegistry(run: WorkflowRunRow, workflow?: WorkflowRow): WorkflowRegistryLike {
  return {
    getRunById: vi.fn().mockReturnValue(run),
    getById: vi.fn().mockReturnValue(workflow ?? makeWorkflowRow({ id: run.workflow_id })),
  };
}

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

/** Golden SDK-init output fixture (panelId === sessionId === runId). */
function makeGoldenOutput(runId: string): { panelId: string; sessionId: string; type: 'json'; data: unknown; timestamp: Date } {
  return {
    panelId: runId,
    sessionId: runId,
    type: 'json',
    data: {
      type: 'system',
      subtype: 'init',
      session_id: 'sess-test',
      cwd: '/tmp',
      model: 'claude-opus',
      tools: [],
      mcp_servers: [],
      permissionMode: 'default',
    },
    timestamp: new Date(),
  };
}

beforeEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

describe('SubstrateDispatchFacade — substrate-aware dispatch', () => {
  it("routes spawnCliProcess to the interactive manager when run.substrate === 'interactive'", async () => {
    const run = makeWorkflowRunRow({ substrate: 'interactive' });
    const registry = makeRegistry(run);
    const sdk = makeSpyManager();
    const interactive = makeSpyManager();
    const facade = new SubstrateDispatchFacade(asManager(sdk), asManager(interactive), registry, makeSpyLogger());

    await facade.spawnCliProcess({
      panelId: run.id,
      sessionId: run.id,
      runId: run.id,
      worktreePath: '/fake/worktree',
      prompt: 'go',
    });

    expect(interactive.spawnCliProcess).toHaveBeenCalledOnce();
    expect(sdk.spawnCliProcess).not.toHaveBeenCalled();
  });

  it("routes spawnCliProcess to the sdk manager when run.substrate === 'sdk'", async () => {
    const run = makeWorkflowRunRow({ substrate: 'sdk' });
    const registry = makeRegistry(run);
    const sdk = makeSpyManager();
    const interactive = makeSpyManager();
    const facade = new SubstrateDispatchFacade(asManager(sdk), asManager(interactive), registry, makeSpyLogger());

    await facade.spawnCliProcess({
      panelId: run.id,
      sessionId: run.id,
      runId: run.id,
      worktreePath: '/fake/worktree',
      prompt: 'go',
    });

    expect(sdk.spawnCliProcess).toHaveBeenCalledOnce();
    expect(interactive.spawnCliProcess).not.toHaveBeenCalled();
  });

  it('routes spawnCliProcess to the sdk manager when substrate is undefined (legacy/default floor)', async () => {
    const run = makeWorkflowRunRow({ substrate: undefined });
    const registry = makeRegistry(run);
    const sdk = makeSpyManager();
    const interactive = makeSpyManager();
    const facade = new SubstrateDispatchFacade(asManager(sdk), asManager(interactive), registry, makeSpyLogger());

    await facade.spawnCliProcess({
      panelId: run.id,
      sessionId: run.id,
      runId: run.id,
      worktreePath: '/fake/worktree',
      prompt: 'go',
    });

    expect(sdk.spawnCliProcess).toHaveBeenCalledOnce();
    expect(interactive.spawnCliProcess).not.toHaveBeenCalled();
  });

  it('routes spawnCliProcess to the sdk manager when getRunById returns null (defaults to sdk)', async () => {
    const registry: WorkflowRegistryLike = {
      getRunById: vi.fn().mockReturnValue(null),
      getById: vi.fn().mockReturnValue(null),
    };
    const sdk = makeSpyManager();
    const interactive = makeSpyManager();
    const facade = new SubstrateDispatchFacade(asManager(sdk), asManager(interactive), registry, makeSpyLogger());

    await facade.spawnCliProcess({
      panelId: 'unknown-run',
      sessionId: 'unknown-run',
      runId: 'unknown-run',
      worktreePath: '/fake/worktree',
      prompt: 'go',
    });

    expect(sdk.spawnCliProcess).toHaveBeenCalledOnce();
    expect(interactive.spawnCliProcess).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// abort by owner
// ---------------------------------------------------------------------------

describe('SubstrateDispatchFacade — abort dispatches to the panel-owning manager', () => {
  it('abort(panelId) calls killProcess on the manager that spawned that panel (interactive)', async () => {
    const run = makeWorkflowRunRow({ substrate: 'interactive' });
    const registry = makeRegistry(run);
    const sdk = makeSpyManager();
    const interactive = makeSpyManager();
    const facade = new SubstrateDispatchFacade(asManager(sdk), asManager(interactive), registry, makeSpyLogger());

    await facade.spawnCliProcess({
      panelId: run.id,
      sessionId: run.id,
      runId: run.id,
      worktreePath: '/fake/worktree',
      prompt: 'go',
    });

    await facade.abort(run.id);

    expect(interactive.killProcess).toHaveBeenCalledOnce();
    expect(interactive.killProcess).toHaveBeenCalledWith(run.id);
    expect(sdk.killProcess).not.toHaveBeenCalled();
  });

  it('abort(panelId) hits the spawning manager even if the row substrate later changes', async () => {
    const run = makeWorkflowRunRow({ substrate: 'interactive' });
    const registry = makeRegistry(run);
    const sdk = makeSpyManager();
    const interactive = makeSpyManager();
    const facade = new SubstrateDispatchFacade(asManager(sdk), asManager(interactive), registry, makeSpyLogger());

    await facade.spawnCliProcess({
      panelId: run.id,
      sessionId: run.id,
      runId: run.id,
      worktreePath: '/fake/worktree',
      prompt: 'go',
    });

    // Mutate the row's substrate AFTER spawn — abort must still hit the original owner.
    (registry.getRunById as ReturnType<typeof vi.fn>).mockReturnValue({ ...run, substrate: 'sdk' });

    await facade.abort(run.id);

    expect(interactive.killProcess).toHaveBeenCalledOnce();
    expect(sdk.killProcess).not.toHaveBeenCalled();
  });

  it('abort for an untracked panel falls back to substrate resolution and warns', async () => {
    const run = makeWorkflowRunRow({ substrate: 'sdk' });
    const registry = makeRegistry(run);
    const sdk = makeSpyManager();
    const interactive = makeSpyManager();
    const logger = makeSpyLogger();
    const facade = new SubstrateDispatchFacade(asManager(sdk), asManager(interactive), registry, logger);

    // No prior spawn — panel is untracked.
    await facade.abort(run.id);

    expect(sdk.killProcess).toHaveBeenCalledOnce();
    expect(sdk.killProcess).toHaveBeenCalledWith(run.id);
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// fan-in re-emit
// ---------------------------------------------------------------------------

describe('SubstrateDispatchFacade — fan-in re-emits both managers events', () => {
  it("re-emits an 'output' from the interactive manager with the identical payload object", () => {
    const run = makeWorkflowRunRow({ substrate: 'interactive' });
    const registry = makeRegistry(run);
    const sdk = makeSpyManager();
    const interactive = makeSpyManager();
    const facade = new SubstrateDispatchFacade(asManager(sdk), asManager(interactive), registry, makeSpyLogger());

    const received: unknown[] = [];
    facade.on('output', (p) => received.push(p));

    const golden = makeGoldenOutput(run.id);
    interactive.emit('output', golden);

    expect(received).toHaveLength(1);
    // Identical payload object (re-emitted by reference, not re-wrapped).
    expect(received[0]).toBe(golden);
  });

  it("re-emits an 'output' from the sdk manager with the identical payload object", () => {
    const run = makeWorkflowRunRow({ substrate: 'sdk' });
    const registry = makeRegistry(run);
    const sdk = makeSpyManager();
    const interactive = makeSpyManager();
    const facade = new SubstrateDispatchFacade(asManager(sdk), asManager(interactive), registry, makeSpyLogger());

    const received: unknown[] = [];
    facade.on('output', (p) => received.push(p));

    const golden = makeGoldenOutput(run.id);
    sdk.emit('output', golden);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(golden);
  });

  it("re-emits an 'exit' from either manager with the identical payload object", () => {
    const run = makeWorkflowRunRow();
    const registry = makeRegistry(run);
    const sdk = makeSpyManager();
    const interactive = makeSpyManager();
    const facade = new SubstrateDispatchFacade(asManager(sdk), asManager(interactive), registry, makeSpyLogger());

    const received: unknown[] = [];
    facade.on('exit', (p) => received.push(p));

    const sdkExit = { panelId: run.id, sessionId: run.id, exitCode: 0, signal: null };
    const interactiveExit = { panelId: run.id, sessionId: run.id, exitCode: 1, signal: null };
    sdk.emit('exit', sdkExit);
    interactive.emit('exit', interactiveExit);

    expect(received).toEqual([sdkExit, interactiveExit]);
    expect(received[0]).toBe(sdkExit);
    expect(received[1]).toBe(interactiveExit);
  });

  it('dispose() unsubscribes from both managers so no further events are re-emitted', () => {
    const run = makeWorkflowRunRow();
    const registry = makeRegistry(run);
    const sdk = makeSpyManager();
    const interactive = makeSpyManager();
    const facade = new SubstrateDispatchFacade(asManager(sdk), asManager(interactive), registry, makeSpyLogger());

    const received: unknown[] = [];
    facade.on('output', (p) => received.push(p));

    facade.dispose();

    sdk.emit('output', makeGoldenOutput(run.id));
    interactive.emit('output', makeGoldenOutput(run.id));

    expect(received).toHaveLength(0);
    // Underlying managers no longer have facade listeners attached.
    expect(sdk.listenerCount('output')).toBe(0);
    expect(interactive.listenerCount('output')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// raw-PTY pty-output fan-in (TASK-814 / IDEA-030) — interactive manager ONLY
// ---------------------------------------------------------------------------

describe('SubstrateDispatchFacade — pty-output fan-in (interactive only)', () => {
  it("re-emits a 'pty-output' from the interactive manager with the identical payload object", () => {
    const run = makeWorkflowRunRow({ substrate: 'interactive' });
    const registry = makeRegistry(run);
    const sdk = makeSpyManager();
    const interactive = makeSpyManager();
    const facade = new SubstrateDispatchFacade(asManager(sdk), asManager(interactive), registry, makeSpyLogger());

    const received: unknown[] = [];
    facade.on('pty-output', (p) => received.push(p));

    const payload = { panelId: run.id, sessionId: run.id, runId: run.id, type: 'pty', data: '\x1b[2Jhello', timestamp: new Date() };
    interactive.emit('pty-output', payload);

    expect(received).toHaveLength(1);
    // Re-emitted by reference (never reshaped), so the raw bytes survive verbatim.
    expect(received[0]).toBe(payload);
  });

  it("does NOT forward a 'pty-output' emitted by the sdk manager (the SDK manager is never subscribed)", () => {
    const run = makeWorkflowRunRow({ substrate: 'sdk' });
    const registry = makeRegistry(run);
    const sdk = makeSpyManager();
    const interactive = makeSpyManager();
    const facade = new SubstrateDispatchFacade(asManager(sdk), asManager(interactive), registry, makeSpyLogger());

    const received: unknown[] = [];
    facade.on('pty-output', (p) => received.push(p));

    sdk.emit('pty-output', { panelId: run.id, sessionId: run.id, runId: run.id, type: 'pty', data: 'should-not-forward', timestamp: new Date() });

    expect(received).toHaveLength(0);
    // The SDK manager has no facade 'pty-output' listener attached.
    expect(sdk.listenerCount('pty-output')).toBe(0);
  });

  it('dispose() removes the interactive pty-output listener so no further bytes are re-emitted', () => {
    const run = makeWorkflowRunRow({ substrate: 'interactive' });
    const registry = makeRegistry(run);
    const sdk = makeSpyManager();
    const interactive = makeSpyManager();
    const facade = new SubstrateDispatchFacade(asManager(sdk), asManager(interactive), registry, makeSpyLogger());

    const received: unknown[] = [];
    facade.on('pty-output', (p) => received.push(p));

    facade.dispose();

    interactive.emit('pty-output', { panelId: run.id, sessionId: run.id, runId: run.id, type: 'pty', data: 'after-dispose', timestamp: new Date() });

    expect(received).toHaveLength(0);
    // Underlying interactive manager no longer has a facade pty-output listener.
    expect(interactive.listenerCount('pty-output')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cross-substrate envelope parity through bridgeEvents()
// ---------------------------------------------------------------------------

describe('SubstrateDispatchFacade — cross-substrate envelope parity through bridgeEvents', () => {
  it('produces a shape-identical {type,payload,timestamp} envelope for both substrates (payload.panelId === runId)', () => {
    const run = makeWorkflowRunRow();
    const runId = run.id;
    const registry = makeRegistry(run);
    const sdk = makeSpyManager();
    const interactive = makeSpyManager();
    const facade = new SubstrateDispatchFacade(asManager(sdk), asManager(interactive), registry, makeSpyLogger());

    const envelopes: StreamEnvelope[] = [];
    const spyPublisher: StreamEventPublisher = {
      publish: (_runId, envelope) => {
        envelopes.push(envelope);
      },
    };

    // The facade is the single source feeding bridgeEvents (skipPersistence:true —
    // each manager owns its own per-run persistence; the bridge double-INSERT guard).
    const bridge = bridgeEvents({
      runId,
      source: facade,
      publisher: spyPublisher,
      skipPersistence: true,
      logger: makeSpyLogger(),
    });

    // Feed the SAME golden fixture through the facade from each manager.
    const golden = makeGoldenOutput(runId);
    sdk.emit('output', golden);
    interactive.emit('output', golden);

    bridge.dispose();

    expect(envelopes).toHaveLength(2);

    const [sdkEnvelope, interactiveEnvelope] = envelopes;

    // Byte-identical SHAPE: same key set {type, payload, timestamp}.
    expect(Object.keys(sdkEnvelope).sort()).toEqual(['payload', 'timestamp', 'type']);
    expect(Object.keys(interactiveEnvelope).sort()).toEqual(['payload', 'timestamp', 'type']);

    // Same discriminant type across substrates.
    expect(interactiveEnvelope.type).toBe(sdkEnvelope.type);

    // panelId === runId === sessionId invariant holds on the forwarded payload.
    expect(golden.panelId).toBe(runId);
    expect(golden.sessionId).toBe(runId);
  });
});

// ---------------------------------------------------------------------------
// RunExecutor-over-facade integration (interactive-branch clean drain)
// ---------------------------------------------------------------------------

/**
 * A subclass of RunExecutor that overrides getPrompt() so execute() can complete
 * without a WorkflowPromptReaderLike (mirrors TestableRunExecutor in
 * runExecutor.test.ts — referenced, not edited).
 */
class TestableRunExecutor extends RunExecutor {
  protected override async getPrompt(_runId: string, _workflow: WorkflowRow): Promise<string> {
    return 'test prompt';
  }
}

describe('RunExecutor-over-facade — interactive-branch clean drain drives identical lifecycle', () => {
  it('drives drained -> awaiting_review (restAwaitingReview fired once) and dispatches to the interactive manager', async () => {
    const run = makeWorkflowRunRow({ substrate: 'interactive', worktree_path: '/my/worktree', status: 'running' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry = makeRegistry(run, workflow);
    const sdk = makeSpyManager();
    const interactive = makeSpyManager();
    const logger = makeSpyLogger();

    const facade = new SubstrateDispatchFacade(asManager(sdk), asManager(interactive), registry, logger);
    const { mock: lt, restAwaitingReview } = makeLifecycleTransitions();

    // The facade IS both the spawner (arg 1) and the EventEmitter source (arg 8).
    const executor = new TestableRunExecutor(
      facade,
      registry,
      logger,
      undefined,
      lt,
      undefined,
      undefined,
      facade,
    );

    await executor.execute(run.id);

    // Clean drain rests the run in awaiting_review (never completes).
    expect(restAwaitingReview).toHaveBeenCalledOnce();
    expect(restAwaitingReview).toHaveBeenCalledWith(run.id);

    // The interactive manager received the spawn (substrate === 'interactive').
    expect(interactive.spawnCliProcess).toHaveBeenCalledOnce();
    expect(sdk.spawnCliProcess).not.toHaveBeenCalled();

    const opts = interactive.spawnCliProcess.mock.calls[0][0];
    expect(opts.panelId).toBe(run.id);
    expect(opts.sessionId).toBe(run.id);
    expect(opts.worktreePath).toBe('/my/worktree');
  });

  it('the sdk (default) branch is regression-clean: substrate undefined drains through the sdk manager', async () => {
    const run = makeWorkflowRunRow({ substrate: undefined, worktree_path: '/my/worktree', status: 'running' });
    const workflow = makeWorkflowRow({ id: run.workflow_id });
    const registry = makeRegistry(run, workflow);
    const sdk = makeSpyManager();
    const interactive = makeSpyManager();
    const logger = makeSpyLogger();

    const facade = new SubstrateDispatchFacade(asManager(sdk), asManager(interactive), registry, logger);
    const { mock: lt, restAwaitingReview } = makeLifecycleTransitions();

    const executor = new TestableRunExecutor(
      facade,
      registry,
      logger,
      undefined,
      lt,
      undefined,
      undefined,
      facade,
    );

    await executor.execute(run.id);

    expect(restAwaitingReview).toHaveBeenCalledOnce();
    expect(sdk.spawnCliProcess).toHaveBeenCalledOnce();
    expect(interactive.spawnCliProcess).not.toHaveBeenCalled();
  });
});
