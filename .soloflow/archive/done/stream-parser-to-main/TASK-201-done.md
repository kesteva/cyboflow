---
id: TASK-201
sprint: SPRINT-005
epic: stream-parser-to-main
status: done
summary: "Main-process streamParser pipeline (LineBufferer → JSONParser → TypedEventNarrowing → EventRouter → ClaudeStreamParser) with never-throw contract"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-201 — Done Report

## Summary

Created the 4-stage main-process parser pipeline under `main/src/services/streamParser/`:

1. **LineBufferer** — chunk-boundary-safe, CRLF-safe, `feed(chunk): string[]` + `flush(): string[]`.
2. **JSONParser** — `parse(line): unknown | null`; never-throws, malformed input logs `logger.warn` (not error) and returns null.
3. **TypedEventNarrowing** — `narrow(parsed): ClaudeStreamEvent` using `claudeStreamEventSchema.safeParse`. Falls through to `{kind: '__unknown__', raw}` on schema mismatch — preserves data, never throws, never drops. The `'__unknown__'` sentinel matches the existing `UnknownStreamEvent` variant pinned in `shared/types/claudeStream.ts:234` (plan-text said `'unknown'` which would have broken typecheck; executor correctly followed the typed contract).
4. **EventRouter** — extends Node EventEmitter; per-runId fanout via `emitForRun(runId, event)` and `onRun(runId, handler) → teardown()`; `clearRun(runId)` for shutdown.
5. **ClaudeStreamParser** — orchestrates the pipeline with a defensive per-line try/catch that warn-logs and continues (third belt protecting against handler-throw under Node EventEmitter contract).
6. **index.ts** — barrel re-exporting all 5 classes.

## Changes

- `main/src/services/streamParser/{lineBufferer,jsonParser,typedEventNarrowing,eventRouter,streamParser,index}.ts` (all new)
- `main/src/services/streamParser/__tests__/{lineBufferer,jsonParser,typedEventNarrowing,eventRouter,streamParser}.test.ts` (new — 65 tests including the load-bearing chunk-boundary invariant)

## Commits

- `da10484` — `feat(TASK-201): add 4-stage streamParser pipeline ...`
- `2c2181e` — `test(TASK-201): add unit and integration tests for streamParser pipeline (63 tests pass)`
- `9c9707f` — `test(TASK-201): add interleaved-feed isolation and blank-line guard tests`

## Verification

- Tests: 65/65 streamParser cases pass across 6 test files.
- Typecheck: PASS across main, frontend, shared.
- Lint: 0 errors on new files.
- Per-task visual: skipped (parallel mode).
- Never-throw contract: `grep "throw" main/src/services/streamParser/{jsonParser,typedEventNarrowing}.ts` returns only docstring matches.
- Chunk-boundary invariant: load-bearing test feeds same fixture in 1-byte, 1024-byte, single-chunk variants and deep-equals the event arrays.

## Notes

- Catch-all sentinel uses `kind: '__unknown__'` (double underscore) per the existing `UnknownStreamEvent` type in `shared/types/claudeStream.ts:234`, not the lowercase `'unknown'` the plan text referenced.
- EventRouter does not call `setMaxListeners()`. Currently fine; if TASK-205's tRPC subscription layer fans out to many consumers per runId, the default-10 warning will fire — deferred to that task per the code-reviewer's note (filed as FIND-SPRINT-005-5 alongside the `parseClaudeStreamEvent` duplication question).
