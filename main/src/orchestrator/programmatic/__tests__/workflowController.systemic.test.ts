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
import {
  WorkflowController,
  MAX_SYSTEMIC_PAUSES,
  SAME_ERROR_CORROBORATION_MIN,
  SAME_ERROR_COHORT_MAX_MS,
} from '../workflowController';
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

  /**
   * Runner scripted per `${itemId}:${stepId}` (falling back to the bare step
   * id), defaulting to ok once a queue drains. Keying by LANE is load-bearing
   * for corroboration: the rule is about WHICH LANES failed with the same
   * text, and a step-id-only script cannot express "these three of five".
   */
  function makeLaneRunner(scripts: Record<string, StepRunResult[]>): StepRunner & {
    calls: Array<{ id: string; itemId: string | undefined }>;
  } {
    const queues: Record<string, StepRunResult[]> = {};
    for (const [k, v] of Object.entries(scripts)) queues[k] = [...v];
    const calls: Array<{ id: string; itemId: string | undefined }> = [];
    return {
      calls,
      async runStep(s, ctx) {
        const itemId = ctx.item?.id;
        calls.push({ id: s.id, itemId });
        const keyed = itemId ? queues[`${itemId}:${s.id}`] : undefined;
        return keyed?.shift() ?? queues[s.id]?.shift() ?? { status: 'ok' };
      },
    };
  }

  /** A plain (NON-systemic) inner-step failure carrying `error`. */
  const plainFail = (error: string): StepRunResult => ({ status: 'failed', error });

  /** Every 'failed' lane write this driver saw, in write order. */
  const failedLanes = (driver: ReturnType<typeof makeFanOutDriver>): string[] =>
    driver.lanes.filter((l) => l.status === 'failed').map((l) => l.itemId);

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

  // (g2) STICKY giveup: once the human gave up, a later systemic re-failure of the
  // SAME step must NOT re-park (no fresh blocking pause item per remaining attempt).
  it("does not re-park a step after the human gave up — the giveup is sticky across attempts", async () => {
    const d = def([phase('p1', [step({ id: 'a', retries: 1 })])]);
    // retries:1 ⇒ two attempts; BOTH fail systemically. The first parks (giveup); the
    // second must fall straight through the normal failure path, NOT park again.
    const runner = makeRunner({ a: [systemicFail(), systemicFail()] });
    const { host, pauseCalls } = makeSystemicHost({ verdicts: ['giveup'] }); // no triage ⇒ fail

    const result = await new WorkflowController(runner, host).run('r', d);

    // Normal failure path (triage absent ⇒ hard fail).
    expect(result.outcome).toBe('failed');
    expect(result.failedStepId).toBe('a');
    // Parked EXACTLY once despite the second systemic attempt.
    expect(pauseCalls.length).toBe(1);
    // Both attempts ran (the giveup did not short-circuit the retry budget).
    expect(runner.calls.map((c) => c.id)).toEqual(['a', 'a']);
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

    // (k) STICKY giveup: two SEPARATE systemic hits on the SAME outer step, but the
    // giveup latch suppresses the second park ⇒ ONE pause total.
    it("parks the fan-out only ONCE across separate systemic hits after a giveup (sticky)", async () => {
      // t3 succeeds; t1 & t2 fail systemically. t2 depends on t3, so it lands in a
      // strictly after t1 — a second systemic hit on the same outer step. Without a
      // sticky latch this would mint a second blocking pause item.
      const d = def([phase('p1', [fanStep('execute', ['implement'])])]);
      const base = makeFanOutDriver(['t1', 't2', 't3']);
      const driver: FanOutDriver = { ...base, dependencies: () => new Map([['t2', ['t3']]]) };
      const runner: StepRunner = {
        async runStep(_s, ctx) {
          const id = ctx.item?.id;
          return id === 't1' || id === 't2' ? systemicFail('overloaded') : { status: 'ok' };
        },
      };
      const { host, pauseCalls } = makeSystemicHost({ verdicts: ['giveup', 'giveup'] });
      host.fanOut = driver;

      const result = await new WorkflowController(runner, host).run('r', d);

      expect(result.outcome).toBe('completed');
      // Parked EXACTLY once across both hits (the sticky latch stopped the second).
      expect(pauseCalls.length).toBe(1);
      // t1 & t2 gave up (failed); t3 integrated.
      const failed = base.lanes.filter((l) => l.status === 'failed').map((l) => l.itemId);
      expect(new Set(failed)).toEqual(new Set(['t1', 't2']));
      expect(base.lanes.some((l) => l.status === 'integrated' && l.itemId === 't3')).toBe(true);
    });
  });

  // ── systemic settlement stays 'failed', never 'blocked' ────────────────────
  describe("systemic abandonment settles 'failed'", () => {
    // A lane that PARKED ran real agent turns against a real condition. Whatever
    // ends the park — a human giving up, a spent pause budget, or no pause seam
    // at all — it must settle 'failed'; calling it "never started" would hide the
    // failure the human is being asked about.
    const d = def([phase('p1', [fanStep('execute', ['implement'])])]);
    const alwaysSystemicT1: StepRunner = {
      async runStep(_s, ctx) {
        return ctx.item?.id === 't1' ? systemicFail('overloaded') : { status: 'ok' };
      },
    };

    it("on a human 'giveup'", async () => {
      const driver = makeFanOutDriver(['t1', 't2']);
      const { host, pauseCalls } = makeSystemicHost({ verdicts: ['giveup'] });
      host.fanOut = driver;

      await new WorkflowController(alwaysSystemicT1, host).run('r', d);

      expect(pauseCalls).toHaveLength(1);
      expect(failedLanes(driver)).toEqual(['t1']);
      expect(driver.lanes.some((l) => l.status === 'blocked')).toBe(false);
    });

    it('when the pause SEAM is absent entirely', async () => {
      const driver = makeFanOutDriver(['t1', 't2']);
      const host: ControllerHost = {
        reportStep() {},
        async requestHumanGate() {
          return 'approve';
        },
        fanOut: driver,
      };

      await new WorkflowController(alwaysSystemicT1, host).run('r', d);

      expect(failedLanes(driver)).toEqual(['t1']);
      expect(driver.lanes.some((l) => l.status === 'blocked')).toBe(false);
    });

    it('when the per-step pause BUDGET is exhausted', async () => {
      const driver = makeFanOutDriver(['t1', 't2']);
      // Every park says 'retry', so the lane re-dispatches until MAX_SYSTEMIC_PAUSES
      // is spent and the park falls through to the settle path.
      const { host, pauseCalls } = makeSystemicHost({
        verdicts: Array.from({ length: MAX_SYSTEMIC_PAUSES }, () => 'retry' as SystemicPauseVerdict),
      });
      host.fanOut = driver;

      await new WorkflowController(alwaysSystemicT1, host).run('r', d);

      expect(pauseCalls).toHaveLength(MAX_SYSTEMIC_PAUSES);
      expect(failedLanes(driver)).toEqual(['t1']);
      expect(driver.lanes.some((l) => l.status === 'blocked')).toBe(false);
    });
  });

  // ── same-error corroboration ────────────────────────────────────────────────
  describe('same-error corroboration', () => {
    /**
     * The failure text three lanes share. Deliberately NOT a shape
     * `isSystemicStepError` recognises — corroboration exists precisely for the
     * environment failures nobody has written a regex for yet.
     */
    const SAME = "Error: EPERM: operation not permitted, open '/var/run/agent.sock'";
    const ITEMS = ['t1', 't2', 't3', 't4', 't5'];
    const d = def([phase('p1', [fanStep('execute', ['implement'])])]);

    it('is three (the smallest count that is not a coincidence)', () => {
      expect(SAME_ERROR_CORROBORATION_MIN).toBe(3);
    });

    it('parks — never fails — when THREE lanes of one cohort fail with identical text', async () => {
      const driver = makeFanOutDriver(ITEMS);
      const runner = makeLaneRunner({
        't1:implement': [plainFail(SAME)],
        't2:implement': [plainFail(SAME)],
        't3:implement': [plainFail(SAME)],
      });
      const { host, pauseCalls } = makeSystemicHost({ verdicts: ['retry'] });
      host.fanOut = driver;

      const result = await new WorkflowController(runner, host).run('r', d);

      expect(result.outcome).toBe('completed');
      // ONE park, carrying the corroborated text.
      expect(pauseCalls).toEqual([{ stepId: 'execute', error: SAME, attempt: 1 }]);
      // The deferred write is what makes this observable: no lane was EVER
      // stamped 'failed', so nothing emitted a lane-failed event either.
      expect(failedLanes(driver)).toEqual([]);
      // All three re-ran after 'retry' and integrated alongside the two that passed.
      const integrated = driver.lanes.filter((l) => l.status === 'integrated').map((l) => l.itemId);
      expect(new Set(integrated)).toEqual(new Set(ITEMS));
      for (const id of ['t1', 't2', 't3']) {
        expect(runner.calls.filter((c) => c.itemId === id)).toHaveLength(2);
      }
    });

    it("persists a deferred 'failed' write when a SIBLING aborts the walk (cancel does not lose it)", async () => {
      // Regression (Codex F3): the corroboration arm HOLDS its write pending a
      // sibling's corroboration, but an aborted sibling ends the walk before the
      // hold resolves — the completed failure must not be left 'running' in the
      // lane store. The pool flushes every held write in its abort drain.
      const driver = makeFanOutDriver(['t1', 't2']);
      const runner = makeLaneRunner({
        't1:implement': [plainFail('tsc: 4 errors in exporter.ts')],
        't2:implement': [{ status: 'aborted' }],
      });
      const { host, pauseCalls } = makeSystemicHost({ verdicts: ['retry'] });
      host.fanOut = driver;

      const result = await new WorkflowController(runner, host).run('r', d);

      expect(result.outcome).toBe('canceled');
      expect(pauseCalls).toEqual([]);
      expect(failedLanes(driver)).toEqual(['t1']);
      expect(driver.lanes.some((l) => l.itemId === 't2' && l.status === 'failed')).toBe(false);
    });

    it('does NOT park for TWO lanes with identical text — each is written failed exactly once', async () => {
      // Two lanes failing alike is ordinary (a shared missing dependency, a bad
      // base commit) and IS the run's problem to surface.
      const driver = makeFanOutDriver(ITEMS);
      const runner = makeLaneRunner({
        't1:implement': [plainFail(SAME)],
        't2:implement': [plainFail(SAME)],
      });
      const { host, pauseCalls } = makeSystemicHost({ verdicts: ['retry'] });
      host.fanOut = driver;

      await new WorkflowController(runner, host).run('r', d);

      expect(pauseCalls).toEqual([]);
      expect(failedLanes(driver)).toEqual(['t1', 't2']);
    });

    it('does NOT park for three DIFFERENT failure texts', async () => {
      const driver = makeFanOutDriver(ITEMS);
      const runner = makeLaneRunner({
        't1:implement': [plainFail('tsc: 4 errors in exporter.ts')],
        't2:implement': [plainFail('eslint: 2 problems in parser.ts')],
        't3:implement': [plainFail('vitest: 1 failing assertion in api.test.ts')],
      });
      const { host, pauseCalls } = makeSystemicHost({ verdicts: ['retry'] });
      host.fanOut = driver;

      await new WorkflowController(runner, host).run('r', d);

      expect(pauseCalls).toEqual([]);
      expect(new Set(failedLanes(driver))).toEqual(new Set(['t1', 't2', 't3']));
    });

    it('lets ONE systemically-failed lane corroborate a single sibling with the same text', async () => {
      // The classifier caught it on one lane and missed it on the other (a
      // different wrapper, a different substrate). One corroborating systemic
      // lane is enough — the environment is already proven down.
      const driver = makeFanOutDriver(ITEMS);
      const runner = makeLaneRunner({
        't1:implement': [systemicFail(SAME)],
        't2:implement': [plainFail(SAME)],
      });
      const { host, pauseCalls } = makeSystemicHost({ verdicts: ['retry'] });
      host.fanOut = driver;

      const result = await new WorkflowController(runner, host).run('r', d);

      expect(result.outcome).toBe('completed');
      expect(pauseCalls).toEqual([{ stepId: 'execute', error: SAME, attempt: 1 }]);
      expect(failedLanes(driver)).toEqual([]);
      const integrated = driver.lanes.filter((l) => l.status === 'integrated').map((l) => l.itemId);
      expect(new Set(integrated)).toEqual(new Set(ITEMS));
    });

    it("fails the corroborated lanes through the give-up path on a systemic 'giveup'", async () => {
      const driver = makeFanOutDriver(ITEMS);
      const runner = makeLaneRunner({
        't1:implement': [plainFail(SAME)],
        't2:implement': [plainFail(SAME)],
        't3:implement': [plainFail(SAME)],
      });
      const { host, pauseCalls } = makeSystemicHost({ verdicts: ['giveup'] });
      host.fanOut = driver;

      await new WorkflowController(runner, host).run('r', d);

      expect(pauseCalls).toHaveLength(1);
      // The human gave up: the park's OWN settle path writes them failed (once).
      expect(new Set(failedLanes(driver))).toEqual(new Set(['t1', 't2', 't3']));
      expect(failedLanes(driver)).toHaveLength(3);
    });

    it('scopes the corroborated error to its PARK EPOCH: later unrelated failures do not re-park', async () => {
      // Three lanes share SAME ⇒ park. After the retry the re-dispatched lanes
      // fail on something else entirely — only two of them, and with different
      // text — so the stale quota-ish text must not corroborate anything.
      const driver = makeFanOutDriver(ITEMS);
      const runner = makeLaneRunner({
        't1:implement': [plainFail(SAME), plainFail('REVIEW: BLOCKING — t1 defect')],
        't2:implement': [plainFail(SAME), plainFail('REVIEW: BLOCKING — t2 defect')],
        't3:implement': [plainFail(SAME)],
      });
      const { host, pauseCalls } = makeSystemicHost({ verdicts: ['retry'] });
      host.fanOut = driver;

      await new WorkflowController(runner, host).run('r', d);

      // Exactly ONE park — the post-retry failures were genuine lane defects.
      expect(pauseCalls).toEqual([{ stepId: 'execute', error: SAME, attempt: 1 }]);
      expect(failedLanes(driver)).toEqual(['t1', 't2']);
      expect(driver.lanes.some((l) => l.status === 'integrated' && l.itemId === 't3')).toBe(true);
    });

    // ── the cohort window the wave barrier used to supply for free ───────────

    it('does NOT fuse identical failures separated by a FULL DRAIN of the pool', async () => {
      // maxConcurrency 1: every lane settles alone, so each hold's cohort is
      // already empty and its write flushes at once. Three identical texts that
      // never overlapped in time are three lane defects, not one environment
      // condition — a pool that simply accumulated held failures forever would
      // park here on the third.
      const serial = def([
        phase('p1', [
          step({
            id: 'execute',
            agent: 'orchestrate',
            fanOut: { over: 'tasks', maxConcurrency: 1, inner: [{ id: 'implement', agent: 'implement' }] },
          }),
        ]),
      ]);
      const driver = makeFanOutDriver(['t1', 't2', 't3']);
      const runner = makeLaneRunner({
        't1:implement': [plainFail(SAME)],
        't2:implement': [plainFail(SAME)],
        't3:implement': [plainFail(SAME)],
      });
      const { host, pauseCalls } = makeSystemicHost({ verdicts: ['retry'] });
      host.fanOut = driver;

      await new WorkflowController(runner, host).run('r', serial);

      expect(pauseCalls).toEqual([]);
      expect(failedLanes(driver)).toEqual(['t1', 't2', 't3']);
    });

    it('flushes a held failure at the COHORT CEILING instead of waiting out the slowest lane', async () => {
      // t1 fails while t2 (slow) and t3 are still live, so its cohort cannot
      // drain. Without a ceiling the lane row reads 'running' for as long as t2
      // takes — invisible on the board, missed by the partial-sprint gate, and
      // re-dispatched on a crash-resume. t3 pushes the clock past the ceiling, so
      // t1's write lands BEFORE t2 finishes.
      const driver = makeFanOutDriver(['t1', 't2', 't3']);
      let clock = 1_000_000;
      let lanesWrittenWhenSlowFinished = -1;
      const runner: StepRunner = {
        async runStep(_s, ctx) {
          const id = ctx.item?.id;
          if (id === 't1') return plainFail(SAME);
          if (id === 't3') {
            // Settle AFTER t1 (so its hold is already recorded), with the clock
            // pushed past the ceiling — t3's settle is the pass that must flush it.
            await new Promise((resolve) => setTimeout(resolve, 5));
            clock += SAME_ERROR_COHORT_MAX_MS * 5;
            return { status: 'ok' };
          }
          await new Promise((resolve) => setTimeout(resolve, 40));
          lanesWrittenWhenSlowFinished = driver.lanes.length;
          return { status: 'ok' };
        },
      };
      const { host, pauseCalls } = makeSystemicHost({ verdicts: ['retry'] });
      host.fanOut = driver;
      host.now = () => clock;

      const result = await new WorkflowController(runner, host).run('r', d);

      expect(result.outcome).toBe('completed');
      // One lane failure is never a park.
      expect(pauseCalls).toEqual([]);
      expect(failedLanes(driver)).toEqual(['t1']);
      // The discriminator: t1's 'failed' write was already on the driver before
      // the slow lane returned. Bounded by the cohort alone it would land after.
      const t1Failed = driver.lanes.findIndex((l) => l.itemId === 't1' && l.status === 'failed');
      expect(t1Failed).toBeGreaterThanOrEqual(0);
      expect(lanesWrittenWhenSlowFinished).toBeGreaterThan(t1Failed);
    });

    it('PARKS (never prunes) when the LAST in-flight lane settles systemic', async () => {
      // The parked lane stays in `remaining` and nothing is dispatchable, so a
      // prune evaluated before the park arm would relabel it "unresolvable
      // blocking dependencies (cycle?)" and the human would never be asked.
      const driver = makeFanOutDriver(['t1']);
      const runner: StepRunner = {
        async runStep() {
          return systemicFail('overloaded');
        },
      };
      const { host, pauseCalls } = makeSystemicHost({ verdicts: ['giveup'] });
      host.fanOut = driver;

      await new WorkflowController(runner, host).run('r', d);

      expect(pauseCalls).toEqual([{ stepId: 'execute', error: 'overloaded', attempt: 1 }]);
      // Settled by the park's own give-up path: 'failed', never 'blocked'.
      expect(failedLanes(driver)).toEqual(['t1']);
      expect(driver.lanes.some((l) => l.status === 'blocked')).toBe(false);
    });

    it('park → retry never double-writes: a re-dispatched lane is written failed at most once', async () => {
      // Three lanes park on one shared text. After the human's 'retry' two of
      // them succeed and one fails on its own defect. A hold left behind by the
      // park would flush a 'failed' write for a lane that is running again, and
      // count its incompleteCount twice.
      const driver = makeFanOutDriver(ITEMS);
      const runner = makeLaneRunner({
        't1:implement': [plainFail(SAME)],
        't2:implement': [plainFail(SAME)],
        't3:implement': [plainFail(SAME), plainFail('REVIEW: BLOCKING — t3 defect')],
      });
      const { host, pauseCalls } = makeSystemicHost({ verdicts: ['retry'] });
      host.fanOut = driver;

      const result = await new WorkflowController(runner, host).run('r', d);

      expect(result.outcome).toBe('completed');
      expect(pauseCalls).toHaveLength(1);
      // EXACTLY one 'failed' write in the whole fan-out, for the one real defect.
      expect(failedLanes(driver)).toEqual(['t3']);
      // t1/t2 succeeded on the re-dispatch and were never stamped failed.
      const integrated = driver.lanes.filter((l) => l.status === 'integrated').map((l) => l.itemId);
      expect(new Set(integrated)).toEqual(new Set(['t1', 't2', 't4', 't5']));
    });
  });
});
