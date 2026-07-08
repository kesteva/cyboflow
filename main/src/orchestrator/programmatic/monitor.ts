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
 * is replaced with a capabilities contract covering 10 action kinds: retrying/
 * handover (`retry_step`, the ONE-WAY `switch_to_orchestrated`), task mutations
 * (`add_task`/`remove_task`/`edit_task`), step control (`skip_step`/`unskip_step`/
 * `steer_step`), and review-queue actions (`resolve_review_item`/`file_note`). The
 * monitor may attach AT MOST ONE action per reply. The eight steering kinds (task
 * mutations, step control, review-queue, `file_note`) are HOST-STAGED: the model
 * attaches the action, the host stages it (does NOT execute) and shows a pause marker,
 * and the model executes it on a LATER turn by attaching a `confirm` control (or
 * abandons it with `cancel`) — the confirmation is ENFORCED by the host, not merely
 * requested of the model. `retry_step` is single-turn (executes immediately) and
 * `switch_to_orchestrated` keeps its own suggest-first-in-reply contract. The host
 * (not the monitor) validates run state and executes the action — the monitor never
 * claims success itself. Pure (output depends only on its args); structured output
 * shape is `{ reply, action? }` per `MONITOR_CONVERSE_SCHEMA`.
 */
export function buildActionAnswerPrompt(
  ctx: MonitorContext,
  question: string,
  history: MonitorHistory,
): string {
  return `You are the SUPERVISOR of a "${ctx.workflowName}" workflow run executing in this git worktree. You still do not sequence steps yourself — host code does. Your role is to MONITOR the run, answer the user's questions about it, and — only when explicitly asked and explicitly confirmed — attach a validated action for the host to execute.

Step timeline so far:
${digestSteps(history.steps)}

Recent conversation:
${digestConversation(history.conversation)}

The user asks:
${question}

Capabilities:
- You may attach AT MOST ONE action per reply, and ONLY when the user EXPLICITLY asks for it.
- Retrying / handover:
  - Action "retry_step": a retry, a resume, or a re-run of a failed or skipped step. Set \`stepId\` to the exact step id from the timeline above when the user names a step or the timeline makes clear which step failed/skipped; omit \`stepId\` to default to the run's failed step. This covers two cases: a FAILED or RESTING run, where it revives the run at the failed/skipped step; and a run currently PAUSED on a usage-limit item, where the host resolves that pause instead. Either way the host picks the right mechanism for the run's actual state and reports back which one happened. The HOST validates the run's state and reports the outcome back to the user — you never claim the retry succeeded yourself.
  - Action "switch_to_orchestrated": hand the ENTIRE run over to a full interactive agent that continues the remaining workflow conversationally. Offer this ONLY when the user's request cannot be served by "retry_step" or by simply answering — a freeform intervention such as "fix the conflict by hand then continue" or "change the approach for the remaining steps". NEVER attach it merely because a retry failed. Because it is ONE-WAY — the run does NOT return to step-by-step execution afterward — SUGGEST it in your reply first and WAIT for the user's EXPLICIT confirmation on a later turn before attaching it. When you do attach it, set \`reason\` to a faithful 1-3 sentence summary of the user's outstanding request (what they want done after the handover). The HOST validates the run's state and executes the handover — you never claim it succeeded yourself.
- Task edits (the run's sprint/ship task fan-out): these apply to a NOT-YET-STARTED task and take effect starting from the run's NEXT wave — they cannot change a task whose work already began.
  - Action "add_task": add a new task. Set \`title\` (required), and optionally \`body\` and \`priority\`.
  - Action "remove_task": remove a not-yet-started task. Set \`taskRef\` (required) to its ref or id.
  - Action "edit_task": edit a not-yet-started task. Set \`taskRef\` (required) plus at least one of \`title\`, \`body\`, or \`priority\` to change.
- Step control: these affect an UPCOMING step the run HASN'T reached yet — they cannot change a step already running or finished.
  - Action "skip_step": skip an upcoming step. Set \`stepId\` (required).
  - Action "unskip_step": reverse a previously requested skip on an upcoming step. Set \`stepId\` (required).
  - Action "steer_step": inject freeform guidance for an upcoming step before it runs. Set \`stepId\` and \`guidance\` (both required).
- Review queue:
  - Action "resolve_review_item": resolve a pending gate, finding, or permission request by id. Set \`reviewItemId\` (required), and optionally \`outcome\` ("approve" or "reject") and \`resolution\` (a short note).
  - Action "file_note": file a non-blocking informational note into the run's review queue. Set \`title\` (required) and optionally \`body\`.
- For a pure question (no explicit action request), return no action.

CONFIRM BEFORE YOU ACT (host-enforced): when the user clearly wants a mutating action — any task edit, step-control, review-queue, or "file_note" action — ATTACH that action. The host will STAGE it (it does NOT execute yet) and show the user a pause marker asking them to confirm, so do NOT claim you already performed it. After the user EXPLICITLY confirms on the NEXT turn, attach an action of kind "confirm" to execute the staged action; if they decline or change their mind, attach kind "cancel" (or simply answer normally). A "confirm" with nothing staged does nothing, and a staged proposal EXPIRES if the very next turn is not a confirmation. "file_note" is low-risk but is still staged and confirmed the same way, for consistency. You may ask a clarifying question instead of attaching when the request is ambiguous (e.g. which task, which step, which review item). "retry_step" and "switch_to_orchestrated" are NOT staged this way — "retry_step" executes immediately, and "switch_to_orchestrated" keeps its own suggest-first-in-reply contract described above.

Answer concisely and concretely, grounding your reply in the run's history above. You have read-only tools (Read/Grep/Glob) for inspecting the worktree — use them when needed to answer accurately.

Return your response as structured output: { reply: string, action?: { kind: "retry_step" | "switch_to_orchestrated" | "add_task" | "remove_task" | "edit_task" | "skip_step" | "unskip_step" | "steer_step" | "resolve_review_item" | "file_note" | "confirm" | "cancel", ...fields } }, where only the fields relevant to the chosen \`kind\` (see Capabilities above) should be set ("confirm"/"cancel" carry no fields). \`reply\` is the message shown to the user.`;
}

// ---------------------------------------------------------------------------
// Converse action schema + parsing (monitor-actuation seam)
// ---------------------------------------------------------------------------

/**
 * JSON schema the SDK `outputFormat` enforces for a structured converse reply: a
 * required `reply` string plus an OPTIONAL `action` object (one of 10 host-action
 * kinds — `retry_step` / `switch_to_orchestrated` plus 8 non-stopping steering
 * actions: task mutations, step control, and review-queue actions) PLUS two
 * host-side control signals (`confirm` / `cancel`) that drive the two-phase
 * confirmation gate. The control signals are NOT host actions: `parseConverseOutput`
 * maps them to a `control` field and they never enter `parseConverseAction` / the
 * `runAction` switch. `additionalProperties: false` at every level so the SDK rejects
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
            'The action to attach — one of the 10 host actions, OR a host-side control signal: "confirm" executes a previously-staged action, "cancel" discards it. The two control signals are NOT host actions.',
          enum: [
            'retry_step',
            'switch_to_orchestrated',
            'add_task',
            'remove_task',
            'edit_task',
            'skip_step',
            'unskip_step',
            'steer_step',
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
            'retry_step / skip_step / unskip_step / steer_step: exact step id from the timeline. For retry_step, omit to default to the run\'s failed step.',
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
          description: 'remove_task / edit_task: the ref or id of the task to mutate.',
        },
        guidance: {
          type: 'string',
          description: 'steer_step only (REQUIRED in practice): freeform guidance injected before the step runs.',
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

/** Inject freeform guidance for an upcoming (not-yet-reached) step before it runs. */
export interface ConverseSteerStepAction {
  kind: 'steer_step';
  stepId: string;
  guidance: string;
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
 * - `steer_step` requires `stepId` AND `guidance`.
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
      return { kind: 'steer_step', stepId: o.stepId, guidance: o.guidance };
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
 * The EIGHT steering kinds that must be STAGED and explicitly confirmed on a later
 * turn before the host actuates them (the host-enforced two-phase confirmation gate).
 *
 * `retry_step` and `switch_to_orchestrated` are DELIBERATELY excluded: `retry_step`
 * is a recovery affordance (the un-stick-my-run action) that must stay single-turn so
 * a wedged run can always be revived in one message, and `switch_to_orchestrated`
 * keeps its own pre-existing suggest-first-in-reply prompt contract (the model offers
 * it in prose and waits for confirmation before attaching). Both were live-verified
 * single-turn in a prior batch and intentionally stay single-turn here.
 */
const CONFIRMATION_REQUIRED_KINDS: ReadonlySet<ConverseAction['kind']> = new Set([
  'add_task',
  'remove_task',
  'edit_task',
  'skip_step',
  'unskip_step',
  'steer_step',
  'resolve_review_item',
  'file_note',
]);

/** True iff `kind` is one of the eight steering actions gated behind staged confirmation. */
function requiresConfirmation(kind: ConverseAction['kind']): boolean {
  return CONFIRMATION_REQUIRED_KINDS.has(kind);
}

/**
 * A stable, canonical string of an action's kind + fields, used ONLY for equality (is
 * a re-attached proposal the SAME as the staged one?). Deterministic: entries are
 * sorted so key order never affects the result. Opaque — never parsed back.
 */
function actionFingerprint(a: ConverseAction): string {
  const entries = Object.entries(a as unknown as Record<string, unknown>).sort(([l], [r]) =>
    l < r ? -1 : l > r ? 1 : 0,
  );
  return JSON.stringify(entries);
}

/**
 * A concise, human-readable one-liner describing a staged action, shown in the pause
 * turn that asks the user to confirm. The switch covers the eight confirmation-
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
   * Inject freeform guidance for an upcoming (not-yet-reached) step to steer how
   * it executes. Host-validated and host-executed; never actuated without the
   * user's explicit confirmation.
   */
  steerStep(input: { stepId: string; guidance: string }): Promise<MonitorActionResult>;

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
   *      (one of 10 kinds: `retry_step` / `switch_to_orchestrated` plus 8
   *      non-stopping steering actions — task mutations, step control, review-queue
   *      resolution) comes back attached to the reply. Without an actuator wired,
   *      this step is the plain `answer()` path, unchanged.
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
   * an at-most-one host action (one of 10 kinds — see `MonitorActions`) the user
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

    // Belt-and-suspenders: re-attaching the IDENTICAL staged action also confirms it.
    if (priorPending && actionFingerprint(priorPending) === actionFingerprint(action)) {
      await this.actuate(action);
      return;
    }

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
   * failure) — the SAME outcome-turn shape for all 10 action kinds. Fail-soft: a
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
   * action's fields onto the method's input shape. `MonitorActions`' 10 methods
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
          ? actions.steerStep({ stepId: action.stepId, guidance: action.guidance })
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
