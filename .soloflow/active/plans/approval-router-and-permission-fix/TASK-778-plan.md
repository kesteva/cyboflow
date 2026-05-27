---
id: TASK-778
idea: SPRINT-040-followups
status: ready
created: 2026-05-26T00:00:00Z
files_owned:
  - frontend/src/stores/__tests__/reviewQueueStore.test.ts
files_readonly:
  - frontend/src/stores/reviewQueueStore.ts
  - main/src/orchestrator/trpc/routers/events.ts
  - shared/types/approvals.ts
acceptance_criteria:
  - criterion: "The tRPC module mock in reviewQueueStore.test.ts declares onApprovalDecided.subscribe returning { unsubscribe: vi.fn() }, symmetric with the existing onApprovalCreated.subscribe declaration."
    verification: "grep -n 'onApprovalDecided' frontend/src/stores/__tests__/reviewQueueStore.test.ts returns at least one match inside the vi.mock('../../trpc/client', ...) factory."
  - criterion: "All 17 tests in reviewQueueStore.test.ts pass — including the 4 previously failing init() idempotency tests."
    verification: "pnpm --filter frontend test -- reviewQueueStore.test.ts exits 0 and the stdout reports 17 tests passing."
  - criterion: "No production code in frontend/src/stores/reviewQueueStore.ts is modified by this task."
    verification: "git diff --name-only HEAD -- frontend/src/stores/reviewQueueStore.ts returns empty."
  - criterion: "Frontend typecheck and lint are clean."
    verification: "pnpm --filter frontend typecheck exits 0; pnpm --filter frontend lint exits 0 (or unchanged from baseline)."
depends_on: []
estimated_complexity: low
epic: approval-router-and-permission-fix
test_strategy:
  needed: true
  justification: "The whole task IS a test fix — adjusting the test module-mock so the existing 4 idempotency tests stop crashing in setup. No new test cases are added; the existing 17 cases become the verification surface."
  targets:
    - behavior: "Updated vi.mock factory declares onApprovalDecided.subscribe returning { unsubscribe: vi.fn() }"
      test_file: "frontend/src/stores/__tests__/reviewQueueStore.test.ts"
      type: unit
    - behavior: "All 4 init() idempotency tests pass: 'double init()', 'unsubscribe then init() re-subscribes', 'onError resets closure state', 'StrictMode double-invoke'"
      test_file: "frontend/src/stores/__tests__/reviewQueueStore.test.ts"
      type: unit
---

# TASK-778 — Fix reviewQueueStore.test.ts init-idempotency failures

## Objective

Repair the 4 failing tests in `frontend/src/stores/__tests__/reviewQueueStore.test.ts > init() idempotency` that crash with `TypeError: unsub1 is not a function`. The production `init()` at `frontend/src/stores/reviewQueueStore.ts:225` subscribes to BOTH `onApprovalCreated` AND `onApprovalDecided`, but the test's `vi.mock('../../trpc/client', ...)` factory only declares `onApprovalCreated.subscribe`. When `init()` invokes `trpc.cyboflow.events.onApprovalDecided.subscribe(...)`, the mocked module returns `undefined`, so the closure dereferences `undefined.unsubscribe` and throws — destroying the closure before `unsub1` ever becomes callable. Fix is symmetric: extend the mock factory to declare `onApprovalDecided.subscribe` with the same `{ unsubscribe: mockSubscribeUnsubscribe }` return shape. No production code changes.

## Implementation Steps

1. Locate the `vi.mock('../../trpc/client', () => { ... })` factory block (currently lines 27–49).

2. Inside the `events` object of the mock factory, add a sibling `onApprovalDecided` entry symmetric with `onApprovalCreated`. Reuse the existing `mockSubscribe` getter so a single spy tracks both channels.

3. Re-baseline the `mockSubscribe.toHaveBeenCalledTimes(N)` and `mockSubscribeUnsubscribe.toHaveBeenCalledTimes(N)` assertions to reflect that one successful `init()` now calls `subscribe` TWICE (once per channel) and cleanup calls `unsubscribe` TWICE:
   - "double init()" test: `expect(mockSubscribe).toHaveBeenCalledTimes(1)` → `2`.
   - "unsubscribe then init() re-subscribes": first-init `1` → `2`; post-second-init `2` → `4`; `mockSubscribeUnsubscribe` count `1` → `2`.
   - "StrictMode double-invoke": `mockSubscribe` `2` → `4`; `mockSubscribeUnsubscribe` `1` → `2`.

4. For the "onError resets closure state" test, add a `subscribeCallIndex` counter so the test captures only the FIRST `onError` (the `onApprovalCreated` handler — the one that resets closure state; `onApprovalDecided`'s onError only sets `connectionStatus`). Apply the same pattern to the second `mockSubscribe` re-assignment in the same test. Production code's `onError` only invokes `subscription.unsubscribe()` (not the decided one), so `mockSubscribeUnsubscribe.toHaveBeenCalledTimes(1)` stays `1`.

5. Verify all 17 tests pass: `pnpm --filter frontend test -- reviewQueueStore.test.ts` exits 0.

6. Run typecheck + lint to confirm no regressions.

7. Confirm zero production drift: `git diff HEAD -- frontend/src/stores/reviewQueueStore.ts` is empty.

## Source

Compound proposal SPRINT-040 item B1; originally FIND-SPRINT-040-1 (pre-existing failures surfaced repeatedly during SPRINT-040 verification).
