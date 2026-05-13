---
id: TASK-203
sprint: SPRINT-005
epic: stream-parser-to-main
status: done
summary: "RawEventsSink — fail-soft append-only persistence of parser events to raw_events"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-203 — Done Report

## Summary

Created `main/src/services/streamParser/rawEventsSink.ts` — `RawEventsSink(db, logger?)` with `attachToRouter(router, runId)` and `dispose(runId?)`. Each typed event from the parser pipeline becomes one INSERT into `raw_events`. Prepared INSERT statement cached at construction time per better-sqlite3 best practice.

Fail-soft contract: insert errors log a warn and return; the sink continues processing subsequent events. A DB hiccup (e.g., WAL checkpoint mid-write) never kills the orchestrator process. The `{kind:'__unknown__', raw}` catch-all variant from TASK-201's TypedEventNarrowing is normalized to `event_type='unknown'` in the row while preserving the raw payload in `payload_json` — future replay possible if the schema gains new variants.

`attachToRouter` is re-attach safe: if called twice for the same runId, the prior teardown is invoked before the new handler registers, preventing duplicate inserts on re-subscribe.

## Changes

- `main/src/services/streamParser/rawEventsSink.ts` (new)
- `main/src/services/streamParser/__tests__/rawEventsSink.test.ts` (new — 8 integration tests including re-attach safety and 100KB-payload no-truncation)

## Commits

- `36431a9` — `feat(TASK-203): add RawEventsSink for raw_events audit log persistence`
- `7c45fd5` — `test(TASK-203): add re-attach safety and large-payload tests`

## Verification

- Tests: 8/8 rawEventsSink cases pass against in-memory better-sqlite3 with the actual `006_cyboflow_schema.sql` DDL applied.
- Typecheck: PASS.
- Lint: PASS.
- Per-task visual: skipped (parallel mode).

## Notes

- Schema reconciliation: the original plan referenced an `event_subtype` column, but the actual `006_cyboflow_schema.sql` does NOT include one. The sink folds subtype information into `payload_json` instead. The plan's "Lowest Confidence Area" explicitly anticipated this dependency.
- Out-of-scope finding queued by the code-reviewer: FIND-SPRINT-005-7 — `main/src/services/streamParser/index.ts` should re-export `RawEventsSink` for the canonical barrel pattern. The barrel is in TASK-201's files_owned so the edit was deferred.
