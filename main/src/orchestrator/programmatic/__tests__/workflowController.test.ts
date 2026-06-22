/**
 * Unit tests for WorkflowController — the deterministic DAG walker for the
 * programmatic execution model. Exercised entirely through fake StepRunner +
 * ControllerHost collaborators, so the suite pins the control-flow contract
 * (ordering, retries, intra-phase loopback budget, optional-skip, human gates,
 * terminal outcomes) without any SDK / DB / Electron dependency.
 */
import { describe, it, expect } from 'vitest';
import { WorkflowController, MAX_STEP_LOOPBACKS } from '../workflowController';
import type {
  ControllerHost,
  FanOutDriver,
  HumanGateDecision,
  StepRunResult,
  StepRunner,
  SupervisorEvent,
  TriageDecision,
} from '../types';
import type { SprintBatchTaskStatus } from '../../../../../shared/types/sprintBatch';
import { SPRINT_BATCH_CAP } from '../../../../../shared/types/sprintBatch';
import type {
  WorkflowDefinition,
  WorkflowPhase,
  WorkflowStep,
} from '../../../../../shared/types/workflows';

// ── builders ────────────────────────────────────────────────────────────────

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

// ── fakes ──────────────────────────────────────────────────────────────────

/**
 * A StepRunner driven by a per-step-id queue of results. Each call to runStep
 * shifts the next scripted result for that step id (defaulting to ok when the
 * queue is empty), and records the call order.
 */
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
      const next = queues[s.id]?.shift();
      return next ?? { status: 'ok' };
    },
  };
}

/**
 * A ControllerHost that records every reportStep call and resolves human gates
 * from a per-step-id queue of decisions (default 'approve').
 */
function makeHost(gates: Record<string, HumanGateDecision[]> = {}): ControllerHost & {
  reports: Array<{ id: string; status: 'running' | 'done' }>;
  gateCalls: string[];
} {
  const queues: Record<string, HumanGateDecision[]> = {};
  for (const [k, v] of Object.entries(gates)) queues[k] = [...v];
  const reports: Array<{ id: string; status: 'running' | 'done' }> = [];
  const gateCalls: string[] = [];
  return {
    reports,
    gateCalls,
    reportStep(id, status) {
      reports.push({ id, status });
    },
    async requestHumanGate(s) {
      gateCalls.push(s.id);
      return queues[s.id]?.shift() ?? 'approve';
    },
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('WorkflowController', () => {
  it('walks a linear all-ok definition to completed, in order, with running/done pairs', async () => {
    const d = def([
      phase('p1', [step({ id: 'a' }), step({ id: 'b' })]),
      phase('p2', [step({ id: 'c' })]),
    ]);
    const runner = makeRunner();
    const host = makeHost();

    const result = await new WorkflowController(runner, host).run('run-1', d);

    expect(result.outcome).toBe('completed');
    expect(result.steps.map((s) => s.stepId)).toEqual(['a', 'b', 'c']);
    expect(result.steps.every((s) => s.outcome === 'done')).toBe(true);
    expect(runner.calls.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    // Each step reports exactly one running then one done, in order.
    expect(host.reports).toEqual([
      { id: 'a', status: 'running' }, { id: 'a', status: 'done' },
      { id: 'b', status: 'running' }, { id: 'b', status: 'done' },
      { id: 'c', status: 'running' }, { id: 'c', status: 'done' },
    ]);
  });

  it('retries an agent step in place up to retries+1 attempts and then completes', async () => {
    const d = def([phase('p1', [step({ id: 'a', retries: 2 })])]);
    // Fail, fail, ok → succeeds on the 3rd attempt (within budget of 3).
    const runner = makeRunner({ a: [{ status: 'failed' }, { status: 'failed' }, { status: 'ok' }] });

    const result = await new WorkflowController(runner, makeHost()).run('r', d);

    expect(result.outcome).toBe('completed');
    expect(result.steps[0]).toMatchObject({ stepId: 'a', outcome: 'done', attempts: 3 });
    expect(runner.calls).toEqual([{ id: 'a', attempt: 1 }, { id: 'a', attempt: 2 }, { id: 'a', attempt: 3 }]);
  });

  it('fails the run when a required step exhausts its retries with no loopback', async () => {
    const d = def([phase('p1', [step({ id: 'a', retries: 1 }), step({ id: 'b' })])]);
    const runner = makeRunner({ a: [{ status: 'failed', error: 'boom' }, { status: 'failed', error: 'boom' }] });

    const result = await new WorkflowController(runner, makeHost()).run('r', d);

    expect(result.outcome).toBe('failed');
    expect(result.failedStepId).toBe('a');
    expect(result.steps[0]).toMatchObject({ stepId: 'a', outcome: 'failed', attempts: 2, error: 'boom' });
    // 'b' never ran — the run terminated at 'a'.
    expect(runner.calls.some((c) => c.id === 'b')).toBe(false);
  });

  it('skips a failing optional step and continues to completion', async () => {
    const d = def([phase('p1', [step({ id: 'a', optional: true }), step({ id: 'b' })])]);
    const runner = makeRunner({ a: [{ status: 'failed', error: 'meh' }] });

    const result = await new WorkflowController(runner, makeHost()).run('r', d);

    expect(result.outcome).toBe('completed');
    expect(result.steps[0]).toMatchObject({ stepId: 'a', outcome: 'skipped', attempts: 1 });
    expect(result.steps[1]).toMatchObject({ stepId: 'b', outcome: 'done' });
  });

  it('loops back to an intra-phase target on failure, then completes after the rerun succeeds', async () => {
    // p1: a, b(loopback→a). b fails once → jump to a → a ok → b ok → done.
    const d = def([phase('p1', [step({ id: 'a' }), step({ id: 'b', loopback: 'a' })])]);
    const runner = makeRunner({ b: [{ status: 'failed' }] /* first b fails; rerun b ok */ });

    const result = await new WorkflowController(runner, makeHost()).run('r', d);

    expect(result.outcome).toBe('completed');
    // a runs, b fails+jumps, a reruns, b reruns ok.
    expect(runner.calls.map((c) => c.id)).toEqual(['a', 'b', 'a', 'b']);
  });

  it('escalates to failed once the loopback budget (MAX_STEP_LOOPBACKS) is exhausted', async () => {
    const d = def([phase('p1', [step({ id: 'a' }), step({ id: 'b', loopback: 'a' })])]);
    // b always fails → it will jump MAX_STEP_LOOPBACKS times then escalate.
    const alwaysFail: StepRunResult[] = Array.from({ length: 50 }, () => ({ status: 'failed' as const }));
    const runner = makeRunner({ b: alwaysFail });

    const result = await new WorkflowController(runner, makeHost()).run('r', d);

    expect(result.outcome).toBe('failed');
    expect(result.failedStepId).toBe('b');
    // b executed MAX_STEP_LOOPBACKS jumps + the final escalating attempt.
    const bRuns = runner.calls.filter((c) => c.id === 'b').length;
    expect(bRuns).toBe(MAX_STEP_LOOPBACKS + 1);
  });

  it('advances past an approved human gate without invoking the runner for it', async () => {
    const d = def([phase('p1', [step({ id: 'gate', agent: 'human', human: true }), step({ id: 'a' })])]);
    const runner = makeRunner();
    const host = makeHost({ gate: ['approve'] });

    const result = await new WorkflowController(runner, host).run('r', d);

    expect(result.outcome).toBe('completed');
    expect(host.gateCalls).toEqual(['gate']);
    expect(runner.calls.some((c) => c.id === 'gate')).toBe(false); // gate never hits the runner
    expect(runner.calls.map((c) => c.id)).toEqual(['a']);
  });

  it('ends the run as rejected when a human gate is rejected', async () => {
    const d = def([phase('p1', [step({ id: 'gate', agent: 'human', human: true }), step({ id: 'a' })])]);
    const host = makeHost({ gate: ['reject'] });

    const result = await new WorkflowController(makeRunner(), host).run('r', d);

    expect(result.outcome).toBe('rejected');
    expect(result.failedStepId).toBe('gate');
  });

  it("loops back on a human gate 'revise' decision, then completes on approve", async () => {
    // p1: work, gate(loopback→work). gate revises once → rerun work → gate approves.
    const d = def([
      phase('p1', [step({ id: 'work' }), step({ id: 'gate', agent: 'human', human: true, loopback: 'work' })]),
    ]);
    const runner = makeRunner();
    const host = makeHost({ gate: ['revise', 'approve'] });

    const result = await new WorkflowController(runner, host).run('r', d);

    expect(result.outcome).toBe('completed');
    expect(runner.calls.map((c) => c.id)).toEqual(['work', 'work']); // work ran twice
    expect(host.gateCalls).toEqual(['gate', 'gate']); // gate presented twice
  });

  // ── agent-then-gate: a step with a REAL agent AND human:true (e.g. planner
  //    'context') runs its agent FIRST, then opens the gate (fix #7) ──────────
  describe('agent step with a trailing human checkpoint (agent + human:true)', () => {
    it('runs the agent, THEN opens the gate, and advances on approve', async () => {
      const d = def([phase('p1', [step({ id: 'context', agent: 'context', human: true }), step({ id: 'a' })])]);
      const runner = makeRunner();
      const host = makeHost({ context: ['approve'] });

      const result = await new WorkflowController(runner, host).run('r', d);

      expect(result.outcome).toBe('completed');
      // The agent DID run for the context step (the prior bug skipped it).
      expect(runner.calls.map((c) => c.id)).toEqual(['context', 'a']);
      expect(host.gateCalls).toEqual(['context']);
    });

    it('does NOT open the gate when the agent step fails (gate is only reached on success)', async () => {
      const d = def([phase('p1', [step({ id: 'context', agent: 'context', human: true })])]);
      const runner = makeRunner({ context: [{ status: 'failed', error: 'boom' }] });
      const host = makeHost({ context: ['approve'] });

      const result = await new WorkflowController(runner, host).run('r', d);

      expect(result.outcome).toBe('failed');
      expect(host.gateCalls).toEqual([]); // gate never opened — agent failed first
    });

    it("re-runs the agent on a 'revise' verdict (no loopback target = re-do this step)", async () => {
      const d = def([phase('p1', [step({ id: 'context', agent: 'context', human: true })])]);
      const runner = makeRunner();
      const host = makeHost({ context: ['revise', 'approve'] });

      const result = await new WorkflowController(runner, host).run('r', d);

      expect(result.outcome).toBe('completed');
      expect(runner.calls.map((c) => c.id)).toEqual(['context', 'context']); // agent ran twice
      expect(host.gateCalls).toEqual(['context', 'context']);
    });
  });

  // ── cancellation via AbortSignal (fix #3/#10/#11/#14) ────────────────────────
  describe('cancellation', () => {
    it('returns canceled without running any step when the signal is already aborted', async () => {
      const d = def([phase('p1', [step({ id: 'a' }), step({ id: 'b' })])]);
      const runner = makeRunner();
      const ac = new AbortController();
      ac.abort();

      const result = await new WorkflowController(runner, makeHost()).run('r', d, ac.signal);

      expect(result.outcome).toBe('canceled');
      expect(runner.calls).toEqual([]);
    });

    it('stops the walk when a runStep reports aborted (SDK abort read as clean)', async () => {
      const d = def([phase('p1', [step({ id: 'a' }), step({ id: 'b' })])]);
      const runner = makeRunner({ a: [{ status: 'aborted' }] });

      const result = await new WorkflowController(runner, makeHost()).run('r', d);

      expect(result.outcome).toBe('canceled');
      expect(result.failedStepId).toBe('a');
      expect(runner.calls.some((c) => c.id === 'b')).toBe(false); // never advanced
    });

    it("ends canceled when a human gate returns 'abort'", async () => {
      const d = def([phase('p1', [step({ id: 'gate', agent: 'human', human: true }), step({ id: 'a' })])]);
      const host = makeHost({ gate: ['abort'] });

      const result = await new WorkflowController(makeRunner(), host).run('r', d);

      expect(result.outcome).toBe('canceled');
      expect(result.failedStepId).toBe('gate');
    });
  });

  // ── revise-budget exhaustion is graceful, not a thrown invariant (fix #9/#16) ─
  it('ends a repeatedly-revised no-loopback gate as rejected (graceful, not a throw)', async () => {
    const d = def([phase('p1', [step({ id: 'gate', agent: 'human', human: true })])]);
    // Always 'revise' — with no loopback target this consumes the per-step budget
    // and must end GRACEFULLY as rejected rather than tripping the execution bound.
    const host = makeHost({ gate: Array.from({ length: 50 }, () => 'revise' as HumanGateDecision) });

    const result = await new WorkflowController(makeRunner(), host).run('r', d);

    expect(result.outcome).toBe('rejected');
    expect(result.failedStepId).toBe('gate');
    // Bounded: MAX_STEP_LOOPBACKS re-presents + the final budget-exhausted one.
    expect(host.gateCalls.length).toBe(MAX_STEP_LOOPBACKS + 1);
  });

  // ── the execution bound must NOT trip for a legitimate multi-loopback phase
  //    (fix #8) ────────────────────────────────────────────────────────────────
  // ── Stage 3: triage seam + monitor feed ──────────────────────────────────────
  describe('triage seam (Stage 3)', () => {
    /** Host with a scripted triageFailure + a notify recorder. */
    function makeTriageHost(
      decision: TriageDecision | TriageDecision[],
      gates: Record<string, HumanGateDecision[]> = {},
    ): ControllerHost & { events: SupervisorEvent[]; gateCalls: string[] } {
      const decisions = Array.isArray(decision) ? [...decision] : null;
      const gateQ: Record<string, HumanGateDecision[]> = {};
      for (const [k, v] of Object.entries(gates)) gateQ[k] = [...v];
      const events: SupervisorEvent[] = [];
      const gateCalls: string[] = [];
      return {
        events,
        gateCalls,
        reportStep() {},
        async requestHumanGate(s) {
          gateCalls.push(s.id);
          return gateQ[s.id]?.shift() ?? 'approve';
        },
        notify(e) {
          events.push(e);
        },
        async triageFailure() {
          return decisions ? decisions.shift() ?? 'fail' : (decision as TriageDecision);
        },
      };
    }

    it("'fail' triage fails the run (and is the no-advisor default)", async () => {
      const d = def([phase('p1', [step({ id: 'a' })])]);
      const runner = makeRunner({ a: Array.from({ length: 5 }, () => ({ status: 'failed' as const })) });

      const result = await new WorkflowController(runner, makeTriageHost('fail')).run('r', d);

      expect(result.outcome).toBe('failed');
      expect(result.failedStepId).toBe('a');
    });

    it("'retry' triage re-runs the failed step, then completes when it succeeds", async () => {
      const d = def([phase('p1', [step({ id: 'a' })])]);
      // First attempt fails (no retries budget) → triage 'retry' → second run ok.
      const runner = makeRunner({ a: [{ status: 'failed' }] });

      const result = await new WorkflowController(runner, makeTriageHost('retry')).run('r', d);

      expect(result.outcome).toBe('completed');
      expect(runner.calls.map((c) => c.id)).toEqual(['a', 'a']); // re-run via triage
    });

    it("'retry' triage is bounded — gives up to 'failed' after the triage budget", async () => {
      const d = def([phase('p1', [step({ id: 'a' })])]);
      const runner = makeRunner({ a: Array.from({ length: 50 }, () => ({ status: 'failed' as const })) });

      const result = await new WorkflowController(runner, makeTriageHost('retry')).run('r', d);

      expect(result.outcome).toBe('failed');
      // 1 initial + MAX_STEP_LOOPBACKS triage retries.
      expect(runner.calls.filter((c) => c.id === 'a').length).toBe(MAX_STEP_LOOPBACKS + 1);
    });

    it("'escalate' triage opens a human gate; approve SKIPS the failed step and advances", async () => {
      const d = def([phase('p1', [step({ id: 'a' }), step({ id: 'b' })])]);
      const runner = makeRunner({ a: [{ status: 'failed', error: 'boom' }] });
      const host = makeTriageHost('escalate', { a: ['approve'] });

      const result = await new WorkflowController(runner, host).run('r', d);

      expect(result.outcome).toBe('completed');
      expect(host.gateCalls).toEqual(['a']); // failure escalated to the human gate
      expect(runner.calls.some((c) => c.id === 'b')).toBe(true); // advanced past the skip
    });

    it("'escalate' → human reject fails the run", async () => {
      const d = def([phase('p1', [step({ id: 'a' })])]);
      const runner = makeRunner({ a: [{ status: 'failed' }] });
      const host = makeTriageHost('escalate', { a: ['reject'] });

      const result = await new WorkflowController(runner, host).run('r', d);

      expect(result.outcome).toBe('failed');
    });

    it("'escalate' → human abort cancels the run", async () => {
      const d = def([phase('p1', [step({ id: 'a' })])]);
      const runner = makeRunner({ a: [{ status: 'failed' }] });
      const host = makeTriageHost('escalate', { a: ['abort'] });

      const result = await new WorkflowController(runner, host).run('r', d);

      expect(result.outcome).toBe('canceled');
    });

    it('does not trip the execution bound when a single self-loopback step ALSO triage-retries', async () => {
      // A 1-step phase whose step loops back to itself AND the supervisor triages
      // 'retry' — exercising BOTH per-step budgets. The bound must absorb both
      // (2*MAX_STEP_LOOPBACKS re-visits) without a false "execution bound" throw.
      const d = def([phase('p1', [step({ id: 'a', loopback: 'a' })])]);
      const runner = makeRunner({ a: Array.from({ length: 100 }, () => ({ status: 'failed' as const })) });

      // No throw: the run ends as a graceful 'failed' once both budgets drain.
      const result = await new WorkflowController(runner, makeTriageHost('retry')).run('r', d);

      expect(result.outcome).toBe('failed');
      expect(result.failedStepId).toBe('a');
    });

    it('emits run-started / step-failed / run-finished monitor events', async () => {
      const d = def([phase('p1', [step({ id: 'a' })])]);
      const runner = makeRunner({ a: [{ status: 'failed' }] });
      const host = makeTriageHost('fail');

      await new WorkflowController(runner, host).run('r', d);

      const kinds = host.events.map((e) => e.kind);
      expect(kinds[0]).toBe('run-started');
      expect(kinds).toContain('step-failed');
      expect(kinds[kinds.length - 1]).toBe('run-finished');
      expect(host.events.find((e) => e.kind === 'run-finished')?.outcome).toBe('failed');
    });
  });

  // ── crash-safe resume (resumeFromStepId) ────────────────────────────────────
  describe('resume', () => {
    it('fast-forwards to resumeFromStepId, skipping earlier phases/steps', async () => {
      const d = def([
        phase('p1', [step({ id: 'a' }), step({ id: 'b' })]),
        phase('p2', [step({ id: 'c' }), step({ id: 'dd' })]),
      ]);
      const runner = makeRunner();

      const result = await new WorkflowController(runner, makeHost()).run('r', d, undefined, 'c');

      expect(result.outcome).toBe('completed');
      // a, b (whole p1) and the earlier p2 step are skipped; resume at c.
      expect(runner.calls.map((x) => x.id)).toEqual(['c', 'dd']);
    });

    it('resumes mid-phase at the given step (earlier steps in the same phase skipped)', async () => {
      const d = def([phase('p1', [step({ id: 'a' }), step({ id: 'b' }), step({ id: 'c' })])]);
      const runner = makeRunner();

      await new WorkflowController(runner, makeHost()).run('r', d, undefined, 'b');

      expect(runner.calls.map((x) => x.id)).toEqual(['b', 'c']); // 'a' skipped
    });

    it('falls back to the beginning when resumeFromStepId is unknown', async () => {
      const d = def([phase('p1', [step({ id: 'a' }), step({ id: 'b' })])]);
      const runner = makeRunner();

      await new WorkflowController(runner, makeHost()).run('r', d, undefined, 'nope');

      expect(runner.calls.map((x) => x.id)).toEqual(['a', 'b']);
    });

    it('skips individually-completed steps via completedStepIds (finer than resumeFromStepId)', async () => {
      const d = def([phase('p1', [step({ id: 'a' }), step({ id: 'b' }), step({ id: 'c' })])]);
      const runner = makeRunner();

      // a + b already completed before the restart → only c re-runs.
      await new WorkflowController(runner, makeHost()).run('r', d, undefined, undefined, new Set(['a', 'b']));

      expect(runner.calls.map((x) => x.id)).toEqual(['c']);
    });
  });

  // ── per-step result recording (Stage 3, migration 033) ───────────────────────
  it('records each settled step via host.recordStepResult with its outcome', async () => {
    const d = def([
      phase('p1', [step({ id: 'a' }), step({ id: 'b', optional: true })]),
      phase('p2', [step({ id: 'gate', agent: 'human', human: true })]),
    ]);
    const runner = makeRunner({ b: [{ status: 'failed', error: 'meh' }] }); // b optional → skipped
    const host = makeHost({ gate: ['approve'] });
    const recorded: Array<{ stepId: string; outcome: string }> = [];
    host.recordStepResult = (r) => recorded.push({ stepId: r.stepId, outcome: r.outcome });

    await new WorkflowController(runner, host).run('r', d);

    expect(recorded).toEqual([
      { stepId: 'a', outcome: 'done' },
      { stepId: 'b', outcome: 'skipped' },
      { stepId: 'gate', outcome: 'done' },
    ]);
  });

  it('does not falsely trip the execution bound when several steps loop back to an early step', async () => {
    // p1: a, b(→a), c(→a), d(→a). Each of b/c/d fails once then succeeds on rerun.
    const d = def([
      phase('p1', [
        step({ id: 'a' }),
        step({ id: 'b', loopback: 'a' }),
        step({ id: 'c', loopback: 'a' }),
        step({ id: 'dd', loopback: 'a' }),
      ]),
    ]);
    const runner = makeRunner({
      b: [{ status: 'failed' }],
      c: [{ status: 'failed' }],
      dd: [{ status: 'failed' }],
    });

    const result = await new WorkflowController(runner, makeHost()).run('r', d);

    expect(result.outcome).toBe('completed'); // no false "execution bound exceeded" throw
  });

  // ── host-driven parallel fan-out (programmatic plane) ────────────────────────
  describe('fan-out', () => {
    /** A recording fake FanOutDriver: resolves a fixed item set + logs lane writes. */
    function makeFanOutDriver(items: string[]): FanOutDriver & {
      lanes: Array<{
        itemId: string;
        status?: SprintBatchTaskStatus;
        currentStepId?: string | null;
        allowedStepIds: readonly string[];
      }>;
    } {
      const lanes: Array<{
        itemId: string;
        status?: SprintBatchTaskStatus;
        currentStepId?: string | null;
        allowedStepIds: readonly string[];
      }> = [];
      return {
        lanes,
        resolveItems() {
          return [...items];
        },
        driveLane({ itemId, status, currentStepId, allowedStepIds }) {
          lanes.push({ itemId, status, currentStepId, allowedStepIds });
        },
      };
    }

    /** A host carrying an injected FanOutDriver (extends makeHost). */
    function makeFanHost(driver: FanOutDriver | undefined): ReturnType<typeof makeHost> {
      const host = makeHost();
      host.fanOut = driver;
      return host;
    }

    const fanStep = (id: string, innerIds: string[]): WorkflowStep =>
      step({
        id,
        agent: 'orchestrate',
        fanOut: {
          over: 'tasks',
          inner: innerIds.map((iid) => ({ id: iid, agent: iid })),
        },
      });

    it('walks each resolved item through the inner chain: running → steps → integrated', async () => {
      const d = def([phase('p1', [fanStep('execute', ['implement', 'verify'])])]);
      const driver = makeFanOutDriver(['t1', 't2', 't3']);
      // Runner default = ok for every inner step.
      const runner = makeRunner();

      const result = await new WorkflowController(runner, makeFanHost(driver)).run('r', d);

      expect(result.outcome).toBe('completed');
      // Outer step recorded done once.
      expect(result.steps.map((s) => s.stepId)).toEqual(['execute']);
      expect(result.steps[0]).toMatchObject({ stepId: 'execute', outcome: 'done' });

      // Each item: running(@implement) → implement → verify → integrated.
      for (const item of ['t1', 't2', 't3']) {
        const itemLanes = driver.lanes.filter((l) => l.itemId === item);
        expect(itemLanes[0]).toMatchObject({ status: 'running', currentStepId: 'implement' });
        expect(itemLanes.map((l) => l.currentStepId)).toEqual([
          'implement', // running seed
          'implement', // step 1
          'verify', // step 2
          undefined, // integrated (no currentStepId)
        ]);
        expect(itemLanes[itemLanes.length - 1].status).toBe('integrated');
        // allowedStepIds threads the inner vocabulary into every lane write.
        expect(itemLanes.every((l) => l.allowedStepIds.join(',') === 'implement,verify')).toBe(true);
      }

      // Each item ran both inner steps via the runner (3 items × 2 inner = 6).
      expect(runner.calls.filter((c) => c.id === 'implement').length).toBe(3);
      expect(runner.calls.filter((c) => c.id === 'verify').length).toBe(3);
      // Item context threaded into the spawn ctx — verified via a context-capturing
      // runner below; here just assert the outer step never hit the runner.
      expect(runner.calls.some((c) => c.id === 'execute')).toBe(false);
    });

    it('threads per-item context into the synthesized inner-step runStep call', async () => {
      const d = def([phase('p1', [fanStep('execute', ['implement'])])]);
      const driver = makeFanOutDriver(['t1', 't2']);
      const seen: Array<{ id: string; over?: string; itemId?: string }> = [];
      const runner: StepRunner = {
        async runStep(s, ctx) {
          seen.push({ id: s.id, over: ctx.item?.over, itemId: ctx.item?.id });
          return { status: 'ok' };
        },
      };

      await new WorkflowController(runner, makeFanHost(driver)).run('r', d);

      expect(seen).toEqual([
        { id: 'implement', over: 'tasks', itemId: 't1' },
        { id: 'implement', over: 'tasks', itemId: 't2' },
      ]);
    });

    it('respects the SPRINT_BATCH_CAP concurrency cap (items run in waves)', async () => {
      // More items than the cap → at most SPRINT_BATCH_CAP run concurrently.
      const items = Array.from({ length: SPRINT_BATCH_CAP + 3 }, (_, k) => `t${k}`);
      const d = def([phase('p1', [fanStep('execute', ['implement'])])]);
      const driver = makeFanOutDriver(items);

      let inFlight = 0;
      let maxInFlight = 0;
      const runner: StepRunner = {
        async runStep() {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          // Yield so concurrently-started items overlap before resolving.
          await new Promise((res) => setTimeout(res, 1));
          inFlight -= 1;
          return { status: 'ok' };
        },
      };

      const result = await new WorkflowController(runner, makeFanHost(driver)).run('r', d);

      expect(result.outcome).toBe('completed');
      expect(maxInFlight).toBeLessThanOrEqual(SPRINT_BATCH_CAP);
      // Every item integrated.
      const integrated = driver.lanes.filter((l) => l.status === 'integrated').map((l) => l.itemId);
      expect(new Set(integrated)).toEqual(new Set(items));
    });

    it('marks a lane failed on a required inner-step failure while siblings integrate', async () => {
      const d = def([phase('p1', [fanStep('execute', ['implement', 'verify'])])]);
      const driver = makeFanOutDriver(['t1', 't2']);
      // t1's 'implement' fails (required) → t1 lane fails, t2 integrates.
      // The runner is keyed by step id only, so distinguish by failing the FIRST
      // implement call: use a single-shot fail on 'implement'.
      const runner = makeRunner({ implement: [{ status: 'failed', error: 'boom' }] });

      const result = await new WorkflowController(runner, makeFanHost(driver)).run('r', d);

      // The fan-out still settles the outer step done (non-terminal item failure).
      expect(result.outcome).toBe('completed');
      expect(result.steps[0]).toMatchObject({ stepId: 'execute', outcome: 'done' });

      // Exactly one lane failed and one integrated.
      const failed = driver.lanes.filter((l) => l.status === 'failed');
      const integrated = driver.lanes.filter((l) => l.status === 'integrated');
      expect(failed.length).toBe(1);
      expect(integrated.length).toBe(1);
    });

    it('continues the lane when an OPTIONAL inner step fails (no lane failure)', async () => {
      const d = def([
        phase('p1', [
          step({
            id: 'execute',
            agent: 'orchestrate',
            fanOut: {
              over: 'tasks',
              inner: [
                { id: 'implement', agent: 'implement' },
                { id: 'visual', agent: 'visual', optional: true },
                { id: 'verify', agent: 'verify' },
              ],
            },
          }),
        ]),
      ]);
      const driver = makeFanOutDriver(['t1']);
      const runner = makeRunner({ visual: [{ status: 'failed', error: 'flaky' }] });

      const result = await new WorkflowController(runner, makeFanHost(driver)).run('r', d);

      expect(result.outcome).toBe('completed');
      // The optional failure did NOT fail the lane — it integrated.
      expect(driver.lanes.some((l) => l.status === 'failed')).toBe(false);
      expect(driver.lanes.some((l) => l.status === 'integrated')).toBe(true);
      // 'verify' still ran after the optional skip.
      expect(runner.calls.some((c) => c.id === 'verify')).toBe(true);
    });

    it('cancels the run when the signal aborts mid fan-out', async () => {
      const d = def([phase('p1', [fanStep('execute', ['implement', 'verify'])])]);
      const driver = makeFanOutDriver(['t1', 't2']);
      const ac = new AbortController();
      // Abort as soon as the first inner step runs.
      const runner: StepRunner = {
        async runStep() {
          ac.abort();
          return { status: 'aborted' };
        },
      };

      const result = await new WorkflowController(runner, makeFanHost(driver)).run('r', d, ac.signal);

      expect(result.outcome).toBe('canceled');
      expect(result.failedStepId).toBe('execute');
    });

    it('falls back to the normal agent path when the driver resolves [] (byte-identical)', async () => {
      const d = def([phase('p1', [fanStep('execute', ['implement', 'verify']), step({ id: 'next' })])]);
      const driver = makeFanOutDriver([]); // no items → no fan-out
      const runner = makeRunner();

      const result = await new WorkflowController(runner, makeFanHost(driver)).run('r', d);

      expect(result.outcome).toBe('completed');
      // The OUTER step ran exactly once via the runner (normal single-step path),
      // and no lanes were driven.
      expect(runner.calls.filter((c) => c.id === 'execute').length).toBe(1);
      expect(driver.lanes).toEqual([]);
      expect(runner.calls.map((c) => c.id)).toEqual(['execute', 'next']);
    });

    it('contains a resolveItems throw: runs the fanOut step as a single step (no crash)', async () => {
      // The production sprint driver SELECTs lanes in resolveItems; a transient DB
      // throw (e.g. SQLITE_BUSY) must NOT escape the walk. The controller contains
      // it and degrades to the normal single agent-step path.
      const d = def([phase('p1', [fanStep('execute', ['implement', 'verify']), step({ id: 'next' })])]);
      const driver: FanOutDriver & { lanes: unknown[] } = {
        lanes: [],
        resolveItems() {
          throw new Error('SQLITE_BUSY: database is locked');
        },
        driveLane() {
          throw new Error('driveLane must not be reached when resolveItems throws');
        },
      };
      const runner = makeRunner();

      const result = await new WorkflowController(runner, makeFanHost(driver)).run('r', d);

      expect(result.outcome).toBe('completed');
      // Degraded to the normal single-step path: the outer step ran once, no lanes driven.
      expect(runner.calls.filter((c) => c.id === 'execute').length).toBe(1);
      expect(driver.lanes).toEqual([]);
      expect(runner.calls.map((c) => c.id)).toEqual(['execute', 'next']);
    });

    it('runs a fanOut step as a normal step when host.fanOut is undefined', async () => {
      const d = def([phase('p1', [fanStep('execute', ['implement', 'verify'])])]);
      const runner = makeRunner();

      // No driver on the host ⇒ the fanOut field is inert.
      const result = await new WorkflowController(runner, makeFanHost(undefined)).run('r', d);

      expect(result.outcome).toBe('completed');
      expect(runner.calls.filter((c) => c.id === 'execute').length).toBe(1);
    });

    // ── A fanOut OUTER step that ALSO carries a trailing human checkpoint
    //    (human: true) / outer loopback must route through the SAME gate logic
    //    the normal agent path uses — it must NOT silently drop the gate. ──────
    it('opens the trailing human gate after a fanOut step settles, advancing on approve', async () => {
      const d = def([
        phase('p1', [
          step({ id: 'execute', agent: 'orchestrate', human: true, fanOut: { over: 'tasks', inner: [{ id: 'implement', agent: 'implement' }] } }),
          step({ id: 'next' }),
        ]),
      ]);
      const driver = makeFanOutDriver(['t1', 't2']);
      const host = makeHost({ execute: ['approve'] });
      host.fanOut = driver;
      const runner = makeRunner();

      const result = await new WorkflowController(runner, host).run('r', d);

      expect(result.outcome).toBe('completed');
      // The outer fanOut step opened its gate exactly once, then advanced to 'next'.
      expect(host.gateCalls).toEqual(['execute']);
      expect(result.steps.map((s) => s.stepId)).toEqual(['execute', 'next']);
      // Both lanes still integrated under the gated outer step.
      expect(driver.lanes.filter((l) => l.status === 'integrated').length).toBe(2);
    });

    it('ends the run rejected when the fanOut step trailing gate is rejected', async () => {
      const d = def([
        phase('p1', [
          step({ id: 'execute', agent: 'orchestrate', human: true, fanOut: { over: 'tasks', inner: [{ id: 'implement', agent: 'implement' }] } }),
          step({ id: 'next' }),
        ]),
      ]);
      const driver = makeFanOutDriver(['t1']);
      const host = makeHost({ execute: ['reject'] });
      host.fanOut = driver;

      const result = await new WorkflowController(makeRunner(), host).run('r', d);

      expect(result.outcome).toBe('rejected');
      expect(result.failedStepId).toBe('execute');
      expect(host.gateCalls).toEqual(['execute']);
    });

    // ── Closing-stage gate: incomplete sprint → skip verify/review → human gate ──
    it('skips the automated closing stages and goes to the human gate when a lane fails', async () => {
      // execute-tasks fans out over two items; one item's required inner step fails
      // (incompleteCount = 1). The closing stages (sprint-verify, sprint-review) must
      // be SKIPPED and the run must advance straight to the human-review gate.
      const d = def([
        phase('execute', [fanStep('execute-tasks', ['implement'])]),
        phase('review', [
          step({ id: 'sprint-verify' }),
          step({ id: 'sprint-review' }),
          step({ id: 'human-review', agent: 'human', human: true }),
        ]),
      ]);
      const driver = makeFanOutDriver(['t1', 't2']);
      // Single-shot fail on 'implement' ⇒ exactly one lane fails, the other integrates.
      const runner = makeRunner({ implement: [{ status: 'failed', error: 'boom' }] });
      const host = makeFanHost(driver);

      const result = await new WorkflowController(runner, host).run('r', d);

      // Reached the human gate (not failed/rejected) — the partial sprint is surfaced.
      expect(host.gateCalls).toEqual(['human-review']);
      expect(result.outcome).toBe('completed');
      // The automated closing stages never hit the runner …
      expect(runner.calls.some((c) => c.id === 'sprint-verify')).toBe(false);
      expect(runner.calls.some((c) => c.id === 'sprint-review')).toBe(false);
      // … and are recorded as skipped in the trace; the gate itself ran.
      const byId = Object.fromEntries(result.steps.map((s) => [s.stepId, s.outcome]));
      expect(byId['sprint-verify']).toBe('skipped');
      expect(byId['sprint-review']).toBe('skipped');
      expect(byId['human-review']).toBe('done');
    });

    it('runs the closing stages normally when every fan-out lane integrates', async () => {
      const d = def([
        phase('execute', [fanStep('execute-tasks', ['implement'])]),
        phase('review', [
          step({ id: 'sprint-verify' }),
          step({ id: 'human-review', agent: 'human', human: true }),
        ]),
      ]);
      const driver = makeFanOutDriver(['t1', 't2']);
      const runner = makeRunner(); // all ok ⇒ both lanes integrate, sprint complete
      const host = makeFanHost(driver);

      const result = await new WorkflowController(runner, host).run('r', d);

      expect(result.outcome).toBe('completed');
      // Closing stage RAN (not skipped) because the sprint is complete.
      expect(runner.calls.some((c) => c.id === 'sprint-verify')).toBe(true);
      const byId = Object.fromEntries(result.steps.map((s) => [s.stepId, s.outcome]));
      expect(byId['sprint-verify']).toBe('done');
      expect(host.gateCalls).toEqual(['human-review']);
    });
  });
});
