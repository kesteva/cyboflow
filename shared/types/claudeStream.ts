/**
 * Wire-format types for Claude Code's `stream-json` output. The discriminant pair is `type`
 * (top-level) and `subtype` (nested, for `system` and `result`). All field names match the
 * actual JSON wire format (snake_case), with the documented exception of `permissionMode` on
 * `system/init` per the SamSaffron CLI spec gist.
 *
 * Sources:
 *   - CLAUDE_AGENT_SDK_SPEC.md gist (SamSaffron): https://gist.github.com/SamSaffron/603648958a8c18ceae34939a8951d417
 *   - @anthropic-ai/claude-agent-sdk@0.2.x sdk.d.ts (authoritative source for SDK wire format)
 */

// ---------------------------------------------------------------------------
// Block-level shapes
// Used by assistant.message.content and user.message.content.
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Thinking block from extended-thinking mode. On the wire the field is `thinking` (not `text`
 * or `content`), though ClaudeMessageTransformer.ts line 249 shows it may surface either key
 * in older parsed representations.
 */
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

/**
 * Tool-result block inside a user message.
 *
 * Research §1 confirms `content` is sometimes a plain string and sometimes an array of
 * `{ type, text }` objects, depending on Claude version and whether the tool succeeded.
 */
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<{ type: string; text: string }>;
  is_error?: boolean;
}

// ---------------------------------------------------------------------------
// Wire variants (7 real + 1 catch-all)
// ---------------------------------------------------------------------------

/**
 * Emitted once at session start.
 *
 * NOTE: `permissionMode` is intentionally camelCase — the SamSaffron gist spec uses this
 * exact casing on the wire, unlike every other field which uses snake_case.
 */
export interface SystemInitEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  cwd: string;
  model: string;
  tools: string[];
  mcp_servers: Array<{ name: string; status: string }>;
  /** camelCase on the wire per SamSaffron CLI spec — intentional exception to snake_case rule */
  permissionMode: string;
  apiKeySource?: string;
  claude_code_version?: string;
  uuid?: string;
  /** SDK types this as `string[]`; older wire captures used a name→definition map. Accept both. */
  agents?: Record<string, unknown> | string[];
  betas?: string[];
  slash_commands?: string[];
  output_style?: string;
  /** SDK types this as `string[]`; older wire captures used a name→definition map. Accept both. */
  skills?: Record<string, unknown> | string[];
  plugins?: Array<{ name: string; path: string }>;
}

/**
 * Emitted by the legacy `--include-partial-messages` CLI when an API call retries.
 *
 * NOTE: The Claude Agent SDK does NOT emit this exact shape. The SDK surfaces retry-ish
 * signals via `SDKStatusMessage` and rate-limit signals via `SDKRateLimitEvent`.
 * This variant is retained intact to keep `messageProjection.ts`'s api_retry skip branch
 * compiling during the migration window. T8 (fixture & test migration) owns its eventual
 * removal once messageProjection.ts and rawEventsSink.ts no longer reference it.
 */
export interface SystemApiRetryEvent {
  type: 'system';
  subtype: 'api_retry';
  attempt: number;
  max_retries: number;
  retry_delay_ms: number;
  error_status?: number;
  error?: {
    category: string;
    message?: string;
  };
}

/**
 * LEGACY: `--include-partial-messages` CLI shape for context-window compaction.
 *
 * The Claude Agent SDK emits the SAME semantic event with a DIFFERENT shape — see
 * `SystemCompactBoundaryEvent` below. This variant is retained verbatim to keep
 * messageProjection.ts's existing compact handler (which reads `summary`) compiling
 * during the migration. T8 owns removal once messageProjection.ts switches to reading
 * compact_metadata from SystemCompactBoundaryEvent.
 */
export interface SystemCompactEvent {
  type: 'system';
  subtype: 'compact';
  session_id?: string;
  summary?: string;
}

/**
 * Emitted by the Claude Agent SDK when context-window compaction occurs.
 * Replaces the legacy `SystemCompactEvent` shape. The `compact_metadata` field
 * carries the trigger reason and pre-compaction token count.
 */
export interface SystemCompactBoundaryEvent {
  type: 'system';
  subtype: 'compact_boundary';
  uuid?: string;
  session_id?: string;
  compact_metadata: {
    trigger: 'manual' | 'auto';
    pre_tokens: number;
  };
}

/**
 * Emitted for each assistant message, including those containing tool_use blocks.
 * The `content` array may be mixed (text + tool_use + thinking in any order).
 */
export interface AssistantEvent {
  type: 'assistant';
  message: {
    id: string;
    model: string;
    role: 'assistant';
    content: Array<TextBlock | ToolUseBlock | ThinkingBlock>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    stop_reason?: string | null;
    stop_sequence?: string | null;
  };
  parent_tool_use_id?: string | null;
  session_id?: string;
  uuid?: string;
  error?: { message?: string; [k: string]: unknown };
}

/**
 * Emitted for each user turn, primarily carrying tool_result blocks.
 *
 * NOTE: `tool_use_result.durationMs` and `tool_use_result.numFiles` are camelCase per the
 * SamSaffron gist reference — these are the confirmed wire casings, not a convention violation.
 */
export interface UserEvent {
  type: 'user';
  message: {
    role: 'user';
    /**
     * Primarily carries `tool_result` blocks (SDK-emitted user turns). May also carry
     * `text` blocks for genuine user-text turns (e.g. the on-demand monitor's injected
     * conversation turns — see `main/src/orchestrator/programmatic/syntheticEvents.ts`).
     * This widening is additive/back-compat: existing SDK producers emit only tool_result.
     */
    content: Array<ToolResultBlock | TextBlock>;
  };
  tool_use_result?: {
    filenames?: string[];
    /** camelCase on the wire per SamSaffron gist */
    durationMs?: number;
    /** camelCase on the wire per SamSaffron gist */
    numFiles?: number;
    truncated?: boolean;
  };
  parent_tool_use_id?: string | null;
  session_id?: string;
  uuid?: string;
}

/**
 * Emitted once at session end. The `subtype` field encodes the 5 terminal conditions:
 *   - `success`               — completed normally
 *   - `error_max_turns`       — hit the --max-turns limit
 *   - `error_max_budget_usd`  — hit the --max-budget-usd spending cap
 *   - `error_during_execution` — an unrecoverable error occurred mid-run
 *   - `error_max_structured_output_retries` — exceeded structured output retry budget (SDK)
 *
 * `is_error` will be `true` for all non-success subtypes.
 * `permission_denials` records any tools that were denied by the --permission-prompt-tool handler.
 *
 * NOTE: `modelUsage` is intentionally camelCase — per the SamSaffron CLI spec gist this is the
 * third documented wire exception alongside `system/init.permissionMode` and
 * `user.tool_use_result.{durationMs,numFiles}`. Every sibling field on this variant
 * (`total_cost_usd`, `num_turns`, `duration_ms`, `is_error`, `permission_denials`) is
 * snake_case — do NOT "normalize" `modelUsage` to `model_usage` or parsing will break.
 */
export interface ResultEvent {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_max_budget_usd' | 'error_during_execution' | 'error_max_structured_output_retries';
  is_error: boolean;
  duration_ms: number;
  num_turns: number;
  result?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  /** camelCase on the wire per SamSaffron CLI spec — intentional exception to snake_case rule */
  modelUsage?: Record<string, unknown>;
  permission_denials?: Array<{
    tool_name: string;
    tool_use_id: string;
    tool_input: Record<string, unknown>;
  }>;
  session_id?: string;
  uuid?: string;
}

/**
 * Streaming Anthropic API events forwarded by Claude Code when
 * `--output-format stream-json --include-partial-messages` is active.
 *
 * NOTE: The wire discriminant is the two-word string `stream_event`, not `stream_delta` or
 * `StreamDeltaEvent` as named in some early design docs.
 */
export interface StreamEvent {
  type: 'stream_event';
  event: {
    type:
      | 'message_start'
      | 'content_block_start'
      | 'content_block_delta'
      | 'content_block_stop'
      | 'message_delta'
      | 'message_stop';
    index?: number;
    delta?: {
      type?: 'text_delta' | 'input_json_delta' | 'signature_delta' | 'thinking_delta';
      text?: string;
      partial_json?: string;
      signature?: string;
      thinking?: string;
    };
    content_block?: { type: string; [k: string]: unknown };
    message?: Record<string, unknown>;
  };
  parent_tool_use_id?: string | null;
  session_id?: string;
  uuid?: string;
}

/**
 * Orchestrator-synthetic event emitted by RunLauncher immediately before the SDK iterator
 * begins. This is NOT an SDK wire event. It signals to the renderer that the run has
 * started, closing the "Waiting for events…" gap before the first real SDK event arrives.
 */
export interface RunStartedEvent {
  type: 'run_started';
  runId: string;
  worktreePath: string;
  branchName: string;
  /**
   * The A/B variant label assigned to this run (migration 046), surfaced at launch
   * so the renderer can badge the run without an extra query. Omitted for a
   * baseline (no-variant) run.
   */
  variantLabel?: string;
}

/**
 * Orchestrator-synthetic event emitted once at SDK run start (claudeCodeManager.ts:251-260).
 * This is NOT an SDK wire event — it is synthesized by the main process and emitted before
 * the SDK iterator begins. It carries run metadata the renderer needs to display the
 * "Run started" header card.
 */
export interface SessionInfoEvent {
  type: 'session_info';
  initial_prompt: string;
  claude_command: string;
  worktree_path: string;
  model: string;
  permission_mode: string;
  timestamp: string;
}

/**
 * SDK `rate_limit_event` — emitted when the claude.ai subscription rate-limit gate is checked.
 * The `rate_limit_info` object is nested (not flat) per sdk.d.ts:SDKRateLimitEvent.
 *
 * NOTE: The IDEA description incorrectly described `status`, `resetsAt`, and `overageStatus`
 * as direct fields; they are nested inside `rate_limit_info`. The schema matches sdk.d.ts.
 */
export interface RateLimitEvent {
  type: 'rate_limit_event';
  rate_limit_info: {
    status: 'allowed' | 'allowed_warning' | 'rejected';
    resetsAt?: number;
    rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_overage_included' | 'overage';
    utilization?: number;
    overageStatus?: 'allowed' | 'allowed_warning' | 'rejected';
    overageResetsAt?: number;
    overageDisabledReason?: string;
    isUsingOverage?: boolean;
    surpassedThreshold?: number;
  };
  uuid: string;
  session_id: string;
}

/**
 * SDK `system/hook_started` — emitted when a registered hook begins executing.
 * Source: sdk.d.ts:SDKHookStartedMessage.
 */
export interface SystemHookStartedEvent {
  type: 'system';
  subtype: 'hook_started';
  hook_id: string;
  hook_name: string;
  hook_event: string;
  uuid: string;
  session_id: string;
}

/**
 * SDK `system/hook_response` — emitted when a registered hook finishes.
 * Source: sdk.d.ts:SDKHookResponseMessage.
 *
 * NOTE: The IDEA description incorrectly listed the outcome enum as `allow | deny | defer`;
 * sdk.d.ts confirms it is `success | error | cancelled`.
 */
export interface SystemHookResponseEvent {
  type: 'system';
  subtype: 'hook_response';
  hook_id: string;
  hook_name: string;
  hook_event: string;
  output: string;
  stdout: string;
  stderr: string;
  exit_code?: number;
  outcome: 'success' | 'error' | 'cancelled';
  uuid: string;
  session_id: string;
}

/**
 * SDK `system/status` — emitted to report SDK internal status changes such as context
 * compaction in progress or a model API request being issued.
 * Source: sdk.d.ts:SDKStatusMessage.
 */
export interface SystemStatusEvent {
  type: 'system';
  subtype: 'status';
  status: 'compacting' | 'requesting' | null;
  permissionMode?: string;
  compact_result?: 'success' | 'failed';
  compact_error?: string;
  uuid: string;
  session_id: string;
}

/**
 * Parser-only catch-all variant for events that do not match any known wire discriminant.
 *
 * The sentinel discriminant is `kind: '__unknown__'` (not `type`) so it cannot collide with
 * any real or future wire `type` value from Anthropic — even if Anthropic adds a new `type`
 * string we have not yet seen.
 *
 * The TASK-102 Zod parser produces this variant when no discriminated branch matches.
 * Downstream code that does a `switch (event.type)` should never reach this branch for real
 * production events, but it prevents crashes on schema drift.
 */
export interface UnknownStreamEvent {
  kind: '__unknown__';
  raw: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

/**
 * The full set of events emitted by the Claude Agent SDK and the cyboflow orchestrator.
 * Discriminate on `event.type` for all real wire variants; discriminate on
 * `event.kind === '__unknown__'` for the catch-all.
 *
 * For `system` events, also check `event.subtype`
 * (`'init' | 'api_retry' | 'compact' | 'compact_boundary' | 'hook_started' | 'hook_response' | 'status'`).
 * For `result` events, also check `event.subtype` (`'success' | 'error_max_turns' | ...`).
 *
 * Additional top-level discriminators added in TASK-696:
 *   - `session_info` — orchestrator-synthetic run-metadata card (SessionInfoEvent)
 *   - `rate_limit_event` — SDK subscription rate-limit gate (RateLimitEvent)
 */
export type ClaudeStreamEvent =
  | SystemInitEvent
  | SystemApiRetryEvent
  | SystemCompactEvent
  | SystemCompactBoundaryEvent
  | SystemHookStartedEvent
  | SystemHookResponseEvent
  | SystemStatusEvent
  | SessionInfoEvent
  | RateLimitEvent
  | AssistantEvent
  | UserEvent
  | ResultEvent
  | StreamEvent
  | UnknownStreamEvent;

// ---------------------------------------------------------------------------
// Renderer-facing StreamEventType union
// ---------------------------------------------------------------------------

/**
 * The discriminator values used on the IPC envelope's `type` field.
 *
 * These mirror the top-level `type` on each `ClaudeStreamEvent` variant, plus:
 *   - `'run_started'`      — orchestrator-synthetic event emitted by RunLauncher before the
 *                            SDK iterator begins (not a ClaudeStreamEvent variant).
 *   - `'session_info'`     — orchestrator-synthetic metadata card (SessionInfoEvent).
 *   - `'rate_limit_event'` — SDK subscription rate-limit gate (RateLimitEvent).
 *   - `'unknown'`          — emitted by deriveEventType when no known discriminant matches.
 *
 * The renderer's `StreamEvent` discriminated union and `RunView.renderEvent` switch are
 * keyed on this type. Add new discriminants here before adding new switch arms.
 */
export type StreamEventType =
  | 'system'
  | 'assistant'
  | 'user'
  | 'result'
  | 'stream_event'
  | 'session_info'
  | 'rate_limit_event'
  | 'run_started'
  | 'unknown';

/**
 * Discriminated payload union for StreamEnvelope. Each arm pairs a StreamEventType
 * value with the corresponding payload shape. `unknown` is the catch-all for the
 * 'unknown' arm (deriveEventType emits 'unknown' when classification fails).
 *
 * Updated alongside StreamEventType — keep the two unions in sync.
 */
export type StreamEnvelopePayload =
  | { type: 'system';            payload: SystemInitEvent | SystemApiRetryEvent | SystemCompactEvent | SystemCompactBoundaryEvent | SystemHookStartedEvent | SystemHookResponseEvent | SystemStatusEvent }
  | { type: 'assistant';         payload: AssistantEvent }
  | { type: 'user';              payload: UserEvent }
  | { type: 'result';            payload: ResultEvent }
  | { type: 'stream_event';      payload: StreamEvent }
  | { type: 'session_info';      payload: SessionInfoEvent }
  | { type: 'rate_limit_event';  payload: RateLimitEvent }
  | { type: 'run_started';       payload: RunStartedEvent }
  | { type: 'unknown';           payload: unknown };

/**
 * IPC envelope wrapping every ClaudeStreamEvent emitted from the main process to
 * the renderer's `cyboflow:stream:<runId>` channel.
 *
 * Discriminate on `type`. The renderer-side `StreamEvent` discriminated union
 * in `frontend/src/utils/cyboflowApi.ts` narrows `payload` per `type`.
 *
 * TASK-725: `payload` is now the discriminated `StreamEnvelopePayload` union (not
 * `unknown`) so TypeScript catches contract drift at the publish site. The bridge
 * construction at `runEventBridge.ts:237` uses a single `as StreamEnvelope` cast
 * at the audited boundary — see the Hardest Decision note in TASK-725-plan.md.
 */
export type StreamEnvelope = StreamEnvelopePayload & { timestamp: string };

// ---------------------------------------------------------------------------
// Exhaustive-check helper
// ---------------------------------------------------------------------------

/**
 * Use this in the `default` branch of a `switch (event.type)` to get a compile-time error
 * if any variant of `ClaudeStreamEvent` is not handled.
 *
 * Usage:
 * ```ts
 * function handleEvent(event: ClaudeStreamEvent): void {
 *   switch (event.type) {
 *     case 'system':      return handleSystem(event);
 *     case 'assistant':   return handleAssistant(event);
 *     case 'user':        return handleUser(event);
 *     case 'result':      return handleResult(event);
 *     case 'stream_event': return handleStreamEvent(event);
 *     default:            return assertNever(event);
 *   }
 * }
 * ```
 *
 * Note: `UnknownStreamEvent` uses `kind` instead of `type`, so it will not appear in the
 * switch discriminant. Handle it before the switch (check `'kind' in event`) or treat the
 * `default` branch as its handler.
 */
export function assertNever(x: never): never {
  throw new Error(`Unhandled stream event variant: ${(x as { type?: unknown })?.type ?? '<no-type>'}`);
}
