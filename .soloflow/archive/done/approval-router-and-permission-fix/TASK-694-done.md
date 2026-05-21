---
id: TASK-694
sprint: SPRINT-029
epic: approval-router-and-permission-fix
status: done
summary: "Fix ApprovalRouter requestApproval INSERT + wire approvalCreated → approvalEvents bridge. Added 7 DIAG-approval checkpoints + defensive db-null assertion in approvalRouter.ts. 5 DIAG-hook checkpoints in preToolUseHookHelper.ts. Bridge handler in main/src/index.ts emits ApprovalCreatedEvent. New 'PreToolUse end-to-end' describe block with 2 integration tests against real SQLite + PQueue."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
visual_macos: skipped_user_preference
---

## Outcome
APPROVED_WITH_DEFERRED. AC4 + AC5 (live `pnpm dev` smoke + cyboflow-backend-debug.log DIAG-approval count) deferred to integration tester. Mitigating coverage: in-memory end-to-end test exercises the same code path against real SQLite + PQueue. 26 task-relevant tests pass; typecheck + lint exit 0.

## Files changed (4 commits)
- main/src/orchestrator/approvalRouter.ts (7 DIAG + defensive assertion)
- main/src/orchestrator/preToolUseHookHelper.ts (5 DIAG)
- main/src/index.ts (bridge: ApprovalRouter.on('approvalCreated', ...) → approvalEvents.emit('created', ApprovalCreatedEvent))
- main/src/orchestrator/__tests__/approvalRouter.test.ts (new "PreToolUse end-to-end" describe + 2 tests)
