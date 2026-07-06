import { describe, it, expect, vi, afterEach } from 'vitest';
import { DefaultProgrammaticRunner } from '../defaultProgrammaticRunner';
import type { StepReporter } from '../programmaticRunHost';
import type { HumanGateResolver } from '../humanGate';
import { MonitorRegistry, type MonitorContext, type MonitorSession } from '../monitor';
import type { ClaudeSpawnerLike, ClaudeSpawnerOptions, ProgrammaticRunContext } from '../../runExecutor';
import type { FanOutDriver } from '../types';
import type { SystemicPauseResolver } from '../systemicPauseGate';
import type { WorkflowDefinition, WorkflowRow, WorkflowRunRow } from '../../../../../shared/types/workflows';

function makeSpawner(impl?: () => Promise<void>): ClaudeSpawnerLike {
  return {
    spawnCliProcess: vi.fn<(o: ClaudeSpawnerOptions) => Promise<void>>(impl ?? (() => Promise.resolve())),
    abort: vi.fn<(p: string) => Promise<void>>().mockResolvedValue(undefined),
  };
}
const reporter: StepReporter = { report: vi.fn() };
function gateOf(d: 'approve' | 'reject' | 'revise'): HumanGateResolver {
  return { resolve: vi.fn().mockResolvedValue(d) };
}

/** Build a ProgrammaticRunContext whose workflow.spec_json encodes `def`. */
function ctxFor(def: WorkflowDefinition, opts?: { batchId?: string | null }): ProgrammaticRunContext {
  const workflow: WorkflowRow = {
    id: 'wf',
    project_id: 1,
    name: 'custom',
    workflow_path: null,
    permission_mode: 'default',
    spec_json: JSON.stringify(def),
    created_at: 'now',
  };
  const run: WorkflowRunRow = {
    id: 'run-1',
    workflow_id: 'wf',
    project_id: 1,
    status: 'running',
    permission_mode_snapshot: 'auto',
    worktree_path: '/wt',
    branch_name: null,
    created_at: 'now',
    updated_at: 'now',
    ...(opts?.batchId !== undefined ? { batch_id: opts.batchId } : {}),
  };
  return {
    runId: 'run-1',
    panelId: 'run-1',
    sessionId: 'run-1',
    worktreePath: '/wt',
    run,
    workflow,
    // Session-resolved mode (permission-mode redesign §3c#2); RunExecutor
    // computes this in production, here supplied directly for the runner.
    agentPermissionMode: 'auto',
    signal: new AbortController().signal,
    injectEvent: () => {},
  };
}

function oneStepDef(): WorkflowDefinition {
  return { id: 'd', phases: [{ id: 'p', label: 'P', color: '#3b6dd6', steps: [{ id: 'a', name: 'A', agent: 'executor', mcps: [], retries: 0 }] }] };
}
function gateDef(): WorkflowDefinition {
  return { id: 'd', phases: [{ id: 'p', label: 'P', color: '#3b6dd6', steps: [{ id: 'g', name: 'Gate', agent: 'human', mcps: [], retries: 0, human: true }] }] };
}
/** A def whose single step declares a fanOut over 'tasks' (exercises the driver seam). */
function fanOutDef(): WorkflowDefinition {
  return {
    id: 'd',
    phases: [
      {
        id: 'p',
        label: 'P',
        color: '#3b6dd6',
        steps: [
          {
            id: 'a',
            name: 'A',
            agent: 'executor',
            mcps: [],
            retries: 0,
            fanOut: { over: 'tasks', inner: [{ id: 'impl', agent: 'executor', name: 'Impl' }] },
          },
        ],
      },
    ],
  };
}

describe('DefaultProgrammaticRunner', () => {
  afterEach(() => {
    MonitorRegistry._resetForTesting();
  });

  it('resolves (rests the run) when the controller completes', async () => {
    const runner = new DefaultProgrammaticRunner({ spawner: makeSpawner(), reporter, gate: gateOf('approve') });
    await expect(runner.run(ctxFor(oneStepDef()))).resolves.toBeUndefined();
  });

  it('throws when a required step fails and the escalation is rejected (so RunExecutor marks the run failed)', async () => {
    // No monitor ⇒ the host's default triage 'escalate's the exhausted failure to a
    // human gate; a REJECT verdict makes it a terminal failure → the runner throws.
    const runner = new DefaultProgrammaticRunner({
      spawner: makeSpawner(() => Promise.reject(new Error('boom'))),
      reporter,
      gate: gateOf('reject'),
    });
    await expect(runner.run(ctxFor(oneStepDef()))).rejects.toThrow("failed at step 'a'");
  });

  it('resolves (skips the step + advances) when a required step fails and the escalation is approved', async () => {
    // No monitor ⇒ default 'escalate'; an APPROVE verdict accepts the failure, skips
    // the step, and the (single-step) run completes → the runner resolves.
    const runner = new DefaultProgrammaticRunner({
      spawner: makeSpawner(() => Promise.reject(new Error('boom'))),
      reporter,
      gate: gateOf('approve'),
    });
    await expect(runner.run(ctxFor(oneStepDef()))).resolves.toBeUndefined();
  });

  it('resolves (does NOT throw) when a human gate is rejected — a terminal human decision, not a failure', async () => {
    const runner = new DefaultProgrammaticRunner({ spawner: makeSpawner(), reporter, gate: gateOf('reject') });
    await expect(runner.run(ctxFor(gateDef()))).resolves.toBeUndefined();
  });

  it('threads ctx.agentPermissionMode (the session-resolved mode) into each step spawn, NOT the snapshot', async () => {
    // ctx.run.permission_mode_snapshot is 'auto' (the demoted audit value), but
    // the runner must spawn under ctx.agentPermissionMode (the session authority).
    const spawner = makeSpawner();
    const runner = new DefaultProgrammaticRunner({ spawner, reporter, gate: gateOf('approve') });
    const ctx: ProgrammaticRunContext = { ...ctxFor(oneStepDef()), agentPermissionMode: 'dontAsk' };

    await runner.run(ctx);

    const passed = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions;
    expect(passed.agentPermissionMode).toBe('dontAsk');
  });

  it('throws when the run has no resolvable workflow definition', async () => {
    const ctx = ctxFor(oneStepDef());
    const badCtx: ProgrammaticRunContext = {
      ...ctx,
      workflow: { ...ctx.workflow, name: 'not-a-builtin', spec_json: 'not json' },
    };
    const runner = new DefaultProgrammaticRunner({ spawner: makeSpawner(), reporter, gate: gateOf('approve') });
    await expect(runner.run(badCtx)).rejects.toThrow('no resolvable workflow definition');
  });

  it('builds the monitor from the factory, registers it, and KEEPS it registered after the walk (close-out owns disposal)', async () => {
    let observed: MonitorContext | undefined;
    let registeredDuringRun = false;
    const monitor: MonitorSession = {
      triage: vi.fn().mockResolvedValue({ decision: 'escalate', rationale: '' }),
      answer: vi.fn().mockResolvedValue(''),
    };
    const monitorFactory = (ctx: MonitorContext): MonitorSession => {
      observed = ctx;
      return monitor;
    };
    // A spawner that observes the monitor is registered WHILE the run is executing.
    const spawner = makeSpawner(async () => {
      registeredDuringRun = MonitorRegistry.getInstance().get('run-1') === monitor;
    });
    const runner = new DefaultProgrammaticRunner({ spawner, reporter, gate: gateOf('approve'), monitorFactory });

    await expect(runner.run(ctxFor(oneStepDef()))).resolves.toBeUndefined();

    // The factory was handed the run's MonitorContext.
    expect(observed).toEqual({ runId: 'run-1', projectId: 1, workflowName: 'custom', worktreePath: '/wt' });
    // It was registered during the walk AND stays registered after — the monitor must
    // remain reachable so the user can chat with it while the run rests in
    // awaiting_review. It is unregistered only at terminal close-out (merge / createPr
    // / dismiss), which the runner does NOT drive.
    expect(registeredDuringRun).toBe(true);
    expect(MonitorRegistry.getInstance().get('run-1')).toBe(monitor);
  });

  it('keeps the monitor registered even when the run throws (chat-about-the-failure; close-out disposes)', async () => {
    const monitor: MonitorSession = {
      triage: vi.fn().mockResolvedValue({ decision: 'fail', rationale: '' }),
      answer: vi.fn().mockResolvedValue(''),
    };
    const runner = new DefaultProgrammaticRunner({
      spawner: makeSpawner(() => Promise.reject(new Error('boom'))),
      reporter,
      gate: gateOf('reject'),
      monitorFactory: () => monitor,
    });

    // The monitor triages 'fail' → the host DOWNGRADES it to 'escalate' (the
    // supervisor-role redesign: ending a run is the human's call) → the human gate
    // rejects → the controller fails the run → the runner throws. The failed run
    // keeps its worktree, so the monitor stays registered for at-rest chat
    // ("why did it fail?") until the user dismisses it.
    await expect(runner.run(ctxFor(oneStepDef()))).rejects.toThrow("failed at step 'a'");
    expect(MonitorRegistry.getInstance().get('run-1')).toBe(monitor);
  });

  it('does NOT register a monitor when no factory is provided (defensive wiring; production always provides one)', async () => {
    const runner = new DefaultProgrammaticRunner({ spawner: makeSpawner(), reporter, gate: gateOf('approve') });
    await expect(runner.run(ctxFor(oneStepDef()))).resolves.toBeUndefined();
    expect(MonitorRegistry.getInstance().get('run-1')).toBeUndefined();
  });

  // ── Fan-out driver wiring (generalize-parallel-fan-out, commit #5) ──────────
  it('builds a fan-out driver from the factory for a run WITH a batch_id and threads it into the host', async () => {
    // A spy driver: resolveItems returns one item so the controller actually fans
    // out, proving the built driver reached the host (host.fanOut !== undefined).
    const driver: FanOutDriver = {
      resolveItems: vi.fn(() => ['task-1']),
      driveLane: vi.fn(),
    };
    const fanOutDriverFactory = vi.fn<(ctx: { runId: string; batchId: string | null }) => FanOutDriver | undefined>(
      () => driver,
    );

    const runner = new DefaultProgrammaticRunner({
      spawner: makeSpawner(),
      reporter,
      gate: gateOf('approve'),
      fanOutDriverFactory,
    });

    await expect(runner.run(ctxFor(fanOutDef(), { batchId: 'batch-9' }))).resolves.toBeUndefined();

    // The factory was invoked once with the run's batchId (built ONLY because the
    // run carries a non-empty batch_id).
    expect(fanOutDriverFactory).toHaveBeenCalledTimes(1);
    expect(fanOutDriverFactory).toHaveBeenCalledWith({ runId: 'run-1', batchId: 'batch-9' });
    // And the built driver was threaded into the host: the controller resolved the
    // item set + drove its lane through it (proves host.fanOut was set).
    expect(driver.resolveItems).toHaveBeenCalledWith('run-1', 'tasks');
    expect(driver.driveLane).toHaveBeenCalled();
  });

  it('does NOT build a fan-out driver for a run with a null batch_id (no host-driven fan-out)', async () => {
    const fanOutDriverFactory = vi.fn<(ctx: { runId: string; batchId: string | null }) => FanOutDriver | undefined>(
      () => ({ resolveItems: vi.fn(() => ['x']), driveLane: vi.fn() }),
    );

    const runner = new DefaultProgrammaticRunner({
      spawner: makeSpawner(),
      reporter,
      gate: gateOf('approve'),
      fanOutDriverFactory,
    });

    // The run has no batch_id ⇒ the factory is never invoked ⇒ host.fanOut is
    // undefined ⇒ the fanOut step runs as a normal single agent step.
    await expect(runner.run(ctxFor(fanOutDef(), { batchId: null }))).resolves.toBeUndefined();
    expect(fanOutDriverFactory).not.toHaveBeenCalled();
  });

  it('does NOT build a fan-out driver when the run carries no batch_id at all', async () => {
    const fanOutDriverFactory = vi.fn<(ctx: { runId: string; batchId: string | null }) => FanOutDriver | undefined>(
      () => ({ resolveItems: vi.fn(() => []), driveLane: vi.fn() }),
    );
    const runner = new DefaultProgrammaticRunner({
      spawner: makeSpawner(),
      reporter,
      gate: gateOf('approve'),
      fanOutDriverFactory,
    });

    await expect(runner.run(ctxFor(oneStepDef()))).resolves.toBeUndefined();
    expect(fanOutDriverFactory).not.toHaveBeenCalled();
  });

  // ── Systemic-pause gate wiring (the 2026-07-06 planner-incident fix) ────────
  it('threads the systemicGate into the host so a systemic step failure routes through it', async () => {
    // A spawner whose turn dies on a usage-limit error ⇒ SpawnStepRunner stamps the
    // result systemic:true ⇒ the controller consults host.awaitSystemicPause, which
    // delegates to the threaded gate. 'giveup' falls through to the normal failure
    // path; a no-monitor 'escalate' + an APPROVE gate skips the step and the run
    // completes (proving the gate was reached AND that giveup is byte-identical).
    const awaitClear = vi.fn<(req: unknown) => Promise<'retry' | 'giveup' | 'canceled'>>().mockResolvedValue('giveup');
    const systemicGate: SystemicPauseResolver = { awaitClear };

    const runner = new DefaultProgrammaticRunner({
      spawner: makeSpawner(() => Promise.reject(new Error('Claude AI usage limit reached'))),
      reporter,
      gate: gateOf('approve'),
      systemicGate,
    });

    await expect(runner.run(ctxFor(oneStepDef()))).resolves.toBeUndefined();

    expect(awaitClear).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        projectId: 1,
        step: expect.objectContaining({ id: 'a' }),
        error: expect.stringContaining('usage limit'),
      }),
    );
  });

  // ── Sprint task-scope grounding (2026-06-22) ────────────────────────────────
  it('threads the seedTasksProvider scope into the step prompt for a sprint run', async () => {
    const spawner = makeSpawner();
    const seedTasksProvider = vi.fn((batchId: string) => `## TASK-001: Init Vite\n\nScaffold for ${batchId}.`);

    const runner = new DefaultProgrammaticRunner({
      spawner,
      reporter,
      gate: gateOf('approve'),
      seedTasksProvider,
    });

    await expect(runner.run(ctxFor(oneStepDef(), { batchId: 'batch-7' }))).resolves.toBeUndefined();

    // Resolved ONCE from the run's batch_id, and the body reached the step prompt.
    expect(seedTasksProvider).toHaveBeenCalledWith('batch-7');
    const prompt = vi.mocked(spawner.spawnCliProcess).mock.calls[0][0].prompt;
    expect(prompt).toContain('# Sprint tasks');
    expect(prompt).toContain('## TASK-001: Init Vite');
    expect(prompt).toContain('Scaffold for batch-7.');
  });

  it('does NOT call the provider or inject a task block for a non-sprint run', async () => {
    const spawner = makeSpawner();
    const seedTasksProvider = vi.fn((b: string) => `scope ${b}`);

    const runner = new DefaultProgrammaticRunner({
      spawner,
      reporter,
      gate: gateOf('approve'),
      seedTasksProvider,
    });

    await expect(runner.run(ctxFor(oneStepDef()))).resolves.toBeUndefined(); // no batch_id

    expect(seedTasksProvider).not.toHaveBeenCalled();
    expect(vi.mocked(spawner.spawnCliProcess).mock.calls[0][0].prompt).not.toContain('# Sprint tasks');
  });

  it('injects no task block when the provider returns null', async () => {
    const spawner = makeSpawner();
    const runner = new DefaultProgrammaticRunner({
      spawner,
      reporter,
      gate: gateOf('approve'),
      seedTasksProvider: () => null,
    });

    await expect(runner.run(ctxFor(oneStepDef(), { batchId: 'batch-7' }))).resolves.toBeUndefined();
    expect(vi.mocked(spawner.spawnCliProcess).mock.calls[0][0].prompt).not.toContain('# Sprint tasks');
  });
});
