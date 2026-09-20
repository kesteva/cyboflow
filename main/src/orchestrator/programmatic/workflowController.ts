/**
 * WorkflowController — the host-side, deterministic DAG walker for the
 * `programmatic` execution model (Stage 1; see
 * docs/proposals/sdk-program-driven-workflows.md).
 *
 * This is the "code walks the DAG" engine. Given a `WorkflowDefinition` (the SAME
 * shared DAG the orchestrated model feeds to an agent), it sequences phases and
 * steps IN ORDER and owns every control-flow decision the orchestrated prose
 * otherwise asks the model to make:
 *
 *   - report each step boundary (running → done) to the live timeline,
 *   - run each non-human step's agent via the injected `StepRunner`,
 *   - honor the per-step `retries` budget (in-place re-attempts),
 *   - honor intra-phase `loopback` on exhaustion (bounded by MAX_STEP_LOOPBACKS),
 *   - skip `optional` steps that fail, escalate required steps that fail,
 *   - resolve human gates via the injected `ControllerHost.requestHumanGate`
 *     (approve advances, reject ends the run, revise loops back / re-presents).
 *
 * The controller is PURE with respect to its injected collaborators (StepRunner +
 * ControllerHost) — it performs no DB / IPC / SDK work itself — so it is
 * exhaustively unit-testable with fakes. The unverifiable live-SDK work lives
 * entirely behind `StepRunner`.
 *
 * Standalone-typecheck invariant: shared types + sibling protocol types only.
 */
import type { WorkflowDefinition, WorkflowStep } from '../../../../shared/types/workflows';
import { effectiveMaxConcurrency } from '../../../../shared/types/workflows';
import { HUMAN_GATE_AGENT } from '../../../../shared/types/agentIdentity';
import {
  AWAITING_VERIFY_STEP,
  SPRINT_CODE_REVIEW_STEP,
  SPRINT_IMPLEMENT_STEP,
  SPRINT_TASK_VERIFY_STEP,
  SPRINT_VISUAL_VERIFY_STEP,
} from '../../../../shared/types/sprintBatch';
import type { VerificationTaskV1 } from '../../../../shared/types/visualVerification';
// Pure, shared-type-backed parser (no electron/DB/service deps) — importing it
// keeps the controller unit-testable with no new mocks, honoring the spirit of
// the standalone-typecheck invariant (heavy imports only).
import { parseVisualTaskSection } from '../verify/visualTaskSection';
// Pure text predicate over an enqueue-seam decline reason (no DB/electron deps) —
// see isNoModalityDeclineReason for why this is a text match and not an import
// of the strings themselves.
import { isNoModalityDeclineReason } from '../verify/verificationPosture';
import type {
  BuildBreakGroup,
  CommitIntegrityProbe,
  ControllerHost,
  ControllerResult,
  ControllerStepContext,
  HumanGateDecision,
  LaneFailureKind,
  LaneRescueOutcome,
  StepReport,
  StepRunner,
  SupervisorEvent,
  VerificationPosture,
  VisualGateOutcome,
} from './types';
import { FAN_OUT_LANE_ATTEMPT_CAP } from './types';
import { createRunDirectives, type RunDirectives } from './runDirectives';

/**
 * Parse a task-verify agent's captured result text for its terminal verdict —
 * the LAST line matching `VERDICT: PASS|FAIL` (verification-agent redesign §5.3).
 * Returns null when no such line exists (the caller treats that as PASS for flow
 * purposes but still enforces the §5.1 output contract). Line-oriented, not
 * fence-aware: a `VERDICT:` line inside a code fence is vanishingly unlikely in a
 * verdict result and the LAST-match rule already tolerates incidental mentions.
 */
function parseTaskVerifyVerdict(text: string): 'pass' | 'fail' | null {
  const re = /^VERDICT:\s*(PASS|FAIL)\b/;
  let verdict: 'pass' | 'fail' | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m) verdict = m[1] === 'PASS' ? 'pass' : 'fail';
  }
  return verdict;
}

/**
 * Parse the code-review verdict line off a subagent's captured result text — the
 * programmatic-plane analogue of `parseTaskVerifyVerdict`. The code-review agent
 * emits `REVIEW: BLOCKING` when it populated a `## Blocking` section, else
 * `REVIEW: CLEAN`. LAST-match wins (same rule as the verdict parser), tolerating
 * an incidental earlier mention. Returns null when no such line exists; the caller
 * treats null as CLEAN for flow purposes (a subagent that never emitted the line —
 * e.g. a substrate that cannot capture final text — must not wedge the lane).
 */
function parseCodeReviewVerdict(text: string): 'blocking' | 'clean' | null {
  const re = /^REVIEW:\s*(BLOCKING|CLEAN)\b/;
  let verdict: 'blocking' | 'clean' | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m) verdict = m[1] === 'BLOCKING' ? 'blocking' : 'clean';
  }
  return verdict;
}

/**
 * Extract the `## Blocking` section body from a code-review result so it can be
 * threaded into the re-driven `implement` step as loopback feedback (the same
 * one-shot channel task-verify's `## Fix guidance` uses). Returns the text between
 * the `## Blocking` heading and the next `## ` heading (or EOF), trimmed; null when
 * no such section exists. Fail-soft: a BLOCKING verdict with no parseable section
 * still loops back (the implementer gets the whole result text as context via the
 * lane), so this only enriches the feedback, never gates it.
 */
function extractBlockingSection(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Blocking\b/i.test(l));
  if (start < 0) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break; // next section heading ends the block
    if (/^REVIEW:\s*(BLOCKING|CLEAN)\b/.test(lines[i])) break; // machine verdict trailer — not defect text
    body.push(lines[i]);
  }
  const joined = body.join('\n').trim();
  return joined.length > 0 ? joined : null;
}

/**
 * Whether a `## Blocking` section carries actual entries. The adversarial-review
 * doc keeps the heading with `None.` under it when the reviewer found nothing (so
 * the human can SEE it looked), which `extractBlockingSection` returns as a
 * non-null body — treating that as blocking would loop the design phase on a
 * clean review. An entry is a `#### AR-n` heading; failing that, any body that is
 * not the literal `None.` placeholder counts (a reviewer that dropped the heading
 * shape still wrote a defect).
 */
function blockingSectionHasEntries(text: string): boolean {
  const body = extractBlockingSection(text);
  if (body === null) return false;
  if (/^####\s+AR-\d+/m.test(body)) return true;
  return !/^none\.?$/i.test(body.trim());
}

/**
 * Maximum number of AUTOMATIC design revisions an adversarial-review step may
 * trigger per run: a `REVIEW: BLOCKING` result loops the refine phase back to the
 * step's declared `loopback` target this many times, each re-run threaded with the
 * review's `## Blocking` entries; the next BLOCKING verdict falls through to the
 * human design gate, which presents the surviving entries. One round is the
 * deliberate bound — the reviewer is a critic, not the arbiter of the design, and
 * a second disagreement is the human's call, not another automated lap through
 * prototype + architecture.
 */
export const MAX_REVIEW_AUTO_REVISIONS = 1;

/**
 * Maximum number of intra-phase loopback JUMPS allowed per step id across a whole
 * run, bounding both agent-step loopbacks and human-gate revises so a flapping
 * step or an indecisive reviewer can never spin forever. Distinct from a step's
 * in-place `retries` budget (which re-attempts the SAME step without jumping).
 */
export const MAX_STEP_LOOPBACKS = 5;

/**
 * Maximum number of SYSTEMIC park-and-retry cycles allowed per step id across a
 * whole run. A systemic failure (usage/session/rate limit, provider overload,
 * auth) parks the run via `ControllerHost.awaitSystemicPause` and re-runs the
 * step WITHOUT consuming its retry/optional/loopback/triage budget — so unlike
 * those budgets this is NOT a normal failure allowance. Each cycle already
 * requires a human resolution OR a limit-reset timer to un-park, so this bound is
 * only a runaway backstop against a pathological condition that never clears (or
 * a host that resolves the pause instantly in a loop): once exhausted, the
 * systemic failure falls through to the normal failure path.
 */
export const MAX_SYSTEMIC_PAUSES = 10;

/**
 * Safety bound on visual merge-gate loopbacks per lane (re-implement → re-verify).
 * The merge-gate's own 3× cap (MERGE_GATE_ATTEMPT_CAP) marks the lane FAILED first,
 * so this is purely a backstop against a semantics drift that never returns 'failed'
 * — a flapping verdict can never spin a lane forever.
 */
export const MAX_VISUAL_LOOPBACKS = 5;

/**
 * How many times ONE lane may be rescued by the monitor's autonomous lane triage
 * (`ControllerHost.triageLaneFailure`) across a whole walk. ONE: a rescue buys the
 * lane a fresh traversal from an earlier inner step with fresh guidance — if that
 * traversal fails too, the supervisor's read of the problem was wrong and a second
 * round of the same reasoning is not going to find a different answer. The lane
 * then settles 'failed' and reaches the human at the run's gate, which is the
 * outcome that always existed.
 */
export const MONITOR_LANE_RESCUE_CAP = 1;

/**
 * How many lane rescues the monitor may spend across a WHOLE walk, however many
 * lanes fail. Bounds the blast radius of a supervisor that has misdiagnosed
 * something run-wide (a broken toolchain, a bad merge base) into rescuing every
 * lane in turn: past this, failures settle as they always did rather than
 * multiplying agent turns against a cause no per-lane guidance can fix.
 */
export const MONITOR_RUN_RESCUE_CAP = 4;

/**
 * How many lanes of ONE wave must fail with the SAME error text before the
 * fan-out treats that error as ENVIRONMENTAL rather than as each lane's own
 * defect, and parks instead of failing them.
 *
 * The classifier (`isSystemicStepError`) can only recognise shapes someone has
 * already seen; corroboration recognises the shape of the EVIDENCE. Three
 * independent lanes — different tasks, different files, different agents —
 * producing byte-identical failure text is not three coincidental task defects,
 * whatever the text says. Three is the smallest count that is not a coincidence:
 * two lanes routinely fail on the same missing dependency or the same broken
 * base commit, which IS a real defect the run should surface.
 *
 * Comparison is EXACT (trimmed) text, deliberately not `digestErrorSkeleton` —
 * that digest strips quoted content, paths and numbers for human-reviewed
 * telemetry grouping and would happily fuse three genuinely different
 * `Cannot find module "<x>"` failures into one park.
 */
export const SAME_ERROR_CORROBORATION_MIN = 3;

/**
 * Wall-clock ceiling on how long ONE lane's 'failed' write may be HELD waiting
 * for a sibling to corroborate it (2 minutes).
 *
 * The wave loop got its corroboration window for free: a wave ended, everything
 * settled, and the hold was bounded by the wave's slowest lane. A rolling pool
 * has no such boundary — a 40-minute lane in the last slot would hold three
 * minute-one failures open for 40 minutes, during which the lane rows read
 * 'running' on the board, the partial-sprint gate summary misses them, and a
 * crash-resume re-dispatches a lane that already failed.
 *
 * So a hold ends at whichever comes FIRST: its cohort drains (nobody is left who
 * could still corroborate it), SAME_ERROR_CORROBORATION_MIN is reached, or this
 * ceiling elapses. The same ceiling ages out remembered SYSTEMIC texts, so a
 * park that never opens cannot leave a minute-one quota error corroborating a
 * minute-fifty review failure.
 *
 * Two minutes is long enough to cover the spread between lanes that fail on one
 * shared environment condition (they fail within seconds of each other) and far
 * short of the time any real lane takes.
 */
export const SAME_ERROR_COHORT_MAX_MS = 120_000;

/**
 * What one lane's walk ended as. Carries the failure text on the OUTCOME (never
 * in state that outlives the wave) so the wave-settle corroboration pass can
 * compare this wave's failures against each other and nothing else.
 *
 * `persisted` says whether the lane row was ALREADY written 'failed' by the arm
 * that produced the outcome. The generic inner-step arm DEFERS its write
 * (`persisted: false`) so a corroborated environment failure is never observably
 * stamped onto a lane that did nothing wrong; every other failing arm has
 * already written (either itself or, at the merge gate, via the gate driver) and
 * is therefore not a corroboration candidate.
 */
type LaneWalkOutcome =
  | { kind: 'done' }
  | { kind: 'aborted' }
  | { kind: 'systemic'; error?: string }
  | { kind: 'failed'; error?: string; persisted: boolean };

/**
 * Walk-scoped bookkeeping for autonomous lane rescue. Created once per `run()`
 * and threaded into every `runFanOut`, so the caps span the whole walk (a run
 * with two fan-out steps cannot spend the run budget twice) and a lane's rescue
 * guidance survives across the inner-chain jumps of that lane.
 */
interface LaneRescueState {
  /** itemId → rescues spent (capped by MONITOR_LANE_RESCUE_CAP). */
  perItem: Map<string, number>;
  /** Rescues spent across the walk (capped by MONITOR_RUN_RESCUE_CAP). */
  runTotal: number;
  /**
   * itemId → the guidance a rescue attached to that lane. STICKY for the life of
   * the lane: the controller threads it into EVERY subsequent inner-step spawn
   * (via `ControllerStepContext.laneGuidance`) until the lane settles, because
   * the guidance describes what the whole re-run must do differently. Keyed by
   * ITEM, never by step id — `RunDirectives.stepGuidance` is keyed by bare step
   * id and shared across lanes, so writing lane guidance there would leak one
   * task's rescue into every sibling lane's next spawn of that step.
   */
  guidance: Map<string, string>;
}

/**
 * A step is a PURE human gate (no agent work) when its agent is the dedicated
 * human-gate agent. A step that names a REAL agent AND also sets `human === true`
 * (e.g. the planner's `context` step) is an AGENT step WITH a trailing human
 * checkpoint, NOT a pure gate — the controller runs its agent first, then opens
 * the gate (see `run`). Keying the pure-gate test on the agent identity (not on
 * `human === true`) is the fix for the prior bug where such agent+gate steps had
 * their agent work silently skipped.
 */
function isPureHumanGate(step: WorkflowStep): boolean {
  return step.agent === HUMAN_GATE_AGENT;
}

/**
 * The enqueue-decline reason F8 does NOT file a finding for, because in its
 * intended case it is a deliberate operator choice rather than a surprise — the
 * run has verification switched off. Filing for it would put a finding on every
 * lane of every verify-disabled run.
 *
 * KNOWN OVER-BREADTH (review round 2, not fixable from here): verify/
 * enqueueFromTask.ts returns this same literal from three places — the genuine
 * off switch (disabled / unstamped run) AND two anomalies: no `workflow_runs` row
 * for the runId, and the run-stamp SELECT throwing. The two anomalies are
 * precisely the kind of surprise F8 exists to surface, and this guard swallows
 * them; the controller cannot tell them apart because the outcome carries only
 * the string. The fix is to give those paths their own reasons in
 * enqueueFromTask.ts (that file is owned by another area of this change set) —
 * this guard then narrows to the deliberate case with no edit here.
 *
 * Duplicated as a literal (not imported) on purpose: the controller is
 * deliberately DB/electron-free, and importing it from enqueueFromTask.ts would
 * pull that module's DB-shaped dependencies into the controller's import graph.
 * If that string is ever renamed there, rename it here too — the cost of a drift
 * is one extra finding per verify-disabled lane, never a wedged run.
 */
const VERIFY_DISABLED_ENQUEUE_REASON = 'verification-disabled';

/** Whether a (non-pure-gate) agent step also carries a trailing human checkpoint. */
function hasTrailingGate(step: WorkflowStep): boolean {
  return step.human === true && step.agent !== HUMAN_GATE_AGENT;
}

export class WorkflowController {
  constructor(
    private readonly runner: StepRunner,
    private readonly host: ControllerHost,
  ) {}

  /**
   * Live operator steering for THIS run (skip / steer), read MID-WALK — unlike
   * the constructor-frozen resumeFromStepId/completedStepIds. Set at the top of
   * `run()`; defaults to an empty (no-op) set so every existing caller/test that
   * passes no directives is byte-identical. Read at the loop head (skip), inside
   * the fan-out inner loop (inner-step skip), and by the SpawnStepRunner
   * `stepGuidance` thunk the runner threads (steer).
   */
  private directives: RunDirectives = createRunDirectives();

  /**
   * `${runId}:${laneTaskRef}` keys already reported through
   * {@link reportVerificationSkipped}, so ONE lane files at most ONE
   * "visual verification never reached the queue" finding per run.
   *
   * Both F8 seams sit inside the fan-out INNER-STEP walk, which a lane re-enters
   * on every loopback (code-review blocking defect, task-verify VERDICT: FAIL,
   * step failure) up to FAN_OUT_LANE_ATTEMPT_CAP. On a substrate that never
   * captures step text the channel-unavailable branch therefore fires on EVERY
   * attempt of EVERY lane — an 8-lane sprint looping twice would post 24
   * byte-identical review-queue cards. The spec asks for "a NON-blocking finding"
   * (singular), and unlike verdictDelivery's findings these carry no requestId to
   * correlate or supersede on (there is no request row — that is the whole point),
   * so de-duplication has to happen here, at the source.
   *
   * Instance-scoped and never cleared: one controller instance walks one run.
   */
  private readonly reportedVerificationSkips = new Set<string>();

  /**
   * runId → the RUN-LEVEL verification posture, resolved ONCE at fan-out start
   * (see `ControllerHost.resolveVerificationPosture`). A Map rather than a plain
   * field because a walk can enter more than one fan-out step, and because it
   * keys the same way `reportedVerificationSkips` does.
   *
   * ABSENT means "not resolved yet", which every read treats as 'available' —
   * i.e. exactly the behaviour of a controller without this seam.
   */
  private readonly verificationPostures = new Map<string, VerificationPosture>();

  /** runIds whose single "no verifiable modality" finding has already been filed. */
  private readonly reportedNoModality = new Set<string>();

  /**
   * `${runId}:${normalizedText}` keys whose shared-build-break group has already
   * been announced. The sweep runs at every quiesced instant AND at fan-out end,
   * and a group only grows, so without this the same group would file a card per
   * sweep.
   */
  private readonly reportedBuildBreakGroups = new Set<string>();

  /**
   * Walk `def` to a terminal result. Resolves with the outcome + the ordered
   * execution trace; it never throws for a normal step failure (that is a
   * 'failed'/'rejected'/'canceled' outcome), only for an internal invariant
   * breach (the safety bound below) which indicates a controller bug.
   *
   * `signal` (optional) cancels the walk: it is checked at the top of every step
   * iteration and threaded into each runStep + human gate, so a canceled run
   * stops promptly with a 'canceled' outcome instead of completing or retrying.
   *
   * `resumeFromStepId` (optional, crash-safe resume) FAST-FORWARDS the walk to the
   * step with that id: all phases/steps BEFORE it are skipped (they already ran
   * before the restart — their effects are in git/the DB), and the walk resumes AT
   * that step (re-running it, which is safe: an interrupted agent step re-runs and
   * a gate re-attaches to its still-pending review item). An unknown id (e.g. the
   * workflow was edited) falls back to starting from the beginning.
   *
   * `directives` (optional) is the LIVE operator-steering object the host mutates
   * mid-walk (skip / un-skip / steer a not-yet-run step). It is read by reference
   * at the loop head and threaded to the runner's `stepGuidance` thunk, so a
   * change lands on the next step turn. Defaults to an empty (no-op) set so every
   * existing caller is unchanged.
   */
  async run(
    runId: string,
    def: WorkflowDefinition,
    signal?: AbortSignal,
    resumeFromStepId?: string,
    completedStepIds?: ReadonlySet<string>,
    directives: RunDirectives = createRunDirectives(),
  ): Promise<ControllerResult> {
    this.directives = directives;
    const steps: StepReport[] = [];
    // Per-step-id loopback counters, shared across the whole run so a target that
    // is revisited from multiple failing steps still terminates. Gate-revise
    // re-presentations consume this SAME budget (even when the gate has no jump
    // target) so an indecisive reviewer can never spin forever.
    const loopbacks = new Map<string, number>();
    // Per-step-id triage-retry counters (Stage 3) — bounds 'retry' triage verdicts
    // and escalation-gate 'revise' re-runs so a flapping step can never spin.
    const triageRetries = new Map<string, number>();
    // Per-step-id systemic park-and-retry counters — bounds how many times a step
    // (or a fan-out outer step) may park on a systemic condition and re-run without
    // consuming its retry/optional/loopback/triage budget. Capped at
    // MAX_SYSTEMIC_PAUSES; the SAME map keys both the single-step retry loop and the
    // fan-out wave-park path (a fanOut outer step keys on its own step.id).
    const systemicPauses = new Map<string, number>();
    // Per-step-id STICKY giveup latch. Once the human GAVE UP on a systemic pause
    // for a step (verdict 'giveup'), that decision is final for the rest of the run:
    // subsequent systemic re-failures of the SAME step (another in-place attempt, or
    // a later fan-out wave on the same outer step) must NOT re-park and mint a fresh
    // blocking pause item — that would force the human to dismiss once per remaining
    // attempt, contradicting the pause item's "Dismiss to stop waiting — the step
    // then fails normally" contract. The SAME set keys both the single-step retry
    // loop and the fan-out wave-park path (keyed on the outer step id).
    const systemicGiveUps = new Set<string>();
    // Walk-scoped autonomous LANE-RESCUE state (per-item + per-run caps, plus the
    // sticky per-lane rescue guidance). Created here rather than per fan-out step
    // so both caps bound the WHOLE walk, and threaded into runFanOut by reference.
    const laneRescues: LaneRescueState = { perItem: new Map(), runTotal: 0, guidance: new Map() };
    // The human's most recent gate 'revise', threaded into every step the gate's
    // loopback re-drives. Walk-scoped and STICKY: set when applyGateDecision takes
    // a revise WITH a jump target, carried on every baseCtx from that target
    // forward, and cleared the moment the walk reaches the gate again (the gate
    // having re-opened, the revision has been answered). The fan-out path never
    // reads it — lanes carry their own per-lane channels.
    let pendingGateRevision:
      | { gateStepId: string; note?: string; source?: 'adversarial-review'; round?: number }
      | undefined;
    // Per-step-id count of AUTOMATIC adversarial-review revisions taken this walk
    // (bounded by MAX_REVIEW_AUTO_REVISIONS). Separate from `loopbacks` so the
    // one automatic lap never eats into the human gate's own revise budget.
    const reviewAutoRevisions = new Map<string, number>();
    // Per-step-id count of COMPLETED adversarial-review results this walk — the
    // review ROUND number, and the only source of it. Deliberately NOT
    // `reviewAutoRevisions`: that one counts only the automatic laps and stops at
    // its cap, while a round is any completed review, clean or blocking, reached
    // by a lap OR by a human's Revise. The re-run prompt quotes it so the reviewer
    // knows which round it is writing and which ids are already spent. Walk state,
    // like every other map here: a restart or a rewind resets it, and nothing
    // persists it (the DB's revision count is a different, unreliable quantity).
    const reviewRounds = new Map<string, number>();
    // Crash-resume skip set, copied into a MUTABLE local. It only fast-forwards PAST
    // work completed BEFORE the restart; the instant the walk deliberately REVISITS a
    // region (a loopback jump or a gate revise), that region's pre-restart history no
    // longer exempts it, so `clearCompletedFrom` PURGES the revisited steps. Without
    // this a loopback landing on a still-marked step would be skipped (the jump burns
    // budget as a no-op), and pausing mid-revise then resuming would silently bypass
    // the revisit steps INCLUDING the human gate itself.
    /**
     * The most recent AGENT step's identity + captured final text, handed to the
     * next step that declares `consumesPriorStepOutput`. Run-scoped and updated
     * only by agent steps, so a human gate between producer and consumer is
     * transparent — which is what Compound's extract → approve-learnings →
     * write-back chain needs.
     *
     * `text` stays undefined when a turn produced nothing capturable; the entry
     * is still recorded so the consumer's prompt can say the channel failed
     * rather than implying the step had nothing to report.
     */
    let priorAgentOutput: { stepId: string; name: string; text?: string } | undefined;
    const remainingCompleted = new Set<string>(completedStepIds ?? []);
    // Closing-stage gate (2026-06-22): set true when a fan-out step settles with
    // one or more incomplete/failed lanes (the sprint has blocked tasks). While
    // set, the walk skips every subsequent AUTOMATED step (e.g. sprint-verify,
    // code-review) and advances straight to the next human gate, which surfaces the
    // partial sprint — running the closing stages over an incomplete sprint is
    // wasteful and misleading. Cleared when a human-gated step is reached.
    let skipToHumanGate = false;

    // Resume target: skip every phase/step before resumeFromStepId.
    let resumePhaseIdx = -1;
    let resumeStepIdx = -1;
    if (resumeFromStepId !== undefined && resumeFromStepId.length > 0) {
      for (let p = 0; p < def.phases.length; p++) {
        const s = def.phases[p].steps.findIndex((st) => st.id === resumeFromStepId);
        if (s >= 0) {
          resumePhaseIdx = p;
          resumeStepIdx = s;
          break;
        }
      }
      if (resumePhaseIdx < 0) {
        this.host.log?.('warn', `resume step '${resumeFromStepId}' not in definition; starting from the beginning`);
      } else {
        this.host.log?.('info', `resuming run at step '${resumeFromStepId}'`);
      }
    }

    this.emit({ kind: 'run-started', runId });

    for (let phaseIdx = 0; phaseIdx < def.phases.length; phaseIdx++) {
      const phase = def.phases[phaseIdx];
      // Skip phases entirely before the resume phase (already executed pre-restart).
      if (resumePhaseIdx >= 0 && phaseIdx < resumePhaseIdx) continue;
      const n = phase.steps.length;
      // Defensive termination bound on step VISITS within this phase (one per
      // while-iteration; in-place retries live INSIDE an iteration and do not
      // count). Each step id has TWO independent non-advancing budgets, both
      // capped at MAX_STEP_LOOPBACKS: `loopbacks` (loopback jumps + pure/agent-gate
      // revises) and `triageRetries` (Stage 3 triage 'retry' + escalate-gate
      // 'revise'). So a step can be re-visited up to 2*MAX_STEP_LOOPBACKS times,
      // and each re-visit can re-walk up to n steps before the next ⇒
      // ≤ (2*MAX_STEP_LOOPBACKS*n + 1)*n visits. The bound MUST include BOTH
      // budgets or a step that both loops back AND triage-retries trips this
      // defensive throw falsely. Exceeding it means a real logic bug — fail loud.
      // Systemic park-and-retry cycles (awaitSystemicPause → 'retry') do NOT affect
      // this bound: like an in-place retry they live INSIDE one while-iteration and
      // never advance `i`, so no additional headroom is needed here.
      const maxExecutions = (2 * MAX_STEP_LOOPBACKS * n + 1) * n + n + 1;
      let executions = 0;

      // Resume: start at the resume step index in the resume phase, else 0.
      let i = resumePhaseIdx >= 0 && phaseIdx === resumePhaseIdx ? resumeStepIdx : 0;
      while (i < n) {
        if (signal?.aborted) {
          return this.finish({ outcome: 'canceled', steps, failedStepId: phase.steps[i]?.id }, runId);
        }
        if (++executions > maxExecutions) {
          // Emit the terminal monitor event before the loud throw so the
          // supervisor feed stays consistent on EVERY terminal path.
          this.emit({ kind: 'run-finished', runId, outcome: 'failed', stepId: phase.steps[i]?.id });
          throw new Error(
            `WorkflowController: phase '${phase.id}' exceeded the execution bound (${maxExecutions}) — possible loopback cycle`,
          );
        }

        const step = phase.steps[i];

        // Crash-safe resume: a step that INDIVIDUALLY completed before a restart
        // (persisted done/skipped) is skipped without re-running or re-reporting.
        // `remainingCompleted` is purged the moment the walk revisits a region, so a
        // deliberate loopback/revise into pre-restart work re-runs it (see below).
        if (remainingCompleted.has(step.id)) {
          i += 1;
          continue;
        }

        // Operator SKIP (RunDirectives — live mid-walk steering). The monitor
        // asked to skip this not-yet-run step; consulted HERE at the loop head so
        // a step the operator UN-skipped before the walk reached it still runs
        // normally. A REQUIRED step skipped by the operator does NOT fail the run
        // — the operator explicitly chose to skip it, so advance exactly like the
        // optional-skip path. NOTE: this also skips a PURE human-gate step if its
        // id was targeted — the gate then never opens (acceptable for v1: the
        // operator asked to skip it; we do not special-case gates).
        if (this.directives.userSkippedStepIds.has(step.id)) {
          this.pushStep(steps, {
            stepId: step.id,
            phaseId: phase.id,
            outcome: 'skipped',
            attempts: 0,
            error: 'skipped by operator',
            deliberate: true,
          });
          this.host.log?.('warn', `step '${step.id}' skipped by operator request`);
          this.host.reportStep(step.id, 'skipped');
          // An operator-skipped GATE answers the pending revision exactly like the
          // self-skipped optional gate below does: the walk reached the gate and
          // moved on, so the "revision requested" section must not leak into the
          // steps after it.
          if (isPureHumanGate(step)) pendingGateRevision = undefined;
          i += 1;
          continue;
        }

        // Blocking-review-items checkpoint: park before starting this step if the
        // PREVIOUS step left a pending BLOCKING review item (e.g. a blocking finding
        // the agent recorded). The host parks the run awaiting_review and awaits the
        // item(s) clearing, then resumes — so the pipeline can't march past a defect
        // the human must clear. Absent host seam (tests / non-programmatic) ⇒ no
        // parking (fast no-op). A cancel while parked ends the walk 'canceled'.
        if (this.host.awaitBlockingReviewItems) {
          const gate = await this.host.awaitBlockingReviewItems(runId, signal);
          if (gate === 'canceled' || signal?.aborted) {
            return this.finish({ outcome: 'canceled', steps, failedStepId: step.id }, runId);
          }
        }

        // Closing-stage gate: the sprint has incomplete/blocked tasks (a fan-out
        // settled with failed lanes). Skip every subsequent AUTOMATED step and go
        // straight to the next human gate. A human-gated step (pure gate or an
        // agent step with a trailing checkpoint) is the stopping point — it clears
        // the flag so any steps AFTER the gate run normally once the human decides.
        if (skipToHumanGate) {
          if (isPureHumanGate(step) || hasTrailingGate(step)) {
            skipToHumanGate = false;
          } else {
            this.pushStep(steps, {
              stepId: step.id,
              phaseId: phase.id,
              outcome: 'skipped',
              attempts: 1,
              error: 'sprint has incomplete or blocked tasks — closing stage skipped',
              deliberate: true,
            });
            this.host.reportStep(step.id, 'skipped');
            this.host.log?.(
              'warn',
              `skipping '${step.id}': sprint has incomplete/blocked tasks; advancing to the human gate`,
            );
            i += 1;
            continue;
          }
        }

        // ── Host-driven parallel fan-out (programmatic plane only) ───────────
        // A step that declares `fanOut` AND has an injected driver resolves a
        // runtime item set; when non-empty, the host walks each item through the
        // inner chain (driving a lane per item) instead of running the step once.
        // An EMPTY item set (or an absent driver) falls through to the normal
        // single agent-step path below — byte-identical to today.
        if (step.fanOut !== undefined && this.host.fanOut !== undefined) {
          // resolveItems may hit the DB (the production sprint driver SELECTs lanes).
          // A throw must NOT crash the walk — contain it and fall through to the
          // normal single agent-step path (degraded but safe), mirroring driveLane's
          // fail-soft contract. An empty result takes the same fall-through.
          let items: string[] = [];
          try {
            items = this.host.fanOut.resolveItems(runId, step.fanOut.over);
          } catch (err) {
            this.host.log?.(
              'warn',
              `fan-out resolveItems('${step.fanOut.over}') threw; running '${step.id}' as a single step: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          if (items.length > 0) {
            this.host.reportStep(step.id, 'running');
            const fanResult = await this.runFanOut(
              runId,
              step,
              { runId, phaseId: phase.id, stepIndex: i, signal },
              items,
              signal,
              systemicPauses,
              systemicGiveUps,
              laneRescues,
            );
            if (fanResult.terminal) {
              // Mark the outer step canceled in the trace before the terminal.
              this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'canceled', attempts: 1 });
              this.host.reportStep(step.id, 'done');
              return this.finish({ outcome: 'canceled', steps, failedStepId: step.id }, runId);
            }
            // One or more lanes failed ⇒ the sprint is incomplete. Gate the closing
            // stages: subsequent automated steps are skipped until the next human
            // gate (set here, honored at the top of the step loop).
            if (fanResult.incompleteCount > 0) {
              skipToHumanGate = true;
              this.host.log?.(
                'warn',
                `fan-out '${step.id}' settled with ${fanResult.incompleteCount} incomplete lane(s); gating the sprint's closing stages until the human gate`,
              );
            }
            // The fan-out settled. If the OUTER step also carries a trailing human
            // checkpoint, open the gate now (fan-out-then-gate) and route the
            // decision through the SAME applyGateDecision logic the normal agent
            // path uses (so approve advances, reject/abort terminate, and revise
            // honors the outer step's `loopback`). Otherwise advance. Not routing
            // here silently dropped a declared `human`/`loopback` on a fanOut step.
            if (hasTrailingGate(step)) {
              this.emit({ kind: 'gate-opened', runId, phaseId: phase.id, stepId: step.id });
              const decision = await this.host.requestHumanGate(step, {
                runId,
                phaseId: phase.id,
                stepIndex: i,
                signal,
                attempt: 1,
              });
              const next = this.applyGateDecision(decision, step, phase, phase.steps, loopbacks, reviewRounds, remainingCompleted, steps, i);
              if (next.terminal) return this.finish(next.result, runId);
              i = next.i;
              continue;
            }
            this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'done', attempts: 1 });
            this.host.reportStep(step.id, 'done');
            i += 1;
            continue;
          }
          // No items resolved ⇒ fall through to the normal agent-step path.
        }

        // ── Optional human gate with an absent precondition ──────────────────
        // An `optional: true` pure gate whose reviewable surface never
        // materialized (e.g. launch's approve-design when both design steps
        // self-skipped) skips instead of parking the run over nothing. Consulted
        // via the host seam; a thrown consult opens the gate (fail-open — never
        // silently skip a human review on an error).
        if (isPureHumanGate(step) && step.optional === true && this.host.shouldSkipHumanGate) {
          let gateSkipReason: string | null = null;
          try {
            gateSkipReason = this.host.shouldSkipHumanGate(step, runId);
          } catch {
            gateSkipReason = null;
          }
          if (gateSkipReason !== null) {
            this.pushStep(steps, {
              stepId: step.id,
              phaseId: phase.id,
              outcome: 'skipped',
              attempts: 0,
              error: gateSkipReason,
              deliberate: true,
            });
            this.host.log?.('info', `optional human gate '${step.id}' skipped: ${gateSkipReason}`);
            this.host.reportStep(step.id, 'skipped');
            // A SKIPPED gate answers the pending revision the same way an opened
            // one does — the walk reached it and moved on. `pendingGateRevision`
            // is otherwise cleared only where a gate actually opens, so without
            // this the "revision requested" section leaks into every step after
            // the skip (epics/tasks re-running as if a human had just asked for
            // changes that nobody is ever shown).
            pendingGateRevision = undefined;
            i += 1;
            continue;
          }
        }

        const baseCtx = {
          runId,
          phaseId: phase.id,
          stepIndex: i,
          signal,
          // Sticky across the revisited region: the human's note describes what
          // the whole re-run must do differently, not one step's defect.
          ...(pendingGateRevision !== undefined ? { gateRevision: pendingGateRevision } : {}),
          // Prior-step handoff, opt-in per step. Only a step that declares it
          // receives the previous agent's text; every other step's prompt is
          // byte-identical to before.
          ...(step.consumesPriorStepOutput === true && priorAgentOutput !== undefined
            ? { priorStepOutput: priorAgentOutput }
            : {}),
        };
        this.host.reportStep(step.id, 'running');

        // ── Pure human gate (no agent work) ──────────────────────────────────
        if (isPureHumanGate(step)) {
          this.emit({ kind: 'gate-opened', runId, phaseId: phase.id, stepId: step.id });
          const decision = await this.host.requestHumanGate(step, { ...baseCtx, attempt: 1 });
          const next = this.applyGateDecision(decision, step, phase, phase.steps, loopbacks, reviewRounds, remainingCompleted, steps, i);
          if (next.terminal) return this.finish(next.result, runId);
          // Every gate decision REPLACES the pending revision: a revise-with-target
          // arms a fresh one, and anything else (approve, or a revise that only
          // re-presents) clears it. Reaching this gate again is exactly what
          // "the revision has been answered" means, so no separate clear is needed.
          pendingGateRevision = next.gateRevision;
          i = next.i;
          continue;
        }

        // ── Agent step (optionally with a trailing human checkpoint) ─────────
        // In-place retries up to (retries + 1) attempts.
        //
        // Systemic-failure invariant: a failed attempt whose result is stamped
        // `systemic === true` (an environment-level condition — usage/session/rate
        // limit, provider overload, auth) NEVER consumes this step's retry budget
        // and NEVER triggers optional-skip / loopback / triage. Instead it parks the
        // run via `host.awaitSystemicPause` (bounded per step id by
        // MAX_SYSTEMIC_PAUSES) and, once the condition clears, re-runs the SAME
        // attempt. The step's normal failure budgets are reserved exclusively for
        // step-specific defects; they only apply once the human GAVE UP on the pause
        // ('giveup') or the pause budget is exhausted, at which point the systemic
        // result falls through the ordinary failure path below unchanged.
        const maxAttempts = step.retries + 1;
        let attempt = 0;
        let lastError: string | undefined;
        let ok = false;
        let aborted = false;
        let okResultText: string | null | undefined;
        while (attempt < maxAttempts) {
          attempt += 1;
          const result = await this.runner.runStep(step, { ...baseCtx, attempt });
          if (result.status === 'ok') {
            ok = true;
            okResultText = result.resultText;
            break;
          }
          if (result.status === 'aborted') {
            aborted = true;
            break;
          }
          // Systemic failure: park-and-retry BEFORE the failure touches any budget.
          if (result.status === 'failed' && result.systemic === true && this.host.awaitSystemicPause) {
            const used = systemicPauses.get(step.id) ?? 0;
            // Park only when budget remains AND the human has not already GIVEN UP on
            // this step's systemic pause. Once giveup is latched, every subsequent
            // systemic attempt of this step skips the pause and falls through to the
            // normal failure path — the human dismissed once, so we honor it once.
            if (used < MAX_SYSTEMIC_PAUSES && !systemicGiveUps.has(step.id)) {
              systemicPauses.set(step.id, used + 1);
              this.host.log?.(
                'warn',
                `step '${step.id}' hit a systemic failure; pausing the run: ${result.error ?? '(no error text)'}`,
              );
              const verdict = await this.host.awaitSystemicPause(step, { ...baseCtx, attempt }, result.error);
              if (verdict === 'canceled' || signal?.aborted) {
                aborted = true;
                break;
              }
              if (verdict === 'retry') {
                // Re-run the SAME attempt WITHOUT consuming the retry budget: undo
                // this iteration's `attempt += 1` so the next iteration re-numbers it.
                attempt -= 1;
                continue;
              }
              // 'giveup' — latch it so later systemic re-failures of this step do NOT
              // re-park, then fall through: the failure follows the normal path below.
              systemicGiveUps.add(step.id);
            }
            // Budget exhausted / already gave up also falls through to the normal path.
          }
          lastError = result.error;
        }

        if (aborted || signal?.aborted) {
          this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'canceled', attempts: attempt });
          this.host.reportStep(step.id, 'done');
          return this.finish({ outcome: 'canceled', steps, failedStepId: step.id }, runId);
        }

        if (ok) {
          // Record this turn for the next step that declares
          // `consumesPriorStepOutput`. Recorded BEFORE the trailing-gate branch
          // so an agent-then-gate step still hands its output forward.
          priorAgentOutput = {
            stepId: step.id,
            name: step.name ?? step.id,
            ...(okResultText !== null && okResultText !== undefined && okResultText.trim().length > 0
              ? { text: okResultText }
              : {}),
          };
          // Adversarial-review verdict routing: a review step that declares a
          // `loopback` and returned `REVIEW: BLOCKING` (or a populated `## Blocking`
          // section with no trailer) sends the refine phase back AUTOMATICALLY —
          // the same verdict-driven loopback the sprint lane's code-review takes —
          // instead of parking the run at the design gate with defects the flow
          // could have fixed itself. Bounded by MAX_REVIEW_AUTO_REVISIONS; past it
          // the step advances and the human gate presents the surviving entries.
          // One completed review result = one round, whatever the verdict and
          // whoever asked for it. Counted BEFORE the loopback decision so a clean
          // result (which takes no lap) still advances the number a later human
          // Revise will quote.
          if (step.agent === 'adversarial-review') {
            reviewRounds.set(step.id, (reviewRounds.get(step.id) ?? 0) + 1);
          }
          const reviewJump = this.tryAdversarialReviewLoopback(
            step, phase.steps, okResultText, reviewAutoRevisions,
          );
          if (reviewJump !== null) {
            this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'done', attempts: attempt });
            this.host.reportStep(step.id, 'done');
            this.host.log?.(
              'warn',
              `step '${step.id}' returned REVIEW: BLOCKING; looping back to '${phase.steps[reviewJump.index].id}' for an automatic revision (${reviewJump.round}/${MAX_REVIEW_AUTO_REVISIONS})`,
            );
            // Deliberate revisit — same purge the gate's revise performs.
            this.clearCompletedFrom(remainingCompleted, phase.steps, reviewJump.index);
            const lapRound = reviewRounds.get(step.id);
            pendingGateRevision = {
              gateStepId: step.id,
              source: 'adversarial-review',
              ...(reviewJump.blocking !== null ? { note: reviewJump.blocking } : {}),
              ...(lapRound !== undefined ? { round: lapRound } : {}),
            };
            i = reviewJump.index;
            continue;
          }
          // Agent succeeded. If the step ALSO carries a human checkpoint, open the
          // gate now (agent-then-gate); otherwise advance.
          if (hasTrailingGate(step)) {
            this.emit({ kind: 'gate-opened', runId, phaseId: phase.id, stepId: step.id });
            const decision = await this.host.requestHumanGate(step, { ...baseCtx, attempt });
            const next = this.applyGateDecision(decision, step, phase, phase.steps, loopbacks, reviewRounds, remainingCompleted, steps, i, attempt);
            if (next.terminal) return this.finish(next.result, runId);
            pendingGateRevision = next.gateRevision;
            i = next.i;
            continue;
          }
          this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'done', attempts: attempt });
          this.host.reportStep(step.id, 'done');
          i += 1;
          continue;
        }

        // Retries exhausted — try an intra-phase loopback before escalating. An
        // OPTIONAL step never takes it: optional means "skippable on failure", and
        // its `loopback` exists for a verdict-driven jump (adversarial-review's
        // REVIEW: BLOCKING above), not to re-run the whole phase because the
        // reviewer itself crashed. No built-in ever paired the two before, so this
        // is byte-identical for every existing definition.
        const jumped = step.optional === true ? null : this.tryLoopback(step, phase.steps, loopbacks);
        if (jumped !== null) {
          this.host.log?.('warn', `step '${step.id}' failed; looping back to '${phase.steps[jumped].id}'`);
          this.host.reportStep(step.id, 'done');
          // Deliberate revisit: the jumped-to region (and this failing step at i >=
          // jumped) is being redone, so drop it from the resume skip set — otherwise
          // the jump lands on a still-marked step and is skipped as a no-op.
          this.clearCompletedFrom(remainingCompleted, phase.steps, jumped);
          i = jumped;
          continue;
        }

        if (step.optional === true) {
          this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'skipped', attempts: attempt, error: lastError });
          this.host.log?.('warn', `optional step '${step.id}' failed; skipping`);
          this.host.reportStep(step.id, 'skipped');
          i += 1;
          continue;
        }

        // Required step, no loopback budget left — consult the supervisor's triage
        // seam (Stage 3) before failing. Absent ⇒ a hard 'fail' (Stages 1-2).
        const triaged = await this.handleRequiredFailure(
          step, phase, baseCtx, lastError, steps, i, attempt, triageRetries,
        );
        if (triaged.terminal) return this.finish(triaged.result, runId);
        i = triaged.i;
        continue;
      }
    }

    return this.finish({ outcome: 'completed', steps }, runId);
  }

  /**
   * Fail-soft report that a lane's visual verification never reached the queue
   * (F8 "never skip silently", docs/proposals/visual-verification-brittleness-
   * fixes.md). Wrapped here rather than at each call site so a host whose sink
   * throws can never disturb lane advancement — the whole point of the finding is
   * VISIBILITY, so it must be strictly weaker than the walk it observes.
   *
   * IDEMPOTENT per lane (see reportedVerificationSkips): a lane that loops back
   * re-runs task-verify and would otherwise re-file the identical finding on every
   * attempt. The FIRST reason is the one kept — later attempts on the same lane
   * drop the same way for the same reason.
   */
  private reportVerificationSkipped(runId: string, laneTaskRef: string, reason: string, detail?: string): void {
    // RUN-LEVEL declaration wins: once this run has been declared as having no
    // verifiable modality at all, every per-lane finding would repeat that one
    // structural fact once per lane — which is the whole reason the run-level
    // declaration exists. Suppress them for the rest of the walk.
    if (this.verificationPostures.get(runId)?.kind === 'unavailable') return;
    // At most one finding per lane per run — see reportedVerificationSkips.
    const key = `${runId}:${laneTaskRef}`;
    if (this.reportedVerificationSkips.has(key)) return;
    this.reportedVerificationSkips.add(key);
    try {
      this.host.reportVerificationSkipped?.({
        runId,
        laneTaskRef,
        reason,
        ...(detail !== undefined ? { detail } : {}),
      });
    } catch {
      // A broken finding sink must never affect the walk.
    }
  }

  /**
   * The run's verification posture, defaulting to 'available' until (and unless)
   * the host resolves one. 'available' is the correct default in every unresolved
   * case: it is precisely the behaviour of a controller with no posture seam.
   */
  private posture(runId: string): VerificationPosture {
    return this.verificationPostures.get(runId) ?? { kind: 'available' };
  }

  /**
   * Resolve the run-level verification posture ONCE, at fan-out start, and file
   * the single "nothing here can be verified" finding when it is 'unavailable'.
   *
   * EAGER, not lazy — see `ControllerHost.resolveVerificationPosture`. Fail-soft
   * in both halves: a throwing resolver leaves the posture unset (read as
   * 'available'), and a throwing sink loses the card, never the walk.
   */
  private async ensureVerificationPosture(runId: string): Promise<VerificationPosture> {
    const known = this.verificationPostures.get(runId);
    if (known !== undefined) return known;
    if (!this.host.resolveVerificationPosture) return { kind: 'available' };
    let resolved: VerificationPosture;
    try {
      resolved = await this.host.resolveVerificationPosture(runId);
    } catch (err) {
      this.host.log?.(
        'warn',
        `verification posture could not be resolved (${err instanceof Error ? err.message : String(err)}); proceeding as if verification were available`,
      );
      return { kind: 'available' };
    }
    this.verificationPostures.set(runId, resolved);
    if (resolved.kind === 'unavailable') this.declareNoVerifiableModality(runId, resolved.reason);
    return resolved;
  }

  /**
   * File the ONE non-blocking "no verifiable modality" card for this run.
   * Idempotent per run here AND at the sink (which dedupes on `source` through
   * `ReviewItemRouter.createIfNoPending`), so neither a second fan-out step nor a
   * crash-resume can double-file.
   */
  private declareNoVerifiableModality(runId: string, reason: string): void {
    if (this.reportedNoModality.has(runId)) return;
    this.reportedNoModality.add(runId);
    this.host.log?.('warn', `run '${runId}': no verifiable modality — ${reason}`);
    try {
      this.host.reportNoVerifiableModality?.({ runId, reason });
    } catch {
      // A broken finding sink must never affect the walk.
    }
  }

  /**
   * MID-FLIGHT FLIP. The eager probe said 'available' and reality disagreed: an
   * enqueue declined for a reason that names a modality/runbook problem, i.e. a
   * fact about the RUN, not about this lane. Flip the posture so later lanes skip
   * the enqueue and their per-lane findings collapse into the one card filed here.
   *
   * DOCUMENTED GAP: lanes already PAST their enqueue when the flip happens are
   * unaffected — they neither park nor get the declaration, and the first of them
   * has already filed its own per-lane finding (which is what triggered this).
   * That is accepted: the eager probe is the primary mechanism and this arm only
   * catches the case it could not predict.
   *
   * Returns true when the reason was a run-level one (the caller then skips its
   * per-lane finding, which `reportVerificationSkipped` would suppress anyway).
   */
  private maybeFlipPostureUnavailable(runId: string, reason: string): boolean {
    if (!isNoModalityDeclineReason(reason)) return false;
    if (this.posture(runId).kind !== 'available') return false;
    this.verificationPostures.set(runId, { kind: 'unavailable', reason });
    this.declareNoVerifiableModality(runId, reason);
    return true;
  }

  /**
   * Sweep this run's pending build-break findings and announce each NEW group.
   * Called at the dispatch pool's quiesced instant and once at fan-out end (see
   * `ControllerHost.sweepBuildBreaks` for why not per lane settle). Detector
   * only: one advisory card per group, no pause, no fix agent. Fail-soft.
   */
  private async sweepBuildBreaks(runId: string): Promise<void> {
    if (!this.host.sweepBuildBreaks) return;
    let groups: BuildBreakGroup[];
    try {
      groups = await this.host.sweepBuildBreaks(runId);
    } catch (err) {
      this.host.log?.(
        'warn',
        `build-break sweep failed (${err instanceof Error ? err.message : String(err)}); continuing`,
      );
      return;
    }
    for (const group of groups) {
      const key = `${runId}:${group.normalized}`;
      if (this.reportedBuildBreakGroups.has(key)) continue;
      this.reportedBuildBreakGroups.add(key);
      this.host.log?.(
        'warn',
        `run '${runId}': ${group.count} lane report(s) share one build break: ${group.sampleTitle.slice(0, 120)}`,
      );
      try {
        this.host.reportBuildBreakGroup?.({ runId, group });
      } catch {
        // A broken finding sink must never affect the walk.
      }
    }
  }

  /** Fail-soft monitor-feed emit to the supervisor (Stage 3). */
  private emit(event: SupervisorEvent): void {
    try {
      this.host.notify?.(event);
    } catch {
      // A broken monitor feed must never affect the walk.
    }
  }

  /**
   * Append a settled step to the trace AND persist it host-side (Stage 3,
   * migration 033). Centralizes every settle so per-step results are recorded as
   * they happen (powering crash-safe resume + queryable results). Fail-soft: a
   * broken recorder must never affect the walk.
   */
  private pushStep(steps: StepReport[], report: StepReport): void {
    steps.push(report);
    try {
      this.host.recordStepResult?.(report);
    } catch {
      // A broken result sink must never affect the walk.
    }
  }

  /** Emit run-finished then return the result (single terminal seam). */
  private finish(result: ControllerResult, runId: string): ControllerResult {
    this.emit({ kind: 'run-finished', runId, outcome: result.outcome, stepId: result.failedStepId });
    return result;
  }

  /**
   * Walk a `fanOut` outer step: drive ONE lane per resolved item through the
   * step's inner chain, with bounded parallelism. Each item's lane goes
   * `running` (at the first inner step) → one `currentStepId` update per inner
   * step → `integrated` (all inner steps succeeded) or `failed` (a required inner
   * step failed). Items run in WAVES of at most `effectiveMaxConcurrency(fanOut)`
   * (the step's declared `maxConcurrency`, else SPRINT_BATCH_CAP — see
   * shared/types/workflows.ts) via `Promise.all`; a cap of 1 naturally serializes,
   * since the wave loop re-evaluates readiness after each wave settles. The abort
   * signal is checked between waves AND per inner step,
   * so a canceled run returns a terminal 'canceled' promptly. Lane writes go
   * through the injected fail-soft `host.fanOut.driveLane` (never throws); the
   * controller itself performs NO DB/IPC.
   *
   * Returns `{ terminal: false }` when the whole item set settled (the caller
   * then marks the outer step done), or `{ terminal: true }` ONLY on cancellation
   * (the caller ends the run 'canceled'). A required inner-step failure on ONE
   * item marks THAT lane 'failed' and stops that item, but does NOT terminate the
   * fan-out — sibling items continue and the outer step still settles 'done'
   * (the holistic verify/review OUTER steps after the fanOut catch real defects).
   *
   * Scheduling is DAG-aware (2026-06-22): a task is dispatched only once all of its
   * in-scope blocking prerequisites have integrated (via `host.fanOut.dependencies`);
   * a task whose prerequisite failed is marked failed (blocked). When the driver
   * exposes no dependencies this degrades to flat cap-sized waves. Expected task
   * files (when the driver exposes them) additionally serialize overlapping ready
   * items into later waves without reducing concurrency for disjoint items.
   * Required inner-step failures honor a declared inner `loopback`, re-driving the
   * lane through Ship's bounded three-attempt contract.
   *
   * Systemic failures: an inner step failing with `systemic === true` (env-level:
   * usage/rate limit, overload, auth) is NOT that lane's defect — it does NOT fail
   * the lane (nor skip an optional inner step). Instead driveItem bubbles it up as
   * 'systemic'; the wave loop keeps the paused item in `remaining` and parks the
   * WHOLE fan-out via `host.awaitSystemicPause` (bounded per outer step id by
   * `systemicPauses`/MAX_SYSTEMIC_PAUSES). On 'retry' the paused items re-dispatch;
   * on 'giveup' / seam-absent / budget-exhausted they are failed like a blocked
   * lane. `systemicPauses` is the SAME run-level map the single-step path uses,
   * keyed here on the outer step id.
   *
   * Operator LANE REWIND: `RunDirectives.laneRewinds` lets the monitor pull ONE
   * lane back to an earlier inner step while the fan-out stays live — sibling
   * lanes, the outer walk, and the run's step_results are untouched (that is the
   * whole-run `rewindRunHandler`'s job). The request is consulted at THREE points
   * in `driveItem` so it lands wherever the lane happens to be: idle between inner
   * steps, mid-agent-turn (the handler kills the lane's spawn to force the step to
   * return, and the pending request is what keeps the resulting failure from
   * failing the lane), and parked at the visual merge gate (woken via the
   * `laneInterrupts` unpark hook this method registers around the park). A rewind
   * restores the lane's automatic loopback budgets but never bumps its attempt
   * counter — see `clearStateForRewind`.
   *
   * MONITOR LANE RESCUE: every site that would settle a lane 'failed' after it
   * EXHAUSTED an automatic budget first consults `host.triageLaneFailure` (see
   * `consultLaneTriage`). A 'rescue' verdict re-drives the lane from an earlier
   * inner step with supervisor guidance — the AUTONOMOUS analogue of the operator
   * rewind above, sharing its `clearStateForRewind` semantics and its refusal to
   * bump `laneAttempt`. Bounded by MONITOR_LANE_RESCUE_CAP (per lane) and
   * MONITOR_RUN_RESCUE_CAP (per walk). Failures that are NOT budget exhaustion
   * never consult: a systemic failure (it has its own park path), an aborted
   * result, a never-started / cycle lane (`markBlocked`), a lane the
   * commit-integrity probe caught, and a task-verify output-CONTRACT exhaustion
   * (a malformed result is not a defect a rescue can reason about).
   */
  private async runFanOut(
    runId: string,
    step: WorkflowStep,
    baseCtx: { runId: string; phaseId: string; stepIndex: number; signal?: AbortSignal },
    items: string[],
    signal: AbortSignal | undefined,
    systemicPauses: Map<string, number>,
    systemicGiveUps: Set<string>,
    laneRescues: LaneRescueState = { perItem: new Map(), runTotal: 0, guidance: new Map() },
  ): Promise<{ terminal: boolean; incompleteCount: number }> {
    const fanOut = step.fanOut;
    const driver = this.host.fanOut;
    // Defensive: the caller only enters here with both present; narrow for TS.
    if (fanOut === undefined || driver === undefined) return { terminal: false, incompleteCount: 0 };

    const inner = fanOut.inner;
    const allowedStepIds: readonly string[] = inner.map((s) => s.id);
    // RUN-LEVEL verification posture, resolved ONCE here — BEFORE the first lane
    // is dispatched, so every lane's implement/task-verify runs under a known
    // posture. Resolving it lazily (from the first lane whose enqueue declined)
    // reaches almost nobody: under the rolling pool the set of lanes whose
    // prompts are already composed is permanently cap-sized.
    await this.ensureVerificationPosture(runId);
    // PARK-EPOCH LATCH (defined ⇒ latched): set to the error text the moment one
    // lane's triage consult dies on a systemic condition. Lanes run concurrently
    // and the consults are serialized on the monitor's send chain, so without it
    // five concurrently-failing lanes make five doomed consults against a dead
    // quota — and the ones past MONITOR_RUN_RESCUE_CAP get no consult at all and
    // settle 'failed' on an environment condition. With it, the first systemic
    // verdict parks every later lane of the same epoch for free.
    //
    // THE EPOCH IS THE PARK, not a dispatch generation: a rolling pool has no
    // wave boundary to clear this at, and clearing it per dispatch would restore
    // the N-doomed-consults bug the latch exists to prevent. It is therefore
    // cleared on EVERY path that settles a park — the human's 'retry', and
    // equally the give-up / spent-budget / no-seam paths, which end the park with
    // no resume event. Leaving it latched on those three would silently strip
    // lane triage from every later lane of the run because ONE consult once hit a
    // transient quota error. Every OTHER systemic/failure text rides on the
    // lane's own outcome, so nothing about one epoch's errors leaks into the
    // next epoch's corroboration.
    let systemicTriageLatch: string | undefined;
    /**
     * Lane-triage consults are SERIALIZED through this chain so the latch above
     * is re-read AFTER the previous consult resolved. Lanes fail concurrently:
     * without the chain, every lane of a wave that fails before the first
     * consult returns passes the latch check together, four of them burn
     * MONITOR_RUN_RESCUE_CAP on a monitor whose own turn is dead, and the fifth
     * — refused a consult on a "spent" budget — settles 'failed' on the
     * environment. The monitor already runs consults one at a time, so
     * serializing here costs no wall-clock.
     */
    let triageConsultChain: Promise<unknown> = Promise.resolve();

    /**
     * Walk ONE item through the inner chain. Fail-soft per inner step:
     *  - required inner failure with a declared, in-chain loopback → re-drive its
     *    target through attempt 3; otherwise mark the lane (failed) + stop;
     *  - optional inner failure → skip that inner step, continue the lane;
     *  - SYSTEMIC inner failure (env-level) → do NOT fail/skip the lane; return
     *    `{ kind: 'systemic' }` carrying the error so the wave loop parks the whole
     *    fan-out;
     *  - all inner steps ok → mark the lane 'integrated', UNLESS the driver's
     *    optional commit-integrity probe shows the lane committed nothing and left
     *    the worktree dirty, in which case the lane is failed instead.
     * Returns `{ kind: 'aborted' }` when the signal fired mid-walk so the wave can
     * short out.
     *
     * A `{ kind: 'failed' }` outcome says whether the lane row was already
     * written: the generic inner-step exhaustion arm alone DEFERS its write to the
     * wave settle (`persisted: false`) so the corroboration pass there can
     * reclassify it as environmental before anything is stamped on the lane. See
     * {@link SAME_ERROR_CORROBORATION_MIN}.
     */
    /** Resolve a declared inner-chain loopback target; invalid data fails the lane. */
    const loopbackIndex = (innerStep: (typeof inner)[number]): number =>
      innerStep.loopback === undefined ? -1 : inner.findIndex((candidate) => candidate.id === innerStep.loopback);
    /** Chain index of the step that COMPOSES the visual-verification task, or -1. */
    const taskVerifyIndex = inner.findIndex((candidate) => candidate.id === SPRINT_TASK_VERIFY_STEP);

    /**
     * Consume a pending OPERATOR LANE REWIND for `itemId` (RunDirectives.laneRewinds,
     * written by the monitor's `rewind_lane_to_step` action) and resolve it to an
     * inner-chain index, or null when there is nothing to honor.
     *
     * ALWAYS deletes the request it read, including on every rejection path — a
     * request the lane cannot honor must not persist and re-fire at the next
     * consult point (an unknown id would then re-refuse on every inner step for the
     * rest of the lane's life, and a stale forward target would jump the lane
     * forward the moment its chain position caught up).
     *
     * Two rejections, both logged rather than lane-failing (an operator's malformed
     * ask must never destroy in-flight work):
     *   - a target that is not in THIS fan-out's inner chain, and
     *   - a FORWARD target (`targetIndex > currentIndex`): rewind means backward.
     *     The handler already checked this against the lane's persisted pointer;
     *     re-checking against the live in-memory index closes the window where the
     *     lane advanced between the operator's request and this consult.
     * `targetIndex === currentIndex` IS honored — "restart this step" — mirroring
     * the whole-run rewind's `target === current` allowance.
     */
    const takeLaneRewind = (itemId: string, currentIndex: number): number | null => {
      const targetId = this.directives.laneRewinds.get(itemId);
      if (targetId === undefined) return null;
      this.directives.laneRewinds.delete(itemId);
      const targetIndex = inner.findIndex((candidate) => candidate.id === targetId);
      if (targetIndex < 0) {
        this.host.log?.(
          'warn',
          `fan-out item '${itemId}': operator asked to rewind to '${targetId}', which is not one of this fan-out's inner steps; ignoring`,
        );
        return null;
      }
      if (targetIndex > currentIndex) {
        this.host.log?.(
          'warn',
          `fan-out item '${itemId}': operator asked to rewind to '${targetId}', which is AHEAD of the lane's current step; ignoring (rewind only goes backward)`,
        );
        return null;
      }
      this.host.log?.(
        'info',
        `fan-out item '${itemId}': operator rewind → '${targetId}' (from inner index ${currentIndex})`,
      );
      return targetIndex;
    };
    /**
     * Consult the host's AUTONOMOUS lane-triage seam for a lane that exhausted an
     * automatic budget, resolving the inner-chain index to re-drive from — or
     * `null`, meaning "settle this lane 'failed'", which is what every call site
     * did unconditionally before this seam existed.
     *
     * Every `null` arm is the pre-seam behavior, so a host with no seam, a spent
     * budget, a give_up verdict, an unresolvable target, or a throwing consult all
     * land on exactly the same code path they always did:
     *   - no `host.triageLaneFailure` (tests, orchestrated hosts) ⇒ null;
     *   - the per-lane or per-run cap is already spent ⇒ null WITHOUT consulting
     *     (a rescue we could not act on is not worth an agent turn);
     *   - the host gives up ⇒ null;
     *   - the target id is not in THIS fan-out's inner chain ⇒ null (defensive:
     *     the brain's parse ladder already constrains it to `innerStepIds`);
     *   - the consult throws ⇒ null (the host contract says it never does).
     *
     * Budget is RESERVED before the consult and RELEASED on every non-rescue arm,
     * rather than charged after it. Lanes run concurrently, and the consult is a
     * slow SDK turn: charging afterwards would let a whole wave of failing lanes
     * pass the cap check together and every one of them get rescued, which is
     * exactly the runaway MONITOR_RUN_RESCUE_CAP exists to prevent. Reserving is
     * safe because the release path restores the counters exactly, so a give_up
     * still costs nothing — the caps bound INTERVENTION, not consultation.
     *
     * The guidance is stored per ITEM, sticky for the life of the lane — see
     * `LaneRescueState.guidance`.
     */
    const consultLaneTriage = async (
      itemId: string,
      failingStepId: string,
      attempt: number,
      failureKind: LaneFailureKind,
      errorExcerpt: string,
    ): Promise<number | null | { systemic: string }> => {
      if (!this.host.triageLaneFailure) return null;
      const usedForLane = laneRescues.perItem.get(itemId) ?? 0;
      if (usedForLane >= MONITOR_LANE_RESCUE_CAP || laneRescues.runTotal >= MONITOR_RUN_RESCUE_CAP) {
        this.host.log?.(
          'info',
          `fan-out item '${itemId}': lane-rescue budget spent (lane ${usedForLane}/${MONITOR_LANE_RESCUE_CAP}, run ${laneRescues.runTotal}/${MONITOR_RUN_RESCUE_CAP}); not consulting lane triage`,
        );
        return null;
      }
      // Reserve now, release on every non-rescue arm below (see the docblock).
      laneRescues.perItem.set(itemId, usedForLane + 1);
      laneRescues.runTotal += 1;
      const releaseReservation = (): null => {
        laneRescues.perItem.set(itemId, usedForLane);
        laneRescues.runTotal -= 1;
        return null;
      };

      let outcome: LaneRescueOutcome;
      try {
        outcome = await this.host.triageLaneFailure({
          itemId,
          stepId: failingStepId,
          attempt,
          failureKind,
          errorExcerpt,
          innerStepIds: allowedStepIds,
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        this.host.log?.(
          'warn',
          `fan-out item '${itemId}': lane triage threw (${err instanceof Error ? err.message : String(err)}); failing the lane`,
        );
        return releaseReservation();
      }
      if (outcome.kind === 'systemic') {
        // The consult itself died on an environment-level condition — it judged
        // nothing, so this costs no rescue budget and the lane is NOT this
        // lane's defect. Hand the text up; the caller parks the fan-out.
        releaseReservation();
        this.host.log?.(
          'warn',
          `fan-out item '${itemId}': lane triage hit a SYSTEMIC condition (${outcome.error}); parking the fan-out instead of failing the lane`,
        );
        return { systemic: outcome.error };
      }
      if (outcome.kind !== 'rescue') return releaseReservation();
      const targetIndex = inner.findIndex((candidate) => candidate.id === outcome.targetStepId);
      if (targetIndex < 0) {
        this.host.log?.(
          'warn',
          `fan-out item '${itemId}': lane triage named '${outcome.targetStepId}', which is not one of this fan-out's inner steps; failing the lane`,
        );
        return releaseReservation();
      }
      laneRescues.guidance.set(itemId, outcome.guidance);
      this.host.log?.(
        'warn',
        `fan-out item '${itemId}': ${failureKind} exhausted at '${failingStepId}' — monitor RESCUE${outcome.adjusted ? ' (task body adjusted)' : ''} → re-driving from '${inner[targetIndex].id}'`,
      );
      return targetIndex;
    };

    // The park step is NOT an inner-chain id, so the lane-store vocabulary must be
    // widened to accept it when the controller parks at the merge-gate.
    const parkAllowedStepIds: readonly string[] = [...allowedStepIds, AWAITING_VERIFY_STEP];

    const driveItem = async (itemId: string): Promise<LaneWalkOutcome> => {
      driver.driveLane({
        runId,
        itemId,
        status: 'running',
        currentStepId: inner[0].id,
        allowedStepIds,
      });

      // Commit-integrity backstop: capture the worktree's lane-start state now so
      // the success end can refuse to stamp 'integrated' on a lane that never
      // committed. Fail-soft — an absent/throwing probe leaves the lane on the
      // pre-backstop path (step verdicts alone).
      let commitProbe: CommitIntegrityProbe | undefined;
      try {
        commitProbe = await driver.beginCommitProbe?.(runId);
      } catch (err) {
        this.host.log?.(
          'warn',
          `fan-out item '${itemId}': could not open the commit-integrity probe (${err instanceof Error ? err.message : String(err)}); integrating on step verdicts alone`,
        );
      }

      // The lane's current implement attempt (1-based). Bumped by a visual
      // merge-gate loopback so the re-dispatched implement (and the steps after it)
      // run under the bumped attempt — parity with the orchestrated re-delegate.
      let laneAttempt = 1;
      let visualLoopbacks = 0;
      // Set when a loopback lands on a target. The target's lane write carries the
      // bumped attempt in the SAME transition that moves it back to that step.
      let loopbackAttemptStepIndex: number | undefined;
      // The composed visual-verification task task-verify's typed output produced
      // for THIS lane (§5.3). undefined ⇒ nothing to verify (NOT-APPLICABLE, a
      // channel-unavailable substrate, or task-verify not yet run) → the agentless
      // visual-verify step skips without parking.
      let visualVerifyTask: VerificationTaskV1 | undefined;
      // §5.1 output-contract re-run budget for THIS lane: task-verify gets exactly
      // ONE re-delegation when its PASS result violates the fence/NOT-APPLICABLE
      // contract; a second violation fails the lane.
      let laneContractRetries = 0;
      // Adoption flag (live-smoke fix 2026-07-22): set when a contract-failing
      // task-verify turn is found to have FIRED the verification request itself
      // (a LIVE lane-attributed request exists). The visual-verify step then
      // parks on that request WITHOUT enqueuing. Reset whenever a fresh
      // task-verify result is consumed.
      let adoptedPreFiredRequest = false;
      // One-shot per-attempt prompt sections consumed when the NEXT agent-step ctx
      // is built (§5.3): a task-verify contract defect / a visual-FAIL report.
      let pendingContractError: string | undefined;
      let pendingLoopbackFeedback: string | undefined;

      /**
       * Reset the per-attempt state an OPERATOR LANE REWIND invalidates, so the
       * re-driven region starts from a clean slate rather than inheriting the
       * superseded attempt's leftovers.
       *
       * What is cleared and why:
       *   - the one-shot prompt sections (a task-verify contract defect, a visual
       *     FAIL report) and any armed loopback attempt write — they describe work
       *     the rewind is discarding;
       *   - `adoptedPreFiredRequest` — the adopted request belongs to the
       *     superseded attempt;
       *   - `visualVerifyTask`, but ONLY when the target is at or before the
       *     task-verify step that composed it (a rewind landing AFTER task-verify
       *     keeps the still-current task);
       *   - the AUTOMATIC loopback budgets (`laneContractRetries`,
       *     `visualLoopbacks`) — an exhausted budget would make the rewind
       *     cosmetic, failing the lane on the first defect of the very region the
       *     operator just asked to redo.
       *
       * What is deliberately NOT touched: `laneAttempt`. It is written to the lane
       * row and read by humans as the re-delegate count, and bumping it would BURN
       * the lane's FAN_OUT_LANE_ATTEMPT_CAP budget on an operator action — the same
       * reasoning that makes an operator skip of a required step advance the walk
       * instead of failing the run.
       */
      const clearStateForRewind = (targetIndex: number): void => {
        pendingContractError = undefined;
        pendingLoopbackFeedback = undefined;
        loopbackAttemptStepIndex = undefined;
        adoptedPreFiredRequest = false;
        laneContractRetries = 0;
        visualLoopbacks = 0;
        if (taskVerifyIndex >= 0 && targetIndex <= taskVerifyIndex) visualVerifyTask = undefined;
      };

      /**
       * This lane exhausted an automatic budget and is about to settle 'failed'.
       * Consult autonomous lane triage first; on a RESCUE, prepare the lane for
       * the re-drive and return the inner index to jump to, else null (the caller
       * settles the lane exactly as it did before this seam existed).
       *
       * A rescue is deliberately the SAME state transition an operator lane rewind
       * performs — `clearStateForRewind` — so the two interventions cannot drift:
       *   - the AUTOMATIC budgets the re-driven region needs (`laneContractRetries`,
       *     `visualLoopbacks`) are reset, otherwise the rescue would be cosmetic:
       *     the lane would fail on the first defect of the very region the
       *     supervisor just asked it to redo;
       *   - the one-shot prompt sections + any armed loopback attempt write are
       *     dropped (they describe the superseded attempt);
       *   - `laneAttempt` is NOT bumped at the three inner-chain sites. A rescue
       *     must not BURN the lane's FAN_OUT_LANE_ATTEMPT_CAP budget — the same
       *     reasoning that exempts an operator rewind (and an operator step-skip)
       *     from the budgets they bypass. It is bounded by
       *     MONITOR_LANE_RESCUE_CAP instead. The ONE exception is the two
       *     MERGE-GATE arms, which bump it after this returns: the verification
       *     scheduler's enqueue key is `${runId}:${ref}:${attempt}`, and the
       *     request the gate just resolved owns the current number — without a
       *     fresh attempt, the rescued traversal's re-enqueue would dedup onto
       *     that terminal request and be failed on its stale verdict. At those
       *     arms the loopback budgets are already exhausted, so the bump grants
       *     nothing; it only keeps the "fresh attempt ⇒ fresh verification"
       *     contract the normal merge-gate loopback keeps via
       *     `laneAttempt = outcome.attempt`.
       *
       * Returns the sentinel `'systemic'` when the consult itself died on an
       * environment-level condition (the supervisor's own SDK turn hit the usage
       * limit). That is NOT a verdict about the lane, so the three non-gate call
       * sites bubble it up as a systemic lane outcome and the wave loop parks the
       * whole fan-out; the two MERGE-GATE sites treat it exactly like `null`
       * (their lane row is already persisted 'failed' and its verification
       * attempt identity must not be reused). A wave-scoped latch makes the FIRST
       * such verdict park every later lane of the same wave without consulting.
       *
       * `needsRevive` is set at the MERGE-GATE sites only: the merge-gate driver
       * durably wrote the lane row 'failed' before `awaitVerdict` resolved, so a
       * rescue there has to un-settle the row before re-driving or the lane would
       * re-run under a 'failed' chip (and the production driver's `resolveItems`
       * would drop it from the next wave's re-resolution). `reviveLane` is
       * status-guarded to 'failed', so passing it on a not-actually-settled lane
       * is a harmless no-op.
       */
      const rescueLaneOrNull = async (
        failingStepId: string,
        failureKind: LaneFailureKind,
        errorExcerpt: string,
        needsRevive = false,
      ): Promise<number | null | { systemic: string }> => {
        const consult = async (): Promise<number | null | { systemic: string }> => {
          // The wave already learned the environment is down (see the latch's
          // declaration): park without consulting and without reserving budget.
          // Read INSIDE the serialized turn, so a lane that failed while a
          // sibling's consult was in flight sees that sibling's verdict.
          if (systemicTriageLatch !== undefined) {
            this.host.log?.(
              'warn',
              `fan-out item '${itemId}': a sibling lane's triage already died on a systemic condition; parking without consulting`,
            );
            return { systemic: systemicTriageLatch };
          }
          const verdict = await consultLaneTriage(
            itemId,
            failingStepId,
            laneAttempt,
            failureKind,
            errorExcerpt,
          );
          if (verdict !== null && typeof verdict === 'object') systemicTriageLatch = verdict.systemic;
          return verdict;
        };
        const turn = triageConsultChain.then(consult, consult);
        triageConsultChain = turn.then(
          () => undefined,
          () => undefined,
        );
        const targetIndex = await turn;
        if (targetIndex === null || typeof targetIndex === 'object') return targetIndex;
        clearStateForRewind(targetIndex);
        if (needsRevive) driver.reviveLane?.({ runId, itemId });
        return targetIndex;
      };

      for (let k = 0; k < inner.length; k++) {
        if (signal?.aborted) return { kind: 'aborted' };
        // Operator LANE REWIND — consult 1 of 3 (IDLE between inner steps). Covers
        // a request that lands while the lane is between turns (mid commit-probe,
        // or in the gap before the next step's lane write). Consulted BEFORE the
        // skip check and before any lane write, so the skipped-over steps are never
        // stamped onto the lane pointer.
        const idleRewind = takeLaneRewind(itemId, k);
        if (idleRewind !== null) {
          clearStateForRewind(idleRewind);
          k = idleRewind - 1; // The loop's k++ lands on the target next.
          continue;
        }
        const innerStep = inner[k];
        // Operator SKIP (RunDirectives): skip this inner step for the lane,
        // mirroring the optional-inner-skip idiom below — advance to the next
        // inner step without driving the lane onto a step the operator suppressed.
        if (this.directives.userSkippedStepIds.has(innerStep.id)) {
          this.host.log?.(
            'warn',
            `fan-out item '${itemId}': step '${innerStep.id}' skipped by operator request`,
          );
          continue;
        }
        // ── Agentless visual-verify step (verification-agent redesign §5.3/§5.7).
        // The in-lane dispatcher subagent is RETIRED — this step spawns NO agent.
        // When verification is active for the run AND task-verify composed a task,
        // the controller enqueues it centrally and PARKS the lane at
        // awaiting-verify; the async merge-gate verdict then advances / loops back /
        // fails. Every skip case (verification inactive, nothing composed, or the
        // scheduler declined) continues the chain WITHOUT parking — byte-identical
        // to a verify-disabled lane. The lane vocabulary + park semantics are
        // unchanged; only the in-lane agent turn is gone.
        if (innerStep.id === SPRINT_VISUAL_VERIFY_STEP) {
          if (!this.host.visualGate?.isActive(runId)) {
            // Verification inactive for the run → skip (never park), as today.
            continue;
          }
          if (this.posture(runId).kind === 'unavailable') {
            // No modality can serve this RUN — declared once at fan-out start (or
            // flipped mid-flight below). Mirror the inactive-gate short-circuit
            // exactly: advance the lane WITHOUT enqueuing and WITHOUT parking. No
            // per-lane finding either; the run-level card already says it.
            this.host.log?.(
              'info',
              `fan-out item '${itemId}': no verifiable modality for this run; skipping visual-verify`,
            );
            continue;
          }
          if (visualVerifyTask === undefined && !adoptedPreFiredRequest) {
            // NOT-APPLICABLE / channel-unavailable / task-verify operator-skipped ⇒
            // nothing to verify: skip the step entirely (no request, no park).
            this.host.log?.('info', `fan-out item '${itemId}': no visual task to verify; skipping visual-verify`);
            continue;
          }
          if (visualVerifyTask !== undefined) {
            const enqueueOutcome = this.host.enqueueVisualVerification
              ? await this.host.enqueueVisualVerification({
                  runId,
                  task: visualVerifyTask,
                  laneTaskRef: itemId,
                  attempt: laneAttempt,
                })
              : ({ outcome: 'skipped', reason: 'no-enqueue-capability' } as const);
            if (enqueueOutcome.outcome === 'skipped') {
              // Verification disabled / scheduler unavailable ⇒ advance WITHOUT parking.
              this.host.log?.(
                'info',
                `fan-out item '${itemId}': visual verification not enqueued (${enqueueOutcome.reason}); advancing`,
              );
              // F8 ("never skip silently"): the enqueue seam declines BEFORE a
              // request row exists, so — unlike a gate-side skip, which writes a
              // 'skipped' row and a verdictDelivery finding — nothing reaches the
              // human. Raise a non-blocking finding for every declined reason
              // EXCEPT 'verification-disabled': a deliberate off switch is not a
              // surprise, and filing one finding per lane per run for it would
              // bury the reasons that are.
              if (enqueueOutcome.reason !== VERIFY_DISABLED_ENQUEUE_REASON) {
                // A decline that names a MODALITY or a RUNBOOK is a fact about the
                // run, not about this lane: flip the posture so the remaining
                // lanes skip the enqueue and their per-lane findings collapse into
                // the single run-level card. (The eager probe at fan-out start is
                // the primary mechanism; this catches what it could not predict.)
                this.maybeFlipPostureUnavailable(runId, enqueueOutcome.reason);
                this.reportVerificationSkipped(
                  runId,
                  itemId,
                  enqueueOutcome.reason,
                  'The composed verification task was declined at the enqueue seam, so NO verification request was created and no visual check ran. The lane advanced regardless (fail-open). Fix the reason above and re-run verification, or verify this deliverable manually.',
                );
              }
              continue;
            }
          } else {
            // Adopted pre-fired request (contract hijack, live-smoke fix
            // 2026-07-22): the misbehaving task-verify turn already enqueued —
            // park on ITS request instead of enqueuing a duplicate; the gate's
            // race-closer resolves it like a controller-enqueued one.
            this.host.log?.(
              'warn',
              `fan-out item '${itemId}': parking on adopted pre-fired verification request`,
            );
          }
          // Enqueued ⇒ park at awaiting-verify + await the async verdict (the
          // merge-gate has already driven the lane by the time this resolves).
          driver.driveLane({
            runId,
            itemId,
            currentStepId: AWAITING_VERIFY_STEP,
            allowedStepIds: parkAllowedStepIds,
          });
          // A lane parked here is blocked on an ASYNC verdict no spawn abort can
          // break, so an operator rewind needs its own wake-up path: park on a
          // per-lane AbortController instead of the run signal directly, chain the
          // run signal into it (so a run cancel still aborts the gate exactly as
          // before), and publish its abort as this lane's UNPARK hook for the
          // duration of the park. RunExecutor.requestLaneRewind fires that hook
          // AFTER recording the request, so the consult below always finds it.
          const parkAbort = new AbortController();
          const onRunAbort = (): void => parkAbort.abort();
          if (signal?.aborted === true) parkAbort.abort();
          else signal?.addEventListener('abort', onRunAbort, { once: true });
          this.directives.laneInterrupts.set(itemId, onRunAbort);
          let outcome: VisualGateOutcome;
          try {
            outcome = await this.host.visualGate.awaitVerdict({
              runId,
              itemId,
              signal: parkAbort.signal,
            });
          } finally {
            this.directives.laneInterrupts.delete(itemId);
            signal?.removeEventListener('abort', onRunAbort);
          }
          // Operator LANE REWIND — consult 3 of 3 (PARKED at the merge gate). The
          // unpark hook above resolves `awaitVerdict` as 'aborted'; this consult is
          // what tells that abort apart from a real run cancellation, so the lane
          // re-drives instead of ending the whole fan-out as canceled.
          if (!signal?.aborted) {
            const parkRewind = takeLaneRewind(itemId, k);
            if (parkRewind !== null) {
              clearStateForRewind(parkRewind);
              k = parkRewind - 1; // The loop's k++ lands on the target next.
              continue;
            }
          }
          if (outcome.kind === 'aborted') return { kind: 'aborted' };
          if (outcome.kind === 'failed') {
            // Budget exhaustion (the merge gate hit its own attempt cap) — consult
            // autonomous lane triage before settling. The gate ALREADY wrote the
            // lane 'failed', hence needsRevive.
            const rescueTarget = await rescueLaneOrNull(
              innerStep.id,
              'merge-gate',
              'the visual merge gate rejected this lane at its attempt cap',
              true,
            );
            // A 'systemic' verdict is treated EXACTLY like `null` here: the merge
            // gate already persisted this lane 'failed' and the verification
            // request that produced the verdict owns the current attempt number,
            // so re-driving it as a parked lane would restart at attempt 1 and
            // dedup onto that terminal request. The lane settles failed; a
            // sibling's inner-step systemic still parks the wave.
            if (typeof rescueTarget === 'number') {
              // A MERGE-GATE rescue must advance the verification attempt: the
              // scheduler's enqueue key is `${runId}:${ref}:${attempt}`, and the
              // request that just FAILED owns the current number — re-enqueueing
              // under it dedups onto that terminal row, so the rescued traversal
              // would be judged on the PRE-rescue tree's stale verdict and fail
              // unconditionally. The bump is the same "genuinely fresh attempt
              // re-fires" contract the normal loopback keeps via
              // `laneAttempt = outcome.attempt`; it grants no loopback budget
              // (the caps were already exhausted at this arm), and the fresh
              // PASS's supersession pass is what resolves the stale blocking
              // finding (it only supersedes LOWER attempts). Synced to the lane
              // row at the target spawn (`loopbackAttemptStepIndex`) so the
              // gate's own DB-side cap keeps reading the true count.
              laneAttempt += 1;
              loopbackAttemptStepIndex = rescueTarget;
              k = rescueTarget - 1; // The loop's k++ lands on the target next.
              continue;
            }
            driver.driveLane({ runId, itemId, status: 'failed', allowedStepIds });
            this.host.log?.('warn', `fan-out item '${itemId}': visual merge-gate FAILED; lane failed`);
            return { kind: 'failed', persisted: true };
          }
          if (outcome.kind === 'loopback') {
            visualLoopbacks += 1;
            // Prefer a declared inner loopback target; retain the historical
            // implement fallback for a custom chain that predates explicit data.
            const declaredTargetIndex = loopbackIndex(innerStep);
            const targetIndex =
              declaredTargetIndex >= 0
                ? declaredTargetIndex
                : inner.findIndex((candidate) => candidate.id === SPRINT_IMPLEMENT_STEP);
            if (
              targetIndex < 0 ||
              visualLoopbacks > MAX_VISUAL_LOOPBACKS ||
              outcome.attempt <= laneAttempt ||
              outcome.attempt > FAN_OUT_LANE_ATTEMPT_CAP
            ) {
              // The defensive re-check refused this loopback — the lane is out of
              // visual-loopback budget (or the verdict is unusable). Consult lane
              // triage before settling, exactly like the 'failed' arm above. The
              // merge-gate driver may already have written the row, so revive
              // defensively (the store's guard makes it a no-op when it has not).
              const rescueTarget = await rescueLaneOrNull(
                innerStep.id,
                'merge-gate',
                `the visual merge gate loopback was refused (attempt ${outcome.attempt}, lane attempt ${laneAttempt}, ${visualLoopbacks} visual loopback(s) used)`,
                true,
              );
              // 'systemic' is treated like `null` for the same reason as the
              // 'failed' arm above (persisted row + attempt identity).
              if (typeof rescueTarget === 'number') {
                // Same verification-attempt advance as the 'failed' arm above —
                // the refused verdict's request owns the current enqueue key, so
                // an un-bumped re-enqueue would dedup onto it and replay the
                // stale verdict against the rescued traversal.
                laneAttempt += 1;
                loopbackAttemptStepIndex = rescueTarget;
                k = rescueTarget - 1; // The loop's k++ lands on the target next.
                continue;
              }
              driver.driveLane({ runId, itemId, status: 'failed', allowedStepIds });
              this.host.log?.('warn', `fan-out item '${itemId}': visual merge-gate loopback exhausted; lane failed`);
              return { kind: 'failed', persisted: true };
            }
            laneAttempt = outcome.attempt;
            loopbackAttemptStepIndex = targetIndex;
            // Thread the gate's failure report to the re-driven implement step so
            // the re-implement agent sees what failed (§5.3), not just that a
            // blocking finding exists. Consumed when the target step builds its ctx.
            pendingLoopbackFeedback = outcome.feedback;
            this.host.log?.(
              'info',
              `fan-out item '${itemId}': visual merge-gate FAIL → '${inner[targetIndex].id}' (attempt ${laneAttempt})`,
            );
            k = targetIndex - 1; // The loop's k++ lands on the target next.
            continue;
          }
          // 'advance' → passed / advisory / skipped: fall through to the next inner
          // step (or lane integration below).
          continue;
        }

        const writeAttempt = loopbackAttemptStepIndex === k ? laneAttempt : undefined;
        driver.driveLane({
          runId,
          itemId,
          currentStepId: innerStep.id,
          allowedStepIds,
          ...(writeAttempt !== undefined ? { attempt: writeAttempt } : {}),
        });
        loopbackAttemptStepIndex = undefined;

        // Synthesize a minimal WorkflowStep for the inner step + thread item
        // context so the spawner scopes the agent to THIS item.
        const synthesized: WorkflowStep = {
          id: innerStep.id,
          name: innerStep.name ?? innerStep.id,
          agent: innerStep.agent,
          mcps: [],
          retries: 0,
          ...(innerStep.optional !== undefined ? { optional: innerStep.optional } : {}),
        };
        const ctx: ControllerStepContext = {
          ...baseCtx,
          attempt: laneAttempt,
          item: { id: itemId, over: fanOut.over },
          // Additive per-lane spawn identity so concurrent lanes each spawn
          // under a distinct key instead of serializing on the shared run
          // panelId (which deadlocks waiting lanes on the spawn mutex).
          spawnKey: `${runId}:${itemId}`,
          // One-shot §5.3 sections, set by a prior task-verify contract defect / a
          // visual-FAIL loopback and consumed by THIS (the re-driven) step, then
          // cleared below so no later step inherits them.
          ...(pendingContractError !== undefined ? { contractError: pendingContractError } : {}),
          ...(pendingLoopbackFeedback !== undefined ? { loopbackFeedback: pendingLoopbackFeedback } : {}),
          // STICKY per-lane rescue guidance (monitor lane triage) — unlike the
          // one-shot sections above it is re-read on EVERY subsequent inner-step
          // spawn of a rescued lane until that lane settles, and it is keyed by
          // ITEM so a sibling lane's prompt is untouched. Absent on every lane
          // that was never rescued (byte-identical prompts).
          ...(laneRescues.guidance.has(itemId)
            ? { laneGuidance: laneRescues.guidance.get(itemId) }
            : {}),
        };
        pendingContractError = undefined;
        pendingLoopbackFeedback = undefined;
        const result = await this.runner.runStep(synthesized, ctx);

        // Operator LANE REWIND — consult 2 of 3 (MID-AGENT-TURN). This is the
        // load-bearing one for a STUCK lane: the handler kills that lane's spawn
        // (its `${runId}:${itemId}` key) to force this await to return, and the
        // spawn rejection surfaces here as a plain `failed` result because the RUN
        // signal never fired. Consulting BEFORE the aborted/failed handling is what
        // stops that operator-induced failure from consuming a loopback attempt or
        // failing the lane outright. Guarded on the run signal so a genuine run
        // cancellation still wins (the request simply stays unread on a dying run).
        if (!signal?.aborted) {
          const stepRewind = takeLaneRewind(itemId, k);
          if (stepRewind !== null) {
            clearStateForRewind(stepRewind);
            k = stepRewind - 1; // The loop's k++ lands on the target next.
            continue;
          }
        }

        if (result.status === 'aborted') return { kind: 'aborted' };
        if (result.status === 'failed') {
          // Systemic (env-level) failure: NOT this lane's defect. Do not fail the
          // lane and do not skip even an optional inner step — bubble up so the wave
          // loop parks the whole fan-out and re-dispatches once the condition clears.
          if (result.systemic === true) {
            this.host.log?.('warn', `fan-out item '${itemId}': step '${innerStep.id}' hit a systemic failure; pausing`);
            return { kind: 'systemic', ...(result.error !== undefined ? { error: result.error } : {}) };
          }
          if (innerStep.optional === true) {
            this.host.log?.('warn', `fan-out item '${itemId}': optional step '${innerStep.id}' failed; skipping`);
            continue;
          }
          const targetIndex = loopbackIndex(innerStep);
          if (targetIndex >= 0 && laneAttempt < FAN_OUT_LANE_ATTEMPT_CAP) {
            laneAttempt += 1;
            loopbackAttemptStepIndex = targetIndex;
            this.host.log?.(
              'info',
              `fan-out item '${itemId}': step '${innerStep.id}' failed; looping back to '${inner[targetIndex].id}' (attempt ${laneAttempt})`,
            );
            k = targetIndex - 1; // The loop's k++ lands on the target next.
            continue;
          }
          // The lane's loopback budget is spent (or it declares no target) — the
          // one genuine exhaustion of an inner step. Consult lane triage before
          // settling; a rescue re-drives from the supervisor's target with
          // guidance, without bumping laneAttempt.
          const rescueTarget = await rescueLaneOrNull(
            innerStep.id,
            'inner-step',
            result.error ?? '(no error text)',
          );
          // The triage consult itself died on an environment condition: the lane
          // row has NOT been written 'failed' at this arm, so bubble up and let
          // the wave loop park the whole fan-out (and re-dispatch on 'retry').
          if (rescueTarget !== null && typeof rescueTarget === 'object') {
            return { kind: 'systemic', error: rescueTarget.systemic };
          }
          if (rescueTarget !== null) {
            k = rescueTarget - 1; // The loop's k++ lands on the target next.
            continue;
          }
          // The 'failed' WRITE IS DEFERRED to the wave settle (see
          // SAME_ERROR_CORROBORATION_MIN): this is the arm an environment failure
          // reaches when it is not a recognised systemic shape, and writing here
          // would stamp — and emit a lane event for — a failure the corroboration
          // pass may be about to reclassify as environmental. Every other failing
          // arm has already written and is excluded from corroboration.
          this.host.log?.(
            'warn',
            `fan-out item '${itemId}': step '${innerStep.id}' failed${targetIndex >= 0 ? ' (attempt cap reached)' : ''}; settling after the wave`,
          );
          return {
            kind: 'failed',
            persisted: false,
            ...(result.error !== undefined ? { error: result.error } : {}),
          };
        }

        // Code-review typed output (Item 0): on a CLEAN (status:'ok') code-review
        // turn, parse its captured result text for the `REVIEW:` verdict line. A
        // review that "successfully found problems" returns status 'ok' — so
        // without this the `## Blocking` defects it lists would be treated as
        // success and the lane would advance, and code-review's declared
        // `loopback: 'implement'` (which only fires on a FAILED step result) would
        // never trigger. Route `REVIEW: BLOCKING` into the SAME non-systemic
        // loopback path a failed step / a task-verify FAIL takes (declared loopback
        // → laneAttempt bump → 3× cap → fail), threading the `## Blocking` section
        // into the re-driven `implement` step as one-shot loopback feedback. A
        // substrate that cannot capture final text (interactive; codex captures it
        // since F1) yields no verdict line → treated as CLEAN (channel unavailable),
        // exactly as the task-verify FAIL channel degrades there.
        if (innerStep.id === SPRINT_CODE_REVIEW_STEP) {
          const resultText = result.resultText;
          if (resultText !== null && resultText !== undefined) {
            const verdict = parseCodeReviewVerdict(resultText);
            // Fail SAFE on a trailer-less turn (Codex review, Item 0 hardening):
            // the agent md REQUIRES a `REVIEW:` last line, but a truncated /
            // forgetful SDK turn can populate a `## Blocking` section yet DROP the
            // trailer — parseCodeReviewVerdict yields null there. Treat a NON-EMPTY
            // `## Blocking` section as blocking anyway, so a real must-fix defect
            // can't ship just because the machine trailer was lost. An EXPLICIT
            // `REVIEW: CLEAN` (verdict 'clean', not null) is trusted as-is, so a
            // clean review whose template prints an empty "## Blocking" heading
            // never false-loops — only the AMBIGUOUS no-trailer case falls back.
            const blocking =
              verdict === 'blocking' ||
              (verdict === null && extractBlockingSection(resultText) !== null);
            if (blocking) {
              // Log-only label: distinguish the explicit trailer from the
              // trailer-less `## Blocking` fail-safe so a debug trace shows which
              // channel drove the loopback.
              const signal = verdict === 'blocking' ? 'REVIEW: BLOCKING' : '## Blocking (no trailer)';
              const targetIndex = loopbackIndex(innerStep);
              if (targetIndex >= 0 && laneAttempt < FAN_OUT_LANE_ATTEMPT_CAP) {
                laneAttempt += 1;
                loopbackAttemptStepIndex = targetIndex;
                pendingLoopbackFeedback = extractBlockingSection(resultText) ?? resultText;
                this.host.log?.(
                  'info',
                  `fan-out item '${itemId}': code-review ${signal}; looping back to '${inner[targetIndex].id}' (attempt ${laneAttempt})`,
                );
                k = targetIndex - 1; // The loop's k++ lands on the target next.
                continue;
              }
              // Code-review keeps reporting blocking defects and the loopback
              // budget is spent — consult lane triage before settling. The
              // excerpt is the `## Blocking` section (the defects themselves),
              // falling back to the whole result text.
              const rescueTarget = await rescueLaneOrNull(
                innerStep.id,
                'code-review',
                extractBlockingSection(resultText) ?? resultText,
              );
              // Nothing is persisted at this arm yet — park, don't fail.
              if (rescueTarget !== null && typeof rescueTarget === 'object') {
                return { kind: 'systemic', error: rescueTarget.systemic };
              }
              if (rescueTarget !== null) {
                k = rescueTarget - 1; // The loop's k++ lands on the target next.
                continue;
              }
              driver.driveLane({ runId, itemId, status: 'failed', allowedStepIds });
              this.host.log?.(
                'warn',
                `fan-out item '${itemId}': code-review ${signal}; lane failed${targetIndex >= 0 ? ' (attempt cap reached)' : ''}`,
              );
              return { kind: 'failed', persisted: true };
            }
          }
        }

        // Task-verify typed output (verification-agent redesign §5.3): on a clean
        // task-verify turn, consume its captured result text to (a) route a
        // VERDICT: FAIL back into the loopback path — a gap programmatic mode never
        // saw before — and (b) compose the visual-verification task the agentless
        // visual-verify step below will enqueue. (a) runs UNCONDITIONALLY: the
        // functional acceptance verdict is orthogonal to visual verification, so
        // disabling the visual gate must not disable verdict enforcement. (b) —
        // fence parsing, §5.1 contract enforcement, and pre-fired adoption — stays
        // gated on the gate being active; a disabled run parses fences leniently
        // (any fence text is simply ignored, never a contract failure).
        if (innerStep.id === SPRINT_TASK_VERIFY_STEP) {
          const visualActive = this.host.visualGate?.isActive(runId) === true;
          // Every fresh task-verify result supersedes a prior adoption decision.
          adoptedPreFiredRequest = false;
          const resultText = result.resultText;
          if (resultText === null || resultText === undefined) {
            // No final text: either a substrate that cannot capture it (interactive;
            // codex captures it since F1) or a clean turn that said nothing. No
            // verdict channel exists, so FAIL routing stays unavailable, and visual
            // verification fails OPEN for this lane (channel-unavailable) — with a
            // non-blocking finding so the silence is visible (F8).
            //
            // F8 ("never skip silently", docs/proposals/visual-verification-
            // brittleness-fixes.md): this drop happens BEFORE any request row
            // exists, so the verify queue and the DB show nothing at all — the
            // single largest reason visual verification "never runs" is invisible
            // in the product. Raise a NON-BLOCKING finding naming the reason
            // verbatim. Lane advancement is untouched.
            if (visualActive) {
              this.host.log?.(
                'warn',
                `fan-out item '${itemId}': task-verify produced no result text; skipping visual verification (channel unavailable)`,
              );
              this.reportVerificationSkipped(
                runId,
                itemId,
                'the task-verify step produced no result text, so no verification task could be composed',
                'The task-verify turn produced no final agent text (an interactive substrate does not capture it; a Codex or Claude turn that ended without a message also yields none), so the `## Visual verification task` fence never reached the controller. No verification request was created for this lane and no visual check ran — the lane advanced regardless. Re-run the task, or verify the deliverable manually.',
              );
              visualVerifyTask = undefined;
            }
          } else {
            const verdict = parseTaskVerifyVerdict(resultText);
            if (verdict === 'fail') {
              // Route into the SAME non-systemic failure/loopback path a failed step
              // result takes (declared loopback → laneAttempt bump → 3× cap → fail).
              const targetIndex = loopbackIndex(innerStep);
              if (targetIndex >= 0 && laneAttempt < FAN_OUT_LANE_ATTEMPT_CAP) {
                laneAttempt += 1;
                loopbackAttemptStepIndex = targetIndex;
                this.host.log?.(
                  'info',
                  `fan-out item '${itemId}': task-verify VERDICT: FAIL; looping back to '${inner[targetIndex].id}' (attempt ${laneAttempt})`,
                );
                k = targetIndex - 1; // The loop's k++ lands on the target next.
                continue;
              }
              // task-verify keeps returning FAIL and the loopback budget is spent
              // — consult lane triage before settling. The excerpt is the verify
              // agent's own result text (its verdict + fix guidance).
              const rescueTarget = await rescueLaneOrNull(innerStep.id, 'task-verify', resultText);
              // Nothing is persisted at this arm yet — park, don't fail.
              if (rescueTarget !== null && typeof rescueTarget === 'object') {
                return { kind: 'systemic', error: rescueTarget.systemic };
              }
              if (rescueTarget !== null) {
                k = rescueTarget - 1; // The loop's k++ lands on the target next.
                continue;
              }
              driver.driveLane({ runId, itemId, status: 'failed', allowedStepIds });
              this.host.log?.(
                'warn',
                `fan-out item '${itemId}': task-verify VERDICT: FAIL; lane failed${targetIndex >= 0 ? ' (attempt cap reached)' : ''}`,
              );
              return { kind: 'failed', persisted: true };
            }
            if (verdict === null) {
              this.host.log?.(
                'warn',
                `fan-out item '${itemId}': task-verify result had no VERDICT line; treating as PASS`,
              );
            }
            // Fence handling below is visual-gate-scoped: with the gate off there
            // is no visual task to compose and the §5.1 fence contract is NOT
            // enforced — a run that never asked for visual verification must not
            // fail its lanes over a missing fence.
            if (visualActive) {
              // PASS (or no explicit verdict): the §5.1 contract requires EXACTLY
              // ONE of a `## Visual verification task` fence or a NOT-APPLICABLE
              // line — a missing/malformed one is an output-contract failure,
              // NEVER silently "nothing to verify" (a truncated response must not
              // bypass the gate).
              const section = parseVisualTaskSection(resultText);
              if (section.kind === 'task') {
                visualVerifyTask = section.task;
              } else if (section.kind === 'not_applicable') {
                visualVerifyTask = undefined;
                this.host.log?.(
                  'info',
                  `fan-out item '${itemId}': visual verification NOT-APPLICABLE${section.reason ? ` (${section.reason})` : ''}`,
                );
              } else if (this.host.visualGate?.hasLiveRequestForLane?.(runId, itemId) === true) {
                // 'missing' | 'contract_error' BUT a LIVE lane-attributed request
                // exists: the misbehaving turn FIRED the request itself instead of
                // printing the fence (pre-fired hijack, observed live 2026-07-22 —
                // belt-and-suspenders behind the spawn-level tool denial). The
                // verification is already underway with this attempt's content, so
                // adopt it — the visual-verify step parks on it — rather than
                // re-running task-verify into the same defect and racing the
                // merge-gate against the contract-retry loop.
                adoptedPreFiredRequest = true;
                this.host.log?.(
                  'warn',
                  `fan-out item '${itemId}': task-verify violated the output contract but a live lane-attributed verification request exists; adopting it`,
                );
              } else {
                // 'missing' | 'contract_error' → re-run task-verify ONCE with the
                // defect threaded; a SECOND violation fails the lane.
                if (laneContractRetries >= 1) {
                  driver.driveLane({ runId, itemId, status: 'failed', allowedStepIds });
                  this.host.log?.(
                    'warn',
                    `fan-out item '${itemId}': task-verify violated the visual-verification output contract twice; lane failed`,
                  );
                  return { kind: 'failed', persisted: true };
                }
                laneContractRetries += 1;
                pendingContractError =
                  section.kind === 'contract_error'
                    ? section.error
                    : 'no "## Visual verification task" section and no VISUAL-VERIFICATION: NOT-APPLICABLE line';
                this.host.log?.(
                  'warn',
                  `fan-out item '${itemId}': task-verify visual-verification contract defect; re-running task-verify`,
                );
                k = k - 1; // Re-run the SAME task-verify step (the loop's k++ lands on it).
                continue;
              }
            }
          }
        }
      }

      // Every inner step returned ok — but 'integrated' claims "complete AND
      // committed in the session worktree" (sprintLaneStore.ts), which step
      // verdicts alone cannot establish: a lane whose `git commit` was denied by
      // a permission gate reported green with its changes untracked on disk
      // (observed live). Consult the probe before making that claim.
      if (commitProbe !== undefined) {
        try {
          const reading = await commitProbe();
          // Deliberately conservative: sibling lanes commit into the SAME
          // worktree, so an advanced HEAD is not proof THIS lane committed, and a
          // clean tree may mean a sibling committed our work along with its own.
          // Only the unambiguous case — nothing committed at all AND changes still
          // sitting uncommitted — withholds 'integrated'. Per-lane attribution
          // would need per-lane commit ranges the fan-out does not have.
          if (!reading.headAdvanced && reading.dirty) {
            driver.driveLane({ runId, itemId, status: 'failed', allowedStepIds });
            this.host.log?.(
              'error',
              `fan-out item '${itemId}': completed all inner steps but made no git commit and left uncommitted changes in the worktree — refusing to mark integrated`,
            );
            return { kind: 'failed', persisted: true };
          }
        } catch (err) {
          this.host.log?.(
            'warn',
            `fan-out item '${itemId}': commit-integrity probe failed (${err instanceof Error ? err.message : String(err)}); integrating on step verdicts alone`,
          );
        }
      }

      driver.driveLane({ runId, itemId, status: 'integrated', allowedStepIds });
      return { kind: 'done' };
    };

    // DAG-aware wave scheduling: dispatch a task only once ALL of its in-scope
    // blocking prerequisites have INTEGRATED. A task whose prerequisite FAILED can
    // never satisfy its preconditions, so its lane is marked failed (blocked) and
    // counts as incomplete. When the driver exposes no dependencies (or an empty
    // map) every task is ready immediately, so this degrades to flat cap-sized waves
    // — byte-identical to the pre-DAG behavior for non-dependency fan-outs.
    // Prerequisites are restricted to the in-scope item set; an out-of-scope prereq
    // (e.g. a task already integrated in a prior run and excluded from `items`) is
    // treated as satisfied.
    const inScope = new Set(items);
    let rawDeps: Map<string, string[]> | undefined;
    try {
      rawDeps = driver.dependencies?.(runId, fanOut.over);
    } catch (err) {
      this.host.log?.(
        'warn',
        `fan-out dependencies('${fanOut.over}') threw; running without DAG ordering: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const prereqs = new Map<string, string[]>();
    for (const itemId of items) {
      prereqs.set(itemId, (rawDeps?.get(itemId) ?? []).filter((p) => inScope.has(p) && p !== itemId));
    }

    const readExpectedFiles = (): Map<string, string[]> | undefined => {
      try {
        return driver.expectedFiles?.(runId, fanOut.over);
      } catch (err) {
        this.host.log?.(
          'warn',
          `fan-out expectedFiles('${fanOut.over}') threw; running without file-conflict serialization: ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }
    };
    let expectedFiles = readExpectedFiles();

    const integrated = new Set<string>();
    // Two DIFFERENT terminal settlements, deliberately not one set:
    //   `failed`  — the lane EXECUTED and did not succeed (its own defect, a
    //               systemic give-up, a spent pause budget). A human reading the
    //               gate needs to see its error.
    //   `blocked` — the lane NEVER STARTED because something it depends on did
    //               not finish. Reporting that as 'failed' manufactures defects
    //               out of a dependency graph: one real failure at the root of a
    //               fan-out used to stamp 'failed' on every descendant, which is
    //               how a single bad lane read as a whole-sprint collapse.
    const failed = new Set<string>();
    const blocked = new Set<string>();
    // MUTABLE (reassigned each wave by the live re-resolution below), so the
    // mark* closures + the settle loop always see the current working set.
    let remaining = new Set(items);
    let incompleteCount = 0;

    /**
     * Settle a lane that NEVER STARTED because a prerequisite did not finish.
     * Writes 'blocked' (not 'failed'), so the lane row, the board chip and the
     * partial-sprint gate summary all say "never started" rather than blaming
     * the task. Still counts incomplete: the sprint did not finish its work.
     */
    const markBlocked = (itemId: string, reason: string): void => {
      driver.driveLane({ runId, itemId, status: 'blocked', allowedStepIds });
      this.host.log?.('warn', `fan-out item '${itemId}': ${reason}; lane blocked`);
      remaining.delete(itemId);
      blocked.add(itemId);
      incompleteCount += 1;
    };

    /**
     * Settle a lane that DID execute and could not be completed — the systemic
     * give-up / exhausted-pause-budget / no-pause-seam path. These lanes ran real
     * agent turns against a real condition, so they stay 'failed': calling them
     * "never started" would hide the very failure the human is being asked about.
     */
    const markFailed = (itemId: string, reason: string): void => {
      driver.driveLane({ runId, itemId, status: 'failed', allowedStepIds });
      this.host.log?.('warn', `fan-out item '${itemId}': ${reason}; lane failed`);
      remaining.delete(itemId);
      failed.add(itemId);
      incompleteCount += 1;
    };

    // ── ROLLING DISPATCH POOL ─────────────────────────────────────────────────
    // Lanes are dispatched the MOMENT a slot frees, not at a wave boundary: the
    // old `Promise.all` barrier made every lane of a generation wait for its
    // slowest sibling, so a 40-minute lane in slot 5 idled four agents and
    // stranded its dependents behind work they did not depend on.
    //
    // Everything the wave barrier used to provide for free is re-provided here
    // explicitly, because "the wave" meant four different things:
    //   - a CONCURRENCY window        → `inFlight` + the per-iteration cap read;
    //   - a FILE-EXCLUSION window     → `claimedFiles`, released on settle;
    //   - a CORROBORATION window      → `deferred` cohorts + SAME_ERROR_COHORT_MAX_MS;
    //   - a QUIESCED instant at which
    //     the park / prune / flush were
    //     provably safe                → the `inFlight.size === 0` drain below.

    /** Wall clock, seam-injected so the cohort ceiling is testable. */
    const nowMs = (): number => this.host.now?.() ?? Date.now();

    /** itemId → its live walk. Resolves to `[itemId, outcome]` so `race` names the winner. */
    const inFlight = new Map<string, Promise<[string, LaneWalkOutcome]>>();
    /**
     * Expected file path → the IN-FLIGHT lane holding it. The wave loop's
     * exclusion set was per-wave; here a claim is taken at dispatch and released
     * at settle, so a lane blocked on `src/shared.ts` starts the instant its
     * holder finishes rather than at the next wave boundary.
     */
    const claimedFiles = new Map<string, string>();
    /**
     * Lanes whose 'failed' write is HELD pending corroboration (the
     * `persisted: false` arm). `cohort` is the set of lanes that were still in
     * flight when this one settled: while any of them is live, an identical text
     * may still arrive and prove the failure environmental. The hold ends when
     * the cohort drains, when SAME_ERROR_CORROBORATION_MIN is reached, or when
     * SAME_ERROR_COHORT_MAX_MS elapses — whichever comes first.
     */
    const deferred = new Map<string, { error: string; cohort: Set<string>; heldSince: number }>();
    /**
     * Systemic failure texts inside the live corroboration window, so a lane that
     * the classifier caught can still corroborate a sibling the classifier missed
     * (the `group.systemic > 0` arm). Bounded by the SAME ceiling as a cohort and
     * cleared on every park settlement: without a bound, a minute-1 quota text
     * would corroborate a minute-50 review failure.
     */
    let systemicSeen: Array<{ error: string; at: number }> = [];
    /**
     * Lanes settled on a SYSTEMIC condition (or reclassified as one by
     * corroboration), waiting for the pool to quiesce so the human is asked once.
     * They stay in `remaining`, uncounted, and re-dispatch on 'retry'.
     */
    let parkPending: { error?: string; items: Set<string> } | undefined;
    /** No new lane may be dispatched: a systemic park is open, or the walk is aborting. */
    let holdDispatch = false;
    /** A lane returned 'aborted', or the signal fired — the walk is terminal. */
    let sawAborted = false;

    /** Persist a lane's own 'failed' verdict (the write the hold was deferring). */
    const settleFailed = (itemId: string, countIncomplete: boolean): void => {
      driver.driveLane({ runId, itemId, status: 'failed', allowedStepIds });
      remaining.delete(itemId);
      failed.add(itemId);
      if (countIncomplete) incompleteCount += 1;
    };

    /**
     * Release ONE held 'failed' write. Deletes the map entry first, so every path
     * that can reach a deferred item (settle flush, drain, abort) writes it at
     * most once — invariant: a deferred write is flushed exactly once, never lost.
     */
    const flushDeferred = (itemId: string, countIncomplete: boolean): void => {
      if (!deferred.delete(itemId)) return;
      settleFailed(itemId, countIncomplete);
    };

    /** Wrap a lane walk so a THROW fails that lane alone (never the whole pool). */
    const runLane = (itemId: string): Promise<[string, LaneWalkOutcome]> =>
      driveItem(itemId).then(
        (outcome): [string, LaneWalkOutcome] => [itemId, outcome],
        (err): [string, LaneWalkOutcome] => [
          itemId,
          {
            kind: 'failed',
            error: err instanceof Error ? err.message : String(err),
            persisted: false,
          },
        ],
      );

    while (remaining.size > 0 || inFlight.size > 0) {
      // 1 ── Cancellation stops DISPATCH, not the loop: in-flight lanes are drained
      // below so their held writes are flushed before the walk returns.
      if (signal?.aborted) {
        sawAborted = true;
        holdDispatch = true;
      }

      // ── Live fan-out re-resolution (add_task / remove_task enabler) ─────────
      // Re-resolve the item set at each pool iteration so a lane ADDED or REMOVED
      // mid-run is honored at the next free slot, rather than the frozen `items`
      // snapshot the caller passed. Recompute `remaining` = fresh − settled,
      // iterating `fresh` in resolve order so dispatch order is preserved. For a
      // STATIC batch `fresh` equals `items` on every call, so `remaining` equals
      // `items − settled`: a settled lane sits in `integrated`/`failed`; a
      // systemic-paused or corroboration-held lane (DB status still 'running', so
      // the production driver keeps returning it) stays in `fresh` and is
      // preserved; a removed QUEUED lane vanishes from `fresh` before dispatch; an
      // added lane appears and joins the pool. Already-settled lanes are never
      // re-dispatched or un-settled (they are excluded by the settled filter), and
      // an IN-FLIGHT lane is re-added unconditionally — a lane removed from the
      // set while it is running must still settle its own bookkeeping.
      // Fail-soft: a throw keeps the current set (degrade to the frozen snapshot
      // rather than crash the walk), mirroring the caller's resolveItems contract.
      let fresh: string[] | undefined;
      try {
        fresh = driver.resolveItems(runId, fanOut.over);
      } catch (err) {
        this.host.log?.(
          'warn',
          `fan-out re-resolveItems('${fanOut.over}') threw; keeping the current lane set: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (fresh !== undefined) {
        // Newly-appeared lanes (added since the last iteration): extend the
        // in-scope set + resolve their blocking prereqs ONCE so they are DAG-gated
        // like any other lane. Guarded on ACTUAL growth so a static batch never
        // re-reads dependencies (and a fan-out whose driver exposes none is
        // untouched).
        const appeared = fresh.filter((id) => !inScope.has(id));
        if (appeared.length > 0) {
          for (const id of fresh) inScope.add(id);
          let freshDeps: Map<string, string[]> | undefined;
          try {
            freshDeps = driver.dependencies?.(runId, fanOut.over);
          } catch (err) {
            this.host.log?.(
              'warn',
              `fan-out re-dependencies('${fanOut.over}') threw; added lanes run without DAG ordering: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          for (const id of appeared) {
            prereqs.set(id, (freshDeps?.get(id) ?? []).filter((p) => inScope.has(p) && p !== id));
          }
          // Added lanes need the same file-conflict constraint as the original
          // batch. Refresh the task-file map only when the item set grows; static
          // batches retain the initial DB read.
          const freshExpectedFiles = readExpectedFiles();
          if (freshExpectedFiles !== undefined) expectedFiles = freshExpectedFiles;
        }
        // Rebuild the working set: keep only not-yet-settled lanes, in resolve
        // order (a removed queued lane is simply absent from `fresh`; a settled
        // lane is filtered by integrated/failed/blocked).
        remaining = new Set(
          fresh.filter((id) => !integrated.has(id) && !failed.has(id) && !blocked.has(id)),
        );
        // A live lane is never dropped from bookkeeping by a mid-flight removal.
        for (const liveId of inFlight.keys()) remaining.add(liveId);
        if (remaining.size === 0 && inFlight.size === 0) break;
      }

      // ── SHARED BUILD-BREAK SWEEP: the quiesced instant ────────────────────
      // Nothing is in flight, so every lane that has settled has had time for its
      // `cyboflow_report_finding` write to reach the ReviewItemRouter queue. That
      // timing is the whole reason this is not a per-lane-settle sweep: the MCP
      // handler replies ok:true WITHOUT awaiting the per-project queue, so with
      // two lanes the second one's finding — exactly the one the threshold needs
      // — is exactly the one most likely to be missing at its own settle.
      //
      // Runs BEFORE dispatch (and so before the park/prune decision further down
      // this iteration) and is idempotent per run on the group's normalized text,
      // so repeating it at every quiesce costs one indexed read and files nothing
      // twice. DETECTOR ONLY: it changes no dispatch, park or prune decision.
      if (inFlight.size === 0) await this.sweepBuildBreaks(runId);

      // ── DISPATCH ──────────────────────────────────────────────────────────
      // Fill every free slot, in resolve order, with lanes that are READY (all
      // in-scope blocking prerequisites INTEGRATED — never merely settled), not
      // already live, not held by corroboration, not parked, and whose expected
      // files no LIVE lane holds. Readiness stays a PURE read: a lane whose
      // prerequisite died is simply not dispatched — nothing is written here.
      // Settling a descendant the moment its parent fails is what made one failure
      // look like many, and it is premature besides, since an operator can still
      // rewind or reset the parent while the pool runs other work.
      // Resolve order is preserved: a file-overlapping lane is skipped while later
      // disjoint lanes still fill the pool. No expected-file data means every ready
      // lane is eligible. The cap is re-read every iteration, so a live spec edit
      // takes effect at the next slot.
      const cap = effectiveMaxConcurrency(fanOut);
      if (!holdDispatch) {
        for (const itemId of remaining) {
          if (inFlight.size >= cap) break;
          if (inFlight.has(itemId) || deferred.has(itemId)) continue;
          if (parkPending?.items.has(itemId) === true) continue;
          const ps = prereqs.get(itemId) ?? [];
          if (ps.some((p) => failed.has(p) || blocked.has(p))) continue;
          if (!ps.every((p) => integrated.has(p))) continue;
          const files = expectedFiles?.get(itemId) ?? [];
          if (files.some((filePath) => claimedFiles.has(filePath))) continue;
          for (const filePath of files) claimedFiles.set(filePath, itemId);
          // A re-dispatched lane is no longer a settled failure: drop its own held
          // entry AND its membership of every other lane's cohort, so nothing can
          // flush a 'failed' write for a lane that is running, and no cohort is
          // held open by a lane that re-entered the pool.
          deferred.delete(itemId);
          for (const held of deferred.values()) held.cohort.delete(itemId);
          inFlight.set(itemId, runLane(itemId));
        }
      }

      // ── DRAIN: the quiesced instant ───────────────────────────────────────
      // Nothing is live, so a park, a prune and a flush are all provably safe
      // here and nowhere else. Order is load-bearing: abort wins over everything
      // (the run is terminal either way), then the systemic park, and only then
      // the prune — a park evaluated AFTER the prune would let the last in-flight
      // lane's systemic failure be relabelled "unresolvable dependencies (cycle?)"
      // and the human would never be asked.
      if (inFlight.size === 0) {
        // Any hold whose cohort cannot grow again is over: flush before deciding
        // anything, so no held lane is ever mistaken for a stranded one.
        for (const itemId of [...deferred.keys()]) {
          if (parkPending?.items.has(itemId) === true) continue;
          flushDeferred(itemId, true);
        }

        if (sawAborted) {
          // Cancellation: persist the held writes (a lane left 'running' in the
          // store forever is the failure mode this exists for), then stop. No
          // corroboration and no park — the run is terminal either way.
          for (const itemId of [...deferred.keys()]) flushDeferred(itemId, false);
          return { terminal: true, incompleteCount };
        }

        if (parkPending !== undefined) {
          // One or more lanes settled on a SYSTEMIC condition. Park the WHOLE
          // fan-out on it (bounded per outer step id by MAX_SYSTEMIC_PAUSES)
          // rather than failing them — the condition is environment-level, not a
          // per-task defect.
          const parked = [...parkPending.items];
          const parkError = parkPending.error;
          const used = systemicPauses.get(step.id) ?? 0;
          // Park only when budget remains AND the human has not already GIVEN UP
          // on this outer step's systemic pause. Once giveup is latched, a later
          // systemic hit on the SAME outer step skips the pause and fails its
          // parked lanes directly — no second blocking pause item to dismiss.
          if (this.host.awaitSystemicPause && used < MAX_SYSTEMIC_PAUSES && !systemicGiveUps.has(step.id)) {
            systemicPauses.set(step.id, used + 1);
            this.host.log?.(
              'warn',
              `fan-out '${step.id}' hit a systemic failure on ${parked.length} lane(s); pausing the run: ${parkError ?? '(no error text)'}`,
            );
            const verdict = await this.host.awaitSystemicPause(step, { ...baseCtx, attempt: 1 }, parkError);
            if (verdict === 'canceled' || signal?.aborted) return { terminal: true, incompleteCount };
            if (verdict === 'retry') {
              // Un-park: the still-in-`remaining` items re-dispatch next iteration.
              // v1 simplification: driveItem restarts a paused lane from inner step
              // 0 (re-running any already-passed inner steps) — safe because step
              // agents observe the worktree state rather than in-memory progress.
              parkPending = undefined;
              holdDispatch = false;
              systemicTriageLatch = undefined;
              systemicSeen = [];
              continue;
            }
            // 'giveup' — latch it so a later systemic hit on this outer step does
            // NOT re-park, then fall through and fail the still-parked lanes.
            systemicGiveUps.add(step.id);
          }
          // Seam absent, budget exhausted, or 'giveup': these lanes EXECUTED and
          // hit a real condition, so they settle 'failed' (markFailed) — never
          // 'blocked', which would report an agent turn that actually ran against
          // a dead environment as a lane that never started.
          for (const itemId of parked) {
            if (remaining.has(itemId)) markFailed(itemId, 'systemic failure — gave up waiting');
          }
          // The park is OVER even though no human resumed it. Clearing the triage
          // latch and the systemic-text window here is what keeps one dead consult
          // from silently parking (and then failing) every later lane of the run:
          // the next lane to exhaust a budget gets a real consult again.
          parkPending = undefined;
          holdDispatch = false;
          systemicTriageLatch = undefined;
          systemicSeen = [];
          continue;
        }

        if (remaining.size > 0) {
          // NOTHING is dispatchable, nothing is live, and lanes remain: only now
          // is a lane's wait provably permanent. Prune to a fixpoint so a chain
          // A→B→C names the right culprit at each link (B waits on a FAILED A, C
          // on a BLOCKED B) instead of collapsing everything into "cycle?".
          let progressed = true;
          while (progressed) {
            progressed = false;
            for (const itemId of [...remaining]) {
              const ps = prereqs.get(itemId) ?? [];
              const dead = ps.find((p) => failed.has(p) || blocked.has(p));
              if (dead === undefined) continue;
              markBlocked(
                itemId,
                failed.has(dead)
                  ? `never started: prerequisite '${dead}' failed`
                  : `never started: prerequisite '${dead}' was never started`,
              );
              progressed = true;
            }
          }
          // Whatever is left waits on a prerequisite that is neither settled nor
          // dispatchable — a cycle, or a prereq outside this fan-out that never runs.
          for (const itemId of [...remaining]) {
            markBlocked(itemId, 'unresolvable blocking dependencies (cycle?)');
          }
        }
        break;
      }

      // ── SETTLE one lane ───────────────────────────────────────────────────
      const [settledId, outcome] = await Promise.race(inFlight.values());
      inFlight.delete(settledId);
      for (const [filePath, owner] of [...claimedFiles]) {
        if (owner === settledId) claimedFiles.delete(filePath);
      }
      // This lane can no longer corroborate anyone: close it out of every cohort.
      for (const held of deferred.values()) held.cohort.delete(settledId);

      const settledAt = nowMs();
      if (outcome.kind === 'aborted') {
        sawAborted = true;
        holdDispatch = true;
      } else if (outcome.kind === 'systemic') {
        const park = parkPending ?? { items: new Set<string>() };
        park.items.add(settledId);
        // Prefer a genuinely systemic lane's own text for the park (last wins,
        // as the wave loop's reduce did); a corroborated group only fills in
        // below when no systemic lane supplied one.
        if (outcome.error !== undefined) park.error = outcome.error;
        parkPending = park;
        const text = outcome.error?.trim();
        if (text !== undefined && text.length > 0) systemicSeen.push({ error: text, at: settledAt });
        // A systemic condition quiesces the pool: no lane may be dispatched into
        // a dead environment while the human is being asked about it.
        holdDispatch = true;
      } else if (outcome.kind === 'failed') {
        const text = outcome.error?.trim();
        if (outcome.persisted) {
          remaining.delete(settledId);
          failed.add(settledId);
          incompleteCount += 1;
        } else if (text === undefined || text.length === 0) {
          // Nothing to corroborate against — settle it now, exactly as the wave
          // loop's settle pass did for a text-less outcome.
          settleFailed(settledId, true);
        } else {
          deferred.set(settledId, {
            error: text,
            cohort: new Set(inFlight.keys()),
            heldSince: settledAt,
          });
        }
      } else {
        remaining.delete(settledId);
        integrated.add(settledId);
      }

      // ── CORROBORATION ─────────────────────────────────────────────────────
      // Group the HELD failures (and the systemic texts still inside the window)
      // by EXACT trimmed error text. A group is corroborated when it holds at
      // least SAME_ERROR_CORROBORATION_MIN lanes, or when one of its members
      // already failed systemically — independent lanes cannot produce
      // byte-identical failure text by coincidence, whatever the classifier makes
      // of the words. A corroborated failure is reclassified systemic: never
      // written 'failed', it stays in `remaining` and re-runs once the condition
      // clears.
      //
      // The window is what the wave barrier used to supply for free. Only holds
      // and systemic texts younger than SAME_ERROR_COHORT_MAX_MS take part, so
      // failures far apart in time can never fuse.
      const windowStart = settledAt - SAME_ERROR_COHORT_MAX_MS;
      const groups = new Map<string, { items: string[]; systemic: number }>();
      for (const [itemId, held] of deferred) {
        if (parkPending?.items.has(itemId) === true) continue;
        if (held.heldSince <= windowStart) continue;
        const group = groups.get(held.error) ?? { items: [], systemic: 0 };
        group.items.push(itemId);
        groups.set(held.error, group);
      }
      for (const seen of systemicSeen) {
        if (seen.at <= windowStart) continue;
        const group = groups.get(seen.error) ?? { items: [], systemic: 0 };
        group.systemic += 1;
        groups.set(seen.error, group);
      }
      for (const [text, group] of groups) {
        if (group.items.length === 0) continue;
        if (group.systemic === 0 && group.items.length < SAME_ERROR_CORROBORATION_MIN) continue;
        const park = parkPending ?? { items: new Set<string>() };
        for (const itemId of group.items) {
          deferred.delete(itemId);
          park.items.add(itemId);
        }
        park.error ??= text;
        parkPending = park;
        holdDispatch = true;
        this.host.log?.(
          'warn',
          `fan-out '${step.id}': ${group.items.length} lane(s) failed with the SAME error${group.systemic > 0 ? ' as a systemically-failed lane' : ''}; treating it as environmental rather than as ${group.items.length} task defects: ${text.slice(0, 120)}`,
        );
      }

      // ── FLUSH ─────────────────────────────────────────────────────────────
      // A hold ends when its cohort has drained (nobody left who could still
      // corroborate it) or when the ceiling elapses — whichever first. Without
      // the ceiling the hold would be bounded by the pool's slowest lane, which
      // leaves a failed lane reading 'running' on the board (and re-dispatchable
      // on a crash-resume) for as long as that lane takes.
      for (const [itemId, held] of [...deferred]) {
        if (parkPending?.items.has(itemId) === true) continue;
        if (held.cohort.size > 0 && held.heldSince > windowStart) continue;
        flushDeferred(itemId, true);
      }
      // Systemic texts age out on the same clock, so a park that never opened
      // cannot leave a minute-1 quota error corroborating a minute-50 failure.
      if (systemicSeen.length > 0) systemicSeen = systemicSeen.filter((seen) => seen.at > windowStart);
    }

    // One last sweep over the settled tree: the drain sweep above runs before the
    // final lanes' findings have necessarily committed, and this one is free
    // (idempotent per run on the group's normalized text).
    await this.sweepBuildBreaks(runId);
    return { terminal: false, incompleteCount };
  }

  /**
   * Handle a required step that exhausted its retry + loopback budget (Stage 3
   * triage seam). Notifies the supervisor of the failure, then consults
   * `host.triageFailure` (absent ⇒ 'fail'):
   *   - 'retry'    — re-run the step (i unchanged), bounded by a per-step triage
   *                  budget; budget-exhausted falls through to fail.
   *   - 'escalate' — open a human gate routing the failure to the review queue:
   *                    approve → skip the step and advance (the human accepts it),
   *                    revise  → retry the step (bounded), abort → cancel,
   *                    reject  → fail.
   *   - 'fail'     — terminal failure (also the no-advisor default).
   */
  private async handleRequiredFailure(
    step: WorkflowStep,
    phase: WorkflowDefinition['phases'][number],
    baseCtx: { runId: string; phaseId: string; stepIndex: number; signal?: AbortSignal },
    lastError: string | undefined,
    steps: StepReport[],
    i: number,
    attempt: number,
    triageRetries: Map<string, number>,
  ): Promise<{ terminal: true; result: ControllerResult } | { terminal: false; i: number }> {
    this.emit({ kind: 'step-failed', runId: baseCtx.runId, phaseId: phase.id, stepId: step.id, error: lastError });

    const ctx: ControllerStepContext = { ...baseCtx, attempt };
    const decision = this.host.triageFailure ? await this.host.triageFailure(step, ctx, lastError) : 'fail';

    const tryTriageRetry = (): { terminal: false; i: number } | null => {
      const used = triageRetries.get(step.id) ?? 0;
      if (used >= MAX_STEP_LOOPBACKS) return null;
      triageRetries.set(step.id, used + 1);
      this.host.reportStep(step.id, 'done');
      return { terminal: false, i };
    };

    if (decision === 'retry') {
      const retry = tryTriageRetry();
      if (retry) {
        this.host.log?.('warn', `triage: retrying failed step '${step.id}'`);
        return retry;
      }
      // budget exhausted → fall through to terminal failure
    } else if (decision === 'escalate') {
      this.emit({ kind: 'gate-opened', runId: baseCtx.runId, phaseId: phase.id, stepId: step.id });
      const verdict = await this.host.requestHumanGate(step, ctx);
      if (verdict === 'approve') {
        // The human accepts the failure — skip the step and advance.
        this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'skipped', attempts: attempt, error: lastError });
        this.host.log?.('warn', `triage: human accepted failure of step '${step.id}'; skipping`);
        this.host.reportStep(step.id, 'skipped');
        return { terminal: false, i: i + 1 };
      }
      if (verdict === 'abort') {
        this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'canceled', attempts: attempt });
        this.host.reportStep(step.id, 'done');
        return { terminal: true, result: { outcome: 'canceled', steps, failedStepId: step.id } };
      }
      if (verdict === 'revise') {
        const retry = tryTriageRetry();
        if (retry) return retry;
        // budget exhausted → fall through to terminal failure
      }
      // 'reject' (or revise-exhausted) → terminal failure
    }

    this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'failed', attempts: attempt, error: lastError });
    this.host.reportStep(step.id, 'failed');
    return { terminal: true, result: { outcome: 'failed', steps, failedStepId: step.id } };
  }

  /**
   * Apply a human-gate decision, mutating `steps` and returning either the next
   * step index to resume at or a terminal result. Shared by the pure-gate arm and
   * the agent-then-gate arm. `attempts` records how many gate presentations /
   * agent attempts preceded this decision.
   *
   * - 'approve' → record done, advance to i+1.
   * - 'reject'  → record rejected, terminal 'rejected'.
   * - 'abort'   → record canceled, terminal 'canceled' (run was canceled).
   * - 'revise'  → consume the per-step loopback budget and either jump to the
   *               gate's loopback target, re-present the gate / re-run the step
   *               (i unchanged), or — when the budget is exhausted — END the run
   *               GRACEFULLY as 'rejected' (NOT by tripping the defensive
   *               execution-bound throw, which was the prior behavior).
   *
   * A non-terminal result carries `gateRevision`: set ONLY on a 'revise' that
   * actually JUMPS to a loopback target, carrying the gate's id and the human's
   * note (read back through the host, since the verdict alone drops the text).
   * The plain walk threads it into every re-driven step's context. It is
   * deliberately ABSENT on a targetless revise — that re-presents the same gate
   * rather than re-running anything, so there is nothing to hand feedback to —
   * and on approve/reject/abort, where the caller assigning it clears whatever
   * the previous round armed.
   */
  private applyGateDecision(
    decision: HumanGateDecision,
    step: WorkflowStep,
    phase: WorkflowDefinition['phases'][number],
    phaseSteps: WorkflowStep[],
    loopbacks: Map<string, number>,
    reviewRounds: ReadonlyMap<string, number>,
    remainingCompleted: Set<string>,
    steps: StepReport[],
    i: number,
    attempts = 1,
  ):
    | { terminal: true; result: ControllerResult }
    | {
        terminal: false;
        i: number;
        gateRevision?: { gateStepId: string; note?: string; round?: number };
      } {
    if (decision === 'approve') {
      this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'done', attempts });
      this.host.reportStep(step.id, 'done');
      return { terminal: false, i: i + 1 };
    }
    if (decision === 'reject') {
      this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'rejected', attempts });
      this.host.reportStep(step.id, 'done');
      return { terminal: true, result: { outcome: 'rejected', steps, failedStepId: step.id } };
    }
    if (decision === 'abort') {
      this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'canceled', attempts });
      this.host.reportStep(step.id, 'done');
      return { terminal: true, result: { outcome: 'canceled', steps, failedStepId: step.id } };
    }

    // 'revise' — consume one unit of the per-step budget regardless of whether a
    // jump target exists, so a no-target gate's re-presentations are bounded too.
    const used = loopbacks.get(step.id) ?? 0;
    if (used >= MAX_STEP_LOOPBACKS) {
      // Budget exhausted — end gracefully rather than letting the defensive
      // per-phase execution bound throw.
      this.host.log?.('warn', `gate '${step.id}' revised ${used} times; ending run (revise budget exhausted)`);
      this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'rejected', attempts });
      this.host.reportStep(step.id, 'done');
      return { terminal: true, result: { outcome: 'rejected', steps, failedStepId: step.id } };
    }
    loopbacks.set(step.id, used + 1);

    const targetIndex =
      step.loopback !== undefined && step.loopback.length > 0
        ? phaseSteps.findIndex((s) => s.id === step.loopback)
        : -1;
    this.pushStep(steps, { stepId: step.id, phaseId: phase.id, outcome: 'done', attempts });
    this.host.reportStep(step.id, 'done');
    // A resolvable target ⇒ jump there; otherwise re-present the gate / re-run the
    // step (i unchanged).
    const nextIndex = targetIndex >= 0 ? targetIndex : i;
    // Deliberate revisit: drop the revisited region (from nextIndex onward, which
    // includes this gate on a no-target re-present) from the resume skip set so it
    // actually re-runs — otherwise a resume mid-revise would fast-forward past the
    // revisit steps and silently bypass the gate itself.
    this.clearCompletedFrom(remainingCompleted, phaseSteps, nextIndex);
    if (targetIndex < 0) return { terminal: false, i: nextIndex };
    // A real jump: recover the human's note (stored behind the anchored verdict
    // prefix by `composeGateResolution`; `readGateResolutionNote` hands back only
    // the note) and arm it for every step the jump re-drives. A host without the
    // seam, or a resolution that is a bare verdict word, yields undefined — the
    // re-run then learns WHICH gate sent it back and nothing more, which still
    // beats silence.
    let note: string | undefined;
    try {
      note = this.host.readGateResolutionNote?.(step.id);
    } catch {
      note = undefined;
    }
    const trimmed = (note ?? '').trim();
    // The ROUND this revision follows. A human gate has no review step of its
    // own, so the count belongs to the adversarial-review step in the SAME phase
    // — the one whose critique the gate just presented. A phase without one (or a
    // walk that never completed a review) contributes no round, and the prompt
    // drops the clause rather than inventing a number.
    const reviewStep = phaseSteps.find((s) => s.agent === 'adversarial-review');
    const round = reviewStep !== undefined ? reviewRounds.get(reviewStep.id) : undefined;
    return {
      terminal: false,
      i: nextIndex,
      gateRevision: {
        gateStepId: step.id,
        ...(trimmed.length > 0 ? { note: trimmed } : {}),
        ...(round !== undefined ? { round } : {}),
      },
    };
  }

  /**
   * Purge the resume skip set for a deliberate intra-phase REVISIT: drop every step
   * at index >= fromIndex (the jumped-to step, this failing/revised step, and every
   * step between them) so the revisited region re-runs. Invariant: the injected
   * `completedStepIds` set only fast-forwards PAST work completed before a restart;
   * the moment the walk deliberately revisits a region, that region's pre-restart
   * history no longer exempts it from execution.
   */
  private clearCompletedFrom(
    remainingCompleted: Set<string>,
    phaseSteps: WorkflowStep[],
    fromIndex: number,
  ): void {
    for (let k = fromIndex; k < phaseSteps.length; k++) {
      remainingCompleted.delete(phaseSteps[k].id);
    }
  }

  /**
   * Resolve the AUTOMATIC adversarial-review loopback for a step that just
   * succeeded: returns the jump target, the round number, and the extracted
   * `## Blocking` section when ALL of these hold — the step's agent is
   * `adversarial-review`, it declares a resolvable intra-phase `loopback`, its
   * captured result says `REVIEW: BLOCKING` (or, with no trailer, carries a
   * populated `## Blocking` section — the same no-trailer tolerance the fan-out
   * code-review path has), and MAX_REVIEW_AUTO_REVISIONS is not yet spent for
   * this step id. Null otherwise, so every other step — and a review whose
   * result could not be captured — advances exactly as before.
   *
   * Keyed on the AGENT rather than on `loopback` alone so a custom flow that
   * puts an on-failure loopback on some other agent step never has its clean
   * result re-parsed as a review verdict.
   */
  private tryAdversarialReviewLoopback(
    step: WorkflowStep,
    phaseSteps: WorkflowStep[],
    resultText: string | null | undefined,
    reviewAutoRevisions: Map<string, number>,
  ): { index: number; round: number; blocking: string | null } | null {
    if (step.agent !== 'adversarial-review') return null;
    if (step.loopback === undefined || step.loopback.length === 0) return null;
    if (typeof resultText !== 'string' || resultText.trim().length === 0) return null;
    const verdict = parseCodeReviewVerdict(resultText);
    const blocking =
      verdict === 'blocking' || (verdict === null && blockingSectionHasEntries(resultText));
    if (!blocking) return null;
    const targetIndex = phaseSteps.findIndex((s) => s.id === step.loopback);
    if (targetIndex < 0) return null; // unresolved (validation should prevent this)
    const used = reviewAutoRevisions.get(step.id) ?? 0;
    if (used >= MAX_REVIEW_AUTO_REVISIONS) {
      this.host.log?.(
        'warn',
        `step '${step.id}' returned REVIEW: BLOCKING again after ${used} automatic revision(s); advancing to the design gate`,
      );
      return null;
    }
    reviewAutoRevisions.set(step.id, used + 1);
    return {
      index: targetIndex,
      round: used + 1,
      // Only a section with real entries is worth quoting — a `REVIEW: BLOCKING`
      // trailer over a `None.` section hands the re-run the artifact instead.
      blocking: blockingSectionHasEntries(resultText) ? extractBlockingSection(resultText) : null,
    };
  }

  /**
   * Resolve an intra-phase loopback for `step`: returns the index of the loopback
   * target within `phaseSteps` when the step declares a resolvable `loopback` AND
   * its per-step loopback budget (MAX_STEP_LOOPBACKS) is not yet exhausted, else
   * null. Increments the budget counter on a successful resolution.
   */
  private tryLoopback(
    step: WorkflowStep,
    phaseSteps: WorkflowStep[],
    loopbacks: Map<string, number>,
  ): number | null {
    if (step.loopback === undefined || step.loopback.length === 0) return null;
    const targetIndex = phaseSteps.findIndex((s) => s.id === step.loopback);
    if (targetIndex < 0) return null; // unresolved (validation should prevent this)

    const used = loopbacks.get(step.id) ?? 0;
    if (used >= MAX_STEP_LOOPBACKS) return null;
    loopbacks.set(step.id, used + 1);
    return targetIndex;
  }
}
