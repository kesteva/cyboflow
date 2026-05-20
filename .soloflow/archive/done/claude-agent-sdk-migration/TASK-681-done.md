---
id: TASK-681
sprint: SPRINT-026
epic: claude-agent-sdk-migration
status: done
summary: "Retire legacy stream-parser schemas (systemApiRetry, systemCompact) + messageProjection dead branches; retarget tests to SDK compact_boundary shape."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: not_applicable
---

# TASK-681 — Done

Retired the `system/api_retry` and `system/compact` Zod schemas (legacy `claude -p` shapes the SDK never emits) and the corresponding `messageProjection` dead branches. The `subtype === 'compact'` text-segment projection is replaced with a `subtype === 'compact_boundary'` projection that emits a single `system_info` segment plus `metadata.compact_trigger` and `metadata.pre_tokens` lifted from `event.compact_metadata`. The SDK does not carry a free-text summary — the renderer-side discriminator wiring is owned by TASK-682.

Compatibility scaffolding preserved per the plan's Hardest Decision: `SystemApiRetryEvent` / `SystemCompactEvent` remain TS-only branches of `shared/types/claudeStream.ts` (read-only) so the narrower Zod union still assigns into the wider TS union, the `_typeCheck` compile-time bridge still holds, and the `assertNever` tripwire in the exhaustive-coverage test continues to typecheck.

## Changes
- `main/src/services/streamParser/schemas.ts` — deleted the `systemApiRetrySchema` and `systemCompactSchema` blocks; `systemUnionSchema` is now `z.discriminatedUnion('subtype', [systemInitSchema, systemCompactBoundarySchema])`.
- `main/src/services/streamParser/messageProjection.ts` — swapped type import to `SystemCompactBoundaryEvent`; removed the `api_retry` early-return; replaced the legacy `subtype === 'compact'` text projection with the new `subtype === 'compact_boundary'` system_info + metadata projection.
- `main/src/services/streamParser/__tests__/sdkMockFactories.ts` — deleted `systemApiRetry()` and `systemCompact()` factories + their type imports.
- `main/src/services/streamParser/__tests__/schemas.test.ts` — deleted the two legacy describe blocks; dropped two fixtures from the exhaustive-union coverage table.
- `main/src/services/streamParser/__tests__/messageProjection.test.ts` — replaced legacy fixtures + test cases with a new `compact_boundary` projection test (executor); added test 12b covering the `projectSystemEvent` fallthrough for unknown system subtypes (test-writer).

## Verification
- `pnpm --filter main typecheck` — clean.
- `pnpm --filter main lint` — 0 errors (208 pre-existing warnings, none introduced).
- `pnpm --filter main exec vitest run src/services/streamParser/__tests__/{schemas,messageProjection}.test.ts` — 38/38 pass.
- Workspace `pnpm --filter main test` returns non-zero exclusively due to a pre-existing better-sqlite3 NODE_MODULE_VERSION 136/127 mismatch (FIND-SPRINT-026-4) — reproduces identically at HEAD~1 and is orthogonal to TASK-681's diff. Remediation: `pnpm electron:rebuild`.

## Findings
- FIND-SPRINT-026-4 (logged): pre-existing `rawEventsSink.test.ts` native-module failure (better-sqlite3 NODE_MODULE_VERSION mismatch). Reproduced at HEAD~1; not caused by this task.
- FIND-SPRINT-026-5 (queued for TASK-682): `metadata.compact_trigger` / `metadata.pre_tokens` use snake_case where surrounding metadata uses camelCase. Rename during TASK-682's renderer wiring rather than now.

## Visual
- `visual_mobile: skipped_user_preference` — visual_mobile=false in config.
- `visual_web: not_applicable` — all touched files are backend pure-TS (Zod schemas + projection + unit tests); no user-visible behavior.

## Commits
- 3e28311 — feat(TASK-681): retire legacy stream-parser schema stubs and dead branches
- cab20e3 — test(TASK-681): cover projectSystemEvent fallthrough for unknown system subtypes
