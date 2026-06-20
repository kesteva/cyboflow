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

/** Terminal status of a single step-agent invocation. */
export type StepRunStatus = 'ok' | 'failed';

/** Result returned by a StepRunner for one step invocation. */
export interface StepRunResult {
  status: StepRunStatus;
  /** Short human-readable summary of what the step produced (timeline/log). */
  summary?: string;
  /** Failure detail when status === 'failed' (surfaced on escalation). */
  error?: string;
}

/** A human-gate decision returned by ControllerHost.requestHumanGate. */
export type HumanGateDecision = 'approve' | 'reject' | 'revise';

/**
 * Context passed to a StepRunner / human gate for one attempt. `attempt` is
 * 1-based (the first try is attempt 1). `phaseId` + `stepIndex` locate the step
 * within the DAG for logging and lane/progress mapping.
 */
export interface ControllerStepContext {
  runId: string;
  phaseId: string;
  stepIndex: number;
  attempt: number;
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
 * The cyboflow-side effect surface the controller drives. Both methods are owned
 * by the host so the controller stays free of DB/IPC/Electron concerns.
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

  /** Optional structured log sink; absent ⇒ the controller stays silent. */
  log?(level: 'info' | 'warn', message: string): void;
}

/** Outcome of a whole controller run over a WorkflowDefinition. */
export type ControllerOutcome = 'completed' | 'failed' | 'rejected';

/** Per-step record accumulated during the walk (ordered as executed). */
export interface StepReport {
  stepId: string;
  phaseId: string;
  outcome: 'done' | 'skipped' | 'failed' | 'rejected';
  /** Total agent invocations / gate presentations for this step. */
  attempts: number;
  error?: string;
}

/**
 * The controller's terminal result. `outcome`:
 *   - 'completed' — every required step settled (done or optional-skip).
 *   - 'failed'    — a required non-human step exhausted its retry/loopback budget.
 *   - 'rejected'  — a human gate was rejected.
 * `failedStepId` is set for 'failed' and 'rejected'.
 */
export interface ControllerResult {
  outcome: ControllerOutcome;
  steps: StepReport[];
  failedStepId?: string;
}
