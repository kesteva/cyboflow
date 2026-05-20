---
id: TASK-627
sprint: SPRINT-023
epic: stuck-detection-and-observability
status: done
summary: "WARN log + button tooltip for clearPendingForRun no-op partial functionality (TASK-304)"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-627 Done

Added `logger?.warn(...)` after `approvalRouter.clearPendingForRun(runId)` in `cancelAndRestartHandler.ts` referencing TASK-304 and including `{ runId }` context, surfacing the documented no-op behavior in dev logs. Added `title` attribute to the Cancel-and-restart button in the stuck-aware `PendingApprovalCard` so users see the known limitation on hover. Two new handler tests (positive + noOp suppression) and one new component test asserting the tooltip text.

## Commits
- 7026d25 feat(TASK-627): add WARN log for clearPendingForRun no-op and tooltip on Cancel and restart button

## Verification
- Tests: 15/15 handler + 259/259 frontend pass
- Typecheck/lint: clean
- Verifier: APPROVED
- Code-reviewer: CLEAN
