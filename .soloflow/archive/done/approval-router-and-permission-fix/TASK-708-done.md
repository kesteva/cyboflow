---
id: TASK-708
sprint: SPRINT-029
epic: approval-router-and-permission-fix
status: done
summary: "Recover running/starting orphans on app boot. New runRecovery.ts module + recoverActiveStateOrphans(db, runQueues) → {runningRecovered, startingRecovered, approvalsCanceled}. Skips runs with live RunQueueRegistry entries. Single transaction. Schema-correct (failed/app_restart/timed_out). 5 integration tests (4 required + 1 defensive)."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
visual_macos: skipped_user_preference
---

## Outcome
APPROVED. All 5 new tests pass; typecheck + lint exit 0. Wired into initializeServices after ApprovalRouter.getInstance().recoverStaleAwaitingReview() from TASK-305.

## Files changed (2 commits)
- main/src/orchestrator/runRecovery.ts (new)
- main/src/orchestrator/__tests__/runRecovery.test.ts (new — 5 tests)
- main/src/index.ts (boot wiring + log)
