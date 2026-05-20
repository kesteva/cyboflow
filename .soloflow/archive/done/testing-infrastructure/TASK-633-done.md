---
id: TASK-633
sprint: SPRINT-023
epic: testing-infrastructure
status: done
summary: "Extract inline dbAdapter to canonical fixture in 4 orchestrator test files"
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-633 Done

Pure test-fixture extraction: removed inline `function dbAdapter` from `cancelAndRestart.test.ts`, `approvalRouter.test.ts`, `stuckDetector.test.ts`, and `mcpServer/mcpQueryHandler.test.ts`. Each now imports the canonical fixture at `main/src/orchestrator/__test_fixtures__/dbAdapter`. `DatabaseLike` imports retained where still referenced (cancelAndRestart + approvalRouter), dropped where unused (stuckDetector + mcpQueryHandler).

## Commits
- ac6243c refactor(TASK-633): extract inline dbAdapter to canonical fixture in 4 test files

## Verification
- Tests: 49 in-scope tests pass (5 pre-existing failures on main, in untouched files)
- Typecheck/lint: clean
- Verifier: APPROVED
- Code-reviewer: CLEAN
- FIND-SPRINT-023-6 logged for 2 out-of-scope claudeCodeManager test files still carrying inline dbAdapter (follow-up task)
