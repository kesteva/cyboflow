---
id: TASK-666
sprint: SPRINT-025
epic: orchestrator-and-trpc-router
status: done
summary: "Made BridgeEventsOptions.db optional with a synchronous runtime guard that throws when skipPersistence is falsy AND db is undefined; expanded JSDoc; added test cases for the new contract"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-666: Optional BridgeEventsOptions.db with runtime guard

## Outcome

`db` is now optional on `BridgeEventsOptions`. A guard at the top of `bridgeEvents()` throws a descriptive error when `opts.skipPersistence !== true && db === undefined`, naming both fields and the recovery path. Production caller `RunExecutor` unchanged. Cases (a)(b)(e) of the test file now omit `db` entirely; new case (f) exercises both falsy `skipPersistence` forms; new case (g) covers the db-omitted success path.

## Changes

- `main/src/orchestrator/runEventBridge.ts` — `db?: Database.Database`; synchronous runtime guard; expanded JSDoc on both `db` and `skipPersistence` fields
- `main/src/orchestrator/__tests__/runEventBridge.test.ts` — updated (a)(b)(e); added (f) and (g)

## Commits

- `bb54ace` — `feat(TASK-666): make BridgeEventsOptions.db optional with runtime guard`

## Verification

- pnpm typecheck: PASS
- pnpm lint: PASS (0 errors)
- runEventBridge.test.ts: 22/22 pass
- shadow-verifier verdict: APPROVED
- code-reviewer verdict: CLEAN
- test-writer: NO_TESTS_NEEDED (case f/g already cover the new behavior; `{skipPersistence: undefined}` ruled tautological)
