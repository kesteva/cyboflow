/**
 * Protocol types for the programmatic execution plane (Stage 1 of the
 * execution-model seam — see docs/proposals/sdk-program-driven-workflows.md).
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
import type { WorkflowStep, WorkflowStepReportStatus } from '../../../../shared/types/workflows';
import type { SprintBatchTaskStatus } from '../../../../shared/types/sprintBatch';
import type { VerificationTaskV1 } from '../../../../shared/types/visualVerification';
import type {
  AdversarialFinding,
  ParsedAdversarialReview,
} from '../../../../shared/types/adversarialReview';

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
  /**
   * True when the failure is SYSTEMIC — an environment-level condition (usage /
   * session / rate limit, provider overload, auth) that no retry of THIS step can
   * fix until it clears. Classified by the runner (see systemicError.ts). The
   * controller routes a systemic failure to `ControllerHost.awaitSystemicPause`
   * (park + retry after clear) instead of consuming the step's retry budget,
   * optional-skip, loopback, or triage — those are for step-specific defects.
   * Absent/false ⇒ a normal step failure (today's behavior).
   */
  systemic?: boolean;
  /**
   * The step agent's FINAL result text captured at the spawn seam (per-spawnKey,
   * so concurrent fan-out lanes never cross-attribute); consumed by the controller
   * to parse typed step outputs (first consumer: the task-verify visual-
   * verification contract, docs/proposals/verification-agent-redesign.md §5.3).
   * Absent on failed/aborted turns and on substrates that do not capture it
   * (interactive, codex).
   */
  resultText?: string | null;
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
  /**
   * Additive per-lane spawn identity (`runId + ':' + itemId`). Set ONLY for a
   * fan-out item's inner step so concurrent lanes each spawn under a distinct
   * key (their own spawn lock / dup-guard / per-spawn maps) instead of
   * serializing on the shared run panelId. Absent for every non-fan-out path,
   * where the spawner defaults it to panelId (byte-identical behavior).
   */
  spawnKey?: string;
  /**
   * The §5.1 visual-verification output-contract defect quoted back to a
   * RE-DELEGATED task-verify (verification-agent redesign §5.3). Set ONLY on the
   * single contract re-run the controller performs when task-verify's PASS result
   * carried neither a `## Visual verification task` fence nor a NOT-APPLICABLE
   * line (or an unparseable/duplicate one); `composeStepPrompt` renders it as a
   * section instructing the agent to re-emit its FULL result with exactly one of
   * the two contract forms. Absent on every normal turn (output unchanged).
   */
  contractError?: string;
  /**
   * The visual merge-gate's failure report quoted VERBATIM to a re-delegated
   * implement step (verification-agent redesign §5.3 "not just 'a blocking
   * finding exists'"). Set ONLY on the step a visual-verify FAIL loopback
   * re-drives, so the re-implement agent sees what was tested, what failed, and
   * why. Absent on every normal turn (output unchanged).
   */
  loopbackFeedback?: string;
  /**
   * A human gate's 'revise' decision, threaded into every step the gate's
   * loopback re-drives — up to and including the gate's own re-presentation.
   *
   * The plain (non-fan-out) step walk had no feedback channel at all: a 'revise'
   * jumped to the loopback target and the re-run step was handed exactly the
   * prompt it got the first time, with no idea a human had rejected its output
   * or why. It then reproduced the same work. `loopbackFeedback` could not serve
   * this — it is populated only by the sprint fan-out's visual merge-gate and its
   * prompt section is hardcoded to visual-verification wording, which would read
   * as nonsense on a design revision.
   *
   * STICKY across the revisited region, deliberately: the note describes what the
   * whole re-run must do differently, not one step's defect, and every step from
   * the target forward is part of that re-run. Cleared once the gate is reached
   * again. Absent on every normal turn (output unchanged).
   *
   * `source` names who sent the region back. Absent ⇒ a human gate 'revise'
   * (the original channel, rendered unchanged). `'adversarial-review'` ⇒ the
   * controller's AUTOMATIC revision: an adversarial-review step whose result
   * carried `REVIEW: BLOCKING` looped back to its declared target before the
   * human ever saw the design gate, and `note` holds the review's `## Blocking`
   * section. The prompt renders a different heading for it, so the re-run agent
   * never reads a machine verdict as "a human rejected this".
   *
   * `round` is how many adversarial-review results this walk has completed for
   * the review step attached to this revision — so the re-run's prompt can tell
   * the reviewer which round it is about to write and which `AR-n` ids are
   * already spent. Absent when the walk has no review step for the gate, or when
   * the revision came from a path that never ran one; the prompt then drops the
   * round clause and keeps the rest. It is WALK state, not run state: a restart
   * or a rewind resets it, which is why it is never persisted.
   */
  gateRevision?: {
    gateStepId: string;
    note?: string;
    source?: 'adversarial-review';
    round?: number;
    /**
     * The supervisor's steering for THIS automatic lap — present only on a
     * `source: 'adversarial-review'` revision whose lap the supervisor voted
     * for. It names the entries the lap must close and the ones it must NOT
     * spend itself on, and the prompt renders it as outranking the review
     * itself. Absent on a mechanical lap (no supervisor verdict) and on every
     * human-gate revision, where the prompt is byte-identical to before.
     */
    steering?: ReviewLoopSteering;
  };
  /**
   * Provenance for the gate this ctx opens, when a supervisor intervention put
   * it there (today: a `stop` verdict that ended the automatic review loop).
   * Set on the ONE `requestHumanGate` call that follows the intervention and
   * cleared the moment that call returns — it is about this gate presentation,
   * not a standing property of the run. Absent on every ordinary gate.
   */
  escalation?: ControllerEscalation;
  /**
   * The final text of the most recent preceding AGENT step, forwarded to a step
   * whose definition sets `consumesPriorStepOutput` (see
   * `WorkflowStep.consumesPriorStepOutput` for why the channel exists). Human
   * gates are transparent when looking back, so a step after a gate still sees
   * the last agent turn.
   *
   * `text` is absent when the previous step produced no capturable final text —
   * a substrate that cannot capture it, or a turn that returned nothing. The
   * consuming prompt renders that case explicitly rather than dropping the
   * section, so the agent knows the channel failed instead of assuming the
   * previous step had nothing to say.
   */
  priorStepOutput?: { stepId: string; name: string; text?: string };
  /**
   * The supervisor's LANE-RESCUE guidance for THIS fan-out item (monitor lane
   * triage). Unlike `contractError` / `loopbackFeedback` — one-shot sections
   * consumed by a single re-driven step — this is STICKY: once a lane is
   * rescued the controller threads it into EVERY subsequent inner-step spawn of
   * that lane until the lane settles, because the guidance describes what the
   * whole re-run must do differently, not one step's defect.
   *
   * It is per-LANE, which is exactly why it rides the ctx instead of
   * `RunDirectives.stepGuidance`: that map is keyed by bare step id and SHARED
   * across every lane, so storing lane guidance there would leak one task's
   * rescue into every sibling lane's next spawn of the same step.
   * `composeStepPrompt` renders it under the SAME `## Operator guidance`
   * section as the operator's own steer, labelled so the agent knows which is
   * which. Absent on every non-rescued lane and every non-fan-out step
   * (byte-identical prompts).
   */
  laneGuidance?: string;
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

/**
 * Verdict of a SYSTEMIC pause (usage/session/rate-limit park — see
 * `ControllerHost.awaitSystemicPause` and StepRunResult.systemic):
 *   - 'retry'    — the condition cleared (human resolved the pause item, or the
 *                  auto-resume timer fired at the limit-reset time); re-run the
 *                  SAME step WITHOUT consuming its retry budget.
 *   - 'giveup'   — the human dismissed the pause (stop waiting); the failure then
 *                  follows the NORMAL step-failure path (retries left → re-attempt,
 *                  else optional-skip / loopback / triage) — byte-identical to a
 *                  world without the systemic seam.
 *   - 'canceled' — the run was canceled while parked; end the walk 'canceled'.
 */
export type SystemicPauseVerdict = 'retry' | 'giveup' | 'canceled';

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
 * One lane-end commit-integrity reading (see `FanOutDriver.beginCommitProbe`).
 * `headAdvanced` — the worktree's HEAD sha moved since the lane was dispatched.
 * `dirty` — `git status --porcelain` is non-empty, i.e. tracked edits and/or
 * untracked files are still sitting in the worktree uncommitted.
 */
export interface CommitIntegrityReading {
  headAdvanced: boolean;
  dirty: boolean;
}

/** The lane-end half of a commit-integrity probe (see `beginCommitProbe`). */
export type CommitIntegrityProbe = () => Promise<CommitIntegrityReading>;

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
   * Resolve each item's expected file paths from the task-file substrate. The
   * controller uses this to keep overlapping tasks out of the same concurrent
   * wave while retaining parallelism for disjoint tasks. OPTIONAL: absent (or an
   * empty map) preserves the dependency-only scheduler. Like `dependencies`, a
   * production implementation may query the DB and a throw is contained by the
   * controller, which then schedules without file-conflict serialization.
   */
  expectedFiles?(runId: string, over: string): Map<string, string[]>;
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
    /**
     * 1-based lane attempt written when a failed inner step loops back. The
     * first pass remains 0 in the persisted lane row; re-delegates record 2 then
     * 3, matching the Ship fan-out contract.
     */
    attempt?: number;
    allowedStepIds: readonly string[];
  }): void;
  /**
   * Open a commit-integrity probe for a lane about to be dispatched. The OUTER
   * call captures the worktree's lane-start state (its HEAD sha); the returned
   * closure re-reads it at the lane's success end, right before the controller
   * would stamp 'integrated'. A lane that ran every inner step green but left
   * HEAD where it was AND the worktree dirty never committed its work — observed
   * live when a `git commit` was denied by a permission gate and the lane still
   * reported integrated with the changes untracked on disk.
   *
   * OPTIONAL and fail-soft at every seam, like `dependencies`/`expectedFiles`:
   * absent, resolving undefined, or throwing (in either half) ⇒ no probe ⇒ the
   * lane integrates on inner-step verdicts alone, byte-identical to the
   * pre-backstop behavior. The backstop may only WITHHOLD a false 'integrated';
   * it must never invent a failure of its own.
   */
  beginCommitProbe?(runId: string): Promise<CommitIntegrityProbe | undefined>;
  /**
   * OPTIONAL targeted un-settle of ONE lane from 'failed' back to 'running',
   * for the controller's MONITOR LANE RESCUE at the visual merge gate. The
   * merge-gate driver durably writes the lane 'failed' BEFORE the controller's
   * `awaitVerdict` resolves, so a lane the supervisor rescues is already settled
   * in the store while its in-memory walk is still live and about to re-drive
   * it. Production maps this to `SprintLaneStore.reviveLane` (status-guarded to
   * 'failed', routed through the same updateLane chokepoint + emit as every
   * other lane write). Fail-soft — MUST never throw (like `driveLane`, the
   * controller does not wrap it). Absent (test drivers / non-sprint fan-outs) ⇒
   * the rescue simply re-drives without the row un-settle.
   */
  reviveLane?(args: { runId: string; itemId: string }): void;
}

/** Ship's per-lane loopback contract: initial pass plus at most two re-delegates. */
export const FAN_OUT_LANE_ATTEMPT_CAP = 3;

/**
 * Which automatic budget a sprint fan-out LANE exhausted before the controller
 * would settle it 'failed'. Rendered into the monitor's lane-triage prompt so it
 * knows what evidence to look for; the controller decides which sites consult.
 * Canonical HERE (not in monitor.ts) so the controller/host protocol stays free
 * of the monitor brain's heavier import graph; `monitor.ts` re-exports it.
 */
export type LaneFailureKind = 'inner-step' | 'task-verify' | 'code-review' | 'merge-gate';

/**
 * The lane/failure facts the controller already holds when a lane exhausts an
 * automatic budget, handed to `ControllerHost.triageLaneFailure`. Deliberately
 * NOT the monitor's full `LaneTriageRequest`: the controller knows nothing about
 * the task's ref/title/body, so the HOST enriches this with task data before it
 * consults the brain.
 */
export interface LaneTriageFailure {
  /** The fan-out item (in production the opaque sprint task id). */
  itemId: string;
  /**
   * The task's display ref when the controller happens to know it. It does not
   * on the sprint path (items are opaque ids), so the host resolves it; this
   * field exists for a driver whose item ids ARE refs.
   */
  taskRef?: string;
  /** The inner step that failed. */
  stepId: string;
  /** The lane's current 1-based attempt at the moment of exhaustion. */
  attempt: number;
  failureKind: LaneFailureKind;
  /** The error / verdict text, already excerpted by the controller. */
  errorExcerpt: string;
  /** The lane's configured inner chain, in execution order. */
  innerStepIds: readonly string[];
  /** The run's cancel signal, so a slow triage query dies with the run. */
  signal?: AbortSignal;
}

/**
 * What the host decided about a lane that exhausted its budget:
 *   - 'give_up' — settle the lane 'failed' exactly as before the seam existed
 *                 (the fail-safe default: kill switch, no monitor, caps spent,
 *                 a brain that judged the failure genuine, any internal error).
 *   - 'rescue'  — re-drive the lane from `targetStepId` with `guidance`, which
 *                 the controller threads into EVERY later inner-step spawn of
 *                 that lane. `adjusted` records whether the host also replaced
 *                 the task's body (the monitor's `adjust_and_retry`); a refused
 *                 edit is DOWNGRADED to a plain rescue with `adjusted: false`,
 *                 never to a give_up — the guidance still carries the substance.
 *   - 'systemic' — the triage consult ITSELF died on an environment-level
 *                 condition (a dead session limit, an expired login): the brain
 *                 could not judge anything, so a give_up here would fail a lane
 *                 the environment failed, not the lane. The controller parks the
 *                 whole fan-out on `error` instead, exactly as it does for a
 *                 systemic INNER-STEP failure. `error` is the systemic text.
 * `targetStepId` is guaranteed by the brain's parse ladder to be one of the
 * request's `innerStepIds` at or before the failing step, and `guidance` to be
 * non-blank; the controller still re-resolves the id against its own chain
 * (a target it cannot locate is treated as a give_up).
 */
export type LaneRescueOutcome =
  | { kind: 'give_up' }
  | { kind: 'systemic'; error: string }
  | { kind: 'rescue'; targetStepId: string; guidance: string; adjusted: boolean };

// ---------------------------------------------------------------------------
// Adversarial-review LOOP protocol (the supervisor steering each automatic lap)
// ---------------------------------------------------------------------------

/**
 * One EARLIER adversarial-review round of the same review step, as the
 * controller recorded it when that round completed.
 *
 * The supervisor needs the round-over-round trend to tell a CONVERGING review
 * (the blocking set shrinking) from CHURN (new ids replacing old ones), and it
 * cannot read that anywhere else: `step_results` collapses every lap of a step
 * into ONE row, so a run that looped three times looks exactly like one that
 * ran once. The controller therefore keeps the ledger in walk state and passes
 * it explicitly. Ids and titles only — the full text of a superseded round is
 * both large and no longer true.
 */
export interface ReviewLoopPriorRound {
  /** 1-based round number (the `reviewRounds` counter at the time). */
  round: number;
  /** The `AR-n` ids that round listed under `## Blocking`. */
  blockingIds: string[];
  /** Those entries' titles, positionally aligned with `blockingIds`. */
  blockingTitles: string[];
}

/**
 * Everything the supervisor needs to decide what ONE blocking adversarial-review
 * round should do next. Assembled by the controller (which knows the budget and
 * the walk's round ledger) and handed to `ControllerHost.adviseReviewLoop`; the
 * HOST enriches nothing here — unlike a lane triage, every fact is already in
 * the controller's hands.
 */
export interface ReviewLoopRequest {
  /** The adversarial-review step whose result just came back BLOCKING. */
  stepId: string;
  /** The intra-phase step id an automatic lap would jump back to. */
  loopbackStepId: string;
  /** The review round that just completed (`reviewRounds.get(stepId)`). */
  round: number;
  /** Automatic laps already taken for this step this walk. */
  lapsUsed: number;
  /** The cap on automatic laps (MAX_REVIEW_AUTO_REVISIONS). */
  maxLaps: number;
  /**
   * The review document the verdict was read from — the run's artifact when
   * there is one (preferred: it carries BOTH `## Blocking` and `## Findings`),
   * else the reviewer's WHOLE captured result text, verbatim. Absent when
   * neither could be read.
   */
  reviewMarkdown?: string;
  /** `reviewMarkdown` parsed — the id allow-list the steering is validated against. */
  parsed: ParsedAdversarialReview;
  /** Every EARLIER round of this step, oldest first (empty on round 1). */
  priorRounds: ReviewLoopPriorRound[];
}

/**
 * The supervisor's per-entry instruction for ONE automatic lap.
 *
 * `address` is the must-fix set the re-run is told to close; `setAside` names
 * entries judged not worth this lap (each filed as a finding IMMEDIATELY, so
 * setting one aside never drops it); `guidance` is free-text advice for the
 * whole lap. Rendered into the re-run's prompt as the authoritative instruction
 * — it OUTRANKS the review where the two disagree.
 */
export interface ReviewLoopSteering {
  address: string[];
  setAside: { id: string; reason: string }[];
  guidance?: string;
}

/**
 * What the supervisor decided about a blocking review round:
 *   - 'loop' — take another automatic lap, steered by `steering`.
 *   - 'stop' — do NOT lap; advance to the human gate now, with `rationale`
 *              (and any set-aside ids) carried into the gate as an escalation.
 * Absent (`undefined` from the host) means the supervisor had no verdict at all
 * — the controller then falls back to the pre-seam MECHANICAL budget.
 */
export type ReviewLoopDecision =
  | { verdict: 'loop'; rationale: string; steering: ReviewLoopSteering }
  | { verdict: 'stop'; rationale: string; setAside: { id: string; reason: string }[] };

/**
 * What the controller carries INTO the next human gate after a supervisor
 * intervention the human should know about. Present only on the ctx handed to
 * `requestHumanGate` immediately after a `stop`, and consumed by that one gate
 * (the controller clears it as soon as the call returns) — it describes THAT
 * gate's provenance, not a standing run property.
 */
export interface ControllerEscalation {
  /** Why the supervisor stopped looping instead of taking another lap. */
  loopStopRationale?: string;
  /** The `AR-n` ids it set aside (already filed as findings by the host). */
  setAsideIds?: string[];
}

/**
 * One adversarial-review entry the supervisor set aside, on its way to the
 * review queue as a non-blocking finding.
 *
 * The ENTRY travels rather than a pre-rendered body so the sink can compose the
 * finding exactly the way the approve-design gate composes its accepted-risk
 * findings (same title shape, same severity mapping, same category) — which is
 * what makes `gateSideEffects.filedAdversarialIds` dedupe a set-aside entry
 * instead of filing it twice when the human later approves the gate.
 */
export interface SetAsideFindingInput {
  entry: AdversarialFinding;
  /** The supervisor's one-line reason, rendered as the body's first line. */
  reason: string;
  /** The review round the entry was set aside on. */
  round: number;
}

/**
 * The outcome of awaiting an async visual merge-gate verdict for ONE lane
 * (programmatic actuation — closes the merge-gate's prose-only boundary). The
 * scheduler delivers the verdict asynchronously; the merge-gate driver
 * (verify/mergeGateLaneAdvance.ts) has ALREADY written the lane by the time this
 * resolves, so the controller only REACTS:
 *   - 'advance'  → the gate passed (or was advisory / skipped / not fired): let the
 *                  lane fall through to 'integrated'.
 *   - 'loopback' → the gate FAILED under the 3× cap: re-run from `implement` with
 *                  the bumped `attempt` (the merge-gate already set the lane back).
 *   - 'failed'   → the gate FAILED at the cap: the lane is terminal-failed.
 *   - 'aborted'  → the run was canceled while awaiting; short the lane's walk.
 */
export type VisualGateOutcome =
  | { kind: 'advance' }
  | {
      kind: 'loopback';
      attempt: number;
      /**
       * Human-readable report of what the visual verification FOUND (failed
       * behaviors + evidence + feedback), composed by the gate from the terminal
       * request row (verification-agent redesign §5.3/C). The controller threads
       * it into the re-driven implement step's `ControllerStepContext.loopbackFeedback`
       * so the re-implement agent sees the concrete failure, not just "a blocking
       * finding exists". Absent when the terminal row carried no report/verdict/error
       * to quote (defensive — the report column is written by a later slice).
       */
      feedback?: string;
    }
  | { kind: 'failed' }
  | { kind: 'aborted' };

/**
 * Outcome of enqueuing a composed visual-verification task on the scheduler for
 * one lane (verification-agent redesign §5.3/§5.4). 'enqueued' carries the
 * scheduler request id; 'skipped' means the run has verification disabled or the
 * scheduler was unavailable — the controller advances the lane WITHOUT parking
 * (fail-open). The concrete implementation lives in verify/enqueueFromTask.ts;
 * the controller only branches on the discriminant, staying DB/electron-free.
 */
export type TaskEnqueueResult =
  | { outcome: 'enqueued'; requestId: string }
  | { outcome: 'skipped'; reason: string };

/**
 * The RUN-LEVEL verification posture, resolved ONCE at fan-out start (never per
 * lane) so a project with nothing verifiable declares that fact one time
 * instead of discovering it N times, once per lane.
 *
 *   - 'disabled'    — the run's immutable stamp says `verify_enabled = 0`. The
 *                     user turned the visual verifier OFF. This is EXACTLY
 *                     today's behaviour, byte for byte: no finding, no prompt
 *                     change, the existing `visualGate.isActive` short-circuit
 *                     does all the work. It is deliberately NOT folded into
 *                     'unavailable' — a deliberate off switch is not a surprise,
 *                     and the enqueue seam was changed specifically to STOP
 *                     filing a finding for it (see VERIFY_DISABLED_ENQUEUE_REASON
 *                     in workflowController.ts).
 *   - 'available'   — a modality this host can actually verify. Unchanged
 *                     behaviour: lanes enqueue, park at the merge gate, and a
 *                     per-lane skip still files its own finding.
 *   - 'unavailable' — verification is ON but NO modality can serve this run
 *                     (the stamped type is the deferred mobile one, or a
 *                     native-desktop run with no proven native-screen runbook).
 *                     The controller files ONE finding for the whole run, skips
 *                     the enqueue for every lane, and SUPPRESSES the per-lane
 *                     skip findings that would otherwise repeat the same
 *                     conclusion once per lane.
 *
 * Canonical HERE rather than in verify/verificationPosture.ts (which re-exports
 * it) for the same reason `LaneFailureKind` is canonical here: this module is
 * the controller/host protocol and carries the standalone-typecheck invariant
 * (shared types only), so it cannot import from a module that reaches the
 * runbook store. The resolver imports the type from here instead.
 */
export type VerificationPosture =
  | { kind: 'disabled' }
  | { kind: 'available' }
  | { kind: 'unavailable'; reason: string };

/**
 * One group of BUILD-BREAK findings that at least two lanes of a run filed with
 * the same normalized error text — the signal that the tree, not any single
 * task, is broken.
 *
 * `count` is the number of DISTINCT review items in the group, NOT the number of
 * distinct lanes: `cyboflow_report_finding` stamps `source` as `agent:<step
 * label>` (every lane's `implement` turn files as `agent:implement`), and the
 * build-break contract does not ask the agent for an entity link, so the row
 * carries no lane identity to group by. `laneRefs` is best-effort — the
 * `entity_id`s of any findings that DID carry an `entity_type: 'task'` link, and
 * frequently empty. Two findings from ONE lane's two attempts would therefore
 * count as two; the normalizer's job is to make that rare (a re-filed identical
 * break is what the contract tells the agent not to do) and the consequence is
 * one extra advisory card, never a paused run.
 */
export interface BuildBreakGroup {
  /** The normalized (path/line/hex-stripped, lowercased) error text. */
  normalized: string;
  /** Distinct `review_items.id`s in the group (see the count caveat above). */
  itemIds: string[];
  /** How many distinct review items the group holds — `itemIds.length`. */
  count: number;
  /** Best-effort lane refs recovered from `entity_type = 'task'` links. */
  laneRefs: string[];
  /** The first-seen ORIGINAL title, kept verbatim for the finding body. */
  sampleTitle: string;
}

/**
 * Awaits the async visual merge-gate verdict for one lane so the PROGRAMMATIC
 * controller can actuate the loopback (re-dispatch implement) instead of leaving a
 * FAILed lane parked. Injected on `ControllerHost.visualGate` (absent ⇒ the
 * controller never parks — byte-identical to today). The production impl
 * (programmatic/visualVerifyGate.ts) subscribes to the scheduler's
 * `verificationEvents` and reads the merge-gate's lane write; test hosts fake it.
 */
export interface VisualVerifyGate {
  /**
   * SYNC guard: is the visual merge-gate ACTIVE for this run (verification
   * enabled)? When false the controller skips parking + awaiting entirely, so a
   * verify-disabled run is byte-identical to the pre-actuation behavior.
   */
  isActive(runId: string): boolean;
  /**
   * Park + await the async verdict for `itemId`'s lane, resolving the outcome the
   * controller acts on. MUST be fail-soft (resolve, never reject) and honor
   * `signal` (a canceled run resolves 'aborted', never hangs).
   */
  awaitVerdict(req: { runId: string; itemId: string; signal?: AbortSignal }): Promise<VisualGateOutcome>;
  /**
   * OPTIONAL adoption probe (live-smoke fix 2026-07-22): is there a LIVE
   * (non-terminal: queued/leased/running) verification request already
   * attributed to this lane? A misbehaving task-verify turn can FIRE the
   * request itself instead of printing the fence (belt-and-suspenders behind
   * the spawn-level tool denial — e.g. a Codex step turn that ignores
   * disallowedTools). When true at contract-failure time, the controller ADOPTS
   * that request — parking on it instead of re-running task-verify into the
   * same defect — and the gate's awaitVerdict race-closer resolves it exactly
   * like a controller-enqueued one. LIVE-only on purpose: a TERMINAL request
   * found here is stale (a prior attempt's) and must not preempt the retry.
   * Fail-soft → false. Absent (test fakes) ⇒ the controller never adopts.
   */
  hasLiveRequestForLane?(runId: string, itemId: string): boolean;
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
   * 'running' as it begins each step and then a TERMINAL status as it settles:
   *   - 'done'    — the step completed (or a gate approved / a loopback / triage
   *                 retry re-drives it — those re-report 'done' before re-running).
   *   - 'failed'  — a REQUIRED step exhausted its retry + loopback + triage budget
   *                 (handleRequiredFailure's terminal arm).
   *   - 'skipped' — an OPTIONAL step failed, a sprint's closing stage was gated off
   *                 (incomplete lanes), or the human ACCEPTED a required failure at
   *                 the triage-escalation gate.
   * The 'rejected' (gate reject / revise-budget-exhausted) and 'canceled' (run
   * abort / fan-out cancel / gate abort) OUTCOMES deliberately still report 'done',
   * NOT a timeline marker: a rejected gate RESTS awaiting the human's decision, so a
   * red "FAILED" marker there would mislead; and cancellation is a run-level affair
   * the run's own status already conveys. The rich outcome is persisted to
   * step_results regardless (migration 033) — this is purely the timeline's view.
   * Must be fail-soft (never throw).
   */
  reportStep(stepId: string, status: WorkflowStepReportStatus): void;

  /**
   * Resolve a human-gate step. The production host integrates with the review /
   * questions surface and blocks until the human responds; test hosts return a
   * canned decision. A 'revise' decision re-runs the gate's intra-phase loopback
   * target (or, absent a target, re-presents the gate).
   */
  requestHumanGate(step: WorkflowStep, ctx: ControllerStepContext): Promise<HumanGateDecision>;

  /**
   * Optional precondition seam for an OPTIONAL pure human-gate step. Consulted
   * ONLY when the step is both `human: true` (pure gate) and `optional: true`,
   * BEFORE the gate opens: return a one-line skip REASON when the gate's
   * reviewable precondition is absent (e.g. launch's approve-design when both
   * design steps self-skipped and there is no prototype or architecture to
   * review), or null to open the gate normally. Absent ⇒ every gate opens
   * (today's behavior). A thrown consult is treated as null (fail-open toward
   * the gate — never silently skip a human review on an error).
   */
  shouldSkipHumanGate?(step: WorkflowStep, runId: string): string | null;

  /**
   * Optional read-back of the free text a human typed when resolving a gate.
   *
   * `requestHumanGate` returns only the four-way verdict — the resolver reduces
   * the resolution string to approve/reject/revise/abort and the note is dropped
   * on the floor. On a 'revise' that is the whole signal: "Revise" alone tells a
   * re-run nothing, while "the spend screen has no way back to Home" tells it
   * everything. The host holds the review-item id, so it is the only party that
   * can recover the text; the controller threads what comes back into the
   * re-driven steps' `gateRevision`.
   *
   * Returns undefined when there is no note, when the resolution is a bare
   * verdict word, or when the host cannot read it — the section is then simply
   * omitted rather than rendering an empty quote. Absent ⇒ a revision carries the
   * gate id alone (still better than nothing: the re-run learns WHICH gate sent
   * it back).
   */
  readGateResolutionNote?(stepId: string): string | undefined;

  /**
   * Optional read-back of the run's CURRENT adversarial-review artifact markdown.
   *
   * The artifact is the DURABLE half of a review: the step agent reports it
   * before its turn ends, so it survives even when the turn's final text does
   * not. The reviewer's captured chat text does not always arrive (a substrate
   * that drops the final message, a turn that ends on a tool result — a real
   * failure mode seen in live runs), and an empty text used to read as "no
   * verdict" and advance a design phase the reviewer had just blocked. The
   * controller therefore falls back to this reader when the text carries no
   * verdict of its own.
   *
   * Fail-soft: returns undefined when there is no artifact or the host cannot
   * read it. Absent ⇒ the controller reads only the reviewer's final text
   * (today's behaviour).
   */
  readAdversarialReview?(): string | undefined;

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
   * Optional LANE-triage seam — `triageFailure`'s per-lane sibling. Consulted
   * when ONE fan-out lane has exhausted an automatic budget, BEFORE the
   * controller settles that lane 'failed'. The production host asks the
   * ON-DEMAND monitor whether the lane is worth re-driving (optionally with an
   * adjusted task body) and returns only the executable verdict; the controller
   * stays dumb, branching on `give_up` vs `rescue`.
   *
   * The controller consults it ONLY at genuine budget exhaustion — never for a
   * systemic failure (that has its own park path), an aborted result, a
   * dependency-blocked / cycle lane, a task-verify output-CONTRACT exhaustion
   * (a malformed result is not a defect a rescue can reason about), or once the
   * per-lane / per-run rescue caps are spent.
   *
   * MUST be fail-soft (resolve `{ kind: 'give_up' }`, never reject) and MUST
   * honor `req.signal`. Absent (tests / any host built without a monitor) ⇒ the
   * controller settles the lane failed exactly as before the seam existed.
   */
  triageLaneFailure?(req: LaneTriageFailure): Promise<LaneRescueOutcome>;

  /**
   * Optional REVIEW-LOOP seam — `triageLaneFailure`'s design-phase sibling.
   * Consulted on EVERY blocking adversarial-review round for which automatic
   * laps remain, BEFORE the controller decides whether to take one.
   *
   * The production host asks the ON-DEMAND monitor whether another lap is worth
   * it and, if so, which entries the lap must close (`steering.address`) and
   * which it must leave alone (`steering.setAside`, filed as findings by the
   * host there and then). The controller stays dumb: it branches on
   * loop / stop / undefined and never learns what a monitor or a finding is.
   *
   * `undefined` is the FAIL-SOFT value and means "no supervisor verdict" — a
   * kill switch, a missing monitor, a thrown consult, an aborted run. The
   * controller then falls back to MAX_REVIEW_MECHANICAL_REVISIONS, i.e. exactly
   * the behaviour of a run without this seam. MUST never reject and MUST honour
   * `ctx.signal`.
   */
  adviseReviewLoop?(
    req: ReviewLoopRequest,
    ctx: ControllerStepContext,
  ): Promise<ReviewLoopDecision | undefined>;

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

  /**
   * Optional blocking-review-items checkpoint. The controller calls this at each
   * step boundary (BEFORE it begins the next step) so a run PARKS when the agent
   * recorded a PENDING BLOCKING review_item (e.g. a blocking finding) during the
   * previous step. The production host parks the run awaiting_review and awaits the
   * item(s) clearing, then resumes and returns 'proceed'; 'canceled' when the run
   * was canceled while parked. Absent (tests / non-programmatic) ⇒ the controller
   * never parks for review items (today's behavior). Fail-soft is the host's
   * responsibility; the controller only branches on the returned verdict.
   */
  awaitBlockingReviewItems?(runId: string, signal?: AbortSignal): Promise<'proceed' | 'canceled'>;

  /**
   * Optional SYSTEMIC-pause seam. Consulted when a step attempt fails with
   * `StepRunResult.systemic === true` (usage/session/rate limit, provider
   * overload, auth) — BEFORE the failure consumes the step's retry budget or
   * triggers optional-skip / loopback / triage. The production host opens a
   * BLOCKING 'decision' review item ("resolve to retry now, dismiss to give up"),
   * parks the run awaiting_review, and settles on human resolution OR an
   * auto-resume timer at the parsed limit-reset time. Bounded by
   * MAX_SYSTEMIC_PAUSES per step id. Absent (tests / hosts built without the
   * gate) ⇒ systemic failures follow the normal failure path (today's behavior).
   * Fail-soft is the host's responsibility; the controller only branches on the
   * returned verdict.
   */
  awaitSystemicPause?(
    step: WorkflowStep,
    ctx: ControllerStepContext,
    error: string | undefined,
  ): Promise<SystemicPauseVerdict>;

  /**
   * Optional visual merge-gate (programmatic actuation). Present ONLY on the
   * programmatic host for a sprint-style run. When present AND active for the run,
   * the controller PARKS each lane at `awaiting-verify` after its `visual-verify`
   * inner step, AWAITS the async verdict, then advances / loops back to
   * `implement` / fails the lane. Absent ⇒ the controller never parks (the lane
   * integrates straight after visual-verify — today's behavior).
   */
  visualGate?: VisualVerifyGate;

  /**
   * Optional agentless visual-verify enqueue capability (verification-agent
   * redesign §5.3/§5.4). Present ONLY on the programmatic host for a sprint-style
   * run wired with a DB. The controller calls it from the (now agentless)
   * visual-verify inner step with the task task-verify composed + the lane's
   * authoritative ref/attempt; the host enqueues it on the central scheduler
   * (snapshot capture, chain resolution, dual-write) and returns whether a request
   * was created. 'enqueued' ⇒ the controller parks the lane at awaiting-verify and
   * awaits the merge-gate verdict; 'skipped' (verification disabled / scheduler
   * unavailable) ⇒ the controller advances WITHOUT parking (fail-open). Absent ⇒
   * the controller never enqueues (the visual-verify step is a clean skip). Keeps
   * the controller DB/electron-free — the real impl (verify/enqueueFromTask.ts) is
   * injected by the host.
   */
  enqueueVisualVerification?(args: {
    runId: string;
    task: VerificationTaskV1;
    laneTaskRef: string;
    attempt: number;
  }): Promise<TaskEnqueueResult>;

  /**
   * Optional NON-BLOCKING report that a lane's visual verification never even
   * reached the queue (F8 "never skip silently",
   * docs/proposals/visual-verification-brittleness-fixes.md).
   *
   * The gate-side skips already produce a `skipped` request row AND a finding via
   * verdictDelivery. The two seams below produce NEITHER — nothing is persisted,
   * so the verify queue and the DB show that nothing happened, which is
   * indistinguishable from "this lane needed no visual check":
   *   1. task-verify produced no result text (the substrate discarded it) ⇒ no
   *      verification task could be composed at all;
   *   2. the enqueue seam declined with a reason OTHER than the deliberate
   *      'verification-disabled' off switch.
   * Both raise ONE non-blocking finding naming the reason verbatim.
   *
   * Fire-and-forget by design (returns void): the controller must never await or
   * be able to throw on the reporting of a skip. Absent (tests / hosts built
   * without a review-queue sink) ⇒ the skip is logged only, exactly as before.
   */
  reportVerificationSkipped?(input: { runId: string; laneTaskRef: string; reason: string; detail?: string }): void;

  /**
   * Optional RUN-LEVEL verification posture resolver, consulted ONCE at fan-out
   * start (before the first lane is dispatched) and cached run-scoped by the
   * controller.
   *
   * EAGER on purpose. The posture used to be discovered lazily, by the first
   * lane whose enqueue declined — but that lane had already run `implement` and
   * `task-verify`, and under a rolling dispatch pool the set of lanes whose
   * prompts are already composed is permanently cap-sized, so a lazily-flipped
   * latch reaches almost nobody. Resolving before dispatch is what makes the
   * declaration cover the whole batch.
   *
   * Absent (tests, orchestrated hosts) ⇒ the controller behaves as 'available',
   * i.e. exactly as it did before this seam existed. MUST be fail-soft (resolve,
   * never reject); a throw is caught and read as 'available' for the same reason.
   */
  resolveVerificationPosture?(runId: string): Promise<VerificationPosture>;

  /**
   * Optional NON-BLOCKING declaration that this run has NO verifiable modality
   * at all — the run-scoped sibling of {@link reportVerificationSkipped}.
   *
   * Filed at most ONCE per run (the controller holds the run-scoped set, and the
   * production sink also dedupes on `source` through
   * `ReviewItemRouter.createIfNoPending`, so a resumed walk cannot double-file).
   * Fire-and-forget by design: the whole point is VISIBILITY, so it must be
   * strictly weaker than the walk it observes.
   */
  reportNoVerifiableModality?(input: { runId: string; reason: string }): void;

  /**
   * Optional BUILD-BREAK sweep: read this run's pending `build-break` findings
   * and return the groups whose normalized error text at least two of them
   * share. Called at the dispatch pool's QUIESCED instant (nothing in flight) and
   * once more at fan-out end — never per lane settle, because
   * `cyboflow_report_finding` replies `ok:true` WITHOUT awaiting the
   * ReviewItemRouter queue, so a lane can settle before its own finding commits.
   *
   * Read-only and fail-soft (resolve, never reject). Absent ⇒ no sweep.
   */
  sweepBuildBreaks?(runId: string): Promise<BuildBreakGroup[]>;

  /**
   * Optional NON-BLOCKING report that N lanes hit the SAME build break. Detector
   * only: this files one advisory card naming the group; it never pauses the run
   * and never deploys a fix agent. Fire-and-forget, like the two seams above.
   */
  reportBuildBreakGroup?(input: { runId: string; group: BuildBreakGroup }): void;

  /**
   * Optional wall clock, for the one place the controller needs one: the
   * fan-out pool's corroboration window (SAME_ERROR_COHORT_MAX_MS), which bounds
   * how long a lane's 'failed' write is held waiting for a sibling to corroborate
   * it. Absent ⇒ `Date.now()`. Exists so a test can advance the ceiling without
   * faking timers around real agent promises.
   */
  now?(): number;

  /** Optional structured log sink; absent ⇒ the controller stays silent. */
  log?(level: 'info' | 'warn' | 'error', message: string): void;
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
  /**
   * This outcome was CHOSEN, not suffered — an operator skip, or a designed
   * control-flow skip such as the closing-stage gate. Such skips still carry an
   * `error` string because it is the human-readable reason shown in step
   * results, but they are not defects and must not be reported as failures.
   * Telemetry-only: never persisted (see StepResultStore.record).
   */
  deliberate?: boolean;
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
