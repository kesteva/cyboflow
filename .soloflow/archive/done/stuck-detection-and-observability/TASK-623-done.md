---
id: TASK-623
sprint: SPRINT-023
epic: stuck-detection-and-observability
status: done
summary: "Align useStuckNotifications with canonical StuckDetectedEvent schema (runId-keyed suppression, runId-truncated body)"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-623 Done

Removed local `StuckDetectedEvent` / `StuckReasonKind` re-declarations, imported the canonical types from `shared/types/stuckDetection`. `stuckReasonText` now accepts a `StuckReason` object and switches on `reason.kind` (exhaustive). Suppression key migrated from `sessionId` → `runId` (`notifiedRunsRef`). Notification body uses `runId.slice(0, 8)` instead of `workflowName` (which no longer exists on the canonical event). All 6 tests rewritten to the canonical event shape; suite passes.

## Commits
- 2d94f71 fix(TASK-623): align useStuckNotifications with canonical StuckDetectedEvent schema

## Verification
- Tests: 6/6 useStuckNotifications pass; 209/209 frontend total
- Typecheck: clean
- Verifier verdict: APPROVED
- Code-reviewer verdict: CLEAN
