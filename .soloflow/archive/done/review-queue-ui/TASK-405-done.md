---
id: TASK-405
sprint: SPRINT-011
epic: review-queue-ui
status: done
summary: "Oldest-first sort + blocking-pin (>3min) + grouping selectors; Blocking/Pending sections; CardChrome refactor (cumulative from SPRINT-010)"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_unable
---

# TASK-405 — Done (SPRINT-011)

## Context
TASK-405 work fully landed in SPRINT-010 (commits 99a3c87, a7e38cf, eb4095f). Verifier APPROVED all 7 ACs; code reviewer CLEAN with one defense-in-depth out-of-diff note queued for compounder.

## Files in Scope
- `frontend/src/utils/reviewQueueSelectors.ts` (sortQueueOldestFirst, partitionBlockingItems, groupRepeatedApprovals, selectQueueView, payloadSignature, QueueItem type)
- `frontend/src/utils/__tests__/reviewQueueSelectors.test.ts` (22 tests)
- `frontend/src/stores/reviewQueueStore.ts` (useReviewQueueView 30s timer hook)
- `frontend/src/components/PendingApprovalCard.tsx` (CardChrome subcomponent, single + group variants, blocking badge, approveRestOfRun for group approve)
- `frontend/src/components/ReviewQueueView.tsx` (Blocking + Pending section headers)

## Verification
- Tests: 22/22 selector tests, 30/30 PendingApprovalCard tests, 99/99 full frontend
- Typecheck: PASS
- Lint: PASS
- Visual: mobile skipped (user pref); web skipped_unable per-task — deferred to sprint-level verifier (Step 3.5)

## Findings Queued
- FIND-SPRINT-011-6 (code-reviewer, new): `ReviewQueueView.tsx:26` interpolates `approval.id` into a CSS attribute selector without `CSS.escape()`. Defense-in-depth; today safe because ids are server-issued UUIDs. Compounder candidate.
