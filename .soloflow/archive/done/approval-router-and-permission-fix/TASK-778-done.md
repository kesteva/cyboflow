---
id: TASK-778
sprint: SPRINT-041
epic: approval-router-and-permission-fix
status: done
summary: "No-op: all 4 ACs satisfied by TASK-773 (mock factory exposure) + TASK-775 (decided-subscription regression test) earlier in this sprint."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-778 — Fix reviewQueueStore.test.ts init-idempotency failures (no-op)

## Outcome

TASK-778 was planned from SPRINT-040 compound bucket B1, before TASK-773 (SPRINT-039 followups) was scheduled in this same sprint. TASK-773 already extended the `vi.mock('../../trpc/client', ...)` factory in `reviewQueueStore.test.ts` to expose `onApprovalDecided.subscribe` and renamed the spy handles to `mockCreatedSubscribe` / `mockDecidedSubscribe`. TASK-775 added the symmetric `onError` regression test for the decided subscription.

All four TASK-778 acceptance criteria are met by the current state:
1. ✓ `grep -n 'onApprovalDecided' frontend/src/stores/__tests__/reviewQueueStore.test.ts` returns matches inside the mock factory (line 44).
2. ✓ All 17 tests in `reviewQueueStore.test.ts` pass (verified: `pnpm --filter frontend test -- src/stores/__tests__/reviewQueueStore.test.ts` reports 515/515 across the frontend suite, focused file shows 17 passing).
3. ✓ `frontend/src/stores/reviewQueueStore.ts` was not modified BY this task (TASK-775 modified it, but that is a different task — second-subscription onError cleanup, not the mock-factory addition).
4. ✓ Typecheck + lint clean.

No new commits required from this task. Compound that originally proposed TASK-778 was not aware that TASK-773 was already queued.

## Changes

- None (no-op).

## Commits

- None.

## Tests

- pnpm --filter frontend test: 515/515 pass.
- focused: reviewQueueStore.test.ts 17/17 pass.

## Findings

- None new. TASK-778 acceptance state was achieved by TASK-773 + TASK-775.
