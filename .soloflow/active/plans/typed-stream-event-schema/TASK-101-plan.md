---
id: TASK-101
idea_id: IDEA-003
status: ready
created: 2026-05-11T00:00:00Z
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
  - criterion: "File shared/types/claudeStream.ts exists and exports a `ClaudeStreamEvent` discriminated union type."
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
   ```ts
   /**
    * Compile-time exhaustiveness guard. Use at the default branch of a
    * `switch (event.type)` (or nested `switch (event.subtype)`) to force a
    * type error when a new wire variant is added to the union without an
    * accompanying handler. The runtime throw is a defense-in-depth fallback
    * for the impossible-but-paranoid case where the parser produces a value
    * outside the declared union (e.g. someone bypassing the Zod schema).
    */
   export function assertNever(x: never): never {
     throw new Error('exhaustive check failed: ' + JSON.stringify(x));
   }
   ```
   Document the canonical consumer pattern in a comment block immediately above the helper:
   ```ts
   // Usage:
   //   switch (event.type) {
   //     case 'system':     return handleSystem(event);     // narrows on subtype inside
   //     case 'assistant':  return handleAssistant(event);
   //     case 'user':       return handleUser(event);
   //     case 'result':     return handleResult(event);
   //     case 'stream_event': return handleStream(event);
   //     default:
   //       if ('kind' in event && event.kind === '__unknown__') return logUnknown(event);
   //       return assertNever(event);
   //   }
   ```

7. **JSDoc each variant interface** with a one-line comment that names (a) the wire-format source (SamSaffron gist / research §1 / `ClaudeMessageTransformer.ts` line ref) and (b) any field-casing exception. Specifically:
   - `SystemInitEvent` — note `permissionMode` is the *only* camelCase field on the wire (SamSaffron spec); every other field is snake_case.
   - `SystemCompactEvent` — note the wire `subtype` is `'compact'` per research §1, NOT `'context_compacted'`. Crystal's renderer at `ClaudeMessageTransformer.ts:338` maps it to the string `'context_compacted'` internally; that mapping is a transformer detail, not the wire value. This task encodes the wire value.
   - `UserEvent` — note `tool_use_result.durationMs` and `tool_use_result.numFiles` are intentionally camelCase on the wire per the SamSaffron gist (this is a second documented exception alongside `permissionMode`).
   - `ResultEvent` — note `modelUsage` is also camelCase on the wire (third exception), while sibling fields like `total_cost_usd`, `num_turns`, `duration_ms`, `is_error`, and `permission_denials` are snake_case.
   - `UnknownStreamEvent` — note this variant is *parser-produced*, not wire-emitted, hence the `kind` discriminant instead of `type`.

8. **Verify file placement.** Frontmatter `files_owned` declares `shared/types/claudeStream.ts`. Confirm the file is at exactly that path (no `index.ts` re-export, no `claudeStreamEvent.ts` typo). The path must match because `main/tsconfig.json` includes `../shared/**/*` and the consumer import will be from `@shared/types/claudeStream` (per the epic's Success Signal).

9. **Run the grep gate** (mirrors the acceptance-criteria verifications):
   ```bash
   grep -n 'export type ClaudeStreamEvent' shared/types/claudeStream.ts
   grep -E 'interface (TextBlock|ToolUseBlock|ThinkingBlock)' shared/types/claudeStream.ts
   grep -nE "'success'|'error_max_turns'|'error_max_budget_usd'|'error_during_execution'" shared/types/claudeStream.ts
   grep -n 'permissionMode' shared/types/claudeStream.ts
   grep -nE "kind: '__unknown__'" shared/types/claudeStream.ts
   grep -nE 'assertNever|exhaustiveCheck' shared/types/claudeStream.ts
   grep -nE '^import.*from' shared/types/claudeStream.ts   # expect zero non-`import type` lines
   ```
   All seven should return at least one match (the last should be empty or only `import type` lines).

10. **Run `cd main && pnpm typecheck`.** Must exit 0. This is the final acceptance gate — the file is types-only, so the only way this fails is a TypeScript syntax error or a missing tsconfig include.

## Acceptance Criteria

All ten frontmatter ACs must hold. In prose: the file exists at `shared/types/claudeStream.ts` and exports a discriminated union `ClaudeStreamEvent` with exactly 8 variants — five top-level `type` values (`assistant`, `user`, `result`, `stream_event`, plus `system` which itself fans out to three subtypes) and one parser-only `__unknown__` catch-all keyed by `kind`. The four `result` subtypes (`success`, `error_max_turns`, `error_max_budget_usd`, `error_during_execution`) are encoded as a literal-union discriminant. Field casing matches the actual wire format (snake_case) with three documented camelCase exceptions per the SamSaffron CLI spec: `system/init.permissionMode`, `user.tool_use_result.{durationMs,numFiles}`, and `result.modelUsage`. The assistant `message.content` is a mixed array of `TextBlock | ToolUseBlock | ThinkingBlock`; the user `tool_result.content` accepts both `string` and `Array<{type, text}>`. An `assertNever` helper sits at the bottom with a JSDoc usage example. The file contains zero runtime imports (the Zod schema lives in TASK-102). `cd main && pnpm typecheck` exits 0.

## Test Strategy

Per the frontmatter `test_strategy.needed: false`: this task ships no runtime tests. The module is pure TypeScript types; correctness is enforced by `tsc --noEmit` via the project's `pnpm typecheck` script and by the grep gates in step 9. Runtime coverage lands in two downstream tasks: **TASK-102** writes the Zod parser (`main/src/services/streamParser/schemas.ts`) and its own unit tests verifying the schema mirrors this union, and **TASK-103** captures real `stream-json` fixtures from a live Claude Code session and asserts each fixture parses cleanly into the typed union with an exhaustive `switch` over `event.type` reachable. Adding tests here would amount to asserting that the TypeScript compiler works — no value over the typecheck gate.

## Hardest Decision

**Modeling the `type + subtype` discriminant: TypeScript template-literal union vs nested discriminated unions.** A template-literal approach (e.g. `kind: 'system/init' | 'system/compact' | 'result/success' | ...`) gives a single flat discriminant — every variant distinguishable in one `switch`, no inner narrowing required. The nested approach (top-level `type` discriminant with `system` and `result` having their own `subtype` discriminants) matches the wire format 1:1 — no synthetic key flattening, the Zod schema in TASK-102 maps directly to `z.discriminatedUnion('type', [...])` with nested `z.discriminatedUnion('subtype', [...])` for `system` and `result`. Choosing the nested approach: it preserves the wire format as the source of truth (the JSON literally has `type` and `subtype` as separate keys), it lets the Zod schema be a structural mirror with no field invention, and the consumer ergonomics (`switch (event.type)` then nested `switch (event.subtype)`) are familiar TypeScript patterns. The flat template-literal would force the parser to synthesize a non-wire field on every event — a small but persistent abstraction leak.

## Rejected Alternatives

- **Auto-generate types from the Anthropic OpenAPI spec.** Rejected: the `stream-json` CLI wire format is not published in any official OpenAPI spec. The only canonical sources are the SamSaffron community gist and Crystal's own empirical handling (research §1). An autogen pipeline would have nothing to consume; hand-authoring against the gist + capturing fixtures (TASK-103) is the only path.
- **Co-locate the union with the Zod schema in `main/src/services/streamParser/schemas.ts`** (single file, `z.infer<>` for the TS types). Rejected: the renderer and any future shared consumer (e.g. tRPC subscription payload type) must be able to import the union without pulling in Zod. Putting the types in `shared/` and the Zod runtime in `main/` is the explicit separation IDEA-003 calls for.
- **Skip the `UnknownStreamEvent` variant; let unrecognized JSON throw at the Zod boundary.** Rejected: the epic's success signal mandates "the parser never crashes on schema drift." Anthropic has changed `stream-json` shape between Claude Code releases before (research §1 references issue #1920); a hard throw on first unknown variant would brick the orchestrator until a patch ships. The `__unknown__` catch-all with a `raw` payload preserves the bytes for forensic logging and lets the consumer downgrade gracefully.

## Lowest Confidence Area

**The `system/compact` subtype string.** Research §1 (`ROADMAP-001-research-architecture.md:30`) records the wire subtype as `compact`, but Crystal's renderer at `ClaudeMessageTransformer.ts:338` matches against `context_compacted`. Two plausible readings: (a) Crystal's transformer string is an internal post-parse alias and the wire value really is `compact`, or (b) the research summary normalized the name and the wire really emits `context_compacted`. This plan encodes `'compact'` per the research note. **Verification path:** when TASK-102 wires up the Zod parser, add a `console.warn` on the `__unknown__` branch that logs the original `type` and `subtype` from `raw`; run a long-context Claude session locally until compaction fires, observe the logged discriminant, and patch the literal in this file if it turns out to be `context_compacted`. If verification is blocked (compaction is hard to trigger on demand), fall back to capturing both literals as a `z.union(['compact', 'context_compacted'])` in TASK-102's schema, normalize to one, and document the dual-accept in a comment here.
