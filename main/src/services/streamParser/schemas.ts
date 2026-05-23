/**
 * Runtime validation layer for Claude Code's `stream-json` wire events.
 *
 * Type contract: `shared/types/claudeStream.ts`
 *
 * This module exports:
 *   - `claudeStreamEventSchema` — the Zod schema that defines the full wire-event
 *     union. Use `.safeParse()` only through the narrower below.
 *
 * Compile-time check (module-local, not exported):
 *   - `_typeCheck` — TS↔Zod drift bridge that fails to compile if the schema output
 *     drifts from the `ClaudeStreamEvent` type.
 *
 * For runtime parsing of stream events, consume `TypedEventNarrowing.narrow()` from
 * the streamParser barrel — that is the single production implementation of the
 * safeParse-and-fallback contract. Do NOT call `claudeStreamEventSchema.parse` or
 * `.safeParse` directly in production code.
 */

import { z } from 'zod';
import type { ClaudeStreamEvent, SystemApiRetryEvent, SystemCompactEvent, UnknownStreamEvent } from '../../../../shared/types/claudeStream';

// ---------------------------------------------------------------------------
// Block-level schemas
// ---------------------------------------------------------------------------

const textBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const toolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
});

const thinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
});

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
});

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
  uuid: z.string().optional(),
  agents: z.record(z.unknown()).optional(),
  betas: z.array(z.string()).optional(),
  slash_commands: z.array(z.string()).optional(),
  output_style: z.string().optional(),
  skills: z.record(z.unknown()).optional(),
  plugins: z.array(z.object({ name: z.string(), path: z.string() }).passthrough()).optional(),
});

/**
 * system/compact_boundary: Claude Agent SDK shape for context-window compaction.
 */
const systemCompactBoundarySchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('compact_boundary'),
  uuid: z.string().optional(),
  session_id: z.string().optional(),
  compact_metadata: z.object({
    trigger: z.union([z.literal('manual'), z.literal('auto')]),
    pre_tokens: z.number(),
  }).passthrough(),
});

/**
 * system/hook_started: emitted when a registered hook begins executing.
 * Source: sdk.d.ts:SDKHookStartedMessage.
 */
const systemHookStartedSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('hook_started'),
  hook_id: z.string(),
  hook_name: z.string(),
  hook_event: z.string(),
  uuid: z.string(),
  session_id: z.string(),
});

/**
 * system/hook_response: emitted when a registered hook finishes.
 * Source: sdk.d.ts:SDKHookResponseMessage.
 * NOTE: outcome is `success | error | cancelled` per SDK (NOT `allow | deny | defer`).
 */
const systemHookResponseSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('hook_response'),
  hook_id: z.string(),
  hook_name: z.string(),
  hook_event: z.string(),
  output: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  exit_code: z.number().optional(),
  outcome: z.union([z.literal('success'), z.literal('error'), z.literal('cancelled')]),
  uuid: z.string(),
  session_id: z.string(),
});

/**
 * system/status: SDK internal status changes (compacting, requesting).
 * Source: sdk.d.ts:SDKStatusMessage.
 */
const systemStatusSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('status'),
  status: z.union([z.literal('compacting'), z.literal('requesting'), z.null()]),
  permissionMode: z.string().optional(),
  compact_result: z.union([z.literal('success'), z.literal('failed')]).optional(),
  compact_error: z.string().optional(),
  uuid: z.string(),
  session_id: z.string(),
});

// Inner discriminated union for system variants — dispatches on subtype.
const systemUnionSchema = z.discriminatedUnion('subtype', [
  systemInitSchema,
  systemCompactBoundarySchema,
  systemHookStartedSchema,
  systemHookResponseSchema,
  systemStatusSchema,
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
    stop_reason: z.union([z.string(), z.null()]).optional(),
    stop_sequence: z.union([z.string(), z.null()]).optional(),
  }).passthrough(),
  parent_tool_use_id: z.union([z.string(), z.null()]).optional(),
  session_id: z.string().optional(),
  uuid: z.string().optional(),
  error: z.object({ message: z.string().optional() }).passthrough().optional(),
});

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
  parent_tool_use_id: z.union([z.string(), z.null()]).optional(),
  session_id: z.string().optional(),
  uuid: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Result variant schemas (subtype-discriminated into five siblings)
// ---------------------------------------------------------------------------

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
  uuid: z.string().optional(),
};

const resultSuccessSchema = z.object({
  ...resultBaseFields,
  subtype: z.literal('success'),
});

const resultErrorMaxTurnsSchema = z.object({
  ...resultBaseFields,
  subtype: z.literal('error_max_turns'),
});

const resultErrorMaxBudgetSchema = z.object({
  ...resultBaseFields,
  subtype: z.literal('error_max_budget_usd'),
});

const resultErrorDuringExecutionSchema = z.object({
  ...resultBaseFields,
  subtype: z.literal('error_during_execution'),
});

const resultErrorMaxStructuredOutputRetriesSchema = z.object({
  ...resultBaseFields,
  subtype: z.literal('error_max_structured_output_retries'),
});

// Inner discriminated union for result variants — dispatches on subtype.
const resultUnionSchema = z.discriminatedUnion('subtype', [
  resultSuccessSchema,
  resultErrorMaxTurnsSchema,
  resultErrorMaxBudgetSchema,
  resultErrorDuringExecutionSchema,
  resultErrorMaxStructuredOutputRetriesSchema,
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
    /** Four content_block_delta delta types. text/input_json appear on text+tool_use blocks; signature/thinking appear on thinking blocks (extended-thinking mode). */
    delta: z.object({
      type: z.union([
        z.literal('text_delta'),
        z.literal('input_json_delta'),
        z.literal('signature_delta'),
        z.literal('thinking_delta'),
      ]).optional(),
      text: z.string().optional(),
      partial_json: z.string().optional(),
      signature: z.string().optional(),
      thinking: z.string().optional(),
    }).passthrough().optional(),
    content_block: z.object({ type: z.string() }).passthrough().optional(),
    message: z.record(z.unknown()).optional(),
  }).passthrough(),
  parent_tool_use_id: z.union([z.string(), z.null()]).optional(),
  session_id: z.string().optional(),
  uuid: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Session info schema (orchestrator-synthetic, top-level discriminant)
// ---------------------------------------------------------------------------

/**
 * Orchestrator-synthetic session_info event emitted by claudeCodeManager.ts:251-260.
 * Not a wire SDK event — synthesized before the SDK iterator starts.
 */
const sessionInfoSchema = z.object({
  type: z.literal('session_info'),
  initial_prompt: z.string(),
  claude_command: z.string(),
  worktree_path: z.string(),
  model: z.string(),
  permission_mode: z.string(),
  timestamp: z.string(),
});

// ---------------------------------------------------------------------------
// Rate limit event schema (top-level discriminant)
// ---------------------------------------------------------------------------

/**
 * SDK rate_limit_event — rate-limit gate for claude.ai subscription users.
 * Source: sdk.d.ts:SDKRateLimitEvent. Fields are nested under rate_limit_info (NOT flat).
 */
const rateLimitEventSchema = z.object({
  type: z.literal('rate_limit_event'),
  rate_limit_info: z.object({
    status: z.union([z.literal('allowed'), z.literal('allowed_warning'), z.literal('rejected')]),
    resetsAt: z.number().optional(),
    rateLimitType: z.union([
      z.literal('five_hour'),
      z.literal('seven_day'),
      z.literal('seven_day_opus'),
      z.literal('seven_day_sonnet'),
      z.literal('overage'),
    ]).optional(),
    utilization: z.number().optional(),
    overageStatus: z.union([z.literal('allowed'), z.literal('allowed_warning'), z.literal('rejected')]).optional(),
    overageResetsAt: z.number().optional(),
    overageDisabledReason: z.string().optional(),
    isUsingOverage: z.boolean().optional(),
    surpassedThreshold: z.number().optional(),
  }).passthrough(),
  uuid: z.string(),
  session_id: z.string(),
});

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
  sessionInfoSchema,
  rateLimitEventSchema,
  assistantEventSchema,
  userEventSchema,
  resultUnionSchema,
  streamEventSchema,
]);

// ---------------------------------------------------------------------------
// Compile-time drift bridges
// ---------------------------------------------------------------------------

// Forward bridge: ensures schema output is assignable to ClaudeStreamEvent.
// TypeScript errors here if the schema drifts from the shared type definition.
const _typeCheck: ClaudeStreamEvent = {} as z.infer<typeof claudeStreamEventSchema>;
void _typeCheck;

// Reverse bridge: assert ClaudeStreamEvent is assignable to z.infer<schema>.
// Together with _typeCheck above, this forces TS↔Zod to stay structurally
// equal — fields added to the TS union but missing from the Zod schema
// (or vice versa) produce a `tsc --noEmit` error at this line.
// Requires outer schemas to have no .passthrough() (Option 3 — TASK-656).
//
// SystemApiRetryEvent, SystemCompactEvent: intentionally-omitted legacy CLI
// variants kept in the TS union to compile messageProjection.ts skip branches
// during the migration window. Zod schema intentionally does not model them.
// UnknownStreamEvent: parser-only catch-all; never produced by Zod safeParse.
// Excluding all three is correct — new drift on OTHER variants is still caught.
const _reverseCheck: z.infer<typeof claudeStreamEventSchema> = {} as Exclude<ClaudeStreamEvent, SystemApiRetryEvent | SystemCompactEvent | UnknownStreamEvent>;
void _reverseCheck;
