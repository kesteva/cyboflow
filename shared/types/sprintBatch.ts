/**
 * Shared types for the parallel-sprint lane subsystem (feat/parallel-sprint).
 *
 * A "sprint batch" is the lane substrate for ONE session-hosted `sprint` run
 * seeded with N tasks: the sprint ORCHESTRATOR AGENT fans out per-task
 * subagents with bounded concurrency in the shared session worktree, and each
 * task's progress is a "lane" — a `sprint_batch_tasks` row (migration 022)
 * written through the `SprintLaneStore` chokepoint (driven by the
 * `cyboflow_update_sprint_task` MCP tool). These row types + status unions are
 * consumed by both the main process (SprintLaneStore, migration 022) and the
 * renderer (batch picker / lane progress UI). Keep this file free of Node.js
 * built-ins so it can be imported anywhere.
 */
import type { CliSubstrate } from './substrate';
import type { RequestStatus, VerificationFailureClass } from './visualVerification';

/** Lifecycle state of a whole batch. Terminal: completed | failed | canceled. */
export type SprintBatchStatus =
  | 'planning'
  | 'running'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'canceled';

/**
 * Lifecycle of a single task's lane within a batch, independent of the global
 * board stage:
 *  - queued      — selected, not yet picked up by a subagent.
 *  - running     — a per-task subagent is in flight.
 *  - integrated  — the task is COMPLETE AND COMMITTED in the shared session
 *                  worktree. (Historically: merged into a per-batch
 *                  integration branch; there is no per-task branch/merge in
 *                  the single-run model.) This is the "satisfied" state for
 *                  dependency gating (NOT global board stage 9).
 *  - failed      — the per-task subagent failed. Surfaced; does not crash the
 *                  sprint.
 *  - blocked     — a task whose prereq failed; the orchestrator skips it.
 */
export type SprintBatchTaskStatus =
  | 'queued'
  | 'running'
  | 'integrated'
  | 'failed'
  | 'blocked';

/**
 * Terminal batch statuses — batches in these states cannot transition further.
 * Mirrors TERMINAL_RUN_STATUSES in shared/types/cyboflow.ts. The boot
 * rehydrator selects NON-terminal batches to resume.
 */
export const TERMINAL_BATCH_STATUSES = ['completed', 'failed', 'canceled'] as const;
export type TerminalBatchStatus = (typeof TERMINAL_BATCH_STATUSES)[number];

/**
 * Fixed parallel-agent concurrency. At most this many per-task subagents
 * execute simultaneously, regardless of batch size or substrate.
 */
export const SPRINT_BATCH_CAP = 5;

/**
 * BUILT-IN selection cap N (the number of tasks a user may multi-select into
 * one batch), keyed by substrate. Protects context/host resources — NOT the
 * concurrency limit (that is SPRINT_BATCH_CAP).
 *
 * These are the DEFAULTS, not the effective cap: Settings → Sessions writes a
 * per-substrate override (`AppConfig.sprintMaxTasks`). Never read this map
 * directly at an enforcement point — go through `resolveSprintMaxTasks`, which
 * layers the user's override on top, so the picker, the two launch seams and
 * the MCP backstop can never disagree about the live cap.
 */
export const SPRINT_BATCH_MAX_TASKS_DEFAULTS: Readonly<Record<CliSubstrate, number>> = {
  sdk: 15,
  interactive: 10,
} as const;

/**
 * Bounds every configured cap is clamped to. `config.json` is user-editable and
 * the value is also typed by hand into a Settings input, so a 0 (which would
 * make EVERY sprint launch impossible) and an absurd 10_000 (which would hand a
 * single orchestrator an unrunnable batch) are both floored/ceilinged rather
 * than trusted. The clamp is applied on READ, so a hand-edited config never
 * needs a migration.
 */
export const SPRINT_MAX_TASKS_MIN = 1;
export const SPRINT_MAX_TASKS_MAX = 100;

/**
 * The user's per-substrate cap override (`AppConfig.sprintMaxTasks`). SPARSE by
 * design: an absent member means "use the built-in default for that substrate",
 * which is what keeps an install that never touches the setting byte-identical.
 */
export type SprintMaxTasksOverrides = Partial<Record<CliSubstrate, number>>;

/**
 * Coerce one configured cap to a usable integer, or `null` when the stored value
 * is not a finite number (a hand-edited `"twenty"` / `null` / NaN). Callers treat
 * `null` as "no override" and fall back to the built-in default.
 */
export function clampSprintMaxTasks(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const int = Math.trunc(value);
  if (int < SPRINT_MAX_TASKS_MIN) return SPRINT_MAX_TASKS_MIN;
  if (int > SPRINT_MAX_TASKS_MAX) return SPRINT_MAX_TASKS_MAX;
  return int;
}

/**
 * THE effective sprint selection cap for a substrate: the user's clamped
 * override when one is set, otherwise the built-in default. The single source
 * of truth shared by the batch picker (client-side disable), `runs.start` and
 * `experiments.start` (server-side 400s), and the `cyboflow_create_sprint_batch`
 * backstop — so raising the setting lifts all four at once.
 */
export function resolveSprintMaxTasks(
  overrides: SprintMaxTasksOverrides | undefined,
  substrate: CliSubstrate,
): number {
  return clampSprintMaxTasks(overrides?.[substrate]) ?? SPRINT_BATCH_MAX_TASKS_DEFAULTS[substrate];
}

/** Row shape of the `sprint_batches` table (migration 022). */
export interface SprintBatchRow {
  id: string;
  project_id: number;
  substrate: CliSubstrate;
  status: SprintBatchStatus;
  /** Legacy scheduler-model column — always NULL in the single-run lane model (the sprint executes in the session worktree; merge to main is the normal session Merge close-out). */
  integration_branch: string | null;
  /** Project main branch captured at create (triage). */
  base_branch: string | null;
  /** Integration branch start sha (triage). */
  base_sha: string | null;
  /** Bounded concurrency for this batch (defaults to SPRINT_BATCH_CAP). */
  concurrency: number;
  /** Legacy scheduler-model column (sprint-init run soft link) — always NULL in the single-run lane model. */
  init_run_id: string | null;
  /** Legacy scheduler-model column (sprint-finalize run soft link) — always NULL in the single-run lane model. */
  finalize_run_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/** Row shape of the `sprint_batch_tasks` table (migrations 022 + 023 + 025). */
export interface SprintBatchTaskRow {
  id: number;
  batch_id: string;
  task_id: string;
  status: SprintBatchTaskStatus;
  /** Legacy scheduler-model column (per-task run soft link) — always NULL in the single-run lane model. */
  run_id: string | null;
  /** Subagent-fail detail when status='failed'. */
  error_message: string | null;
  integrated_at: string | null;
  /** The lane step the per-task subagent is currently on (migration 023) — a SprintLaneStepId, or NULL before the first cyboflow_update_sprint_task report. */
  current_step_id: string | null;
  /**
   * Implement→verify retry counter (migration 025). 0 = first pass (render
   * nothing); the orchestrator reports attempt N (2, 3, ...) when it
   * RE-delegates implement after a task-verify FAIL or blocking review defect.
   */
  attempts: number;
  created_at: string;
  updated_at: string;
}

// ─── Lane step vocabulary + lane read-model ──────────────────────────────────

/**
 * The fixed per-task lane step vocabulary the sprint orchestrator's subagents
 * report through `cyboflow_update_sprint_task` (`current_step` enum). These
 * are LANE steps inside the single 'execute-tasks' workflow step — NOT
 * workflow step ids — and mirror the historical per-task sprint pipeline.
 *
 * `awaiting-verify` (locked decision #2 — the visual merge-gate) is the PARK
 * step a lane sits on AFTER it has fired a `cyboflow_request_verification` and
 * BEFORE the asynchronous verdict lands. It is ordered AFTER `visual-verify`
 * (the dispatch step) so the monotonic-forward guard in
 * deriveLaneFromTaskDispatch never regresses a parked lane, and the merge-gate
 * driver (verify/mergeGateLaneAdvance.ts) reads the verdict and drives the lane
 * off it: PASS → `integrated`; FAIL (under the 3× cap) → back to `implement`
 * with a bumped attempt; FAIL (cap reached) → `failed`. The vocabulary stays a
 * SUPERSET of the historical pipeline, so a verify-disabled run that never
 * parks here is byte-identical to the pre-merge-gate behavior.
 */
export const SPRINT_LANE_STEP_IDS = [
  'implement',
  'write-tests',
  'code-review',
  'task-verify',
  'visual-verify',
  'awaiting-verify',
] as const;
export type SprintLaneStepId = (typeof SPRINT_LANE_STEP_IDS)[number];

/**
 * The lane park step for the visual merge-gate (locked decision #2). A lane that
 * fired a verification request sits here until the verdict drives it off via the
 * merge-gate driver. Exported as a named const (not a bare string literal) so the
 * driver, the prompts, and the tests share ONE source of truth.
 */
export const AWAITING_VERIFY_STEP: SprintLaneStepId = 'awaiting-verify';

/**
 * The lane step the visual merge-gate loops BACK to on a FAIL (under the 3× cap) —
 * the re-implement target. Named const (not a bare literal) so the merge-gate
 * driver, the programmatic controller's loopback, and the tests share one source.
 */
export const SPRINT_IMPLEMENT_STEP: SprintLaneStepId = 'implement';

/**
 * The lane step whose typed output carries a code-review verdict. On the
 * programmatic plane the controller parses a `REVIEW: BLOCKING | CLEAN` line off
 * this step's captured result text (mirroring task-verify's `VERDICT:` channel):
 * `BLOCKING` routes the lane back to its declared loopback target (`implement`)
 * with a bumped attempt, up to the 3× cap; `CLEAN` (or no line) advances. Named
 * const (not a bare literal) so the controller, the parser, and the tests share
 * one source of truth.
 */
export const SPRINT_CODE_REVIEW_STEP: SprintLaneStepId = 'code-review';

/**
 * The lane step that FIRES the fire-and-continue verification request. After it
 * runs, the lane parks at AWAITING_VERIFY_STEP until the async verdict lands. The
 * programmatic controller keys its merge-gate park/await on this inner-step id.
 */
export const SPRINT_VISUAL_VERIFY_STEP: SprintLaneStepId = 'visual-verify';

/**
 * The lane step whose typed output composes the visual-verification task
 * (verification-agent redesign §5.3). On `VERDICT: PASS` its result carries a
 * `## Visual verification task` fence (or an explicit NOT-APPLICABLE line); the
 * programmatic controller parses that off the step's captured result text to
 * decide whether to enqueue the agentless visual-verify step. Named const (not a
 * bare literal) so the controller, the parser, and the tests share one source.
 */
export const SPRINT_TASK_VERIFY_STEP: SprintLaneStepId = 'task-verify';

/**
 * Read-model for a single task lane (SprintLaneStore.listLanes /
 * cyboflow.runs.listLanes). `ref`/`title` are resolved fail-soft from the
 * `tasks` table (NULL when the task row is missing).
 */
export interface SprintLaneRow {
  batchId: string;
  taskId: string;
  status: SprintBatchTaskStatus;
  currentStepId: string | null;
  ref: string | null;
  title: string | null;
  /**
   * Implement→verify retry counter (migration 025). 0 = first pass (the UI
   * renders nothing); the orchestrator reports attempt N (2, 3, ...) when it
   * RE-delegates implement after a task-verify FAIL or blocking review defect.
   * UI: a running lane with attempts >= 2 shows the dashed loop edge
   * ("ATTEMPT n/3"); integrated with >= 2 shows "n attempts"; failed shows
   * "3/3 failed".
   */
  attempts: number;
  /**
   * Display refs (task ref, falling back to the raw task id) of this lane's
   * IN-BATCH blocking prerequisites (task_dependencies kind='blocking') whose
   * own lane in the SAME batch is not yet 'integrated'; [] when none.
   * Computed on read in listLanes — NOT stored.
   */
  blockedByRefs: string[];
  /**
   * The lane's REAL visual-verification outcome, or null when no request row is
   * attributable to it (F8 / Codex #9, docs/proposals/visual-verification-
   * brittleness-fixes.md). Derived on read from the most recent non-proof
   * `verification_requests` row keyed to this lane — NOT stored, no new column.
   *
   * Why it exists: `mergeGateLaneAdvance` integrates a lane on `passed`,
   * `low_confidence`, `skipped` AND `timeout`, and the swimlane paints every
   * step of an integrated lane green — so three of those four outcomes rendered
   * as "Visual check ✓" when no visual check had actually run. The canvas reads
   * this field to paint the visual-verify step from the outcome instead of from
   * lane status alone.
   */
  visualVerification: SprintLaneVisualVerification | null;
  updatedAt: string;
}

/**
 * The lane-attributable slice of a `verification_requests` row (F8). Carries the
 * lifecycle `status` (the verdict category), the §3.1 failure classification and
 * the concrete `errorMessage` so the UI can say WHY a check did not run rather
 * than only that it did not.
 */
export interface SprintLaneVisualVerification {
  status: RequestStatus;
  failureClass: VerificationFailureClass | null;
  errorMessage: string | null;
  /**
   * The LANE attempt this request was fired on, parsed from the request's
   * `enqueue_key` (`${runId}:${taskRef}:${attempt}`) — the same parse
   * `verdictDelivery.parseAttemptFromEnqueueKey` and the merge-gate's
   * replay-safety check use. `null` when the key is absent or malformed (an
   * MCP-fired request carries no enqueue_key at all).
   *
   * NOT `verification_requests.attempt`: that column is the chain's fall-forward
   * counter and every INSERT hard-codes it to 0 (verificationScheduler's enqueue),
   * so it can neither identify nor age a lane's fire. Naming the two "attempt" in
   * one object graph was the bug — this is the lane counter, comparable with
   * `SprintLaneRow.attempts`.
   */
  laneAttempt: number | null;
  /**
   * True when this verdict belongs to an EARLIER lane attempt than the lane is on
   * now (`laneAttempt !== null && SprintLaneRow.attempts > laneAttempt`) — the
   * exact supersession rule `mergeGateLaneAdvance` applies before writing a
   * verdict. It happens when a later attempt's verification was dropped BEFORE a
   * request row existed (the codex-substrate channel-unavailable drop F8 exists
   * for), leaving the older row as the newest attributable one. A stale row must
   * never be rendered as this attempt's outcome.
   */
  stale: boolean;
}

/**
 * Event payload emitted by sprintLaneEvents on the per-run
 * `sprint-lane-<runId>` channel after every lane write. Consumed by the tRPC
 * lane subscription and the run progress rail.
 */
export interface SprintLaneChangedEvent {
  runId: string;
  batchId: string;
  taskId: string;
  status: SprintBatchTaskStatus;
  currentStepId: string | null;
  /** The lane's current attempts counter (see SprintLaneRow.attempts). */
  attempts: number;
  /**
   * The lane's visual-verification outcome AS OF this write, carried on the event
   * so a live-watched swimlane does not have to wait for a fresh snapshot query to
   * learn a verdict landed (the round-1 F8 bug: the renderer fetches the snapshot
   * once at mount, so a lane that later PASSED kept rendering "did not run" for
   * the life of the mount).
   *
   * It is a READ-SIDE DERIVATION, not a stored column — the store fills it from
   * the same `readLane` projection it already reads back before emitting, and the
   * merge gate writes the lane through that chokepoint only AFTER the scheduler
   * has committed the terminal row, so the integrating event carries the real
   * verdict. `null` = no request row attributable to the lane (also the value on a
   * lane REMOVAL event, whose lane no longer exists).
   */
  visualVerification: SprintLaneVisualVerification | null;
  timestamp: string;
}
