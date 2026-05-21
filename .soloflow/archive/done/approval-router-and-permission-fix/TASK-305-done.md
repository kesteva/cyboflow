---
id: TASK-305
sprint: SPRINT-029
epic: approval-router-and-permission-fix
status: done
summary: "Boot-time recovery for stale awaiting_review rows. ApprovalRouter.recoverStaleAwaitingReview() transitions workflow_runs awaiting_review→failed/'app_restart' and pending approvals→timed_out/decided_by='system' in one transaction. Wired into main/src/index.ts initializeServices(). 2 unit tests."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
visual_macos: skipped_user_preference
---

## Outcome
APPROVED + CLEAN. 18/18 approvalRouter tests pass after pnpm install/electron-builder rebuild resolved the better-sqlite3 NMV mismatch surfaced as FIND-SPRINT-029-3 (now resolved).

## Files changed (3 commits)
- main/src/orchestrator/approvalRouter.ts (recoverStaleAwaitingReview method)
- main/src/index.ts (boot wiring after databaseService.initialize + ApprovalRouter.initialize)
- main/src/orchestrator/__tests__/approvalRouter.test.ts (Cases G + H)

## Notes
- Schema 006 compliant (error_message='app_restart', approvals.status='timed_out', decided_by='system').
- Atomic transaction wraps SELECT + both UPDATEs.
