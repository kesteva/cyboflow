/**
 * Unit tests for the WorkflowController SYSTEMIC-pause seam.
 *
 * A systemic failure (env-level: usage/session/rate limit, provider overload,
 * auth) is stamped `systemic: true` on the StepRunResult by the runner. The
 * controller must route it to `ControllerHost.awaitSystemicPause` BEFORE the
 * failure consumes the step's retry budget / optional-skip / loopback / triage —
 * a 'retry' verdict re-runs the SAME step without burning any budget, 'giveup'
 * falls through the normal failure path, and 'canceled' ends the walk. The
 * per-step-id park budget is bounded by MAX_SYSTEMIC_PAUSES.
 *
 * Driven entirely through fake StepRunner + ControllerHost collaborators (no SDK
 * / DB / Electron), mirroring workflowController.test.ts's fakes.
 */
import { describe, it, expect, vi } from 'vitest';
import { WorkflowController, MAX_SYSTEMIC_PAUSES } from '../workflowController';
import type {
  ControllerHost,
  FanOutDriver,
  HumanGateDecision,
  StepRunResult,
  StepRunner,
  SystemicPauseVerdict,
  TriageDecision,
} from '../types';
import type { SprintBatchTaskStatus } from '../../../../../shared/types/sprintBatch';
import type {
  WorkflowDefinition,
  WorkflowPhase,
  WorkflowStep,
} from '../../../../../shared/types/workflows';

// ── builders (mirrors workflowController.test.ts) ─────────────────────────────

function step(partial: Partial<WorkflowStep> & { id: string }): WorkflowStep {
  return {
    name: partial.id,
    agent: partial.agent ?? 'executor',
    mcps: [],
    retries: partial.retries ?? 0,
    ...partial,
  };
}

function phase(id: string, steps: WorkflowStep[]): WorkflowPhase {
  return { id, label: id, color: '#3b6dd6', steps };
}

function def(phases: WorkflowPhase[]): WorkflowDefinition {
  return { id: 'test', phases };
}

/** A systemic-failure StepRunResult with the given error text. */
function systemicFail(error = 'Claude AI usage limit reached'): StepRunResult {
  return { status: 'failed', systemic: true, error };
}

// ── fakes ─────────────────────────────────────────────────────────────────────

/** Per-step-id scripted StepRunner (default ok), recording call order. */
function makeRunner(scripts: Record<string, StepRunResult[]> = {}): StepRunner & {
  calls: Array<{ id: string; attempt: number }>;
} {
  const queues: Record<string, StepRunResult[]> = {};
  for (const [k, v] of Object.entries(scripts)) queues[k] = [...v];
  const calls: Array<{ id: string; attempt: number }> = [];
  return {
    calls,
    async runStep(s, ctx) {
      calls.push({ id: s.id, attempt: ctx.attempt });
      return queues[s.id]?.shift() ?? { status: 'ok' };
    },
  };
}

/**
 * A ControllerHost whose awaitSystemicPause replays a scripted verdict queue
 * (default 'giveup' when drained), records every pause call, and optionally
 * implements triageFailure (a spy) + scripted human gates.
 */
function makeSystemicHost(opts: {
  verdicts: SystemicPauseVerdict[];
  triage?: TriageDecision;
  gates?: Record<string, HumanGateDecision[]>;
}): {
  host: ControllerHost;
  pauseCalls: Array<{ stepId: string; error: string | undefined; attempt: number }>;
  triageSpy: ReturnType<typeof vi.fn> | null;
  gateCalls: string[];
} {
  const q = [...opts.verdicts];
  const pauseCalls: Array<{ stepId: string; error: string | undefined; attempt: number }> = [];
  const gateCalls: string[] = [];
  const gateQ: Record<string, HumanGateDecision[]> = {};
  for (const [k, v] of Object.entries(opts.gates ?? {})) gateQ[k] = [...v];
  const triageSpy = opts.triage !== undefined ? vi.fn(async () => opts.triage as TriageDecision) : null;
  const host: ControllerHost = {
    reportStep() {},
    async requestHumanGate(s) {
      gateCalls.push(s.id);
      return gateQ[s.id]?.shift() ?? 'approve';
    },
    async awaitSystemicPause(s, ctx, error) {
      pauseCalls.push({ stepId: s.id, error, attempt: ctx.attempt });
      return q.shift() ?? 'giveup';
    },
    ...(triageSpy ? { triageFailure: triageSpy } : {}),
  };
  return { host, pauseCalls, triageSpy, gateCalls };
}

/** A recording fake FanOutDriver: resolves a fixed item set + logs lane writes. */
function makeFanOutDriver(items: string[]): FanOutDriver & {
  lanes: Array<{ itemId: string; status?: SprintBatchTaskStatus }>;
} {
  const lanes: Array<{ itemId: string; status?: SprintBatchTaskStatus }> = [];
  return {
    lanes,
    resolveItems() {
      return [...items];
    },
    driveLane({ itemId, status }) {
      lanes.push({ itemId, status });
    },
  };
}

const fanStep = (id: string, innerIds: string[]): WorkflowStep =>
  step({
    id,
    agent: 'orchestrate',
    fanOut: { over: 'tasks', inner: innerIds.map((iid) => ({ id: iid, agent: iid })) },
  });

// ── tests ───────────────────────────────────────────────────────────────────

describe('WorkflowController — systemic-pause seam', () => {
  // (a) required step, retries:0 — systemic twice then ok, host retries both.
  it("parks-and-retries a required step on systemic failure without consuming retry/triage budget", async () => {
    const d = def([phase('p1', [step({ id: 'a', retries: 0 })])]);
    const runner = makeRunner({ a: [systemicFail(), systemicFail(), { status: 'ok' }] });
    const { host, pauseCalls, triageSpy } = makeSystemicHost({ verdicts: ['retry', 'retry'], triage: 'fail' });

    const result = await new WorkflowController(runner, host).run('r', d);

    expect(result.outcome).toBe('completed');
    // Runner called 3x (fail, fail, ok); the pause seam consulted on each systemic fail.
    expect(runner.calls.map((c) => c.id)).toEqual(['a', 'a', 'a']);
    expect(pauseCalls.length).toBe(2);
    // The step recorded done with attempts:1 — systemic retries did NOT bump the attempt.
    expect(result.steps[0]).toMatchObject({ stepId: 'a', outcome: 'done', attempts: 1 });
    // Triage NEVER consulted — the systemic failure never touched the failure path.
    expect(triageSpy).not.toHaveBeenCalled();
  });

  // (b) optional step, systemic then ok on 'retry' → done, NOT skipped.
  it("retries an OPTIONAL step on systemic failure ('retry') — completes done, not skipped", async () => {
    const d = def([phase('p1', [step({ id: 'a', optional: true })])]);
    const runner = makeRunner({ a: [systemicFail(), { status: 'ok' }] });
    const { host, pauseCalls } = makeSystemicHost({ verdicts: ['retry'] });

    const result = await new WorkflowController(runner, host).run('r', d);

    expect(result.outcome).toBe('completed');
    expect(result.steps[0]).toMatchObject({ stepId: 'a', outcome: 'done', attempts: 1 });
    expect(pauseCalls.length).toBe(1);
  });

  // (c) optional step, systemic + 'giveup' → normal optional-skip path.
  it("falls through to optional-skip when the human GIVES UP on a systemic pause", async () => {
    const d = def([phase('p1', [step({ id: 'a', optional: true }), step({ id: 'b' })])]);
    const runner = makeRunner({ a: [systemicFail('overloaded_error')] });
    const { host, pauseCalls } = makeSystemicHost({ verdicts: ['giveup'] });

    const result = await new WorkflowController(runner, host).run('r', d);

    expect(result.outcome).toBe('completed');
    expect(result.steps[0]).toMatchObject({ stepId: 'a', outcome: 'skipped', error: 'overloaded_error' });
    expect(result.steps[1]).toMatchObject({ stepId: 'b', outcome: 'done' });
    expect(pauseCalls.length).toBe(1);
  });

  // (d) required step, systemic + 'giveup', triage ABSENT → run failed.
  it("falls through to a hard failure when the human GIVES UP and no triage seam exists", async () => {
    const d = def([phase('p1', [step({ id: 'a' })])]);
    const runner = makeRunner({ a: [systemicFail('429 rate limit')] });
    const { host, pauseCalls } = makeSystemicHost({ verdicts: ['giveup'] }); // no triage

    const result = await new WorkflowController(runner, host).run('r', d);

    expect(result.outcome).toBe('failed');
    expect(result.failedStepId).toBe('a');
    expect(pauseCalls.length).toBe(1);
  });

  // (e) 'canceled' verdict → run canceled at that step.
  it("ends the walk 'canceled' when a systemic pause is canceled", async () => {
    const d = def([phase('p1', [step({ id: 'a' }), step({ id: 'b' })])]);
    const runner = makeRunner({ a: [systemicFail()] });
    const { host, pauseCalls } = makeSystemicHost({ verdicts: ['canceled'] });

    const result = await new WorkflowController(runner, host).run('r', d);

    expect(result.outcome).toBe('canceled');
    expect(result.failedStepId).toBe('a');
    expect(pauseCalls.length).toBe(1);
    // 'b' never ran — the walk stopped at the canceled pause.
    expect(runner.calls.some((c) => c.id === 'b')).toBe(false);
  });

  // (f) seam ABSENT → a systemic failure behaves exactly as a plain failure.
  it('treats a systemic failure as a plain failure when awaitSystemicPause is absent', async () => {
    const d = def([phase('p1', [step({ id: 'a' })])]);
    const runner = makeRunner({ a: [systemicFail()] });
    // A host WITHOUT the systemic seam (and without triage) — today's behavior.
    const host: ControllerHost = {
      reportStep() {},
      async requestHumanGate() {
        return 'approve';
      },
    };

    const result = await new WorkflowController(runner, host).run('r', d);

    // Byte-identical to a required non-systemic failure with no triage: run fails.
    expect(result.outcome).toBe('failed');
    expect(result.failedStepId).toBe('a');
    expect(runner.calls.filter((c) => c.id === 'a').length).toBe(1);
  });

  // (g) budget: MAX_SYSTEMIC_PAUSES exhausted → falls through to normal failure.
  it('bounds systemic retries at MAX_SYSTEMIC_PAUSES, then falls through to failure', async () => {
    const d = def([phase('p1', [step({ id: 'a' })])]);
    // Always systemic; the host always says 'retry' — the CONTROLLER's budget must stop it.
    const runner = makeRunner({ a: Array.from({ length: MAX_SYSTEMIC_PAUSES + 5 }, () => systemicFail()) });
    const { host, pauseCalls } = makeSystemicHost({
      verdicts: Array.from({ length: MAX_SYSTEMIC_PAUSES + 5 }, () => 'retry' as SystemicPauseVerdict),
    });

    const result = await new WorkflowController(runner, host).run('r', d);

    expect(result.outcome).toBe('failed');
    expect(result.failedStepId).toBe('a');
    // The pause seam was consulted exactly MAX_SYSTEMIC_PAUSES times.
    expect(pauseCalls.length).toBe(MAX_SYSTEMIC_PAUSES);
  });

  // ── fan-out ────────────────────────────────────────────────────────────────
  describe('fan-out', () => {
    /** Runner that fails item t1 systemically on its FIRST inner call, ok otherwise. */
    function makeT1FlakeRunner(mode: 'once' | 'always'): StepRunner & { calls: string[] } {
      const perItem = new Map<string, number>();
      const calls: string[] = [];
      return {
        calls,
        async runStep(s, ctx) {
          const id = ctx.item?.id ?? s.id;
          calls.push(id);
          const n = (perItem.get(id) ?? 0) + 1;
          perItem.set(id, n);
          if (id === 't1' && (mode === 'always' || n === 1)) return systemicFail('overloaded');
          return { status: 'ok' };
        },
      };
    }

    // (h) one lane systemic → park once → 'retry' → re-dispatch → integrates.
    it("parks the whole fan-out on one lane's systemic failure and re-dispatches on 'retry'", async () => {
      const d = def([phase('p1', [fanStep('execute', ['implement']), step({ id: 'after' })])]);
      const driver = makeFanOutDriver(['t1', 't2']);
      const runner = makeT1FlakeRunner('once');
      const { host, pauseCalls } = makeSystemicHost({ verdicts: ['retry'] });
      host.fanOut = driver;

      const result = await new WorkflowController(runner, host).run('r', d);

      expect(result.outcome).toBe('completed');
      expect(pauseCalls.length).toBe(1);
      // Both lanes integrated (t1 after its retry); NO lane failed.
      const integrated = driver.lanes.filter((l) => l.status === 'integrated').map((l) => l.itemId);
      expect(new Set(integrated)).toEqual(new Set(['t1', 't2']));
      expect(driver.lanes.some((l) => l.status === 'failed')).toBe(false);
      // skipToHumanGate was NOT engaged — the subsequent automated step still ran.
      expect(runner.calls.includes('after')).toBe(true);
    });

    // (i) one lane systemic → 'giveup' → lane failed, incompleteCount 1, closing gate engages.
    it("fails the paused lane and gates the closing stage on a systemic 'giveup'", async () => {
      const d = def([
        phase('execute', [fanStep('execute', ['implement'])]),
        phase('review', [
          step({ id: 'sprint-verify' }),
          step({ id: 'human-review', agent: 'human', human: true }),
        ]),
      ]);
      const driver = makeFanOutDriver(['t1', 't2']);
      const runner = makeT1FlakeRunner('always');
      const { host, pauseCalls, gateCalls } = makeSystemicHost({ verdicts: ['giveup'] });
      host.fanOut = driver;

      const result = await new WorkflowController(runner, host).run('r', d);

      expect(result.outcome).toBe('completed');
      expect(pauseCalls.length).toBe(1);
      // t1 lane failed (gave up), t2 integrated.
      expect(driver.lanes.filter((l) => l.status === 'failed').map((l) => l.itemId)).toEqual(['t1']);
      expect(driver.lanes.some((l) => l.status === 'integrated')).toBe(true);
      // incompleteCount > 0 ⇒ closing-stage gate engaged: sprint-verify skipped, gate reached.
      const byId = Object.fromEntries(result.steps.map((s) => [s.stepId, s.outcome]));
      expect(byId['sprint-verify']).toBe('skipped');
      expect(byId['human-review']).toBe('done');
      expect(gateCalls).toEqual(['human-review']);
    });

    // (j) systemic 'canceled' inside a fan-out → terminal canceled.
    it("ends the run 'canceled' when a fan-out systemic pause is canceled", async () => {
      const d = def([phase('p1', [fanStep('execute', ['implement'])])]);
      const driver = makeFanOutDriver(['t1', 't2']);
      const runner = makeT1FlakeRunner('always');
      const { host, pauseCalls } = makeSystemicHost({ verdicts: ['canceled'] });
      host.fanOut = driver;

      const result = await new WorkflowController(runner, host).run('r', d);

      expect(result.outcome).toBe('canceled');
      expect(result.failedStepId).toBe('execute');
      expect(pauseCalls.length).toBe(1);
      expect(driver.lanes.some((l) => l.status === 'integrated' && l.itemId === 't1')).toBe(false);
    });
  });
});
