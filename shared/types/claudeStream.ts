/**
 * Wire-format types for Claude Code's `stream-json` output. The discriminant pair is `type`
 * (top-level) and `subtype` (nested, for `system` and `result`). All field names match the
 * actual JSON wire format (snake_case), with the documented exception of `permissionMode` on
 * `system/init` per the SamSaffron CLI spec gist.
 *
 * Sources:
 *   - CLAUDE_AGENT_SDK_SPEC.md gist (SamSaffron): https://gist.github.com/SamSaffron/603648958a8c18ceae34939a8951d417
 *   - Architecture research §1: .soloflow/active/research/ROADMAP-001-research-architecture.md
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
}

/**
 * Emitted when the Claude API call is being retried after a transient failure.
 * `error.category` may be: `rate_limit`, `server_error`, `billing_error`, etc.
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
 * Emitted when Claude performs a context-window compaction.
 *
 * NOTE: This variant is NOT in Anthropic's official stream-json specification but is confirmed
 * by community reverse-engineering and is handled by Crystal's ClaudeMessageTransformer.ts.
 * Crystal's transformer uses the string `context_compacted` internally (line 338), but the
 * actual wire discriminant is `compact` — this type uses the real wire value.
 */
export interface SystemCompactEvent {
  type: 'system';
  subtype: 'compact';
  session_id?: string;
  summary?: string;
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
  };
  parent_tool_use_id?: string;
  session_id?: string;
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
    content: ToolResultBlock[];
  };
  tool_use_result?: {
    filenames?: string[];
    /** camelCase on the wire per SamSaffron gist */
    durationMs?: number;
    /** camelCase on the wire per SamSaffron gist */
    numFiles?: number;
    truncated?: boolean;
  };
  parent_tool_use_id?: string;
  session_id?: string;
}

/**
 * Emitted once at session end. The `subtype` field encodes the 4 terminal conditions:
 *   - `success`               — completed normally
 *   - `error_max_turns`       — hit the --max-turns limit
 *   - `error_max_budget_usd`  — hit the --max-budget-usd spending cap
 *   - `error_during_execution` — an unrecoverable error occurred mid-run
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
  subtype: 'success' | 'error_max_turns' | 'error_max_budget_usd' | 'error_during_execution';
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
      type?: 'text_delta' | 'input_json_delta';
      text?: string;
      partial_json?: string;
    };
    content_block?: { type: string; [k: string]: unknown };
    message?: Record<string, unknown>;
  };
  parent_tool_use_id?: string;
  session_id?: string;
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
 * The full set of events emitted by `claude --output-format stream-json --verbose
 * --include-partial-messages`. Discriminate on `event.type` for all real wire variants;
 * discriminate on `event.kind === '__unknown__'` for the catch-all.
 *
 * For `system` events, also check `event.subtype` (`'init' | 'api_retry' | 'compact'`).
 * For `result` events, also check `event.subtype` (`'success' | 'error_max_turns' | ...`).
 */
export type ClaudeStreamEvent =
  | SystemInitEvent
  | SystemApiRetryEvent
  | SystemCompactEvent
  | AssistantEvent
  | UserEvent
  | ResultEvent
  | StreamEvent
  | UnknownStreamEvent;

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
  throw new Error('Unhandled stream event variant: ' + JSON.stringify(x));
}
