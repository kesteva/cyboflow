---
id: TASK-646
sprint: SPRINT-024
epic: testing-infrastructure
status: done
summary: "Consolidated 6+ scattered LoggerLike test helpers into a single shared makeSpyLogger fixture + smoke-test; migrated 10 test files (8 planned + 2 scope expansions for sweep-grep completeness)."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

## Summary

Created `main/src/orchestrator/__test_fixtures__/loggerLikeSpy.ts` exporting `makeSpyLogger(): LoggerLike & { calls: LogCall[] }`. Dual contract: each method is a `vi.fn()` (spy-able) AND every invocation pushes `{ level, message, ctx? }` onto the shared `calls` array. Migrated workflowRegistry, runLauncher, stuckDetector, Orchestrator, mcpServerLifecycle, cyboflow ipc, runExecutor, preToolUseHookHelper test files plus tests/helpers/cyboflowTestHarness.ts. Field rename `.context` → `.ctx` applied consistently in workflowRegistry.test.ts.

Scope expansions (runExecutor.test.ts + preToolUseHookHelper.test.ts) were plan-prescribed (Step 1 sweep-grep gate calls for adding missed sites to files_owned). Logged as FIND-SPRINT-024-6 / -7, then resolved by verifier.

## Verifier

APPROVED — all 7 ACs met. 492 tests pass; 5 pre-existing failures (FIND-SPRINT-024-1, -2) confirmed pre-task on commit 2513687.

## Code review

CLEAN — no critical/important/minor findings.

## Test-writer

NO_TESTS_NEEDED. 8-case smoke-test covers all behavioral ACs; migrated test files themselves serve as the regression net.

## Commits

- `9928bd2 feat(TASK-646): add shared makeSpyLogger fixture with smoke-test`
- `24c451a refactor(TASK-646): migrate 8 test files to shared makeSpyLogger fixture`
