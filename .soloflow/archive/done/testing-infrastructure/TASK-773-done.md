---
id: TASK-773
sprint: SPRINT-041
epic: testing-infrastructure
status: done
summary: "Fixed 4 pre-existing reviewQueueStore.test.ts failures by mirroring questionStore.test.ts post-shim mock pattern (onApprovalDecided subscription)."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-773 — Fix reviewQueueStore.test.ts post-shim failures

## Outcome

Restored `pnpm --filter frontend test` to a fully green baseline. The 4 `init() idempotency` cases that failed at `reviewQueueStore.ts:225` (missing `onApprovalDecided.subscribe` mock) now pass. Mock factory extended with the second subscription, mutable-reference handles renamed for clarity, all 4 assertions updated to cover both channels.

## Changes

- `frontend/src/stores/__tests__/reviewQueueStore.test.ts` — renamed `mockSubscribe*` → `mockCreatedSubscribe*`, added `mockDecidedSubscribe*` handles + factory exposure, updated 4 idempotency cases.

## Commits

- `36e99cf` fix(TASK-773): add onApprovalDecided mock to reviewQueueStore.test.ts

## Tests

- `pnpm --filter frontend test`: 511/511 pass (up from 507/511).
- Focused: reviewQueueStore.test.ts 17/17 pass.
- `pnpm --filter frontend typecheck`: 0.
- `pnpm --filter frontend lint`: 0 errors.

## Findings

- None new.

## Notes

Verifier flagged AC2 grep heuristic (`grep -n 'onApprovalDecided' ≥2`) as imperfect — questionStore.test.ts's analogous pattern also produces a single grep match for the channel name. Substantive criterion met; AC phrasing was over-specified by the planner. Not material.
