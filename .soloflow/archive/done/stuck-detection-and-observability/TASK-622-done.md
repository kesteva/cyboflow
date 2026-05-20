---
id: TASK-622
sprint: SPRINT-023
epic: stuck-detection-and-observability
status: done
summary: "Wire stuck-detection UI: ReviewQueueView card swap, subscription mount, cancelAndRestart deps"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-622 Done

Swapped ReviewQueueView's PendingApprovalCard import to the stuck-aware variant under `./ReviewQueue/`, added `useRunStatus` selector to `reviewQueueSlice`, mounted `subscribeToStuckEvents` at App top-level, and wired `setCancelAndRestartDeps` in `main/src/index.ts` after `ApprovalRouter.initialize`. Stuck events now propagate to UI cards and Cancel-and-Restart can run end-to-end (subject to TASK-304 for deny-replies on the permission socket).

## Commits
- 6d9badb feat(TASK-622): add useRunStatus selector hook to reviewQueueSlice
- 23266d2 feat(TASK-622): swap to stuck-aware PendingApprovalCard and thread runStatus
- 938b67b feat(TASK-622): mount subscribeToStuckEvents at App top-level
- e118f9b feat(TASK-622): wire setCancelAndRestartDeps in main/src/index.ts
- 5e1905a test(TASK-622): update ReviewQueueView tests for new import and runStatus prop
- 508e68e test(TASK-622): add useRunStatus selector unit tests to reviewQueueSlice.test.ts

## Verification
- Tests: 215/215 frontend pass; 5 pre-existing main-process failures unchanged
- Typecheck: clean across workspaces
- Verifier verdict: APPROVED
- Code-reviewer verdict: CLEAN
