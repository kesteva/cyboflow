/**
 * useRunSummaryVariant — decides whether (and in what state) the end-of-workflow
 * WorkflowSummaryPanel replaces the WorkflowCanvas, from data the center pane
 * already has (run status + live phase state). One panel, three header states:
 *
 *   'failed'   — the run self-terminated on a TERMINAL error (status 'failed').
 *   'complete' — the run self-terminated 'completed' (unconditional), OR RESTED
 *                in awaiting_review with no open gate (useRunEndEligibility)
 *                AND phase state confirms the flow actually reached its LAST
 *                step (isTerminalStepReached).
 *   'review'   — the run is STILL running but its CURRENT step is the flow's
 *                LAST step and a `human: true` gate that is running: the flow
 *                agent has reached the final Human review and is waiting on its
 *                Approve/Reject decision. The summary (token use + future
 *                quality-eval score) is surfaced HERE because it is input INTO
 *                that final decision, so it must appear the moment the run hits
 *                the gate — not only once the run is terminal/rested. Mid-flow
 *                human gates (approve-idea / approve-design / approve-plan) do
 *                NOT swap the canvas out — an end-of-run summary popping up in
 *                the middle of a flow reads as the run being over when it isn't.
 *
 * Returns null when the canvas should stay (a normally-progressing run).
 *
 * The review-gate signal is derived from the SAME `useWorkflowPhaseState` snapshot
 * the WorkflowCanvas renders (definition + currentStepId + stepStates) — no new
 * subscription. Precedence failed > complete > review keeps the states disjoint (a
 * review-gate run is 'running', so it is never also end-eligible or failed).
 *
 * WHY awaiting_review alone is not enough (2026-07-06 incident): on the
 * INTERACTIVE substrate, the backend rests every orchestrated run in
 * awaiting_review at each assistant turn-end (registerTurnEndRest) — including
 * turns that end mid-workflow with no open gate (e.g. the agent yields "waiting
 * for a background agent"). useRunEndEligibility can't tell that apart from a
 * genuine end-of-walk rest; it only knows there's no pending gate right now. So
 * `endEligible` alone flashed the 'complete' card while the step timeline still
 * showed a step running and gates pending. Phase position is the only signal
 * that discriminates the two, hence isTerminalStepReached below. This is an
 * interactive-only failure mode: SDK-orchestrated runs only drain into
 * awaiting_review at the true end of the walk, and programmatic runs rest once
 * at the end of their walk — neither rests mid-flow the way interactive does.
 * A residual false negative (the agent under-reports the final step) is
 * acceptable: useRunEndEligibility and the top-bar End button are deliberately
 * NOT gated by this — End always stays available as a bail-out.
 */
import type { UseWorkflowPhaseStateResult } from './useWorkflowPhaseState';

export type RunSummaryVariant = 'complete' | 'failed' | 'review';

/**
 * True when the run's CURRENT step is the flow's FINAL step, a human gate
 * (`human: true`), and running — i.e. the flow paused for the operator's
 * end-of-run review decision while the run itself is still 'running'. Mid-flow
 * human gates deliberately do NOT qualify: swapping the canvas for the summary
 * mid-flow reads as the run being over when it isn't.
 */
export function isAtHumanReviewGate(
  phaseState: UseWorkflowPhaseStateResult,
  status: string | undefined,
): boolean {
  if (status !== 'running') return false;
  const { definition, currentStepId, stepStates } = phaseState;
  if (definition === null || currentStepId === null) return false;

  const flatSteps = definition.phases.flatMap((p) => p.steps);
  const currentStep = flatSteps.length > 0 ? flatSteps[flatSteps.length - 1] : undefined;
  if (currentStep === undefined || currentStep.id !== currentStepId) return false;
  if (currentStep.human !== true) return false;

  // The step must be actively running (the gate is open), not merely the last
  // known current id from a stale snapshot.
  const stepStatus = stepStates.find((s) => s.stepId === currentStepId)?.status;
  return stepStatus === 'running';
}

/**
 * True when phase state confirms the flow's walk has actually reached its end,
 * as opposed to an interactive turn-end rest landing mid-workflow (see the
 * module docblock for the 2026-07-06 incident this guards against).
 *
 * Order of checks, each a positive signal the walk is done:
 *   1. No definition loaded yet → false. Transient (query still in flight) —
 *      keep the canvas rather than flash a wrong card off a stale/empty snapshot.
 *   2. The flow has no steps at all → true (trivially at the end).
 *   3. currentStepId is the LAST flat step across all phases → true.
 *   4. There is at least one step state and every one of them is 'done' → true
 *      (getPhaseState force-marks all steps done for terminal run statuses, so
 *      a self-terminated run also satisfies this).
 *   5. No step-transition data has been observed at all (currentStepId null and
 *      stepStates empty) → true. There's no positive evidence of an open,
 *      non-terminal step to withhold 'complete' over, so this falls back to
 *      trusting endEligible alone (the pre-fix behavior) rather than blocking a
 *      genuinely rested run on missing telemetry.
 *
 * Anything else — a known, non-last currentStepId, or concrete step states that
 * aren't all 'done' — is the regression case: false.
 */
export function isTerminalStepReached(phaseState: UseWorkflowPhaseStateResult): boolean {
  const { definition, currentStepId, stepStates } = phaseState;
  if (definition === null) return false;

  const flatSteps = definition.phases.flatMap((p) => p.steps);
  if (flatSteps.length === 0) return true;

  const lastStepId = flatSteps[flatSteps.length - 1].id;
  if (currentStepId === lastStepId) return true;

  if (stepStates.length > 0 && stepStates.every((s) => s.status === 'done')) return true;

  if (currentStepId === null && stepStates.length === 0) return true;

  return false;
}

/**
 * Resolve the summary-panel variant, or null to keep the canvas.
 *
 * @param status        The run's lifecycle status.
 * @param endEligible   Result of useRunEndEligibility (rested-no-gate / self-terminated).
 * @param phaseState    Live phase snapshot (for the review-gate and terminal-step signals).
 */
export function resolveRunSummaryVariant(
  status: string | undefined,
  endEligible: boolean,
  phaseState: UseWorkflowPhaseStateResult,
): RunSummaryVariant | null {
  if (status === 'failed') return 'failed';
  // 'completed' is unconditional (self-terminated, nothing left to discriminate).
  // Any other end-eligible status (awaiting_review) additionally requires phase
  // state to confirm the walk actually reached its last step — see
  // isTerminalStepReached and the module docblock.
  if (endEligible && (status === 'completed' || isTerminalStepReached(phaseState))) {
    return 'complete';
  }
  if (isAtHumanReviewGate(phaseState, status)) return 'review';
  return null;
}
