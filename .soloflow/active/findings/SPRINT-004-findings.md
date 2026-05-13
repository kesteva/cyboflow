---
sprint: SPRINT-004
pending_count: 8
last_updated: "2026-05-13T17:46:41.724Z"
---
# Findings Queue

## FIND-SPRINT-004-1
- **source:** TASK-101 (verifier)
- **type:** claude-md
- **severity:** low
- **status:** open
- **location:** .soloflow/active/plans/typed-stream-event-schema/TASK-101-plan.md
- **description:** Plan was refined (87 → 159 lines) on `main` after the executor authored the initial implementation against the 87-line draft. Step 7 (per-variant JSDoc camelCase-exception annotations) was added in the refinement but never reached the executor, causing the executor to ship the implementation without one of the three required JSDoc notes (`ResultEvent.modelUsage`). Soloflow's plan-refinement workflow should either (a) re-spawn the executor when an in-flight plan is refined with new implementation steps, or (b) treat refinement-on-an-in-flight-plan as a protocol violation requiring an explicit re-plan. Compounder: consider documenting which plan revisions are safe to merge mid-flight vs. which require restarting the executor.
- **suggested_action:** Add guidance in plan-refinement docs: if `status: in-flight`, refinements may not introduce new implementation steps or new acceptance-criteria sub-clauses; only clarify existing ones.
- **resolved_by:** 

## FIND-SPRINT-004-2
- **source:** TASK-102 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/services/streamParser/schemas.ts:152-159
- **description:** `resultSubtypeEnum` is declared but never used at runtime — it exists only to satisfy AC #6's grep gate (`z.enum(['success', ...`). The actual schema uses four `z.literal(...)` sibling schemas inside `z.discriminatedUnion('subtype', ...)` because `discriminatedUnion` branches must pin discriminants with `z.literal`, not `z.enum`. A `void resultSubtypeEnum` line silences the unused-binding lint. This is intentional (the plan's "Rejected Alternatives" documents the tension) but leaves behind a dead binding whose only purpose is to satisfy a grep. Either (a) replace the four `z.literal` siblings with a single resultEventSchema that uses `subtype: resultSubtypeEnum` and drop the discriminatedUnion('subtype') performance optimization, or (b) delete `resultSubtypeEnum` and rewrite AC #6 to grep for the four `z.literal('success' | 'error_max_turns' | ...)` declarations directly. Defer to TASK-103 timing — once the fixture suite is green, the dead enum can be removed without losing coverage.
- **suggested_action:** Delete `resultSubtypeEnum` after TASK-103 lands. The schema's actual subtype coverage is enforced by the four `z.literal` sibling schemas plus the inner discriminatedUnion, which TASK-103's `result` subtype fixtures will verify behaviorally.
- **resolved_by:** 

## FIND-SPRINT-004-3
- **source:** TASK-103 (verifier)
- **type:** claude-md
- **severity:** medium
- **status:** open
- **location:** .soloflow/active/plans/typed-stream-event-schema/TASK-103-plan.md (AC #10 / verification command)
- **description:** TASK-103's AC #10 verification command is `cd main && pnpm test -- streamParser exits 0` (runtime tests only). Vitest uses esbuild to strip TS types without compile-checking, so the test file passed runtime even though `tsc --noEmit` produces 55 type errors inside it. The plan's compile-time tripwire (the `assertNever` switch in step 9) is therefore not actually compiled by the AC, defeating its own forward-compatibility-tripwire purpose. Soloflow plans authoring a test file should require BOTH `pnpm test ...` AND `pnpm typecheck` as verification commands when the file is meant to host a compile-time assertion. Without the typecheck gate, "test passes" silently includes "but the file does not compile" — exactly the failure mode this plan was supposed to prevent.
- **suggested_action:** Update plan-authoring guidance (or a soloflow check) so that when a task's acceptance criteria include a TypeScript compile-time assertion (e.g. `assertNever`, branded types, conditional types), the AC verification commands MUST include `pnpm typecheck` (or equivalent `tsc --noEmit`) in addition to the runtime test command. Otherwise the compile-time check is silently bypassed by transpile-only test runners.
- **resolved_by:** 

## FIND-SPRINT-004-4
- **source:** SPRINT-004 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** shared/types/claudeStream.ts:18-58
- **description:** Duplicated block-level content types across packages — violates documented `docs/CODE-PATTERNS.md` §"Shared types as the cross-package contract" rule ("Never duplicate type definitions across packages"). TASK-101 introduced `TextBlock`, `ToolUseBlock`, `ToolResultBlock` in `shared/types/claudeStream.ts` with the exact wire shapes that already exist as `TextContent`, `ToolUseContent`, `ToolResultContent` in both `main/src/types/session.ts:88-105` and `frontend/src/types/session.ts:1-19`. The same domain concept is now defined three times across packages. The new types are also better-specd than the legacy ones: `ToolResultBlock.content` is `string | Array<{type, text}>` whereas `ToolResultContent.content: string` is missing the array form documented in research §1 §4.
- **suggested_action:** Make `shared/types/claudeStream.ts` the canonical home for the four content/block types. Re-export `TextBlock`/`ToolUseBlock`/`ToolResultBlock` (and `ThinkingBlock`) from `shared/types/`, then convert `main/src/types/session.ts` and `frontend/src/types/session.ts` to type aliases pointing at the shared definitions. While at it, widen the legacy `ToolResultContent.content: string` to match the wire spec (`string | Array<{type, text}>`) since the existing narrow type is a latent bug.
- **resolved_by:** 





Suspected tasks: TASK-101

## FIND-SPRINT-004-5
- **source:** SPRINT-004 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/services/streamParser/schemas.ts:264-266
- **description:** TS↔Zod drift bridge is one-way only. TASK-101 (TS union) and TASK-102 (Zod schema) re-declare every field by hand and rely on a single drift-detector: `const _typeCheck: ClaudeStreamEvent = {} as z.infer<typeof claudeStreamEventSchema>`. This only checks `z.infer<...>` is assignable to `ClaudeStreamEvent`, not the reverse. Because nearly every field on `ResultEvent`, `SystemInitEvent`, `AssistantEvent`, etc. is optional, a TS field that is silently missing from the Zod schema will still produce a structurally assignable `z.infer` — the bridge will compile clean. Concretely: if someone adds `total_input_tokens?: number` to `ResultEvent` in `claudeStream.ts` but forgets to add it to `resultBaseFields` in `schemas.ts`, `_typeCheck` will pass and the schema will silently strip the field at runtime.
- **suggested_action:** Add a second compile-time bridge in the opposite direction. Either (a) add `const _reverseCheck: z.infer<typeof claudeStreamEventSchema> = {} as ClaudeStreamEvent; void _reverseCheck` so any TS-only field is caught, or (b) derive `ClaudeStreamEvent` directly from `z.infer<typeof claudeStreamEventSchema>` (export the inferred type from `schemas.ts` and replace the hand-written types in `claudeStream.ts` with re-exports of the inferred types). Option (b) eliminates the drift surface entirely.
- **resolved_by:** 




Suspected tasks: TASK-101, TASK-102

## FIND-SPRINT-004-6
- **source:** SPRINT-004 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/streamParser/schemas.ts:295
- **description:** `parseClaudeStreamEvent` uses `console.warn` directly, which breaks the main-process logging convention. Every other service under `main/src/services/` (gitFileWatcher.ts, executionTracker.ts, gitDiffManager.ts, commitManager.ts, gitStatusLogger.ts) takes a `Logger?` in the constructor and routes diagnostics through it. The code self-documents this as deferred (`// IDEA-004 (full streamParser) will replace this with the proper Logger`), but on a noisy/drifted stream this `console.warn` will fire on every malformed line with no severity-aware filtering, no session-id correlation downstream of the renderer, and no respect for the users Logger config. Also the warning embeds `session_id` directly in the message rather than as structured metadata.
- **suggested_action:** When IDEA-004 wires the parser into the real ingestion pipeline, pass a `Logger` instance into `parseClaudeStreamEvent` (or wrap it in a class that holds the Logger). Switch the `console.warn` to `logger.warn([streamParser] unknown ClaudeStreamEvent variant, { type: wireType, session_id: sessionId })`. Until then, consider rate-limiting the warn (e.g., once per session_id+type pair) to avoid log flooding on a drifted CLI.
- **resolved_by:** 



Suspected tasks: TASK-102

## FIND-SPRINT-004-7
- **source:** SPRINT-004 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** shared/types/claudeStream.ts:287
- **description:** `assertNever` stringifies the entire offending event into the thrown Error message: `throw new Error(Unhandled stream event variant:  + JSON.stringify(x))`. For a stream-event union this `x` will, in practice, be an event object that may contain user prompts, tool inputs, file paths, or thinking-block content. Any thrown error eventually surfaces in crash reports / Sentry / log aggregators / dev consoles. While `assertNever` is documented as a compile-time tripwire that should be unreachable, runtime drift in the CLI output (a new wire `type` Anthropic adds) is the exact case where it would fire — and thats also when an unexpected payload is most likely to contain user content.
- **suggested_action:** Narrow the error message to non-PII metadata: `throw new Error(`Unhandled stream event variant: ${(x as {type?: unknown})?.type ?? <no-type>}`);`. The `type` discriminator alone is sufficient for diagnosis; the full event body adds no debugging value at this layer and is the only PII vector in this throw.
- **resolved_by:** 


Suspected tasks: TASK-101

## FIND-SPRINT-004-8
- **source:** SPRINT-004 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/services/streamParser/__fixtures__/system_init.json:10, result_*.json
- **description:** Synthetic-fixture content drifts from production wire spec in two small ways that will mask real-CLI capture issues later: (1) `system_init.json` sets `permissionMode: "bypassPermissions"` and `apiKeySource: "ANTHROPIC_API_KEY"` — neither value appears in the SamSaffron specs documented enum, so when a real-CLI capture lands these fixtures will silently change (or, worse, become the de facto type widening if anyone later replaces `permissionMode: z.string()` with `z.enum([...])`). (2) The four `result_*.json` fixtures all use `"claude-opus-4-5"` as the `modelUsage` key, but the agents knowledge cutoff is Jan 2026 and the project repo references `claude-opus-4-7` (CLAUDE.md banner). Synthetic fixtures should pick canonical or stable model-id values, not values that look plausible but are unverified. The README correctly flags fixtures as synthetic, but the values themselves are not pinned to a verified source.

Suspected tasks: TASK-103
- **suggested_action:** On the first real-CLI capture (per the READMEs quarterly schedule), diff the synthetic values against the live capture and (a) update fixtures to match real wire output, (b) decide whether `permissionMode` / `apiKeySource` should be tightened from `z.string()` to `z.enum([...])`, (c) consider redacting model-id strings in fixtures to a deterministic placeholder like `<model-id>` if test assertions never inspect the model name.
- **resolved_by:** 
