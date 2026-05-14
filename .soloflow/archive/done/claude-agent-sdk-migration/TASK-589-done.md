---
id: TASK-589
sprint: SPRINT-008
epic: claude-agent-sdk-migration
status: done
summary: "Retarget claudeStream discriminated union + schemas.ts to Claude Agent SDK wire format; additive only; consumers untouched."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-589 — Retarget claudeStream union to SDK wire format

## Outcome

Additive retarget of the discriminated union and its Zod parity layer onto the `@anthropic-ai/claude-agent-sdk` wire shapes. Every existing variant kept all its existing fields; new fields are optional. New variant `SystemCompactBoundaryEvent` (subtype `compact_boundary`) added; legacy `SystemCompactEvent` and `SystemApiRetryEvent` retained verbatim with T8-cleanup-owner doc comments. `ResultEvent.subtype` gained a fifth literal `'error_max_structured_output_retries'`. The `_typeCheck` drift bridge between TS and Zod still compiles, so schema output remains assignable to `ClaudeStreamEvent`. The four substrate-independent consumers (`eventRouter`, `messageProjection`, `rawEventsSink`, `typedEventNarrowing`) are byte-identical to pre-task.

## Files changed

- `shared/types/claudeStream.ts` — discriminated union retarget
- `main/src/services/streamParser/schemas.ts` — parallel Zod retarget

## Verification

- `pnpm typecheck`: PASS (3 workspaces clean; `_typeCheck` drift bridge holds)
- `pnpm lint`: PASS (0 errors; 303 pre-existing warnings in frontend, unchanged)
- streamParser test suite: 104/104 pass against retargeted union
- Verifier verdict: APPROVED (11/11 ACs; consumer-invariance + no-fixture-touch + no-claudeCodeManager-touch all confirmed via `git diff --name-only`)
- Code-review verdict: CLEAN (TS↔Zod parity exact across all 13 additions; discriminator integrity preserved on both union schemas; `.passthrough()` retained everywhere)

## Forward references

- TASK-590 (T4) — must add a `compact_boundary` case in `projectSystemEvent`'s switch (`messageProjection.ts:106`).
- TASK-594 (T8) — fixture & test migration: delete the dead `SystemApiRetryEvent` and legacy `SystemCompactEvent` variants once `messageProjection.ts` and `rawEventsSink.ts` no longer reference them; migrate fixtures from CLI wire format to SDK wire format.
