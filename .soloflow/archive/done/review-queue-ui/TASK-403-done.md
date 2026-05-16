---
id: TASK-403
sprint: SPRINT-011
epic: review-queue-ui
status: done
summary: "PendingApprovalCard + approvalFormatters fully implemented (cumulative from SPRINT-010); CardChrome refactor + group variant from TASK-405/406 already in place"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_unable
---

# TASK-403 — Done (SPRINT-011)

## Context

TASK-403 work landed in SPRINT-010 and was extended by sibling TASK-405 (CardChrome extraction, blocking-pin) and TASK-406 (group variant with approveRestOfRun). Verifier APPROVED all 6 ACs; code reviewer CLEAN with one queued out-of-diff finding (FIND-SPRINT-011-3, see below).

## Files in Scope
- `frontend/src/components/PendingApprovalCard.tsx` (single + group variants, CardChrome, role=listitem, data-approval-id, focus ring, busy state)
- `frontend/src/utils/approvalFormatters.ts` (formatAge + truncatePayload pure helpers)
- `frontend/src/components/__tests__/PendingApprovalCard.test.tsx` (30 tests)

## Verification
- Tests: 96/96 frontend, 30/30 PendingApprovalCard.test.tsx
- Typecheck: PASS
- Lint: PASS
- Visual: mobile skipped (user pref); web skipped_unable per-task (sprint-level verifier handles)

## Findings Queued
- FIND-SPRINT-011-3 (code-reviewer, out-of-diff): `useReviewQueueKeyboard.ts:74-80` still uses per-item `approve.mutate` for groups while the mouse path now uses `approveRestOfRun`. Originally framed as a TASK-406 follow-up but TASK-406 only updated the card. Compounder candidate.
