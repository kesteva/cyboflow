/**
 * Unit tests for WorkflowController — the deterministic DAG walker for the
 * programmatic execution model. Exercised entirely through fake StepRunner +
 * ControllerHost collaborators, so the suite pins the control-flow contract
 * (ordering, retries, intra-phase loopback budget, optional-skip, human gates,
 * terminal outcomes) without any SDK / DB / Electron dependency.
 */
import { describe, it, expect } from 'vitest';
import { WorkflowController, MAX_STEP_LOOPBACKS, MAX_VISUAL_LOOPBACKS } from '../workflowController';
import { createRunDirectives } from '../runDirectives';
import type {
  ControllerHost,
  FanOutDriver,
  HumanGateDecision,
  StepRunResult,
  StepRunner,
  SupervisorEvent,
  TaskEnqueueResult,
  TriageDecision,
  VisualGateOutcome,
  VisualVerifyGate,
} from '../types';
import type { SprintBatchTaskStatus } from '../../../../../shared/types/sprintBatch';
import { SPRINT_BATCH_CAP } from '../../../../../shared/types/sprintBatch';
import type {
  WorkflowDefinition,
  WorkflowPhase,
  WorkflowStep,
  WorkflowStepReportStatus,
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
  reports: Array<{ id: string; status: WorkflowStepReportStatus }>;
  gateCalls: string[];
} {
  const queues: Record<string, HumanGateDecision[]> = {};
  for (const [k, v] of Object.entries(gates)) queues[k] = [...v];
  const reports: Array<{ id: string; status: WorkflowStepReportStatus }> = [];
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

  describe('prior-step output handoff', () => {
    /** A runner that records the ctx.priorStepOutput each step was handed. */
    function makeHandoffRunner(texts: Record<string, string | null>): StepRunner & {
      seen: Record<string, { stepId: string; name: string; text?: string } | undefined>;
    } {
      const seen: Record<string, { stepId: string; name: string; text?: string } | undefined> = {};
      return {
        seen,
        async runStep(s, ctx) {
          seen[s.id] = ctx.priorStepOutput;
          return { status: 'ok', resultText: texts[s.id] ?? null };
        },
      };
    }

    it('hands a consuming step the previous agent step\'s final text', async () => {
      const d = def([
        phase('p', [
          step({ id: 'load', name: 'Load merged work' }),
          step({ id: 'extract', consumesPriorStepOutput: true }),
        ]),
      ]);
      const runner = makeHandoffRunner({ load: '## Merged work\n\nthe survey' });

      const result = await new WorkflowController(runner, makeHost()).run('r', d);

      expect(result.outcome).toBe('completed');
      expect(runner.seen.extract).toEqual({
        stepId: 'load',
        name: 'Load merged work',
        text: '## Merged work\n\nthe survey',
      });
    });

    it('does NOT hand it to a step that has not opted in', async () => {
      // Most steps re-derive their inputs from the repo and the database;
      // prepending the previous agent's prose to all of them would spend context
      // on text they must not treat as authoritative.
      const d = def([phase('p', [step({ id: 'load' }), step({ id: 'other' })])]);
      const runner = makeHandoffRunner({ load: 'the survey' });

      await new WorkflowController(runner, makeHost()).run('r', d);

      expect(runner.seen.other).toBeUndefined();
    });

    it('carries the output ACROSS a human gate', async () => {
      // Compound's chain is extract → approve-learnings → write-back: the gate
      // records the human's approved subset, but the learning bodies it refers
      // to come from the last AGENT step, so a gate must not break the channel.
      const d = def([
        phase('p', [
          step({ id: 'extract', name: 'Extract learnings' }),
          step({ id: 'approve', agent: 'human', human: true }),
          step({ id: 'write-back', consumesPriorStepOutput: true }),
        ]),
      ]);
      const runner = makeHandoffRunner({ extract: '## Act on\n\nthe learnings' });

      await new WorkflowController(runner, makeHost()).run('r', d);

      expect(runner.seen['write-back']).toEqual({
        stepId: 'extract',
        name: 'Extract learnings',
        text: '## Act on\n\nthe learnings',
      });
    });

    it('still names the producer when its text could not be captured', async () => {
      // The consuming prompt must distinguish "the channel failed" from "the
      // step found nothing" — so the entry is recorded with no text rather than
      // dropped.
      const d = def([
        phase('p', [step({ id: 'load', name: 'Load merged work' }), step({ id: 'extract', consumesPriorStepOutput: true })]),
      ]);
      const runner = makeHandoffRunner({ load: null });

      await new WorkflowController(runner, makeHost()).run('r', d);

      expect(runner.seen.extract).toEqual({ stepId: 'load', name: 'Load merged work' });
    });
  });

  it('calls awaitBlockingReviewItems before each step and proceeds on "proceed"', async () => {
    const d = def([phase('p1', [step({ id: 'a' }), step({ id: 'b' })])]);
    const runner = makeRunner();
    const host = makeHost();
    const gateCalls: string[] = [];
    const hostWithCheckpoint: ControllerHost = {
      ...host,
      awaitBlockingReviewItems: async () => {
        gateCalls.push('checkpoint');
        return 'proceed';
      },
    };

    const result = await new WorkflowController(runner, hostWithCheckpoint).run('r', d);

    expect(result.outcome).toBe('completed');
    // Checkpoint fires once before each of the two steps.
    expect(gateCalls).toEqual(['checkpoint', 'checkpoint']);
    expect(runner.calls.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('ends the walk canceled when a blocking-items checkpoint returns "canceled"', async () => {
    const d = def([phase('p1', [step({ id: 'a' }), step({ id: 'b' })])]);
    const runner = makeRunner();
    const host = makeHost();
    let call = 0;
    const hostWithCheckpoint: ControllerHost = {
      ...host,
      // proceed for step 'a', then cancel before step 'b'.
      awaitBlockingReviewItems: async () => (call++ === 0 ? 'proceed' : 'canceled'),
    };

    const result = await new WorkflowController(runner, hostWithCheckpoint).run('r', d);

    expect(result.outcome).toBe('canceled');
    expect(result.failedStepId).toBe('b');
    // 'a' ran; 'b' never did (parked-then-canceled before it started).
    expect(runner.calls.map((c) => c.id)).toEqual(['a']);
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
    const host = makeHost();

    const result = await new WorkflowController(runner, host).run('r', d);

    expect(result.outcome).toBe('failed');
    expect(result.failedStepId).toBe('a');
    expect(result.steps[0]).toMatchObject({ stepId: 'a', outcome: 'failed', attempts: 2, error: 'boom' });
    // 'b' never ran — the run terminated at 'a'.
    expect(runner.calls.some((c) => c.id === 'b')).toBe(false);
    // The required-failure path reports the terminal 'failed' status (not 'done'),
    // so the timeline can distinguish the failed step from a completed one.
    expect(host.reports.at(-1)).toEqual({ id: 'a', status: 'failed' });
  });

  it('skips a failing optional step and continues to completion', async () => {
    const d = def([phase('p1', [step({ id: 'a', optional: true }), step({ id: 'b' })])]);
    const runner = makeRunner({ a: [{ status: 'failed', error: 'meh' }] });
    const host = makeHost();

    const result = await new WorkflowController(runner, host).run('r', d);

    expect(result.outcome).toBe('completed');
    expect(result.steps[0]).toMatchObject({ stepId: 'a', outcome: 'skipped', attempts: 1 });
    expect(result.steps[1]).toMatchObject({ stepId: 'b', outcome: 'done' });
    // The optional-skip path reports 'skipped' for 'a' (then 'b' running → done).
    expect(host.reports).toContainEqual({ id: 'a', status: 'skipped' });
    expect(host.reports.some((r) => r.id === 'a' && r.status === 'done')).toBe(false);
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
    // A REJECTED gate rests awaiting the human's decision — it still reports 'done'
    // (NOT a 'failed'/'skipped' marker), so the timeline never shows a misleading
    // red FAILED on a gate the human declined. (reportStep collapse, decision 2.)
    expect(host.reports.at(-1)).toEqual({ id: 'gate', status: 'done' });
    expect(host.reports.some((r) => r.status === 'failed' || r.status === 'skipped')).toBe(false);
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
    ): ControllerHost & {
      events: SupervisorEvent[];
      gateCalls: string[];
      reports: Array<{ id: string; status: WorkflowStepReportStatus }>;
    } {
      const decisions = Array.isArray(decision) ? [...decision] : null;
      const gateQ: Record<string, HumanGateDecision[]> = {};
      for (const [k, v] of Object.entries(gates)) gateQ[k] = [...v];
      const events: SupervisorEvent[] = [];
      const gateCalls: string[] = [];
      const reports: Array<{ id: string; status: WorkflowStepReportStatus }> = [];
      return {
        events,
        gateCalls,
        reports,
        reportStep(id, status) {
          reports.push({ id, status });
        },
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
      // The human ACCEPTED the failure → the step is reported 'skipped' (not 'done').
      expect(host.reports).toContainEqual({ id: 'a', status: 'skipped' });
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
      // Cancellation is a run-level affair — the aborted step still reports 'done'
      // (not a 'failed'/'skipped' marker); the run's own status conveys the cancel.
      expect(host.reports.at(-1)).toEqual({ id: 'a', status: 'done' });
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

    // ── Defect 1: the resume skip set must NOT mask a DELIBERATE revisit ─────────
    it('re-runs a loopback target that is in the injected completed set (no no-op jump)', async () => {
      // p1: a, b(loopback→a). 'a' completed pre-restart (in the skip set); 'b' fails
      // once then jumps to a. WITHOUT the purge, the jump lands on the still-marked
      // 'a', skips it, and burns budget as a no-op. WITH the purge, 'a' re-runs.
      const d = def([phase('p1', [step({ id: 'a' }), step({ id: 'b', loopback: 'a' })])]);
      const runner = makeRunner({ b: [{ status: 'failed' }] }); // first b fails; rerun b ok

      const result = await new WorkflowController(runner, makeHost()).run(
        'r', d, undefined, undefined, new Set(['a']),
      );

      expect(result.outcome).toBe('completed');
      // 'a' skipped initially (in the set); b fails+jumps → a PURGED & re-runs → b ok.
      expect(runner.calls.map((x) => x.id)).toEqual(['b', 'a', 'b']);
    });

    it("re-runs a gate's revise loopback region even when its steps are in the completed set", async () => {
      // p1: a, b (agent), gate(human, loopback→a). Simulate resume-after-pause: a & b
      // were done pre-restart (in the skip set); the gate re-attaches to its still
      // pending review item (NOT in the set — a pending gate is not "completed") and
      // revises once. The revise must PURGE a & b so the revisited region re-runs,
      // and the gate must RE-PRESENT after the revisit (defect 1b — else the gate is
      // silently bypassed on resume).
      const d = def([
        phase('p1', [
          step({ id: 'a' }),
          step({ id: 'b' }),
          step({ id: 'gate', agent: 'human', human: true, loopback: 'a' }),
        ]),
      ]);
      const runner = makeRunner();
      const host = makeHost({ gate: ['revise', 'approve'] });

      const result = await new WorkflowController(runner, host).run(
        'r', d, undefined, undefined, new Set(['a', 'b']),
      );

      expect(result.outcome).toBe('completed');
      // First pass: a & b skipped (in the set); gate revises → purge → a & b re-run.
      expect(runner.calls.map((x) => x.id)).toEqual(['a', 'b']);
      // The gate re-presented after the revisit (revise, then approve).
      expect(host.gateCalls).toEqual(['gate', 'gate']);
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

  // ── operator SKIP (RunDirectives — live mid-walk steering) ───────────────────
  describe('operator skip', () => {
    it('skips a not-yet-run REQUIRED step on operator request, ADVANCING (not failing) the run', async () => {
      const d = def([phase('p1', [step({ id: 'a' }), step({ id: 'b' }), step({ id: 'c' })])]);
      const runner = makeRunner();
      const host = makeHost();
      const directives = createRunDirectives();
      directives.userSkippedStepIds.add('b'); // 'b' is required (no optional flag)

      const result = await new WorkflowController(runner, host).run('r', d, undefined, undefined, undefined, directives);

      // The run COMPLETES — an operator skip of a required step is not a failure.
      expect(result.outcome).toBe('completed');
      // 'b' never hit the runner; 'a' and 'c' did.
      expect(runner.calls.map((c) => c.id)).toEqual(['a', 'c']);
      // 'b' is recorded skipped (trace + timeline), never done.
      expect(result.steps.find((s) => s.stepId === 'b')).toMatchObject({ outcome: 'skipped' });
      expect(host.reports).toContainEqual({ id: 'b', status: 'skipped' });
      expect(host.reports.some((rp) => rp.id === 'b' && rp.status === 'done')).toBe(false);
    });

    it('marks an operator skip DELIBERATE so it is not reported as a step failure', async () => {
      // The skip carries an `error` string as its human-readable reason, which
      // would otherwise trip the programmatic-step-failed seam (CYBOFLOW-APP-H).
      const d = def([phase('p1', [step({ id: 'a' }), step({ id: 'b' })])]);
      const directives = createRunDirectives();
      directives.userSkippedStepIds.add('b');

      const result = await new WorkflowController(makeRunner(), makeHost()).run(
        'r', d, undefined, undefined, undefined, directives,
      );

      expect(result.steps.find((s) => s.stepId === 'b')).toMatchObject({
        outcome: 'skipped',
        error: 'skipped by operator',
        deliberate: true,
      });
    });

    it('runs a step normally when it was un-skipped before the walk reached it', async () => {
      const d = def([phase('p1', [step({ id: 'a' }), step({ id: 'b' })])]);
      const runner = makeRunner();
      const host = makeHost();
      const directives = createRunDirectives();
      // Skipped then un-skipped (add + delete) before the walk starts — nets to run.
      directives.userSkippedStepIds.add('b');
      directives.userSkippedStepIds.delete('b');

      const result = await new WorkflowController(runner, host).run('r', d, undefined, undefined, undefined, directives);

      expect(result.outcome).toBe('completed');
      expect(runner.calls.map((c) => c.id)).toEqual(['a', 'b']); // 'b' ran normally
      expect(host.reports.some((rp) => rp.id === 'b' && rp.status === 'skipped')).toBe(false);
    });

    it('does not skip a step whose skip was requested only AFTER the walk already ran it', async () => {
      // 'a' runs first; a mid-walk skip of 'a' arrives too late (natural no-op) —
      // and skipping 'b' (not yet reached) still takes effect on its turn.
      const d = def([phase('p1', [step({ id: 'a' }), step({ id: 'b' })])]);
      const host = makeHost();
      const directives = createRunDirectives();
      const ran: string[] = [];
      const runner: StepRunner = {
        async runStep(s) {
          ran.push(s.id);
          if (s.id === 'a') {
            // Operator skips BOTH the already-running 'a' (too late) and 'b' (in time).
            directives.userSkippedStepIds.add('a');
            directives.userSkippedStepIds.add('b');
          }
          return { status: 'ok' };
        },
      };

      const result = await new WorkflowController(runner, host).run('r', d, undefined, undefined, undefined, directives);

      expect(result.outcome).toBe('completed');
      // 'a' completed normally (skip landed too late); 'b' was skipped in time.
      expect(ran).toEqual(['a']);
      expect(host.reports).toContainEqual({ id: 'a', status: 'done' });
      expect(host.reports).toContainEqual({ id: 'b', status: 'skipped' });
    });
  });

  // ── host-driven parallel fan-out (programmatic plane) ────────────────────────
  describe('fan-out', () => {
    /** A recording fake FanOutDriver: resolves a fixed item set + logs lane writes. */
    function makeFanOutDriver(items: string[]): FanOutDriver & {
      lanes: Array<{
        itemId: string;
        status?: SprintBatchTaskStatus;
        currentStepId?: string | null;
        attempt?: number;
        allowedStepIds: readonly string[];
      }>;
    } {
      const lanes: Array<{
        itemId: string;
        status?: SprintBatchTaskStatus;
        currentStepId?: string | null;
        attempt?: number;
        allowedStepIds: readonly string[];
      }> = [];
      return {
        lanes,
        resolveItems() {
          return [...items];
        },
        driveLane({ itemId, status, currentStepId, attempt, allowedStepIds }) {
          lanes.push({ itemId, status, currentStepId, attempt, allowedStepIds });
        },
      };
    }

    /** A host carrying an injected FanOutDriver (extends makeHost). */
    function makeFanHost(driver: FanOutDriver | undefined): ReturnType<typeof makeHost> {
      const host = makeHost();
      host.fanOut = driver;
      return host;
    }

    /** `maxConcurrency` is optional (mirrors FanOutSpec) — absent ⇒ the default cap. */
    const fanStep = (id: string, innerIds: string[], maxConcurrency?: number): WorkflowStep =>
      step({
        id,
        agent: 'orchestrate',
        fanOut: {
          over: 'tasks',
          inner: innerIds.map((iid) => ({ id: iid, agent: iid })),
          ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
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

    it('sets ctx.spawnKey to `${runId}:${itemId}` on each lane (additive per-lane identity)', async () => {
      const d = def([phase('p1', [fanStep('execute', ['implement', 'verify'])])]);
      const driver = makeFanOutDriver(['t1', 't2']);
      const seen: Array<{ itemId?: string; spawnKey?: string }> = [];
      const runner: StepRunner = {
        async runStep(_s, ctx) {
          seen.push({ itemId: ctx.item?.id, spawnKey: ctx.spawnKey });
          return { status: 'ok' };
        },
      };

      const result = await new WorkflowController(runner, makeFanHost(driver)).run('run-xyz', d);

      expect(result.outcome).toBe('completed');
      // Every inner-step ctx for an item carries spawnKey = `${runId}:${itemId}`.
      for (const s of seen) {
        expect(s.spawnKey).toBe(`run-xyz:${s.itemId}`);
      }
      // Distinct lanes ⇒ distinct spawnKeys (the whole point — lanes don't share a key).
      expect(new Set(seen.map((s) => s.spawnKey))).toEqual(new Set(['run-xyz:t1', 'run-xyz:t2']));
    });

    it('settles every lane to canceled (no integration) when the signal aborts mid-flight', async () => {
      const d = def([phase('p1', [fanStep('execute', ['implement', 'verify'])])]);
      const driver = makeFanOutDriver(['t1', 't2']);
      const ac = new AbortController();
      // Abort as the first inner step runs; the SDK substrate reports a canceled
      // turn as 'aborted' (a clean drain), which the controller reads as a cancel.
      const runner: StepRunner = {
        async runStep() {
          ac.abort();
          return { status: 'aborted' };
        },
      };

      const result = await new WorkflowController(runner, makeFanHost(driver)).run('r', d, ac.signal);

      // The whole run settles canceled at the fanOut outer step — no lane integrates.
      expect(result.outcome).toBe('canceled');
      expect(result.failedStepId).toBe('execute');
      expect(driver.lanes.some((l) => l.status === 'integrated')).toBe(false);
    });

    it('respects the SPRINT_BATCH_CAP DEFAULT concurrency cap when the step declares no maxConcurrency (surplus items wait for a free slot)', async () => {
      // More items than the cap → at most SPRINT_BATCH_CAP run concurrently.
      const items = Array.from({ length: SPRINT_BATCH_CAP + 3 }, (_, k) => `t${k}`);
      const d = def([phase('p1', [fanStep('execute', ['implement'])])]); // no maxConcurrency ⇒ default
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

    it('respects a per-step fanOut.maxConcurrency override (e.g. 2) instead of the SPRINT_BATCH_CAP default', async () => {
      // More items than the declared cap → at most 2 run concurrently, even though
      // SPRINT_BATCH_CAP (5) would otherwise allow more.
      const items = Array.from({ length: 5 }, (_, k) => `t${k}`);
      const d = def([phase('p1', [fanStep('execute', ['implement'], 2)])]);
      const driver = makeFanOutDriver(items);

      let inFlight = 0;
      let maxInFlight = 0;
      const runner: StepRunner = {
        async runStep() {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((res) => setTimeout(res, 1));
          inFlight -= 1;
          return { status: 'ok' };
        },
      };

      const result = await new WorkflowController(runner, makeFanHost(driver)).run('r', d);

      expect(result.outcome).toBe('completed');
      expect(maxInFlight).toBeLessThanOrEqual(2);
      // Sanity: it actually raced at least 2 concurrently (not accidentally serial).
      expect(maxInFlight).toBeGreaterThan(1);
      const integrated = driver.lanes.filter((l) => l.status === 'integrated').map((l) => l.itemId);
      expect(new Set(integrated)).toEqual(new Set(items));
    });

    it("drives lanes fully serially when fanOut.maxConcurrency is 1 — one item's WHOLE inner chain completes before the next item starts", async () => {
      const d = def([phase('p1', [fanStep('execute', ['implement', 'verify'], 1)])]);
      const items = ['t0', 't1', 't2'];
      const driver = makeFanOutDriver(items);

      let inFlight = 0;
      let maxInFlight = 0;
      const seen: Array<{ itemId?: string; stepId: string }> = [];
      const runner: StepRunner = {
        async runStep(s, ctx) {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          seen.push({ itemId: ctx.item?.id, stepId: s.id });
          // Yield so a bugged concurrent dispatch would have a chance to overlap —
          // a passing maxInFlight === 1 here is a real serialization guarantee,
          // not an artifact of everything resolving synchronously.
          await new Promise((res) => setTimeout(res, 1));
          inFlight -= 1;
          return { status: 'ok' };
        },
      };

      const result = await new WorkflowController(runner, makeFanHost(driver)).run('r', d);

      expect(result.outcome).toBe('completed');
      expect(maxInFlight).toBe(1);
      // The recorded (item, step) order is grouped by item — t0's full 2-step
      // inner chain finishes before t1's FIRST step starts, and likewise for t2.
      expect(seen.map((s) => s.itemId)).toEqual(['t0', 't0', 't1', 't1', 't2', 't2']);
      expect(seen.map((s) => s.stepId)).toEqual([
        'implement', 'verify', 'implement', 'verify', 'implement', 'verify',
      ]);
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

    it('re-drives a declared required-inner loopback through attempt 3, persists it, and keeps siblings running', async () => {
      const d = def([
        phase('p1', [
          step({
            id: 'execute',
            agent: 'orchestrate',
            fanOut: {
              over: 'tasks',
              maxConcurrency: 2,
              inner: [
                { id: 'implement', agent: 'implement' },
                { id: 'task-verify', agent: 'task-verify', loopback: 'implement' },
              ],
            },
          }),
        ]),
      ]);
      const driver = makeFanOutDriver(['t1', 't2']);
      const calls: Array<{ itemId: string; stepId: string; attempt: number }> = [];
      const runner: StepRunner = {
        async runStep(s, ctx) {
          if (ctx.item) calls.push({ itemId: ctx.item.id, stepId: s.id, attempt: ctx.attempt });
          // t1 fails every required verification: two declared loopbacks (attempts
          // 2 and 3), then the Ship cap fails only t1's lane. t2 keeps integrating.
          if (ctx.item?.id === 't1' && s.id === 'task-verify') return { status: 'failed', error: 'verify failed' };
          return { status: 'ok' };
        },
      };

      const result = await new WorkflowController(runner, makeFanHost(driver)).run('r', d);

      expect(result.outcome).toBe('completed');
      expect(calls.filter((call) => call.itemId === 't1' && call.stepId === 'implement').map((call) => call.attempt)).toEqual([1, 2, 3]);
      expect(calls.filter((call) => call.itemId === 't2').map((call) => call.stepId)).toEqual(['implement', 'task-verify']);
      expect(
        driver.lanes
          .filter((lane) => lane.itemId === 't1' && lane.currentStepId === 'implement')
          .map((lane) => lane.attempt)
          .filter((attempt): attempt is number => attempt !== undefined),
      ).toEqual([2, 3]);
      expect(driver.lanes.filter((lane) => lane.itemId === 't1').at(-1)?.status).toBe('failed');
      expect(driver.lanes.filter((lane) => lane.itemId === 't2').at(-1)?.status).toBe('integrated');
    });

    it("gates off a closing stage (reports 'skipped') when a fan-out lane fails", async () => {
      // execute(fanOut) → review(automated). One lane's required inner step fails ⇒
      // the sprint is incomplete ⇒ the closing 'review' stage is gated off. With no
      // human gate after it, the run completes and 'review' is recorded + reported
      // 'skipped' (never hitting the runner).
      const d = def([
        phase('p1', [fanStep('execute', ['implement', 'verify']), step({ id: 'review' })]),
      ]);
      const driver = makeFanOutDriver(['t1', 't2']);
      const runner = makeRunner({ implement: [{ status: 'failed', error: 'boom' }] });
      const host = makeFanHost(driver);

      const result = await new WorkflowController(runner, host).run('r', d);

      expect(result.outcome).toBe('completed');
      expect(runner.calls.some((c) => c.id === 'review')).toBe(false); // gated off
      expect(result.steps).toContainEqual(
        expect.objectContaining({ stepId: 'review', outcome: 'skipped' }),
      );
      expect(host.reports).toContainEqual({ id: 'review', status: 'skipped' });
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

    // ── Agentless visual-verify + task-verify typed output (verification-agent
    //    redesign §5.3): task-verify composes the visual task off its captured
    //    result text; the visual-verify step spawns NO agent — the controller
    //    enqueues the task via the host capability then parks + awaits the merge
    //    gate, advancing / looping back to implement / failing the lane. ─────────
    describe('agentless visual-verify + task-verify typed output', () => {
      /** task-verify result text carrying a valid `## Visual verification task` fence. */
      function taskVerifyWithTask(summary = 'Check the UI'): string {
        const task = {
          version: 1,
          summary,
          behaviors: [{ id: 'b1', description: 'renders', expected: 'form visible' }],
        };
        return `VERDICT: PASS\n\n## Visual verification task\n\n\`\`\`json\n${JSON.stringify(task)}\n\`\`\`\n`;
      }

      /** A gate scripted with a queue of outcomes (default advance). */
      function makeVisualGate(
        outcomes: VisualGateOutcome[],
        active = true,
      ): VisualVerifyGate & { calls: Array<{ runId: string; itemId: string }> } {
        const queue = [...outcomes];
        const calls: Array<{ runId: string; itemId: string }> = [];
        return {
          calls,
          isActive: () => active,
          async awaitVerdict({ runId, itemId }) {
            calls.push({ runId, itemId });
            return queue.shift() ?? { kind: 'advance' };
          },
        };
      }

      /** A recording enqueue capability (default: always 'enqueued'). */
      function makeEnqueue(
        result: TaskEnqueueResult = { outcome: 'enqueued', requestId: 'vr-1' },
      ): {
        fn: NonNullable<ControllerHost['enqueueVisualVerification']>;
        calls: Array<{ runId: string; laneTaskRef: string; attempt: number; summary: string }>;
      } {
        const calls: Array<{ runId: string; laneTaskRef: string; attempt: number; summary: string }> = [];
        return {
          calls,
          fn: async ({ runId, task, laneTaskRef, attempt }) => {
            calls.push({ runId, laneTaskRef, attempt, summary: task.summary });
            return result;
          },
        };
      }

      /**
       * Attach a recording F8 skip sink to the host and return the log
       * (docs/proposals/visual-verification-brittleness-fixes.md §F8).
       */
      function recordSkips(
        host: ControllerHost,
      ): Array<{ runId: string; laneTaskRef: string; reason: string; detail?: string }> {
        const skips: Array<{ runId: string; laneTaskRef: string; reason: string; detail?: string }> = [];
        host.reportVerificationSkipped = (input) => {
          skips.push(input);
        };
        return skips;
      }

      /** A runner where task-verify returns a scripted resultText; other steps ok. */
      function verifyRunner(
        taskVerifyText: string | null,
        opts: { captureCtx?: Array<{ id: string; attempt: number; contractError?: string; loopbackFeedback?: string }> } = {},
      ): StepRunner & { calls: Array<{ id: string; attempt: number }> } {
        const calls: Array<{ id: string; attempt: number }> = [];
        return {
          calls,
          async runStep(s, ctx) {
            calls.push({ id: s.id, attempt: ctx.attempt });
            opts.captureCtx?.push({
              id: s.id,
              attempt: ctx.attempt,
              ...(ctx.contractError !== undefined ? { contractError: ctx.contractError } : {}),
              ...(ctx.loopbackFeedback !== undefined ? { loopbackFeedback: ctx.loopbackFeedback } : {}),
            });
            if (s.id === 'task-verify') return { status: 'ok', resultText: taskVerifyText };
            return { status: 'ok' };
          },
        };
      }

      const verifyChain = (): WorkflowStep =>
        step({
          id: 'execute',
          agent: 'orchestrate',
          fanOut: {
            over: 'tasks',
            inner: [
              { id: 'implement', agent: 'implement' },
              { id: 'task-verify', agent: 'task-verify', loopback: 'implement' },
              { id: 'visual-verify', agent: 'visual-verify' },
            ],
          },
        });

      it('PASS + task fence → enqueue (forced laneTaskRef + attempt), park, gate advance → integrated', async () => {
        const d = def([phase('p1', [verifyChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        host.visualGate = makeVisualGate([{ kind: 'advance' }]);
        const enqueue = makeEnqueue();
        host.enqueueVisualVerification = enqueue.fn;
        const runner = verifyRunner(taskVerifyWithTask());

        const result = await new WorkflowController(runner, host).run('run-9', d);

        expect(result.outcome).toBe('completed');
        // Enqueue was called with the lane's authoritative ref + attempt 1.
        expect(enqueue.calls).toEqual([{ runId: 'run-9', laneTaskRef: 't1', attempt: 1, summary: 'Check the UI' }]);
        // visual-verify spawned NO agent (agentless).
        expect(runner.calls.some((c) => c.id === 'visual-verify')).toBe(false);
        // Lane parked at awaiting-verify then integrated.
        const steps = driver.lanes.filter((l) => l.itemId === 't1').map((l) => l.currentStepId);
        expect(steps).toContain('awaiting-verify');
        expect(driver.lanes.filter((l) => l.itemId === 't1').pop()?.status).toBe('integrated');
      });

      it('PASS + NOT-APPLICABLE → no enqueue, no park, lane integrates', async () => {
        const d = def([phase('p1', [verifyChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        host.visualGate = makeVisualGate([]);
        const enqueue = makeEnqueue();
        host.enqueueVisualVerification = enqueue.fn;
        const runner = verifyRunner('VERDICT: PASS\n\nVISUAL-VERIFICATION: NOT-APPLICABLE — no user-visible UI\n');

        const result = await new WorkflowController(runner, host).run('r', d);

        expect(result.outcome).toBe('completed');
        expect(enqueue.calls.length).toBe(0);
        expect(driver.lanes.some((l) => l.currentStepId === 'awaiting-verify')).toBe(false);
        expect(driver.lanes.filter((l) => l.itemId === 't1').pop()?.status).toBe('integrated');
      });

      it('enqueue outcome "skipped" → advance WITHOUT parking, lane integrates', async () => {
        const d = def([phase('p1', [verifyChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        host.visualGate = makeVisualGate([]);
        const enqueue = makeEnqueue({ outcome: 'skipped', reason: 'verification-disabled' });
        host.enqueueVisualVerification = enqueue.fn;
        const skips = recordSkips(host);
        const runner = verifyRunner(taskVerifyWithTask());

        const result = await new WorkflowController(runner, host).run('r', d);

        expect(result.outcome).toBe('completed');
        expect(enqueue.calls.length).toBe(1);
        // Skipped → never parked.
        expect(driver.lanes.some((l) => l.currentStepId === 'awaiting-verify')).toBe(false);
        expect(driver.lanes.filter((l) => l.itemId === 't1').pop()?.status).toBe('integrated');
        // F8: 'verification-disabled' is a DELIBERATE off switch — no finding.
        expect(skips).toEqual([]);
      });

      // ── F8 "never skip silently" (docs/proposals/visual-verification-
      //    brittleness-fixes.md): the two PRE-ROW drops raise a non-blocking
      //    finding. Gate-side skips already write a 'skipped' row + a
      //    verdictDelivery finding; these two write nothing at all. ──
      it('F8: enqueue "skipped" for any OTHER reason files a non-blocking finding, lane still integrates', async () => {
        const d = def([phase('p1', [verifyChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        host.visualGate = makeVisualGate([]);
        host.enqueueVisualVerification = makeEnqueue({ outcome: 'skipped', reason: 'scheduler-unavailable' }).fn;
        const skips = recordSkips(host);
        const runner = verifyRunner(taskVerifyWithTask());

        const result = await new WorkflowController(runner, host).run('run-f8', d);

        expect(result.outcome).toBe('completed');
        expect(skips.length).toBe(1);
        expect(skips[0]).toMatchObject({ runId: 'run-f8', laneTaskRef: 't1', reason: 'scheduler-unavailable' });
        // Advancement is untouched — the finding is strictly weaker than the walk.
        expect(driver.lanes.filter((l) => l.itemId === 't1').pop()?.status).toBe('integrated');
      });

      it('F8: files at most ONE finding per lane even when the lane loops back', async () => {
        // Both F8 seams sit inside the fan-out INNER-STEP walk, which a lane
        // re-enters on every loopback. On a substrate that never captures step
        // text the channel-unavailable branch fires on EVERY attempt — without
        // per-lane de-duplication an 8-lane sprint looping twice would post 24
        // byte-identical review-queue cards, and these findings carry no
        // requestId to correlate or supersede on (there is no request row).
        const d = def([
          phase('p1', [
            step({
              id: 'execute',
              agent: 'orchestrate',
              fanOut: {
                over: 'tasks',
                inner: [
                  { id: 'implement', agent: 'implement' },
                  { id: 'task-verify', agent: 'task-verify', loopback: 'implement' },
                  { id: 'code-review', agent: 'code-review', loopback: 'implement' },
                  { id: 'visual-verify', agent: 'visual-verify' },
                ],
              },
            }),
          ]),
        ]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        host.visualGate = makeVisualGate([]);
        const skips = recordSkips(host);
        // task-verify NEVER captures result text (the codex substrate), and
        // code-review — which runs AFTER it — returns a blocking defect on its
        // first pass, so the lane loops back and task-verify runs a second time.
        const calls: string[] = [];
        let reviewPass = 0;
        const runner: StepRunner = {
          async runStep(sp) {
            calls.push(sp.id);
            if (sp.id === 'task-verify') return { status: 'ok', resultText: null };
            if (sp.id === 'code-review') {
              reviewPass += 1;
              return {
                status: 'ok',
                resultText: reviewPass === 1 ? '## Blocking defect\nfix it' : 'no blocking defects',
              };
            }
            return { status: 'ok' };
          },
        };

        const result = await new WorkflowController(runner, host).run('run-dupe', d);

        expect(result.outcome).toBe('completed');
        // The loopback really happened — task-verify dropped its task TWICE...
        expect(calls.filter((id) => id === 'task-verify').length).toBeGreaterThan(1);
        // ...and exactly ONE finding reached the human.
        expect(skips.length).toBe(1);
        expect(skips[0]).toMatchObject({ runId: 'run-dupe', laneTaskRef: 't1' });
      });

      it('F8: a THROWING finding sink never disturbs lane advancement', async () => {
        const d = def([phase('p1', [verifyChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        host.visualGate = makeVisualGate([]);
        host.enqueueVisualVerification = makeEnqueue({ outcome: 'skipped', reason: 'scheduler-unavailable' }).fn;
        host.reportVerificationSkipped = () => {
          throw new Error('review queue down');
        };
        const runner = verifyRunner(taskVerifyWithTask());

        const result = await new WorkflowController(runner, host).run('r', d);

        expect(result.outcome).toBe('completed');
        expect(driver.lanes.filter((l) => l.itemId === 't1').pop()?.status).toBe('integrated');
      });

      it('missing/contract-error fence → task-verify re-runs ONCE with contractError in ctx, then success continues', async () => {
        const d = def([phase('p1', [verifyChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        host.visualGate = makeVisualGate([{ kind: 'advance' }]);
        const enqueue = makeEnqueue();
        host.enqueueVisualVerification = enqueue.fn;
        // First task-verify: PASS but NO fence (contract defect). On the re-run the
        // runner returns a valid fence, so the lane then completes.
        const captureCtx: Array<{ id: string; attempt: number; contractError?: string; loopbackFeedback?: string }> = [];
        let taskVerifyCall = 0;
        const runner: StepRunner & { calls: Array<{ id: string; attempt: number }> } = {
          calls: [],
          async runStep(s, ctx) {
            this.calls.push({ id: s.id, attempt: ctx.attempt });
            captureCtx.push({
              id: s.id,
              attempt: ctx.attempt,
              ...(ctx.contractError !== undefined ? { contractError: ctx.contractError } : {}),
            });
            if (s.id === 'task-verify') {
              taskVerifyCall += 1;
              return taskVerifyCall === 1
                ? { status: 'ok', resultText: 'VERDICT: PASS\n\n(no visual section here)\n' }
                : { status: 'ok', resultText: taskVerifyWithTask() };
            }
            return { status: 'ok' };
          },
        };

        const result = await new WorkflowController(runner, host).run('r', d);

        expect(result.outcome).toBe('completed');
        // task-verify ran twice; the SECOND ctx carried a contractError.
        expect(runner.calls.filter((c) => c.id === 'task-verify').length).toBe(2);
        const reRun = captureCtx.filter((c) => c.id === 'task-verify')[1];
        expect(reRun?.contractError).toBeDefined();
        // The re-run composed a task → enqueue fired once → lane integrated.
        expect(enqueue.calls.length).toBe(1);
        expect(driver.lanes.filter((l) => l.itemId === 't1').pop()?.status).toBe('integrated');
      });

      it('a SECOND visual-verification contract failure fails the lane', async () => {
        const d = def([phase('p1', [verifyChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        host.visualGate = makeVisualGate([]);
        const enqueue = makeEnqueue();
        host.enqueueVisualVerification = enqueue.fn;
        // task-verify NEVER emits a valid fence → contract fails twice → lane fails.
        const runner = verifyRunner('VERDICT: PASS\n\n(never any visual section)\n');

        const result = await new WorkflowController(runner, host).run('r', d);

        expect(result.outcome).toBe('completed'); // outer step still settles
        expect(runner.calls.filter((c) => c.id === 'task-verify').length).toBe(2);
        expect(enqueue.calls.length).toBe(0);
        expect(driver.lanes.filter((l) => l.itemId === 't1').map((l) => l.status)).toContain('failed');
        expect(driver.lanes.filter((l) => l.itemId === 't1').map((l) => l.status)).not.toContain('integrated');
      });

      it('contract failure + LIVE lane request → ADOPTS it: no retry, no enqueue, parks, gate advance → integrated', async () => {
        // Pre-fired hijack (live smoke 2026-07-22): the task-verify turn fired
        // cyboflow_request_verification itself instead of printing the fence.
        const d = def([phase('p1', [verifyChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        const probeCalls: Array<{ runId: string; itemId: string }> = [];
        host.visualGate = {
          ...makeVisualGate([{ kind: 'advance' }]),
          hasLiveRequestForLane: (runId: string, itemId: string) => {
            probeCalls.push({ runId, itemId });
            return true;
          },
        };
        const enqueue = makeEnqueue();
        host.enqueueVisualVerification = enqueue.fn;
        // PASS but NO fence and NO NOT-APPLICABLE line — the hijacker's summary.
        const runner = verifyRunner('VERDICT: PASS\n\nFired async visual verification and parked the lane.\n');

        const result = await new WorkflowController(runner, host).run('run-a', d);

        expect(result.outcome).toBe('completed');
        // Adopted: task-verify ran ONCE (no contract re-run), nothing enqueued.
        expect(runner.calls.filter((c) => c.id === 'task-verify').length).toBe(1);
        expect(enqueue.calls.length).toBe(0);
        expect(probeCalls).toEqual([{ runId: 'run-a', itemId: 't1' }]);
        // Parked on the adopted request, then the gate advanced → integrated.
        const lanes = driver.lanes.filter((l) => l.itemId === 't1');
        expect(lanes.map((l) => l.currentStepId)).toContain('awaiting-verify');
        expect(lanes.pop()?.status).toBe('integrated');
      });

      it('contract failure with NO live request (probe false) → retries as before, never adopts', async () => {
        // A terminal/stale request must not preempt the retry: the probe is
        // LIVE-only, so false ⇒ the normal one-retry-then-fail path.
        const d = def([phase('p1', [verifyChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        host.visualGate = { ...makeVisualGate([]), hasLiveRequestForLane: () => false };
        const enqueue = makeEnqueue();
        host.enqueueVisualVerification = enqueue.fn;
        const runner = verifyRunner('VERDICT: PASS\n\n(never any visual section)\n');

        const result = await new WorkflowController(runner, host).run('r', d);

        expect(result.outcome).toBe('completed');
        expect(runner.calls.filter((c) => c.id === 'task-verify').length).toBe(2);
        expect(enqueue.calls.length).toBe(0);
        expect(driver.lanes.some((l) => l.currentStepId === 'awaiting-verify')).toBe(false);
        expect(driver.lanes.filter((l) => l.itemId === 't1').map((l) => l.status)).toContain('failed');
      });

      it('task-verify VERDICT: FAIL → loopback to implement with the bumped attempt', async () => {
        const d = def([phase('p1', [verifyChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        host.visualGate = makeVisualGate([{ kind: 'advance' }]);
        const enqueue = makeEnqueue();
        host.enqueueVisualVerification = enqueue.fn;
        // First task-verify FAILs (loopback → implement @2); second PASSes with a task.
        let tv = 0;
        const runner: StepRunner & { calls: Array<{ id: string; attempt: number }> } = {
          calls: [],
          async runStep(s, ctx) {
            this.calls.push({ id: s.id, attempt: ctx.attempt });
            if (s.id === 'task-verify') {
              tv += 1;
              return tv === 1
                ? { status: 'ok', resultText: 'VERDICT: FAIL\n\ncriterion 2 not met\n' }
                : { status: 'ok', resultText: taskVerifyWithTask() };
            }
            return { status: 'ok' };
          },
        };

        const result = await new WorkflowController(runner, host).run('r', d);

        expect(result.outcome).toBe('completed');
        // implement re-ran at attempt 2 (the FAIL loopback bumped the lane attempt).
        expect(runner.calls.filter((c) => c.id === 'implement').map((c) => c.attempt)).toEqual([1, 2]);
        // The re-verify composed a task → enqueue fired at the BUMPED attempt.
        expect(enqueue.calls).toEqual([{ runId: 'r', laneTaskRef: 't1', attempt: 2, summary: 'Check the UI' }]);
        expect(driver.lanes.filter((l) => l.itemId === 't1').pop()?.status).toBe('integrated');
      });

      it('resultText null (channel unavailable) → visual verification SKIPPED, lane integrates', async () => {
        const d = def([phase('p1', [verifyChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        host.visualGate = makeVisualGate([]);
        const enqueue = makeEnqueue();
        host.enqueueVisualVerification = enqueue.fn;
        const skips = recordSkips(host);
        const runner = verifyRunner(null); // task-verify captured no text

        const result = await new WorkflowController(runner, host).run('r', d);

        expect(result.outcome).toBe('completed');
        expect(enqueue.calls.length).toBe(0);
        expect(driver.lanes.some((l) => l.currentStepId === 'awaiting-verify')).toBe(false);
        expect(driver.lanes.filter((l) => l.itemId === 't1').pop()?.status).toBe('integrated');
        // F8: the drop happens BEFORE any request row exists, so it is invisible
        // everywhere unless the controller says so.
        expect(skips.length).toBe(1);
        expect(skips[0].laneTaskRef).toBe('t1');
        expect(skips[0].reason).toContain('no result text');
      });

      it('F8: an INACTIVE visual gate files no channel-unavailable finding', async () => {
        const d = def([phase('p1', [verifyChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        host.visualGate = makeVisualGate([], false); // present but inactive
        host.enqueueVisualVerification = makeEnqueue().fn;
        const skips = recordSkips(host);

        const result = await new WorkflowController(verifyRunner(null), host).run('r', d);

        expect(result.outcome).toBe('completed');
        expect(skips).toEqual([]);
      });

      // ── Disabled-run verdict enforcement: the functional VERDICT channel is
      //    orthogonal to visual verification — turning the visual gate off must
      //    not turn off the FAIL loopback (disabled-run FAIL-invisibility fix). ──
      it('visual gate INACTIVE: VERDICT: FAIL still loops back to implement, then PASS integrates', async () => {
        const d = def([phase('p1', [verifyChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        host.visualGate = makeVisualGate([], false); // present but inactive
        const enqueue = makeEnqueue();
        host.enqueueVisualVerification = enqueue.fn;
        let tv = 0;
        const runner: StepRunner & { calls: Array<{ id: string; attempt: number }> } = {
          calls: [],
          async runStep(s, ctx) {
            this.calls.push({ id: s.id, attempt: ctx.attempt });
            if (s.id === 'task-verify') {
              tv += 1;
              return tv === 1
                ? { status: 'ok', resultText: 'VERDICT: FAIL\n\ncriterion 2 not met\n' }
                : { status: 'ok', resultText: 'VERDICT: PASS\n\nall criteria met\n' };
            }
            return { status: 'ok' };
          },
        };

        const result = await new WorkflowController(runner, host).run('r', d);

        expect(result.outcome).toBe('completed');
        // The FAIL loopback bumped the lane attempt exactly as on an active run.
        expect(runner.calls.filter((c) => c.id === 'implement').map((c) => c.attempt)).toEqual([1, 2]);
        // No visual machinery engaged: nothing enqueued, no awaiting-verify park.
        expect(enqueue.calls.length).toBe(0);
        expect(driver.lanes.some((l) => l.currentStepId === 'awaiting-verify')).toBe(false);
        expect(driver.lanes.filter((l) => l.itemId === 't1').pop()?.status).toBe('integrated');
      });

      it('visual gate ABSENT: persistent VERDICT: FAIL exhausts the attempt cap and fails the lane', async () => {
        const d = def([phase('p1', [verifyChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        host.visualGate = undefined;
        const runner = verifyRunner('VERDICT: FAIL\n\nnever meets criteria\n');

        const result = await new WorkflowController(runner, host).run('r', d);

        // A failed lane never fails the run (fan-out partial-success semantics).
        expect(result.outcome).toBe('completed');
        // Loopback re-ran implement until the attempt cap, then the lane failed.
        expect(runner.calls.filter((c) => c.id === 'implement').map((c) => c.attempt)).toEqual([1, 2, 3]);
        expect(driver.lanes.filter((l) => l.itemId === 't1').pop()?.status).toBe('failed');
      });

      it('visual gate INACTIVE: PASS with NO fence is lenient — no contract re-run, lane integrates', async () => {
        const d = def([phase('p1', [verifyChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        host.visualGate = makeVisualGate([], false);
        const enqueue = makeEnqueue();
        host.enqueueVisualVerification = enqueue.fn;
        const runner = verifyRunner('VERDICT: PASS\n\n(no visual section here)\n');

        const result = await new WorkflowController(runner, host).run('r', d);

        expect(result.outcome).toBe('completed');
        // Exactly ONE task-verify turn — the §5.1 contract retry never engaged.
        expect(runner.calls.filter((c) => c.id === 'task-verify').length).toBe(1);
        expect(enqueue.calls.length).toBe(0);
        expect(driver.lanes.filter((l) => l.itemId === 't1').pop()?.status).toBe('integrated');
      });

      it('gate loopback carrying feedback → the re-driven implement ctx has loopbackFeedback', async () => {
        const d = def([phase('p1', [verifyChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        host.visualGate = makeVisualGate([{ kind: 'loopback', attempt: 2, feedback: 'Behavior b1: button never appeared' }, { kind: 'advance' }]);
        const enqueue = makeEnqueue();
        host.enqueueVisualVerification = enqueue.fn;
        const captureCtx: Array<{ id: string; attempt: number; loopbackFeedback?: string }> = [];
        const runner = verifyRunner(taskVerifyWithTask(), { captureCtx });

        const result = await new WorkflowController(runner, host).run('r', d);

        expect(result.outcome).toBe('completed');
        // implement re-ran at attempt 2, and THAT ctx carried the gate's feedback.
        const reImplement = captureCtx.filter((c) => c.id === 'implement' && c.attempt === 2)[0];
        expect(reImplement?.loopbackFeedback).toBe('Behavior b1: button never appeared');
        // The FIRST implement carried no feedback.
        const firstImplement = captureCtx.filter((c) => c.id === 'implement' && c.attempt === 1)[0];
        expect(firstImplement?.loopbackFeedback).toBeUndefined();
        expect(driver.lanes.filter((l) => l.itemId === 't1').pop()?.status).toBe('integrated');
      });

      it('loopback → a FRESH task fence re-enqueues at the BUMPED attempt (a new idempotency key)', async () => {
        const d = def([phase('p1', [verifyChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        // First verdict loops back (attempt 2), second advances → two enqueues.
        host.visualGate = makeVisualGate([{ kind: 'loopback', attempt: 2 }, { kind: 'advance' }]);
        const enqueue = makeEnqueue();
        host.enqueueVisualVerification = enqueue.fn;
        const runner = verifyRunner(taskVerifyWithTask());

        const result = await new WorkflowController(runner, host).run('r', d);

        expect(result.outcome).toBe('completed');
        // Two enqueues: attempt 1 then attempt 2 (a fresh key on the re-walk).
        expect(enqueue.calls.map((c) => c.attempt)).toEqual([1, 2]);
        expect(driver.lanes.filter((l) => l.itemId === 't1').pop()?.status).toBe('integrated');
      });

      it('fails the lane when the merge-gate returns failed (cap reached)', async () => {
        const d = def([phase('p1', [verifyChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        host.visualGate = makeVisualGate([{ kind: 'failed' }]);
        host.enqueueVisualVerification = makeEnqueue().fn;
        const runner = verifyRunner(taskVerifyWithTask());

        const result = await new WorkflowController(runner, host).run('r', d);

        expect(result.outcome).toBe('completed');
        const laneStatuses = driver.lanes.filter((l) => l.itemId === 't1').map((l) => l.status);
        expect(laneStatuses).toContain('failed');
        expect(laneStatuses).not.toContain('integrated');
      });

      it('does NOT enqueue or park when the gate is inactive for the run (byte-identical)', async () => {
        const d = def([phase('p1', [verifyChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        const gate = makeVisualGate([], /* active */ false);
        host.visualGate = gate;
        const enqueue = makeEnqueue();
        host.enqueueVisualVerification = enqueue.fn;
        const runner = verifyRunner(taskVerifyWithTask());

        const result = await new WorkflowController(runner, host).run('r', d);

        expect(result.outcome).toBe('completed');
        // Inactive → task-verify output ignored, no enqueue, never parked.
        expect(enqueue.calls.length).toBe(0);
        expect(gate.calls.length).toBe(0);
        expect(driver.lanes.some((l) => l.currentStepId === 'awaiting-verify')).toBe(false);
        expect(driver.lanes.filter((l) => l.itemId === 't1').pop()?.status).toBe('integrated');
      });

      it('aborts the lane when the gate resolves aborted (run canceled while awaiting)', async () => {
        const d = def([phase('p1', [verifyChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        host.visualGate = makeVisualGate([{ kind: 'aborted' }]);
        host.enqueueVisualVerification = makeEnqueue().fn;
        const runner = verifyRunner(taskVerifyWithTask());

        const result = await new WorkflowController(runner, host).run('r', d);

        expect(result.outcome).toBe('canceled');
        expect(driver.lanes.filter((l) => l.itemId === 't1').pop()?.status).not.toBe('integrated');
      });

      it('fails the lane after the MAX_VISUAL_LOOPBACKS backstop (never spins forever)', async () => {
        const d = def([phase('p1', [verifyChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        host.visualGate = makeVisualGate(
          Array.from({ length: MAX_VISUAL_LOOPBACKS + 5 }, () => ({ kind: 'loopback', attempt: 2 }) as VisualGateOutcome),
        );
        host.enqueueVisualVerification = makeEnqueue().fn;
        const runner = verifyRunner(taskVerifyWithTask());

        const result = await new WorkflowController(runner, host).run('r', d);

        expect(result.outcome).toBe('completed');
        expect(driver.lanes.filter((l) => l.itemId === 't1').map((l) => l.status)).toContain('failed');
      });
    });

    // ── Code-review verdict channel (Item 0): a CLEAN (status:'ok') code-review
    //    turn that lists `## Blocking` defects must loop the lane back to implement
    //    on the programmatic plane — WITHOUT this the defects ship unfixed. Mirrors
    //    the task-verify VERDICT channel. ──────────────────────────────────────
    describe('code-review verdict channel (Item 0)', () => {
      // implement → code-review (loopback: implement). A review runner scripts the
      // code-review result text; implement + any other step returns bare ok.
      const reviewChain = (): WorkflowStep =>
        step({
          id: 'execute',
          agent: 'orchestrate',
          fanOut: {
            over: 'tasks',
            inner: [
              { id: 'implement', agent: 'implement' },
              { id: 'code-review', agent: 'code-review', loopback: 'implement' },
            ],
          },
        });

      /** A runner where code-review returns scripted resultText per call; others ok. */
      function reviewRunner(
        texts: Array<string | null>,
        capture?: Array<{ id: string; attempt: number; loopbackFeedback?: string }>,
      ): StepRunner & { calls: Array<{ id: string; attempt: number }> } {
        const calls: Array<{ id: string; attempt: number }> = [];
        let cr = 0;
        return {
          calls,
          async runStep(s, ctx) {
            calls.push({ id: s.id, attempt: ctx.attempt });
            capture?.push({
              id: s.id,
              attempt: ctx.attempt,
              ...(ctx.loopbackFeedback !== undefined ? { loopbackFeedback: ctx.loopbackFeedback } : {}),
            });
            if (s.id === 'code-review') {
              const t = texts[Math.min(cr, texts.length - 1)];
              cr += 1;
              return { status: 'ok', resultText: t };
            }
            return { status: 'ok' };
          },
        };
      }

      it('REVIEW: BLOCKING → loopback to implement @2 threading the ## Blocking section, then CLEAN integrates', async () => {
        const d = def([phase('p1', [reviewChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        const capture: Array<{ id: string; attempt: number; loopbackFeedback?: string }> = [];
        const runner = reviewRunner(
          [
            '## Findings\nNo findings.\n\n## Blocking\n- src/foo.ts:12 — off-by-one in the loop bound\n\nREVIEW: BLOCKING\n',
            '## Findings\nNo findings.\n\nREVIEW: CLEAN\n',
          ],
          capture,
        );

        const result = await new WorkflowController(runner, host).run('r', d);

        expect(result.outcome).toBe('completed');
        // implement re-ran at attempt 2 (the BLOCKING loopback bumped the lane attempt).
        expect(runner.calls.filter((c) => c.id === 'implement').map((c) => c.attempt)).toEqual([1, 2]);
        // The re-driven implement carried the extracted ## Blocking section as feedback.
        const reImplement = capture.filter((c) => c.id === 'implement' && c.attempt === 2)[0];
        expect(reImplement?.loopbackFeedback).toBe('- src/foo.ts:12 — off-by-one in the loop bound');
        expect(driver.lanes.filter((l) => l.itemId === 't1').pop()?.status).toBe('integrated');
      });

      it('persistent REVIEW: BLOCKING exhausts the attempt cap and fails the lane', async () => {
        const d = def([phase('p1', [reviewChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        const runner = reviewRunner(['## Blocking\n- still broken\n\nREVIEW: BLOCKING\n']);

        const result = await new WorkflowController(runner, host).run('r', d);

        // A failed lane never fails the run (fan-out partial-success semantics).
        expect(result.outcome).toBe('completed');
        // Loopback re-ran implement until the attempt cap, then the lane failed.
        expect(runner.calls.filter((c) => c.id === 'implement').map((c) => c.attempt)).toEqual([1, 2, 3]);
        expect(driver.lanes.filter((l) => l.itemId === 't1').pop()?.status).toBe('failed');
      });

      it('REVIEW: CLEAN → no loopback, lane integrates', async () => {
        const d = def([phase('p1', [reviewChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        const runner = reviewRunner(['## Findings\nNo findings.\n\nREVIEW: CLEAN\n']);

        const result = await new WorkflowController(runner, host).run('r', d);

        expect(result.outcome).toBe('completed');
        expect(runner.calls.filter((c) => c.id === 'implement').length).toBe(1);
        expect(driver.lanes.filter((l) => l.itemId === 't1').pop()?.status).toBe('integrated');
      });

      it('no REVIEW line / null result text (channel unavailable) → treated CLEAN, lane integrates', async () => {
        const d = def([phase('p1', [reviewChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        // A substrate that captured no final text, and one that emitted findings but
        // no verdict line — both must advance, never wedge.
        const runnerNull = reviewRunner([null]);
        const resultNull = await new WorkflowController(runnerNull, makeFanHost(makeFanOutDriver(['t1']))).run('r1', d);
        expect(resultNull.outcome).toBe('completed');

        const runnerNoLine = reviewRunner(['## Findings\n- minor nit at foo.ts:1 (out of scope)\n']);
        const result = await new WorkflowController(runnerNoLine, host).run('r2', d);
        expect(result.outcome).toBe('completed');
        expect(runnerNoLine.calls.filter((c) => c.id === 'implement').length).toBe(1);
        expect(driver.lanes.filter((l) => l.itemId === 't1').pop()?.status).toBe('integrated');
      });

      it('## Blocking section with NO REVIEW trailer (dropped trailer) → fail-safe loopback', async () => {
        const d = def([phase('p1', [reviewChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        const capture: Array<{ id: string; attempt: number; loopbackFeedback?: string }> = [];
        // A truncated / forgetful SDK turn: real `## Blocking` defects, but the
        // required machine `REVIEW:` last line is MISSING. The fail-safe must still
        // loop back so the defect can't ship just because the trailer was lost.
        const runner = reviewRunner(
          [
            '## Findings\nNo findings.\n\n## Blocking\n- src/foo.ts:12 — off-by-one\n',
            '## Findings\nNo findings.\n\nREVIEW: CLEAN\n',
          ],
          capture,
        );

        const result = await new WorkflowController(runner, host).run('r', d);

        expect(result.outcome).toBe('completed');
        expect(runner.calls.filter((c) => c.id === 'implement').map((c) => c.attempt)).toEqual([1, 2]);
        // The section (sans trailer) is threaded into the re-driven implement.
        const reImplement = capture.filter((c) => c.id === 'implement' && c.attempt === 2)[0];
        expect(reImplement?.loopbackFeedback).toBe('- src/foo.ts:12 — off-by-one');
        expect(driver.lanes.filter((l) => l.itemId === 't1').pop()?.status).toBe('integrated');
      });

      it('REVIEW: CLEAN with an empty "## Blocking" heading (template) → trusts the verdict, no loopback', async () => {
        const d = def([phase('p1', [reviewChain()])]);
        const driver = makeFanOutDriver(['t1']);
        const host = makeFanHost(driver);
        // An EXPLICIT CLEAN trailer wins even if the template prints an empty
        // "## Blocking" heading — the fail-safe covers only the AMBIGUOUS no-trailer
        // case, never an explicit clean verdict.
        const runner = reviewRunner(['## Findings\nNo findings.\n\n## Blocking\n\nREVIEW: CLEAN\n']);

        const result = await new WorkflowController(runner, host).run('r', d);

        expect(result.outcome).toBe('completed');
        expect(runner.calls.filter((c) => c.id === 'implement').length).toBe(1);
        expect(driver.lanes.filter((l) => l.itemId === 't1').pop()?.status).toBe('integrated');
      });
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

      // Both closing-stage skips are DELIBERATE control flow, not defects — the
      // flag keeps them off the programmatic-step-failed seam even though they
      // carry a reason string (CYBOFLOW-APP-H).
      expect(result.steps.find((s) => s.stepId === 'sprint-verify')).toMatchObject({ deliberate: true });
      expect(result.steps.find((s) => s.stepId === 'sprint-review')).toMatchObject({ deliberate: true });
      // The lane failure that CAUSED the gating is a real failure and must not
      // be marked deliberate.
      expect(result.steps.find((s) => s.outcome === 'failed')?.deliberate).toBeUndefined();
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

    // ── DAG-aware pool scheduling (driver.dependencies) ─────────────────────────
    it('dispatches a task only after its blocking prerequisite integrates', async () => {
      // t2 and t3 both depend on t1 ⇒ t1 dispatches alone; t2 and t3 only once it integrates.
      const d = def([phase('p1', [fanStep('execute', ['implement'])])]);
      const base = makeFanOutDriver(['t1', 't2', 't3']);
      const driver: FanOutDriver = {
        ...base,
        dependencies: () =>
          new Map([
            ['t2', ['t1']],
            ['t3', ['t1']],
          ]),
      };
      const order: string[] = [];
      const runner: StepRunner = {
        async runStep(_s, ctx) {
          if (ctx.item) order.push(ctx.item.id);
          return { status: 'ok' };
        },
      };
      const host = makeFanHost(driver);

      const result = await new WorkflowController(runner, host).run('r', d);

      expect(result.outcome).toBe('completed');
      // t1 ran FIRST (alone); t2 & t3 only after it integrated.
      expect(order[0]).toBe('t1');
      expect(new Set(order.slice(1))).toEqual(new Set(['t2', 't3']));
      // Every lane integrated.
      const integrated = base.lanes.filter((l) => l.status === 'integrated').map((l) => l.itemId);
      expect(new Set(integrated)).toEqual(new Set(['t1', 't2', 't3']));
    });

    it("settles a dependent task 'blocked' (never 'failed') when its prerequisite fails", async () => {
      const d = def([phase('p1', [fanStep('execute', ['implement'])])]);
      const base = makeFanOutDriver(['t1', 't2']);
      const driver: FanOutDriver = { ...base, dependencies: () => new Map([['t2', ['t1']]]) };
      const order: string[] = [];
      const runner: StepRunner = {
        async runStep(_s, ctx) {
          if (ctx.item) order.push(ctx.item.id);
          return ctx.item?.id === 't1' ? { status: 'failed', error: 'boom' } : { status: 'ok' };
        },
      };
      const host = makeFanHost(driver);

      const result = await new WorkflowController(runner, host).run('r', d);

      expect(result.outcome).toBe('completed'); // a failed/blocked lane is non-terminal
      // t1 ran (and failed); t2 was NEVER dispatched (blocked by t1).
      expect(order).toEqual(['t1']);
      // Only the lane that actually ran is 'failed'. t2 never started, so it is
      // 'blocked' — one real failure must not read as two.
      expect(base.lanes.filter((l) => l.status === 'failed').map((l) => l.itemId)).toEqual(['t1']);
      expect(base.lanes.filter((l) => l.status === 'blocked').map((l) => l.itemId)).toEqual(['t2']);
      // …and the prune is DEFERRED: t2 is written only once nothing is
      // dispatchable, i.e. after t1 settled and the pool drained, never during the dispatch pass.
      const t2Write = base.lanes.findIndex((l) => l.itemId === 't2' && l.status !== undefined);
      const t1Failed = base.lanes.findIndex((l) => l.itemId === 't1' && l.status === 'failed');
      expect(t2Write).toBeGreaterThan(t1Failed);
    });

    it('re-runs a SELF-looping first step at attempt 2 and integrates the lane', async () => {
      // The built-in sprint/ship chains declare `loopback: 'implement'` on
      // `implement` itself. Pin the controller behavior that makes that
      // declaration worth having: a first-step failure is retried, not fatal.
      const selfLoop = step({
        id: 'execute',
        agent: 'orchestrate',
        fanOut: {
          over: 'tasks',
          inner: [{ id: 'implement', agent: 'implement', loopback: 'implement' }],
        },
      });
      const d = def([phase('p1', [selfLoop])]);
      const base = makeFanOutDriver(['t1']);
      const attempts: number[] = [];
      let calls = 0;
      const runner: StepRunner = {
        async runStep(_s, ctx) {
          attempts.push(ctx.attempt);
          calls += 1;
          return calls === 1 ? { status: 'failed', error: 'spawn flaked' } : { status: 'ok' };
        },
      };

      const result = await new WorkflowController(runner, makeFanHost(base)).run('r', d);

      expect(result.outcome).toBe('completed');
      expect(attempts).toEqual([1, 2]);
      expect(base.lanes.some((l) => l.status === 'failed')).toBe(false);
      expect(base.lanes.filter((l) => l.status === 'integrated').map((l) => l.itemId)).toEqual(['t1']);
    });

    it('still fails a SELF-looping first step once the lane attempt cap is spent', async () => {
      const selfLoop = step({
        id: 'execute',
        agent: 'orchestrate',
        fanOut: {
          over: 'tasks',
          inner: [{ id: 'implement', agent: 'implement', loopback: 'implement' }],
        },
      });
      const d = def([phase('p1', [selfLoop])]);
      const base = makeFanOutDriver(['t1']);
      const attempts: number[] = [];
      const runner: StepRunner = {
        async runStep(_s, ctx) {
          attempts.push(ctx.attempt);
          return { status: 'failed', error: 'genuinely broken' };
        },
      };

      await new WorkflowController(runner, makeFanHost(base)).run('r', d);

      // The self-loopback grants retries up to the cap, then the lane settles.
      expect(attempts).toEqual([1, 2, 3]);
      expect(base.lanes.filter((l) => l.status === 'failed').map((l) => l.itemId)).toEqual(['t1']);
    });

    it('keeps dispatching independent lanes before pruning the ones a failure stranded', async () => {
      // A→B plus an independent C, serialized (cap 1). The old readiness pass
      // settled B the instant A failed; the deferred prune must let C run first,
      // so an operator still has the whole fan-out's worth of time to rewind A.
      const d = def([phase('p1', [fanStep('execute', ['implement'], 1)])]);
      const base = makeFanOutDriver(['t1', 't2', 't3']);
      const driver: FanOutDriver = { ...base, dependencies: () => new Map([['t2', ['t1']]]) };
      const order: string[] = [];
      const runner: StepRunner = {
        async runStep(_s, ctx) {
          if (ctx.item) order.push(ctx.item.id);
          return ctx.item?.id === 't1' ? { status: 'failed', error: 'boom' } : { status: 'ok' };
        },
      };
      const host = makeFanHost(driver);

      const result = await new WorkflowController(runner, host).run('r', d);

      expect(result.outcome).toBe('completed');
      // t3 ran even though t1 had already failed; t2 never did.
      expect(order).toEqual(['t1', 't3']);
      expect(base.lanes.filter((l) => l.status === 'blocked').map((l) => l.itemId)).toEqual(['t2']);
      const t3Integrated = base.lanes.findIndex((l) => l.itemId === 't3' && l.status === 'integrated');
      const t2Blocked = base.lanes.findIndex((l) => l.itemId === 't2' && l.status === 'blocked');
      expect(t3Integrated).toBeGreaterThanOrEqual(0);
      expect(t2Blocked).toBeGreaterThan(t3Integrated);
    });

    it('names the culprit transitively down a chain: A fails, B blocked by A, C blocked by B', async () => {
      const d = def([phase('p1', [fanStep('execute', ['implement'], 1)])]);
      const base = makeFanOutDriver(['t1', 't2', 't3']);
      const driver: FanOutDriver = {
        ...base,
        dependencies: () =>
          new Map([
            ['t2', ['t1']],
            ['t3', ['t2']],
          ]),
      };
      const runner: StepRunner = {
        async runStep(_s, ctx) {
          return ctx.item?.id === 't1' ? { status: 'failed', error: 'boom' } : { status: 'ok' };
        },
      };
      const host = makeFanHost(driver);

      await new WorkflowController(runner, host).run('r', d);

      // The whole tail is 'blocked' — a cycle diagnosis here would be a lie.
      expect(base.lanes.filter((l) => l.status === 'blocked').map((l) => l.itemId)).toEqual(['t2', 't3']);
      expect(base.lanes.filter((l) => l.status === 'failed').map((l) => l.itemId)).toEqual(['t1']);
    });

    it('blocks tasks with unresolvable (cyclic) dependencies instead of spinning', async () => {
      const d = def([phase('p1', [fanStep('execute', ['implement'])])]);
      const base = makeFanOutDriver(['t1', 't2']);
      const driver: FanOutDriver = {
        ...base,
        dependencies: () =>
          new Map([
            ['t1', ['t2']],
            ['t2', ['t1']],
          ]),
      };
      const runner = makeRunner();
      const host = makeFanHost(driver);

      const result = await new WorkflowController(runner, host).run('r', d);

      expect(result.outcome).toBe('completed');
      expect(runner.calls.length).toBe(0); // neither task could ever run
      // Neither lane ever started, so neither is 'failed'.
      const blockedLanes = base.lanes.filter((l) => l.status === 'blocked').map((l) => l.itemId);
      expect(new Set(blockedLanes)).toEqual(new Set(['t1', 't2']));
      expect(base.lanes.some((l) => l.status === 'failed')).toBe(false);
    });

    it('holds an overlapping lane out of the pool until the file\'s holder settles, while disjoint tasks run concurrently', async () => {
      const d = def([phase('p1', [fanStep('execute', ['implement'], 3)])]);
      const base = makeFanOutDriver(['t1', 't2', 't3']);
      const expectedFiles = new Map([
        ['t1', ['src/shared.ts']],
        ['t2', ['src/shared.ts']],
        ['t3', ['src/disjoint.ts']],
      ]);
      const driver: FanOutDriver = { ...base, expectedFiles: () => expectedFiles };
      const active = new Set<string>();
      const pathsByItem = expectedFiles;
      let overlapObserved = false;
      let maxInFlight = 0;
      const runner: StepRunner = {
        async runStep(_s, ctx) {
          const itemId = ctx.item?.id;
          if (!itemId) return { status: 'ok' };
          const files = pathsByItem.get(itemId) ?? [];
          for (const activeItem of active) {
            const activeFiles = pathsByItem.get(activeItem) ?? [];
            if (files.some((file) => activeFiles.includes(file))) overlapObserved = true;
          }
          active.add(itemId);
          maxInFlight = Math.max(maxInFlight, active.size);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active.delete(itemId);
          return { status: 'ok' };
        },
      };

      const result = await new WorkflowController(runner, makeFanHost(driver)).run('r', d);

      expect(result.outcome).toBe('completed');
      expect(overlapObserved).toBe(false);
      // t1 and t3 run together, proving the conflict guard did not make the
      // entire fan-out serial merely because t2 overlaps t1.
      expect(maxInFlight).toBe(2);
    });

    // ── rolling dispatch pool (no wave barrier) ───────────────────────────────
    describe('rolling dispatch pool', () => {
      /** A promise plus its resolver, so a test can hold one lane open on purpose. */
      function gate(): { wait: Promise<void>; open: () => void } {
        let open: () => void = () => undefined;
        const wait = new Promise<void>((resolve) => {
          open = resolve;
        });
        return { wait, open };
      }

      /**
       * Hold until `g` opens, but never longer than `ms` — so a REGRESSION (the
       * lane that was supposed to open the gate never dispatching) fails the
       * assertion instead of hanging the suite.
       */
      const holdUntil = (g: { wait: Promise<void> }, ms = 40): Promise<unknown> =>
        Promise.race([g.wait, new Promise((resolve) => setTimeout(resolve, ms))]);

      it('dispatches a dependent the MOMENT its prerequisite integrates, without waiting for the slowest sibling', async () => {
        // t3 depends on t1; t2 is the slow lane and depends on nothing. The wave
        // barrier made t3 wait for t1 AND t2 — the pool only owes it t1.
        const d = def([phase('p1', [fanStep('execute', ['implement'])])]);
        const base = makeFanOutDriver(['t1', 't2', 't3']);
        const driver: FanOutDriver = { ...base, dependencies: () => new Map([['t3', ['t1']]]) };
        const slow = gate();
        let slowFinished = false;
        let dependentStartedWhileSlowRan = false;
        const runner: StepRunner = {
          async runStep(_s, ctx) {
            const id = ctx.item?.id;
            if (id === 't2') {
              await holdUntil(slow);
              slowFinished = true;
              return { status: 'ok' };
            }
            if (id === 't3') {
              dependentStartedWhileSlowRan = !slowFinished;
              slow.open();
            }
            return { status: 'ok' };
          },
        };

        const result = await new WorkflowController(runner, makeFanHost(driver)).run('r', d);

        expect(result.outcome).toBe('completed');
        // The whole point of the pool: t1 freed a slot and t3 took it immediately.
        expect(dependentStartedWhileSlowRan).toBe(true);
        const integrated = base.lanes.filter((l) => l.status === 'integrated').map((l) => l.itemId);
        expect(new Set(integrated)).toEqual(new Set(['t1', 't2', 't3']));
      });

      it("releases a lane's expected-file claim the instant it settles, not at a batch boundary", async () => {
        // t1 & t2 both touch src/shared.ts; t3 is disjoint and slow. The wave loop
        // pushed t2 into the NEXT wave — i.e. behind t3, which it never conflicted
        // with. Here the claim is held by the live lane and freed on its settle.
        const d = def([phase('p1', [fanStep('execute', ['implement'], 3)])]);
        const base = makeFanOutDriver(['t1', 't2', 't3']);
        const expectedFiles = new Map([
          ['t1', ['src/shared.ts']],
          ['t2', ['src/shared.ts']],
          ['t3', ['src/disjoint.ts']],
        ]);
        const driver: FanOutDriver = { ...base, expectedFiles: () => expectedFiles };
        const slow = gate();
        const active = new Set<string>();
        let overlapObserved = false;
        let slowFinished = false;
        let blockedLaneStartedWhileSlowRan = false;
        const runner: StepRunner = {
          async runStep(_s, ctx) {
            const id = ctx.item?.id;
            if (id === undefined) return { status: 'ok' };
            const files = expectedFiles.get(id) ?? [];
            for (const other of active) {
              const otherFiles = expectedFiles.get(other) ?? [];
              if (files.some((file) => otherFiles.includes(file))) overlapObserved = true;
            }
            active.add(id);
            if (id === 't3') {
              await holdUntil(slow);
              slowFinished = true;
            }
            if (id === 't2') {
              blockedLaneStartedWhileSlowRan = !slowFinished;
              slow.open();
            }
            active.delete(id);
            return { status: 'ok' };
          },
        };

        const result = await new WorkflowController(runner, makeFanHost(driver)).run('r', d);

        expect(result.outcome).toBe('completed');
        // The exclusion is still real: t1 and t2 never overlapped on shared.ts.
        expect(overlapObserved).toBe(false);
        // …but t2 started as soon as t1 let the file go, not after t3 finished.
        expect(blockedLaneStartedWhileSlowRan).toBe(true);
      });

      it('never prunes a lane whose prerequisite is STILL IN FLIGHT', async () => {
        // Nothing is dispatchable the moment t3 settles — t2 waits on the slow t1
        // — but t1 is live and goes on to integrate. A prune that fires on
        // "nothing ready" alone would settle t2 'blocked' on a prerequisite that
        // succeeds, and name it a dependency cycle.
        const d = def([phase('p1', [fanStep('execute', ['implement'])])]);
        const base = makeFanOutDriver(['t1', 't2', 't3']);
        const driver: FanOutDriver = { ...base, dependencies: () => new Map([['t2', ['t1']]]) };
        const slow = gate();
        const runner: StepRunner = {
          async runStep(_s, ctx) {
            const id = ctx.item?.id;
            if (id === 't1') await holdUntil(slow);
            if (id === 't3') slow.open();
            return { status: 'ok' };
          },
        };

        const result = await new WorkflowController(runner, makeFanHost(driver)).run('r', d);

        expect(result.outcome).toBe('completed');
        expect(base.lanes.some((l) => l.status === 'blocked')).toBe(false);
        const integrated = base.lanes.filter((l) => l.status === 'integrated').map((l) => l.itemId);
        expect(new Set(integrated)).toEqual(new Set(['t1', 't2', 't3']));
      });

      it("fails ONLY the throwing lane when a lane's walk throws outright", async () => {
        // The wave loop awaited every lane through one Promise.all, so a throw
        // rejected the whole call: siblings were abandoned mid-walk and every
        // held write was lost. Each lane now carries its own rejection guard.
        const d = def([phase('p1', [fanStep('execute', ['implement'])])]);
        const driver = makeFanOutDriver(['t1', 't2', 't3']);
        const runner: StepRunner = {
          async runStep(_s, ctx) {
            if (ctx.item?.id === 't1') throw new Error('runner exploded');
            return { status: 'ok' };
          },
        };

        const result = await new WorkflowController(runner, makeFanHost(driver)).run('r', d);

        expect(result.outcome).toBe('completed');
        expect(driver.lanes.filter((l) => l.status === 'failed').map((l) => l.itemId)).toEqual(['t1']);
        const integrated = driver.lanes.filter((l) => l.status === 'integrated').map((l) => l.itemId);
        expect(new Set(integrated)).toEqual(new Set(['t2', 't3']));
      });
    });

    // ── operator skip of a fan-out INNER step (RunDirectives) ─────────────────
    it('skips a fan-out inner step for every lane on operator request, running the rest', async () => {
      const d = def([phase('p1', [fanStep('execute', ['implement', 'verify'])])]);
      const driver = makeFanOutDriver(['t1', 't2']);
      const seen: Array<{ itemId?: string; stepId: string }> = [];
      const runner: StepRunner = {
        async runStep(s, ctx) {
          seen.push({ itemId: ctx.item?.id, stepId: s.id });
          return { status: 'ok' };
        },
      };
      const directives = createRunDirectives();
      directives.userSkippedStepIds.add('verify'); // skip the inner 'verify' step

      const result = await new WorkflowController(runner, makeFanHost(driver)).run(
        'r', d, undefined, undefined, undefined, directives,
      );

      expect(result.outcome).toBe('completed');
      // Only 'implement' ran (per lane); 'verify' was skipped for both lanes.
      expect(seen.filter((x) => x.stepId === 'implement').map((x) => x.itemId)).toEqual(['t1', 't2']);
      expect(seen.some((x) => x.stepId === 'verify')).toBe(false);
      // The lane is never driven onto the skipped step, but still integrates.
      expect(driver.lanes.some((l) => l.currentStepId === 'verify')).toBe(false);
      for (const item of ['t1', 't2']) {
        expect(driver.lanes.filter((l) => l.itemId === item).at(-1)?.status).toBe('integrated');
      }
    });

    // ── live fan-out RE-RESOLUTION at every pool iteration (add/remove enabler) ─
    describe('live re-resolution', () => {
      /**
       * A FanOutDriver whose resolved item set is MUTABLE mid-run (via
       * setItems) — models add_task/remove_task on the batch mid-run. Records the
       * lane writes like makeFanOutDriver. Optional static `dependencies`.
       */
      function makeMutableDriver(
        initial: string[],
        deps?: Map<string, string[]>,
      ): FanOutDriver & {
        lanes: Array<{ itemId: string; status?: SprintBatchTaskStatus; currentStepId?: string | null }>;
        setItems: (next: string[]) => void;
      } {
        let items = [...initial];
        const lanes: Array<{ itemId: string; status?: SprintBatchTaskStatus; currentStepId?: string | null }> = [];
        return {
          lanes,
          setItems: (next) => {
            items = [...next];
          },
          resolveItems: () => [...items],
          ...(deps ? { dependencies: () => new Map(deps) } : {}),
          driveLane: ({ itemId, status, currentStepId }) => {
            lanes.push({ itemId, status, currentStepId });
          },
        };
      }

      const integratedOf = (
        lanes: Array<{ itemId: string; status?: SprintBatchTaskStatus }>,
      ): Set<string> =>
        new Set(lanes.filter((l) => l.status === 'integrated').map((l) => l.itemId));

      it('produces an identical dispatch order for a STATIC batch (re-resolution is a no-op)', async () => {
        // Sequential deps force one lane at a time, so re-resolution runs between
        // every dispatch — yet with no mutation the outcome is byte-identical.
        const d = def([phase('p1', [fanStep('execute', ['implement'])])]);
        const deps = new Map([
          ['t2', ['t1']],
          ['t3', ['t2']],
        ]);
        const driver = makeMutableDriver(['t1', 't2', 't3'], deps);
        const order: string[] = [];
        const runner: StepRunner = {
          async runStep(_s, ctx) {
            if (ctx.item) order.push(ctx.item.id);
            return { status: 'ok' };
          },
        };

        const result = await new WorkflowController(runner, makeFanHost(driver)).run('r', d);

        expect(result.outcome).toBe('completed');
        expect(order).toEqual(['t1', 't2', 't3']); // strict sequence, each once
        expect(integratedOf(driver.lanes)).toEqual(new Set(['t1', 't2', 't3']));
      });

      it('picks up a lane ADDED mid-run and dispatches it at the next free slot', async () => {
        // t2 depends on t1, so t1 dispatches alone. While t1 runs, the operator adds t3.
        const d = def([phase('p1', [fanStep('execute', ['implement'])])]);
        const driver = makeMutableDriver(['t1', 't2'], new Map([['t2', ['t1']]]));
        const order: string[] = [];
        const runner: StepRunner = {
          async runStep(_s, ctx) {
            if (ctx.item) {
              order.push(ctx.item.id);
              if (ctx.item.id === 't1') driver.setItems(['t1', 't2', 't3']); // add t3 mid-run
            }
            return { status: 'ok' };
          },
        };

        const result = await new WorkflowController(runner, makeFanHost(driver)).run('r', d);

        expect(result.outcome).toBe('completed');
        expect(order[0]).toBe('t1'); // t1 first (alone)
        expect(new Set(order)).toEqual(new Set(['t1', 't2', 't3'])); // t3 was dispatched
        expect(integratedOf(driver.lanes)).toEqual(new Set(['t1', 't2', 't3']));
      });

      it('drops a QUEUED lane removed mid-run — it is never dispatched', async () => {
        // t2 & t3 depend on t1, so t1 dispatches alone and t2/t3 follow it. While
        // t1 runs, the operator removes the still-queued t3 before it is dispatched.
        const d = def([phase('p1', [fanStep('execute', ['implement'])])]);
        const driver = makeMutableDriver(
          ['t1', 't2', 't3'],
          new Map([
            ['t2', ['t1']],
            ['t3', ['t1']],
          ]),
        );
        const order: string[] = [];
        const runner: StepRunner = {
          async runStep(_s, ctx) {
            if (ctx.item) {
              order.push(ctx.item.id);
              if (ctx.item.id === 't1') driver.setItems(['t1', 't2']); // remove queued t3
            }
            return { status: 'ok' };
          },
        };

        const result = await new WorkflowController(runner, makeFanHost(driver)).run('r', d);

        // A removed queued lane is NOT a failure — the run completes clean.
        expect(result.outcome).toBe('completed');
        expect(order).toEqual(['t1', 't2']); // t3 never ran
        expect(driver.lanes.some((l) => l.itemId === 't3')).toBe(false); // no t3 lane write at all
        expect(integratedOf(driver.lanes)).toEqual(new Set(['t1', 't2']));
      });

      it('never re-dispatches an already-dispatched lane still present in the re-resolved set', async () => {
        // t2 depends on t1 ⇒ two dispatch rounds; t1 stays in the (naive) resolved
        // set across both, yet the controller's settled-tracking prevents a re-dispatch.
        const d = def([phase('p1', [fanStep('execute', ['implement'])])]);
        const driver = makeMutableDriver(['t1', 't2'], new Map([['t2', ['t1']]]));
        const counts = new Map<string, number>();
        const runner: StepRunner = {
          async runStep(_s, ctx) {
            if (ctx.item) counts.set(ctx.item.id, (counts.get(ctx.item.id) ?? 0) + 1);
            return { status: 'ok' };
          },
        };

        const result = await new WorkflowController(runner, makeFanHost(driver)).run('r', d);

        expect(result.outcome).toBe('completed');
        expect(counts.get('t1')).toBe(1); // dispatched exactly once despite staying in fresh
        expect(counts.get('t2')).toBe(1);
      });
    });

    // ── commit-integrity backstop before the 'integrated' stamp ───────────────
    describe('commit-integrity backstop', () => {
      /** makeFanHost plus a recording log sink (the backstop's only other output). */
      function makeLoggingFanHost(driver: FanOutDriver): {
        host: ControllerHost;
        logs: Array<{ level: 'info' | 'warn' | 'error'; message: string }>;
      } {
        const host = makeFanHost(driver);
        const logs: Array<{ level: 'info' | 'warn' | 'error'; message: string }> = [];
        host.log = (level, message) => {
          logs.push({ level, message });
        };
        return { host, logs };
      }

      it('integrates as before when the driver exposes no commit probe', async () => {
        const d = def([phase('p1', [fanStep('execute', ['implement'])])]);
        const driver = makeFanOutDriver(['t1']);
        expect(driver.beginCommitProbe).toBeUndefined();

        const result = await new WorkflowController(makeRunner(), makeFanHost(driver)).run('r', d);

        expect(result.outcome).toBe('completed');
        expect(driver.lanes.at(-1)).toMatchObject({ itemId: 't1', status: 'integrated' });
      });

      it('integrates when the probe reports HEAD advanced', async () => {
        const d = def([phase('p1', [fanStep('execute', ['implement'])])]);
        const driver = makeFanOutDriver(['t1']);
        driver.beginCommitProbe = async () => async () => ({ headAdvanced: true, dirty: true });

        const result = await new WorkflowController(makeRunner(), makeFanHost(driver)).run('r', d);

        expect(result.outcome).toBe('completed');
        expect(driver.lanes.at(-1)).toMatchObject({ itemId: 't1', status: 'integrated' });
      });

      it('integrates when the probe reports a clean tree even with HEAD unmoved', async () => {
        // Nothing to commit is not a defect (e.g. a docs-only task the agent
        // resolved as already-satisfied, or a sibling that committed our work).
        const d = def([phase('p1', [fanStep('execute', ['implement'])])]);
        const driver = makeFanOutDriver(['t1']);
        driver.beginCommitProbe = async () => async () => ({ headAdvanced: false, dirty: false });

        const result = await new WorkflowController(makeRunner(), makeFanHost(driver)).run('r', d);

        expect(result.outcome).toBe('completed');
        expect(driver.lanes.at(-1)).toMatchObject({ itemId: 't1', status: 'integrated' });
      });

      it('FAILS a green lane that made no commit and left the worktree dirty', async () => {
        // The live defect: every inner step returned ok but `git commit` was
        // denied, so the changes sat untracked and the lane still showed merged.
        const d = def([phase('p1', [fanStep('execute', ['implement', 'verify'])])]);
        const driver = makeFanOutDriver(['t1', 't2']);
        driver.beginCommitProbe = async () =>
          async () => ({ headAdvanced: false, dirty: true });
        const { host, logs } = makeLoggingFanHost(driver);

        const result = await new WorkflowController(makeRunner(), host).run('r', d);

        // The outer step still settles (a lane failure is not terminal), but no
        // lane is integrated — both are failed.
        expect(result.outcome).toBe('completed');
        expect(driver.lanes.some((l) => l.status === 'integrated')).toBe(false);
        for (const item of ['t1', 't2']) {
          expect(driver.lanes.filter((l) => l.itemId === item).at(-1)).toMatchObject({
            status: 'failed',
          });
        }
        const errors = logs.filter((l) => l.level === 'error');
        expect(errors.length).toBe(2);
        expect(errors[0].message).toContain('made no git commit');
        expect(errors[0].message).toContain('refusing to mark integrated');
      });

      it('integrates (with a warning) when opening the probe throws', async () => {
        const d = def([phase('p1', [fanStep('execute', ['implement'])])]);
        const driver = makeFanOutDriver(['t1']);
        driver.beginCommitProbe = async () => {
          throw new Error('no worktree');
        };
        const { host, logs } = makeLoggingFanHost(driver);

        const result = await new WorkflowController(makeRunner(), host).run('r', d);

        expect(result.outcome).toBe('completed');
        expect(driver.lanes.at(-1)).toMatchObject({ itemId: 't1', status: 'integrated' });
        expect(logs.some((l) => l.level === 'warn' && l.message.includes('no worktree'))).toBe(true);
        expect(logs.some((l) => l.level === 'error')).toBe(false);
      });

      it('integrates (with a warning) when the probe closure throws at lane end', async () => {
        const d = def([phase('p1', [fanStep('execute', ['implement'])])]);
        const driver = makeFanOutDriver(['t1']);
        driver.beginCommitProbe = async () => async () => {
          throw new Error('git rev-parse exploded');
        };
        const { host, logs } = makeLoggingFanHost(driver);

        const result = await new WorkflowController(makeRunner(), host).run('r', d);

        expect(result.outcome).toBe('completed');
        expect(driver.lanes.at(-1)).toMatchObject({ itemId: 't1', status: 'integrated' });
        expect(
          logs.some((l) => l.level === 'warn' && l.message.includes('git rev-parse exploded')),
        ).toBe(true);
        expect(logs.some((l) => l.level === 'error')).toBe(false);
      });
    });

    // ── Operator LANE REWIND (RunDirectives.laneRewinds) ──────────────────────
    //    The monitor's `rewind_lane_to_step` pulls ONE lane back to an earlier
    //    inner step while the fan-out stays live. Consulted at three points in the
    //    lane loop (idle / mid-agent-turn / parked at the visual merge gate).
    describe('operator lane rewind', () => {
      const chain = (): WorkflowStep =>
        step({
          id: 'execute',
          agent: 'orchestrate',
          fanOut: {
            over: 'tasks',
            inner: [
              { id: 'implement', agent: 'implement' },
              { id: 'code-review', agent: 'code-review', loopback: 'implement' },
              { id: 'task-verify', agent: 'task-verify', loopback: 'implement' },
            ],
          },
        });

      it('mid-agent-turn: a killed step whose lane has a pending rewind re-drives instead of failing the lane', async () => {
        // The production handler kills the lane's spawn to force a stuck step to
        // return; the spawn rejection reaches the controller as a plain `failed`
        // result (the RUN signal never fired). The pending request is what keeps
        // that operator-induced failure from consuming a loopback attempt.
        const d = def([phase('p1', [chain()])]);
        const driver = makeFanOutDriver(['t1']);
        const directives = createRunDirectives();
        const calls: string[] = [];
        let killed = false;
        const runner: StepRunner = {
          async runStep(s) {
            calls.push(s.id);
            if (s.id === 'task-verify' && !killed) {
              killed = true;
              directives.laneRewinds.set('t1', 'implement');
              return { status: 'failed', error: 'process killed' };
            }
            return { status: 'ok' };
          },
        };

        const result = await new WorkflowController(runner, makeFanHost(driver)).run(
          'r', d, undefined, undefined, undefined, directives,
        );

        expect(result.outcome).toBe('completed');
        // The lane re-ran the whole chain from 'implement' rather than failing.
        expect(calls).toEqual([
          'implement', 'code-review', 'task-verify', // killed here
          'implement', 'code-review', 'task-verify',
        ]);
        const laneWrites = driver.lanes.filter((l) => l.itemId === 't1');
        expect(laneWrites[laneWrites.length - 1].status).toBe('integrated');
        expect(laneWrites.some((l) => l.status === 'failed')).toBe(false);
        // No attempt bump: an operator rewind must not burn the lane's automatic
        // loopback budget (unlike a code-review / task-verify loopback, which does).
        expect(laneWrites.every((l) => l.attempt === undefined)).toBe(true);
        // The request was consumed exactly once.
        expect(directives.laneRewinds.size).toBe(0);
      });

      it('re-drives a lane whose step SUCCEEDED when a rewind landed during that turn', async () => {
        // A lane that is not stuck but whose output the operator rejects: the
        // request lands mid-turn and the (clean) result is discarded.
        const d = def([phase('p1', [chain()])]);
        const driver = makeFanOutDriver(['t1']);
        const directives = createRunDirectives();
        const calls: string[] = [];
        let rewound = false;
        const runner: StepRunner = {
          async runStep(s) {
            calls.push(s.id);
            if (s.id === 'code-review' && !rewound) {
              rewound = true;
              directives.laneRewinds.set('t1', 'implement');
            }
            return { status: 'ok' };
          },
        };

        const result = await new WorkflowController(runner, makeFanHost(driver)).run(
          'r', d, undefined, undefined, undefined, directives,
        );

        expect(result.outcome).toBe('completed');
        expect(calls).toEqual(['implement', 'code-review', 'implement', 'code-review', 'task-verify']);
      });

      it('idle consult: a rewind requested before the lane starts is consumed at its first inner step', async () => {
        const d = def([phase('p1', [chain()])]);
        const driver = makeFanOutDriver(['t1']);
        const directives = createRunDirectives();
        directives.laneRewinds.set('t1', 'implement'); // target === the lane's entry step
        const runner = makeRunner();

        const result = await new WorkflowController(runner, makeFanHost(driver)).run(
          'r', d, undefined, undefined, undefined, directives,
        );

        expect(result.outcome).toBe('completed');
        // Consumed at the loop head, so the chain runs exactly once (no re-entry loop).
        expect(runner.calls.map((c) => c.id)).toEqual(['implement', 'code-review', 'task-verify']);
        expect(directives.laneRewinds.size).toBe(0);
      });

      it('ignores (and consumes) a target that is not one of the fan-out inner steps', async () => {
        const d = def([phase('p1', [chain()])]);
        const driver = makeFanOutDriver(['t1']);
        const directives = createRunDirectives();
        const calls: string[] = [];
        const runner: StepRunner = {
          async runStep(s) {
            calls.push(s.id);
            if (s.id === 'implement' && calls.length === 1) directives.laneRewinds.set('t1', 'not-a-step');
            return { status: 'ok' };
          },
        };

        const result = await new WorkflowController(runner, makeFanHost(driver)).run(
          'r', d, undefined, undefined, undefined, directives,
        );

        expect(result.outcome).toBe('completed');
        expect(calls).toEqual(['implement', 'code-review', 'task-verify']);
        // Consumed on the rejection path too — a request the lane cannot honor must
        // not linger and re-refuse at every later consult point.
        expect(directives.laneRewinds.size).toBe(0);
      });

      it('refuses (and consumes) a FORWARD target — rewind only goes backward', async () => {
        const d = def([phase('p1', [chain()])]);
        const driver = makeFanOutDriver(['t1']);
        const directives = createRunDirectives();
        const calls: string[] = [];
        const runner: StepRunner = {
          async runStep(s) {
            calls.push(s.id);
            // From 'implement' (index 0), ask to jump to 'task-verify' (index 2).
            if (s.id === 'implement' && calls.length === 1) directives.laneRewinds.set('t1', 'task-verify');
            return { status: 'ok' };
          },
        };

        const result = await new WorkflowController(runner, makeFanHost(driver)).run(
          'r', d, undefined, undefined, undefined, directives,
        );

        expect(result.outcome).toBe('completed');
        expect(calls).toEqual(['implement', 'code-review', 'task-verify']); // no jump
        expect(directives.laneRewinds.size).toBe(0);
      });

      it('rewinds ONLY the targeted lane — a sibling lane is untouched', async () => {
        const d = def([phase('p1', [chain()])]);
        const driver = makeFanOutDriver(['t1', 't2']);
        const directives = createRunDirectives();
        const calls: Array<{ item: string; id: string }> = [];
        let rewound = false;
        const runner: StepRunner = {
          async runStep(s, ctx) {
            const item = ctx.item?.id ?? '?';
            calls.push({ item, id: s.id });
            if (item === 't1' && s.id === 'code-review' && !rewound) {
              rewound = true;
              directives.laneRewinds.set('t1', 'implement');
            }
            return { status: 'ok' };
          },
        };

        const result = await new WorkflowController(runner, makeFanHost(driver)).run(
          'r', d, undefined, undefined, undefined, directives,
        );

        expect(result.outcome).toBe('completed');
        expect(calls.filter((c) => c.item === 't1').map((c) => c.id)).toEqual([
          'implement', 'code-review', 'implement', 'code-review', 'task-verify',
        ]);
        // t2 walked its chain exactly once.
        expect(calls.filter((c) => c.item === 't2').map((c) => c.id)).toEqual([
          'implement', 'code-review', 'task-verify',
        ]);
      });

      // ── parked at the visual merge gate ──────────────────────────────────────
      const verifyChainWithGate = (): WorkflowStep =>
        step({
          id: 'execute',
          agent: 'orchestrate',
          fanOut: {
            over: 'tasks',
            inner: [
              { id: 'implement', agent: 'implement' },
              { id: 'task-verify', agent: 'task-verify', loopback: 'implement' },
              { id: 'visual-verify', agent: 'visual-verify' },
            ],
          },
        });

      /** A task-verify result carrying a valid `## Visual verification task` fence. */
      const taskVerifyFence = (): string =>
        `VERDICT: PASS\n\n## Visual verification task\n\n\`\`\`json\n${JSON.stringify({
          version: 1,
          summary: 'Check the UI',
          behaviors: [{ id: 'b1', description: 'renders', expected: 'form visible' }],
        })}\n\`\`\`\n`;

      it('parked at the merge gate: the unpark hook wakes the lane and it re-drives (not canceled)', async () => {
        const d = def([phase('p1', [verifyChainWithGate()])]);
        const driver = makeFanOutDriver(['t1']);
        const directives = createRunDirectives();
        const host = makeFanHost(driver);
        let parks = 0;
        let hookSeen = false;
        host.visualGate = {
          isActive: () => true,
          awaitVerdict({ itemId, signal }) {
            parks += 1;
            if (parks === 1) {
              // The operator's rewind lands while the lane is parked: record it,
              // then fire the lane's unpark hook exactly as requestLaneRewind does.
              directives.laneRewinds.set(itemId, 'implement');
              const interrupt = directives.laneInterrupts.get(itemId);
              hookSeen = interrupt !== undefined;
              interrupt?.();
            }
            if (parks === 1) {
              return Promise.resolve<VisualGateOutcome>(
                signal?.aborted === true ? { kind: 'aborted' } : { kind: 'advance' },
              );
            }
            return Promise.resolve<VisualGateOutcome>({ kind: 'advance' });
          },
        };
        host.enqueueVisualVerification = async () => ({ outcome: 'enqueued', requestId: 'vr-1' });
        const calls: string[] = [];
        const runner: StepRunner = {
          async runStep(s) {
            calls.push(s.id);
            if (s.id === 'task-verify') return { status: 'ok', resultText: taskVerifyFence() };
            return { status: 'ok' };
          },
        };

        const result = await new WorkflowController(runner, host).run(
          'r', d, undefined, undefined, undefined, directives,
        );

        // The gate really did see a registered unpark hook, and the abort it fired
        // was read as a rewind — NOT as a run cancellation.
        expect(hookSeen).toBe(true);
        expect(result.outcome).toBe('completed');
        expect(calls).toEqual(['implement', 'task-verify', 'implement', 'task-verify']);
        expect(parks).toBe(2);
        const laneWrites = driver.lanes.filter((l) => l.itemId === 't1');
        expect(laneWrites[laneWrites.length - 1].status).toBe('integrated');
        // The hook is unregistered once the park ends.
        expect(directives.laneInterrupts.size).toBe(0);
      });

      it('a RUN cancellation while parked still ends the walk canceled (the park chains the run signal)', async () => {
        const d = def([phase('p1', [verifyChainWithGate()])]);
        const driver = makeFanOutDriver(['t1']);
        const directives = createRunDirectives();
        const host = makeFanHost(driver);
        const ac = new AbortController();
        host.visualGate = {
          isActive: () => true,
          awaitVerdict({ signal }) {
            ac.abort(); // the run is canceled while this lane is parked
            return Promise.resolve<VisualGateOutcome>(
              signal?.aborted === true ? { kind: 'aborted' } : { kind: 'advance' },
            );
          },
        };
        host.enqueueVisualVerification = async () => ({ outcome: 'enqueued', requestId: 'vr-1' });
        const runner: StepRunner = {
          async runStep(s) {
            if (s.id === 'task-verify') return { status: 'ok', resultText: taskVerifyFence() };
            return { status: 'ok' };
          },
        };

        const result = await new WorkflowController(runner, host).run(
          'r', d, ac.signal, undefined, undefined, directives,
        );

        expect(result.outcome).toBe('canceled');
        expect(directives.laneInterrupts.size).toBe(0);
      });
    });
  });
});

// ── shouldSkipHumanGate — optional-human-gate precondition seam ─────────────

describe('WorkflowController shouldSkipHumanGate (optional human gates)', () => {
  const gateDef = (opts: { optional?: boolean } = {}) =>
    def([
      phase('p1', [
        step({ id: 'work' }),
        step({ id: 'approve-design', agent: 'human', human: true, ...(opts.optional === false ? {} : { optional: true }) }),
        step({ id: 'after' }),
      ]),
    ]);

  it('skips an optional pure human gate when the seam returns a reason (gate never opens)', async () => {
    const host = makeHost();
    const withSkip: ControllerHost = {
      ...host,
      shouldSkipHumanGate: (s) => (s.id === 'approve-design' ? 'no design surface to review' : null),
    };
    const runner = makeRunner();

    const result = await new WorkflowController(runner, withSkip).run('run-gs', gateDef());

    expect(result.outcome).toBe('completed');
    const gateStep = result.steps.find((s) => s.stepId === 'approve-design');
    expect(gateStep).toMatchObject({ outcome: 'skipped', error: 'no design surface to review' });
    expect(host.gateCalls).toEqual([]); // the gate never opened
    // Timeline: skipped, with NO 'running' report for the gate.
    expect(host.reports.filter((r) => r.id === 'approve-design')).toEqual([
      { id: 'approve-design', status: 'skipped' },
    ]);
    // The walk continued past the gate.
    expect(runner.calls.map((c) => c.id)).toEqual(['work', 'after']);
  });

  it('opens the gate normally when the seam returns null', async () => {
    const host = makeHost();
    const withSkip: ControllerHost = { ...host, shouldSkipHumanGate: () => null };

    const result = await new WorkflowController(makeRunner(), withSkip).run('run-gn', gateDef());

    expect(result.outcome).toBe('completed');
    expect(host.gateCalls).toEqual(['approve-design']);
  });

  it('never consults the seam for a REQUIRED pure human gate', async () => {
    const host = makeHost();
    let consulted = 0;
    const withSkip: ControllerHost = {
      ...host,
      shouldSkipHumanGate: () => {
        consulted += 1;
        return 'would skip';
      },
    };

    const result = await new WorkflowController(makeRunner(), withSkip).run(
      'run-gr',
      gateDef({ optional: false }),
    );

    expect(consulted).toBe(0);
    expect(result.outcome).toBe('completed');
    expect(host.gateCalls).toEqual(['approve-design']);
  });

  it('fail-open: a throwing seam opens the gate instead of skipping it', async () => {
    const host = makeHost();
    const withSkip: ControllerHost = {
      ...host,
      shouldSkipHumanGate: () => {
        throw new Error('db read failed');
      },
    };

    const result = await new WorkflowController(makeRunner(), withSkip).run('run-gt', gateDef());

    expect(result.outcome).toBe('completed');
    expect(host.gateCalls).toEqual(['approve-design']);
  });
});

describe('WorkflowController — gate revision threading', () => {
  /**
   * A design phase shaped like Planner's refine phase: a spec step, a design step,
   * then a gate that loops back to the spec step.
   */
  function reviseDef(): WorkflowDefinition {
    return def([
      phase('refine', [
        step({ id: 'expand-spec' }),
        step({ id: 'ui-prototype' }),
        step({ id: 'approve-design', agent: 'human', human: true, loopback: 'expand-spec' }),
      ]),
    ]);
  }

  /** Records the gateRevision each step turn actually received. */
  function recordingRunner(): StepRunner & {
    seen: Array<{ id: string; gateRevision?: { gateStepId: string; note?: string } }>;
  } {
    const seen: Array<{ id: string; gateRevision?: { gateStepId: string; note?: string } }> = [];
    return {
      seen,
      async runStep(s, ctx) {
        seen.push({
          id: s.id,
          ...(ctx.gateRevision ? { gateRevision: ctx.gateRevision } : {}),
        });
        return { status: 'ok' };
      },
    };
  }

  it("threads the human's note into every step the gate's loopback re-drives", async () => {
    const runner = recordingRunner();
    const base = makeHost({ 'approve-design': ['revise', 'approve'] });
    const host: ControllerHost = {
      ...base,
      readGateResolutionNote: (stepId) =>
        stepId === 'approve-design' ? 'the spend screen has no way back to Home' : undefined,
    };

    const result = await new WorkflowController(runner, host).run('run-rev', reviseDef());
    expect(result.outcome).toBe('completed');

    // First pass has no revision; the re-run of BOTH steps carries it, because the
    // note describes what the whole re-run must do differently.
    expect(runner.seen.map((s) => s.id)).toEqual([
      'expand-spec',
      'ui-prototype',
      'expand-spec',
      'ui-prototype',
    ]);
    expect(runner.seen[0].gateRevision).toBeUndefined();
    expect(runner.seen[1].gateRevision).toBeUndefined();
    for (const turn of runner.seen.slice(2)) {
      expect(turn.gateRevision).toEqual({
        gateStepId: 'approve-design',
        note: 'the spend screen has no way back to Home',
      });
    }
  });

  it('re-presents the gate after the loop and clears the revision once it is answered', async () => {
    // Two revisions in a row, with different notes: the second round must carry the
    // SECOND note, never a stale first one, and an approve must leave nothing armed.
    const runner = recordingRunner();
    const notes = ['first note', 'second note'];
    const base = makeHost({ 'approve-design': ['revise', 'revise', 'approve'] });
    const host: ControllerHost = {
      ...base,
      readGateResolutionNote: () => notes.shift(),
    };

    const result = await new WorkflowController(runner, host).run('run-rev2', reviseDef());
    expect(result.outcome).toBe('completed');
    // The gate opened three times: once per round plus the final approve.
    expect(base.gateCalls).toEqual(['approve-design', 'approve-design', 'approve-design']);
    expect(runner.seen.map((s) => s.gateRevision?.note)).toEqual([
      undefined,
      undefined,
      'first note',
      'first note',
      'second note',
      'second note',
    ]);
  });

  it('arms nothing when the gate has no loopback target, and survives a note read that throws', async () => {
    // A targetless revise RE-PRESENTS the gate rather than re-running anything, so
    // there is no step to hand feedback to; and a throwing host seam must degrade
    // to "no note" rather than aborting a walk that is mid-loopback.
    const noTarget = def([
      phase('p', [step({ id: 'a' }), step({ id: 'gate', agent: 'human', human: true })]),
    ]);
    const runner = recordingRunner();
    const base = makeHost({ gate: ['revise', 'approve'] });
    let consulted = 0;
    const host: ControllerHost = {
      ...base,
      readGateResolutionNote: () => {
        consulted += 1;
        throw new Error('db read failed');
      },
    };

    const result = await new WorkflowController(runner, host).run('run-rev3', noTarget);
    expect(result.outcome).toBe('completed');
    // 'a' ran once — the targetless revise re-presented the gate at the same index.
    expect(runner.seen.map((s) => s.id)).toEqual(['a']);
    expect(runner.seen[0].gateRevision).toBeUndefined();
    // Targetless ⇒ the seam is never consulted at all.
    expect(consulted).toBe(0);
  });

  it('leaves the fan-out lane path untouched', async () => {
    // Lanes carry their own per-lane channels (laneGuidance / loopbackFeedback);
    // a run-level gate revision must never leak into an inner lane step.
    const fanDef = def([
      phase('exec', [
        step({
          id: 'execute-tasks',
          agent: 'orchestrate',
          fanOut: {
            over: 'tasks',
            maxConcurrency: 1,
            inner: [{ id: 'implement', agent: 'implement', loopback: 'implement' }],
          },
        }),
      ]),
    ]);
    const runner = recordingRunner();
    const host = makeHost();
    host.fanOut = { resolveItems: () => ['TASK-1', 'TASK-2'], driveLane: () => {} };

    const result = await new WorkflowController(runner, host).run('run-fan', fanDef);
    expect(result.outcome).toBe('completed');
    // The fan-out really ran (one inner turn per lane), and no lane turn carried a
    // run-level gate revision — lanes have their own per-lane channels.
    expect(runner.seen.map((s) => s.id)).toEqual(['implement', 'implement']);
    for (const turn of runner.seen) {
      expect(turn.gateRevision).toBeUndefined();
    }
  });
});

describe('WorkflowController — adversarial-review automatic revision', () => {
  /**
   * Planner's refine phase in miniature: spec → design → adversarial review
   * (declaring the loopback) → the human design gate.
   */
  function reviewDef(reviewLoopback: string | null = 'expand-spec'): WorkflowDefinition {
    return def([
      phase('refine', [
        step({ id: 'expand-spec' }),
        step({ id: 'ui-prototype', optional: true }),
        step({
          id: 'adversarial-review',
          agent: 'adversarial-review',
          optional: true,
          ...(reviewLoopback !== null ? { loopback: reviewLoopback } : {}),
        }),
        step({ id: 'approve-design', agent: 'human', human: true, loopback: 'expand-spec' }),
        step({ id: 'epics' }),
      ]),
    ]);
  }

  const BLOCKING_RESULT = [
    'Reported the adversarial review.',
    '',
    '## Blocking',
    '',
    '#### AR-1 — Spend screen has no way back',
    '**Severity:** blocker   **Area:** prototype',
    '**What:** no Home affordance.',
    '',
    'REVIEW: BLOCKING',
  ].join('\n');
  const CLEAN_RESULT = 'Reported the adversarial review.\n\n## Blocking\n\nNone.\n\nREVIEW: CLEAN';

  type Seen = {
    id: string;
    gateRevision?: { gateStepId: string; note?: string; source?: string; round?: number };
  };

  /** Scripted review results per adversarial-review turn; every other step is ok. */
  function reviewRunner(reviewResults: string[]): StepRunner & { seen: Seen[] } {
    const seen: Seen[] = [];
    const queue = [...reviewResults];
    return {
      seen,
      async runStep(s, ctx) {
        seen.push({ id: s.id, ...(ctx.gateRevision ? { gateRevision: ctx.gateRevision } : {}) });
        if (s.id === 'adversarial-review') {
          return { status: 'ok', resultText: queue.shift() ?? CLEAN_RESULT };
        }
        return { status: 'ok' };
      },
    };
  }

  it('loops the refine phase back once on REVIEW: BLOCKING, threading the blocking entries, before the gate opens', async () => {
    const runner = reviewRunner([BLOCKING_RESULT, CLEAN_RESULT]);
    const host = makeHost({ 'approve-design': ['approve'] });

    const result = await new WorkflowController(runner, host).run('run-ar', reviewDef());
    expect(result.outcome).toBe('completed');

    expect(runner.seen.map((s) => s.id)).toEqual([
      'expand-spec',
      'ui-prototype',
      'adversarial-review',
      // automatic revision — the whole refine region re-runs
      'expand-spec',
      'ui-prototype',
      'adversarial-review',
      'epics',
    ]);
    // The gate opened exactly once, AFTER the revision round.
    expect(host.gateCalls).toEqual(['approve-design']);
    // First pass carries nothing; every re-run turn carries the review-sourced
    // revision with the `## Blocking` section as its note.
    for (const turn of runner.seen.slice(0, 3)) expect(turn.gateRevision).toBeUndefined();
    for (const turn of runner.seen.slice(3, 6)) {
      expect(turn.gateRevision).toEqual({
        gateStepId: 'adversarial-review',
        source: 'adversarial-review',
        // One review result has completed, so the re-run is about to write round 2.
        round: 1,
        note: [
          '#### AR-1 — Spend screen has no way back',
          '**Severity:** blocker   **Area:** prototype',
          '**What:** no Home affordance.',
        ].join('\n'),
      });
    }
    // The gate's approve clears it: epics runs with no revision armed.
    expect(runner.seen[6].gateRevision).toBeUndefined();
  });

  it('counts one ROUND per completed review result and carries it into a later human revise', async () => {
    // The round number is the reviewer's only anchor for id continuity, so it has
    // to count EVERY completed review — the automatic lap's blocking one and the
    // clean one after it — not just the laps (which stop at their cap).
    const runner = reviewRunner([BLOCKING_RESULT, CLEAN_RESULT]);
    const host = makeHost({ 'approve-design': ['revise', 'approve'] });

    const result = await new WorkflowController(runner, host).run('run-ar-round', reviewDef());
    expect(result.outcome).toBe('completed');
    expect(runner.seen.map((s) => s.id)).toEqual([
      'expand-spec', 'ui-prototype', 'adversarial-review',
      // automatic lap after the blocking verdict
      'expand-spec', 'ui-prototype', 'adversarial-review',
      // the human then revises the (clean) second round
      'expand-spec', 'ui-prototype', 'adversarial-review',
      'epics',
    ]);
    // Lap: one review has completed, so the re-run writes round 2.
    expect(runner.seen[3].gateRevision?.round).toBe(1);
    expect(runner.seen[3].gateRevision?.source).toBe('adversarial-review');
    // Human revise after the lap: two reviews have completed — round 3 next. The
    // count is attributed to the phase's REVIEW step, not to the gate.
    expect(runner.seen[6].gateRevision).toEqual({ gateStepId: 'approve-design', round: 2 });
    expect(runner.seen[8].gateRevision?.round).toBe(2);
    // Approve clears it.
    expect(runner.seen[9].gateRevision).toBeUndefined();
  });

  it('omits the round on a gate whose phase has no adversarial-review step', async () => {
    const noReview = def([
      phase('refine', [
        step({ id: 'expand-spec' }),
        step({ id: 'approve-design', agent: 'human', human: true, loopback: 'expand-spec' }),
        step({ id: 'epics' }),
      ]),
    ]);
    const runner = reviewRunner([]);
    const host = makeHost({ 'approve-design': ['revise', 'approve'] });

    const result = await new WorkflowController(runner, host).run('run-ar-noreview', noReview);
    expect(result.outcome).toBe('completed');
    // The re-driven step learns WHICH gate sent it back and nothing more — no
    // invented round.
    expect(runner.seen[1].gateRevision).toEqual({ gateStepId: 'approve-design' });
  });

  it('falls through to the human gate when the second round is still blocking (bounded to one automatic lap)', async () => {
    const runner = reviewRunner([BLOCKING_RESULT, BLOCKING_RESULT]);
    const host = makeHost({ 'approve-design': ['approve'] });

    const result = await new WorkflowController(runner, host).run('run-ar2', reviewDef());
    expect(result.outcome).toBe('completed');
    expect(runner.seen.filter((s) => s.id === 'adversarial-review')).toHaveLength(2);
    expect(runner.seen.filter((s) => s.id === 'expand-spec')).toHaveLength(2);
    expect(host.gateCalls).toEqual(['approve-design']);
  });

  it('does not loop on REVIEW: CLEAN, on a `None.` blocking section, or without a declared loopback', async () => {
    // Clean verdict.
    let runner = reviewRunner([CLEAN_RESULT]);
    let host = makeHost();
    await new WorkflowController(runner, host).run('run-ar3', reviewDef());
    expect(runner.seen.filter((s) => s.id === 'expand-spec')).toHaveLength(1);

    // No trailer, but the section is the `None.` placeholder — not an entry.
    runner = reviewRunner(['Reported.\n\n## Blocking\n\nNone.\n\n## Findings\n\n#### AR-1 — nit']);
    host = makeHost();
    await new WorkflowController(runner, host).run('run-ar4', reviewDef());
    expect(runner.seen.filter((s) => s.id === 'expand-spec')).toHaveLength(1);

    // No trailer, populated section ⇒ still read as blocking (no-trailer tolerance).
    runner = reviewRunner(['Reported.\n\n## Blocking\n\n#### AR-1 — real defect\n**What:** x']);
    host = makeHost();
    await new WorkflowController(runner, host).run('run-ar5', reviewDef());
    expect(runner.seen.filter((s) => s.id === 'expand-spec')).toHaveLength(2);

    // BLOCKING but the step declares no loopback (ship/launch today) ⇒ advance.
    runner = reviewRunner([BLOCKING_RESULT]);
    host = makeHost();
    await new WorkflowController(runner, host).run('run-ar6', reviewDef(null));
    expect(runner.seen.filter((s) => s.id === 'expand-spec')).toHaveLength(1);
    expect(host.gateCalls).toEqual(['approve-design']);
  });

  it('a FAILED optional review skips instead of taking its loopback edge', async () => {
    // The loopback exists for the verdict; a crashed reviewer must not re-run the
    // whole design phase.
    const seen: string[] = [];
    const runner: StepRunner = {
      async runStep(s) {
        seen.push(s.id);
        if (s.id === 'adversarial-review') return { status: 'failed', error: 'boom' };
        return { status: 'ok' };
      },
    };
    const host = makeHost();
    const result = await new WorkflowController(runner, host).run('run-ar7', reviewDef());
    expect(result.outcome).toBe('completed');
    expect(seen).toEqual(['expand-spec', 'ui-prototype', 'adversarial-review', 'epics']);
    expect(host.reports.filter((r) => r.id === 'adversarial-review').map((r) => r.status)).toContain('skipped');
  });

  it('a SKIPPED optional gate clears the armed revision instead of leaking it into the steps after it', async () => {
    // The automatic lap arms a review-sourced revision for the re-driven region.
    // If the gate that would have consumed it self-skips, the steps AFTER it must
    // not keep receiving "a revision was requested" — nobody ever asked.
    const skippableGateDef = def([
      phase('refine', [
        step({ id: 'expand-spec' }),
        step({ id: 'ui-prototype', optional: true }),
        step({ id: 'adversarial-review', agent: 'adversarial-review', optional: true, loopback: 'expand-spec' }),
        step({ id: 'approve-design', agent: 'human', human: true, optional: true, loopback: 'expand-spec' }),
        step({ id: 'epics' }),
      ]),
    ]);
    const runner = reviewRunner([BLOCKING_RESULT, CLEAN_RESULT]);
    const host = makeHost();
    const withSkip: ControllerHost = {
      ...host,
      shouldSkipHumanGate: (s) => (s.id === 'approve-design' ? 'no design surface to review' : null),
    };

    const result = await new WorkflowController(runner, withSkip).run('run-ar-skip', skippableGateDef);
    expect(result.outcome).toBe('completed');
    expect(host.gateCalls).toEqual([]); // the gate never opened

    expect(runner.seen.map((s) => s.id)).toEqual([
      'expand-spec', 'ui-prototype', 'adversarial-review',
      // automatic lap after the blocking verdict
      'expand-spec', 'ui-prototype', 'adversarial-review',
      'epics',
    ]);
    // The lap's turns still carry the review-sourced revision…
    for (const turn of runner.seen.slice(3, 6)) {
      expect(turn.gateRevision?.source).toBe('adversarial-review');
    }
    // …and the skipped gate clears it before `epics`.
    expect(runner.seen[6].gateRevision).toBeUndefined();
  });

  it('an OPERATOR-skipped gate clears the armed revision the same way', async () => {
    // Same leak, other skip path: a RunDirectives skip of the gate step (monitor
    // `skip_step`) also never opens it, so it must also answer the revision.
    const skippableGateDef = def([
      phase('refine', [
        step({ id: 'expand-spec' }),
        step({ id: 'adversarial-review', agent: 'adversarial-review', optional: true, loopback: 'expand-spec' }),
        step({ id: 'approve-design', agent: 'human', human: true, optional: true, loopback: 'expand-spec' }),
        step({ id: 'epics' }),
      ]),
    ]);
    const runner = reviewRunner([BLOCKING_RESULT, CLEAN_RESULT]);
    const host = makeHost();
    const directives = createRunDirectives();
    directives.userSkippedStepIds.add('approve-design');

    const result = await new WorkflowController(runner, host).run(
      'run-ar-opskip', skippableGateDef, undefined, undefined, undefined, directives,
    );
    expect(result.outcome).toBe('completed');
    expect(host.gateCalls).toEqual([]);
    expect(runner.seen.map((s) => s.id)).toEqual([
      'expand-spec', 'adversarial-review', 'expand-spec', 'adversarial-review', 'epics',
    ]);
    expect(runner.seen[2].gateRevision?.source).toBe('adversarial-review');
    expect(runner.seen[4].gateRevision).toBeUndefined();
  });

  it('a plain step with an on-failure loopback still ignores REVIEW: BLOCKING in its result', async () => {
    // The verdict routing is keyed on the adversarial-review AGENT, not on the
    // presence of `loopback`.
    const seen: string[] = [];
    const runner: StepRunner = {
      async runStep(s) {
        seen.push(s.id);
        return { status: 'ok', resultText: s.id === 'b' ? BLOCKING_RESULT : undefined };
      },
    };
    const d = def([phase('p', [step({ id: 'a' }), step({ id: 'b', loopback: 'a' })])]);
    const result = await new WorkflowController(runner, makeHost()).run('run-ar8', d);
    expect(result.outcome).toBe('completed');
    expect(seen).toEqual(['a', 'b']);
  });
});
