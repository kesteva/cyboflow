---
sprint: SPRINT-018
pending_count: 3
last_updated: "2026-05-18T23:55:00Z"
---

# Findings Queue

## FIND-SPRINT-018-1
- **source:** TASK-642 (verifier)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/__tests__/runEventBridge.test.ts:22
- **description:** `TypedEventNarrowing` is imported from `../../services/streamParser` but never referenced in the test body. The bridge uses the default-constructed narrowing under the hood, so the test does not need to import it. ESLint flags it as `@typescript-eslint/no-unused-vars` (warning, not error).
- **suggested_action:** Drop `TypedEventNarrowing` from the import; keep only `EventRouter` and `RawEventsSink`.
- **resolved_by:**

## FIND-SPRINT-018-2
- **source:** TASK-642 (verifier)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/__tests__/runEventBridge.test.ts:96-99
- **description:** The `unknownEvent` fixture is declared but never consumed — the malformed-payload test (case 7) emits an inline raw object instead. ESLint flags this as `@typescript-eslint/no-unused-vars` (warning). The fixture is misleading because it shows a pre-built __unknown__ shape that the bridge never produces from the emit path it tests.
- **suggested_action:** Either delete the fixture, or rework case 7 to round-trip it (would need to feed it through `narrowing.narrow` first — probably not worth it; deletion is simpler).
- **resolved_by:**

## FIND-SPRINT-018-3
- **source:** TASK-642 (code-reviewer)
- **type:** anti-pattern
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/runEventBridge.ts:89-94 + main/src/services/streamParser/rawEventsSink.ts:38-44
- **description:** `deriveEnvelopeType` in runEventBridge.ts is a verbatim duplicate of `deriveEventType` in rawEventsSink.ts — both check `'kind' in event && event.kind === '__unknown__'` and fall back to `event.type`. The mapping from `ClaudeStreamEvent → event_type` is now defined in two places, so a future variant rename (e.g. a third "kind"-tagged catch-all) must be updated in both files or the sink/bridge views diverge silently. TASK-642's files_owned excluded rawEventsSink.ts, so the bridge correctly duplicated the helper rather than editing the sink — this is a cross-task cleanup, not a TASK-642 defect.
- **suggested_action:** Promote a single `deriveEventType(event: ClaudeStreamEvent): string` helper to `main/src/services/streamParser/index.ts` (or a new `derivers.ts`), then have both runEventBridge.ts and rawEventsSink.ts import it. Add a unit test for the helper itself rather than testing the mapping through each call site.
- **resolved_by:**
