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
import type { SprintBatchTaskStatus } from '../../../../shared/types/sprintBatch';

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
  /**
   * Fan-out item context — present ONLY when this is one item's inner step (the
   * host walks a fanOut step). Absent for every normal single-step invocation, so
   * the single-step prompt path stays byte-identical. The downstream
   * `SpawnStepRunner`/`composeStepPrompt` scope the agent to this item.
   */
  item?: { id: string; over: string };
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
 * budget — the monitor-unify triage seam. Instead of the controller hard-failing,
 * it can consult the ON-DEMAND monitor (or, absent a monitor, the host defaults to
 * 'escalate' — routing every exhausted required failure to the human review queue):
 *   - 'retry'    — re-run the step once more (bounded by a per-step triage budget).
 *   - 'escalate' — open a human gate routing the failure to the review queue; the
 *                  human then decides (approve = skip the step and advance, reject
 *                  = fail the run, revise = retry, abort = cancel). The host's
 *                  default when no monitor is wired.
 *   - 'fail'     — give up; the run fails. Only produced by an active monitor that
 *                  judges the failure definitive; never the host's default.
 */
export type TriageDecision = 'retry' | 'escalate' | 'fail';

/** Kinds of run/step lifecycle event the controller can emit on its monitor feed. */
export type SupervisorEventKind =
  | 'run-started'
  | 'step-running'
  | 'step-settled'
  | 'step-failed'
  | 'gate-opened'
  | 'run-finished';

/**
 * A monitoring event the controller emits on its optional monitor feed (`host.notify`).
 * Purely observational — it does NOT sequence the walk. `outcome`/`error` are
 * populated for settle/finish/fail. After the monitor-unify refactor the production
 * host no longer consumes this feed (routine progress lives in the stepper, not the
 * chat); the feed is retained as a no-op-safe optional seam so the controller stays
 * unchanged.
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
 * Resolves the runtime item set + drives one lane per item for a `fanOut` step
 * (host-driven parallel fan-out on the PROGRAMMATIC plane). Injected on
 * `ControllerHost.fanOut` so the controller stays free of DB/IPC — the production
 * implementation is sprint-lane backed (writes `sprint_batch_tasks` via
 * `SprintLaneStore`, which emits on `sprintLaneChannel`); test hosts fake it.
 * Absent ⇒ the controller never fans out (a fanOut step runs as a normal step).
 */
export interface FanOutDriver {
  /**
   * Resolve the item ids for `over` (e.g. 'tasks' → the run's batch lane task
   * ids). An empty result ⇒ NO fan-out — the controller falls through to the
   * normal single agent-step path (byte-identical to today). SHOULD be fail-soft
   * (the production driver hits the DB); a throw is contained by the controller
   * and treated as an empty result, so a transient DB error degrades to a single
   * step rather than crashing the run.
   */
  resolveItems(runId: string, over: string): string[];
  /**
   * Resolve the BLOCKING dependency edges among the item set: a map from item id to
   * the ids of the items it must wait for (its prerequisites). The controller uses
   * it to schedule DAG waves — a task is dispatched only once all of its in-scope
   * prerequisites have integrated. OPTIONAL: absent (or an empty map) ⇒ every task
   * is ready immediately and the fan-out runs flat cap-sized waves (byte-identical
   * to the pre-DAG behavior). MAY hit the DB (the production driver reads
   * `task_dependencies`); a throw is contained by the controller (treated as no
   * dependencies), so a transient error degrades to a flat run rather than crashing.
   */
  dependencies?(runId: string, over: string): Map<string, string[]>;
  /**
   * Drive a lane's status/step for ONE item. Fail-soft — MUST never throw (the
   * controller does not wrap this); the production driver swallows lane-store
   * errors and logs. `allowedStepIds` is the fanOut step's inner-id vocabulary,
   * threaded so the lane store validates `currentStepId` against it.
   */
  driveLane(args: {
    runId: string;
    itemId: string;
    status?: SprintBatchTaskStatus;
    currentStepId?: string | null;
    allowedStepIds: readonly string[];
  }): void;
}

/**
 * The cyboflow-side effect surface the controller drives. `reportStep` +
 * `requestHumanGate` are owned by the host so the controller stays free of
 * DB/IPC/Electron concerns. The optional `triageFailure` seam consults the
 * ON-DEMAND monitor (or, absent one, the host returns 'escalate' — the default
 * review-queue routing). `notify` is the optional monitor feed; the production host
 * no longer implements it (no continuous chat feed), so the controller's
 * `host.notify?.(...)` calls are a safe no-op.
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
   * Optional monitor feed. The controller calls this at run/step boundaries.
   * Fail-soft (never throws); the production host no longer implements it (no
   * continuous chat feed), so absent ⇒ the feed is dropped.
   */
  notify?(event: SupervisorEvent): void;

  /**
   * Optional triage seam. Consulted when a REQUIRED step has exhausted its retry +
   * loopback budget, BEFORE the controller fails the run. Returns the triage
   * decision (retry / escalate-to-human / fail). Absent ⇒ the controller fails the
   * run. The production host always implements it (escalate by default, or the
   * monitor's verdict when one is wired).
   */
  triageFailure?(step: WorkflowStep, ctx: ControllerStepContext, error: string | undefined): Promise<TriageDecision>;

  /**
   * Optional per-step result sink (Stage 3, migration 033). The controller calls
   * this each time a step SETTLES (with its final StepReport) so the host can
   * persist it — backing queryable per-step results and crash-safe resume (skip
   * individually-completed steps). Fail-soft; absent ⇒ results live only in the
   * returned ControllerResult.
   */
  recordStepResult?(report: StepReport): void;

  /**
   * Optional fan-out lane driver. Present ONLY on the programmatic host for a
   * seeded sprint-style run (a `batch_id` exists). When present AND a step
   * declares `fanOut` AND the driver resolves a non-empty item set, the
   * controller walks each item through the inner chain, driving a lane per item.
   * Absent ⇒ the controller never fans out (a `fanOut` step runs as a normal
   * single agent step — today's behavior for orchestrated runs and tests).
   */
  fanOut?: FanOutDriver;

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
