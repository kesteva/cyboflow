---
id: TASK-624
sprint: SPRINT-023
epic: stuck-detection-and-observability
status: done
summary: "Persist reason + detectedAt in reviewQueueSlice; surface detectedAt in StuckBadge tooltip"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-624 Done

Added `runReasonMap` and `runDetectedAtMap` to `reviewQueueSlice` state with idempotent per-field writes in `applyStuckEvent`. New `useRunStuckDetails(runId)` selector hook (using zustand v5 `useShallow` from `zustand/react/shallow`) returns both fields. `StuckBadge` accepts optional `detectedAt` and appends a relative-time suffix to its native title. `PendingApprovalCard` now reads the slice internally — ReviewQueueView no longer passes `stuckReason` explicitly (preferred path).

## Commits
- c495ee9 feat(TASK-624): add runReasonMap/runDetectedAtMap to reviewQueueSlice and surface detectedAt in StuckBadge
- 9e3c990 test(TASK-624): add slice tests for reason/detectedAt maps and useRunStuckDetails; update card tests for badge tooltip with detectedAt

## Verification
- Tests: 231/231 frontend pass
- Typecheck: clean
- Verifier: APPROVED
- Code-reviewer: CLEAN
