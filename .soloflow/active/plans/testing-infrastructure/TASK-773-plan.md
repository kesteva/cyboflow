---
id: TASK-773
idea: SPRINT-039-followups
status: ready
created: 2026-05-26T00:00:00Z
files_owned:
  - frontend/src/stores/__tests__/reviewQueueStore.test.ts
files_readonly:
  - frontend/src/stores/reviewQueueStore.ts
  - frontend/src/stores/__tests__/questionStore.test.ts
  - .soloflow/active/findings/SPRINT-039-findings.md
acceptance_criteria:
  - criterion: "All 4 pre-existing test failures in reviewQueueStore.test.ts are resolved. Failures stem from missing `trpc.cyboflow.events.onApprovalDecided.subscribe` in the mock factory after TASK-750 removed the trpc-shim."
    verification: "pnpm --filter frontend test -- reviewQueueStore.test.ts exits 0; the previously-failing 4 cases in `describe('init() idempotency', ...)` all pass."
  - criterion: "Mock factory now exposes BOTH `onApprovalCreated.subscribe` AND `onApprovalDecided.subscribe`, using the same mutable-reference pattern as questionStore.test.ts."
    verification: "grep -n 'onApprovalDecided' frontend/src/stores/__tests__/reviewQueueStore.test.ts returns ≥2 matches (one in the vi.mock factory, one or more in beforeEach mutable-reference assignment)."
  - criterion: "Test expectations for `mockSubscribe` call counts are updated to account for two subscriptions (created + decided) per init(), mirroring questionStore.test.ts's pattern of separate `mockCreatedSubscribe` and `mockDecidedSubscribe` (or `mockAnsweredSubscribe`-equivalent) spies."
    verification: "grep -n 'mockDecidedSubscribe\\|mockApprovalDecidedSubscribe' frontend/src/stores/__tests__/reviewQueueStore.test.ts returns ≥1 match."
  - criterion: "All 452 frontend tests pass (the 448 previously-passing + 4 newly-fixed)."
    verification: "pnpm --filter frontend test exits 0; the printed test summary shows 0 failed tests."
  - criterion: "Frontend typecheck and lint clean."
    verification: "pnpm --filter frontend typecheck exits 0; pnpm --filter frontend lint reports 0 errors (warnings unchanged from baseline acceptable)."
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: true
  justification: "This task IS the test fix — the deliverable is correct passing tests. The 4 failing tests need their mock factory + spy expectations updated."
  targets:
    - behavior: "init() subscribes to both onApprovalCreated and onApprovalDecided exactly once on first init; double-init is a no-op for both"
      test_file: "frontend/src/stores/__tests__/reviewQueueStore.test.ts"
      type: unit
    - behavior: "unsubscribe then init re-subscribes both subscriptions"
      test_file: "frontend/src/stores/__tests__/reviewQueueStore.test.ts"
      type: unit
    - behavior: "onError on the first (created) subscription resets closure state so a subsequent init re-subscribes"
      test_file: "frontend/src/stores/__tests__/reviewQueueStore.test.ts"
      type: unit
    - behavior: "StrictMode double-invoke leaves exactly one live subscription per subscription channel"
      test_file: "frontend/src/stores/__tests__/reviewQueueStore.test.ts"
      type: unit
---

# TASK-773 — Fix pre-existing reviewQueueStore.test.ts failures from TASK-750 trpc-shim removal

## Objective

Restore `pnpm --filter frontend test` to a fully-green baseline. The 4 failing test cases in `frontend/src/stores/__tests__/reviewQueueStore.test.ts` (all in the `describe('init() idempotency', ...)` block) throw `TypeError: Cannot read properties of undefined (reading 'subscribe')` at `reviewQueueStore.ts:225` because the test's `vi.mock('../../trpc/client', ...)` factory only stubs `trpc.cyboflow.events.onApprovalCreated.subscribe`, but the store's `init()` was extended (in SPRINT-038 commits 9927ca8 + 1127800) to subscribe to `trpc.cyboflow.events.onApprovalDecided` as well. The fix is mechanical: mirror the post-shim subscription mock pattern that `questionStore.test.ts` already uses (separate mutable-reference handles for each subscription channel), update the mock factory, and update the test's call-count expectations.

## Implementation Steps

1. **Establish a completeness baseline.** Run `pnpm --filter frontend test -- reviewQueueStore.test.ts` and confirm exactly 4 failures, all in `describe('init() idempotency', ...)`. Output of this run is the executor's "before" snapshot — record it in the task done file.

2. **Edit the mutable-reference declarations** at the top of `frontend/src/stores/__tests__/reviewQueueStore.test.ts` (currently lines 19-21) to add decided-subscription handles, mirroring questionStore.test.ts lines 27-31:
   ```ts
   let mockListPendingQuery: ReturnType<typeof vi.fn>;
   let mockCreatedSubscribeUnsubscribe: ReturnType<typeof vi.fn>;
   let mockCreatedSubscribe: ReturnType<typeof vi.fn>;
   let mockDecidedSubscribeUnsubscribe: ReturnType<typeof vi.fn>;
   let mockDecidedSubscribe: ReturnType<typeof vi.fn>;
   ```
   Rename the existing `mockSubscribeUnsubscribe` / `mockSubscribe` references to `mockCreatedSubscribeUnsubscribe` / `mockCreatedSubscribe` everywhere in the file for clarity (the existing names imply a single subscription; the post-shim store has two).

3. **Extend the `vi.mock('../../trpc/client', ...)` factory** (lines 27-49) to expose `onApprovalDecided.subscribe` alongside the existing `onApprovalCreated.subscribe`, using the same getter pattern:
   ```ts
   vi.mock('../../trpc/client', () => {
     return {
       trpc: {
         cyboflow: {
           approvals: {
             listPending: {
               get query() { return mockListPendingQuery; },
             },
           },
           events: {
             onApprovalCreated: {
               get subscribe() { return mockCreatedSubscribe; },
             },
             onApprovalDecided: {
               get subscribe() { return mockDecidedSubscribe; },
             },
             setBadgeCount: {
               mutate: vi.fn().mockResolvedValue(undefined),
             },
           },
         },
       },
     };
   });
   ```

4. **Update `beforeEach`** (lines 62-74) to reset the new decided-subscription mocks:
   ```ts
   beforeEach(() => {
     mockListPendingQuery = vi.fn().mockResolvedValue([]);
     mockCreatedSubscribeUnsubscribe = vi.fn();
     mockCreatedSubscribe = vi.fn().mockReturnValue({ unsubscribe: mockCreatedSubscribeUnsubscribe });
     mockDecidedSubscribeUnsubscribe = vi.fn();
     mockDecidedSubscribe = vi.fn().mockReturnValue({ unsubscribe: mockDecidedSubscribeUnsubscribe });
     useReviewQueueStore.setState({ queue: [], connectionStatus: 'idle' });
   });
   ```

5. **Update the 4 failing `init() idempotency` cases** (lines 213-300) to assert on the renamed spies AND on the decided-subscription separately, following questionStore.test.ts lines 227-300 as the model:
   - **Case "double init() — listPending.query called exactly once and subscribe called exactly once"** (line 213): rename to "double init() — listPending.query called exactly once and subscribe called exactly twice (once per subscription)"; assert both `mockCreatedSubscribe` AND `mockDecidedSubscribe` were called exactly 1 time after the double init (the second init must be a no-op for both channels).
   - **Case "unsubscribe then init() re-subscribes — subscribe called twice"** (line 228): assert that BOTH `mockCreatedSubscribe` AND `mockDecidedSubscribe` are called 2 times total (once per init), and that BOTH `mockCreatedSubscribeUnsubscribe` AND `mockDecidedSubscribeUnsubscribe` are called once after the first `unsub1()`.
   - **Case "onError resets closure state so a subsequent init() re-subscribes"** (line 245): update the `capturedOnError` capture to use `mockCreatedSubscribe`'s onError handler (the store wires the closure-state reset only on the first subscription's onError, line 212-219 of reviewQueueStore.ts; the decided subscription's onError at line 236-239 does NOT reset closure state). Re-create both `mockCreatedSubscribe` and `mockDecidedSubscribe` in the second-init setup; assert both are called once on the second init.
   - **Case "StrictMode double-invoke — exactly one live subscription after both mount effects settle"** (line 281): on the assertion side, assert `mockCreatedSubscribe` called 2 times AND `mockDecidedSubscribe` called 2 times AND both unsubscribes called exactly 1 time (mirrors lines 297-299).

6. **Run the completeness gate**:
   ```bash
   pnpm --filter frontend test -- reviewQueueStore.test.ts
   pnpm --filter frontend test
   pnpm --filter frontend typecheck
   pnpm --filter frontend lint
   ```
   All four must exit 0. The first command must show all `init() idempotency` cases passing.

## Acceptance Criteria

1. `pnpm --filter frontend test -- reviewQueueStore.test.ts` exits 0.
2. `pnpm --filter frontend test` exits 0; the printed summary reports 0 failed tests (up from 4 failing).
3. `grep -n 'onApprovalDecided' frontend/src/stores/__tests__/reviewQueueStore.test.ts` returns ≥2 matches (mock factory + beforeEach assignment).
4. `grep -n 'mockDecidedSubscribe\|mockApprovalDecidedSubscribe' frontend/src/stores/__tests__/reviewQueueStore.test.ts` returns ≥1 match.
5. `pnpm --filter frontend typecheck` and `pnpm --filter frontend lint` exit 0.

## Test Strategy

This task IS a test fix; the new `it()` blocks ARE the deliverable. The four updated cases cover the four failing scenarios from the pre-existing baseline: double init no-op, unsubscribe-then-reinit, onError closure reset, StrictMode double-invoke. The pattern is a verbatim mirror of questionStore.test.ts (added in SPRINT-039) — that file is already green and provides the canonical post-shim pattern.

## Hardest Decision

Whether to also refactor `reviewQueueStore.ts` to consolidate the two `subscribe(...)` call sites into a helper. Decided **not** to — it would expand scope beyond a test fix and could regress the existing first-subscription onError closure-reset asymmetry (which is the subject of TASK-775's separate fix). Keeping this task purely test-side preserves a clean diff and lets the executor's reviewer focus on test correctness.

## Rejected Alternatives

- **Delete the 4 failing tests.** Rejected: they cover real correctness properties (idempotency, StrictMode safety) and were green before TASK-750. Restoring them is the goal.
- **Add a single combined `mockSubscribe` that handles both channels via discrimination.** Rejected: questionStore.test.ts already established the separate-spy pattern; matching it keeps the two stores' tests symmetric and the diff small.
- **Mock the trpc-electron renderer adapter at a higher level.** Rejected: it would expand the test's mock surface beyond what the store needs and complicate future tRPC procedure changes.

## Lowest Confidence Area

Whether all 4 failing cases use exactly the line-number references in step 5. The compounder note cites 4 failures at `trpc.cyboflow.events.onApprovalDecided.subscribe` on `reviewQueueStore.ts:225` (verified at plan time), and the test file's `describe('init() idempotency', ...)` contains 4 `it()` blocks (verified at plan time). If a new case has been added since SPRINT-039 closed, run the failure grep once after step 1 to map current failures to current case names — the mapping shouldn't drift, but verify before editing.
```

---

```markdown
