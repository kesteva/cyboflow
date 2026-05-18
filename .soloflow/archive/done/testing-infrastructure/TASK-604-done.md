---
id: TASK-604
sprint: SPRINT-015
epic: testing-infrastructure
status: done
summary: "Extracted shared dbAdapter() helper with `: DatabaseLike` return annotation; replaced 4 inline copies with imports"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-604 — Done

Created `main/src/orchestrator/__test_fixtures__/dbAdapter.ts` with `export function dbAdapter(db: Database.Database): DatabaseLike`. Replaced 4 inline copies in `workflowRegistry.test.ts`, `runLauncher.test.ts`, `cyboflow.test.ts`, and `cyboflowTestHarness.ts` with imports.

The load-bearing `: DatabaseLike` return-type annotation ensures future widening of the `DatabaseLike` interface fails typecheck at the fixture site rather than silently drifting across copies.

44 unit tests pass; gate test passes (6.7s).

Sprint-code-reviewer noted FIND-SPRINT-015-15: 5 additional test files (`cancelAndRestart.test.ts`, `approvalRouter.test.ts`, `stuckDetector.test.ts`, `mcpQueryHandler.test.ts`, `inspectorQueries.test.ts`) still carry inline dbAdapter copies — direct drop-in candidates for follow-up.

Ran serially on the run branch (no worktree) because TASK-605/606 overlap on `runLauncher.test.ts`.

Commit: `7b599a1` — refactor(TASK-604): extract shared dbAdapter() into __test_fixtures__
