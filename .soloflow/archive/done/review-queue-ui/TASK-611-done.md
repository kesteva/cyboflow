---
id: TASK-611
sprint: SPRINT-017
epic: review-queue-ui
status: done
summary: "ReviewQueueView mount effect now returns init() unsubscribe; init() is idempotent under StrictMode double-invoke; onError resets closure state so retry works"
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

Plugged the review-queue subscription leak. Mount effect uses the single-expression return form so React invokes init()'s unsubscribe on unmount. Store-level closure now tracks an `initialized` flag plus the active unsubscribe — double init() is a no-op, unsubscribe-then-init re-subscribes cleanly, StrictMode double-mount results in one live subscription. After review feedback, onError also resets the closure (calls subscription.unsubscribe(), clears flags) so the documented "call init() again to reconnect" contract holds after a tRPC drop. Tests: 203 across 16 files; added 4 idempotency cases + 1 component-level unmount cleanup case.
