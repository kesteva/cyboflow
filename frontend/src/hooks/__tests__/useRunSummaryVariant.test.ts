import { describe, it, expect } from 'vitest';
import { isAtHumanReviewGate, resolveRunSummaryVariant } from '../useRunSummaryVariant';
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
});
