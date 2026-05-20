---
id: TASK-625
sprint: SPRINT-023
epic: first-run-onboarding-and-self-host-acceptance
status: done
summary: "Consolidate OnboardingCard dismissal via onDecide prop on PendingApprovalCard + useReviewQueueKeyboard"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-625 Done

Added optional `onDecide?: () => void` prop to both `PendingApprovalCard` variants (root + ReviewQueue), invoked after success in `.then()` for approve/reject (single + group); `.catch(noop)` suppresses error-path dismissal. `useReviewQueueKeyboard` now accepts `onDecide` as a positional second arg, stored in a ref so the global key listener stays registered once. `ReviewQueueView` consolidates dismissal through `handleDecide` (idempotent via `onboardingDismissedRef`) and removed the duplicate window.keydown y/n listener. Comprehensive tests across 4 files cover success, error suppression, idempotency, keyboard, mouse, modifier guard.

## Commits
- 83bfbcd feat(TASK-625): add onDecide prop to PendingApprovalCard variants; consolidate dismissal in ReviewQueueView
- 401c95c test(TASK-625): add onDecide, keyboard-path, and dismissal tests
- 1c93f19 fix(TASK-625): add .catch() to mutation chains to suppress unhandled rejections on error path
- 4a45595 fix(TASK-625): update OnboardingCard.test.tsx keyboard mock to forward onDecide arg

## Verification
- Tests: 258/258 frontend pass
- Typecheck/lint: clean
- Verifier: APPROVED
- Code-reviewer: CLEAN
- FIND-SPRINT-023-7 (OnboardingCard.test.tsx scope deviation) self-resolved as AC-prescribed
