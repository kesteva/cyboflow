---
id: TASK-665
sprint: SPRINT-025
epic: testing-infrastructure
status: done
summary: "Extracted shared raw_events test fixture (RAW_EVENTS_DDL, makeRawEventsDb, countRawEvents) and migrated runEventBridge.test.ts + runExecutor.test.ts to use it instead of inline duplicates"
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-665: Shared raw_events test fixture

## Outcome

Created `main/src/orchestrator/__tests__/__fixtures__/rawEvents.ts` with three named exports: `RAW_EVENTS_DDL`, `makeRawEventsDb()`, `countRawEvents()`. Migrated `runEventBridge.test.ts` (7 makeDb sites, 14 count sites) and `runExecutor.test.ts` (3 inline DBs, 2 inline counts) to use the fixture. `countRows` was renamed to `countRawEvents` mid-review per code-reviewer feedback to avoid future fixture collision once siblings (`messages`, `approvals`) materialize.

## Changes

- `main/src/orchestrator/__tests__/__fixtures__/rawEvents.ts` — new file with shared DDL + helpers
- `main/src/orchestrator/__tests__/runEventBridge.test.ts` — removed local DDL/makeDb/countRows; imports from fixture; 6 makeDb + 12 count sites updated
- `main/src/orchestrator/__tests__/runExecutor.test.ts` — removed RAW_EVENTS_DDL_EXEC; imports from fixture; 3 inline DBs + 2 inline counts updated

## Commits

- `49fa4a1` — `feat(TASK-665): add shared raw_events test fixture module`
- `2cbee0e` — `refactor(TASK-665): replace inline DDL/makeDb/countRows with shared fixture imports`
- `74ae7df` — `refactor(TASK-665): rename countRows to countRawEvents for future fixture cohabitation`
- `0d72eaa` — `docs(TASK-665): update stale countRows references in test comments`

## Verification

- pnpm typecheck: PASS
- pnpm lint: PASS (0 errors)
- runEventBridge.test.ts: 20/20 pass
- runExecutor.test.ts: 4 pre-existing failures unrelated to this refactor (FIND-SPRINT-025-1, FIND-SPRINT-025-8)
- shadow-verifier final verdict: APPROVED (after rename + comment fix)
- code-reviewer final verdict: CLEAN (after rename round)

## Out-of-diff findings filed

- FIND-SPRINT-025-8 — directory naming `__fixtures__/` diverges from established `__test_fixtures__/` convention; new fixture should be documented in `docs/CODE-PATTERNS.md`
- FIND-SPRINT-025-9 — `main/src/services/streamParser/__tests__/rawEventsSink.test.ts` still inlines an identical copy of the raw_events DDL; the dedup goal isn't fully achieved across the test surface yet
