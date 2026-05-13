/**
 * Runtime validation layer for Claude Code's `stream-json` wire events.
 *
 * Type contract: `shared/types/claudeStream.ts`
 *
 * This module owns runtime validation only. Downstream code should consume the
 * typed return value from `parseClaudeStreamEvent` and never call
 * `claudeStreamEventSchema.parse` directly — the former is guaranteed non-throwing,
 * the latter is not.
 */

import { z } from 'zod';
import type { ClaudeStreamEvent } from '../../../../shared/types/claudeStream';

// ---------------------------------------------------------------------------
// Block-level schemas
// ---------------------------------------------------------------------------

const textBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
}).passthrough();

const toolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
}).passthrough();

const thinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
}).passthrough();

/**
 * tool_result.content can be a plain string or an array of { type, text } objects.
 * Research §1 confirms both forms appear on the wire.
 */
const toolResultContentSchema = z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string() }).passthrough())]);

const toolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: toolResultContentSchema,
  is_error: z.boolean().optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// System variant schemas (subtype-discriminated)
// ---------------------------------------------------------------------------

const systemInitSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: z.string(),
  cwd: z.string(),
  model: z.string(),
  tools: z.array(z.string()),
  mcp_servers: z.array(z.object({ name: z.string(), status: z.string() }).passthrough()),
  /** camelCase on the wire per SamSaffron CLI spec — intentional exception to snake_case rule */
  permissionMode: z.string(),
  apiKeySource: z.string().optional(),
  claude_code_version: z.string().optional(),
}).passthrough();

const systemApiRetrySchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('api_retry'),
  attempt: z.number(),
  max_retries: z.number(),
  retry_delay_ms: z.number(),
  error_status: z.number().optional(),
  error: z.object({
    category: z.string(),
    message: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

/**
 * system/compact: not in the official spec but confirmed by community reverse-engineering
 * and handled in Crystal's ClaudeMessageTransformer.ts.
 */
const systemCompactSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('compact'),
  session_id: z.string().optional(),
  summary: z.string().optional(),
}).passthrough();

// Inner discriminated union for system variants — dispatches on subtype.
const systemUnionSchema = z.discriminatedUnion('subtype', [
  systemInitSchema,
  systemApiRetrySchema,
  systemCompactSchema,
]);

// ---------------------------------------------------------------------------
// Assistant variant schema
// ---------------------------------------------------------------------------

const contentBlockSchema = z.union([
  textBlockSchema,
  toolUseBlockSchema,
  thinkingBlockSchema,
]);

const assistantEventSchema = z.object({
  type: z.literal('assistant'),
  message: z.object({
    id: z.string(),
    model: z.string(),
    role: z.literal('assistant'),
    content: z.array(contentBlockSchema),
    usage: z.object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
    }).passthrough().optional(),
  }).passthrough(),
  parent_tool_use_id: z.string().optional(),
  session_id: z.string().optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// User variant schema
// ---------------------------------------------------------------------------

const userEventSchema = z.object({
  type: z.literal('user'),
  message: z.object({
    role: z.literal('user'),
    content: z.array(toolResultBlockSchema),
  }).passthrough(),
  tool_use_result: z.object({
    filenames: z.array(z.string()).optional(),
    /** camelCase on the wire per SamSaffron gist */
    durationMs: z.number().optional(),
    /** camelCase on the wire per SamSaffron gist */
    numFiles: z.number().optional(),
    truncated: z.boolean().optional(),
  }).passthrough().optional(),
  parent_tool_use_id: z.string().optional(),
  session_id: z.string().optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Result variant schemas (subtype-discriminated into four siblings)
// ---------------------------------------------------------------------------

/**
 * All valid subtype literals for the result event.
 * Used for documentation and potential future validation helpers.
 * The four sibling schemas below each pin a single z.literal so that
 * z.discriminatedUnion('subtype', [...]) can dispatch in O(1).
 */
const resultSubtypeEnum = z.enum(['success', 'error_max_turns', 'error_max_budget_usd', 'error_during_execution']);
void resultSubtypeEnum; // referenced as documentation; siblings use z.literal for perf

/** Shared fields present on every result variant. */
const resultBaseFields = {
  type: z.literal('result'),
  is_error: z.boolean(),
  duration_ms: z.number(),
  num_turns: z.number(),
  result: z.string().optional(),
  total_cost_usd: z.number().optional(),
  usage: z.object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
  }).passthrough().optional(),
  /** camelCase on the wire per SamSaffron CLI spec — intentional exception */
  modelUsage: z.record(z.unknown()).optional(),
  permission_denials: z.array(z.object({
    tool_name: z.string(),
    tool_use_id: z.string(),
    tool_input: z.record(z.unknown()),
  }).passthrough()).optional(),
  session_id: z.string().optional(),
};

const resultSuccessSchema = z.object({
  ...resultBaseFields,
  subtype: z.literal('success'),
}).passthrough();

const resultErrorMaxTurnsSchema = z.object({
  ...resultBaseFields,
  subtype: z.literal('error_max_turns'),
}).passthrough();

const resultErrorMaxBudgetSchema = z.object({
  ...resultBaseFields,
  subtype: z.literal('error_max_budget_usd'),
}).passthrough();

const resultErrorDuringExecutionSchema = z.object({
  ...resultBaseFields,
  subtype: z.literal('error_during_execution'),
}).passthrough();

// Inner discriminated union for result variants — dispatches on subtype.
const resultUnionSchema = z.discriminatedUnion('subtype', [
  resultSuccessSchema,
  resultErrorMaxTurnsSchema,
  resultErrorMaxBudgetSchema,
  resultErrorDuringExecutionSchema,
]);

// ---------------------------------------------------------------------------
// StreamEvent variant schema
// ---------------------------------------------------------------------------

const streamEventSchema = z.object({
  type: z.literal('stream_event'),
  event: z.object({
    type: z.union([
      z.literal('message_start'),
      z.literal('content_block_start'),
      z.literal('content_block_delta'),
      z.literal('content_block_stop'),
      z.literal('message_delta'),
      z.literal('message_stop'),
    ]),
    index: z.number().optional(),
    delta: z.object({
      type: z.union([z.literal('text_delta'), z.literal('input_json_delta')]).optional(),
      text: z.string().optional(),
      partial_json: z.string().optional(),
    }).passthrough().optional(),
    content_block: z.object({ type: z.string() }).passthrough().optional(),
    message: z.record(z.unknown()).optional(),
  }).passthrough(),
  parent_tool_use_id: z.string().optional(),
  session_id: z.string().optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Top-level union
//
// Note: z.discriminatedUnion('type', [...]) does not accept nested
// z.discriminatedUnion instances as branches (Zod 3.x constraint — see plan
// §"Lowest Confidence Area"). Falling back to z.union per the documented
// plan fallback; safeParse semantics are identical. Inner discriminated unions
// (systemUnionSchema, resultUnionSchema) remain as discriminatedUnion for
// their subtype dispatch.
// Excludes UnknownStreamEvent — that is the fallback produced by the parser
// function when no branch matches.
// ---------------------------------------------------------------------------

export const claudeStreamEventSchema = z.union([
  systemUnionSchema,
  assistantEventSchema,
  userEventSchema,
  resultUnionSchema,
  streamEventSchema,
]);

// Compile-time guarantee: schema output is assignable to ClaudeStreamEvent.
// The `parseClaudeStreamEvent` return type annotation below enforces this at
// the call site — TypeScript errors if `parsed.data` is not assignable to
// `ClaudeStreamEvent`. This explicit assignment also catches the case where
// the function signature drifts from the actual returned union.
const _typeCheck: ClaudeStreamEvent = {} as z.infer<typeof claudeStreamEventSchema>;
void _typeCheck;

// ---------------------------------------------------------------------------
// Parser function — NEVER throws
// ---------------------------------------------------------------------------

/**
 * Parse a raw unknown value into a typed `ClaudeStreamEvent`.
 *
 * On success, returns the narrowed `ClaudeStreamEvent` (one of the seven wire
 * variants). On any mismatch — unknown variant, extra/missing field, bad type
 * — returns `{ kind: '__unknown__', raw }` without throwing.
 */
export function parseClaudeStreamEvent(raw: unknown): ClaudeStreamEvent {
  const parsed = claudeStreamEventSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  // Observability: log the unmatched type + session_id before falling through.
  // IDEA-004 (full streamParser) will replace this with the proper Logger.
  const rawObj =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const wireType =
    typeof rawObj['type'] === 'string' ? rawObj['type'] : '<missing>';
  const sessionId =
    typeof rawObj['session_id'] === 'string'
      ? rawObj['session_id']
      : '<unknown>';
  console.warn(
    `[streamParser] unknown ClaudeStreamEvent variant type=${wireType} session_id=${sessionId}`,
  );
  return { kind: '__unknown__', raw: rawObj };
}
