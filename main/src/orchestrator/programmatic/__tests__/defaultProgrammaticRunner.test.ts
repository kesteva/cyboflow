import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DefaultProgrammaticRunner,
  readSelectedFindingsBlock,
  readGateResolutionNote,
} from '../defaultProgrammaticRunner';
import type { DatabaseLike } from '../../types';
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
    tuning_level: 'standard',
    runtime_mix: 'claude',
    created_at: 'now',
    archived_at: null,
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
/**
 * A def shaped like `ship`: a plain step BEFORE a fanOut step. Used to simulate
 * the materialize-batch step's mid-run `batch_id` stamp — the plain step's agent
 * turn flips a fake `readRunBatchId`'s return value, mirroring
 * `cyboflow_create_sprint_batch`'s `UPDATE workflow_runs SET batch_id=...` — and
 * the LATER fanOut step ('execute-tasks') must observe the live stamp.
 */
function shipShapedDef(): WorkflowDefinition {
  return {
    id: 'd',
    phases: [
      {
        id: 'p',
        label: 'P',
        color: '#3b6dd6',
        steps: [
          { id: 'materialize-batch', name: 'Materialize', agent: 'executor', mcps: [], retries: 0 },
          {
            id: 'execute-tasks',
            name: 'Execute',
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

/** A raw-prompt Ship shape: context creates an idea before an optional design step. */
function rawPromptShipDef(): WorkflowDefinition {
  return {
    id: 'd',
    phases: [
      {
        id: 'p',
        label: 'P',
        color: '#3b6dd6',
        steps: [
          { id: 'context', name: 'Context', agent: 'context', mcps: [], retries: 0 },
          { id: 'ui-prototype', name: 'UI prototype', agent: 'ui-prototype', mcps: [], retries: 0 },
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

  it('live-resolves the run-owned idea scope after raw-prompt Ship context creates its idea', async () => {
    let ownedIdeaIds: readonly string[] = [];
    let spawnCount = 0;
    const spawner = makeSpawner(async () => {
      if (spawnCount++ === 0) ownedIdeaIds = ['IDEA-created-during-context'];
    });
    const runOwnedIdeaIdsProvider = vi.fn<(runId: string) => readonly string[]>(() => ownedIdeaIds);
    const runner = new DefaultProgrammaticRunner({
      spawner,
      reporter,
      gate: gateOf('approve'),
      runOwnedIdeaIdsProvider,
    });

    await expect(runner.run(ctxFor(rawPromptShipDef()))).resolves.toBeUndefined();

    expect(runOwnedIdeaIdsProvider).toHaveBeenCalledTimes(2);
    expect(runOwnedIdeaIdsProvider).toHaveBeenCalledWith('run-1');
    const prompts = vi.mocked(spawner.spawnCliProcess).mock.calls.map(([o]) => (o as ClaudeSpawnerOptions).prompt);
    expect(prompts[0]).not.toContain('## Run-owned idea scope');
    expect(prompts[1]).toContain('`IDEA-created-during-context`');
    expect(prompts[1]).not.toContain('cyboflow_list_tasks');
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

  // The WIRING half of dogfood finding 0. The predicate and the SpawnStepRunner
  // option are each unit-tested elsewhere; what broke in production was the SEAM
  // between components that were individually correct, so pin the seam itself:
  // the runner must derive the deny list from THIS run's definition.
  it('derives the step deny list from the run definition — denies the enqueue tool only when the chain owns it', async () => {
    const withVisualVerify: WorkflowDefinition = {
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
              fanOut: {
                over: 'tasks',
                inner: [
                  { id: 'implement', agent: 'executor', name: 'Impl' },
                  { id: 'visual-verify', agent: 'executor', name: 'Visual verify' },
                ],
              },
            },
          ],
        },
      ],
    };

    // A chain WITHOUT a controller-owned visual-verify step (the verify-setup
    // shape): nobody else can enqueue, so the step turn must not be denied.
    const openSpawner = makeSpawner();
    await new DefaultProgrammaticRunner({ spawner: openSpawner, reporter, gate: gateOf('approve') }).run(
      ctxFor(oneStepDef()),
    );
    const openCall = (openSpawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as ClaudeSpawnerOptions;
    expect(openCall.disallowedTools).toEqual([]);

    // A chain WITH one: the controller owns the enqueue, so every step turn is
    // denied (the 2026-07-22 merge-gate hijack this list exists to prevent).
    const deniedSpawner = makeSpawner();
    await new DefaultProgrammaticRunner({
      spawner: deniedSpawner,
      reporter,
      gate: gateOf('approve'),
    }).run(ctxFor(withVisualVerify));
    for (const [passed] of (deniedSpawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls as Array<
      [ClaudeSpawnerOptions]
    >) {
      expect(passed.disallowedTools).toEqual(['mcp__cyboflow__cyboflow_request_verification']);
    }
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
  // Live-resolution follow-up (fixes a confirmed `ship` silent no-op): the driver
  // is now built LAZILY — by a provider the host consults on every `host.fanOut`
  // read — instead of once at construction from a `ctx.run.batch_id` snapshot, so
  // a `batch_id` stamped MID-WALK (ship's materialize-batch step) is honored by
  // the SAME walk. `readRunBatchId` absent ⇒ the provider falls back to the
  // one-shot `ctx.run.batch_id` snapshot (today's pre-fix behavior), which is why
  // most of these cases below still work without wiring it explicitly.
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

    // The factory was invoked once with the run's batchId — memoized after the
    // FIRST successful resolution, so the second `host.fanOut` read inside
    // runFanOut (the driver assignment) does not re-invoke it.
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

    // The run has no batch_id AND it is never stamped mid-walk (single-step def,
    // no readRunBatchId wired) ⇒ the factory is never invoked ⇒ host.fanOut stays
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

  it('does NOT call the factory when readRunBatchId is live-wired but the run never stamps a batch_id', async () => {
    // readRunBatchId is consulted (it is wired) but keeps returning null for the
    // whole walk — never called ⇒ the provider never has a batchId to build from.
    const readRunBatchId = vi.fn((): string | null => null);
    const fanOutDriverFactory = vi.fn<(ctx: { runId: string; batchId: string | null }) => FanOutDriver | undefined>(
      () => ({ resolveItems: vi.fn(() => ['x']), driveLane: vi.fn() }),
    );

    const runner = new DefaultProgrammaticRunner({
      spawner: makeSpawner(),
      reporter,
      gate: gateOf('approve'),
      fanOutDriverFactory,
      readRunBatchId,
    });

    await expect(runner.run(ctxFor(fanOutDef(), { batchId: null }))).resolves.toBeUndefined();

    expect(readRunBatchId).toHaveBeenCalled();
    expect(fanOutDriverFactory).not.toHaveBeenCalled();
  });

  it('memoizes the resolved fan-out driver — readRunBatchId is not re-read once a driver exists', async () => {
    const readRunBatchId = vi.fn((): string | null => 'batch-9');
    const driver: FanOutDriver = { resolveItems: vi.fn(() => ['task-1']), driveLane: vi.fn() };
    const fanOutDriverFactory = vi.fn<(ctx: { runId: string; batchId: string | null }) => FanOutDriver | undefined>(
      () => driver,
    );

    const runner = new DefaultProgrammaticRunner({
      spawner: makeSpawner(),
      reporter,
      gate: gateOf('approve'),
      fanOutDriverFactory,
      readRunBatchId,
    });

    await expect(runner.run(ctxFor(fanOutDef(), { batchId: null }))).resolves.toBeUndefined();

    // The controller reads `host.fanOut` TWICE for one fanOut-step visit (the
    // presence check at the loop head, then the driver read inside runFanOut).
    // Memoization means only the FIRST of those two triggers a live DB read +
    // factory build; the second is a cheap in-memory return.
    expect(readRunBatchId).toHaveBeenCalledTimes(1);
    expect(fanOutDriverFactory).toHaveBeenCalledTimes(1);
  });

  it('resolves a LIVE fan-out driver mid-walk when batch_id is stamped after run start (the ship regression)', async () => {
    // Simulates `ship`: batch_id starts null (no seeded sprint at run start) and
    // is stamped by an EARLIER step's agent turn (materialize-batch, standing in
    // for the cyboflow_create_sprint_batch MCP tool's mid-run UPDATE) BEFORE the
    // LATER fanOut step (execute-tasks) is reached — all within the SAME walk.
    let liveBatchId: string | null = null;
    const readRunBatchId = vi.fn((runId: string): string | null => {
      expect(runId).toBe('run-1');
      return liveBatchId;
    });
    const driver: FanOutDriver = {
      resolveItems: vi.fn(() => ['task-1']),
      driveLane: vi.fn(),
    };
    const fanOutDriverFactory = vi.fn<(ctx: { runId: string; batchId: string | null }) => FanOutDriver | undefined>(
      () => driver,
    );
    // The 'materialize-batch' step's agent turn stamps batch_id, mirroring the
    // MCP tool's mid-run UPDATE; every OTHER step (including the fanOut step's own
    // inner spawn) is a no-op.
    const spawner = makeSpawner(async () => {
      liveBatchId = 'batch-ship';
    });

    const runner = new DefaultProgrammaticRunner({
      spawner,
      reporter,
      gate: gateOf('approve'),
      fanOutDriverFactory,
      readRunBatchId,
    });

    // ctx.run.batch_id is null — the run-start snapshot RunExecutor took BEFORE
    // materialize-batch ran — proving the driver came from the LIVE re-read, not
    // a stale snapshot (a one-shot resolution would see null forever and the
    // fanOut step would silently degrade to a single agent step).
    await expect(runner.run(ctxFor(shipShapedDef(), { batchId: null }))).resolves.toBeUndefined();

    expect(fanOutDriverFactory).toHaveBeenCalledTimes(1);
    expect(fanOutDriverFactory).toHaveBeenCalledWith({ runId: 'run-1', batchId: 'batch-ship' });
    expect(driver.resolveItems).toHaveBeenCalledWith('run-1', 'tasks');
    expect(driver.driveLane).toHaveBeenCalled();
  });

  it('grounds step prompts with the sprint task scope AFTER the mid-run batch_id stamp (the ship task-scope regression)', async () => {
    // Companion to the driver regression above: the SAME mid-run stamp must also
    // be observed by the taskScope thunk, or ship's per-task inner spawns carry
    // only the opaque item id with no `# Sprint tasks` grounding block (a
    // snapshot-gated taskScope was decided once from the null run-start batch_id).
    let liveBatchId: string | null = null;
    const readRunBatchId = vi.fn((): string | null => liveBatchId);
    const driver: FanOutDriver = { resolveItems: vi.fn(() => ['task-1']), driveLane: vi.fn() };
    const fanOutDriverFactory = vi.fn<(ctx: { runId: string; batchId: string | null }) => FanOutDriver | undefined>(
      () => driver,
    );
    const seedTasksProvider = vi.fn((batchId: string) => `## TASK-001: Ship it\n\nSeeded from ${batchId}.`);
    const spawner = makeSpawner(async () => {
      liveBatchId = 'batch-ship';
    });

    const runner = new DefaultProgrammaticRunner({
      spawner,
      reporter,
      gate: gateOf('approve'),
      fanOutDriverFactory,
      readRunBatchId,
      seedTasksProvider,
    });

    await expect(runner.run(ctxFor(shipShapedDef(), { batchId: null }))).resolves.toBeUndefined();

    const prompts = vi
      .mocked(spawner.spawnCliProcess)
      .mock.calls.map(([o]) => (o as ClaudeSpawnerOptions).prompt);
    const materializePrompt = prompts.find((p) => p.includes('id: `materialize-batch`'));
    const innerPrompt = prompts.find((p) => p.includes('id: `impl`'));
    expect(materializePrompt).toBeDefined();
    expect(innerPrompt).toBeDefined();

    // materialize-batch spawned BEFORE the stamp — no batch yet, no scope block.
    expect(materializePrompt).not.toContain('# Sprint tasks');
    // The fanOut inner spawn came AFTER the stamp — grounded with the live block.
    expect(seedTasksProvider).toHaveBeenCalledWith('batch-ship');
    expect(innerPrompt).toContain('# Sprint tasks');
    expect(innerPrompt).toContain('Seeded from batch-ship.');
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
  // ── Lane-triage wiring (autonomous lane rescue) ────────────────────────────
  // The runner is the seam that RUN-BINDS the composition root's lane-triage
  // collaborators onto the host, so this asserts the plumbing end to end:
  // a failing lane → the monitor's brain → the task reader → the body edit →
  // the audit sink → the rescued re-drive, all carrying THIS run's id.
  it('run-binds the lane-triage task reader, body writer, and finding sink onto the host', async () => {
    const triageLane = vi.fn().mockResolvedValue({
      verdict: 'adjust_and_retry',
      targetStepId: 'impl',
      guidance: 'stub the network layer',
      reason: 'the AC assumes an API that does not exist (src/x.ts:12)',
      taskBody: '## Narrowed body',
    });
    const monitor: MonitorSession = { triage: vi.fn(), answer: vi.fn().mockResolvedValue(''), triageLane };
    const driver: FanOutDriver = { resolveItems: vi.fn(() => ['task-1']), driveLane: vi.fn() };

    const laneTriageTaskReader = vi.fn(() => ({
      taskRef: 'TASK-014',
      taskTitle: 'Wire the thing',
      taskBody: '## Old body',
    }));
    const laneTriageAdjustTask = vi.fn().mockResolvedValue({ ok: true });
    const laneTriageFindingSink = vi.fn().mockResolvedValue(undefined);

    // The lane's only inner step fails ONCE (exhausting it — no declared
    // loopback), then succeeds on the rescued traversal.
    let impl = 0;
    const spawner = makeSpawner(async () => {
      impl += 1;
      if (impl === 1) throw new Error('tsc: 4 errors');
    });

    const runner = new DefaultProgrammaticRunner({
      spawner,
      reporter,
      gate: gateOf('approve'),
      monitorFactory: () => monitor,
      fanOutDriverFactory: () => driver,
      laneTriageTaskReader,
      laneTriageAdjustTask,
      laneTriageFindingSink,
    });

    await expect(runner.run(ctxFor(fanOutDef(), { batchId: 'batch-9' }))).resolves.toBeUndefined();

    // Enrichment: the reader is called with THIS run's id + the fan-out item id.
    expect(laneTriageTaskReader).toHaveBeenCalledWith('run-1', 'task-1');
    // The brain saw the enriched request, not the controller's bare facts.
    expect(triageLane).toHaveBeenCalledWith(
      expect.objectContaining({ taskRef: 'TASK-014', taskBody: '## Old body', failureKind: 'inner-step' }),
      expect.anything(),
    );
    // The adjust + the audit note both carry the bound runId.
    expect(laneTriageAdjustTask).toHaveBeenCalledWith('run-1', {
      taskRef: 'TASK-014',
      body: '## Narrowed body',
    });
    expect(laneTriageFindingSink).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ title: 'Monitor rescued TASK-014 (inner-step)' }),
    );
    // And the lane actually re-ran and integrated rather than settling failed.
    expect(impl).toBe(2);
    expect(vi.mocked(driver.driveLane).mock.calls.some(([a]) => a.status === 'integrated')).toBe(true);
  });

  it('gives up (lane settles failed) when the lane-triage deps are not wired', async () => {
    const triageLane = vi.fn();
    const monitor: MonitorSession = { triage: vi.fn(), answer: vi.fn().mockResolvedValue(''), triageLane };
    const driver: FanOutDriver = { resolveItems: vi.fn(() => ['task-1']), driveLane: vi.fn() };
    const runner = new DefaultProgrammaticRunner({
      spawner: makeSpawner(() => Promise.reject(new Error('boom'))),
      reporter,
      gate: gateOf('approve'),
      monitorFactory: () => monitor,
      fanOutDriverFactory: () => driver,
      // No laneTriage* deps — but the monitor CAN triage, so the consult still
      // happens; it simply runs without task facts.
    });

    await expect(runner.run(ctxFor(fanOutDef(), { batchId: 'batch-9' }))).resolves.toBeUndefined();

    expect(triageLane).toHaveBeenCalledWith(
      expect.objectContaining({ taskRef: 'task-1', taskTitle: '', taskBody: '' }),
      expect.anything(),
    );
    expect(vi.mocked(driver.driveLane).mock.calls.some(([a]) => a.status === 'failed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readSelectedFindingsBlock — the programmatic half of compound's seeded branch
// (survey D C1). Mirrors RunExecutor.buildSelectedFindingsBlock's ordering and
// per-finding shape; a programmatic step turn has no main prompt to prepend to.
// ---------------------------------------------------------------------------

describe('readSelectedFindingsBlock', () => {
  interface FakeFinding {
    id: string;
    title: string;
    body: string | null;
    severity: null;
    priority: 'P0' | 'P1' | 'P2' | null;
    source: string | null;
    proposedTarget: 'backlog' | 'docs' | 'prompt' | 'fix' | null;
    suggestedFix: string | null;
    locations: Array<{ path: string; line?: number }> | null;
  }

  function finding(p: Partial<FakeFinding> & { id: string }): FakeFinding {
    return {
      title: p.id,
      body: null,
      severity: null,
      priority: null,
      source: null,
      proposedTarget: null,
      suggestedFix: null,
      locations: null,
      ...p,
    };
  }

  /** A DatabaseLike whose review_items reads resolve out of `rows`. */
  function dbWith(rows: Record<string, FakeFinding>): DatabaseLike {
    return {
      prepare: (sql: string) => ({
        get: (...args: unknown[]) => {
          // selectFindingForSeed gates on hasReviewItemsTable first.
          if (sql.includes('sqlite_master')) return { name: 'review_items' };
          if (!sql.includes('review_items')) return undefined;
          const row = rows[String(args[0])];
          if (!row) return undefined;
          return {
            id: row.id,
            title: row.title,
            body: row.body,
            severity: row.severity,
            priority: row.priority,
            source: row.source,
            payloadJson: JSON.stringify({
              proposedTarget: row.proposedTarget,
              suggestedFix: row.suggestedFix,
              locations: row.locations,
            }),
          };
        },
        all: () => [],
        run: () => ({ changes: 0 }),
      }),
      transaction: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => fn(...a),
    } as unknown as DatabaseLike;
  }

  it('renders the directive + one section per resolved finding', () => {
    const db = dbWith({
      a: finding({ id: 'a', title: 'Null deref', body: 'It throws.', priority: 'P1', source: 'agent:code-review', proposedTarget: 'fix', suggestedFix: 'Guard it.', locations: [{ path: 'src/a.ts', line: 12 }] }),
    });
    const out = readSelectedFindingsBlock(db, JSON.stringify(['a']));
    expect(out).toBeDefined();
    expect(out).toContain('Act ONLY on these findings, in the order listed.');
    expect(out).toContain('## P1 Null deref');
    expect(out).toContain('Target: quick · Source: agent:code-review · id: `a`');
    expect(out).toContain('It throws.');
    expect(out).toContain('### Suggested fix\nGuard it.');
    expect(out).toContain('- src/a.ts:12');
  });

  it('orders by priority (null LAST) then bucket', () => {
    const db = dbWith({
      lo: finding({ id: 'lo', title: 'Unprioritized', priority: null, proposedTarget: 'fix' }),
      p2doc: finding({ id: 'p2doc', title: 'P2 doc', priority: 'P2', proposedTarget: 'docs' }),
      p0: finding({ id: 'p0', title: 'P0 urgent', priority: 'P0', proposedTarget: 'backlog' }),
      p2fix: finding({ id: 'p2fix', title: 'P2 fix', priority: 'P2', proposedTarget: 'fix' }),
    });
    const out = readSelectedFindingsBlock(db, JSON.stringify(['lo', 'p2doc', 'p0', 'p2fix'])) ?? '';
    const order = ['P0 urgent', 'P2 fix', 'P2 doc', 'Unprioritized'].map((t) => out.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it('is fail-soft on every miss', () => {
    const db = dbWith({ a: finding({ id: 'a' }) });
    expect(readSelectedFindingsBlock(db, null)).toBeUndefined();
    expect(readSelectedFindingsBlock(db, '')).toBeUndefined();
    expect(readSelectedFindingsBlock(db, 'not json')).toBeUndefined();
    expect(readSelectedFindingsBlock(db, '{"not":"an array"}')).toBeUndefined();
    expect(readSelectedFindingsBlock(db, '[]')).toBeUndefined();
    // Every id unresolvable ⇒ undefined, not an empty block.
    expect(readSelectedFindingsBlock(db, JSON.stringify(['gone']))).toBeUndefined();
    // One resolvable among misses still renders.
    expect(readSelectedFindingsBlock(db, JSON.stringify(['gone', 'a']))).toContain('## — a');
  });

  it('survives a throwing read for one id without sinking the block', () => {
    const base = dbWith({ ok: finding({ id: 'ok', title: 'Fine' }) });
    const db = {
      ...base,
      prepare: (sql: string) => {
        const stmt = base.prepare(sql);
        return {
          ...stmt,
          get: (...args: unknown[]) => {
            if (args[0] === 'boom') throw new Error('db exploded');
            return stmt.get(...args);
          },
        };
      },
    } as unknown as DatabaseLike;
    expect(readSelectedFindingsBlock(db, JSON.stringify(['boom', 'ok']))).toContain('Fine');
  });
});

describe('readGateResolutionNote', () => {
  /** A DatabaseLike whose single resolved gate row carries `resolution`. */
  function dbWithResolution(resolution: string | null): DatabaseLike {
    return {
      prepare: () => ({
        get: () => ({ resolution }),
        all: () => [],
        run: () => ({ changes: 0 }),
      }),
    } as unknown as DatabaseLike;
  }
  const noteOf = (resolution: string | null): string | undefined =>
    readGateResolutionNote(dbWithResolution(resolution), 'run-1', 'approve-design');

  it('returns the NOTE of a prefixed resolution, verdict words in it and all', () => {
    // The human's own words reach the re-run through this reader, so a note that
    // happens to contain 'rejects' must survive verbatim rather than be dropped
    // or mistaken for the verdict.
    expect(noteOf('revise: only AR-2 matters, drop AR-11')).toBe('only AR-2 matters, drop AR-11');
    expect(noteOf('revise: the architecture rejects empty input')).toBe(
      'the architecture rejects empty input',
    );
    expect(noteOf('approve[no-findings]: ship it')).toBe('ship it');
  });

  it('returns undefined for a bare verdict (nothing to render as guidance)', () => {
    expect(noteOf('revise')).toBeUndefined();
    expect(noteOf('approve')).toBeUndefined();
    expect(noteOf('approve[no-findings]')).toBeUndefined();
    expect(noteOf('revise:   ')).toBeUndefined();
  });

  it('keeps legacy rows on their existing behaviour', () => {
    // Pre-grammar rows: a bare verdict word is still dropped by the regex, any
    // other free text still passes through whole.
    expect(noteOf('approved')).toBeUndefined();
    expect(noteOf('retry')).toBeUndefined();
    expect(noteOf('the spend screen has no way back to Home')).toBe(
      'the spend screen has no way back to Home',
    );
    expect(noteOf(null)).toBeUndefined();
    expect(noteOf('   ')).toBeUndefined();
  });
});
