import { describe, it, expect } from 'vitest';
import { isAtHumanReviewGate, isTerminalStepReached, resolveRunSummaryVariant } from '../useRunSummaryVariant';
import type { UseWorkflowPhaseStateResult } from '../useWorkflowPhaseState';
import type { WorkflowDefinition, WorkflowStep } from '../../../../shared/types/workflows';

function step(id: string, over: Partial<WorkflowStep> = {}): WorkflowStep {
  return { id, name: id, agent: 'a', mcps: [], retries: 0, ...over };
}

const DEF: WorkflowDefinition = {
  id: 'sprint',
  phases: [
    {
      id: 'execute',
      label: 'Execute',
      color: '#000',
      // approve-plan is a MID-FLOW human gate — it must never trigger the
      // end-of-run summary (only the flow's LAST step qualifies).
      steps: [step('approve-plan', { agent: 'human', human: true }), step('execute-tasks')],
    },
    {
      id: 'verify',
      label: 'Sprint review',
      color: '#000',
      steps: [step('sprint-verify'), step('human-review', { agent: 'human', human: true })],
    },
  ],
};

function phaseState(over: Partial<UseWorkflowPhaseStateResult> = {}): UseWorkflowPhaseStateResult {
  return { definition: DEF, currentStepId: null, stepStates: [], isLoading: false, error: null, ...over };
}

describe('isAtHumanReviewGate', () => {
  it('is true when the running current step is the FINAL human gate', () => {
    const ps = phaseState({ currentStepId: 'human-review', stepStates: [{ stepId: 'human-review', status: 'running' }] });
    expect(isAtHumanReviewGate(ps, 'running')).toBe(true);
  });

  it('is false at a MID-FLOW human gate (only the last step qualifies)', () => {
    const ps = phaseState({ currentStepId: 'approve-plan', stepStates: [{ stepId: 'approve-plan', status: 'running' }] });
    expect(isAtHumanReviewGate(ps, 'running')).toBe(false);
  });

  it('is false when the current step is a non-human step (still running)', () => {
    const ps = phaseState({ currentStepId: 'execute-tasks', stepStates: [{ stepId: 'execute-tasks', status: 'running' }] });
    expect(isAtHumanReviewGate(ps, 'running')).toBe(false);
  });

  it('is false when the human step is not yet running (pending)', () => {
    const ps = phaseState({ currentStepId: 'human-review', stepStates: [{ stepId: 'human-review', status: 'pending' }] });
    expect(isAtHumanReviewGate(ps, 'running')).toBe(false);
  });

  it('is false when the run status is not running (e.g. awaiting_review)', () => {
    const ps = phaseState({ currentStepId: 'human-review', stepStates: [{ stepId: 'human-review', status: 'running' }] });
    expect(isAtHumanReviewGate(ps, 'awaiting_review')).toBe(false);
  });

  it('is false with no definition yet (query unresolved)', () => {
    expect(isAtHumanReviewGate(phaseState({ definition: null, currentStepId: 'human-review' }), 'running')).toBe(false);
  });
});

describe('isTerminalStepReached', () => {
  it('is false with no definition yet (query unresolved)', () => {
    expect(isTerminalStepReached(phaseState({ definition: null }))).toBe(false);
  });

  it("is true when currentStepId is the flow's LAST step", () => {
    const ps = phaseState({
      currentStepId: 'human-review',
      stepStates: [{ stepId: 'human-review', status: 'done' }],
    });
    expect(isTerminalStepReached(ps)).toBe(true);
  });

  it('is true when every known step state is done, regardless of currentStepId', () => {
    const ps = phaseState({
      currentStepId: 'execute-tasks',
      stepStates: [
        { stepId: 'approve-plan', status: 'done' },
        { stepId: 'execute-tasks', status: 'done' },
        { stepId: 'sprint-verify', status: 'done' },
        { stepId: 'human-review', status: 'done' },
      ],
    });
    expect(isTerminalStepReached(ps)).toBe(true);
  });

  it("is true when steps are settled as a mix of 'done' and 'skipped' (a surviving skip marker must not withhold 'complete')", () => {
    const ps = phaseState({
      currentStepId: 'sprint-verify',
      stepStates: [
        { stepId: 'approve-plan', status: 'done' },
        { stepId: 'execute-tasks', status: 'done' },
        { stepId: 'sprint-verify', status: 'skipped' },
        { stepId: 'human-review', status: 'done' },
      ],
    });
    expect(isTerminalStepReached(ps)).toBe(true);
  });

  it('is false at a mid-flow step with concrete non-done step state (the interactive turn-end-rest regression, 2026-07-06)', () => {
    const ps = phaseState({
      currentStepId: 'execute-tasks',
      stepStates: [
        { stepId: 'approve-plan', status: 'done' },
        { stepId: 'execute-tasks', status: 'running' },
        { stepId: 'sprint-verify', status: 'pending' },
        { stepId: 'human-review', status: 'pending' },
      ],
    });
    expect(isTerminalStepReached(ps)).toBe(false);
  });

  it('is true with no step-transition data at all (no evidence of an open step)', () => {
    expect(isTerminalStepReached(phaseState())).toBe(true);
  });
});

describe('resolveRunSummaryVariant', () => {
  const idle = phaseState();
  const atGate = phaseState({ currentStepId: 'human-review', stepStates: [{ stepId: 'human-review', status: 'running' }] });

  it("→ 'failed' for a failed run (precedence over everything)", () => {
    expect(resolveRunSummaryVariant('failed', true, atGate)).toBe('failed');
  });

  it("→ 'complete' when end-eligible and not failed", () => {
    expect(resolveRunSummaryVariant('completed', true, idle)).toBe('complete');
    expect(resolveRunSummaryVariant('awaiting_review', true, idle)).toBe('complete');
  });

  it("→ 'review' when running at the final human gate (not end-eligible)", () => {
    expect(resolveRunSummaryVariant('running', false, atGate)).toBe('review');
  });

  it('→ null (keep the canvas) at a mid-flow human gate', () => {
    const midGate = phaseState({
      currentStepId: 'approve-plan',
      stepStates: [{ stepId: 'approve-plan', status: 'running' }],
    });
    expect(resolveRunSummaryVariant('running', false, midGate)).toBeNull();
  });

  it('→ null (keep the canvas) for a normally-running run', () => {
    expect(resolveRunSummaryVariant('running', false, idle)).toBeNull();
  });

  it("regression: awaiting_review + endEligible mid-flow with concrete non-done step state → NOT 'complete' (interactive turn-end-rest, 2026-07-06)", () => {
    const midFlowRunning = phaseState({
      currentStepId: 'execute-tasks',
      stepStates: [
        { stepId: 'approve-plan', status: 'done' },
        { stepId: 'execute-tasks', status: 'running' },
        { stepId: 'sprint-verify', status: 'pending' },
        { stepId: 'human-review', status: 'pending' },
      ],
    });
    expect(resolveRunSummaryVariant('awaiting_review', true, midFlowRunning)).toBeNull();
  });

  it("→ 'complete' when awaiting_review + endEligible and currentStepId is the flow's LAST step", () => {
    const atLastStep = phaseState({
      currentStepId: 'human-review',
      stepStates: [{ stepId: 'human-review', status: 'done' }],
    });
    expect(resolveRunSummaryVariant('awaiting_review', true, atLastStep)).toBe('complete');
  });

  it("→ 'complete' when awaiting_review + endEligible and every step state is done", () => {
    const allDone = phaseState({
      currentStepId: 'execute-tasks',
      stepStates: [
        { stepId: 'approve-plan', status: 'done' },
        { stepId: 'execute-tasks', status: 'done' },
        { stepId: 'sprint-verify', status: 'done' },
        { stepId: 'human-review', status: 'done' },
      ],
    });
    expect(resolveRunSummaryVariant('awaiting_review', true, allDone)).toBe('complete');
  });

  it("→ 'complete' unconditionally for status 'completed' even when phase state is still loading (definition null)", () => {
    expect(resolveRunSummaryVariant('completed', true, phaseState({ definition: null }))).toBe('complete');
  });

  it("→ NOT 'complete' for awaiting_review + endEligible while phase state is still loading (definition null)", () => {
    expect(resolveRunSummaryVariant('awaiting_review', true, phaseState({ definition: null }))).toBeNull();
  });
});
