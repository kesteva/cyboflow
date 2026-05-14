---
id: TASK-589
idea: IDEA-014
status: ready
created: "2026-05-14T00:00:00Z"
files_owned:
  - shared/types/claudeStream.ts
  - main/src/services/streamParser/schemas.ts
files_readonly:
  - main/src/services/streamParser/types.ts
  - main/src/services/streamParser/typedEventNarrowing.ts
  - main/src/services/streamParser/eventRouter.ts
  - main/src/services/streamParser/messageProjection.ts
  - main/src/services/streamParser/rawEventsSink.ts
  - main/src/services/streamParser/__fixtures__/system_init.json
  - main/src/services/streamParser/__fixtures__/stream_event.json
  - main/src/services/streamParser/__fixtures__/result_success.json
  - main/src/services/streamParser/__tests__/schemas.test.ts
  - main/src/services/streamParser/__tests__/typedEventNarrowing.test.ts
  - main/src/services/streamParser/__tests__/messageProjection.test.ts
  - main/src/services/streamParser/__tests__/rawEventsSink.test.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
acceptance_criteria:
  - criterion: "Every variant in the ClaudeStreamEvent discriminated union in shared/types/claudeStream.ts that maps to an SDK message (SDKSystemMessage init, SDKAssistantMessage, SDKUserMessage, SDKResultMessage, SDKPartialAssistantMessage, SDKCompactBoundaryMessage) declares an optional `uuid?: string` field, and the corresponding Zod schema in schemas.ts declares `uuid: z.string().optional()`."
    verification: "grep -n 'uuid' shared/types/claudeStream.ts main/src/services/streamParser/schemas.ts — every variant marked with the SDK-mapped comment block must have one `uuid` line each in both files."
  - criterion: "`parent_tool_use_id` on AssistantEvent, UserEvent, and StreamEvent accepts both `string` and `null` (matching SDK's `string | null`), not just `string | undefined`."
    verification: "grep -n 'parent_tool_use_id' shared/types/claudeStream.ts shows `string | null` (optional via `?`) on all three variants; grep -n 'parent_tool_use_id' main/src/services/streamParser/schemas.ts shows `z.union([z.string(), z.null()]).optional()` on those three schemas."
  - criterion: "A new `SystemCompactBoundaryEvent` variant exists with `type: 'system'`, `subtype: 'compact_boundary'`, and `compact_metadata: { trigger: 'manual' | 'auto'; pre_tokens: number }`, and is added to the ClaudeStreamEvent union AND to systemUnionSchema's discriminatedUnion list. The existing `SystemCompactEvent` (subtype: 'compact') is retained verbatim, with an updated header comment that flags it as legacy CLI-only and marks it for deletion in T8."
    verification: "grep -n 'compact_boundary' shared/types/claudeStream.ts main/src/services/streamParser/schemas.ts shows the new variant in both files. grep -n 'SystemCompactBoundaryEvent' shared/types/claudeStream.ts shows it in the ClaudeStreamEvent union. grep -n 'compact_metadata' main/src/services/streamParser/schemas.ts shows the nested schema with literal trigger union and number pre_tokens."
  - criterion: "ResultEvent.subtype literal union and the four result*Schema branches include `'error_max_structured_output_retries'` as a fifth subtype, with a matching resultErrorMaxStructuredOutputRetriesSchema added to resultUnionSchema."
    verification: "grep -n 'error_max_structured_output_retries' shared/types/claudeStream.ts main/src/services/streamParser/schemas.ts shows the literal in both files. grep -n 'resultErrorMaxStructuredOutputRetriesSchema' main/src/services/streamParser/schemas.ts shows the schema added to the discriminatedUnion."
  - criterion: "SystemInitEvent and systemInitSchema declare these optional SDK passthrough fields: `agents`, `betas`, `slash_commands`, `output_style`, `skills`, `plugins`. Types are `Record<string, unknown> | undefined` in the .ts file and `z.unknown().optional()` (or equivalent) in the schema. apiKeySource and claude_code_version remain unchanged."
    verification: "grep -nE 'agents|betas|slash_commands|output_style|skills|plugins' shared/types/claudeStream.ts shows each field on SystemInitEvent. Same grep against main/src/services/streamParser/schemas.ts shows each on systemInitSchema."
  - criterion: "AssistantEvent.message declares optional `stop_reason?: string | null` and `stop_sequence?: string | null` (matching BetaMessage). AssistantEvent itself declares optional `error?: { message?: string }` (matching SDKAssistantMessageError). The same shape is reflected in assistantEventSchema."
    verification: "grep -nE 'stop_reason|stop_sequence' shared/types/claudeStream.ts main/src/services/streamParser/schemas.ts shows both fields in both files. grep -nE 'error\\?:' shared/types/claudeStream.ts shows the new optional error field on AssistantEvent."
  - criterion: "SystemApiRetryEvent is retained verbatim in both the .ts union and the systemUnionSchema, but the header comment is updated to note that the SDK does NOT emit this variant (it surfaces retries via SDKStatusMessage and SDKRateLimitEvent instead) — preserved so messageProjection.ts's existing api_retry skip branch continues to typecheck. The comment names T8 as the cleanup owner."
    verification: "grep -nB 2 'SystemApiRetryEvent' shared/types/claudeStream.ts shows the updated comment block referencing 'SDKStatusMessage', 'SDKRateLimitEvent', and 'T8'."
  - criterion: "The four substrate-independent consumers (eventRouter.ts, messageProjection.ts, rawEventsSink.ts, typedEventNarrowing.ts) compile against the retargeted union without any modification to their source files. `pnpm typecheck` exits 0 from the repo root."
    verification: "`pnpm typecheck` runs and exits with code 0. git diff --name-only main/src/services/streamParser/eventRouter.ts main/src/services/streamParser/messageProjection.ts main/src/services/streamParser/rawEventsSink.ts main/src/services/streamParser/typedEventNarrowing.ts shows no changes to these four files."
  - criterion: The compile-time TS↔Zod drift bridge (`_typeCheck` in schemas.ts) still compiles — schema output remains assignable to ClaudeStreamEvent after the retarget.
    verification: "`pnpm typecheck` exits 0. grep -n '_typeCheck' main/src/services/streamParser/schemas.ts confirms the drift bridge line is unchanged in shape (still `const _typeCheck: ClaudeStreamEvent = {} as z.infer<typeof claudeStreamEventSchema>;`)."
  - criterion: No fixture file under main/src/services/streamParser/__fixtures__/ is modified or deleted by this task.
    verification: "`git diff --name-only main/src/services/streamParser/__fixtures__/` returns empty."
  - criterion: claudeCodeManager.ts is not modified by this task.
    verification: "`git diff --name-only main/src/services/panels/claude/claudeCodeManager.ts` returns empty."
depends_on: []
estimated_complexity: medium
epic: claude-agent-sdk-migration
test_strategy:
  needed: false
  justification: "Per the EPIC explicitly: 'typecheck is the primary gate. No new test code; do NOT modify the existing test files in this task.' The existing test files in main/src/services/streamParser/__tests__/ (schemas.test.ts, typedEventNarrowing.test.ts, messageProjection.test.ts, rawEventsSink.test.ts) MUST still compile against the retargeted union — they may fail at runtime since fixtures predate SDK shapes, which is the intended state for T8 to migrate. The four sibling test files are listed in files_readonly to make the no-modify intent unambiguous to the executor."
---
# Retarget `shared/types/claudeStream.ts` and `schemas.ts` to the Claude Agent SDK wire format

## Objective

The TypeScript discriminated union in `shared/types/claudeStream.ts` and the parallel Zod runtime layer in `main/src/services/streamParser/schemas.ts` were built around `claude --output-format stream-json --include-partial-messages` output (the SamSaffron CLI spec). The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk@0.2.x`) emits structurally-equivalent messages with field-level deltas: it adds `uuid` to every message, switches `parent_tool_use_id` to `string | null`, replaces `system/compact` with `system/compact_boundary` (and changes the payload shape), adds `error_max_structured_output_retries` as a fifth result subtype, adds `stop_reason`/`stop_sequence` to assistant messages, and adds an optional `error` field to assistant messages. This task retargets the union and the Zod schemas to match the SDK's emitted shapes without redesigning the taxonomy, without touching fixtures, without touching `claudeCodeManager.ts`, and without modifying the four substrate-independent consumers (`eventRouter`, `messageProjection`, `rawEventsSink`, `typedEventNarrowing`). The acceptance gate is `pnpm typecheck` exiting 0 with all four consumers untouched.

## Implementation Steps

1. **Prerequisite reading.** If `@anthropic-ai/claude-agent-sdk` is installed in `node_modules/` (T1/TASK-587 has landed):
   ```bash
   find node_modules/@anthropic-ai/claude-agent-sdk -name '*.d.ts' | head -20
   cat node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts 2>/dev/null || cat node_modules/@anthropic-ai/claude-agent-sdk/dist/sdk.d.ts 2>/dev/null
   ```
   Read the exported types `SDKMessage`, `SDKSystemMessage`, `SDKAssistantMessage`, `SDKUserMessage`, `SDKResultMessage`, `SDKPartialAssistantMessage`, `SDKCompactBoundaryMessage`, `SDKAssistantMessageError`, and confirm the field-level deltas listed below match what is on disk. If the package is NOT yet installed, treat the SDK shapes listed in this plan as authoritative (sourced from https://docs.claude.com/en/docs/agent-sdk/typescript) and proceed.

2. **Open `shared/types/claudeStream.ts` end-to-end** and apply the variant-by-variant retargets below. Preserve the existing file header (lines 1–10) and the existing "Sources" comment block — append a second line citing `@anthropic-ai/claude-agent-sdk@0.2.x` `sdk.d.ts` as the new authoritative source.

3. **Retarget `SystemInitEvent` (currently lines 62–74).** Add these optional fields after `claude_code_version?: string;`:
   ```ts
   uuid?: string;
   agents?: Record<string, unknown>;
   betas?: string[];
   slash_commands?: string[];
   output_style?: string;
   skills?: Record<string, unknown>;
   plugins?: Array<{ name: string; path: string }>;
   ```
   Do NOT remove `apiKeySource` or `claude_code_version`.

4. **Retarget `SystemApiRetryEvent` (currently lines 78–91).** Do NOT touch the field list. Replace the existing doc comment with:
   ```ts
   /**
    * Emitted by the legacy `--include-partial-messages` CLI when an API call retries.
    *
    * NOTE: The Claude Agent SDK does NOT emit this exact shape. The SDK surfaces retry-ish
    * signals via `SDKStatusMessage` and rate-limit signals via `SDKRateLimitEvent`.
    * This variant is retained intact to keep `messageProjection.ts`'s api_retry skip branch
    * compiling during the migration window. T8 (fixture & test migration) owns its eventual
    * removal once messageProjection.ts and rawEventsSink.ts no longer reference it.
    */
   ```

5. **Retarget `SystemCompactEvent` (currently lines 93–106).** Do NOT touch the field list. Update the doc comment to flag it as legacy:
   ```ts
   /**
    * LEGACY: `--include-partial-messages` CLI shape for context-window compaction.
    *
    * The Claude Agent SDK emits the SAME semantic event with a DIFFERENT shape — see
    * `SystemCompactBoundaryEvent` below. This variant is retained verbatim to keep
    * messageProjection.ts's existing compact handler (which reads `summary`) compiling
    * during the migration. T8 owns removal once messageProjection.ts switches to reading
    * compact_metadata from SystemCompactBoundaryEvent.
    */
   ```

6. **Add new `SystemCompactBoundaryEvent` variant** immediately after `SystemCompactEvent`:
   ```ts
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
   ```

7. **Retarget `AssistantEvent` (currently lines 110–128).** Modify to:
   - Change `parent_tool_use_id?: string;` to `parent_tool_use_id?: string | null;`.
   - Add `uuid?: string;`.
   - Inside `message`, after `usage`, add `stop_reason?: string | null;` and `stop_sequence?: string | null;`.
   - After `parent_tool_use_id`, add `error?: { message?: string; [k: string]: unknown };`.

8. **Retarget `UserEvent` (currently lines 135–152).** Modify to:
   - Change `parent_tool_use_id?: string;` to `parent_tool_use_id?: string | null;`.
   - Add `uuid?: string;`.

9. **Retarget `ResultEvent` (currently lines 169–190).** Modify to:
   - Extend the `subtype` literal union to include `'error_max_structured_output_retries'`.
   - Add `uuid?: string;` after `session_id?: string;`.

10. **Retarget `StreamEvent` (currently lines 198–220).** Modify to:
    - Change `parent_tool_use_id?: string;` to `parent_tool_use_id?: string | null;`.
    - Add `uuid?: string;`.

11. **Extend the `ClaudeStreamEvent` discriminated union** (currently lines 249–258) to include the new `SystemCompactBoundaryEvent`.

12. **Open `main/src/services/streamParser/schemas.ts` end-to-end.** Apply the same retargets in Zod-schema form.

13. **Retarget `systemInitSchema` (currently lines 61–73).** Add the new optional fields BEFORE the closing `.passthrough()`:
    ```ts
    uuid: z.string().optional(),
    agents: z.record(z.unknown()).optional(),
    betas: z.array(z.string()).optional(),
    slash_commands: z.array(z.string()).optional(),
    output_style: z.string().optional(),
    skills: z.record(z.unknown()).optional(),
    plugins: z.array(z.object({ name: z.string(), path: z.string() }).passthrough()).optional(),
    ```

14. **Leave `systemApiRetrySchema` and `systemCompactSchema` field lists unchanged.** Update inline doc comments.

15. **Add new `systemCompactBoundarySchema`** immediately after `systemCompactSchema`:
    ```ts
    const systemCompactBoundarySchema = z.object({
      type: z.literal('system'),
      subtype: z.literal('compact_boundary'),
      uuid: z.string().optional(),
      session_id: z.string().optional(),
      compact_metadata: z.object({
        trigger: z.union([z.literal('manual'), z.literal('auto')]),
        pre_tokens: z.number(),
      }).passthrough(),
    }).passthrough();
    ```

16. **Extend `systemUnionSchema`** to include `systemCompactBoundarySchema` as a fourth branch.

17. **Retarget `assistantEventSchema`.** Inside the inner `message` z.object, after `usage`, add `stop_reason: z.union([z.string(), z.null()]).optional()` and `stop_sequence: z.union([z.string(), z.null()]).optional()`. At the outer level, change `parent_tool_use_id: z.string().optional()` to `parent_tool_use_id: z.union([z.string(), z.null()]).optional()`. Add `uuid: z.string().optional()` and `error: z.object({ message: z.string().optional() }).passthrough().optional()`.

18. **Retarget `userEventSchema`.** Change `parent_tool_use_id` to `z.union([z.string(), z.null()]).optional()`. Add `uuid: z.string().optional()`.

19. **Retarget `resultBaseFields` and result variant schemas.** Add `uuid: z.string().optional()` to `resultBaseFields`. Add:
    ```ts
    const resultErrorMaxStructuredOutputRetriesSchema = z.object({
      ...resultBaseFields,
      subtype: z.literal('error_max_structured_output_retries'),
    }).passthrough();
    ```
    Extend `resultUnionSchema` to include it as the fifth branch.

20. **Retarget `streamEventSchema`.** Change `parent_tool_use_id` to `z.union([z.string(), z.null()]).optional()`. Add `uuid: z.string().optional()`.

21. **Do NOT touch the top-level `claudeStreamEventSchema`.** Do NOT touch `_typeCheck`.

22. **Run typecheck as the primary gate.**
    ```bash
    pnpm typecheck
    ```
    Expected: exit 0.

23. **Manually verify the no-touch invariants:**
    ```bash
    git diff --name-only main/src/services/streamParser/__fixtures__/
    # Expected: empty
    git diff --name-only main/src/services/streamParser/eventRouter.ts \
                          main/src/services/streamParser/messageProjection.ts \
                          main/src/services/streamParser/rawEventsSink.ts \
                          main/src/services/streamParser/typedEventNarrowing.ts
    # Expected: empty
    git diff --name-only main/src/services/panels/cli/
    # Expected: empty
    ```

24. **Surface T4 hints** in the commit message body:
    - `messageProjection.ts:106` `projectSystemEvent` switch handles `init` and `compact` but NOT `compact_boundary` — T4 must add a `compact_boundary` case OR T8 must migrate it.
    - `messageProjection.ts:69-70` and `rawEventsSink.ts:39-43` still reference `SystemApiRetryEvent`; the SDK never produces this variant, so those branches are dead code post-migration — T8 should delete them.

## Acceptance Criteria

1. **Field-level retarget completeness.** Every variant gets `uuid?`; `parent_tool_use_id` accepts `null`; `SystemInitEvent` gets the 7 new optional SDK fields; `AssistantEvent` gets `stop_reason`/`stop_sequence`/`error`; `ResultEvent.subtype` gains a fifth literal; `SystemCompactBoundaryEvent` is added as a new variant.
2. **Consumer invariance.** `pnpm typecheck` exits 0 and `git diff --name-only` reports no changes to the four substrate-independent consumers.
3. **No fixture, no manager touch.** `git diff --name-only` against `__fixtures__/` and `claudeCodeManager.ts` returns empty.

## Test Strategy

`needed: false`. Per EPIC directive: "typecheck is the primary gate. No new test code; do NOT modify the existing test files in this task." The four sibling test files are listed in `files_readonly` to make the no-modify boundary explicit. They will continue to compile against the retargeted union (the union is additive — every existing field is preserved, every new field is optional). They may fail at runtime in the post-T4 world because the fixtures predate SDK shapes; that runtime delta is T8's scope, not this task's.

## Hardest Decision

**Whether to delete `SystemApiRetryEvent` and `SystemCompactEvent` (the two legacy CLI-only variants), or retain them verbatim through the migration window.** Deletion is "purer" — the SDK doesn't emit them, so post-migration they're dead code. But deleting them would break `messageProjection.ts`'s existing `projectSystemEvent` switch (which reads `compact.summary`) and its `api_retry` skip branch — both of which are listed in the EPIC as "must survive intact." Retention is the correct call: the union grows by 7 fields and 1 new variant, but loses nothing, so every consumer keeps compiling. T8 owns the cleanup pass once messageProjection.ts is rewritten to consume the SDK shape directly.

## Rejected Alternatives

- **Replace `SystemCompactEvent` in-place with the SDK's `compact_boundary` shape.** Rejected because `messageProjection.ts:134-147` reads `compact.summary` directly. An in-place replacement would force a same-PR edit to `messageProjection.ts`, violating the EPIC's "four consumers must survive intact" constraint.
- **Tighten `session_id` from optional to required everywhere (SDK requires it on every variant).** Rejected because the existing fixtures plus the test in `__tests__/schemas.test.ts` for "future_unannounced_field" passthrough expect `safeParse` to succeed on objects WITHOUT session_id. Tightening would silently break those tests' runtime expectations.
- **Use `z.discriminatedUnion('type', ...)` at the top level now that variants share the `type` discriminant cleanly.** Rejected because Zod 3.x rejects nested z.discriminatedUnion as branches.
- **Replace `Record<string, unknown>` for `agents`/`skills` with stricter inferred shapes from the SDK.** Rejected because the SDK's exported types for these are themselves complex unions that would require pulling SDK types into `shared/types/` — and the EPIC keeps `shared/` SDK-independent until T6/T7 collapses the parser.

## Lowest Confidence Area

**Whether the SDK's `BetaMessage.usage` shape is byte-identical to the cyboflow CLI's `usage` shape.** Both definitively include `input_tokens` and `output_tokens`. The CLI also exposes `cache_creation_input_tokens` and `cache_read_input_tokens`. The SDK's `BetaMessage.usage` MAY have renamed or added fields (e.g. `cache_creation`, `cache_read`, `service_tier`, `server_tool_use`) that this plan does not enumerate. Mitigation: every schema uses `.passthrough()`, so unknown usage subfields parse through and survive — they just won't be typed strictly. If T4 or T8 later discover a load-bearing usage subfield the union should expose, adding it is a one-line .ts + one-line .zod change. A second uncertainty: the exact discriminant shape of `SDKRateLimitEvent` (which the EPIC ignores for now but T4/T8 may need to add).
