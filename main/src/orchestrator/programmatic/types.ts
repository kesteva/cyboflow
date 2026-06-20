/**
 * Protocol types for the programmatic execution plane (Stage 1 of the
 * execution-model seam — see docs/sdk-program-driven-workflows.md).
 *
 * In the `programmatic` execution model, host CODE walks the workflow's DAG (its
 * `WorkflowDefinition`) instead of an orchestrator agent. The `WorkflowController`
 * owns the deterministic sequencing — phase/step order, optional-skip, the
 * retries + intra-phase loopback budget, human gates, and terminal detection —
 * and is driven entirely through the two injected collaborators declared here:
 *
 *   - `StepRunner`    — runs ONE non-human step's agent and returns a pass/fail
 *                       result. The SDK boundary (a real implementation invokes a
 *                       scoped agent turn); fully fakeable in unit tests.
 *   - `ControllerHost` — the cyboflow-side side-effect surface: step reporting
 *                       (drives the live timeline) and the human-gate decision.
 *
 * Keeping both as narrow injected interfaces makes the controller a PURE,
 * deterministic state machine that is exhaustively unit-testable with fakes,
 * with the unverifiable live-SDK work isolated behind `StepRunner`.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * 'fs', or any concrete service in main/src/services/*. Shared types only.
 */
import type { WorkflowStep } from '../../../../shared/types/workflows';

/**
 * Terminal status of a single step-agent invocation.
 *   - 'ok'      — the agent turn drained cleanly.
 *   - 'failed'  — the agent turn errored (retryable / loopback-able / escalates).
 *   - 'aborted' — the run was CANCELED mid-turn (the injected AbortSignal fired).
 *                 Distinct from 'failed' so the controller stops the walk instead
 *                 of retrying/looping back a step the user deliberately canceled.
 *                 (FIND: SDK abort resolves spawnCliProcess cleanly, so the runner
 *                 must consult the signal to tell cancel apart from success.)
 */
export type StepRunStatus = 'ok' | 'failed' | 'aborted';

/** Result returned by a StepRunner for one step invocation. */
export interface StepRunResult {
  status: StepRunStatus;
  /** Short human-readable summary of what the step produced (timeline/log). */
  summary?: string;
  /** Failure detail when status === 'failed' (surfaced on escalation). */
  error?: string;
}

/**
 * A human-gate decision returned by ControllerHost.requestHumanGate.
 *   - 'approve' / 'reject' / 'revise' — the human's verdict (revise loops back).
 *   - 'abort' — the run was CANCELED while parked at the gate (the AbortSignal
 *               fired). The controller ends the walk with a 'canceled' outcome.
 *               Never produced by parseGateVerdict — it comes only from the
 *               cancel/abort path, not from a resolution string.
 */
export type HumanGateDecision = 'approve' | 'reject' | 'revise' | 'abort';

/**
 * Context passed to a StepRunner / human gate for one attempt. `attempt` is
 * 1-based (the first try is attempt 1). `phaseId` + `stepIndex` locate the step
 * within the DAG for logging and lane/progress mapping. `signal` (when present)
 * fires when the run is canceled — the StepRunner and the human gate both consult
 * it so a canceled run stops promptly instead of completing or retrying.
 */
export interface ControllerStepContext {
  runId: string;
  phaseId: string;
  stepIndex: number;
  attempt: number;
  signal?: AbortSignal;
}

/**
 * Runs a single non-human step's agent. The production implementation invokes a
 * scoped agent turn (via the existing spawn surface) and maps a clean turn to
 * `ok` and a thrown/aborted turn to `failed`; test implementations return canned
 * results. The controller NEVER calls this for a human-gate step.
 */
export interface StepRunner {
  runStep(step: WorkflowStep, ctx: ControllerStepContext): Promise<StepRunResult>;
}

/**
 * A triage decision for a required step that has exhausted its retry + loopback
 * budget — the Stage 3 supervisory seam. Instead of the controller hard-failing,
 * it can consult a supervisor:
 *   - 'retry'    — re-run the step once more (bounded by a per-step triage budget).
 *   - 'escalate' — open a human gate routing the failure to the review queue; the
 *                  human then decides (approve = skip the step and advance, reject
 *                  = fail the run, revise = retry, abort = cancel).
 *   - 'fail'     — give up; the run fails (today's behavior; also the default when
 *                  no triage advisor is wired, keeping the seam dormant-safe).
 */
export type TriageDecision = 'retry' | 'escalate' | 'fail';

/** Kinds of run/step lifecycle event fed to the supervisor's monitor seam. */
export type SupervisorEventKind =
  | 'run-started'
  | 'step-running'
  | 'step-settled'
  | 'step-failed'
  | 'gate-opened'
  | 'run-finished';

/**
 * A monitoring event the controller emits to the supervisor (Stage 3 monitor
 * feed). Purely observational — the supervisor watches the host-driven walk; it
 * does NOT sequence it. `outcome`/`error` are populated for settle/finish/fail.
 */
export interface SupervisorEvent {
  kind: SupervisorEventKind;
  runId: string;
  phaseId?: string;
  stepId?: string;
  outcome?: string;
  error?: string;
}

/**
 * The cyboflow-side effect surface the controller drives. The first two methods
 * are owned by the host so the controller stays free of DB/IPC/Electron concerns.
 * The optional Stage 3 methods (notify / triageFailure) bridge the controller to
 * the supervisor; when both are absent the controller behaves exactly as Stages
 * 1-2 (monitor feed dropped, required-step failure escalates to a hard 'fail').
 */
export interface ControllerHost {
  /**
   * Report a step boundary to the live timeline. The controller calls this with
   * 'running' as it begins each step and 'done' when the step settles (whether
   * completed, skipped, failed, or rejected) — mirroring the orchestrated path's
   * single running/done pair per step. Must be fail-soft (never throw).
   */
  reportStep(stepId: string, status: 'running' | 'done'): void;

  /**
   * Resolve a human-gate step. The production host integrates with the review /
   * questions surface and blocks until the human responds; test hosts return a
   * canned decision. A 'revise' decision re-runs the gate's intra-phase loopback
   * target (or, absent a target, re-presents the gate).
   */
  requestHumanGate(step: WorkflowStep, ctx: ControllerStepContext): Promise<HumanGateDecision>;

  /**
   * Optional monitor feed (Stage 3). The controller calls this at run/step
   * boundaries so the supervisor can observe progress. Fail-soft (never throws);
   * absent ⇒ no monitoring.
   */
  notify?(event: SupervisorEvent): void;

  /**
   * Optional triage seam (Stage 3). Consulted when a REQUIRED step has exhausted
   * its retry + loopback budget, BEFORE the controller fails the run. Returns the
   * triage decision (retry / escalate-to-human / fail). Absent ⇒ the controller
   * fails the run exactly as in Stages 1-2.
   */
  triageFailure?(step: WorkflowStep, ctx: ControllerStepContext, error: string | undefined): Promise<TriageDecision>;

  /** Optional structured log sink; absent ⇒ the controller stays silent. */
  log?(level: 'info' | 'warn', message: string): void;
}

/** Outcome of a whole controller run over a WorkflowDefinition. */
export type ControllerOutcome = 'completed' | 'failed' | 'rejected' | 'canceled';

/** Per-step record accumulated during the walk (ordered as executed). */
export interface StepReport {
  stepId: string;
  phaseId: string;
  outcome: 'done' | 'skipped' | 'failed' | 'rejected' | 'canceled';
  /** Total agent invocations / gate presentations for this step. */
  attempts: number;
  error?: string;
}

/**
 * The controller's terminal result. `outcome`:
 *   - 'completed' — every required step settled (done or optional-skip).
 *   - 'failed'    — a required non-human step exhausted its retry/loopback budget.
 *   - 'rejected'  — a human gate was rejected (or a no-target gate's revise budget
 *                   was exhausted — a graceful terminal, not an internal throw).
 *   - 'canceled'  — the run was canceled mid-walk (the AbortSignal fired) — NOT a
 *                   failure; the cancel path owns the terminal DB transition.
 * `failedStepId` is set for 'failed', 'rejected', and 'canceled'.
 */
export interface ControllerResult {
  outcome: ControllerOutcome;
  steps: StepReport[];
  failedStepId?: string;
}
