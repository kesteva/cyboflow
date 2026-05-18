---
id: TASK-611
idea: IDEA-009
status: in-flight
created: "2026-05-15T00:00:00Z"
files_owned:
  - frontend/src/components/ReviewQueueView.tsx
  - frontend/src/stores/reviewQueueStore.ts
  - frontend/src/stores/__tests__/reviewQueueStore.test.ts
  - frontend/src/components/__tests__/ReviewQueueView.test.tsx
files_readonly:
  - frontend/src/utils/trpcClient.ts
  - shared/types/approvals.ts
  - frontend/src/utils/reviewQueueSelectors.ts
acceptance_criteria:
  - criterion: "ReviewQueueView's mount effect returns the unsubscribe function from init() so React invokes it on unmount."
    verification: "grep -n 'useEffect' frontend/src/components/ReviewQueueView.tsx shows the init() mount effect body as a single-expression return form (e.g. `useEffect(() => useReviewQueueStore.getState().init(), [])`), and there is no `init()` call whose return value is discarded."
  - criterion: "init() is idempotent: a second call before the returned unsubscribe runs does not create a second tRPC subscription and does not issue a second listPending fetch."
    verification: "grep -n 'initialized\\|isInitialized' frontend/src/stores/reviewQueueStore.ts shows an internal guard flag. A vitest case in reviewQueueStore.test.ts calls init() twice on the same store instance and asserts `trpc.cyboflow.approvals.listPending.query` was called exactly once and `trpc.cyboflow.events.onApprovalCreated.subscribe` was called exactly once."
  - criterion: "After the returned unsubscribe runs once, the next init() call re-subscribes (re-entry is a no-op only while a live subscription exists)."
    verification: "A vitest case calls init(), invokes the returned unsubscribe, then calls init() again, and asserts subscribe was called twice (one per init() that produced a live subscription)."
  - criterion: ReviewQueueView.test.tsx still passes after the mount-effect rewrite — `mockInit` is invoked exactly once per test render.
    verification: "pnpm --filter frontend test exits 0 and the suite includes the existing `it('calls init() once on mount', ...)` case. The mock's `init` factory MUST return a no-op unsubscribe `() => {}` so React's useEffect contract is satisfied."
  - criterion: "No StrictMode-style double subscription: rendering ReviewQueueView inside <React.StrictMode> (or two consecutive mounts of the component) results in exactly one live onApprovalCreated subscription after both mount effects settle."
    verification: "A vitest case in reviewQueueStore.test.ts that simulates StrictMode's double-invoke (call init() twice without invoking the unsubscribe between calls, then invoke the first unsubscribe, then assert the store still has one subscription accounted for via the mocked subscribe call count and the internal `initialized` flag)."
depends_on: []
estimated_complexity: low
epic: review-queue-ui
test_strategy:
  needed: true
  justification: Adds an idempotency guard and changes a React effect-cleanup contract — both regressions slip silently if not tested.
  targets:
    - behavior: "init() is idempotent on re-entry while subscription is live (single listPending fetch, single subscribe)"
      test_file: frontend/src/stores/__tests__/reviewQueueStore.test.ts
      type: unit
    - behavior: init() returned unsubscribe disposes the subscription; subsequent init() re-subscribes
      test_file: frontend/src/stores/__tests__/reviewQueueStore.test.ts
      type: unit
    - behavior: "ReviewQueueView mount effect wires init()'s unsubscribe (mock asserts unsubscribe is invoked on unmount)"
      test_file: frontend/src/components/__tests__/ReviewQueueView.test.tsx
      type: component
---
# Fix subscription leak — wire init() unsubscribe return in ReviewQueueView

## Objective

Plug a subscription/state leak in the review-queue mount path. `ReviewQueueView` discards the unsubscribe function returned by `useReviewQueueStore.getState().init()`, so React's StrictMode double-invoke and any future remount stack live `onApprovalCreated` subscriptions inside the Zustand store. Switch the mount effect to React's cleanup-return form AND add an `initialized` guard inside `init()` so re-entry while a live subscription exists is a no-op.

## Implementation Steps

1. In `frontend/src/stores/reviewQueueStore.ts`, capture an `initialized: boolean` flag and an active `unsubscribe` reference inside the `create((set, get) => {...})` factory closure. Do NOT expose either via the public `ReviewQueueState` shape.
2. In `init()` (currently lines 155-207): at the top, if `initialized === true`, return the cached unsubscribe immediately — skip the connecting status set, the `listPending.query()` call, and the `onApprovalCreated.subscribe` call.
3. Set `initialized = true` before the listPending fetch begins. When the returned unsubscribe runs, set `initialized = false` AND clear the cached unsubscribe reference so a later init() restarts cleanly.
4. In `frontend/src/components/ReviewQueueView.tsx`, replace the mount effect with the single-expression return form: `useEffect(() => useReviewQueueStore.getState().init(), [])`.
5. In `frontend/src/components/__tests__/ReviewQueueView.test.tsx`, update `mockInit` to return a no-op unsubscribe (`vi.fn(() => () => {})`).
6. Add three new test cases under a `describe('init() idempotency')` block in `reviewQueueStore.test.ts` covering: (a) double init() → one query/subscribe; (b) unsubscribe→init() → re-subscribes; (c) StrictMode-style sequence.
7. Run `pnpm --filter frontend test` and `pnpm typecheck`.

## Acceptance Criteria

All five criteria above.

## Test Strategy

Two layers: store-level idempotency cases in `reviewQueueStore.test.ts` (3 new cases) plus the existing component-level mount-once test still passing.
