/**
 * monitor — the ON-DEMAND monitor brain for the programmatic execution plane (the
 * unify-monitor refactor; supersedes the Stage 3 supervisor + supervisor-chat
 * planes). The monitor renders into the run's EXISTING unified Chat pane (no
 * separate transcript store) and is TOKEN-FRUGAL: it consumes zero tokens during
 * routine step progress and reads the WHOLE run history ONLY when it must act —
 *
 *   - TRIAGE: a required step exhausts its retry/loopback budget. The monitor reads
 *     the full history, may inspect the worktree (read-only tools), and decides
 *     retry / escalate / fail WITH full context.
 *   - ANSWER: a human types in the run's chat. The monitor reads the full history
 *     and replies with a grounded, concise answer.
 *
 * Each call reads the whole history FRESH (`HistoryReader.read(runId)`) — there is
 * no accumulated in-memory feed (the canonical transcript is `raw_events`). The SDK
 * call is isolated behind two fakeable fns (`StructuredQueryFn` / `TextQueryFn` in
 * monitorQuery.ts, the SOLE SDK importer), so this brain is pure / fully
 * unit-testable without the SDK. Fail-soft on every path: triage → 'escalate',
 * answer → a short apology.
 *
 * Standalone-typecheck invariant: shared types + sibling protocol/store types only —
 * NO `@anthropic-ai/claude-agent-sdk` / electron import here (that lives in
 * monitorQuery.ts).
 */
import type { WorkflowStep } from '../../../../shared/types/workflows';
import type { UnifiedMessage } from '../../../../shared/types/unifiedMessage';
import type { ClaudeStreamEvent } from '../../../../shared/types/claudeStream';
import type { SprintLaneRow } from '../../../../shared/types/sprintBatch';
import type { DatabaseLike, LoggerLike } from '../types';
import type { LaneFailureKind, TriageDecision } from './types';
import type { StructuredQueryFn, TextQueryFn } from './monitorQuery';
import { selectRunUnifiedMessages } from '../runUnifiedMessagesListing';
import { StepResultStore, type StepResultRow } from '../stepResultStore';
import { SprintLaneStore } from '../sprintLaneStore';
import { buildUserTextEvent, buildAssistantTextEvent } from './syntheticEvents';
import { isSystemicStepError } from './systemicError';

// ---------------------------------------------------------------------------
// Context + history reader
// ---------------------------------------------------------------------------

/** Per-run context the monitor brain is bound to for its lifetime. */
export interface MonitorContext {
  runId: string;
  projectId: number;
  workflowName: string;
  /** The run's git worktree — the cwd the monitor's read-only inspection runs in. */
  worktreePath: string;
}

/** The whole-history snapshot the monitor reads before each act. */
export interface MonitorHistory {
  /** The run's chat transcript (correlated UnifiedMessage[], oldest-first). */
  conversation: UnifiedMessage[];
  /** The per-step results timeline (in execution order). */
  steps: StepResultRow[];
  /**
   * The run's sprint fan-out lanes (per-task progress), when it is a sprint/ship
   * run — else absent/empty. OPTIONAL so the many non-sprint callers (and every
   * existing test literal) need not supply it; a run with no lanes produces no
   * lane section, keeping non-sprint prompts byte-identical. This exists because
   * the `steps` timeline collapses the whole task fan-out into ONE opaque
   * container step (`execute-tasks`), so it carries NO per-task granularity — the
   * lanes are the source of truth for how far any individual task has gotten.
   */
  lanes?: SprintLaneRow[];
  /**
   * True when the lane read FAILED (an internal DB/read error), as distinct from a
   * legitimate non-sprint run that simply has no lanes. Both leave `lanes` empty,
   * but they must render differently: a genuine non-sprint run omits the lane
   * section entirely, whereas a failed read emits an explicit "per-task status
   * unavailable — do NOT infer it from the step timeline" warning. Without this,
   * a query/schema/corruption failure would silently fall back to the exact
   * collapsed-timeline reasoning this whole change exists to prevent.
   */
  lanesUnavailable?: boolean;
}

/**
 * Reads the whole run history on demand. The default impl reads the canonical
 * `raw_events` transcript (via `selectRunUnifiedMessages`) + the `step_results`
 * timeline (via `StepResultStore`). Fakeable so the brain is unit-testable.
 */
export interface HistoryReader {
  read(runId: string): Promise<MonitorHistory>;
}

/**
 * The production `HistoryReader`: reads the canonical transcript from `raw_events`
 * and the step timeline from the `StepResultStore` singleton. Both are synchronous
 * SQLite reads wrapped in a Promise so the brain's call sites stay async-uniform.
 * Fail-soft on the step store: an uninitialized store (early boot / tests) → [].
 */
export class DefaultHistoryReader implements HistoryReader {
  constructor(
    private readonly db: DatabaseLike,
    private readonly logger?: LoggerLike,
  ) {}

  async read(runId: string): Promise<MonitorHistory> {
    const conversation = selectRunUnifiedMessages(this.db, runId, this.logger);
    const steps = StepResultStore.tryGetInstance()?.listForRun(runId) ?? [];
    const { lanes, unavailable } = this.readLanes(runId);
    return { conversation, steps, lanes, ...(unavailable ? { lanesUnavailable: true } : {}) };
  }

  /**
   * Read the run's sprint fan-out lanes, fail-soft. Distinguishes a genuine
   * NO-LANES result (`unavailable: false`) — a non-sprint run with no batch, or
   * the store not yet initialized (early boot / tests) — from a READ FAILURE
   * (`unavailable: true`) — any throw from the batch lookup or `listLanes` (a
   * schema/corruption/query error). The two look identical (`lanes: []`) but must
   * render differently (see `MonitorHistory.lanesUnavailable`): only a failure
   * warns the monitor NOT to fall back to the collapsed step timeline. A lane-read
   * problem must never break the monitor's history read, so neither path throws.
   * The batch is resolved the same way the lane store's own owners do
   * (workflow_runs.batch_id, 1:1).
   */
  private readLanes(runId: string): { lanes: SprintLaneRow[]; unavailable: boolean } {
    try {
      const store = SprintLaneStore.tryGetInstance();
      // Store absent (early boot / tests) is NOT a failure — treat as no lanes so
      // non-sprint prompts stay byte-identical (no spurious "unavailable" warning).
      if (store === null) return { lanes: [], unavailable: false };
      const row = this.db
        .prepare('SELECT batch_id AS batchId FROM workflow_runs WHERE id = ?')
        .get(runId) as { batchId?: unknown } | undefined;
      const batchId =
        typeof row?.batchId === 'string' && row.batchId.length > 0 ? row.batchId : null;
      // Genuine non-sprint run (no batch) — no lanes, and NOT a failure.
      if (batchId === null) return { lanes: [], unavailable: false };
      return { lanes: store.listLanes(batchId), unavailable: false };
    } catch (err) {
      // A real read error: report it as UNAVAILABLE (not empty) so the prompt warns
      // the monitor off the misleading timeline instead of silently reasoning from it.
      this.logger?.warn('[Monitor] lane read failed — per-task status marked unavailable', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { lanes: [], unavailable: true };
    }
  }
}

// ---------------------------------------------------------------------------
// Triage schema + parsing
// ---------------------------------------------------------------------------

/** JSON schema the SDK `outputFormat` enforces for a structured triage verdict. */
export const MONITOR_TRIAGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'rationale'],
  properties: {
    decision: { type: 'string', enum: ['retry', 'escalate', 'fail'] },
    rationale: { type: 'string', description: '2-4 sentences: why this decision' },
  },
};

/** The parsed triage verdict: a decision + the rationale rendered into the chat. */
export interface TriageAdvice {
  decision: TriageDecision;
  rationale: string;
}

/** A `TriageDecision` type guard (narrows the structured-output `decision`). */
function isTriageDecision(v: unknown): v is TriageDecision {
  return v === 'retry' || v === 'escalate' || v === 'fail';
}

/**
 * Parse the SDK's structured-output object into a `TriageAdvice`. Lenient and never
 * throws: an unrecognized / missing decision falls back to 'escalate' (route to the
 * human seam — the safe default when the verdict is unusable).
 */
export function parseTriageAdvice(structured: unknown): TriageAdvice {
  if (typeof structured === 'object' && structured !== null) {
    const o = structured as Record<string, unknown>;
    if (isTriageDecision(o.decision)) {
      return {
        decision: o.decision,
        rationale: typeof o.rationale === 'string' ? o.rationale : '',
      };
    }
  }
  return { decision: 'escalate', rationale: 'unparseable triage verdict — escalating to human' };
}

// ---------------------------------------------------------------------------
// Lane triage schema + parsing (autonomous sprint-lane rescue)
// ---------------------------------------------------------------------------

/**
 * JSON schema the SDK `outputFormat` enforces for a structured LANE-triage verdict —
 * the monitor's decision about a sprint fan-out lane that exhausted its automatic
 * budget. `additionalProperties: false` so the SDK rejects extra fields.
 *
 * Only `verdict` + `reason` are schema-required: `targetStepId` / `guidance` /
 * `taskBody` are verdict-specific and enforced (with a fail-safe DOWNGRADE, never an
 * error) by `parseLaneTriageOutput`.
 */
export const MONITOR_LANE_TRIAGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reason'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['give_up', 'retry', 'adjust_and_retry', 'append_correction'],
      description:
        'retry = re-drive the lane with new guidance; adjust_and_retry = also replace the task body first; append_correction = record a diagnosis worth keeping WITHOUT re-driving (costs no rescue budget; the lane still settles failed); give_up = escalate to the human gate, for a product decision the brief does not settle, work that needs a human, or after two failed autonomous corrections.',
    },
    reason: {
      type: 'string',
      description:
        '2-4 sentences: why this verdict. For adjust_and_retry, cite the file:line evidence that the task’s criteria conflict with repo reality. For append_correction, this IS the diagnosis that gets recorded — make it specific and evidence-backed.',
    },
    targetStepId: {
      type: 'string',
      description:
        'retry / adjust_and_retry (REQUIRED in practice): the INNER lane step id to re-drive from. Must be one of the lane’s listed inner step ids, at or before the failing step.',
    },
    guidance: {
      type: 'string',
      description:
        'retry / adjust_and_retry (REQUIRED in practice): what the lane must do DIFFERENTLY on the next attempt. "Try again" is not guidance. OPTIONAL for append_correction, where it is the corrective note recorded alongside the diagnosis.',
    },
    taskBody: {
      type: 'string',
      description:
        'adjust_and_retry only (REQUIRED there): the FULL replacement task body, minimally edited — never silently drop a security- or correctness-relevant criterion.',
    },
  },
};

/**
 * Which budget-exhaustion site in a lane's inner chain produced the failure. Purely
 * descriptive (it is rendered into the prompt so the monitor knows what kind of
 * evidence to look for); the controller decides which sites consult lane triage.
 *
 * Declared canonically in `./types` (the controller/host protocol module, which
 * must stay free of this file's heavier import graph) and re-exported here so the
 * brain, the host seam, and the controller can never drift apart on the union.
 */
export type { LaneFailureKind };

/**
 * Everything the monitor needs to triage ONE failing sprint fan-out lane. Assembled
 * by the host/controller (the brain reads no lane state itself beyond the history
 * snapshot). `innerStepIds` is the lane's configured inner chain IN ORDER — it is the
 * ONLY allow-list `parseLaneTriageOutput` accepts a `targetStepId` from, so a caller
 * that supplies an empty chain gets an unconditional `give_up` (fail-safe: with no
 * known step to re-drive from, a rescue is not expressible).
 */
export interface LaneTriageRequest {
  /** The task's display ref (e.g. `TASK-014`) — what the chat turns name. */
  taskRef: string;
  /** The batch item / task id the controller keys its per-item rescue cap on. */
  itemId: string;
  /** The inner step that failed (usually, but not necessarily, in `innerStepIds`). */
  stepId: string;
  /** 1-based lane attempt that just exhausted its budget. */
  attempt: number;
  failureKind: LaneFailureKind;
  /** The error / verdict text (already excerpted by the caller — rendered verbatim). */
  errorExcerpt: string;
  /** The lane's configured inner chain, in execution order. */
  innerStepIds: string[];
  taskTitle: string;
  /** The task's CURRENT body — the acceptance criteria the lane's agents work from. */
  taskBody: string;
}

/**
 * Let the lane settle `failed` — the fail-safe default. `reason` is optional so a
 * host can construct a bare `{ verdict: 'give_up' }` (e.g. a kill switch) without
 * inventing prose; the brain always fills it in so the chat turn is informative.
 */
export interface LaneGiveUpDecision {
  verdict: 'give_up';
  reason?: string;
  /**
   * Set ONLY when the triage exchange itself died on an environment-level
   * condition (a spent session limit, an expired login) — the verbatim error
   * text. The brain judged nothing here: it never got a turn. A host that reads
   * this must PARK the fan-out on the text rather than settle the lane 'failed',
   * or a dead quota silently converts every concurrent lane into a task defect
   * (the 2026-09-05 sprint-2 cascade: 50 lanes failed in 13 ms this way).
   */
  systemicError?: string;
}

/** Re-drive the lane from `targetStepId` with `guidance`, leaving the task body alone. */
export interface LaneRetryDecision {
  verdict: 'retry';
  targetStepId: string;
  guidance: string;
  reason: string;
}

/**
 * Replace the task's body with `taskBody`, THEN re-drive the lane from
 * `targetStepId` with `guidance`. The host executes both autonomously and audits the
 * edit via a non-blocking review-queue finding.
 */
export interface LaneAdjustAndRetryDecision {
  verdict: 'adjust_and_retry';
  targetStepId: string;
  guidance: string;
  taskBody: string;
  reason: string;
}

/**
 * Record a diagnosis WITHOUT re-driving the lane — the cheapest verdict, and the
 * one that closes a real hole: a supervisor that investigates a failure, works
 * out a genuine cross-lane cause, and then gives up leaves NO record of what it
 * found (a plain `give_up` files nothing, because the lane's failure already
 * reaches the human at the run's gate). The diagnosis died with the consult.
 *
 * The host files it as a non-blocking advisory finding and then returns the
 * give-up outcome, so the lane settles `failed` exactly as before. It costs NO
 * rescue budget — the controller reserves budget before the consult and releases
 * it on every non-rescue arm, and this is one.
 */
export interface LaneAppendCorrectionDecision {
  verdict: 'append_correction';
  /** The diagnosis. REQUIRED and non-blank — a blank one downgrades to give_up. */
  reason: string;
  /** Optional corrective note recorded alongside the diagnosis. */
  guidance?: string;
}

/** The parsed, host-safe lane-triage verdict (every field a rescue needs is present). */
export type LaneTriageDecision =
  | LaneGiveUpDecision
  | LaneRetryDecision
  | LaneAdjustAndRetryDecision
  | LaneAppendCorrectionDecision;

/** Build the fail-safe `give_up` decision carrying a machine-authored reason. */
function laneGiveUp(reason: string): LaneGiveUpDecision {
  return { verdict: 'give_up', reason };
}

/**
 * Resolve the model's `targetStepId` against the lane's configured inner chain, or
 * `null` when it is unusable (the caller then downgrades to `give_up`).
 *
 * - An EMPTY chain is always `null`: there is no step a rescue could name.
 * - ABSENT / blank ⇒ the FIRST inner step (typically `implement`) — the documented default.
 * - A non-string ⇒ `null`.
 * - A string must be one of the inner ids AT OR BEFORE the failing step. Re-driving a
 *   lane to a step AFTER the failure would skip the very work that failed, so such a
 *   target is treated as unusable rather than silently clamped. When the failing step
 *   is not itself in the chain (e.g. a merge-gate failure), the whole chain is allowed.
 */
function resolveLaneTargetStep(raw: unknown, req: LaneTriageRequest): string | null {
  const ids = req.innerStepIds;
  if (ids.length === 0) return null;
  const failingIdx = ids.indexOf(req.stepId);
  const allowed = failingIdx >= 0 ? ids.slice(0, failingIdx + 1) : ids;
  if (raw === undefined || raw === null) return allowed[0];
  if (typeof raw !== 'string') return null;
  if (raw.trim().length === 0) return allowed[0];
  return allowed.includes(raw) ? raw : null;
}

/**
 * Parse the SDK's structured lane-triage output into a host-safe `LaneTriageDecision`.
 * Lenient and never throws; every unusable shape DOWNGRADES along a fail-safe ladder,
 * because the conservative outcome (letting the lane fail into the human gate) is
 * always available and a half-specified rescue is not:
 *
 *   1. non-object / null / unknown `verdict`            ⇒ give_up
 *   1b. `append_correction` with a blank `reason`       ⇒ give_up (there is
 *      nothing to record); otherwise it is VALID AS GIVEN and never downgraded
 *      further — it names no step and re-drives nothing, so none of the rescue
 *      constraints below apply to it
 *   2. `give_up`                                        ⇒ give_up (reason kept when present)
 *   3. `retry`/`adjust_and_retry` with blank `guidance` ⇒ give_up (a rescue with
 *      nothing to do differently is just a wasted attempt)
 *   4. `targetStepId` unknown / after the failing step / no chain to pick from
 *      ⇒ give_up (see `resolveLaneTargetStep`)
 *   5. `adjust_and_retry` with a blank `taskBody`       ⇒ DOWNGRADE to `retry` — the
 *      guidance still carries the substance, and an empty body would wipe the task's
 *      acceptance criteria
 *   6. otherwise ⇒ the verdict as given (`reason` defaults to '' when non-string)
 */
export function parseLaneTriageOutput(structured: unknown, req: LaneTriageRequest): LaneTriageDecision {
  if (typeof structured !== 'object' || structured === null) {
    return laneGiveUp('unparseable lane triage verdict — letting the lane fail');
  }
  const o = structured as Record<string, unknown>;
  if (o.verdict === 'give_up') {
    return { verdict: 'give_up', ...(isNonEmptyString(o.reason) ? { reason: o.reason } : {}) };
  }
  if (o.verdict === 'append_correction') {
    // The ONE verdict that names no step and re-drives nothing: the target-step
    // allow-list and the guidance requirement are both meaningless for it. Its
    // only precondition is that there is something to record.
    if (!isNonEmptyString(o.reason)) {
      return laneGiveUp('lane triage asked to record a correction with no diagnosis — letting the lane fail');
    }
    return {
      verdict: 'append_correction',
      reason: o.reason,
      ...(isNonEmptyString(o.guidance) ? { guidance: o.guidance } : {}),
    };
  }
  if (o.verdict !== 'retry' && o.verdict !== 'adjust_and_retry') {
    return laneGiveUp('unrecognized lane triage verdict — letting the lane fail');
  }
  if (!isNonEmptyString(o.guidance)) {
    return laneGiveUp('lane triage asked for a retry without guidance — letting the lane fail');
  }
  const targetStepId = resolveLaneTargetStep(o.targetStepId, req);
  if (targetStepId === null) {
    return laneGiveUp('lane triage named an unusable target step — letting the lane fail');
  }
  const guidance = o.guidance;
  const reason = typeof o.reason === 'string' ? o.reason : '';
  if (o.verdict === 'retry' || !isNonEmptyString(o.taskBody)) {
    // adjust_and_retry with no replacement body downgrades to a plain rescue.
    return { verdict: 'retry', targetStepId, guidance, reason };
  }
  return { verdict: 'adjust_and_retry', targetStepId, guidance, taskBody: o.taskBody, reason };
}

// ---------------------------------------------------------------------------
// History digesting (compact, prompt-friendly)
// ---------------------------------------------------------------------------

/** Cap on conversation turns folded into a prompt digest (most recent kept). */
const MAX_DIGEST_TURNS = 12;

/** Render a single UnifiedMessage to a compact one-line digest (text only). */
function digestMessage(m: UnifiedMessage): string {
  const text = m.segments
    .map((s) => (s.type === 'text' ? s.content : s.type === 'thinking' ? s.content : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tools = m.segments
    .filter((s) => s.type === 'tool_call')
    .map((s) => (s.type === 'tool_call' ? s.tool.name : ''))
    .filter(Boolean);
  const toolNote = tools.length > 0 ? ` [tools: ${tools.join(', ')}]` : '';
  const body = text.length > 0 ? text : toolNote.length > 0 ? '(tool activity)' : '(no text)';
  return `- ${m.role}: ${body}${toolNote}`;
}

/** Build the compact step-timeline digest from the step_results rows. */
function digestSteps(steps: StepResultRow[]): string {
  if (steps.length === 0) return '- (no step results recorded yet)';
  return steps
    .map(
      (s) =>
        `- ${s.stepId}${s.phaseId ? ` [${s.phaseId}]` : ''}: ${s.outcome} (attempts: ${s.attempts})` +
        (s.error ? ` — ${s.error}` : ''),
    )
    .join('\n');
}

/** Render one sprint lane to a compact one-line digest (ref, status, current step, attempt, blockers). */
function digestLane(lane: SprintLaneRow): string {
  const ref = lane.ref ?? lane.taskId;
  const step = lane.currentStepId !== null ? ` @ ${lane.currentStepId}` : '';
  // attempts is 1-based (0 = clean first pass); only surface a re-delegation.
  const attempt = lane.attempts >= 2 ? `, attempt ${lane.attempts}` : '';
  const blocked =
    lane.blockedByRefs.length > 0 ? ` — blocked on ${lane.blockedByRefs.join(', ')}` : '';
  return `- ${ref}: ${lane.status}${step}${attempt}${blocked}`;
}

/**
 * Warning emitted when the lane read FAILED (`lanesUnavailable`) — as distinct from
 * a non-sprint run with genuinely no lanes. It tells the monitor per-task status is
 * unavailable and must NOT be inferred from the collapsed step timeline, closing the
 * silent-fallback hole (a read error otherwise looks like "no lanes" and the monitor
 * would reason from the misleading timeline — the exact bug this change fixes).
 */
const LANES_UNAVAILABLE_SECTION =
  '\n\nSprint task lanes: per-task progress could NOT be read for this run right now ' +
  '(an internal read error). Do NOT infer how far individual tasks have gotten from the step ' +
  'timeline above — for a fan-out sprint it collapses all per-task work into ONE container step ' +
  'and is not a reliable per-task signal. If asked about a specific task’s status, say the ' +
  'per-task state is temporarily unavailable rather than guessing.';

/**
 * The per-task fan-out lane section. Three cases:
 *   - lanes present            → render them + the "trust lanes over the timeline" note.
 *   - lanes empty + UNAVAILABLE → the read-failure warning (do not fall back to the timeline).
 *   - lanes empty + available   → '' (a genuine non-sprint run — prompts stay byte-identical).
 *
 * The step timeline collapses the entire task fan-out into ONE opaque container step
 * (`execute-tasks`), so on its own it reads as "nothing past the container has run"
 * even when tasks have fully integrated — the exact trap that made a monitor
 * confidently report "verification not reached" for an already-integrated task.
 *
 * `integrated` wording is deliberately conservative: `driveLane`
 * (programmatic/workflowController.ts) marks a lane integrated once its CONFIGURED
 * inner chain completes, and OPTIONAL inner steps that fail are SKIPPED, so an
 * integrated lane does NOT prove any specific stage (code review, tests, visual
 * verify) actually ran — that depends on the run's configured chain. The prompt
 * therefore claims only "completed its configured chain + committed", never a
 * specific check, and tells the monitor to confirm a stage before asserting it.
 */
function laneSection(history: MonitorHistory): string {
  const lanes = history.lanes ?? [];
  if (lanes.length === 0) {
    return history.lanesUnavailable === true ? LANES_UNAVAILABLE_SECTION : '';
  }
  const rows = lanes.map(digestLane).join('\n');
  return (
    '\n\nSprint task lanes (per-task fan-out progress — AUTHORITATIVE for per-task state):\n' +
    'Note: the step timeline above shows the whole task fan-out as ONE container step, so it does ' +
    'NOT reflect per-task progress — trust these lanes, not the step timeline, for how far any ' +
    'individual task has gotten. A lane status of `integrated` means that task finished its ' +
    'configured task chain (all required steps passed; optional steps may have been skipped) and ' +
    'its work is committed in the shared worktree. Exactly which checks ran — code review, tests, ' +
    'verification — depends on this run’s configured chain and its optional steps, so do NOT ' +
    'claim a specific check passed unless you can confirm it (from the lane’s current step or ' +
    'the run’s workflow definition).\n' +
    rows
  );
}

/** Build the compact recent-conversation digest (last MAX_DIGEST_TURNS turns). */
function digestConversation(conversation: UnifiedMessage[]): string {
  if (conversation.length === 0) return '- (no conversation yet)';
  const recent = conversation.slice(-MAX_DIGEST_TURNS);
  return recent.map(digestMessage).join('\n');
}

// ---------------------------------------------------------------------------
// Prompt builders (pure)
// ---------------------------------------------------------------------------

/**
 * Compose the TRIAGE prompt for one failed step. Pure (output depends only on its
 * args). Frames the monitor as the supervisor; includes the step timeline + the
 * recent conversation + the failure; instructs read-only investigation then a
 * structured { decision, rationale } verdict. Reuses the supervisor's prose tone.
 */
export function buildTriagePrompt(
  ctx: MonitorContext,
  failedStep: WorkflowStep,
  error: string | undefined,
  history: MonitorHistory,
): string {
  return `You are the SUPERVISOR of a "${ctx.workflowName}" workflow run executing in this git worktree. You do NOT run the steps — host code does. A REQUIRED step has exhausted its automatic retries and you must TRIAGE it.

Failed step: **${failedStep.name}** (id: \`${failedStep.id}\`, agent: \`${failedStep.agent}\`)
Error: ${error ?? '(no error message captured)'}

Step timeline so far:
${digestSteps(history.steps)}${laneSection(history)}

Recent conversation:
${digestConversation(history.conversation)}

If it helps, investigate the worktree with your read-only tools (Read/Grep/Glob) before deciding. Then decide ONE triage action and return it as structured output:
- "retry"    — the failure looks transient/flaky and a fresh attempt is likely to succeed.
- "escalate" — a human should decide (ambiguous, risky, or needs a judgement call). Prefer this when unsure.
- "fail"     — the failure is definitive and retrying won't help; recommend ending the run (a human confirms before it ends).

Return only the structured { decision, rationale } object. The rationale should be 2-4 sentences explaining your reasoning.`;
}

/**
 * One-line description of what each failure kind means, so the monitor knows what
 * evidence to go looking for in the worktree before it decides.
 */
const LANE_FAILURE_KIND_LABELS: Record<LaneFailureKind, string> = {
  'inner-step': 'an inner lane step kept failing until its retry/loopback budget ran out',
  'task-verify': 'the task-verify gate kept returning FAIL until its loopback budget ran out',
  'code-review': 'code review kept reporting blocking defects until its loopback budget ran out',
  'merge-gate': 'the visual merge gate rejected this lane',
};

/**
 * Compose the LANE-TRIAGE prompt for one sprint fan-out lane that exhausted its
 * automatic budget. Pure (output depends only on its args). Mirrors
 * `buildTriagePrompt`'s framing (SUPERVISOR of the run; host code runs the steps) and
 * reuses the SAME digest scaffolding (`digestSteps` + `laneSection` +
 * `digestConversation`), then adds the per-lane evidence the outer triage prompt has
 * no notion of: the task's ref/title/CURRENT body, the lane's inner chain, the failing
 * step + attempt + failure kind, and the error excerpt.
 *
 * Three things the prompt must be explicit about, because the host acts on the answer
 * with NO human confirmation:
 *   - the ESCALATION LINE. `give_up` was once described to the model as "the
 *     DEFAULT when unsure", and an agent told a verdict is the safe default takes
 *     it: real diagnoses were reached and then thrown away, because the only way
 *     to decline a rescue was a verdict that records nothing. The menu now names
 *     what `give_up` is FOR (a product decision the brief does not settle, work
 *     needing a human's own hands or account, or a lane where two autonomous
 *     corrections already failed) and offers `append_correction` as the cheap way
 *     to decline a rescue while keeping the finding;
 *   - the AUTONOMOUS-EXECUTION notice (nothing here is a suggestion; it also states
 *     the audit trail + the one-rescue-per-lane budget, so the model can calibrate),
 *   - the `targetStepId` constraint (an inner id, at or before the failing step),
 *     which `parseLaneTriageOutput` enforces by downgrading to give_up.
 */
export function buildLaneTriagePrompt(
  ctx: MonitorContext,
  history: MonitorHistory,
  req: LaneTriageRequest,
): string {
  const chain = req.innerStepIds.length > 0 ? req.innerStepIds.map((id) => `\`${id}\``).join(' → ') : '(unknown)';
  const defaultTarget = req.innerStepIds[0] ?? '(none)';
  return `You are the SUPERVISOR of a "${ctx.workflowName}" workflow run executing in this git worktree. You do NOT run the steps — host code does. One TASK LANE of this run's fan-out has exhausted its automatic budget, and you must decide what to do about it.

Failing lane: **${req.taskRef}** — ${req.taskTitle}
Failure kind: \`${req.failureKind}\` — ${LANE_FAILURE_KIND_LABELS[req.failureKind]}
Failing step: \`${req.stepId}\` (attempt ${req.attempt})
This lane's inner step chain, in order: ${chain}

Error / verdict excerpt:
${req.errorExcerpt.trim().length > 0 ? req.errorExcerpt : '(no error text captured)'}

Current task body — the acceptance criteria this lane's agents are working from:
---
${req.taskBody.trim().length > 0 ? req.taskBody : '(empty)'}
---

Step timeline so far:
${digestSteps(history.steps)}${laneSection(history)}

Recent conversation:
${digestConversation(history.conversation)}

Investigate the worktree with your read-only tools (Read/Grep/Glob) BEFORE deciding — check whether the code, the tests, and repo reality actually match what this task asks for. Then decide ONE verdict and return it as structured output:
- "retry"            — a concrete, DIFFERENT approach is likely to succeed. \`guidance\` is REQUIRED and must say what to do DIFFERENTLY; "try again" is not guidance and the host will reject it (downgrading your verdict to give_up).
- "adjust_and_retry" — the task body CONFLICTS with repo reality and you have the file:line evidence (cite it in \`reason\`). Set \`taskBody\` to the FULL replacement body, MINIMALLY edited: narrow or clarify the conflicting criterion — never silently drop a security- or correctness-relevant one. \`guidance\` is still REQUIRED.
- "append_correction" — you worked out something worth KEEPING (a real cause, a cross-lane interaction, a wrong assumption in the task) but re-driving this lane would not fix it. Put the diagnosis in \`reason\`; add the corrective note in \`guidance\` if you have one. This costs NO rescue budget and the lane still settles failed — it exists so a diagnosis you actually made does not die with this consult.
- "give_up"          — ESCALATE to the human. Use it ONLY for: a product decision the task brief does not settle; work that needs a human's own hands or account (a credential, an external approval, a device); or a lane where TWO autonomous corrections have already failed.

RESOLVE IT YOURSELF WHERE YOU CAN. Between those four, bias hard toward resolving: "retry" when you can name a concrete different approach, "adjust_and_retry" when the brief is what is wrong, "append_correction" when neither will help but you learned something. "give_up" is an escalation, not a safe default — reach for it when the decision is genuinely not yours to make, not merely when you are unsure. Every autonomous correction is recorded as a non-blocking finding in the run's review queue, so nothing you do here is unaudited.

AUTONOMOUS EXECUTION: whatever you return is executed by the host IMMEDIATELY, with no human confirmation. A rescue rewinds this lane and re-runs it with your guidance; an adjusted body replaces the task's body for every later step spawn of that lane. Every intervention is recorded in the run's review queue and audited at the run's human gate before anything merges — but the budget is bounded (a lane is rescued at most once), so spend it only where it will genuinely change the outcome.

\`targetStepId\` — the inner step to re-drive this lane from — is REQUIRED for "retry" and "adjust_and_retry" (and is IGNORED for "append_correction", which re-drives nothing). It MUST be one of the inner step ids listed above AND at or before the failing step; default to the FIRST inner step (\`${defaultTarget}\`) unless you have a specific reason to resume later. An unknown or later-than-the-failure step id is rejected and your verdict is downgraded to give_up.

Return only the structured { verdict, reason, targetStepId?, guidance?, taskBody? } object. \`reason\` should be 2-4 sentences explaining your decision (and, for "adjust_and_retry", the file:line evidence for the conflict).`;
}

/**
 * Compose the ANSWER prompt for a human's chat question. Pure. Frames the monitor as
 * the supervisor + human seam; includes the history digest + the question; instructs
 * a concise, grounded answer (read-only investigation allowed).
 */
export function buildAnswerPrompt(
  ctx: MonitorContext,
  question: string,
  history: MonitorHistory,
): string {
  return `You are the SUPERVISOR of a "${ctx.workflowName}" workflow run executing in this git worktree. The workflow's steps are sequenced by HOST CODE, not by you — do NOT try to run, edit, or re-order steps. Your role is to MONITOR the run and answer the user's questions about it.

Step timeline so far:
${digestSteps(history.steps)}${laneSection(history)}

Recent conversation:
${digestConversation(history.conversation)}

The user asks:
${question}

Answer concisely and concretely, grounding your reply in the run's history above. You have read-only tools (Read/Grep/Glob) for inspecting the worktree — use them when needed to answer accurately. Do not attempt to run or modify the workflow.`;
}

/**
 * Compose the ACTION-CAPABLE answer prompt used when the monitor session was built
 * with a `MonitorActions` actuator wired (the monitor-actuation seam). Same digest
 * scaffolding as `buildAnswerPrompt`, but the hard "do NOT try to run ... steps" line
 * is replaced with a capabilities contract covering 12 action kinds: retrying/
 * handover (`retry_step`, the ONE-WAY `switch_to_orchestrated`), task mutations
 * (`add_task`/`remove_task`/`edit_task`), step control (`skip_step`/`unskip_step`/
 * `steer_step`), run control (the confirm-gated whole-run `rewind_to_step` and the
 * per-lane `rewind_lane_to_step`), and review-queue actions
 * (`resolve_review_item`/`file_note`). The monitor may attach AT MOST ONE action
 * per reply. The ten steering kinds (task mutations, step control, run control,
 * review-queue, `file_note`) may be attached either because the user explicitly
 * asked, or PROACTIVELY — unprompted — when the user's message describes a problem
 * and the model is confident which single one of them fixes it (the reply must say
 * why it staged the action); either way they are all HOST-STAGED: the model
 * attaches the action, the host stages it (does NOT execute) and shows a pause marker,
 * and the model executes it on a LATER turn by attaching a `confirm` control (or
 * abandons it with `cancel`) — the confirmation is ENFORCED by the host, not merely
 * requested of the model. `retry_step` is single-turn (executes immediately) so it
 * must NEVER be attached proactively, and `switch_to_orchestrated` keeps its own
 * suggest-first-in-reply contract — both keep their existing stricter, explicit-ask
 * contracts unchanged. The host (not the monitor) validates run state and executes
 * the action — the monitor never claims success itself. The capabilities list also
 * tells the model that sprint-lane failures are auto-triaged by the host supervisor,
 * so it neither promises manual intervention nor proactively duplicates a rescue the
 * host already performed. Pure (output depends only on its args); structured output
 * shape is `{ reply, action? }` per `MONITOR_CONVERSE_SCHEMA`.
 */
export function buildActionAnswerPrompt(
  ctx: MonitorContext,
  question: string,
  history: MonitorHistory,
): string {
  return `You are the SUPERVISOR of a "${ctx.workflowName}" workflow run executing in this git worktree. You still do not sequence steps yourself — host code does. Your role is to MONITOR the run, answer the user's questions about it, and attach a validated action for the host to execute — either because the user explicitly asks for it, or PROACTIVELY when the user's message describes a problem and you are confident which single action fixes it. Either way the host STAGES the action behind a confirm/cancel gate before it runs (see CONFIRM BEFORE YOU ACT below) — you never claim it already ran.

Step timeline so far:
${digestSteps(history.steps)}${laneSection(history)}

Recent conversation:
${digestConversation(history.conversation)}

The user asks:
${question}

Capabilities:
- You may attach AT MOST ONE action per reply. Attach it when the user EXPLICITLY asks for it, OR PROACTIVELY — without being asked — when the user's message describes a problem and you are CONFIDENT which single action fixes it; when you stage proactively, your reply MUST explain WHY you staged it so the user can judge the proposal before confirming. Either way the action is host-staged behind the confirm/cancel gate (see CONFIRM BEFORE YOU ACT below) before it runs. "retry_step" is the one exception: it executes immediately rather than staging, so it must NEVER be attached proactively — only when the user explicitly asks for a retry. "switch_to_orchestrated" also keeps its own stricter contract below (suggest first, attach only after the user's explicit confirmation on a later turn).
- Sprint-lane failures (a sprint/ship fan-out task lane failing a step) are AUTO-TRIAGED by the host supervisor itself — a bounded, audited rescue/adjust that is logged as a finding in the run's review queue — so do NOT tell the user a just-failed lane needs manual intervention, and do NOT proactively stage an action that would duplicate a rescue the host may have already performed; check the step timeline / review queue for that lane's triage outcome first.
- Retrying / handover:
  - Action "retry_step": a retry, a resume, or a re-run of a failed or skipped step. Set \`stepId\` to the exact step id from the timeline above when the user names a step or the timeline makes clear which step failed/skipped; omit \`stepId\` to default to the run's failed step. This covers two cases: a FAILED or RESTING run, where it revives the run at the failed/skipped step; and a run currently PAUSED on a usage-limit item, where the host resolves that pause instead. Either way the host picks the right mechanism for the run's actual state and reports back which one happened. The HOST validates the run's state and reports the outcome back to the user — you never claim the retry succeeded yourself.
  - Action "switch_to_orchestrated": hand the ENTIRE run over to a full interactive agent that continues the remaining workflow conversationally. Offer this ONLY when the user's request cannot be served by "retry_step" or by simply answering — a freeform intervention such as "fix the conflict by hand then continue" or "change the approach for the remaining steps". NEVER attach it merely because a retry failed. Because it is ONE-WAY — the run does NOT return to step-by-step execution afterward — SUGGEST it in your reply first and WAIT for the user's EXPLICIT confirmation on a later turn before attaching it. In that suggestion, also warn the user that steps configured to run in a separate runtime (e.g. a Codex-pinned step) will be switched to this one — the single handover agent runs the entire remaining workflow itself. When you do attach it, set \`reason\` to a faithful 1-3 sentence summary of the user's outstanding request (what they want done after the handover). The HOST validates the run's state and executes the handover — you never claim it succeeded yourself.
- Task edits (the run's sprint/ship task fan-out): these apply to a NOT-YET-STARTED task and take effect starting from the run's NEXT wave — they cannot change a task whose work already began.
  - Action "add_task": add a new task. Set \`title\` (required), and optionally \`body\` and \`priority\`.
  - Action "remove_task": remove a not-yet-started task. Set \`taskRef\` (required) to its ref or id.
  - Action "edit_task": edit a not-yet-started task. Set \`taskRef\` (required) plus at least one of \`title\`, \`body\`, or \`priority\` to change.
- Step control:
  - Action "skip_step": skip an upcoming step the run HASN'T reached yet. Set \`stepId\` (required). Cannot change a step already running or finished.
  - Action "unskip_step": reverse a previously requested skip on an upcoming step. Set \`stepId\` (required). Same restriction as "skip_step" — cannot change a step already running or finished.
  - Action "steer_step": inject freeform operator guidance for a step. Set \`stepId\` and \`guidance\` (both required). If that step is CURRENTLY RUNNING the host also delivers the guidance live to its running agent(s) mid-flight; either way it is included in every future spawn of that step (including retries). Setting \`taskRef\` narrows to ONE sprint task's currently-running agent and is LIVE-ONLY: it is delivered to that agent mid-flight and NOT stored for future spawns (and fails if that task's agent isn't running the step right now) — omit \`taskRef\` to store the guidance for every future spawn. Steering a FAN-OUT phase step (one that fans out over sprint tasks) is likewise LIVE-ONLY: the guidance is broadcast to every currently-running sprint agent but nothing is stored (that step never spawns its own agent) — steer one of its INNER steps (e.g. 'implement') to store guidance durably.
  - Action "rewind_to_step": rewind the WHOLE run to an earlier step and re-run everything from that step onward. Set \`stepId\` (required) to a step at or before the run's current step (from the timeline above). Works even while the run is actively executing — the host safely stops current work first. Use when earlier output was wrong and later steps built on it; prefer "retry_step" for simply re-running a failed step.
  - Action "rewind_lane_to_step": rewind ONE sprint task's lane to an earlier step of ITS chain (e.g. back to 'implement'), leaving the run and every other lane running. Set \`taskRef\` (the task's ref or id) and \`stepId\` (an INNER lane step such as 'implement', 'code-review', 'task-verify' — NOT a phase step from the timeline), both required, with \`stepId\` at or before that lane's current step (see the sprint task lanes section above). The lane must be RUNNING right now; a queued lane hasn't started, and an integrated or failed lane has already settled — neither can be rewound this way. This is THE action for one stuck or misbehaving task: the host safely stops just that lane's agent and re-drives it from the step you name. Prefer it over "rewind_to_step" whenever the problem is confined to one task — the whole-run rewind throws away every other lane's work too.
- Review queue:
  - Action "resolve_review_item": resolve a pending gate, finding, or permission request by id. Set \`reviewItemId\` (required), and optionally \`outcome\` ("approve" or "reject") and \`resolution\` (a short note).
  - Action "file_note": file a non-blocking informational note into the run's review queue. Set \`title\` (required) and optionally \`body\`.
- For a pure question (no explicit action request), return no action.

CONFIRM BEFORE YOU ACT (host-enforced): when the user clearly wants a mutating action, or you are proactively proposing one to fix a problem they described — any task edit, step-control, review-queue, or "file_note" action — ATTACH that action. The host will STAGE it (it does NOT execute yet) and show the user a pause marker asking them to confirm, so do NOT claim you already performed it. After the user EXPLICITLY confirms on the NEXT turn, attach an action of kind "confirm" to execute the staged action; if they decline or change their mind, attach kind "cancel" (or simply answer normally). A "confirm" with nothing staged does nothing, and a staged proposal EXPIRES if the very next turn is not a confirmation. "file_note" is low-risk but is still staged and confirmed the same way, for consistency. You may ask a clarifying question instead of attaching when the request is ambiguous (e.g. which task, which step, which review item). "retry_step" and "switch_to_orchestrated" are NOT staged this way — "retry_step" executes immediately, and "switch_to_orchestrated" keeps its own suggest-first-in-reply contract described above.

Answer concisely and concretely, grounding your reply in the run's history above. You have read-only tools (Read/Grep/Glob) for inspecting the worktree — use them when needed to answer accurately.

Return your response as structured output: { reply: string, action?: { kind: "retry_step" | "switch_to_orchestrated" | "add_task" | "remove_task" | "edit_task" | "skip_step" | "unskip_step" | "steer_step" | "rewind_to_step" | "rewind_lane_to_step" | "resolve_review_item" | "file_note" | "confirm" | "cancel", ...fields } }, where only the fields relevant to the chosen \`kind\` (see Capabilities above) should be set ("confirm"/"cancel" carry no fields; "rewind_to_step" and "rewind_lane_to_step" follow the same staged-confirm contract as the other steering kinds above). \`reply\` is the message shown to the user.`;
}

// ---------------------------------------------------------------------------
// Converse action schema + parsing (monitor-actuation seam)
// ---------------------------------------------------------------------------

/**
 * JSON schema the SDK `outputFormat` enforces for a structured converse reply: a
 * required `reply` string plus an OPTIONAL `action` object (one of 12 host-action
 * kinds — `retry_step` / `switch_to_orchestrated` plus the ten confirm-gated
 * steering kinds: task mutations, step control — including the whole-run
 * `rewind_to_step` and the per-lane `rewind_lane_to_step` — and review-queue
 * actions) PLUS two host-side control signals
 * (`confirm` / `cancel`) that drive the two-phase confirmation gate. The control
 * signals are NOT host actions: `parseConverseOutput` maps them to a `control`
 * field and they never enter `parseConverseAction` / the `runAction` switch.
 * `additionalProperties: false` at every level so the SDK rejects
 * any extra fields. Used only when a `MonitorActions` actuator is wired
 * (`converseOnce` picks this over `MONITOR_TRIAGE_SCHEMA` / plain text).
 *
 * Every field below is kind-specific and optional at the schema level (only the
 * fields relevant to the chosen `kind` should be set) — `parseConverseAction`
 * enforces the REQUIRED-in-practice fields per kind and drops the action when
 * they're missing/blank; see its doc comment for the exact per-kind rules.
 */
export const MONITOR_CONVERSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['reply'],
  properties: {
    reply: { type: 'string', description: 'The message shown to the user.' },
    action: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: {
          type: 'string',
          description:
            'The action to attach — one of the 12 host actions, OR a host-side control signal: "confirm" executes a previously-staged action, "cancel" discards it. The two control signals are NOT host actions.',
          enum: [
            'retry_step',
            'switch_to_orchestrated',
            'add_task',
            'remove_task',
            'edit_task',
            'skip_step',
            'unskip_step',
            'steer_step',
            'rewind_to_step',
            'rewind_lane_to_step',
            'resolve_review_item',
            'file_note',
            // Host-side two-phase-confirmation CONTROL signals (NOT host actions):
            // parseConverseOutput maps these to `control`, never a ConverseAction.
            'confirm',
            'cancel',
          ],
        },
        stepId: {
          type: 'string',
          description:
            'retry_step / skip_step / unskip_step / steer_step / rewind_to_step: exact step id from the timeline. For retry_step, omit to default to the run\'s failed step. For rewind_to_step, the step must be at or before the run\'s current step. For rewind_lane_to_step it is an INNER lane step id instead (e.g. implement / code-review / task-verify), at or before that lane\'s current step.',
        },
        reason: {
          type: 'string',
          description:
            'switch_to_orchestrated only (REQUIRED in practice): a faithful 1-3 sentence summary of what the user wants done after the handover.',
        },
        title: {
          type: 'string',
          description: 'add_task / edit_task / file_note: the task or note title.',
        },
        body: {
          type: 'string',
          description: 'add_task / edit_task / file_note: the task or note body (markdown).',
        },
        priority: {
          type: 'string',
          description: 'add_task / edit_task: the task priority.',
        },
        taskRef: {
          type: 'string',
          description:
            "remove_task / edit_task: the ref or id of the task to mutate. rewind_lane_to_step (REQUIRED there): the ref or id of the sprint task whose lane to rewind. steer_step: optionally targets ONE sprint lane's currently-running agent (live-only — not stored for future spawns).",
        },
        guidance: {
          type: 'string',
          description:
            'steer_step only (REQUIRED in practice): freeform operator guidance for the step — delivered live to its running agent(s) when the step is currently executing, and included in every future spawn of the step.',
        },
        reviewItemId: {
          type: 'string',
          description: 'resolve_review_item only (REQUIRED in practice): the id of the pending review item to resolve.',
        },
        outcome: {
          type: 'string',
          enum: ['approve', 'reject'],
          description: 'resolve_review_item only: the resolution outcome.',
        },
        resolution: {
          type: 'string',
          description: 'resolve_review_item only: an optional resolution note.',
        },
      },
    },
  },
};

/** A parsed `retry_step` action from a converse structured reply. */
export interface ConverseRetryStepAction {
  kind: 'retry_step';
  stepId?: string;
}

/**
 * A parsed `switch_to_orchestrated` action from a converse structured reply: a
 * ONE-WAY handover of the whole run from the programmatic plane to the orchestrated
 * plane. `reason` is a required, non-empty faithful summary of the user's
 * outstanding request (the host seeds it as the handover brief).
 */
export interface ConverseSwitchToOrchestratedAction {
  kind: 'switch_to_orchestrated';
  reason: string;
}

/**
 * Add a new task to the run's sprint/ship task fan-out. `title` is required;
 * `body`/`priority` are optional.
 */
export interface ConverseAddTaskAction {
  kind: 'add_task';
  title: string;
  body?: string;
  priority?: string;
}

/** Remove a not-yet-started task, identified by `taskRef` (ref or id). */
export interface ConverseRemoveTaskAction {
  kind: 'remove_task';
  taskRef: string;
}

/**
 * Edit a not-yet-started task, identified by `taskRef`. At least one of
 * `title`/`body`/`priority` must be present (enforced by `parseConverseAction`).
 */
export interface ConverseEditTaskAction {
  kind: 'edit_task';
  taskRef: string;
  title?: string;
  body?: string;
  priority?: string;
}

/** Mark an upcoming (not-yet-reached) step to be skipped when the run reaches it. */
export interface ConverseSkipStepAction {
  kind: 'skip_step';
  stepId: string;
}

/** Reverse a previously requested `skip_step` for an upcoming step. */
export interface ConverseUnskipStepAction {
  kind: 'unskip_step';
  stepId: string;
}

/**
 * Inject freeform guidance for a step. When the step is currently running, the
 * host ALSO delivers the guidance live into its running agent(s) mid-turn; either
 * way it is stored for every future spawn of the step (including retries).
 * `taskRef`, if present, narrows live delivery to one sprint lane's agent.
 */
export interface ConverseSteerStepAction {
  kind: 'steer_step';
  stepId: string;
  guidance: string;
  taskRef?: string;
}

/**
 * Rewind the WHOLE run to an earlier step and re-run every step from there
 * onward, discarding their prior results. Unlike `retry_step` (which re-runs ONE
 * already-failed step in place — non-destructive recovery), this can abort work
 * that is CURRENTLY in flight; the host stops it safely before rewinding.
 * `stepId` must name a step at or before the run's current step.
 */
export interface ConverseRewindToStepAction {
  kind: 'rewind_to_step';
  stepId: string;
}

/**
 * Rewind ONE sprint fan-out LANE to an earlier step of its inner chain, leaving
 * the run, the outer walk, and every sibling lane running. The narrow-blast-radius
 * counterpart to `rewind_to_step`: nothing durable is discarded (no step results,
 * no sibling work) — only that lane's position moves. `stepId` names an INNER lane
 * step (`implement`, `code-review`, …), not a phase step from the timeline, and
 * must be at or before the lane's current step; the lane must be RUNNING.
 */
export interface ConverseRewindLaneToStepAction {
  kind: 'rewind_lane_to_step';
  taskRef: string;
  stepId: string;
}

/**
 * Resolve a pending review-queue item (a gate, finding, or permission request) by
 * id. `outcome`/`resolution` are optional.
 */
export interface ConverseResolveReviewItemAction {
  kind: 'resolve_review_item';
  reviewItemId: string;
  outcome?: 'approve' | 'reject';
  resolution?: string;
}

/** File a non-blocking informational note into the run's review queue. */
export interface ConverseFileNoteAction {
  kind: 'file_note';
  title: string;
  body?: string;
}

/** Any host-executable action a converse reply may attach (at most one). */
export type ConverseAction =
  | ConverseRetryStepAction
  | ConverseSwitchToOrchestratedAction
  | ConverseAddTaskAction
  | ConverseRemoveTaskAction
  | ConverseEditTaskAction
  | ConverseSkipStepAction
  | ConverseUnskipStepAction
  | ConverseSteerStepAction
  | ConverseRewindToStepAction
  | ConverseRewindLaneToStepAction
  | ConverseResolveReviewItemAction
  | ConverseFileNoteAction;

/**
 * A host-side two-phase-confirmation CONTROL signal — NOT a `ConverseAction`. It
 * never enters `parseConverseAction` or the `runAction` switch; the host consumes it
 * in `handleControlAndAction` to execute (`confirm`) or discard (`cancel`) a
 * previously-STAGED pending action.
 */
export type ConverseControl = 'confirm' | 'cancel';

/** True iff `v` is a string with non-whitespace content (the drop-if-missing check below). */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Narrow + sanitize a candidate `action` field into a `ConverseAction`, or drop it.
 * `retry_step` keeps its optional-`stepId` contract; every other kind REQUIRES its
 * kind-specific fields to be non-empty strings (a missing/blank required field
 * drops the whole action — the same failure mode as an unknown `kind`):
 *
 * - `switch_to_orchestrated` requires `reason`.
 * - `add_task` / `file_note` require `title`.
 * - `remove_task` requires `taskRef`.
 * - `edit_task` requires `taskRef` AND at least one of `title`/`body`/`priority`.
 * - `skip_step` / `unskip_step` require `stepId`.
 * - `steer_step` requires `stepId` AND `guidance`; its optional `taskRef` is kept
 *   only when it is a non-empty string — absent stays absent, and a blank
 *   `taskRef` is simply dropped rather than failing the whole action (it is not a
 *   required field).
 * - `rewind_to_step` requires `stepId`.
 * - `rewind_lane_to_step` requires BOTH `taskRef` and `stepId` — unlike
 *   `steer_step`'s optional lane narrowing, a lane rewind without a lane is
 *   meaningless, so a missing/blank `taskRef` drops the whole action.
 * - `resolve_review_item` requires `reviewItemId`; `outcome`, if present, must be
 *   `'approve'` or `'reject'` — an invalid `outcome` is dropped to `undefined`
 *   while the rest of the action is KEPT (not the same failure mode as a missing
 *   required field).
 *
 * Optional fields (`body`, `priority`, `resolution`, etc.) are stored verbatim
 * when present as a string; a present-but-wrong-typed optional field drops the
 * whole action, mirroring `retry_step`'s existing `stepId` type check.
 */
function parseConverseAction(v: unknown): ConverseAction | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  switch (o.kind) {
    case 'retry_step': {
      if (o.stepId !== undefined && typeof o.stepId !== 'string') return undefined;
      return typeof o.stepId === 'string' ? { kind: 'retry_step', stepId: o.stepId } : { kind: 'retry_step' };
    }
    case 'switch_to_orchestrated': {
      if (!isNonEmptyString(o.reason)) return undefined;
      return { kind: 'switch_to_orchestrated', reason: o.reason };
    }
    case 'add_task': {
      if (!isNonEmptyString(o.title)) return undefined;
      if (o.body !== undefined && typeof o.body !== 'string') return undefined;
      if (o.priority !== undefined && typeof o.priority !== 'string') return undefined;
      return {
        kind: 'add_task',
        title: o.title,
        ...(typeof o.body === 'string' ? { body: o.body } : {}),
        ...(typeof o.priority === 'string' ? { priority: o.priority } : {}),
      };
    }
    case 'remove_task': {
      if (!isNonEmptyString(o.taskRef)) return undefined;
      return { kind: 'remove_task', taskRef: o.taskRef };
    }
    case 'edit_task': {
      if (!isNonEmptyString(o.taskRef)) return undefined;
      if (o.title !== undefined && typeof o.title !== 'string') return undefined;
      if (o.body !== undefined && typeof o.body !== 'string') return undefined;
      if (o.priority !== undefined && typeof o.priority !== 'string') return undefined;
      const hasEdit = isNonEmptyString(o.title) || isNonEmptyString(o.body) || isNonEmptyString(o.priority);
      if (!hasEdit) return undefined;
      return {
        kind: 'edit_task',
        taskRef: o.taskRef,
        ...(typeof o.title === 'string' ? { title: o.title } : {}),
        ...(typeof o.body === 'string' ? { body: o.body } : {}),
        ...(typeof o.priority === 'string' ? { priority: o.priority } : {}),
      };
    }
    case 'skip_step': {
      if (!isNonEmptyString(o.stepId)) return undefined;
      return { kind: 'skip_step', stepId: o.stepId };
    }
    case 'unskip_step': {
      if (!isNonEmptyString(o.stepId)) return undefined;
      return { kind: 'unskip_step', stepId: o.stepId };
    }
    case 'steer_step': {
      if (!isNonEmptyString(o.stepId) || !isNonEmptyString(o.guidance)) return undefined;
      if (o.taskRef !== undefined && typeof o.taskRef !== 'string') return undefined;
      return {
        kind: 'steer_step',
        stepId: o.stepId,
        guidance: o.guidance,
        ...(isNonEmptyString(o.taskRef) ? { taskRef: o.taskRef } : {}),
      };
    }
    case 'rewind_to_step': {
      if (!isNonEmptyString(o.stepId)) return undefined;
      return { kind: 'rewind_to_step', stepId: o.stepId };
    }
    case 'rewind_lane_to_step': {
      if (!isNonEmptyString(o.taskRef) || !isNonEmptyString(o.stepId)) return undefined;
      return { kind: 'rewind_lane_to_step', taskRef: o.taskRef, stepId: o.stepId };
    }
    case 'resolve_review_item': {
      if (!isNonEmptyString(o.reviewItemId)) return undefined;
      if (o.resolution !== undefined && typeof o.resolution !== 'string') return undefined;
      const outcome = o.outcome === 'approve' || o.outcome === 'reject' ? o.outcome : undefined;
      return {
        kind: 'resolve_review_item',
        reviewItemId: o.reviewItemId,
        ...(outcome ? { outcome } : {}),
        ...(typeof o.resolution === 'string' ? { resolution: o.resolution } : {}),
      };
    }
    case 'file_note': {
      if (!isNonEmptyString(o.title)) return undefined;
      if (o.body !== undefined && typeof o.body !== 'string') return undefined;
      return { kind: 'file_note', title: o.title, ...(typeof o.body === 'string' ? { body: o.body } : {}) };
    }
    default:
      return undefined;
  }
}

/**
 * Parse the SDK's structured-output object into a converse
 * `{ reply, action?, control? }`. Lenient and never throws: a missing/non-string
 * `reply` becomes `''` (the caller substitutes `NO_ANSWER`); an unknown action
 * `kind` or malformed action shape (an invalid `stepId`, or a
 * `switch_to_orchestrated` with no usable `reason`) is silently dropped (action
 * omitted) rather than surfaced as an error.
 *
 * A raw action whose `kind` is `confirm` or `cancel` is a host-side CONTROL signal,
 * not a host action: it is returned as `{ reply, control }` with NO `action` (it
 * never reaches `parseConverseAction` / the `runAction` switch).
 */
export function parseConverseOutput(
  structured: unknown,
): { reply: string; action?: ConverseAction; control?: ConverseControl } {
  if (typeof structured !== 'object' || structured === null) return { reply: '' };
  const o = structured as Record<string, unknown>;
  const reply = typeof o.reply === 'string' ? o.reply : '';
  // CONTROL signals (confirm/cancel) are detected on the RAW action object before it
  // is narrowed to a ConverseAction — they carry no fields and never become actions.
  if (typeof o.action === 'object' && o.action !== null) {
    const kind = (o.action as Record<string, unknown>).kind;
    if (kind === 'confirm' || kind === 'cancel') return { reply, control: kind };
  }
  const action = parseConverseAction(o.action);
  return action ? { reply, action } : { reply };
}

// ---------------------------------------------------------------------------
// Two-phase confirmation gate (host-enforced)
// ---------------------------------------------------------------------------

/**
 * The TEN steering kinds that must be STAGED and explicitly confirmed on a later
 * turn before the host actuates them (the host-enforced two-phase confirmation gate).
 *
 * `retry_step` and `switch_to_orchestrated` are DELIBERATELY excluded: `retry_step`
 * is a recovery affordance (the un-stick-my-run action) that must stay single-turn so
 * a wedged run can always be revived in one message, and `switch_to_orchestrated`
 * keeps its own pre-existing suggest-first-in-reply prompt contract (the model offers
 * it in prose and waits for confirmation before attaching). Both were live-verified
 * single-turn in a prior batch and intentionally stay single-turn here.
 *
 * `rewind_to_step` IS gated, even though it superficially resembles `retry_step`:
 * a retry re-runs ONE already-failed step in place — a bounded, non-destructive
 * recovery affordance — whereas a rewind can abort work that is CURRENTLY in
 * flight and re-runs EVERY step from the target onward, discarding their prior
 * results. That much larger, potentially-destructive blast radius is exactly what
 * this gate exists to guard, so — unlike `retry_step` — it must be staged and
 * explicitly confirmed like the other steering kinds.
 *
 * `rewind_lane_to_step` is gated for the same reason at a smaller scale: it kills
 * one lane's in-flight agent turn and discards that lane's progress back to the
 * target step. Much narrower than a run rewind — no sibling lane and no step
 * result is touched — but still destructive to work already done, so it stays
 * behind the gate rather than becoming a second single-turn recovery affordance.
 */
const CONFIRMATION_REQUIRED_KINDS: ReadonlySet<ConverseAction['kind']> = new Set([
  'add_task',
  'remove_task',
  'edit_task',
  'skip_step',
  'unskip_step',
  'steer_step',
  'rewind_to_step',
  'rewind_lane_to_step',
  'resolve_review_item',
  'file_note',
]);

/** True iff `kind` is one of the ten steering actions gated behind staged confirmation. */
function requiresConfirmation(kind: ConverseAction['kind']): boolean {
  return CONFIRMATION_REQUIRED_KINDS.has(kind);
}

/**
 * A concise, human-readable one-liner describing a staged action, shown in the pause
 * turn that asks the user to confirm. The switch covers the ten confirmation-
 * required kinds; the generic fallback exists only for exhaustiveness (the two
 * excluded kinds never reach here, since they are actuated without staging).
 */
function stageDescription(a: ConverseAction): string {
  switch (a.kind) {
    case 'add_task':
      return `Ready to add task "${a.title}".`;
    case 'remove_task':
      return `Ready to remove task ${a.taskRef}.`;
    case 'edit_task':
      return `Ready to edit task ${a.taskRef}.`;
    case 'skip_step':
      return `Ready to skip step ${a.stepId}.`;
    case 'unskip_step':
      return `Ready to un-skip step ${a.stepId}.`;
    case 'steer_step':
      return `Ready to steer step ${a.stepId}.`;
    case 'rewind_to_step':
      return `Ready to rewind the run to step ${a.stepId} — current work will be stopped and every step from there on re-runs.`;
    case 'rewind_lane_to_step':
      return `Ready to rewind ${a.taskRef}'s lane to step ${a.stepId} — that lane's current agent will be stopped and it re-runs from there. Other lanes and the run keep going.`;
    case 'resolve_review_item':
      return `Ready to resolve review item ${a.reviewItemId}.`;
    case 'file_note':
      return `Ready to file a note titled "${a.title}".`;
    default:
      return 'Ready to perform the requested action.';
  }
}

// ---------------------------------------------------------------------------
// MonitorSession
// ---------------------------------------------------------------------------

/** The outcome of a host-executed monitor action (e.g. a validated step retry). */
export interface MonitorActionResult {
  ok: boolean;
  message: string;
}

/**
 * Fallback result for an action whose corresponding `MonitorActions` method is
 * absent from the bag (see `DefaultMonitorSession.runAction`'s defensive guard).
 */
const ACTION_UNAVAILABLE: MonitorActionResult = {
  ok: false,
  message: 'That action is not available for this run.',
};

/**
 * Per-kind fail-soft apology injected when a host actuator THROWS (`actuate`) —
 * distinct from `ACTION_UNAVAILABLE`, which covers a missing method rather than a
 * thrown error.
 */
function actuationFailureFallback(kind: ConverseAction['kind']): string {
  switch (kind) {
    case 'retry_step':
      return '⚠ The retry action failed unexpectedly.';
    case 'switch_to_orchestrated':
      return '⚠ The handover action failed unexpectedly.';
    case 'add_task':
      return '⚠ Adding the task failed unexpectedly.';
    case 'remove_task':
      return '⚠ Removing the task failed unexpectedly.';
    case 'edit_task':
      return '⚠ Editing the task failed unexpectedly.';
    case 'skip_step':
      return '⚠ Skipping the step failed unexpectedly.';
    case 'unskip_step':
      return '⚠ Un-skipping the step failed unexpectedly.';
    case 'steer_step':
      return '⚠ Steering the step failed unexpectedly.';
    case 'rewind_to_step':
      return '⚠ The rewind action failed unexpectedly.';
    case 'rewind_lane_to_step':
      return '⚠ The lane rewind action failed unexpectedly.';
    case 'resolve_review_item':
      return '⚠ Resolving the review item failed unexpectedly.';
    case 'file_note':
      return '⚠ Filing the note failed unexpectedly.';
  }
}

/**
 * Host-validated, host-executed actions the monitor may trigger from `converse`
 * (the monitor-actuation seam). Injected only where a real executor exists
 * (production wiring — see the tRPC `cyboflow.monitor.send` seam); absent in tests
 * and in any session built without one, in which case `converse` behaves exactly as
 * it did before this seam existed (byte-identical `answer()` path).
 */
export interface MonitorActions {
  /**
   * Retry the run from a failed/skipped step. `stepId` omitted ⇒ the run's failed
   * step. Host-validated (run must be failed/resting) and host-executed via the
   * production `retryRunHandler`; the monitor brain never validates or executes
   * this itself — it only requests it and relays the host's reported outcome.
   *
   * A run PARKED on a live systemic pause (awaiting_review with an active
   * executor) is neither failed nor resting, so `retryRunHandler` alone would
   * reject it as not-retryable. The host binding (index.ts, parent-owned) falls
   * back in that case to resolving the pending pause review item instead — same
   * requested action, the host picks whichever mechanism actually applies to the
   * run's current state and reports back which one happened.
   */
  retryStep(stepId?: string): Promise<MonitorActionResult>;

  /**
   * Hand the ENTIRE run over from the programmatic plane to the ORCHESTRATED
   * plane — a ONE-WAY escalation for a request that exceeds programmatic
   * step-by-step capability (e.g. "fix the conflict by hand then continue",
   * "change the approach for the remaining steps", or any freeform intervention).
   * Host-validated (the run must be `programmatic` AND non-terminal) and
   * host-executed via the production `handoverRunHandler` at the composition root;
   * the monitor brain never validates or executes this itself — it only requests
   * it and relays the host's reported outcome, never claiming success on its own.
   *
   * `reason` is a faithful 1-3 sentence summary of the user's outstanding request;
   * the host seeds it into the FRESH orchestrated conversation as the handover
   * brief (programmatic runs carry no `claude_session_id`, so the seeded nudge
   * yields a fresh, non-resumed conversation). The monitor session stays
   * registered and reachable across the flip — the run does NOT return to
   * step-by-step execution afterward.
   */
  switchToOrchestrated(reason: string): Promise<MonitorActionResult>;

  /**
   * Add a new task to the run's sprint/ship task fan-out. Host-validated and
   * host-executed; the monitor brain never validates or executes this itself —
   * it only requests it (after the user's explicit confirmation, per the
   * action-capable prompt's contract) and relays the host's reported outcome.
   * Takes effect starting from the run's NEXT wave — it cannot retroactively
   * affect a wave already in flight.
   */
  addTask(input: { title: string; body?: string; priority?: string }): Promise<MonitorActionResult>;

  /**
   * Remove a not-yet-started task from the run's sprint/ship fan-out, identified
   * by ref or id. Host-validated and host-executed; never actuated without the
   * user's explicit confirmation.
   */
  removeTask(input: { taskRef: string }): Promise<MonitorActionResult>;

  /**
   * Edit a not-yet-started task's title/body/priority, identified by ref or id.
   * Host-validated and host-executed; never actuated without the user's explicit
   * confirmation.
   */
  editTask(input: {
    taskRef: string;
    title?: string;
    body?: string;
    priority?: string;
  }): Promise<MonitorActionResult>;

  /**
   * Mark an upcoming (not-yet-reached) step to be skipped when the run gets to
   * it. Host-validated and host-executed; never actuated without the user's
   * explicit confirmation.
   */
  skipStep(input: { stepId: string }): Promise<MonitorActionResult>;

  /**
   * Reverse a previously requested `skipStep` for an upcoming step.
   * Host-validated and host-executed; never actuated without the user's explicit
   * confirmation.
   */
  unskipStep(input: { stepId: string }): Promise<MonitorActionResult>;

  /**
   * Inject freeform guidance for a step to steer how it executes. Host-validated
   * and host-executed; never actuated without the user's explicit confirmation.
   * Without `taskRef`: the guidance is stored for the step's future spawns
   * (including retries) AND, when the step is CURRENTLY RUNNING, is ALSO
   * delivered live into the running agent(s) mid-turn. With `taskRef`: LIVE-ONLY
   * — delivered to that one sprint lane's currently-running agent and NOT stored
   * (the host refuses when that lane isn't mid-flight on the step; the stored
   * directive is step-scoped, so a per-lane store would leak to every lane).
   */
  steerStep(input: { stepId: string; guidance: string; taskRef?: string }): Promise<MonitorActionResult>;

  /**
   * Rewind the WHOLE run to an earlier step and re-run every step from there
   * onward, discarding their prior results. Host-validated (the target step must
   * be at or before the run's current step) and host-executed via the production
   * `rewindRunHandler`; the monitor brain never validates or executes this itself
   * — it only requests it and relays the host's reported outcome, never claiming
   * success on its own.
   *
   * Works on a LIVE run: if the target step (or a later one) is currently
   * executing, the host safely aborts that in-flight work before rewinding.
   * Because a rewind discards already-completed work, it is NEVER actuated
   * without the user's explicit confirmation.
   */
  rewindToStep(input: { stepId: string }): Promise<MonitorActionResult>;

  /**
   * Rewind ONE sprint fan-out LANE to an earlier step of its inner chain while the
   * run and every sibling lane keep going. Host-validated (the run must be a LIVE
   * programmatic walk, the lane must be RUNNING, and the target must be an inner
   * lane step at or before that lane's current one) and host-executed via the
   * production `laneRewindHandler`; the monitor brain never validates or executes
   * this itself — it only requests it and relays the host's reported outcome.
   *
   * The host stops just that lane — killing its own agent turn, or waking it from
   * the visual merge-gate park — so a wedged task can be re-driven without the
   * collateral damage of `rewindToStep`, which discards every OTHER lane's work
   * too. Still destructive to the targeted lane's progress, so it is NEVER
   * actuated without the user's explicit confirmation.
   */
  rewindLaneToStep(input: { taskRef: string; stepId: string }): Promise<MonitorActionResult>;

  /**
   * Resolve a pending review-queue item (a gate, finding, or permission request)
   * by id. Host-validated and host-executed; never actuated without the user's
   * explicit confirmation.
   */
  resolveReviewItem(input: {
    reviewItemId: string;
    outcome?: 'approve' | 'reject';
    resolution?: string;
  }): Promise<MonitorActionResult>;

  /**
   * File a non-blocking informational note into the run's review queue. Lower
   * risk than the other mutating actions, but still only actuated after the
   * user's explicit confirmation for consistency.
   */
  fileNote(input: { title: string; body?: string }): Promise<MonitorActionResult>;
}

/**
 * The on-demand monitor brain for one run. Each method reads the WHOLE history
 * fresh, builds the prompt, runs the (fakeable) SDK query, and returns the result.
 * Fail-soft on every path.
 */
export interface MonitorSession {
  /**
   * Triage a required step that has exhausted its retry/loopback budget. Reads the
   * whole history, runs a structured triage query, returns the parsed verdict.
   * Fail-soft: any error → { decision: 'escalate', rationale: 'monitor failed; ...' }.
   */
  triage(
    failedStep: WorkflowStep,
    error: string | undefined,
    signal?: AbortSignal,
  ): Promise<TriageAdvice>;

  /**
   * Answer a human's chat question. Reads the whole history, runs a text query,
   * returns the assistant's reply. Fail-soft: any error → a short apology string.
   */
  answer(question: string, signal?: AbortSignal): Promise<string>;

  /**
   * Triage ONE sprint fan-out LANE that exhausted its automatic budget, and decide
   * whether the host should rescue it (re-drive it from an earlier inner step, with
   * guidance and optionally an adjusted task body) or let it settle `failed`. Reads
   * the whole history fresh, runs a structured query, returns the parsed verdict.
   * Fail-soft: any error → `{ verdict: 'give_up' }`.
   *
   * UNLIKE `triage`, this method OWNS its chat rendering (the failure announcement
   * and the decision turn) — the host must NOT inject its own turns for it, or the
   * user sees the same event twice. It is serialized on the same chain as `converse`
   * so an autonomous rescue can never interleave its turns with a human exchange.
   *
   * OPTIONAL on the interface for the same reason as `converse`: the many faked
   * sessions across the test suite (and any session built without a lane-capable
   * brain) simply omit it, and the host treats an absent method exactly like a
   * `give_up` — the pre-existing behavior.
   */
  triageLane?(req: LaneTriageRequest, signal?: AbortSignal): Promise<LaneTriageDecision>;

  /**
   * Conduct one full chat exchange in the run's unified Chat pane (the human seam
   * the tRPC `cyboflow.monitor.send` mutation drives — see Slice E). Owns the
   * inject→answer→inject orchestration so the router stays thin:
   *   1. INJECT the human's turn (so it renders + becomes part of the history the
   *      monitor reads next).
   *   2. ANSWER it (`answer` reads the WHOLE history fresh — including the just-
   *      injected user turn, since the raw_events INSERT behind `injectEvent` is
   *      synchronous, so ordering holds). When a `MonitorActions` actuator is
   *      wired, this step OPTIONALLY actuates: the query runs as a structured
   *      `{ reply, action? }` request instead of a plain text answer, and — only
   *      when the user explicitly asked for it AND (for every kind but a bare
   *      retry) explicitly confirmed on a later turn — an at-most-one host action
   *      (one of 11 kinds: `retry_step` / `switch_to_orchestrated` plus the nine
   *      confirm-gated steering kinds — task mutations, step control including the
   *      whole-run `rewind_to_step`, and review-queue resolution) comes back
   *      attached to the reply. Without an actuator wired, this step is the plain
   *      `answer()` path, unchanged.
   *   3. INJECT the monitor's reply as an assistant turn.
   *   4. If an action came back, EXECUTE it via the actuator (host-validated) and
   *      INJECT a follow-up assistant turn reporting the outcome. Fail-soft: a
   *      throwing actuator injects a short apology instead of escaping.
   * Returns the assistant's reply text (unaffected by any action follow-up turn).
   * Fail-soft on every path (a thrown inject / answer / action must never escape).
   * OPTIONAL on the interface: faked test sessions and the brain's own callers may
   * omit it; only the production `DefaultMonitorSession` (built with an
   * `injectEvent`) implements it. When the session has NO `injectEvent` wired,
   * `converse` falls back to `answer` (no rendering, no actuation).
   */
  converse?(text: string, signal?: AbortSignal): Promise<string>;
}

/** Dependencies of the default monitor brain (all fakeable). */
export interface DefaultMonitorSessionDeps {
  ctx: MonitorContext;
  history: HistoryReader;
  structuredQuery: StructuredQueryFn;
  textQuery: TextQueryFn;
  model?: string;
  /**
   * Inject a synthetic event into the run's unified stream (monitor-unify seam,
   * threaded from the run context — Slice B `injectEvent`). When present, `converse`
   * renders the human turn + the monitor's reply into the run's Chat pane; when
   * absent (e.g. tests, or a session built without a persisting bridge) `converse`
   * falls back to `answer` with no rendering. Triage rationale is injected by the
   * host (it owns its own `injectEvent`), so the brain only needs this for `converse`.
   */
  injectEvent?: (event: ClaudeStreamEvent) => void;
  /**
   * The monitor-actuation seam: when present, `converse` upgrades its query from a
   * plain text answer to a structured `{ reply, action? }` request and may execute
   * an at-most-one host action (one of 11 kinds — see `MonitorActions`) the user
   * explicitly asked for. Wired only in production (where real host-executed
   * handlers exist); absent here ⇒ `converse` behaves byte-identically to before
   * this seam existed.
   */
  actions?: MonitorActions;
  logger?: LoggerLike;
}

const ANSWER_FAILED =
  'Sorry — I could not answer that right now (the monitor encountered an error). Please try again.';

/** Rendered when the monitor returns a successful-but-empty answer (so a turn always renders). */
const NO_ANSWER = 'I could not produce an answer for that.';

/** The `reason` carried on the fail-soft `give_up` when lane triage itself blew up. */
const LANE_TRIAGE_FAILED = 'lane triage failed; letting the lane fail';

/**
 * The chat turn announcing that a lane exhausted its budget, injected BEFORE the
 * (potentially slow) triage query so the user sees the failure the moment it happens
 * rather than only once the monitor has made up its mind.
 */
function laneFailureAnnouncement(req: LaneTriageRequest): string {
  return `⚠ **${req.taskRef}** (${req.taskTitle}) failed at \`${req.stepId}\` — ${req.failureKind}, attempt ${req.attempt}. Triaging the lane…`;
}

/**
 * The chat turn reporting the monitor's lane verdict. Phrased as a DECISION, not a
 * completed act: the host executes it (and may still downgrade an adjust to a plain
 * rescue if the task edit is refused), so this turn must never claim success itself.
 */
function laneDecisionSummary(req: LaneTriageRequest, decision: LaneTriageDecision): string {
  switch (decision.verdict) {
    case 'give_up':
      return `✖ **${req.taskRef}**: no rescue — letting the lane fail.${decision.reason ? ` ${decision.reason}` : ''}`;
    case 'retry':
      return `▶ **${req.taskRef}**: rescue — re-drive the lane from \`${decision.targetStepId}\`. ${decision.reason}\n\nGuidance: ${decision.guidance}`;
    case 'adjust_and_retry':
      return `▶ **${req.taskRef}**: rescue with an ADJUSTED task body — re-drive the lane from \`${decision.targetStepId}\`. ${decision.reason}\n\nGuidance: ${decision.guidance}`;
    case 'append_correction':
      // Advisory: no re-drive, no budget spent. Say so plainly, or the reader
      // assumes the lane got another attempt.
      return `✎ **${req.taskRef}**: no rescue — recording a correction instead (advisory, no rescue spent). ${decision.reason}${decision.guidance !== undefined ? `\n\nSuggested correction: ${decision.guidance}` : ''}`;
  }
}

/**
 * The default `MonitorSession` over the fakeable query fns + a `HistoryReader`. Each
 * call reads the whole history fresh (no accumulated feed), builds the prompt, runs
 * the query, and returns the result. Fail-soft: triage escalates, answer apologizes.
 */
export class DefaultMonitorSession implements MonitorSession {
  private readonly ctx: MonitorContext;
  private readonly history: HistoryReader;
  private readonly structuredQuery: StructuredQueryFn;
  private readonly textQuery: TextQueryFn;
  private readonly model?: string;
  private readonly injectEvent?: (event: ClaudeStreamEvent) => void;
  private readonly actions?: MonitorActions;
  private readonly logger?: LoggerLike;
  /** Tail of the serialized converse chain — see `converse`. */
  private sendChain: Promise<unknown> = Promise.resolve();
  /**
   * The action STAGED by the previous converse turn, awaiting an explicit confirm on
   * the immediately-next turn (the host-enforced two-phase confirmation gate — see
   * `handleControlAndAction`). The session instance persists in `MonitorRegistry`
   * across turns, so instance state is the correct home; on restart the session is
   * rebuilt fresh and any pending is safely dropped (nothing to confirm).
   */
  private pendingAction: ConverseAction | undefined;

  constructor(deps: DefaultMonitorSessionDeps) {
    this.ctx = deps.ctx;
    this.history = deps.history;
    this.structuredQuery = deps.structuredQuery;
    this.textQuery = deps.textQuery;
    this.model = deps.model;
    this.injectEvent = deps.injectEvent;
    this.actions = deps.actions;
    this.logger = deps.logger;
  }

  async triage(
    failedStep: WorkflowStep,
    error: string | undefined,
    signal?: AbortSignal,
  ): Promise<TriageAdvice> {
    try {
      const history = await this.history.read(this.ctx.runId);
      const prompt = buildTriagePrompt(this.ctx, failedStep, error, history);
      const structured = await this.structuredQuery({
        prompt,
        schema: MONITOR_TRIAGE_SCHEMA,
        cwd: this.ctx.worktreePath,
        ...(this.model ? { model: this.model } : {}),
        ...(signal ? { signal } : {}),
      });
      const advice = parseTriageAdvice(structured);
      this.logger?.info('[Monitor] triage verdict', {
        runId: this.ctx.runId,
        stepId: failedStep.id,
        decision: advice.decision,
        rationale: advice.rationale,
      });
      return advice;
    } catch (err) {
      // A broken monitor must not hard-fail the run — escalate to the human seam.
      this.logger?.warn('[Monitor] triage failed; escalating to human', {
        runId: this.ctx.runId,
        stepId: failedStep.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return { decision: 'escalate', rationale: 'monitor failed; escalating' };
    }
  }

  /**
   * Triage one failing sprint lane (see `MonitorSession.triageLane`). Serialized on
   * the SAME `sendChain` as `converse` — unlike `triage`, this method injects chat
   * turns of its own, and an autonomous rescue fires without anyone's involvement, so
   * it could otherwise land in the middle of a human's inject(user) → answer →
   * inject(assistant) sequence. `triage` needs no such serialization: it injects
   * nothing (the HOST renders its rationale, see ProgrammaticRunHost.triageFailure).
   * The chain tail swallows outcomes so one failure never poisons later exchanges.
   */
  async triageLane(req: LaneTriageRequest, signal?: AbortSignal): Promise<LaneTriageDecision> {
    const exchange = this.sendChain.then(() => this.triageLaneOnce(req, signal));
    this.sendChain = exchange.then(
      () => undefined,
      () => undefined,
    );
    return exchange;
  }

  /**
   * One lane-triage exchange (serialized by `triageLane`): announce the failure →
   * read the whole history fresh → structured query → parse → announce the decision.
   * Fail-soft at every step: a thrown history read / query / parse yields `give_up`
   * plus an explanatory chat note, so a broken monitor degrades to exactly the
   * pre-triage behavior (the lane settles failed) instead of stranding the walk.
   */
  private async triageLaneOnce(req: LaneTriageRequest, signal?: AbortSignal): Promise<LaneTriageDecision> {
    this.tryInject(buildAssistantTextEvent(laneFailureAnnouncement(req)));
    try {
      const history = await this.history.read(this.ctx.runId);
      const prompt = buildLaneTriagePrompt(this.ctx, history, req);
      const structured = await this.structuredQuery({
        prompt,
        schema: MONITOR_LANE_TRIAGE_SCHEMA,
        cwd: this.ctx.worktreePath,
        ...(this.model ? { model: this.model } : {}),
        ...(signal ? { signal } : {}),
      });
      const decision = parseLaneTriageOutput(structured, req);
      this.logger?.info('[Monitor] lane triage verdict', {
        runId: this.ctx.runId,
        taskRef: req.taskRef,
        stepId: req.stepId,
        verdict: decision.verdict,
        reason: decision.reason ?? '',
      });
      this.tryInject(buildAssistantTextEvent(laneDecisionSummary(req, decision)));
      return decision;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.warn('[Monitor] lane triage failed; letting the lane fail', {
        runId: this.ctx.runId,
        taskRef: req.taskRef,
        stepId: req.stepId,
        error: message,
      });
      // A triage consult that died on an ENVIRONMENT-level condition judged
      // nothing — the brain never got a turn. Tag the give-up so the host parks
      // the fan-out on the condition instead of failing this (and every
      // concurrent) lane for something no lane did.
      const systemic = isSystemicStepError(message);
      this.tryInject(
        buildAssistantTextEvent(
          systemic
            ? `⚠ ${req.taskRef}: lane triage could not run (${message}) — that is an environment-level failure, so the run parks instead of failing the lane.`
            : `⚠ ${req.taskRef}: lane triage could not run (${message}) — letting the lane fail.`,
        ),
      );
      const decision = laneGiveUp(LANE_TRIAGE_FAILED);
      return systemic ? { ...decision, systemicError: message } : decision;
    }
  }

  async answer(question: string, signal?: AbortSignal): Promise<string> {
    try {
      const history = await this.history.read(this.ctx.runId);
      const prompt = buildAnswerPrompt(this.ctx, question, history);
      const reply = await this.textQuery({
        prompt,
        cwd: this.ctx.worktreePath,
        ...(this.model ? { model: this.model } : {}),
        ...(signal ? { signal } : {}),
      });
      return reply;
    } catch (err) {
      this.logger?.warn('[Monitor] answer failed (fail-soft)', {
        runId: this.ctx.runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return ANSWER_FAILED;
    }
  }

  /**
   * One full chat exchange in the run's Chat pane: inject the human turn → answer
   * (reads the whole history, now including that turn — optionally actuating when
   * a `MonitorActions` seam is wired, see `converseOnce`) → inject the reply →
   * (optionally) execute + report a requested action. Owns the orchestration so the
   * tRPC router stays thin. Every step is fail-soft (a thrown inject is swallowed;
   * `answer`/the action-answer path already fail-soft to an apology; a throwing
   * actuator reports a short apology turn instead of escaping), so `converse` never
   * throws — `send` resolves cleanly either way. When no `injectEvent` is wired the
   * turns are not rendered (fallback to a bare answer, no actuation).
   */
  async converse(text: string, signal?: AbortSignal): Promise<string> {
    // Serialize exchanges on this session: concurrent sends (the frontend
    // isSending flag only guards a single component instance) must NOT interleave
    // their inject(user) → answer → inject(assistant) sequences or race the
    // whole-history read (review: converse-no-serialization). Each call waits for
    // the prior to settle; the chain tail swallows outcomes so one failure does
    // not poison later exchanges.
    const exchange = this.sendChain.then(() => this.converseOnce(text, signal));
    this.sendChain = exchange.then(
      () => undefined,
      () => undefined,
    );
    return exchange;
  }

  /** One full chat exchange (serialized by `converse`). */
  private async converseOnce(text: string, signal?: AbortSignal): Promise<string> {
    this.tryInject(buildUserTextEvent(text));
    const { reply, action, control } = await this.answerOrAct(text, signal);
    // A successful-but-EMPTY reply ('' from textQuery / the structured answer) would
    // render as nothing — the user would see their question with no answer. Always
    // render something (review: empty-monitor-reply-dropped).
    const rendered = reply.trim().length > 0 ? reply : NO_ANSWER;
    this.tryInject(buildAssistantTextEvent(rendered));
    await this.handleControlAndAction(control, action);
    return rendered;
  }

  /**
   * The host-enforced two-phase confirmation state machine (review: monitor actions
   * execute without an enforceable confirmation state). A mutating steering action is
   * never actuated on the turn it is first proposed — it is STAGED as `pendingAction`
   * and executed only when the immediately-next turn confirms it. Excluded kinds
   * (`retry_step` / `switch_to_orchestrated`) stay single-turn.
   *
   * The pending proposal is valid for EXACTLY the next turn: we snapshot it and clear
   * `pendingAction` up front, so any turn that is not a matching confirmation (a plain
   * answer, a `cancel`, or a different action) discards the stale proposal — a
   * confirmation can never re-fire an old, superseded, or abandoned proposal.
   */
  private async handleControlAndAction(
    control: ConverseControl | undefined,
    action: ConverseAction | undefined,
  ): Promise<void> {
    // Snapshot + clear: a proposal is valid ONLY for the immediately-next turn.
    const priorPending = this.pendingAction;
    this.pendingAction = undefined;

    if (control === 'cancel') {
      // Only acknowledge a discard when there was actually something staged.
      if (priorPending) {
        this.tryInject(buildAssistantTextEvent('✖ Discarded the proposed action.'));
      }
      return;
    }
    if (control === 'confirm') {
      if (priorPending) {
        await this.actuate(priorPending);
      } else {
        this.tryInject(buildAssistantTextEvent('There is no pending action to confirm.'));
      }
      return;
    }

    // No action attached: a plain-answer turn clears any stale proposal (done above).
    if (!action) return;

    // Excluded kinds actuate immediately (single-turn) — no staging.
    if (!requiresConfirmation(action.kind)) {
      await this.actuate(action);
      return;
    }

    // Any next-turn action (even an identical re-attach of the staged one) is
    // NOT a confirmation: a mutating action executes ONLY via an explicit
    // `confirm` control against a matching pending proposal. So a re-attach
    // (re)STAGES and re-asks rather than auto-confirming — this keeps the trust
    // boundary honest against persistent prompt-injected content that would
    // otherwise re-emit the same action every turn and self-confirm.
    // First proposal, or a DIFFERENT action superseding a prior pending one: STAGE it
    // and ask the user to confirm on the next turn. Do NOT execute.
    this.pendingAction = action;
    this.tryInject(
      buildAssistantTextEvent(`⏸ ${stageDescription(action)} Reply to confirm, or say cancel.`),
    );
  }

  /**
   * Produce the reply (+ optional requested action) for one exchange. When
   * `this.actions` is wired (the monitor-actuation seam), this runs the
   * ACTION-CAPABLE structured query (`buildActionAnswerPrompt` +
   * `MONITOR_CONVERSE_SCHEMA`) instead of the plain `answer()` text query — same
   * fail-soft contract (`ANSWER_FAILED`, no action, on any throw). When `this.actions`
   * is absent this is BYTE-IDENTICAL to the pre-actuation behavior: it just calls
   * `answer()`.
   */
  private async answerOrAct(
    text: string,
    signal?: AbortSignal,
  ): Promise<{ reply: string; action?: ConverseAction; control?: ConverseControl }> {
    if (!this.actions) {
      // CRITICAL INVARIANT: with no actuator wired, this returns { reply } only (no
      // action, no control), so `handleControlAndAction(undefined, undefined)` just
      // clears the (always-empty) pending and returns — byte-identical to the
      // pre-seam `answer()` path.
      return { reply: await this.answer(text, signal) };
    }
    try {
      const history = await this.history.read(this.ctx.runId);
      const prompt = buildActionAnswerPrompt(this.ctx, text, history);
      const structured = await this.structuredQuery({
        prompt,
        schema: MONITOR_CONVERSE_SCHEMA,
        cwd: this.ctx.worktreePath,
        ...(this.model ? { model: this.model } : {}),
        ...(signal ? { signal } : {}),
      });
      return parseConverseOutput(structured);
    } catch (err) {
      this.logger?.warn('[Monitor] action-capable answer failed (fail-soft)', {
        runId: this.ctx.runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { reply: ANSWER_FAILED };
    }
  }

  /**
   * Execute a requested action via the host actuator and inject a follow-up
   * assistant turn reporting the outcome (`▶` on success, `⚠` on a reported
   * failure) — the SAME outcome-turn shape for all 11 action kinds. Fail-soft: a
   * throwing actuator injects a per-kind apology turn instead of escaping — the
   * exchange's reply has already been returned by the time this runs, so a throw
   * here must never surface to `converse`'s caller.
   */
  private async actuate(action: ConverseAction): Promise<void> {
    if (!this.actions) return;
    try {
      const result = await this.runAction(this.actions, action);
      this.tryInject(buildAssistantTextEvent(result.ok ? `▶ ${result.message}` : `⚠ ${result.message}`));
    } catch (err) {
      this.logger?.warn('[Monitor] converse action failed (fail-soft)', {
        runId: this.ctx.runId,
        kind: action.kind,
        error: err instanceof Error ? err.message : String(err),
      });
      this.tryInject(buildAssistantTextEvent(actuationFailureFallback(action.kind)));
    }
  }

  /**
   * Dispatch one parsed action to its `MonitorActions` method, mapping the
   * action's fields onto the method's input shape. `MonitorActions`' 11 methods
   * are required members of the interface, so whenever `actions` (the bag) is
   * present every method is too under the type system — the `typeof ... ===
   * 'function'` checks below are a defensive runtime guard (mirrors the
   * pre-expansion ternary's tolerance for a not-yet-wired method) rather than a
   * type-level possibility; a bag missing a method resolves to a graceful
   * `{ ok: false, ... }` instead of throwing.
   */
  private async runAction(actions: MonitorActions, action: ConverseAction): Promise<MonitorActionResult> {
    switch (action.kind) {
      case 'retry_step':
        return typeof actions.retryStep === 'function' ? actions.retryStep(action.stepId) : ACTION_UNAVAILABLE;
      case 'switch_to_orchestrated':
        return typeof actions.switchToOrchestrated === 'function'
          ? actions.switchToOrchestrated(action.reason)
          : ACTION_UNAVAILABLE;
      case 'add_task':
        return typeof actions.addTask === 'function'
          ? actions.addTask({ title: action.title, body: action.body, priority: action.priority })
          : ACTION_UNAVAILABLE;
      case 'remove_task':
        return typeof actions.removeTask === 'function'
          ? actions.removeTask({ taskRef: action.taskRef })
          : ACTION_UNAVAILABLE;
      case 'edit_task':
        return typeof actions.editTask === 'function'
          ? actions.editTask({
              taskRef: action.taskRef,
              title: action.title,
              body: action.body,
              priority: action.priority,
            })
          : ACTION_UNAVAILABLE;
      case 'skip_step':
        return typeof actions.skipStep === 'function' ? actions.skipStep({ stepId: action.stepId }) : ACTION_UNAVAILABLE;
      case 'unskip_step':
        return typeof actions.unskipStep === 'function'
          ? actions.unskipStep({ stepId: action.stepId })
          : ACTION_UNAVAILABLE;
      case 'steer_step':
        return typeof actions.steerStep === 'function'
          ? actions.steerStep({ stepId: action.stepId, guidance: action.guidance, taskRef: action.taskRef })
          : ACTION_UNAVAILABLE;
      case 'rewind_to_step':
        return typeof actions.rewindToStep === 'function'
          ? actions.rewindToStep({ stepId: action.stepId })
          : ACTION_UNAVAILABLE;
      case 'rewind_lane_to_step':
        return typeof actions.rewindLaneToStep === 'function'
          ? actions.rewindLaneToStep({ taskRef: action.taskRef, stepId: action.stepId })
          : ACTION_UNAVAILABLE;
      case 'resolve_review_item':
        return typeof actions.resolveReviewItem === 'function'
          ? actions.resolveReviewItem({
              reviewItemId: action.reviewItemId,
              outcome: action.outcome,
              resolution: action.resolution,
            })
          : ACTION_UNAVAILABLE;
      case 'file_note':
        return typeof actions.fileNote === 'function'
          ? actions.fileNote({ title: action.title, body: action.body })
          : ACTION_UNAVAILABLE;
    }
  }

  /** Inject a synthetic turn into the Chat pane, fail-soft (no-op when unwired). */
  private tryInject(event: ClaudeStreamEvent): void {
    if (!this.injectEvent) return;
    try {
      this.injectEvent(event);
    } catch (err) {
      this.logger?.warn('[Monitor] converse inject failed (fail-soft)', {
        runId: this.ctx.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// MonitorRegistry
// ---------------------------------------------------------------------------

/**
 * Per-run registry of active monitor sessions, so the tRPC layer (and the renderer)
 * can reach the session for a run by id. Created on programmatic-run start, removed
 * on stop. Singleton, mirroring the other orchestrator registries (and the old
 * SupervisorChatRegistry API it replaces).
 */
export class MonitorRegistry {
  private static instance: MonitorRegistry | null = null;
  private readonly sessions = new Map<string, MonitorSession>();

  static getInstance(): MonitorRegistry {
    if (!MonitorRegistry.instance) {
      MonitorRegistry.instance = new MonitorRegistry();
    }
    return MonitorRegistry.instance;
  }

  static _resetForTesting(): void {
    MonitorRegistry.instance = null;
  }

  register(runId: string, session: MonitorSession): void {
    this.sessions.set(runId, session);
  }

  get(runId: string): MonitorSession | undefined {
    return this.sessions.get(runId);
  }

  unregister(runId: string): void {
    this.sessions.delete(runId);
  }
}
