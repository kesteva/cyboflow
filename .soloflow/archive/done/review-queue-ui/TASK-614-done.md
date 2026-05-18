---
id: TASK-614
sprint: SPRINT-017
epic: review-queue-ui
status: done
summary: "Added focus guard to useReviewQueueKeyboard so j/k/y/n only fire when document.activeElement is body/null"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

Tightened the window-level keydown handler in ReviewQueueView's always-mounted hook. New guard returns early when document.activeElement is neither document.body nor null, so j/k/y/n no longer fire when a Radix focus trap, modal, or other focusable element holds focus. The existing input-element instanceof guards remain as defence-in-depth (documented in JSDoc). Three new tests cover: j no-op on focused div, y no-op on focused div, j fires when body focused. 207 tests pass.
