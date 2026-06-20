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
  HumanGateDecision,
  StepRunResult,
  StepRunner,
} from '../types';
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
    const d = def([phase('p1', [step({ id: 'gate', human: true }), step({ id: 'a' })])]);
    const host = makeHost({ gate: ['reject'] });

    const result = await new WorkflowController(makeRunner(), host).run('r', d);

    expect(result.outcome).toBe('rejected');
    expect(result.failedStepId).toBe('gate');
  });

  it("loops back on a human gate 'revise' decision, then completes on approve", async () => {
    // p1: work, gate(loopback→work). gate revises once → rerun work → gate approves.
    const d = def([
      phase('p1', [step({ id: 'work' }), step({ id: 'gate', human: true, loopback: 'work' })]),
    ]);
    const runner = makeRunner();
    const host = makeHost({ gate: ['revise', 'approve'] });

    const result = await new WorkflowController(runner, host).run('r', d);

    expect(result.outcome).toBe('completed');
    expect(runner.calls.map((c) => c.id)).toEqual(['work', 'work']); // work ran twice
    expect(host.gateCalls).toEqual(['gate', 'gate']); // gate presented twice
  });
});
