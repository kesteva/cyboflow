---
id: TASK-101
idea_id: IDEA-003
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - shared/types/claudeStream.ts
files_readonly:
  - frontend/src/components/panels/ai/transformers/ClaudeMessageTransformer.ts
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
  - docs/cyboflow_system_design.md
  - shared/types/panels.ts
  - shared/types/models.ts
  - shared/types/cliPanels.ts
  - docs/ARCHITECTURE.md
  - docs/CODE-PATTERNS.md
acceptance_criteria:
  - criterion: File shared/types/claudeStream.ts exists and exports a `ClaudeStreamEvent` discriminated union type.
    verification: "grep -n 'export type ClaudeStreamEvent' shared/types/claudeStream.ts returns at least one line; `pnpm --filter main typecheck` succeeds with this type re-exported into a temp scratch import."
  - criterion: "Union has 8 variants distinguishable by a discriminant: system/init, system/api_retry, system/compact, assistant, user, result (with all 4 subtypes representable), stream_event, and an `unknown` catch-all."
    verification: "grep -E '(SystemInitEvent|SystemApiRetryEvent|SystemCompactEvent|AssistantEvent|UserEvent|ResultEvent|StreamEvent|UnknownStreamEvent)' shared/types/claudeStream.ts returns 8 distinct interface or type exports."
  - criterion: "All JSON-wire field names use snake_case (matching actual stream-json output), with the documented exception of `permissionMode` on the system/init variant (camelCase per SamSaffron spec)."
    verification: "grep -nE '\\b(camelCase|totalCostUsd|permissionDenials|numTurns|durationMs|isError|toolUseId|sessionId)\\b' shared/types/claudeStream.ts returns 0 matches except where the variable is a TS field declared with a snake_case key on the wire (e.g. session_id, total_cost_usd, permission_denials, num_turns, duration_ms, is_error, tool_use_id). `grep -n 'permissionMode' shared/types/claudeStream.ts` returns at least one match (system/init exception)."
  - criterion: "Result event encodes all 4 subtypes from architecture research §1: success, error_max_turns, error_max_budget_usd, error_during_execution."
    verification: "grep -nE \"'success'|'error_max_turns'|'error_max_budget_usd'|'error_during_execution'\" shared/types/claudeStream.ts returns all four literals."
  - criterion: "Tool-result `content` on the user variant accepts both `string` and `Array<{ type: string; text: string }>` shapes."
    verification: "grep -nE 'content:.*string.*\\|.*Array|content:.*\\(string \\| ' shared/types/claudeStream.ts returns at least one matching line in the user variant block."
  - criterion: "Assistant message `content` is typed as a mixed array of TextBlock | ToolUseBlock | ThinkingBlock."
    verification: "grep -nE 'TextBlock.*\\|.*ToolUseBlock|ToolUseBlock.*\\|.*ThinkingBlock' shared/types/claudeStream.ts returns at least one match; all three block interfaces exist (`grep -E 'interface (TextBlock|ToolUseBlock|ThinkingBlock)' shared/types/claudeStream.ts` returns 3 matches)."
  - criterion: "UnknownStreamEvent variant has a parser-only discriminant that cannot collide with any real wire value, plus a `raw: Record<string, unknown>` field carrying the original JSON."
    verification: "grep -nE \"kind: '__unknown__'|kind: 'unknown'\" shared/types/claudeStream.ts returns at least one match in the UnknownStreamEvent block AND `grep -n 'raw: Record<string, unknown>' shared/types/claudeStream.ts` returns at least one match."
  - criterion: "Exhaustive-check helper exists: a function or type-level construct that compiles only if `switch (event.type)` covers every wire variant."
    verification: "grep -nE 'assertNever|never|exhaustiveCheck' shared/types/claudeStream.ts returns at least one match; the helper has a documented usage comment."
  - criterion: "`pnpm --filter main typecheck` succeeds with the new file in place (file is referenced via `../shared/**/*` include in `main/tsconfig.json`)."
    verification: "cd main && pnpm typecheck exits 0."
  - criterion: "No runtime imports — file is pure TypeScript types/interfaces, no Zod or other runtime values."
    verification: "grep -nE \"^import.*from\" shared/types/claudeStream.ts returns 0 matches (or only `import type` declarations)."
depends_on: []
estimated_complexity: medium
epic: typed-stream-event-schema
test_strategy:
  needed: false
  justification: "Pure type-only module with no runtime behavior. Validation is via `tsc --noEmit` (the project's `typecheck` script) and the consumer-side fixture tests in TASK-103. Adding runtime tests here would test the TypeScript compiler, not application logic."
---
# Write Corrected ClaudeStreamEvent Discriminated Union in shared/

## Objective

Author `shared/types/claudeStream.ts` — a pure TypeScript type module that defines the
`ClaudeStreamEvent` discriminated union covering every variant Claude Code emits via `--output-format
stream-json --verbose --include-partial-messages`. This file is the parser-boundary contract. It
must encode the 7 corrections the architecture research surfaced against the original system design
doc (snake_case field names, the missing `system/compact` variant, the 4 result subtypes, the
correct `stream_event` discriminant string, the dropped fictional `ErrorEvent`, the mixed
content-block array, and the `tool_result.content` string|array union), plus a `kind:
'__unknown__'` parser-only catch-all variant so downstream code never crashes on schema drift.

## Implementation Steps

1. **Create the file** `shared/types/claudeStream.ts`. It is a new file — does not exist today.
   Author header comment: "Wire-format types for Claude Code's `stream-json` output. The
   discriminant pair is `type` (top-level) and `subtype` (nested, for `system` and `result`).
   All field names match the actual JSON wire format (snake_case), with the documented exception
   of `permissionMode` on `system/init` per the SamSaffron CLI spec gist."

2. **Define block-level shapes** (used by `assistant.message.content` and `user.message.content`):
   - `interface TextBlock { type: 'text'; text: string }`
   - `interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }`
   - `interface ThinkingBlock { type: 'thinking'; thinking: string }` (also accepts `content` or `text` per ClaudeMessageTransformer.ts line 249, but on the wire it's `thinking`)
   - `interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: string; text: string }>; is_error?: boolean }`
     - Note in a comment: research §1 confirms `content` is sometimes string, sometimes array.

3. **Define the 7 wire variants**, each with a unique `type` (or `type` + `subtype` pair) discriminant. All fields are snake_case on the wire:
   - `SystemInitEvent`: `{ type: 'system'; subtype: 'init'; session_id: string; cwd: string; model: string; tools: string[]; mcp_servers: Array<{ name: string; status: string }>; permissionMode: string; apiKeySource?: string; claude_code_version?: string }` — `permissionMode` stays camelCase (research §1 corner case).
   - `SystemApiRetryEvent`: `{ type: 'system'; subtype: 'api_retry'; attempt: number; max_retries: number; retry_delay_ms: number; error_status?: number; error?: { category: string; message?: string } }`
   - `SystemCompactEvent`: `{ type: 'system'; subtype: 'compact'; session_id?: string; summary?: string }` — research §1 notes this isn't in Anthropic's official spec but is confirmed by community and Crystal's own handler (`ClaudeMessageTransformer.ts:338` uses subtype `context_compacted`; on the wire per research §1, it is `compact` — document this exact wire string as the discriminant).
   - `AssistantEvent`: `{ type: 'assistant'; message: { id: string; model: string; role: 'assistant'; content: Array<TextBlock | ToolUseBlock | ThinkingBlock>; usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } }; parent_tool_use_id?: string; session_id?: string }`
   - `UserEvent`: `{ type: 'user'; message: { role: 'user'; content: ToolResultBlock[] }; tool_use_result?: { filenames?: string[]; durationMs?: number; numFiles?: number; truncated?: boolean }; parent_tool_use_id?: string; session_id?: string }` — note `tool_use_result.durationMs` and `numFiles` are documented as camelCase in research §1's gist reference; preserve those exact casings in a comment.
   - `ResultEvent`: `{ type: 'result'; subtype: 'success' | 'error_max_turns' | 'error_max_budget_usd' | 'error_during_execution'; is_error: boolean; duration_ms: number; num_turns: number; result?: string; total_cost_usd?: number; usage?: { input_tokens?: number; output_tokens?: number }; modelUsage?: Record<string, unknown>; permission_denials?: Array<{ tool_name: string; tool_use_id: string; tool_input: Record<string, unknown> }>; session_id?: string }`
   - `StreamEvent`: `{ type: 'stream_event'; event: { type: 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop'; index?: number; delta?: { type?: 'text_delta' | 'input_json_delta'; text?: string; partial_json?: string }; content_block?: { type: string; [k: string]: unknown }; message?: Record<string, unknown> }; parent_tool_use_id?: string; session_id?: string }`

4. **Add the catch-all variant.** `interface UnknownStreamEvent { kind: '__unknown__'; raw: Record<string, unknown> }`. Sentinel discriminant `kind` (not `type`) so it can never collide with a real wire `type` value, even one Anthropic might add in future. The Zod schema in TASK-102 produces this when no discriminated variant matches.

5. **Export the union:** `export type ClaudeStreamEvent = SystemInitEvent | SystemApiRetryEvent | SystemCompactEvent | AssistantEvent | UserEvent | ResultEvent | StreamEvent | UnknownStreamEvent;`

6. **Add an exhaustive-check helper** at the bottom of the file:
   