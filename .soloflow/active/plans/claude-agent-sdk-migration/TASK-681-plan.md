---
id: TASK-681
idea: IDEA-014
status: in-flight
created: "2026-05-20T00:00:00Z"
files_owned:
  - main/src/services/streamParser/schemas.ts
  - main/src/services/streamParser/messageProjection.ts
  - main/src/services/streamParser/__tests__/schemas.test.ts
  - main/src/services/streamParser/__tests__/messageProjection.test.ts
  - main/src/services/streamParser/__tests__/sdkMockFactories.ts
files_readonly:
  - shared/types/claudeStream.ts
  - main/src/services/streamParser/typedEventNarrowing.ts
  - main/src/services/streamParser/eventRouter.ts
  - main/src/services/streamParser/rawEventsSink.ts
acceptance_criteria:
  - criterion: schemas.ts no longer declares Zod schemas for the legacy CLI shapes system/api_retry and system/compact
    verification: "grep -nE \"z\\.literal\\('(api_retry|compact)'\\)\" main/src/services/streamParser/schemas.ts returns 0 matches"
  - criterion: "schemas.ts top-level systemUnionSchema discriminated union contains exactly two branches: init and compact_boundary"
    verification: "grep -n 'systemUnionSchema = z.discriminatedUnion' -A 5 main/src/services/streamParser/schemas.ts shows only systemInitSchema and systemCompactBoundarySchema as branches (no systemApiRetrySchema, no systemCompactSchema)"
  - criterion: messageProjection.ts no longer has the api_retry skip branch and reads compact_metadata (not summary) from system events
    verification: "grep -nE \"(api_retry|SystemCompactEvent|compact\\.summary|=== 'compact'[^_])\" main/src/services/streamParser/messageProjection.ts returns 0 matches"
  - criterion: "messageProjection.ts projectSystemEvent dispatches on subtype 'compact_boundary' (the SDK shape), producing a UnifiedMessage with systemSubtype='context_compacted' that carries trigger and pre_tokens in metadata"
    verification: "grep -n \"subtype === 'compact_boundary'\" main/src/services/streamParser/messageProjection.ts returns at least one match AND grep -n \"systemSubtype: 'context_compacted'\" main/src/services/streamParser/messageProjection.ts returns at least one match"
  - criterion: __tests__/sdkMockFactories.ts no longer exports systemApiRetry or systemCompact (legacy CLI factories)
    verification: "grep -nE \"export function (systemApiRetry|systemCompact)\\(\" main/src/services/streamParser/__tests__/sdkMockFactories.ts returns 0 matches"
  - criterion: __tests__/schemas.test.ts no longer imports or references the retired legacy factories or their describe blocks
    verification: "grep -nE \"systemApiRetry|systemCompact[^B]\" main/src/services/streamParser/__tests__/schemas.test.ts returns 0 matches"
  - criterion: __tests__/messageProjection.test.ts is updated to assert compact_boundary projection (not the legacy compact shape) and no longer references SystemApiRetryEvent
    verification: "grep -nE \"SystemApiRetryEvent|systemApiRetryEvent|subtype: 'compact'[^_]|subtype: 'api_retry'\" main/src/services/streamParser/__tests__/messageProjection.test.ts returns 0 matches AND grep -n \"subtype: 'compact_boundary'\" main/src/services/streamParser/__tests__/messageProjection.test.ts returns at least one match"
  - criterion: pnpm --filter main typecheck passes
    verification: "cd <repo> && pnpm --filter main typecheck exits 0"
  - criterion: pnpm --filter main lint passes
    verification: "cd <repo> && pnpm --filter main lint exits 0"
  - criterion: "pnpm --filter main test (vitest) is green, with all messageProjection.test.ts and schemas.test.ts cases passing"
    verification: "cd <repo> && pnpm --filter main test exits 0"
depends_on: []
estimated_complexity: medium
epic: claude-agent-sdk-migration
test_strategy:
  needed: true
  justification: "messageProjection.test.ts and schemas.test.ts directly cover the dead branches being removed and must be retargeted to the SDK compact_boundary shape; sibling-test scan of __tests__/ found 4 candidate tests, 2 of which assert the exact branches retired by this task."
  targets:
    - behavior: "messageProjection projects system/compact_boundary to a system message with systemSubtype='context_compacted', text segment empty, and metadata carrying compact_metadata.trigger and compact_metadata.pre_tokens"
      test_file: main/src/services/streamParser/__tests__/messageProjection.test.ts
      type: unit
    - behavior: "messageProjection no longer returns null on a system event whose subtype is 'compact_boundary' (positive case) and continues to return null for unknown system subtypes"
      test_file: main/src/services/streamParser/__tests__/messageProjection.test.ts
      type: unit
    - behavior: "Removed: legacy system/api_retry and system/compact projection tests must be deleted (they assert behavior that no longer exists)"
      test_file: main/src/services/streamParser/__tests__/messageProjection.test.ts
      type: unit
    - behavior: "TypedEventNarrowing still narrows compact_boundary, init, assistant, user, all 5 result subtypes, and stream_event; the exhaustive coverage table no longer includes systemApiRetry or systemCompact factory entries"
      test_file: main/src/services/streamParser/__tests__/schemas.test.ts
      type: unit
---
# Retire legacy stream-parser schema stubs and messageProjection dead branches

## Objective

The `system/api_retry` and `system/compact` Zod schemas in `main/src/services/streamParser/schemas.ts` are legacy `claude -p --include-partial-messages` CLI shapes that the Claude Agent SDK does NOT emit (the SDK uses `SDKStatusMessage` / `SDKRateLimitEvent` for retries and `compact_boundary` with `compact_metadata` for compaction). They were retained as migration scaffolding under explicit "T8 owns removal" markers. This task removes those schema stubs, retargets `messageProjection.ts` to read the SDK `compact_boundary` shape (replacing the dead `compact.summary` path and the unreachable `api_retry` skip branch), and updates the streamParser test surface to drop the legacy fixtures and add coverage for the SDK shape. `eventRouter.ts`, `rawEventsSink.ts`, `typedEventNarrowing.ts`, and the discriminated-union TypeScript types in `shared/types/claudeStream.ts` are not touched — the TS types stay as compatibility scaffolding for the test files and any third-party callers of the union; only the runtime Zod schema and the live code paths retire.

## Implementation Steps

1. **Sweep grep (rule 5d completeness gate).** Re-run the legacy-symbol grep before reporting COMPLETED:
   ```
   grep -rnE "systemApiRetry|systemCompact[^B]|systemApiRetrySchema|systemCompactSchema|subtype: 'api_retry'|subtype: 'compact'[^_]|z\\.literal\\('(api_retry|compact)'\\)" main/src/services/streamParser/ shared/types/
   ```
   Expected: matches survive ONLY in `shared/types/claudeStream.ts` (the TS interface declarations, intentionally preserved). Any match in `main/src/services/streamParser/` (including its `__tests__/` subtree) is a missed cleanup.

2. **Edit `main/src/services/streamParser/schemas.ts`.**
   - Delete the entire `systemApiRetrySchema` block (lines ~82-101 — the `/** system/api_retry: legacy CLI shape. ... */` comment plus the `z.object({...}).passthrough()` declaration).
   - Delete the entire `systemCompactSchema` block (lines ~103-116 — the `/** system/compact: LEGACY ... */` comment plus its declaration).
   - In the `systemUnionSchema = z.discriminatedUnion('subtype', [...])` declaration, remove `systemApiRetrySchema` and `systemCompactSchema` from the branch array, leaving exactly `[systemInitSchema, systemCompactBoundarySchema]`.
   - Leave `systemCompactBoundarySchema` and `systemInitSchema` untouched. Leave the top-level `z.union([systemUnionSchema, ...])` untouched (the SDK retained `system` as a top-level variant).
   - The compile-time `_typeCheck: ClaudeStreamEvent = {} as z.infer<typeof claudeStreamEventSchema>` continues to work because the narrower schema-inferred union is still assignable to the wider `ClaudeStreamEvent` TS union (which retains `SystemApiRetryEvent` and `SystemCompactEvent` as branches).

3. **Edit `main/src/services/streamParser/messageProjection.ts`.**
   - Update the type import on line 22 from `SystemCompactEvent` to `SystemCompactBoundaryEvent`. Final import: `import type { ClaudeStreamEvent, SystemInitEvent, SystemCompactBoundaryEvent, AssistantEvent, UserEvent, ResultEvent } from '../../../../shared/types/claudeStream';`.
   - Remove the `api_retry` skip branch (lines 69-72: the `// system/api_retry is informational — not renderable in the current design.` comment and the early-return `if` block). The new SDK substrate does not emit this subtype, so the branch is unreachable.
   - Change the `switch case 'system'` cast on line 79 from `SystemInitEvent | SystemCompactEvent` to `SystemInitEvent | SystemCompactBoundaryEvent`.
   - Change `projectSystemEvent`'s parameter type on line 106 from `SystemInitEvent | SystemCompactEvent` to `SystemInitEvent | SystemCompactBoundaryEvent`.
   - In `projectSystemEvent`, replace the `subtype === 'compact'` branch (lines 133-147) with a `subtype === 'compact_boundary'` branch:
     ```ts
     if (subtype === 'compact_boundary') {
       const compact = event as SystemCompactBoundaryEvent;
       return {
         id: `context_compacted_msg_${++this.messageIdCounter}`,
         role: 'system',
         timestamp: new Date().toISOString(),
         segments: [
           { type: 'system_info', info: {} }
         ],
         metadata: {
           systemSubtype: 'context_compacted',
           compact_trigger: compact.compact_metadata.trigger,
           pre_tokens: compact.compact_metadata.pre_tokens,
         }
       };
     }
     ```
     Note: the legacy `compact` shape carried a free-text `summary` string that was rendered as a text segment; the SDK shape does NOT carry a summary string — only the `compact_metadata` machine-readable fields. Replace the user-facing text segment with the empty `system_info` segment alone; downstream UI code in the renderer can format the context_compacted indication from the metadata. (This is a deliberate behavior change driven by the wire format change; preserve `systemSubtype: 'context_compacted'` so the renderer's existing discriminator continues to match.)
   - Leave the `subtype === 'init'` branch untouched.

4. **Edit `main/src/services/streamParser/__tests__/sdkMockFactories.ts`.**
   - Remove the import line entries `SystemApiRetryEvent,` and `SystemCompactEvent,` from the multi-line type import at the top.
   - Delete the `systemApiRetry(overrides)` factory function (lines 47-61).
   - Delete the `systemCompact(overrides)` factory function (lines 63-71).
   - Leave `systemCompactBoundary`, `systemInit`, and all other factories untouched.

5. **Edit `main/src/services/streamParser/__tests__/schemas.test.ts`.**
   - Remove `systemApiRetry,` and `systemCompact,` from the import list on lines 18-32. (`systemCompactBoundary` stays.)
   - Delete the `describe('SystemApiRetryEvent', () => { ... })` block (lines 76-95).
   - Delete the `describe('SystemCompactEvent', () => { ... })` block (lines 98-118).
   - Leave `describe('SystemCompactBoundaryEvent', ...)` untouched.
   - In the `describe('exhaustive union coverage', ...)` test (line 381+), remove the two entries from the `fixtures` array: `[systemApiRetry(), 'system/api_retry']` and `[systemCompact(), 'system/compact']`. Keep `[systemCompactBoundary(), 'system/compact_boundary']`. The `summarize` function's `case 'system': return \`system/${event.subtype}\`;` continues to handle compact_boundary because subtype is templated.
   - The `assertNever` call at the default branch still compiles because `SystemApiRetryEvent` and `SystemCompactEvent` remain in `ClaudeStreamEvent`. The exhaustive-coverage test now covers all variants the SDK actually emits.

6. **Edit `main/src/services/streamParser/__tests__/messageProjection.test.ts`.**
   - Remove `SystemCompactEvent,` and `SystemApiRetryEvent,` from the type import block on lines 28-37. Add `SystemCompactBoundaryEvent,` to that import.
   - Delete the `systemCompactEvent: SystemCompactEvent` fixture object (lines 62-67) and the `systemApiRetryEvent: SystemApiRetryEvent` fixture object (lines 69-77).
   - Add a new fixture `systemCompactBoundaryEvent: SystemCompactBoundaryEvent` with `subtype: 'compact_boundary'`, a `session_id`, and `compact_metadata: { trigger: 'auto', pre_tokens: 90000 }`.
   - Delete test case "2. system/compact" (`it('projects system/compact ...')`, lines 223-236).
   - Delete test case "3. system/api_retry → null" (`it('returns null for system/api_retry ...')`, lines 242-245).
   - Add a new test case in the same position: `it('projects system/compact_boundary to a system message with systemSubtype=context_compacted', () => { ... })` that calls `projection.project(systemCompactBoundaryEvent)` and asserts:
     - `result.role === 'system'`
     - `result.metadata?.systemSubtype === 'context_compacted'`
     - `result.metadata?.compact_trigger === 'auto'`
     - `result.metadata?.pre_tokens === 90000`
     - `result.segments` contains exactly one `system_info` segment (no text segment).
   - Update the JSDoc comment block at the top of the file (the "Coverage" enumeration at lines 9-23) to replace items 2 and 3 with the new compact_boundary case and remove the api_retry line. Keep numbering or renumber freely.

7. **Verification gate.** Run, in this order:
   - `cd <repo> && pnpm --filter main typecheck` — must exit 0. If it fails because some other file imports `SystemApiRetryEvent` or `SystemCompactEvent` and was missed, surface the failure and add the file to a follow-up (the grep in step 1 should have caught this).
   - `cd <repo> && pnpm --filter main lint` — must exit 0.
   - `cd <repo> && pnpm --filter main test` — must exit 0. All messageProjection.test.ts and schemas.test.ts cases must pass.
   - Re-run the step 1 grep one more time to confirm no legacy symbols remain in `main/src/services/streamParser/`.

## Acceptance Criteria

Each criterion is restated in the frontmatter with its grep / exit-code verification. Notable expectations:

- **Schema purity.** `schemas.ts` exposes a Zod `claudeStreamEventSchema` whose system branch dispatches only on `init` and `compact_boundary`. No `api_retry`, no `compact` literals remain.
- **Projection retargeted.** `messageProjection.ts` reads `compact_metadata` from the SDK `compact_boundary` event and no longer references the legacy `summary` field. The `api_retry` early-return branch is gone.
- **Test surface migrated, not deleted.** `schemas.test.ts` and `messageProjection.test.ts` survive — they cover narrowing and projection behavior that retains value post-migration. The two retired test cases per file are removed. A new `compact_boundary` projection test is added.
- **Factories pruned.** `sdkMockFactories.ts` no longer exports the legacy `systemApiRetry` and `systemCompact` factories.
- **Green checks.** `pnpm --filter main typecheck`, `pnpm --filter main lint`, and `pnpm --filter main test` all exit 0.

## Test Strategy

The test-writer should:

1. Delete the two retired test cases in `messageProjection.test.ts` (system/compact → context_compacted using the legacy summary, system/api_retry → null) and replace them with a single new test for the SDK `compact_boundary` projection. The new test asserts: `role === 'system'`, `metadata.systemSubtype === 'context_compacted'`, `metadata.compact_trigger`, `metadata.pre_tokens`, and the segments list contains exactly one `system_info` segment (no text segment carrying a `summary`).
2. Delete the two retired `describe` blocks in `schemas.test.ts` and the two corresponding entries in the exhaustive union coverage fixture table. The remaining `SystemCompactBoundaryEvent`, `passthrough preservation`, `UnknownStreamEvent fallback`, and 5 `ResultEvent` subtype tests stay green unchanged. The `assertNever` tripwire in the exhaustive-coverage test continues to compile because `SystemApiRetryEvent` and `SystemCompactEvent` remain branches of the TS union (we did not remove them from `shared/types/claudeStream.ts` — that is intentional, see "Hardest Decision").
3. No new mocking / fixture infrastructure required. The existing `MessageProjection` constructor (`new MessageProjection('run-id')`) and the inline fixture object literal pattern already used in `messageProjection.test.ts` are sufficient.

## Hardest Decision

**Whether to update or fully delete `__tests__/schemas.test.ts`.** The EPIC's deletion list (line 59 of `EPIC-claude-agent-sdk-migration.md`) names the file as part of the "fixture-driven `__tests__/schemas.test.ts` validation pattern" to retire. The skeleton's `scope_summary` reiterates "delete the `__tests__/schemas.test.ts` fixture-driven validation layer." However, the current file (post-TASK-594 migration) is no longer fixture-driven: it imports inline factory functions from `sdkMockFactories.ts` and asserts narrowing behavior of `TypedEventNarrowing.narrow()` against typed SDK-shape mocks. That coverage — variant narrowing, subtype discrimination, passthrough preservation, the `__unknown__` catch-all, the exhaustive `assertNever` tripwire — is substrate-independent and survives the migration unchanged in value. Deleting it would leave `TypedEventNarrowing.narrow()` (still production code, still imported by `eventRouter.ts`) without any unit coverage of its narrowing path.

I chose to **update** rather than delete: remove the two retired test cases and the two entries from the exhaustive-coverage fixture table, but keep the file as the SDK-mock narrowing test layer. This honors the EPIC's intent (retire byte-stream parse-and-validate scaffolding) while preserving the substrate-independent test coverage that EPIC line 51 explicitly directs us to keep: "Update fixture-based tests where they have substrate-independent value (event routing, message projection) to use SDK-mock fixtures."

## Rejected Alternatives

- **Full deletion of `schemas.test.ts`.** Rejected because it would silently drop `TypedEventNarrowing.narrow()` coverage — the production narrower that `eventRouter.ts` consumes — and there is no equivalent test in `typedEventNarrowing.test.ts` (which covers the constructor / logger plumbing, not the variant-narrowing surface). Would change my mind if a follow-up task migrates the narrowing assertions into `typedEventNarrowing.test.ts` first; in the current sprint that work is not scheduled.
- **Also delete `SystemApiRetryEvent` and `SystemCompactEvent` TS types from `shared/types/claudeStream.ts`.** Rejected because the skeleton lists `shared/types/claudeStream.ts` in `files_readonly_hint` (a constraint the detail-mode rules forbid removing). The dead types persist as TS-only union branches; they cost zero runtime bytes and zero behavior because the Zod schema no longer matches them. Would change my mind if a follow-up T-task is allocated to do the TS type cleanup with `claudeStream.ts` explicitly in `files_owned`; that would be a small chore-class task.
- **Render `compact_boundary` as a text segment using a synthesized summary string (e.g. "Context compacted (auto trigger, 90000 pre_tokens).").** Rejected because the SDK does not emit a free-text summary and synthesizing one in the main process couples message-projection logic to copy decisions that belong in the renderer. The new shape exposes `compact_trigger` and `pre_tokens` in metadata and the renderer can format them. Would change my mind if the renderer surfaces a regression requiring a server-side text fallback — in that case the synthesis belongs in this projection layer.

## Lowest Confidence Area

The compact_boundary projection's resulting metadata shape (`metadata.compact_trigger`, `metadata.pre_tokens`) is new — no existing renderer code consumes those fields. The legacy `compact` projection emitted a `text` segment containing `compact.summary` that the renderer presumably displayed; with this change the renderer will receive a `system_info` segment with empty `info` plus the new metadata fields. **If the renderer has UI that relies on the `text` segment of a `systemSubtype: 'context_compacted'` message, the user-visible behavior will silently change to "no text shown" until the renderer is also updated to read `compact_trigger` / `pre_tokens` from metadata.** This is downstream of TASK-682 (the renderer-side discriminator work). I did NOT grep the renderer for `context_compacted` consumers because `frontend/` is outside this task's `files_readonly` scope, but the integration smoke task (TASK-683) should explicitly verify a compaction round-trip if one can be triggered in dev. If the renderer regression is severe, fold a text-segment fallback back into `projectSystemEvent` as the cheapest mitigation.
