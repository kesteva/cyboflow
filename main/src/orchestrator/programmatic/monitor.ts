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
import type { DatabaseLike, LoggerLike } from '../types';
import type { TriageDecision } from './types';
import type { StructuredQueryFn, TextQueryFn } from './monitorQuery';
import { selectRunUnifiedMessages } from '../runUnifiedMessagesListing';
import { StepResultStore, type StepResultRow } from '../stepResultStore';
import { buildUserTextEvent, buildAssistantTextEvent } from './syntheticEvents';

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
    return { conversation, steps };
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
${digestSteps(history.steps)}

Recent conversation:
${digestConversation(history.conversation)}

If it helps, investigate the worktree with your read-only tools (Read/Grep/Glob) before deciding. Then decide ONE triage action and return it as structured output:
- "retry"    — the failure looks transient/flaky and a fresh attempt is likely to succeed.
- "escalate" — a human should decide (ambiguous, risky, or needs a judgement call). Prefer this when unsure.
- "fail"     — the failure is definitive and retrying won't help; recommend ending the run (a human confirms before it ends).

Return only the structured { decision, rationale } object. The rationale should be 2-4 sentences explaining your reasoning.`;
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
${digestSteps(history.steps)}

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
 * is replaced with a capabilities contract: the monitor may attach AT MOST ONE
 * `retry_step` action to its reply, and ONLY when the user explicitly asks for a
 * retry/resume/re-run of a failed or skipped step. The host (not the monitor)
 * validates run state and executes the action — the monitor never claims success
 * itself. Pure (output depends only on its args); structured output shape is
 * `{ reply, action? }` per `MONITOR_CONVERSE_SCHEMA`.
 */
export function buildActionAnswerPrompt(
  ctx: MonitorContext,
  question: string,
  history: MonitorHistory,
): string {
  return `You are the SUPERVISOR of a "${ctx.workflowName}" workflow run executing in this git worktree. You still do not sequence steps yourself — host code does. Your role is to MONITOR the run, answer the user's questions about it, and — only when explicitly asked — attach a validated action for the host to execute.

Step timeline so far:
${digestSteps(history.steps)}

Recent conversation:
${digestConversation(history.conversation)}

The user asks:
${question}

Capabilities:
- You may attach AT MOST ONE action per reply, and ONLY when the user EXPLICITLY asks for it — a retry, a resume, or a re-run of a failed or skipped step (for example, after a usage-limit reset).
- Action "retry_step": set \`stepId\` to the exact step id from the timeline above when the user names a step or the timeline makes clear which step failed/skipped; omit \`stepId\` to default to the run's failed step. The HOST validates the run's state (it must be failed or resting) and reports the outcome back to the user — you never claim the retry succeeded yourself.
- For a pure question (no explicit retry/resume/re-run request), return no action.

Answer concisely and concretely, grounding your reply in the run's history above. You have read-only tools (Read/Grep/Glob) for inspecting the worktree — use them when needed to answer accurately.

Return your response as structured output: { reply: string, action?: { kind: "retry_step", stepId?: string } }. \`reply\` is the message shown to the user.`;
}

// ---------------------------------------------------------------------------
// Converse action schema + parsing (monitor-actuation seam)
// ---------------------------------------------------------------------------

/**
 * JSON schema the SDK `outputFormat` enforces for a structured converse reply: a
 * required `reply` string plus an OPTIONAL `action` object (currently only
 * `retry_step`). `additionalProperties: false` at every level so the SDK rejects
 * any extra fields. Used only when a `MonitorActions` actuator is wired
 * (`converseOnce` picks this over `MONITOR_TRIAGE_SCHEMA` / plain text).
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
        kind: { type: 'string', enum: ['retry_step'] },
        stepId: {
          type: 'string',
          description: 'Exact step id to retry; omit to default to the run\'s failed step.',
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

/** Narrow + sanitize a candidate `action` field into a `ConverseRetryStepAction`, or drop it. */
function parseConverseAction(v: unknown): ConverseRetryStepAction | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (o.kind !== 'retry_step') return undefined;
  if (o.stepId !== undefined && typeof o.stepId !== 'string') return undefined;
  return typeof o.stepId === 'string' ? { kind: 'retry_step', stepId: o.stepId } : { kind: 'retry_step' };
}

/**
 * Parse the SDK's structured-output object into a converse `{ reply, action? }`.
 * Lenient and never throws: a missing/non-string `reply` becomes `''` (the caller
 * substitutes `NO_ANSWER`); an unknown action `kind` or malformed action shape is
 * silently dropped (action omitted) rather than surfaced as an error.
 */
export function parseConverseOutput(
  structured: unknown,
): { reply: string; action?: ConverseRetryStepAction } {
  if (typeof structured !== 'object' || structured === null) return { reply: '' };
  const o = structured as Record<string, unknown>;
  const reply = typeof o.reply === 'string' ? o.reply : '';
  const action = parseConverseAction(o.action);
  return action ? { reply, action } : { reply };
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
   */
  retryStep(stepId?: string): Promise<MonitorActionResult>;
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
   *      when the user explicitly asked for it — an at-most-one `retry_step`
   *      action comes back attached to the reply. Without an actuator wired, this
   *      step is the plain `answer()` path, unchanged.
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
   * an at-most-one `retry_step` action the user explicitly asked for. Wired only in
   * production (where a real `retryRunHandler`-backed executor exists); absent here
   * ⇒ `converse` behaves byte-identically to before this seam existed.
   */
  actions?: MonitorActions;
  logger?: LoggerLike;
}

const ANSWER_FAILED =
  'Sorry — I could not answer that right now (the monitor encountered an error). Please try again.';

/** Rendered when the monitor returns a successful-but-empty answer (so a turn always renders). */
const NO_ANSWER = 'I could not produce an answer for that.';

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
    const { reply, action } = await this.answerOrAct(text, signal);
    // A successful-but-EMPTY reply ('' from textQuery / the structured answer) would
    // render as nothing — the user would see their question with no answer. Always
    // render something (review: empty-monitor-reply-dropped).
    const rendered = reply.trim().length > 0 ? reply : NO_ANSWER;
    this.tryInject(buildAssistantTextEvent(rendered));
    if (action) {
      await this.actuate(action);
    }
    return rendered;
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
  ): Promise<{ reply: string; action?: ConverseRetryStepAction }> {
    if (!this.actions) {
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
   * Execute a requested `retry_step` action via the host actuator and inject a
   * follow-up assistant turn reporting the outcome (`▶` on success, `⚠` on a
   * reported failure). Fail-soft: a throwing actuator injects a generic apology
   * turn instead of escaping — the exchange's reply has already been returned by
   * the time this runs, so a throw here must never surface to `converse`'s caller.
   */
  private async actuate(action: ConverseRetryStepAction): Promise<void> {
    if (!this.actions) return;
    try {
      const result = await this.actions.retryStep(action.stepId);
      this.tryInject(buildAssistantTextEvent(result.ok ? `▶ ${result.message}` : `⚠ ${result.message}`));
    } catch (err) {
      this.logger?.warn('[Monitor] retry_step action failed (fail-soft)', {
        runId: this.ctx.runId,
        stepId: action.stepId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.tryInject(buildAssistantTextEvent('⚠ The retry action failed unexpectedly.'));
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
