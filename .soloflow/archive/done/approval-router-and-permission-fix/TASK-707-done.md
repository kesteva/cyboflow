---
id: TASK-707
sprint: SPRINT-029
epic: approval-router-and-permission-fix
status: done
summary: "Backfill workflow_runs.started_at via COALESCE(started_at, CURRENT_TIMESTAMP) in transitionToRunning. Single-line UPDATE change + 2 unit tests (set-when-NULL, preserve-COALESCE)."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
visual_macos: skipped_user_preference
---

## Outcome
APPROVED + CLEAN. 12/12 tests pass (10 existing + 2 new). transitionFromAwaitingReview intentionally untouched per AC #2.
