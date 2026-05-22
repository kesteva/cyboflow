---
id: TASK-729
sprint: SPRINT-032
epic: typed-stream-event-schema
status: done
summary: "Extend streamEventSchema.delta.type to accept signature_delta + thinking_delta and mirror in TS StreamEvent (P0 wire-format fix from live testing 2026-05-22)."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-729 — Done

## Changes
- `main/src/services/streamParser/schemas.ts`: inner delta `type` union grew 2 → 4 literals (`text_delta`, `input_json_delta`, `signature_delta`, `thinking_delta`) + optional `signature`/`thinking` carrier fields. JSDoc added.
- `shared/types/claudeStream.ts`: mirror change in `StreamEvent.event.delta`. `_typeCheck` bridge at `schemas.ts:385` keeps Zod schema and TS interface in lockstep.
- `main/src/services/streamParser/__tests__/sdkMockFactories.ts`: new factories `streamEventSignatureDelta()` and `streamEventThinkingDelta()` with audit-trail comment (`raw_events.id=1125`, run `b0f26c00...`).
- `main/src/services/streamParser/__tests__/schemas.test.ts`: 2 round-trip `it()` blocks asserting narrower preserves typed variant + carrier fields.
- `main/src/services/streamParser/__tests__/typedEventNarrowing.test.ts`: regression `it()` block confirming both delta types do NOT fall through to `__unknown__`.

## Verification
- Verifier: APPROVED. visual_mobile/web/macos `not_applicable` (pure backend schema).
- Code review: CLEAN. Zero findings.
- Tests: 72/72 stream-parser pass. `pnpm typecheck` exits 0.

## Out-of-scope follow-up
Plan §Hardest Decision flags a structural split — `main/src/services/panels/claude/claudeCodeManager.ts:343` raw-casts the SDK event bypassing `TypedEventNarrowing.narrow()`, while `runEventBridge.ts:209` uses the narrower. The compounder is cued to file this as a finding (bucket: structural, severity medium).

## Commits
- c5bd8b7 feat(TASK-729): extend streamEventSchema delta.type to accept signature_delta + thinking_delta
