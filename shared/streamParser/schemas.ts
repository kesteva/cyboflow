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
import type { ClaudeStreamEvent, SystemApiRetryEvent, SystemCompactEvent, UnknownStreamEvent } from '../types/claudeStream';

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
 * tool_result.content array elements. Two shapes are modelled explicitly:
 *   - image blocks: { type: 'image', source: { type, media_type, data } } — the
 *     base64-embedded shape a tool_result carries when a tool returns an image
 *     (e.g. a visual-verification screenshot). This block has NO `text` field,
 *     which is why the old single-shape arm (requiring `text: z.string()` on
 *     every element) rejected it outright, demoting the whole `user` event to
 *     `__unknown__` and dropping it from the transcript.
 *   - everything else: the pre-existing loose `{ type, text? }` passthrough
 *     catch-all — `text` is now OPTIONAL (was required) so an arbitrary/
 *     unrecognized block type with no `text` field is still accepted rather
 *     than narrowed out. This stays a plain union, not a discriminatedUnion:
 *     the catch-all doesn't pin a literal `type`, so it can't be a
 *     discriminated branch.
 */
const toolResultImageBlockSchema = z.object({
  type: z.literal('image'),
  source: z.object({ type: z.string(), media_type: z.string(), data: z.string() }).passthrough(),
}).passthrough();

const toolResultGenericBlockSchema = z.object({ type: z.string(), text: z.string().optional() }).passthrough();

/**
 * tool_result.content can be a plain string or an array of block objects.
 * Research §1 confirms both forms appear on the wire.
 */
const toolResultContentSchema = z.union([
  z.string(),
  z.array(z.union([toolResultImageBlockSchema, toolResultGenericBlockSchema])),
]);

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
  // SDK `SDKSystemMessage` types `agents`/`skills` as `string[]`; older wire
  // captures modeled them as name→definition maps. Accept both so a real SDK
  // `system/init` (which always carries `skills` as an array) narrows instead of
  // falling through to `{kind:'__unknown__'}`. Surfaced by the sdkContract keystone.
  agents: z.union([z.record(z.unknown()), z.array(z.string())]).optional(),
  betas: z.array(z.string()).optional(),
  slash_commands: z.array(z.string()).optional(),
  output_style: z.string().optional(),
  skills: z.union([z.record(z.unknown()), z.array(z.string())]).optional(),
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

/**
 * system/task_started: a background task began. SDK >=0.3.201 backgrounds
 * Agent-tool subagents by default; `local_bash` background commands share the
 * lifecycle. NOT in the SDK's published SDKMessage union — shape modelled from
 * observed `raw_events` samples, so it can drift without a type error anywhere.
 *
 * Hence, across all three task_* schemas ONLY the fields the projection actually
 * dispatches on are required; everything else — including `uuid`/`session_id`,
 * which no consumer reads — is optional, matching the init/compact_boundary
 * siblings. This matters because a `safeParse` failure demotes the event to
 * `{kind:'__unknown__'}`, which the projection drops: wire drift would silently
 * un-render background-task reports rather than fail loudly.
 *
 * Deliberately NOT `.passthrough()`, despite these being sample-modelled: every
 * top-level event schema here strips unknown keys, and opting out would force an
 * index signature onto the wire types to satisfy the `_typeCheck` drift bridge.
 * Consequence to know: the sink persists the NARROWED event, so an unmodelled
 * future field is dropped from `raw_events`. No observed field is lost today.
 */
const systemTaskStartedSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('task_started'),
  task_id: z.string(),
  tool_use_id: z.string().optional(),
  description: z.string().optional(),
  subagent_type: z.string().optional(),
  task_type: z.string().optional(),
  uuid: z.string().optional(),
  session_id: z.string().optional(),
});

/** system/task_updated: partial patch to a live background task. */
const systemTaskUpdatedSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('task_updated'),
  task_id: z.string(),
  patch: z.record(z.unknown()),
  uuid: z.string().optional(),
  session_id: z.string().optional(),
});

/**
 * system/task_notification: background task reached a terminal status. `summary`
 * carries the task's FINAL REPORT — for a backgrounded subagent it is the only
 * copy that reaches the parent stream.
 */
const systemTaskNotificationSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('task_notification'),
  task_id: z.string(),
  tool_use_id: z.string().optional(),
  status: z.string(),
  summary: z.string().optional(),
  output_file: z.string().optional(),
  usage: z.object({
    total_tokens: z.number().optional(),
    tool_uses: z.number().optional(),
    duration_ms: z.number().optional(),
  }).passthrough().optional(),
  uuid: z.string().optional(),
  session_id: z.string().optional(),
});

// Inner discriminated union for system variants — dispatches on subtype.
const systemUnionSchema = z.discriminatedUnion('subtype', [
  systemInitSchema,
  systemCompactBoundarySchema,
  systemHookStartedSchema,
  systemHookResponseSchema,
  systemStatusSchema,
  systemTaskStartedSchema,
  systemTaskUpdatedSchema,
  systemTaskNotificationSchema,
]);

// ---------------------------------------------------------------------------
// Assistant variant schema
// ---------------------------------------------------------------------------

// discriminatedUnion, not union: this parses once PER CONTENT BLOCK of every
// assistant message, so a plain union would build a ZodError for each
// non-matching block type on every block (see the dispatch-map comment at the
// bottom of this file for why that is expensive). All three arms are plain
// objects pinning a distinct `type`, which is exactly what Zod 3's
// discriminatedUnion requires. Accept/reject behaviour is unchanged — only the
// error SHAPE on failure differs, and the sole consumer
// (TypedEventNarrowing.narrow) discards the error and falls back to
// `__unknown__`.
const contentBlockSchema = z.discriminatedUnion('type', [
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
  // SDKAssistantMessageError is a bare string code ('authentication_failed',
  // 'rate_limit', …); the object form is the legacy shape. Accepting only the
  // object used to demote every synthetic auth-failure message to __unknown__.
  error: z.union([z.string(), z.object({ message: z.string().optional() }).passthrough()]).optional(),
});

// ---------------------------------------------------------------------------
// User variant schema
// ---------------------------------------------------------------------------

const userEventSchema = z.object({
  type: z.literal('user'),
  message: z.object({
    role: z.literal('user'),
    // Primarily tool_result blocks (SDK user turns); may also carry text blocks for
    // genuine user-text turns (the on-demand monitor's injected conversation turns).
    // Mirrors the additive widening of UserEvent.message.content in claudeStream.ts.
    // discriminatedUnion for the same per-block reason as contentBlockSchema.
    content: z.array(z.discriminatedUnion('type', [toolResultBlockSchema, textBlockSchema])),
  }).passthrough(),
  // Two wire shapes observed: the file-tool metadata OBJECT (SamSaffron gist), and
  // an ARRAY of content blocks — what an MCP tool result carries (confirmed in the
  // global-agent thread's persisted events, where every MCP tool_result user event
  // fell through to `{kind:'__unknown__'}` and its result vanished from the
  // transcript). Nothing reads this field; it is declared only so the variant
  // narrows, so the array arm stays deliberately loose.
  tool_use_result: z.union([
    z.object({
      filenames: z.array(z.string()).optional(),
      /** camelCase on the wire per SamSaffron gist */
      durationMs: z.number().optional(),
      /** camelCase on the wire per SamSaffron gist */
      numFiles: z.number().optional(),
      truncated: z.boolean().optional(),
    }).passthrough(),
    z.array(z.unknown()),
  ]).optional(),
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
      z.literal('seven_day_overage_included'),
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
// Top-level branch dispatch (performance)
//
// `z.union` has no fast path: Zod 3 tries each branch in order and CONSTRUCTS A
// FULL ZodError for every one that does not match — including the branches it
// discards before reaching the one that does. Since each ZodError captures a
// stack trace, the cost lands on every single streamed event. Profiling the
// main process under two concurrent sprint runs put `ZodError` construction at
// ~39% of ALL main-process CPU, with GC (churning those errors) next at ~10%.
//
// Every branch above pins a distinct top-level `type` literal, so the branch a
// value can possibly match is fully determined by `type` alone. This map makes
// that dispatch O(1) and parses exactly ONE branch, which is semantically
// identical to the union — a value whose `type` is X cannot match any branch
// that pins a different literal, and a value with a missing/non-string `type`
// matches nothing either way (both routes yield the `__unknown__` fallback).
//
// The union above is retained as the source of truth for the drift bridges;
// {@link TypedEventNarrowing} is the only runtime consumer and it uses this map.
// ---------------------------------------------------------------------------

export const claudeStreamEventSchemaByType = {
  system: systemUnionSchema,
  session_info: sessionInfoSchema,
  rate_limit_event: rateLimitEventSchema,
  assistant: assistantEventSchema,
  user: userEventSchema,
  result: resultUnionSchema,
  stream_event: streamEventSchema,
} as const;

// Compile-time coverage bridges — the reason a forgotten map entry cannot
// silently demote a whole event variant to `__unknown__` at runtime. Adding a
// branch to the union without adding it here (or vice versa) fails `tsc`.
type MapBranchOutput = z.infer<
  (typeof claudeStreamEventSchemaByType)[keyof typeof claudeStreamEventSchemaByType]
>;
const _mapCoversUnion: MapBranchOutput = {} as z.infer<typeof claudeStreamEventSchema>;
void _mapCoversUnion;
const _unionCoversMap: z.infer<typeof claudeStreamEventSchema> = {} as MapBranchOutput;
void _unionCoversMap;

// ---------------------------------------------------------------------------
// Compile-time drift bridges
// ---------------------------------------------------------------------------

// Forward bridge: ensures schema output is assignable to ClaudeStreamEvent.
// TypeScript errors here if the schema drifts from the shared type definition.
const _typeCheck: ClaudeStreamEvent = {} as z.infer<typeof claudeStreamEventSchema>;
void _typeCheck;

// Reverse bridge: asserts ClaudeStreamEvent (minus the three exclusions below)
// is assignable to z.infer<schema>. Together with _typeCheck above, this
// catches REQUIRED-field drift in both directions — a required field added
// to the TS union but missing from the Zod schema (or vice versa) produces a
// `tsc --noEmit` error at this line.
//
// Known gap (FIND-SPRINT-020-3): optional fields (`?:`) added to a TS
// interface are NOT caught here. TS treats absence and `undefined` as
// assignment-compatible, so the bridge cannot distinguish "schema doesn't
// model this field" from "field is just absent in this instance." Optional-
// field drift surfaces only at runtime via the `__unknown__` fallback when a
// downstream consumer needs the field. Option 2 (eliminate the drift surface
// by collapsing to `z.infer`) would close this gap; deferred per TASK-656.
//
// Requires outer schemas to have no .passthrough() (Option 3 — TASK-656).
//
// SystemApiRetryEvent, SystemCompactEvent: intentionally-omitted legacy CLI
// variants kept in the TS union to compile messageProjection.ts skip branches
// during the migration window. Zod schema intentionally does not model them.
// UnknownStreamEvent: parser-only catch-all; never produced by Zod safeParse.
// Excluding all three is correct — new drift on OTHER variants is still caught.
const _reverseCheck: z.infer<typeof claudeStreamEventSchema> = {} as Exclude<ClaudeStreamEvent, SystemApiRetryEvent | SystemCompactEvent | UnknownStreamEvent>;
void _reverseCheck;
