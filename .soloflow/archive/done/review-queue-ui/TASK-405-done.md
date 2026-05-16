---
id: TASK-405
sprint: SPRINT-010
epic: review-queue-ui
status: done
summary: "Oldest-first sort + blocking-pin (>3min) + repeated-approval grouping; Blocking/Pending sections; CardChrome subcomponent"
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-405 — Selectors + Sections + Group Variant

## Outcome

Three pure selectors composed in `frontend/src/utils/reviewQueueSelectors.ts`: `sortQueueOldestFirst`, `partitionBlockingItems` (3-min threshold), `groupRepeatedApprovals` (same-run + same toolName + payloadSignature), and `selectQueueView` composing all three. `useReviewQueueView` hook re-evaluates every 30s. `ReviewQueueView` renders `Blocking` (conditional) + `Pending` sections. `PendingApprovalCard` learned a `group` variant with `{toolName} (×N in this run)` header, blocking badge, and batched Promise.all approve/reject — chrome extracted into a single `CardChrome` subcomponent. `useReviewQueueKeyboard` refactored to `QueueItem[]` (plan step 5).

## Files

- `frontend/src/utils/reviewQueueSelectors.ts` (new)
- `frontend/src/utils/__tests__/reviewQueueSelectors.test.ts` (new — 22 tests)
- `frontend/src/stores/reviewQueueStore.ts` (added useReviewQueueView)
- `frontend/src/components/PendingApprovalCard.tsx` (single + group variants; CardChrome subcomponent)
- `frontend/src/components/ReviewQueueView.tsx` (Blocking/Pending sections, useReviewQueueView)
- `frontend/src/hooks/useReviewQueueKeyboard.ts` (refactored to QueueItem[])
- Test files updated to match: 95 tests across 6 files.

## Verification

- 95 frontend tests pass (vitest + jsdom)
- `pnpm typecheck`: clean
- `pnpm lint`: 0 errors
- Visual: skipped (parallel mode)

## Commits

- `99a3c87` feat(TASK-405): oldest-first sort, blocking-pin, repeated-approval grouping
- `a7e38cf` refactor(TASK-405): extract CardChrome subcomponent to remove single/group duplication
