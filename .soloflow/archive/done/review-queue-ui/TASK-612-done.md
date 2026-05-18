---
id: TASK-612
sprint: SPRINT-017
epic: review-queue-ui
status: done
summary: "Keyboard y on group card now calls atomic approveRestOfRun.mutate, matching mouse semantics; mock path bug fixed"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

Restored keyboard/mouse parity for the review queue: group `y` now dispatches `trpc.cyboflow.approvals.approveRestOfRun.mutate({ runId })` atomically, matching PendingApprovalCard's mouse path and honoring the per-run lock introduced by IDEA-009 slice 8. Single-item `y` still uses `approve.mutate`, and group `n` keeps the per-member Promise.all fan-out (no rejectRestOfRun exists in v1). Test mock path corrected to `'../../utils/trpcClient'`, and added inverse assertions so future regressions are caught.
