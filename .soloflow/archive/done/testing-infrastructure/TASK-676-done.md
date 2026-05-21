---
id: TASK-676
sprint: SPRINT-027
epic: testing-infrastructure
status: done
summary: "Moved rawEvents fixture to canonical __test_fixtures__/ path; deleted inline DDL/helpers in rawEventsSink.test.ts. Single source of truth."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: not_applicable
visual_macos: not_applicable
---

# TASK-676 — Done

## What changed
- New canonical file: main/src/orchestrator/__test_fixtures__/rawEvents.ts (content preserved verbatim from old path)
- Deleted: main/src/orchestrator/__tests__/__fixtures__/rawEvents.ts + empty __fixtures__/ directory
- Imports updated: runEventBridge.test.ts, runExecutor.test.ts (both now from ../__test_fixtures__/rawEvents)
- rawEventsSink.test.ts refactored: removed inline RAW_EVENTS_DDL, makeDb, countRows; added shared import; renamed call sites to makeRawEventsDb/countRawEvents

## Verification
- Targeted: 56/56 pass (runEventBridge.test.ts 22, runExecutor.test.ts 26, rawEventsSink.test.ts 8).
- Full vitest: 541/542 (pre-existing killProcess timeout only).
- Typecheck + lint: pass.

## Findings logged
- FIND-SPRINT-027-3 (duplicate of -2; killProcess timeout)
- FIND-SPRINT-027-4 (out-of-scope: GATE_SCHEMA in registrySchema.ts still inlines raw_events DDL)

## Commit
- 6fb03c9 refactor(TASK-676): move rawEvents fixture to canonical __test_fixtures__/ directory
