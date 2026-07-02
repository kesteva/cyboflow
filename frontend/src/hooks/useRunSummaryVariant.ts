/**
 * useRunSummaryVariant — decides whether (and in what state) the end-of-workflow
 * WorkflowSummaryPanel replaces the WorkflowCanvas, from data the center pane
 * already has (run status + live phase state). One panel, three header states:
 *
 *   'failed'   — the run self-terminated on a TERMINAL error (status 'failed').
 *   'complete' — the run is end-eligible: self-terminated 'completed', or RESTED
 *                in awaiting_review with no open gate (useRunEndEligibility).
 *   'review'   — the run is STILL running but its CURRENT step is a `human: true`
 *                gate that is running: the flow agent has reached Human review and
 *                is waiting on its Approve/Reject decision. The summary (token use
 *                + future quality-eval score) is surfaced HERE because it is input
 *                INTO that human decision, so it must appear the moment the run
 *                hits the gate — not only once the run is terminal/rested.
 *
 * Returns null when the canvas should stay (a normally-progressing run).
 *
 * The review-gate signal is derived from the SAME `useWorkflowPhaseState` snapshot
 * the WorkflowCanvas renders (definition + currentStepId + stepStates) — no new
 * subscription. Precedence failed > complete > review keeps the states disjoint (a
 * review-gate run is 'running', so it is never also end-eligible or failed).
 */
import type { UseWorkflowPhaseStateResult } from './useWorkflowPhaseState';

export type RunSummaryVariant = 'complete' | 'failed' | 'review';

/**
 * True when the run's CURRENT step is a human gate (`human: true`) that is running
 * — i.e. the flow paused for the operator's review decision while the run itself
 * is still 'running'.
 */
export function isAtHumanReviewGate(
  phaseState: UseWorkflowPhaseStateResult,
  status: string | undefined,
): boolean {
  if (status !== 'running') return false;
  const { definition, currentStepId, stepStates } = phaseState;
  if (definition === null || currentStepId === null) return false;

  const currentStep = definition.phases
    .flatMap((p) => p.steps)
    .find((s) => s.id === currentStepId);
  if (currentStep?.human !== true) return false;

  // The step must be actively running (the gate is open), not merely the last
  // known current id from a stale snapshot.
  const stepStatus = stepStates.find((s) => s.stepId === currentStepId)?.status;
  return stepStatus === 'running';
}

/**
 * Resolve the summary-panel variant, or null to keep the canvas.
 *
 * @param status        The run's lifecycle status.
 * @param endEligible   Result of useRunEndEligibility (rested-no-gate / self-terminated).
 * @param phaseState    Live phase snapshot (for the review-gate signal).
 */
export function resolveRunSummaryVariant(
  status: string | undefined,
  endEligible: boolean,
  phaseState: UseWorkflowPhaseStateResult,
): RunSummaryVariant | null {
  if (status === 'failed') return 'failed';
  if (endEligible) return 'complete';
  if (isAtHumanReviewGate(phaseState, status)) return 'review';
  return null;
}
