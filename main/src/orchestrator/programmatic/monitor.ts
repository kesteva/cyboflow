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
- "fail"     — the failure is definitive and retrying or human review won't help; end the run.

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

// ---------------------------------------------------------------------------
// MonitorSession
// ---------------------------------------------------------------------------

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
   *      synchronous, so ordering holds).
   *   3. INJECT the monitor's reply as an assistant turn.
   * Returns the assistant's reply text. Fail-soft on every path (a thrown inject /
   * answer must never escape). OPTIONAL on the interface: faked test sessions and
   * the brain's own callers may omit it; only the production `DefaultMonitorSession`
   * (built with an `injectEvent`) implements it. When the session has NO
   * `injectEvent` wired, `converse` falls back to `answer` (no rendering).
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
   * (reads the whole history, now including that turn) → inject the reply. Owns the
   * orchestration so the tRPC router stays thin. The inject + the answer call are
   * each fail-soft (a thrown inject is swallowed; `answer` already fails-soft to an
   * apology), so `converse` never throws — `send` resolves cleanly either way. When
   * no `injectEvent` is wired the turns are not rendered (fallback to a bare answer).
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
    const reply = await this.answer(text, signal);
    // A successful-but-EMPTY reply ('' from textQuery) would render as nothing —
    // the user would see their question with no answer. Always render something
    // (review: empty-monitor-reply-dropped).
    const rendered = reply.trim().length > 0 ? reply : NO_ANSWER;
    this.tryInject(buildAssistantTextEvent(rendered));
    return rendered;
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
