---
id: TASK-303
sprint: SPRINT-029
epic: approval-router-and-permission-fix
status: done
summary: "Add 60-min APPROVAL_TIMEOUT_MS to ApprovalRouter; per-pending-entry setTimeout fires deny on socket + sets approvals.status='timed_out' (plan said 'expired' but schema 006 CHECK only allows 'timed_out'). respond() and clearPendingForRun() clearTimeout to prevent leaks. 3 fake-timer tests added."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
visual_macos: skipped_user_preference
---

## Outcome
APPROVED + CLEAN. 16/16 tests pass. Plan-text 'expired' status replaced with schema-mandated 'timed_out' per migration 006 CHECK constraint.

## Files changed
- main/src/orchestrator/approvalRouter.ts (added APPROVAL_TIMEOUT_MS export, expireApproval method, timer wiring)
- main/src/orchestrator/__tests__/approvalRouter.test.ts (3 new fake-timer test cases)

## Notes
- Race between respond() and expireApproval is safe: both serialize through getQueueForRun(); inner double-check on this.pending.get() ensures only one handles each approvalId.
- clearTimeout also called in clearPendingForRun() for defensive cleanup.
