/**
 * ProgrammaticRunHost — the `ControllerHost` implementation for a programmatic
 * run. It adapts the controller's side-effect needs onto cyboflow surfaces via
 * narrow injected collaborators (all fakeable in tests):
 *
 *   - reportStep      → `StepReporter.report(runId, stepId, status)`, which in
 *                       production drives `current_step_id` + the live timeline
 *                       through the same `buildStepTransitionEvent` path the
 *                       agent's `cyboflow_report_step` tool uses. Fail-soft.
 *   - requestHumanGate→ `HumanGateResolver.resolve(...)` (see humanGate.ts).
 *   - triageFailure   → the ON-DEMAND `MonitorSession` (the monitor-unify refactor;
 *                       supersedes the Stage 3 supervisor + supervisor-chat planes).
 *                       When a monitor is wired the host asks it to triage a
 *                       required step that exhausted its budget and INJECTS the
 *                       monitor's rationale into the run's unified Chat pane as an
 *                       assistant turn (via `injectEvent`). The supervisor may
 *                       auto-'retry', but a 'fail' verdict is downgraded to
 *                       'escalate' — ending a run is the human's call, and every
 *                       escalation surfaces in BOTH the chat and the review queue
 *                       (the supervisor-role redesign, 2026-07-05). When NO monitor
 *                       is wired the host returns 'escalate' with a plain chat note.
 *
 * There is NO continuous monitor feed: routine step progress stays in the stepper
 * (the reporter path), and the chat carries CONVERSATION + NOTABLE events only.
 *
 * Bound to one run (runId + projectId) when constructed by
 * DefaultProgrammaticRunner.
 */
import type { WorkflowStep, WorkflowStepReportStatus } from '../../../../shared/types/workflows';
import type { ClaudeStreamEvent } from '../../../../shared/types/claudeStream';
import type { LoggerLike } from '../types';
import type { AdversarialFinding } from '../../../../shared/types/adversarialReview';
import type {
  BlockingItemDecision,
  BlockingItemsEscalationRequest,
  BuildBreakGroup,
  ControllerHost,
  ControllerStepContext,
  FanOutDriver,
  HumanGateDecision,
  LaneRescueOutcome,
  EscalationReviewItemSummary,
  GateEscalationDecision,
  LaneTriageFailure,
  ReviewLoopDecision,
  ReviewLoopRequest,
  SetAsideFindingInput,
  StepReport,
  SystemicPauseVerdict,
  TriageDecision,
  VerificationPosture,
  VisualVerifyGate,
} from './types';
import type { HumanGateOpenedSnapshot, HumanGateResolver } from './humanGate';
import type { BlockingItemsResolver, PendingBlockingItem } from './blockingItemsGate';
import type { SystemicPauseResolver } from './systemicPauseGate';
import type { MonitorSession } from './monitor';
import {
  SUPERVISOR_RECOMMENDATION_HEADING,
  composeSupervisorRecommendation,
  readMarkdownSection,
} from '../../../../shared/types/reviews';
import type { ReviewItemKind, SupervisorRecommendationChoice } from '../../../../shared/types/reviews';
import { buildAssistantTextEvent } from './syntheticEvents';
import { isSystemicStepError } from './systemicError';
import { buildBreakGroupKey } from './buildBreakDetector';

/**
 * Rollback lever for autonomous LANE RESCUE (precedent: CYBOFLOW_DISABLE_WARM_SDK).
 * With it set to '1' the host never consults the monitor about a failing lane and
 * every lane settles 'failed' exactly as it did before the seam existed — no
 * query cost, no task edits, no findings.
 */
export const LANE_TRIAGE_KILL_SWITCH_ENV = 'CYBOFLOW_DISABLE_LANE_TRIAGE';

/** True when the operator has disabled autonomous lane rescue for this process. */
function laneTriageDisabled(): boolean {
  return process.env[LANE_TRIAGE_KILL_SWITCH_ENV] === '1';
}

/**
 * Rollback lever for the SUPERVISED adversarial-review loop (sibling of
 * LANE_TRIAGE_KILL_SWITCH_ENV). With it set to '1' the host never consults the
 * monitor about a blocking review round, so the controller falls back to its
 * MECHANICAL revision budget — i.e. exactly the one-lap behaviour that shipped
 * before this seam existed. No query cost, no findings, no chat.
 */
export const REVIEW_LOOP_KILL_SWITCH_ENV = 'CYBOFLOW_DISABLE_REVIEW_LOOP_TRIAGE';

/** True when the operator has disabled the supervised review loop for this process. */
function reviewLoopTriageDisabled(): boolean {
  return process.env[REVIEW_LOOP_KILL_SWITCH_ENV] === '1';
}

/**
 * Rollback lever for the SUPERVISOR'S ESCALATION REVIEW — the recommendation it
 * attaches to an open human gate (this item) and, from item 9, to a run parked
 * on blocking findings. With it set to '1' no gate is ever consulted about and
 * no review item is ever annotated, so every card renders exactly as it did
 * before the seam existed. No query cost, no writes, no chat.
 */
export const ESCALATION_REVIEW_KILL_SWITCH_ENV = 'CYBOFLOW_DISABLE_ESCALATION_REVIEW';

/** True when the operator has disabled the supervisor's escalation review. */
function escalationReviewDisabled(): boolean {
  return process.env[ESCALATION_REVIEW_KILL_SWITCH_ENV] === '1';
}

/**
 * Most review-queue rows folded into ONE escalation consult.
 *
 * The list is context, not the decision: a run that filed sixty findings would
 * otherwise push the gate body, the deliverables and the timeline out of the
 * model's attention with rows it does not need to read individually. Newest
 * first, so what survives the cap is what the run did most recently.
 */
export const ESCALATION_REVIEW_ITEM_CAP = 30;

/**
 * Most blocking findings the supervisor may RESOLVE on one pass over a step
 * boundary (in-memory, per host instance = per walk).
 *
 * Small on purpose. A boundary that hands back four autonomous resolutions is
 * already an unusual run; one that hands back twenty is a supervisor clearing
 * its own defect queue, which is the exact failure this seam has to be unable to
 * produce. Past the cap a `resolve` is downgraded to a `recommend`, so nothing is
 * lost — the item keeps blocking and the human sees the advice.
 */
export const MONITOR_WALK_RESOLVE_CAP = 4;

/**
 * Most blocking findings the supervisor may resolve across the WHOLE run,
 * counted from the `escalation-resolve` audit findings already committed for it.
 *
 * The walk cap alone is defeated by a restart or a rewind: both mint a fresh
 * host with a zeroed counter, so a run that crash-looped could resolve four
 * items per attempt forever. This one is read from the database before each
 * resolve, so the budget survives everything that resets process state.
 */
export const MONITOR_RUN_RESOLVE_CAP = 8;

/** Grouping category for the supervisor's autonomous-resolve audit findings. */
const ESCALATION_RESOLVE_FINDING_CATEGORY = 'escalation-resolve';

/** The recommendation menu for a blocking FINDING — keep it, or drop it. */
const FINDING_RECOMMENDATION_CHOICES: readonly SupervisorRecommendationChoice[] = ['continue', 'dismiss'];

/** The recommendation menu for any other blocking item (a decision gate, a pause). */
const DECISION_RECOMMENDATION_CHOICES: readonly SupervisorRecommendationChoice[] = [
  'revise',
  'approve',
  'reject',
];

/**
 * Normalize the supervisor's free-text `choice` onto the menu this item's KIND
 * actually offers, defaulting to the menu's FIRST entry.
 *
 * The defaults are chosen to be the least consequential answer of each menu:
 * `continue` keeps a finding blocking (today's behaviour), and `revise` sends a
 * decision back rather than emphasizing the approve or reject button on advice
 * the supervisor did not actually name.
 */
function normalizeBlockingChoice(kind: ReviewItemKind, choice: string | undefined): SupervisorRecommendationChoice {
  const menu = kind === 'finding' ? FINDING_RECOMMENDATION_CHOICES : DECISION_RECOMMENDATION_CHOICES;
  const found = menu.find((c) => c === choice?.trim().toLowerCase());
  return found ?? menu[0];
}

/** The `ReviewItemError.code` a refusal carries when the human answered first. */
const INVALID_STATUS_CODE = 'invalid_status';

/** True for the EXPECTED refusal: the human resolved the gate mid-consult. */
function isInvalidStatusRefusal(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === INVALID_STATUS_CODE
  );
}

/**
 * The first sentence of a rationale — what the card renders next to the button.
 *
 * Sentence-splitting on `.`/`!`/`?` + whitespace is deliberately crude: the
 * FULL rationale is written underneath either way, so a bad split costs a
 * slightly long headline, never any meaning. A rationale with no terminator at
 * all is used whole.
 */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  const m = /^(.+?[.!?])(\s|$)/s.exec(trimmed);
  return (m ? m[1] : trimmed).trim();
}

/**
 * The task facts the monitor's lane-triage prompt needs but the CONTROLLER does
 * not have (it only ever sees opaque fan-out item ids). Resolved by the injected
 * {@link ProgrammaticRunHostArgs.readLaneTask} reader.
 */
export interface LaneTriageTaskFacts {
  /** Display ref, e.g. `TASK-014`. */
  taskRef?: string;
  taskTitle?: string;
  /** The task's CURRENT body — the acceptance criteria the lane works from. */
  taskBody?: string;
}

/** Outcome of the injected task-body adjust (a REFUSAL is `ok: false`, not a throw). */
export interface LaneTriageAdjustResult {
  ok: boolean;
  /** Machine-readable refusal reason, surfaced in the chat note + the finding. */
  reason?: string;
}

/** Grouping category for the supervisor's review-loop audit findings in the review queue. */
const REVIEW_LOOP_FINDING_CATEGORY = 'review-loop';
/** Grouping category for the supervisor's triage-retry audit findings in the review queue. */
const TRIAGE_RETRY_FINDING_CATEGORY = 'triage-retry';

/** Longest before/after body excerpt rendered into the audit finding. */
const FINDING_BODY_EXCERPT = 1200;

/** Truncate a body for the audit finding without pretending it is complete. */
function excerptBody(body: string | undefined): string {
  const text = (body ?? '').trim();
  if (text.length === 0) return '_(empty)_';
  return text.length <= FINDING_BODY_EXCERPT ? text : `${text.slice(0, FINDING_BODY_EXCERPT)}\n\n…(truncated)`;
}

/**
 * Drives a step boundary onto the live timeline (current_step_id + emit). In
 * production a thin adapter over `buildStepTransitionEvent`; in tests a spy.
 */
export interface StepReporter {
  report(runId: string, stepId: string, status: WorkflowStepReportStatus): void;
}

export interface ProgrammaticRunHostArgs {
  runId: string;
  projectId: number;
  reporter: StepReporter;
  gate: HumanGateResolver;
  /**
   * Optional blocking-review-items checkpoint (Fix: blocking findings must block).
   * When present the host parks the run at each step boundary while a pending
   * blocking review_item exists (e.g. a blocking finding) and awaits it clearing.
   * Absent ⇒ the controller never parks for review items (byte-identical to today
   * for tests / any host built without it).
   */
  blockingGate?: BlockingItemsResolver;
  /**
   * Optional SYSTEMIC-pause gate (the 2026-07-06 planner-incident fix). When
   * present the host routes a systemic step failure (usage/session/rate limit,
   * provider overload, auth — `StepRunResult.systemic === true`) here to
   * park-and-retry: it opens a BLOCKING 'decision' pause item, parks the run, and
   * settles 'retry' (condition cleared) / 'giveup' (human dismissed → normal
   * failure path) / 'canceled' (run canceled while parked). Absent ⇒
   * `awaitSystemicPause` returns 'giveup' — byte-identical to a world without the
   * seam (the systemic failure follows the normal step-failure path).
   */
  systemicGate?: SystemicPauseResolver;
  /**
   * The ON-DEMAND monitor (the monitor-unify refactor). When present, the host
   * routes `triageFailure` to `monitor.triage` (which reads the WHOLE run history
   * fresh + may inspect the worktree) and injects its rationale into the run's Chat
   * pane. Absent (tests) ⇒ `triageFailure` returns 'escalate' with a plain chat
   * note. In production the monitor is ALWAYS built for programmatic runs (the
   * supervisor-role redesign, 2026-07-05 — no config opt-in).
   */
  monitor?: MonitorSession;
  /**
   * ONE-SHOT retry-guidance setter (`RunDirectives.retryGuidance`), injected by
   * the runner that owns the run's directives. Called by `triageFailure` when the
   * supervisor's verdict is 'retry' WITH guidance, so the step's next spawn is
   * told what to do differently instead of repeating the attempt its own retry
   * budget already made. Absent (tests / a host built without a runner) ⇒ the
   * retry still happens, just unguided — logged at warn, never a failure: a
   * dropped hint must never be worse than the pre-seam behaviour.
   */
  setRetryGuidance?: (stepId: string, text: string) => void;
  /**
   * Inject a synthetic event into the run's unified stream (monitor-unify seam).
   * Used to render the monitor's triage rationale as an assistant turn in the Chat
   * pane. Threaded from the run context (Slice B); a no-op when no persisting bridge
   * was wired, so the host can call it unconditionally.
   */
  injectEvent?: (event: ClaudeStreamEvent) => void;
  /**
   * Per-step result sink (migration 033). When present, the host persists each
   * settled step's StepReport (in production via StepResultStore.record) — backing
   * queryable per-step results + crash-safe resume. Absent ⇒ not recorded.
   */
  recordStepResult?: (runId: string, report: StepReport) => void;
  /**
   * Fan-out lane driver PROVIDER (sprint-lane backed). Consulted by the host's
   * `fanOut` getter EVERY time the controller reads it — NOT captured once at
   * construction — because `ship` stamps `workflow_runs.batch_id` MID-RUN (the
   * materialize-batch step's `cyboflow_create_sprint_batch` MCP tool), strictly
   * AFTER this host is built and BEFORE the run's execute-tasks fanOut step is
   * reached. A one-shot field would forever see "no batch" for that walk and the
   * fanOut step would silently degrade to a single agent step. The provider is
   * expected to memoize its own successful resolution (batch_id only ever
   * transitions null → non-null, never un-stamped) — DefaultProgrammaticRunner's
   * does — so a settled driver is a cheap in-memory return on later consults, not
   * a repeat DB read. Absent ⇒ `host.fanOut` is always undefined ⇒ the controller
   * never fans out (a `fanOut` step runs as a normal single agent step — the
   * behavior of every host built without one, e.g. most existing tests).
   */
  fanOutDriverProvider?: () => FanOutDriver | undefined;
  /**
   * Optional visual merge-gate (programmatic actuation). Exposed verbatim on the
   * host's `visualGate` getter so the controller can park + await the async verdict
   * after a lane's visual-verify step. Attached whenever the caller wires one —
   * NOT gated on a fan-out driver existing (which, under lazy resolution above,
   * this host cannot know at construction time). It is otherwise inert: the
   * controller only ever consults `visualGate` from inside `runFanOut`, which
   * itself only runs once `host.fanOut` has resolved non-undefined, so wiring it
   * unconditionally strands nothing. Absent ⇒ `host.visualGate` is undefined ⇒
   * the controller never parks (byte-identical).
   */
  visualGate?: VisualVerifyGate;
  /**
   * Optional agentless visual-verify enqueue capability (verification-agent
   * redesign §5.3/§5.4). Exposed verbatim on the host's `enqueueVisualVerification`
   * getter so the controller's agentless visual-verify step can enqueue the
   * composed task on the central scheduler. Like `visualGate` it is wired
   * unconditionally (the controller consults it only inside `runFanOut`, which runs
   * only once a fan-out driver has resolved). Absent ⇒ the controller never
   * enqueues (the visual-verify step is a clean skip — byte-identical).
   */
  enqueueVisualVerification?: ControllerHost['enqueueVisualVerification'];
  /**
   * Optional precondition predicate for OPTIONAL pure human-gate steps
   * (ControllerHost.shouldSkipHumanGate, run-bound by the runner). Returns a
   * skip reason when the gate's reviewable surface is absent, null to open the
   * gate. Absent ⇒ every gate opens.
   */
  humanGateSkip?: (step: WorkflowStep) => string | null;
  /**
   * Read-back of the free text a human typed when resolving one of this run's
   * gates (ControllerHost.readGateResolutionNote, run-bound by the runner). The
   * gate resolver reduces a resolution to a four-way verdict and drops the note,
   * which on a 'revise' is the entire signal — so the controller asks for it here
   * when it arms a gate revision. Injected rather than read inline because this
   * host holds no DB handle. MUST be fail-soft (return undefined, never throw).
   * Absent ⇒ a revision carries the gate id alone.
   */
  readGateResolutionNote?: (stepId: string) => string | undefined;
  /**
   * Read-back of this run's CURRENT adversarial-review artifact markdown
   * (ControllerHost.readAdversarialReview, run-bound by the runner) — the same
   * reader the revision prompt uses. The controller consults it when a review
   * step's captured text carries no verdict of its own, because the artifact is
   * the durable channel and the chat text can simply be missing. Injected rather
   * than read inline because this host holds no DB handle. MUST be fail-soft
   * (return undefined, never throw). Absent ⇒ the controller reads only the
   * reviewer's final text.
   */
  readAdversarialReview?: () => string | undefined;
  /**
   * LANE-TRIAGE task reader. Resolves the ref / title / CURRENT body for a
   * fan-out item so `triageLaneFailure` can ENRICH the controller's bare
   * lane/failure facts into the monitor's full `LaneTriageRequest` — the brain
   * decides whether the task's acceptance criteria conflict with repo reality,
   * which it cannot do without seeing them. Run-bound by the composition root
   * (production reads the `tasks` row). MUST be fail-soft (return undefined
   * rather than throw). Absent ⇒ the monitor is consulted with an empty
   * title/body and the item id standing in for the ref: still a usable rescue
   * consult, but `adjust_and_retry` is effectively out of reach.
   */
  readLaneTask?: (itemId: string) => LaneTriageTaskFacts | undefined;
  /**
   * LANE-TRIAGE task-body writer — the monitor's AUTONOMOUS requirements
   * adjustment (`adjust_and_retry`). Bound by the composition root to
   * `adjustRunTaskForLaneTriage`, which routes through TaskChangeRouter and
   * deliberately bypasses `edit_task`'s queued-only lane guard (safe because
   * lane prompts re-read the body at every step spawn and the host always pairs
   * the edit with a lane rewind). A normal refusal resolves `{ ok: false,
   * reason }`; the host DOWNGRADES to a plain rescue rather than abandoning it.
   * Absent ⇒ every adjust verdict is downgraded to a plain rescue.
   */
  adjustRunTask?: (input: { taskRef: string; body: string }) => Promise<LaneTriageAdjustResult>;
  /**
   * LANE-TRIAGE audit sink. Files the NON-BLOCKING review-queue record of an
   * autonomous intervention (bound by the composition root to the SAME
   * ReviewItemRouter seam the monitor's `fileNote` action uses). Called for
   * RESCUES only — a plain give_up needs no record because the lane's failure
   * already surfaces at the run's human gate. Fail-soft at the call site: a
   * throwing/absent sink never blocks the rescue it was supposed to audit.
   */
  fileLaneTriageFinding?: (input: { title: string; body: string }) => Promise<void>;
  /**
   * SUPERVISOR-AUDIT sink. Files the NON-BLOCKING record of ONE review-loop
   * consult — the verdict, its rationale, and the steering the re-run will be
   * given — so an autonomous decision to spend (or not spend) another design
   * lap is visible in the review queue before the human reaches the gate. Bound
   * by the composition root to the SAME ReviewItemRouter seam the lane-triage
   * audit uses, with actor `monitor`. Fail-soft at the call site: a throwing or
   * absent sink never costs the decision it was supposed to record.
   */
  fileMonitorFinding?: (input: { title: string; body: string; category?: string }) => Promise<void>;
  /**
   * SET-ASIDE sink. Files one non-blocking finding per adversarial-review entry
   * the supervisor set aside, IMMEDIATELY — which is what makes setting an entry
   * aside safe: the entry leaves the lap but not the run. Composed to match the
   * approve-design gate's accepted-risk findings exactly (same title shape, same
   * category, same severity mapping) so `filedAdversarialIds` dedupes it there
   * rather than filing it twice. Fail-soft at the call site.
   */
  fileSetAsideFinding?: (input: SetAsideFindingInput) => Promise<void>;
  /**
   * GATE-OPEN hook. Fired (fire-and-forget, never awaited by the resolver) once a
   * human gate is live and this host has armed on it, with the gate item's real
   * title + body. The supervisor's escalation consult binds here: it is the first
   * instant the question the human is being asked actually exists, because the
   * gate body is composed inside the gate-open transaction.
   *
   * MUST be fail-soft — a rejection is logged and swallowed by the resolver, and
   * nothing here may delay or reject the gate promise. Absent => no hook fires
   * (today's behaviour).
   */
  onGateOpened?: (
    step: WorkflowStep,
    ctx: ControllerStepContext,
    snapshot: HumanGateOpenedSnapshot,
  ) => Promise<void>;
  /**
   * ESCALATION-REVIEW reader: this run's review-queue rows as the gate consult
   * should see them — its PENDING items plus every `monitor`-sourced one
   * whatever its status, newest first, capped at
   * {@link ESCALATION_REVIEW_ITEM_CAP} rows.
   *
   * This is how the supervisor's own autonomous history (set-aside entries, lane
   * rescues, loop-stop audits) reaches the person reviewing the gate — CR-9. The
   * `monitor`-sourced arm ignores status on purpose: an audit finding somebody
   * already triaged still describes an action this run took unattended.
   * Run-bound by the composition root; MUST be fail-soft. Absent ⇒ the consult
   * runs with an empty list.
   */
  listRunReviewItems?: (runId: string) => Promise<EscalationReviewItemSummary[]>;
  /**
   * ESCALATION-REVIEW writer: upsert the supervisor's recommendation section
   * into a still-pending review item's body, through the `ReviewItemRouter`
   * `annotate` op (the only sanctioned path — see the chokepoint rule).
   *
   * REJECTS rather than throws for the expected race: the gate is annotated
   * fire-and-forget while it is open, so a human who answers first leaves the
   * router refusing with `invalid_status`. The caller logs that at debug and
   * anything else at warn. Absent ⇒ a recommendation is logged only.
   */
  annotateReviewItem?: (input: { reviewItemId: string; markdown: string }) => Promise<void>;
  /**
   * REVIEW-WRITE BARRIER (CR-3): resolve once every review-item write already
   * enqueued for this project has committed
   * (`ReviewItemRouter.awaitProjectWritesSettled`).
   *
   * Awaited at EVERY step boundary, before any read of the blocking queue —
   * including the plain no-consult path. The MCP `report_finding` reply lands
   * before its create drains the router's per-project queue, so a boundary that
   * read `review_items` directly could march straight past the blocking finding
   * the step it just finished had filed. That is a pre-existing race; this is
   * where it is closed. Fail-soft: absent or throwing ⇒ the boundary proceeds
   * unbarriered, exactly as it did before.
   */
  awaitReviewWritesSettled?: (projectId: number) => Promise<void>;
  /**
   * AUTONOMOUS-RESOLVE sink: close one blocking FINDING as the supervisor,
   * through the `ReviewItemRouter` `resolve` op with actor `monitor`.
   *
   * The only host seam that can clear a human-audience blocking item without a
   * human, which is why it is paired with two caps and an audit finding on every
   * use. Absent ⇒ a `resolve` verdict is downgraded to a recommendation (the
   * item keeps blocking) rather than dropped.
   */
  resolveReviewItemAsMonitor?: (input: { reviewItemId: string; resolution: string }) => Promise<void>;
  /**
   * DURABLE RESOLVE COUNTER: how many `escalation-resolve` audit findings this
   * run already carries. Read before EACH autonomous resolve so
   * {@link MONITOR_RUN_RESOLVE_CAP} survives restarts and rewinds, which both
   * mint a fresh host with a zeroed in-memory counter. Absent ⇒ only the walk
   * cap applies; throwing ⇒ the resolve is downgraded (a budget that cannot be
   * read is treated as spent, never as free).
   */
  countMonitorResolves?: (runId: string) => Promise<number>;
  /**
   * VISUAL-VERIFICATION PRE-ROW SKIP sink (F8 "never skip silently",
   * docs/proposals/visual-verification-brittleness-fixes.md). Bound by the
   * composition root to the SAME ReviewItemRouter chokepoint verdictDelivery
   * files its verification findings on, so a lane whose check never reached the
   * queue is as visible as one whose check ran and skipped. Absent ⇒ the skip is
   * logged only (byte-identical to before F8).
   */
  fileVerificationSkipFinding?: (input: { title: string; body: string }) => Promise<void>;
  /**
   * RUN-LEVEL verification posture resolver (CD1), bound by the composition root
   * to `verify/verificationPosture.ts` fed with the run stamp + the SAME
   * runbook-status closure the scheduler's §3.2 degrade gate consults. Absent ⇒
   * the controller behaves as 'available', i.e. exactly as before this seam.
   */
  resolveVerificationPosture?: () => Promise<VerificationPosture>;
  /**
   * RUN-SCOPED, SOURCE-DEDUPED finding sink: the two declarations this host makes
   * about the run as a whole — "no verifiable modality" (CD1) and "N lanes share
   * one build break" (CD3) — are both statements that must appear exactly once,
   * so both are filed through `ReviewItemRouter.createIfNoPending`, which runs
   * the check-and-create as ONE task on the per-project queue. Passing `source`
   * explicitly (rather than baking it in) is what lets one sink serve both: the
   * source IS the dedupe key. Absent ⇒ the declaration is logged only.
   */
  fileRunScopedFinding?: (input: { source: string; title: string; body: string }) => Promise<void>;
  /**
   * SHARED BUILD-BREAK sweep (CD3) — bound to `buildBreakDetector.sweepBuildBreaks`
   * over this run's DB. Absent ⇒ no sweep runs (every host without a DB).
   */
  sweepBuildBreaks?: () => BuildBreakGroup[];
  logger?: LoggerLike;
}

/** Longest untrusted `reason` rendered into a skip finding, in characters. */
const SKIP_REASON_MAX_CHARS = 2000;

/**
 * Make an untrusted reason safe to drop inside a ``` fence in a review-item body:
 * neutralize any backtick run that could CLOSE the fence early (and so let the
 * text escape into markdown), and cap the length so an agent-composed rejection
 * quoting a hundred commands cannot dominate the review queue. Truncation is
 * announced rather than silent.
 */
function fenceSafeReason(reason: string): string {
  const capped =
    reason.length > SKIP_REASON_MAX_CHARS
      ? `${reason.slice(0, SKIP_REASON_MAX_CHARS)}\n… (truncated, ${reason.length} chars total)`
      : reason;
  // U+200B between backticks breaks a ``` run without dropping any character the
  // reader needs; a plain strip would silently rewrite the quoted command.
  return capped.replace(/`{3,}/g, (run) => run.split('').join('\u200b'));
}

export class ProgrammaticRunHost implements ControllerHost {
  /**
   * Review items the supervisor has already answered on THIS walk. A run that
   * parks, is unparked by a human, and reaches the next boundary must not pay
   * for a second opinion on the items it was already asked about — and above
   * all must not get a second chance to `resolve` one it passed on. Per host
   * instance, i.e. per walk: a restart deliberately starts fresh, because the
   * durable cap is what bounds the run as a whole.
   */
  private readonly reviewedBlockingIds = new Set<string>();

  /** Autonomous resolves spent on this walk — see {@link MONITOR_WALK_RESOLVE_CAP}. */
  private walkResolveCount = 0;

  constructor(private readonly args: ProgrammaticRunHostArgs) {}

  reportStep(stepId: string, status: WorkflowStepReportStatus): void {
    try {
      this.args.reporter.report(this.args.runId, stepId, status);
    } catch (err) {
      // Fail-soft, mirroring RunExecutor.emitStep — a broken timeline emit must
      // never abort the walk.
      this.args.logger?.warn('[ProgrammaticRunHost] step report failed (fail-soft)', {
        runId: this.args.runId,
        stepId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async requestHumanGate(step: WorkflowStep, ctx: ControllerStepContext): Promise<HumanGateDecision> {
    // The gate-open hook: the host's OWN escalation review by default, and
    // `args.onGateOpened` as an explicit override (which is how tests observe
    // the seam without a monitor). Nothing is passed at all when neither exists,
    // because the resolver's `onOpened` is optional and an always-present no-op
    // would make "is anybody listening" untestable here.
    const hook =
      this.args.onGateOpened ??
      (this.args.monitor?.reviewGateEscalation
        ? (s: WorkflowStep, c: ControllerStepContext, snap: HumanGateOpenedSnapshot) =>
            this.reviewGateEscalation(s, c, snap)
        : undefined);
    return this.args.gate.resolve({
      runId: this.args.runId,
      projectId: this.args.projectId,
      step,
      signal: ctx.signal,
      ...(hook ? { onOpened: (snapshot: HumanGateOpenedSnapshot) => hook(step, ctx, snapshot) } : {}),
    });
  }

  /**
   * ESCALATION-REVIEW seam — consult the supervisor about an OPEN human gate and
   * annotate its review item with a non-binding recommendation.
   *
   * Bound as the gate resolver's `onOpened` hook (see `requestHumanGate`), which
   * fires FIRE-AND-FORGET: this method is never awaited by the gate promise, and
   * the human may answer while it is still running. That race is the designed
   * outcome, not a bug — the annotate is then refused `invalid_status` and the
   * human's verdict stands untouched.
   *
   * Order of business, each arm short-circuiting to today's behaviour (a card
   * with no recommendation):
   *   1. KILL SWITCH (`CYBOFLOW_DISABLE_ESCALATION_REVIEW=1`) ⇒ return. No
   *      consult, no chat (a rollback lever should be silent) — just a log.
   *   2. No monitor, or one with no `reviewGateEscalation` ⇒ return.
   *   3. ALREADY ANNOTATED ⇒ return. A RESUMED gate whose body already carries
   *      the section keeps the recommendation the human has been looking at;
   *      re-consulting would spend a query to overwrite advice with advice
   *      (CR-5). A resumed gate WITHOUT the section still gets its consult —
   *      that is a gate whose first consult never landed.
   *   4. Consult, then annotate on a `recommend`. A `pass` writes nothing: an
   *      empty "no recommendation" section would be noise in a body the human
   *      reads to decide.
   *
   * NEVER THROWS, at any depth: the resolver logs and swallows a rejection, but
   * relying on that would make every failure here look like a gate-hook bug.
   */
  async reviewGateEscalation(
    step: WorkflowStep,
    ctx: ControllerStepContext,
    snapshot: HumanGateOpenedSnapshot,
  ): Promise<void> {
    try {
      if (escalationReviewDisabled()) {
        this.args.logger?.info('[ProgrammaticRunHost] escalation review disabled by kill switch', {
          runId: this.args.runId,
          stepId: step.id,
        });
        return;
      }
      const monitor = this.args.monitor;
      if (!monitor?.reviewGateEscalation) return;
      if (readMarkdownSection(snapshot.body, SUPERVISOR_RECOMMENDATION_HEADING) !== null) {
        this.args.logger?.info('[ProgrammaticRunHost] gate already carries a recommendation; not re-consulting', {
          runId: this.args.runId,
          stepId: step.id,
          reviewItemId: snapshot.reviewItemId,
          resumed: snapshot.resumed,
        });
        return;
      }

      const reviewItems = await this.readEscalationReviewItems();
      const decision = await monitor.reviewGateEscalation(
        {
          kind: 'gate',
          stepId: step.id,
          stepName: step.name,
          reviewItemId: snapshot.reviewItemId,
          title: snapshot.title,
          body: snapshot.body,
          ...(ctx.escalation ? { escalation: ctx.escalation } : {}),
          reviewItems,
        },
        ctx.signal,
      );
      if (decision.action !== 'recommend') return;

      await this.annotateGateRecommendation(step, snapshot.reviewItemId, decision);
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] gate escalation review failed (fail-soft)', {
        runId: this.args.runId,
        stepId: step.id,
        reviewItemId: snapshot.reviewItemId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * The run's review-queue summaries for a gate consult. Fail-soft twice over
   * (absent reader and throwing reader both yield []): the recommendation is an
   * enrichment, and a consult with a thinner picture beats no consult.
   */
  private async readEscalationReviewItems(): Promise<EscalationReviewItemSummary[]> {
    try {
      return (await this.args.listRunReviewItems?.(this.args.runId)) ?? [];
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] run review-item read failed (fail-soft)', {
        runId: this.args.runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Write the recommendation onto the gate item through the injected `annotate`
   * sink.
   *
   * `invalid_status` is the EXPECTED outcome of the race this whole hook runs
   * inside — the human answered while the consult was in flight — so it is a
   * debug line, not a warning: the decision is already made and the advice is
   * correctly discarded. Every other failure is a real one and warns.
   */
  private async annotateGateRecommendation(
    step: WorkflowStep,
    reviewItemId: string,
    decision: Extract<GateEscalationDecision, { action: 'recommend' }>,
  ): Promise<void> {
    const sink = this.args.annotateReviewItem;
    if (!sink) {
      this.args.logger?.info('[ProgrammaticRunHost] no annotate sink; recommendation logged only', {
        runId: this.args.runId,
        stepId: step.id,
        choice: decision.choice,
        rationale: decision.rationale,
      });
      return;
    }
    // A ONE-SENTENCE rationale is already the whole headline, so passing it as
    // the tail too would print it twice under the heading. The tail is dropped
    // only when it is character-for-character the head; a longer rationale keeps
    // its full text under the machine-readable line.
    const head = firstSentence(decision.rationale);
    const tail = decision.rationale.trim();
    try {
      await sink({
        reviewItemId,
        markdown: composeSupervisorRecommendation(decision.choice, head, tail === head ? undefined : tail),
      });
      this.args.logger?.info('[ProgrammaticRunHost] gate recommendation annotated', {
        runId: this.args.runId,
        stepId: step.id,
        reviewItemId,
        choice: decision.choice,
      });
    } catch (err) {
      if (isInvalidStatusRefusal(err)) {
        this.args.logger?.debug('[ProgrammaticRunHost] gate resolved before the recommendation landed', {
          runId: this.args.runId,
          stepId: step.id,
          reviewItemId,
        });
        return;
      }
      this.args.logger?.warn('[ProgrammaticRunHost] gate recommendation not annotated (fail-soft)', {
        runId: this.args.runId,
        stepId: step.id,
        reviewItemId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  shouldSkipHumanGate(step: WorkflowStep): string | null {
    return this.args.humanGateSkip?.(step) ?? null;
  }

  /**
   * The human's free-text note on a resolved gate, for the controller's gate
   * revision. Fail-soft twice over: an absent reader and a throwing one both
   * yield undefined, because a missing note degrades the re-run's prompt while a
   * thrown read would abort a walk that is mid-loopback.
   */
  readGateResolutionNote(stepId: string): string | undefined {
    try {
      return this.args.readGateResolutionNote?.(stepId);
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] gate resolution note read failed (fail-soft)', {
        runId: this.args.runId,
        stepId,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /**
   * This run's current adversarial-review artifact markdown, for the controller's
   * loopback verdict. Fail-soft twice over, for the same reason as the gate note:
   * an absent reader and a throwing one both yield undefined, because degrading to
   * the reviewer's chat text is survivable while a thrown read would abort a walk
   * that is mid-review.
   */
  readAdversarialReview(): string | undefined {
    try {
      return this.args.readAdversarialReview?.();
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] adversarial-review artifact read failed (fail-soft)', {
        runId: this.args.runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /**
   * Step-boundary checkpoint: park the run while a pending BLOCKING review_item
   * exists (e.g. a blocking finding), then resume. Delegates to the injected
   * blockingGate; a run built without one proceeds immediately (fast no-op).
   */
  async awaitBlockingReviewItems(runId: string, signal?: AbortSignal): Promise<'proceed' | 'canceled'> {
    const gate = this.args.blockingGate;
    if (!gate) return 'proceed';
    // (1) WRITE BARRIER FIRST, always — before the consult's read AND before
    // awaitClear's own fast-path read. See `awaitReviewWritesSettled`: without
    // it a boundary can march past the very finding the step just filed.
    await this.awaitReviewWritesSettled();
    // (2) The supervisor's escalation review. Never throws, never parks, and
    // never gates: whatever it does or fails to do, awaitClear still decides.
    await this.reviewBlockingItems(gate, runId, signal);
    return gate.awaitClear({ runId, projectId: this.args.projectId, signal });
  }

  /**
   * Await the review-item write barrier, fail-soft.
   *
   * An absent or throwing barrier degrades to the PRE-BARRIER behaviour (read
   * whatever has committed so far), which is survivable; letting it reject would
   * abort a walk over a queue-drain hiccup, which is not.
   */
  private async awaitReviewWritesSettled(): Promise<void> {
    try {
      await this.args.awaitReviewWritesSettled?.(this.args.projectId);
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] review write barrier failed (fail-soft)', {
        runId: this.args.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * ESCALATION-REVIEW seam at a STEP BOUNDARY — consult the supervisor about the
   * blocking items that are about to park the run, and apply its per-item
   * verdicts.
   *
   * The gate sibling (`reviewGateEscalation`) may only ANNOTATE. This one may
   * also RESOLVE, because a blocking finding is a claim the run itself filed and
   * may itself have already closed — but only a `finding`, only within
   * {@link MONITOR_WALK_RESOLVE_CAP} and {@link MONITOR_RUN_RESOLVE_CAP}, and
   * only with an audit finding recording what was closed and why.
   *
   * Order of business, each arm short-circuiting to today's behaviour (the run
   * parks for a human):
   *   1. KILL SWITCH (`CYBOFLOW_DISABLE_ESCALATION_REVIEW=1`) ⇒ return without
   *      even reading the queue. A rollback lever should cost nothing.
   *   2. No monitor, or one with no `reviewBlockingItems` ⇒ return.
   *   3. Nothing pending, or nothing NOT ALREADY REVIEWED ON THIS WALK ⇒ return.
   *      The second half is what stops a run that parks, is unparked, and parks
   *      again from re-litigating the same items.
   *   4. Consult, mark every item reviewed, then apply the verdicts one by one.
   *
   * NEVER THROWS and never delays the park beyond its own consult: the caller
   * awaits it only so the applies land before `awaitClear` reads the queue (a
   * resolve that arrived later would park the run and then unpark it, which
   * looks like a flicker to the human).
   */
  private async reviewBlockingItems(
    gate: BlockingItemsResolver,
    runId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      if (escalationReviewDisabled()) {
        this.args.logger?.info('[ProgrammaticRunHost] blocking-items review disabled by kill switch', { runId });
        return;
      }
      const monitor = this.args.monitor;
      if (!monitor?.reviewBlockingItems) return;

      const pending = gate.listPendingBlockingItems?.(runId) ?? [];
      const fresh = pending.filter((i) => !this.reviewedBlockingIds.has(i.id));
      if (fresh.length === 0) return;

      const req: BlockingItemsEscalationRequest = { kind: 'blocking-items', items: fresh };
      const decisions = await monitor.reviewBlockingItems(req, signal);
      // Mark BEFORE applying: an item the supervisor was shown has had its one
      // look, whether or not the apply below succeeds. Re-asking on the next
      // boundary would spend another query to reach the same verdict — and,
      // worse, would give a passed-on item a second chance at a resolve.
      for (const item of fresh) this.reviewedBlockingIds.add(item.id);

      const byId = new Map(fresh.map((i) => [i.id, i]));
      for (const decision of decisions) {
        const item = byId.get(decision.reviewItemId);
        if (item === undefined) continue;
        await this.applyBlockingItemDecision(runId, item, decision);
      }
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] blocking-items review failed (fail-soft)', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Apply ONE per-item verdict. Each call is independently try/caught, so a
   * refused resolve or a broken annotate degrades that item alone — never the
   * rest of the batch, and never the park that follows.
   */
  private async applyBlockingItemDecision(
    runId: string,
    item: PendingBlockingItem,
    decision: BlockingItemDecision,
  ): Promise<void> {
    try {
      if (decision.action === 'pass') return;
      // A `resolve` survives only for a FINDING, with a resolve sink wired and
      // budget left. Every other case falls through to the recommendation —
      // which is the honest degradation: the supervisor's reasoning still
      // reaches the human, and the item keeps blocking.
      if (
        decision.action === 'resolve' &&
        item.kind === 'finding' &&
        this.args.resolveReviewItemAsMonitor !== undefined &&
        (await this.canSpendResolve(runId))
      ) {
        await this.resolveBlockingFinding(runId, item, decision.rationale);
        return;
      }
      await this.annotateBlockingItem(runId, item, decision);
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] blocking-item verdict not applied (fail-soft)', {
        runId,
        reviewItemId: item.id,
        action: decision.action,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Both resolve budgets, checked in the cheap-then-durable order.
   *
   * A durable read that THROWS counts as spent, not as free: the whole point of
   * {@link MONITOR_RUN_RESOLVE_CAP} is that a run cannot resolve its way past a
   * human, and a budget nobody can read is exactly when that guarantee matters.
   */
  private async canSpendResolve(runId: string): Promise<boolean> {
    if (this.walkResolveCount >= MONITOR_WALK_RESOLVE_CAP) {
      this.args.logger?.info('[ProgrammaticRunHost] walk resolve cap reached; downgrading to a recommendation', {
        runId,
        cap: MONITOR_WALK_RESOLVE_CAP,
      });
      return false;
    }
    const counter = this.args.countMonitorResolves;
    if (counter === undefined) return true;
    try {
      const spent = await counter(runId);
      if (spent >= MONITOR_RUN_RESOLVE_CAP) {
        this.args.logger?.info('[ProgrammaticRunHost] run resolve cap reached; downgrading to a recommendation', {
          runId,
          spent,
          cap: MONITOR_RUN_RESOLVE_CAP,
        });
        return false;
      }
      return true;
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] resolve budget unreadable; downgrading to a recommendation', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Close one blocking finding as the supervisor and file the audit record.
   *
   * The walk counter is incremented on the RESOLVE landing, not on the audit
   * finding: the resolve is what unblocks the run, and a dropped audit note must
   * not hand the walk a free extra resolve. The audit finding is filed after and
   * is fail-soft in its own right (`fileMonitorAuditFinding`) — a run that closed
   * an item but could not record it is bad, and one that closed it twice would
   * be worse.
   */
  private async resolveBlockingFinding(
    runId: string,
    item: PendingBlockingItem,
    rationale: string,
  ): Promise<void> {
    await this.args.resolveReviewItemAsMonitor?.({
      reviewItemId: item.id,
      resolution: `resolved by supervisor: ${rationale}`,
    });
    this.walkResolveCount += 1;
    this.args.logger?.info('[ProgrammaticRunHost] blocking finding resolved by the supervisor', {
      runId,
      reviewItemId: item.id,
      walkSpent: this.walkResolveCount,
    });
    await this.fileMonitorAuditFinding(
      `Resolved blocking finding: ${item.title}`,
      `${rationale}\n\nResolved item: \`${item.id}\` — ${item.title}`,
      ESCALATION_RESOLVE_FINDING_CATEGORY,
    );
  }

  /**
   * File one non-blocking `monitor`-sourced audit finding, fail-soft.
   *
   * The paper trail for an action the human never confirmed. Deliberately
   * SWALLOWS its failure: the action it records has already happened, and losing
   * the note must not also lose (or, worse, half-undo) the action. It is also
   * what {@link MONITOR_RUN_RESOLVE_CAP} counts, so an unfiled note costs the
   * run one unit of durable budget it will never get back — the safe direction.
   */
  private async fileMonitorAuditFinding(title: string, body: string, category: string): Promise<void> {
    if (!this.args.fileMonitorFinding) return;
    try {
      await this.args.fileMonitorFinding({ title, body, category });
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] supervisor audit finding not filed (fail-soft)', {
        runId: this.args.runId,
        title,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Write the supervisor's recommendation onto a still-blocking item.
   *
   * Shares the `invalid_status` treatment with the gate path: a human who
   * triaged the item while the consult was in flight is the DESIGNED outcome of
   * a consult that runs beside an open queue, so it is a debug line, not a
   * warning.
   */
  private async annotateBlockingItem(
    runId: string,
    item: PendingBlockingItem,
    decision: BlockingItemDecision,
  ): Promise<void> {
    const sink = this.args.annotateReviewItem;
    const choice = normalizeBlockingChoice(item.kind, decision.choice);
    if (!sink) {
      this.args.logger?.info('[ProgrammaticRunHost] no annotate sink; blocking-item recommendation logged only', {
        runId,
        reviewItemId: item.id,
        choice,
        rationale: decision.rationale,
      });
      return;
    }
    // Same head/tail rule as the gate annotate: a one-sentence rationale IS the
    // headline, so repeating it underneath would print it twice.
    const head = firstSentence(decision.rationale);
    const tail = decision.rationale.trim();
    try {
      await sink({
        reviewItemId: item.id,
        markdown: composeSupervisorRecommendation(choice, head, tail === head ? undefined : tail),
      });
    } catch (err) {
      if (isInvalidStatusRefusal(err)) {
        this.args.logger?.debug('[ProgrammaticRunHost] blocking item triaged before the recommendation landed', {
          runId,
          reviewItemId: item.id,
        });
        return;
      }
      throw err;
    }
  }

  /**
   * Systemic-pause seam (the 2026-07-06 planner-incident fix). Consulted when a
   * step attempt fails with `StepRunResult.systemic === true` (usage/session/rate
   * limit, provider overload, auth), BEFORE the failure consumes the retry budget
   * / optional-skip / loopback / triage. Delegates to the injected systemicGate:
   * it parks the run behind a BLOCKING pause item and settles 'retry' (cleared) /
   * 'giveup' (dismissed → normal failure path) / 'canceled' (canceled while parked).
   * A run built WITHOUT a gate returns 'giveup' — byte-identical to a world without
   * the seam. Mirrors triageFailure's try/catch + logging: a broken gate must never
   * strand the run, so any throw defaults to 'giveup'. The pause + resume/dismiss
   * transitions are surfaced in the run's Chat pane as monitor turns.
   */
  async awaitSystemicPause(
    step: WorkflowStep,
    ctx: ControllerStepContext,
    error: string | undefined,
  ): Promise<SystemicPauseVerdict> {
    if (!this.args.systemicGate) return 'giveup';
    this.injectMonitorTurn(
      `⏸ Run paused — step **${step.name}** hit a systemic failure (${(error ?? 'no error text').slice(0, 200)}). It will auto-resume when the limit resets, or resolve the pause item in the review queue to retry now.`,
    );
    try {
      const verdict = await this.args.systemicGate.awaitClear({
        runId: this.args.runId,
        projectId: this.args.projectId,
        step,
        error,
        signal: ctx.signal,
      });
      if (verdict === 'retry') this.injectMonitorTurn(`▶ Resuming — retrying step **${step.name}**.`);
      if (verdict === 'giveup')
        this.injectMonitorTurn(`⏭ Pause dismissed — step **${step.name}** now follows its normal failure handling.`);
      return verdict;
    } catch (err) {
      // A broken gate must never strand the run — default to 'giveup' so the
      // systemic failure follows the normal step-failure path.
      this.args.logger?.warn('[ProgrammaticRunHost] systemic-pause gate failed; giving up', {
        runId: this.args.runId,
        stepId: step.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'giveup';
    }
  }

  /**
   * Triage seam → the ON-DEMAND monitor (the monitor-unify refactor + the
   * supervisor-role redesign, 2026-07-05). Consulted when a REQUIRED step has
   * exhausted its retry/loopback budget, BEFORE the controller fails the run:
   *   - monitor present ⇒ ask `monitor.triage` (reads the whole history, may inspect
   *     the worktree). The supervisor may auto-'retry' a transient failure, but it
   *     has NO unilateral 'fail' power — a 'fail' verdict is DOWNGRADED to
   *     'escalate' (the rationale becomes a recommendation the human rules on).
   *     Whatever the outcome, its rationale is INJECTED into the Chat pane as an
   *     assistant turn, so an escalation surfaces in BOTH the chat AND the human
   *     review queue — never one or the other.
   *   - monitor absent (tests / a factory returning undefined) ⇒ 'escalate', with a
   *     plain chat note so the dual-surface invariant holds without a brain.
   * Fail-soft: a throwing monitor/inject must never strand the run — default to
   * 'escalate' (DefaultMonitorSession itself already fails-soft to 'escalate', so
   * this catch is a belt-and-braces guard).
   *
   * Two things the seam now also carries:
   *   - a 'retry' verdict's GUIDANCE is STAGED for the step's next spawn (the
   *     one-shot `RunDirectives.retryGuidance` channel) and quoted into the chat
   *     note, so a supervised retry actually differs from the attempts the step's
   *     own budget already spent. A host with no setter wired still retries —
   *     unguided, logged at warn.
   *   - an OPTIONAL step's 'escalate'/'fail' is phrased as SKIPPING. The
   *     controller never opens a gate for an optional step (item 7D consults this
   *     seam before skipping one), so "escalated to the review queue" would
   *     promise the user a gate that is never going to appear.
   */
  async triageFailure(
    step: WorkflowStep,
    ctx: ControllerStepContext,
    error: string | undefined,
  ): Promise<TriageDecision> {
    const optional = step.optional === true;
    // What an unusable/absent verdict MEANS for this step, in the user's terms.
    const escalationOutcome = optional
      ? 'skipping the optional step'
      : 'escalated to the review queue for your decision';
    if (!this.args.monitor) {
      this.injectMonitorTurn(`Step **${step.name}** exhausted its retries — ${escalationOutcome}.`);
      return 'escalate';
    }
    try {
      const { decision, rationale, guidance } = await this.args.monitor.triage(step, error, ctx.signal);
      if (decision === 'fail') {
        // The supervisor recommends ending the run, but ending it is the HUMAN's
        // call — downgrade to an escalation carrying the recommendation. For an
        // optional step there is no run to end and no gate to open: it is a skip.
        this.injectMonitorTurn(
          optional
            ? `Triage — ${step.name}: the supervisor judged this optional step not worth another attempt — skipping the optional step. ${rationale}`
            : `Triage — ${step.name}: the supervisor recommends ending the run, escalated to the review queue for your decision. ${rationale}`,
        );
        return 'escalate';
      }
      if (decision === 'escalate') {
        // Non-optional wording is unchanged from the pre-guidance seam; only an
        // OPTIONAL step needs re-phrasing, because nothing is escalated there.
        this.injectMonitorTurn(
          optional
            ? `Triage — ${step.name}: skipping the optional step. ${rationale}`
            : `Triage — ${step.name}: escalate. ${rationale}`,
        );
        return 'escalate';
      }
      // 'retry' — stage the supervisor's guidance for the next spawn before the
      // controller re-drives the step, and quote it in the chat so the user sees
      // what the retry was bought with. Fail-soft: a missing or throwing setter
      // costs the guidance, never the retry.
      const staged = this.stageRetryGuidance(step, guidance);
      this.injectMonitorTurn(
        staged !== undefined
          ? `Triage — ${step.name}: retry. ${rationale}\n\nGuidance for the retry: ${staged}`
          : `Triage — ${step.name}: retry. ${rationale}`,
      );
      // The audit record the charter promises ("every autonomous action is
      // recorded in the run's review queue"): a supervised retry spends a step
      // turn on the supervisor's say-so, so it gets the same non-blocking paper
      // trail a lane rescue or a review-loop verdict gets. Fail-soft — the retry
      // is already decided, and losing its record must not lose the retry.
      await this.fileTriageRetryAudit(step, rationale, staged);
      return 'retry';
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] monitor.triage failed; escalating to human', {
        runId: this.args.runId,
        stepId: step.id,
        error: err instanceof Error ? err.message : String(err),
      });
      this.injectMonitorTurn(`Step **${step.name}** exhausted its retries — ${escalationOutcome}.`);
      return 'escalate';
    }
  }

  /**
   * File the NON-BLOCKING audit record for one supervised triage retry (source
   * `monitor`, category `triage-retry`), so the human reaches the next gate
   * knowing a step was re-driven autonomously and with what instruction. Absent
   * sink ⇒ nothing filed (the chat note still carries the decision).
   */
  private async fileTriageRetryAudit(
    step: WorkflowStep,
    rationale: string,
    guidance: string | undefined,
  ): Promise<void> {
    if (!this.args.fileMonitorFinding) return;
    try {
      await this.args.fileMonitorFinding({
        title: `Triage retry — ${step.name}`,
        body: [
          `The run supervisor re-drove \`${step.id}\` after it exhausted its automatic retries` +
            `${step.optional === true ? ' (an optional step that would otherwise have been skipped)' : ''}.`,
          '',
          `- Rationale: ${rationale}`,
          guidance !== undefined
            ? `- Guidance handed to the retry (this attempt only): ${guidance}`
            : '- No guidance was staged for the retry.',
        ].join('\n'),
        category: TRIAGE_RETRY_FINDING_CATEGORY,
      });
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] triage-retry audit finding not filed (fail-soft)', {
        runId: this.args.runId,
        stepId: step.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Stage a triage 'retry' verdict's guidance on the one-shot channel and return
   * what was actually staged (undefined ⇒ nothing was, so the chat note must not
   * promise guidance the re-run will never see). Never throws: the guidance is an
   * improvement on the retry, not a precondition for it, so a host built without
   * the setter — or one whose setter throws — logs and lets the unguided retry
   * proceed exactly as it did before this channel existed.
   */
  private stageRetryGuidance(step: WorkflowStep, guidance: string | undefined): string | undefined {
    const text = (guidance ?? '').trim();
    if (text.length === 0) return undefined;
    if (!this.args.setRetryGuidance) {
      this.args.logger?.warn('[ProgrammaticRunHost] retry guidance dropped (no setter wired)', {
        runId: this.args.runId,
        stepId: step.id,
      });
      return undefined;
    }
    try {
      this.args.setRetryGuidance(step.id, text);
      return text;
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] retry guidance dropped (setter failed)', {
        runId: this.args.runId,
        stepId: step.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /**
   * LANE-triage seam — `triageFailure`'s per-lane sibling. Consulted when ONE
   * sprint fan-out lane exhausts an automatic budget, BEFORE the controller
   * settles it 'failed'. Resolves the executable verdict only (give_up | rescue),
   * so the controller never learns what a monitor, a task edit, or a finding is.
   *
   * Order of business, each arm short-circuiting to the pre-seam behavior:
   *   1. KILL SWITCH (`CYBOFLOW_DISABLE_LANE_TRIAGE=1`) ⇒ give_up. No consult, no
   *      chat turn (a rollback lever should be silent, not chatty) — just a log.
   *   2. No monitor, or a monitor with no `triageLane` (the many faked sessions
   *      across the suite) ⇒ give_up, mirroring `fanOut`/`visualGate`'s
   *      absent-optional-dep style.
   *   3. ENRICH with the task's ref/title/CURRENT body via `readLaneTask` — the
   *      controller only holds opaque item ids, and the brain cannot judge an
   *      acceptance-criteria conflict it cannot see.
   *   4. Consult `monitor.triageLane`. It OWNS its own chat rendering (the
   *      failure announcement + the decision turn), so this method injects NO
   *      turn for the consult itself — a host turn here would double-render.
   *   5. `adjust_and_retry` ⇒ apply the body edit via `adjustRunTask`. A refusal
   *      (or a throw, or an unwired dep) DOWNGRADES to a plain rescue carrying
   *      the same guidance — never to a give_up, since the guidance still holds
   *      the substance. The downgrade IS injected as a chat turn: it is the one
   *      thing the brain cannot know, and its own decision turn is deliberately
   *      phrased as a decision rather than a completed act, so the downgrade note
   *      corrects the record without making the earlier turn a lie.
   *   6. File the audit finding for the rescue (fail-soft; a broken review queue
   *      must never cost the run a rescue). Nothing is filed for a give_up —
   *      that lane's failure already reaches the human at the run's gate.
   *
   * Fail-soft overall: `DefaultMonitorSession.triageLane` already never rejects,
   * so the try/catch is belt-and-braces — any escape still yields give_up, i.e.
   * exactly the behavior of a run without the seam.
   *
   * The ONE non-give_up failure arm is `{ kind: 'systemic' }`: a consult that
   * died on an environment-level condition (the brain's own SDK turn hit the
   * usage limit / a dead login) judged NOTHING, so settling the lane 'failed'
   * would blame a task for the environment — and, with a whole wave failing at
   * once, would convert one dead quota into a fan-out-wide cascade. The
   * controller parks on it instead.
   */
  async triageLaneFailure(req: LaneTriageFailure): Promise<LaneRescueOutcome> {
    if (laneTriageDisabled()) {
      this.args.logger?.info('[ProgrammaticRunHost] lane triage disabled by kill switch; letting the lane fail', {
        runId: this.args.runId,
        itemId: req.itemId,
        stepId: req.stepId,
      });
      return { kind: 'give_up' };
    }
    const monitor = this.args.monitor;
    if (!monitor?.triageLane) {
      this.args.logger?.info('[ProgrammaticRunHost] no lane-triage-capable monitor; letting the lane fail', {
        runId: this.args.runId,
        itemId: req.itemId,
        stepId: req.stepId,
      });
      return { kind: 'give_up' };
    }

    let facts: LaneTriageTaskFacts | undefined;
    try {
      facts = this.args.readLaneTask?.(req.itemId);
    } catch (err) {
      // A broken reader degrades the consult (empty body ⇒ no adjust), never
      // costs the lane its rescue.
      this.args.logger?.warn('[ProgrammaticRunHost] lane-triage task read failed (fail-soft)', {
        runId: this.args.runId,
        itemId: req.itemId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const taskRef = req.taskRef ?? facts?.taskRef ?? req.itemId;
    const previousBody = facts?.taskBody;

    try {
      const decision = await monitor.triageLane(
        {
          taskRef,
          itemId: req.itemId,
          stepId: req.stepId,
          attempt: req.attempt,
          failureKind: req.failureKind,
          errorExcerpt: req.errorExcerpt,
          innerStepIds: [...req.innerStepIds],
          taskTitle: facts?.taskTitle ?? '',
          taskBody: previousBody ?? '',
        },
        req.signal,
      );
      if (decision.verdict === 'give_up') {
        // The brain never judged anything — the consult itself died on an
        // environment-level condition. Surface it so the controller parks the
        // fan-out rather than settling this lane (and its siblings) 'failed'.
        if (decision.systemicError !== undefined) {
          this.args.logger?.warn('[ProgrammaticRunHost] lane triage died on a systemic condition; parking instead of failing the lane', {
            runId: this.args.runId,
            itemId: req.itemId,
            stepId: req.stepId,
            error: decision.systemicError,
          });
          return { kind: 'systemic', error: decision.systemicError };
        }
        return { kind: 'give_up' };
      }

      if (decision.verdict === 'append_correction') {
        // ADVISORY, NOT A RESCUE. The brain investigated, reached a diagnosis, and
        // judged that re-driving this lane would not act on it. Before this arm
        // that judgement had only one expressible form — a plain `give_up`, which
        // files NOTHING — so the diagnosis died with the consult. Record it, then
        // return the give-up outcome so the lane settles `failed` exactly as it
        // always did.
        //
        // COSTS NO RESCUE BUDGET: the controller RESERVES budget before the
        // consult and releases it on every arm whose outcome is not `rescue`
        // (see consultLaneTriage's releaseReservation) — this outcome is
        // `give_up`, so the reservation is released like any other non-rescue.
        await this.fileLaneCorrectionFinding({
          taskRef,
          req,
          reason: decision.reason,
          ...(decision.guidance !== undefined ? { guidance: decision.guidance } : {}),
        });
        return { kind: 'give_up' };
      }

      let adjusted = false;
      let downgradeReason: string | undefined;
      if (decision.verdict === 'adjust_and_retry') {
        if (!this.args.adjustRunTask) {
          downgradeReason = 'no task-adjust capability is wired on this run';
        } else {
          try {
            const result = await this.args.adjustRunTask({ taskRef, body: decision.taskBody });
            if (result.ok) adjusted = true;
            else downgradeReason = result.reason ?? 'the task edit was refused';
          } catch (err) {
            downgradeReason = err instanceof Error ? err.message : String(err);
          }
        }
        if (!adjusted) {
          this.args.logger?.warn('[ProgrammaticRunHost] lane-triage task adjust refused; downgrading to a plain rescue', {
            runId: this.args.runId,
            taskRef,
            reason: downgradeReason,
          });
          // The ONE thing the brain could not know — its decision turn said it
          // would adjust the body, so correct the record before the lane re-runs.
          this.injectMonitorTurn(
            `⚠ **${taskRef}**: the requirements adjustment could NOT be applied (${downgradeReason ?? 'unknown reason'}) — re-driving the lane with the guidance alone, task body unchanged.`,
          );
        }
      }

      await this.fileLaneRescueFinding({
        taskRef,
        req,
        targetStepId: decision.targetStepId,
        guidance: decision.guidance,
        reason: decision.reason,
        adjusted,
        ...(downgradeReason !== undefined ? { downgradeReason } : {}),
        ...(decision.verdict === 'adjust_and_retry' ? { proposedBody: decision.taskBody } : {}),
        ...(previousBody !== undefined ? { previousBody } : {}),
      });

      return { kind: 'rescue', targetStepId: decision.targetStepId, guidance: decision.guidance, adjusted };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Same reasoning as the tagged give_up above, for an escape the monitor's
      // own fail-soft did not catch.
      const systemic = isSystemicStepError(message);
      this.args.logger?.warn(
        systemic
          ? '[ProgrammaticRunHost] lane triage threw a systemic error; parking instead of failing the lane'
          : '[ProgrammaticRunHost] lane triage failed; letting the lane fail',
        {
          runId: this.args.runId,
          itemId: req.itemId,
          stepId: req.stepId,
          error: message,
        },
      );
      return systemic ? { kind: 'systemic', error: message } : { kind: 'give_up' };
    }
  }

  /**
   * REVIEW-LOOP seam — `triageLaneFailure`'s design-phase sibling. Consulted on
   * every blocking adversarial-review round for which automatic laps remain,
   * BEFORE the controller decides whether to take one. Resolves the executable
   * verdict only, so the controller never learns what a monitor or a finding is.
   *
   * Order of business, each arm short-circuiting to the pre-seam behaviour (the
   * controller's MECHANICAL revision budget):
   *   1. KILL SWITCH (`CYBOFLOW_DISABLE_REVIEW_LOOP_TRIAGE=1`) ⇒ undefined. No
   *      consult, no chat turn (a rollback lever should be silent) — just a log.
   *   2. No monitor, or a monitor with no `adviseReviewLoop` (the many faked
   *      sessions across the suite) ⇒ undefined.
   *   3. Consult `monitor.adviseReviewLoop`. It OWNS its chat rendering (the
   *      blocking announcement + the verdict turn), so this method injects NO
   *      turn of its own — a host turn here would double-render.
   *   4. RECORD, before returning: one audit finding for the consult, and one
   *      finding per SET-ASIDE entry. The set-asides are what make the verdict
   *      safe to execute unattended — an entry the supervisor drops from the lap
   *      must still reach the human — so they are filed on BOTH arms (a `stop`
   *      can set entries aside too), each fail-soft and awaited.
   *
   * Fail-soft overall: `DefaultMonitorSession.adviseReviewLoop` already never
   * rejects, so the try/catch is belt-and-braces. An ABORTED run also resolves
   * undefined — a canceled walk has no lap to take — and records NOTHING, which
   * is why the abort is re-checked between the consult and step 4.
   */
  async adviseReviewLoop(
    req: ReviewLoopRequest,
    ctx: ControllerStepContext,
  ): Promise<ReviewLoopDecision | undefined> {
    if (reviewLoopTriageDisabled()) {
      this.args.logger?.info('[ProgrammaticRunHost] review-loop triage disabled by kill switch; using the mechanical budget', {
        runId: this.args.runId,
        stepId: req.stepId,
        round: req.round,
      });
      return undefined;
    }
    const monitor = this.args.monitor;
    if (!monitor?.adviseReviewLoop) {
      this.args.logger?.info('[ProgrammaticRunHost] no review-loop-capable monitor; using the mechanical budget', {
        runId: this.args.runId,
        stepId: req.stepId,
        round: req.round,
      });
      return undefined;
    }
    try {
      const decision = await monitor.adviseReviewLoop(req, ctx.signal);
      if (decision === undefined) return undefined;
      // Canceled WHILE the consult was in flight: the controller discards the
      // verdict, so recording it would leave the queue asserting a lap that
      // never happened and set-aside entries nothing ever set aside.
      if (ctx.signal?.aborted === true) {
        this.args.logger?.info('[ProgrammaticRunHost] review-loop verdict discarded; the run was canceled mid-consult', {
          runId: this.args.runId,
          stepId: req.stepId,
          round: req.round,
        });
        return undefined;
      }
      await this.fileReviewLoopAudit(req, decision);
      const setAside = decision.verdict === 'loop' ? decision.steering.setAside : decision.setAside;
      await this.fileSetAsideFindings(req, setAside);
      return decision;
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] review-loop consult failed; using the mechanical budget', {
        runId: this.args.runId,
        stepId: req.stepId,
        round: req.round,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /**
   * File the NON-BLOCKING audit record for one review-loop consult.
   *
   * The decision is autonomous and unconfirmed — it spends design turns, or ends
   * the automatic loop early — so it needs the same paper trail a lane rescue
   * gets: the verdict, the rationale a human will weigh at the gate, and the
   * exact steering the re-run is about to be handed. Fail-soft: the decision is
   * already made, and losing its paper trail must not lose the decision.
   */
  private async fileReviewLoopAudit(req: ReviewLoopRequest, decision: ReviewLoopDecision): Promise<void> {
    if (!this.args.fileMonitorFinding) return;
    try {
      const setAside = decision.verdict === 'loop' ? decision.steering.setAside : decision.setAside;
      const lines = [
        `The run supervisor reviewed round ${req.round} of \`${req.stepId}\` (${req.parsed.blocking.length} blocking entr` +
          `${req.parsed.blocking.length === 1 ? 'y' : 'ies'}) and voted **${decision.verdict}**.`,
        '',
        `- Automatic revisions used: ${req.lapsUsed} of ${req.maxLaps}`,
        `- Rationale: ${decision.rationale}`,
      ];
      if (decision.verdict === 'loop') {
        lines.push(
          `- Re-running from \`${req.loopbackStepId}\`, addressing: ${decision.steering.address.join(', ')}`,
        );
        if (decision.steering.guidance !== undefined) {
          lines.push('', '## Guidance threaded into the re-run', '', decision.steering.guidance.trim());
        }
      } else {
        lines.push('- No further automatic revision — the surviving entries go to the human design gate.');
      }
      if (setAside.length > 0) {
        lines.push(
          '',
          '## Set aside for this round',
          '',
          ...setAside.map((entry) => `- ${entry.id}: ${entry.reason}`),
          '',
          'Each is filed as its own non-blocking finding — set aside for the lap, not dropped from the run.',
        );
      }
      await this.args.fileMonitorFinding({
        title: `Review loop — ${req.stepId} round ${req.round}: ${decision.verdict}`,
        body: lines.join('\n'),
        category: REVIEW_LOOP_FINDING_CATEGORY,
      });
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] review-loop audit finding not filed (fail-soft)', {
        runId: this.args.runId,
        stepId: req.stepId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * File one non-blocking finding per set-aside entry, NOW.
   *
   * "Set aside" is only defensible because of this call: the entry leaves the
   * lap the moment the supervisor says so, and the finding is the only thing
   * that keeps it in the run. Each entry is filed independently — one entry the
   * queue refuses must not cost the others their record — and the whole thing is
   * fail-soft, because the verdict is already decided.
   *
   * An id the supervisor named but the round's review does not carry is dropped
   * silently: `parseReviewLoopOutput` already validated against the round's
   * ids, so reaching here means the entry genuinely does not exist.
   */
  private async fileSetAsideFindings(
    req: ReviewLoopRequest,
    setAside: readonly { id: string; reason: string }[],
  ): Promise<void> {
    const sink = this.args.fileSetAsideFinding;
    if (!sink || setAside.length === 0) return;
    const byId = new Map<string, AdversarialFinding>();
    for (const entry of [...req.parsed.blocking, ...req.parsed.findings]) byId.set(entry.id, entry);
    for (const { id, reason } of setAside) {
      const entry = byId.get(id);
      if (entry === undefined) continue;
      try {
        await sink({ entry, reason, round: req.round });
      } catch (err) {
        this.args.logger?.warn('[ProgrammaticRunHost] set-aside finding not filed (fail-soft)', {
          runId: this.args.runId,
          stepId: req.stepId,
          arId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * File the NON-BLOCKING audit record for one autonomous lane rescue. Every
   * intervention is auditable at the run's human gate before anything merges,
   * which is what makes an unconfirmed body edit acceptable in the first place —
   * so the body carries the verdict, its reason, the guidance that will be
   * threaded into the re-run, and, for an adjust, BOTH the old and the proposed
   * body (a downgraded adjust says so explicitly, since the body on disk is
   * still the old one). Fail-soft: the rescue is already decided, and losing its
   * paper trail must not lose the rescue.
   */
  private async fileLaneRescueFinding(args: {
    taskRef: string;
    req: LaneTriageFailure;
    targetStepId: string;
    guidance: string;
    reason: string;
    adjusted: boolean;
    downgradeReason?: string;
    proposedBody?: string;
    previousBody?: string;
  }): Promise<void> {
    if (!this.args.fileLaneTriageFinding) return;
    try {
      const lines = [
        `The run supervisor rescued task **${args.taskRef}** after its lane exhausted an automatic budget.`,
        '',
        `- Failure: \`${args.req.failureKind}\` at step \`${args.req.stepId}\` (attempt ${args.req.attempt})`,
        `- Verdict: ${args.adjusted ? 'adjust_and_retry (task body REPLACED)' : 'retry'} — re-driving from \`${args.targetStepId}\``,
        `- Reason: ${args.reason.trim().length > 0 ? args.reason.trim() : '(none given)'}`,
        '',
        '## Guidance threaded into the re-run',
        '',
        args.guidance.trim(),
      ];
      if (args.proposedBody !== undefined) {
        if (!args.adjusted) {
          lines.push(
            '',
            '## Requirements adjustment NOT applied',
            '',
            `The supervisor asked to replace this task's body, but the edit was refused (${args.downgradeReason ?? 'unknown reason'}). The task body on disk is UNCHANGED; the lane was re-driven with the guidance above only. The proposed body is recorded below for review.`,
            '',
            '### Proposed (not applied) body',
            '',
            excerptBody(args.proposedBody),
          );
        } else {
          lines.push(
            '',
            '## Requirements adjustment APPLIED (autonomous — review this)',
            '',
            '### Previous body',
            '',
            excerptBody(args.previousBody),
            '',
            '### New body',
            '',
            excerptBody(args.proposedBody),
          );
        }
      }
      await this.args.fileLaneTriageFinding({
        title: `Monitor rescued ${args.taskRef} (${args.req.failureKind})`,
        body: lines.join('\n'),
      });
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] lane-triage finding failed (fail-soft)', {
        runId: this.args.runId,
        taskRef: args.taskRef,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * File the NON-BLOCKING ADVISORY record for an `append_correction` verdict —
   * a diagnosis the supervisor reached and deliberately did NOT act on.
   *
   * Routed through the SAME sink as a rescue finding (one channel for every
   * autonomous lane intervention, so the human reads them in one place), but the
   * body says plainly that nothing was re-driven and no budget was spent — the
   * rescue card's reader would otherwise assume this lane got another attempt.
   * Fail-soft for the same reason: losing the paper trail must not change the
   * lane's outcome.
   */
  private async fileLaneCorrectionFinding(args: {
    taskRef: string;
    req: LaneTriageFailure;
    reason: string;
    guidance?: string;
  }): Promise<void> {
    if (!this.args.fileLaneTriageFinding) return;
    try {
      const lines = [
        `The run supervisor diagnosed task **${args.taskRef}** after its lane exhausted an automatic budget, and recorded the diagnosis WITHOUT re-driving the lane.`,
        '',
        `- Failure: \`${args.req.failureKind}\` at step \`${args.req.stepId}\` (attempt ${args.req.attempt})`,
        '- Verdict: append_correction — **advisory (no rescue spent)**. The lane was NOT re-run and the task body was NOT changed; the lane settles failed and reaches you at the run\'s gate.',
        '',
        '## Diagnosis',
        '',
        args.reason.trim().length > 0 ? args.reason.trim() : '(none given)',
      ];
      if (args.guidance !== undefined && args.guidance.trim().length > 0) {
        lines.push('', '## Suggested correction', '', args.guidance.trim());
      }
      await this.args.fileLaneTriageFinding({
        title: `Monitor diagnosis for ${args.taskRef} (${args.req.failureKind}) — advisory`,
        body: lines.join('\n'),
      });
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] lane-correction finding failed (fail-soft)', {
        runId: this.args.runId,
        taskRef: args.taskRef,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Render a monitor turn into the run's Chat pane. Fail-soft — never abort the walk. */
  private injectMonitorTurn(text: string): void {
    if (!this.args.injectEvent) return;
    try {
      this.args.injectEvent(buildAssistantTextEvent(text));
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] monitor turn inject failed (fail-soft)', {
        runId: this.args.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Per-step result sink (migration 033). Fail-soft — recording must not abort the walk. */
  recordStepResult(report: StepReport): void {
    if (!this.args.recordStepResult) return;
    try {
      this.args.recordStepResult(this.args.runId, report);
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] recordStepResult failed (fail-soft)', {
        runId: this.args.runId,
        stepId: report.stepId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Fan-out lane driver (sprint-lane backed) — resolved LIVE on every read via the
   * injected provider (see `ProgrammaticRunHostArgs.fanOutDriverProvider`), not
   * captured once. `ControllerHost.fanOut` is optional so a provider-less host (or
   * one whose provider still returns undefined, e.g. batch_id not yet stamped) is
   * a valid "never fans out (yet)" host — the controller treats a `fanOut` step as
   * a normal single agent step until a driver becomes available.
   */
  get fanOut(): FanOutDriver | undefined {
    return this.args.fanOutDriverProvider?.();
  }

  /**
   * Visual merge-gate (programmatic actuation). Wired only for sprint-style runs;
   * `ControllerHost.visualGate` is optional so an absent gate (undefined) means the
   * controller never parks a lane at awaiting-verify (today's behavior).
   */
  get visualGate(): VisualVerifyGate | undefined {
    return this.args.visualGate;
  }

  /**
   * Agentless visual-verify enqueue capability (verification-agent redesign
   * §5.3/§5.4). Optional so an absent capability (undefined) means the controller
   * never enqueues a lane verification (the visual-verify step cleanly skips).
   */
  get enqueueVisualVerification(): ControllerHost['enqueueVisualVerification'] {
    return this.args.enqueueVisualVerification;
  }

  /**
   * File the NON-BLOCKING finding for a visual verification that never reached
   * the queue (F8 "never skip silently"): the task-verify channel produced no
   * result text, or the enqueue seam declined for a reason other than the
   * deliberate off switch. Neither seam writes a `verification_requests` row, so
   * without this the drop is invisible everywhere — the verify queue, the DB, and
   * the swimlane all read as "this lane needed no visual check".
   *
   * Fire-and-forget (the ControllerHost method returns void): the controller must
   * never await or be able to throw on reporting a skip. Both the async rejection
   * and a synchronous throw degrade to a warn log; lane advancement is untouched.
   *
   * `reason` is UNTRUSTED TEXT and is fenced + capped before it enters the body
   * (review round 2). On the enqueue-decline path it is `prepared.error`, which for
   * a §7.2 forbidden-command rejection quotes every offending command out of the
   * AGENT'S OWN composed task fence verbatim — multi-line, and free to contain
   * markdown headings or its own fences. Interpolating that raw let a composed
   * command restyle or spoof a review-queue card. Same treatment verdictDelivery
   * already gives subprocess text (its build/launch log excerpt).
   */
  reportVerificationSkipped(input: { runId: string; laneTaskRef: string; reason: string; detail?: string }): void {
    const sink = this.args.fileVerificationSkipFinding;
    if (!sink) return;
    const body = [
      `Visual verification did not run for lane \`${input.laneTaskRef}\` in run \`${input.runId}\`, and no verification request was created — so this skip appears nowhere else (no request row, no verdict, no screenshots artifact).`,
      'Reason:',
      '```',
      fenceSafeReason(input.reason),
      '```',
      ...(input.detail !== undefined ? [input.detail] : []),
    ].join('\n\n');
    try {
      void sink({
        title: `Visual verification did not run for ${input.laneTaskRef}`,
        body,
      }).catch((err: unknown) => {
        this.args.logger?.warn('[ProgrammaticRunHost] verification-skip finding failed (fail-soft)', {
          runId: input.runId,
          laneTaskRef: input.laneTaskRef,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] verification-skip finding threw (fail-soft)', {
        runId: input.runId,
        laneTaskRef: input.laneTaskRef,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * RUN-LEVEL verification posture (CD1). Resolved ONCE by the controller at
   * fan-out start; this is a straight delegation to the injected resolver, which
   * already never rejects. An absent resolver means the controller keeps its
   * pre-seam behaviour ('available').
   */
  async resolveVerificationPosture(): Promise<VerificationPosture> {
    if (!this.args.resolveVerificationPosture) return { kind: 'available' };
    try {
      return await this.args.resolveVerificationPosture();
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] verification-posture resolve failed (fail-soft)', {
        runId: this.args.runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { kind: 'available' };
    }
  }

  /**
   * The ONE "nothing here can be verified" card for the whole run — the
   * run-scoped sibling of {@link reportVerificationSkipped}, which the controller
   * suppresses for every lane once this has fired.
   *
   * `source` is run-scoped (`verification-posture:<runId>`), so
   * `createIfNoPending` collapses a repeat from a second fan-out step or a
   * crash-resume into the existing card. Fire-and-forget, like every other
   * finding this host files.
   */
  reportNoVerifiableModality(input: { runId: string; reason: string }): void {
    const sink = this.args.fileRunScopedFinding;
    if (!sink) return;
    const body = [
      `No verification modality can serve run \`${input.runId}\`, so NO lane of this run enqueues a visual verification and no verification request rows exist for it.`,
      'Reason:',
      '```',
      fenceSafeReason(input.reason),
      '```',
      'This is declared ONCE for the run rather than once per lane. The lanes themselves are unaffected — they implement, review and verify their acceptance criteria as usual, and the sprint proceeds; only the VISUAL check is absent. To restore it, fix the reason above (run verification setup, merge the branch carrying the runbook, or re-prove a drifted one) and re-run verification for the deliverables you care about.',
    ].join('\n\n');
    try {
      void sink({
        source: `verification-posture:${input.runId}`,
        title: `No verifiable modality for this project: ${input.reason}`,
        body,
      }).catch((err: unknown) => {
        this.args.logger?.warn('[ProgrammaticRunHost] no-modality finding failed (fail-soft)', {
          runId: input.runId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] no-modality finding threw (fail-soft)', {
        runId: input.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * SHARED BUILD-BREAK sweep (CD3). Synchronous underneath (one indexed read of
   * `review_items`); wrapped in a promise because the controller's seam is async
   * and a future sweep may not be. Fail-soft → no groups.
   */
  async sweepBuildBreaks(): Promise<BuildBreakGroup[]> {
    if (!this.args.sweepBuildBreaks) return [];
    try {
      return this.args.sweepBuildBreaks();
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] build-break sweep failed (fail-soft)', {
        runId: this.args.runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Announce ONE shared build break. DETECTOR ONLY: this is an advisory card, not
   * a pause and not a fix — the lanes that reported the break have already dealt
   * with it however they could, and the card exists so a human reading N lane
   * findings sees the one fact behind them.
   *
   * Deduped on a source derived from the group's NORMALIZED text, so the sweep
   * can run at every quiesced instant without re-filing.
   */
  reportBuildBreakGroup(input: { runId: string; group: BuildBreakGroup }): void {
    const sink = this.args.fileRunScopedFinding;
    if (!sink) return;
    const { group } = input;
    const body = [
      `${group.count} build-break report(s) filed by this run's lanes normalize to the SAME error, which means the tree — not any single task — is what broke.`,
      'First reported as:',
      '```',
      fenceSafeReason(group.sampleTitle),
      '```',
      group.laneRefs.length > 0
        ? `Lanes that linked a task: ${group.laneRefs.map((ref) => `\`${ref}\``).join(', ')}.`
        : 'None of the reports carried a task link, so the individual lanes are not recoverable from the rows — open the findings below to see which steps filed them.',
      `Original findings: ${group.itemIds.map((id) => `\`${id}\``).join(', ')}.`,
      'This is an ADVISORY detection only: the run was not paused and nothing was fixed automatically. Fix the break at its source and the individual lane reports become resolvable together.',
    ].join('\n\n');
    try {
      void sink({
        source: `build-break-group:${input.runId}:${buildBreakGroupKey(group.normalized)}`,
        title: `Shared build break (${group.count} lanes): ${group.sampleTitle}`,
        body,
      }).catch((err: unknown) => {
        this.args.logger?.warn('[ProgrammaticRunHost] build-break-group finding failed (fail-soft)', {
          runId: input.runId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] build-break-group finding threw (fail-soft)', {
        runId: input.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log(level: 'info' | 'warn' | 'error', message: string): void {
    if (level === 'error') this.args.logger?.error(message);
    else if (level === 'warn') this.args.logger?.warn(message);
    else this.args.logger?.info(message);
  }
}
