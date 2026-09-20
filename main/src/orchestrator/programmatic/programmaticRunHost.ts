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
import type {
  BuildBreakGroup,
  ControllerHost,
  ControllerStepContext,
  FanOutDriver,
  HumanGateDecision,
  LaneRescueOutcome,
  LaneTriageFailure,
  StepReport,
  SystemicPauseVerdict,
  TriageDecision,
  VerificationPosture,
  VisualVerifyGate,
} from './types';
import type { HumanGateResolver } from './humanGate';
import type { BlockingItemsResolver } from './blockingItemsGate';
import type { SystemicPauseResolver } from './systemicPauseGate';
import type { MonitorSession } from './monitor';
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
    return this.args.gate.resolve({
      runId: this.args.runId,
      projectId: this.args.projectId,
      step,
      signal: ctx.signal,
    });
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
    if (!this.args.blockingGate) return 'proceed';
    return this.args.blockingGate.awaitClear({ runId, projectId: this.args.projectId, signal });
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
   */
  async triageFailure(
    step: WorkflowStep,
    ctx: ControllerStepContext,
    error: string | undefined,
  ): Promise<TriageDecision> {
    if (!this.args.monitor) {
      this.injectMonitorTurn(
        `Step **${step.name}** exhausted its retries — escalated to the review queue for your decision.`,
      );
      return 'escalate';
    }
    try {
      const { decision, rationale } = await this.args.monitor.triage(step, error, ctx.signal);
      if (decision === 'fail') {
        // The supervisor recommends ending the run, but ending it is the HUMAN's
        // call — downgrade to an escalation carrying the recommendation.
        this.injectMonitorTurn(
          `Triage — ${step.name}: the supervisor recommends ending the run, escalated to the review queue for your decision. ${rationale}`,
        );
        return 'escalate';
      }
      this.injectMonitorTurn(`Triage — ${step.name}: ${decision}. ${rationale}`);
      return decision;
    } catch (err) {
      this.args.logger?.warn('[ProgrammaticRunHost] monitor.triage failed; escalating to human', {
        runId: this.args.runId,
        stepId: step.id,
        error: err instanceof Error ? err.message : String(err),
      });
      this.injectMonitorTurn(
        `Step **${step.name}** exhausted its retries — escalated to the review queue for your decision.`,
      );
      return 'escalate';
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
