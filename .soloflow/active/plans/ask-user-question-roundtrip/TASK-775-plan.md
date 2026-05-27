---
id: TASK-775
idea: SPRINT-039-followups
status: in-flight
created: "2026-05-26T00:00:00Z"
files_owned:
  - frontend/src/stores/reviewQueueStore.ts
  - frontend/src/stores/questionStore.ts
  - frontend/src/stores/__tests__/reviewQueueStore.test.ts
  - frontend/src/stores/__tests__/questionStore.test.ts
files_readonly:
  - .soloflow/active/findings/SPRINT-039-findings.md
acceptance_criteria:
  - criterion: "In reviewQueueStore.ts, the SECOND subscription's onError (currently lines 236-239 on onApprovalDecided) MIRRORS the FIRST subscription's onError pattern: unsubscribes both subscriptions, resets `initialized = false`, clears `cachedUnsubscribe = null`."
    verification: "grep -nA 8 'onError: \\(err: unknown\\) => \\{' frontend/src/stores/reviewQueueStore.ts | grep -c 'initialized = false' returns 2 (one for each subscription's onError handler)."
  - criterion: "In questionStore.ts, the SECOND subscription's onError (currently lines 248-251 on onQuestionAnswered) MIRRORS the FIRST subscription's onError pattern likewise."
    verification: "grep -nA 8 'onError: \\(err: unknown\\) => \\{' frontend/src/stores/questionStore.ts | grep -c 'initialized = false' returns 2."
  - criterion: "Both stores' SECOND-subscription onError handlers unsubscribe BOTH subscriptions before resetting state, ensuring no dangling subscription leaks."
    verification: "grep -nC 4 'onApprovalDecided subscription error' frontend/src/stores/reviewQueueStore.ts shows the onError body calls subscription.unsubscribe() AND decidedSubscription.unsubscribe() before setting initialized = false; similar pattern for onQuestionAnswered in questionStore.ts."
  - criterion: "A new test case in each store's test file asserts that triggering the SECOND subscription's onError allows a subsequent init() to re-subscribe (mirroring the existing first-subscription onError tests)."
    verification: "grep -n 'onError.*second subscription\\|onQuestionAnswered.*resets closure\\|onApprovalDecided.*resets closure' frontend/src/stores/__tests__/reviewQueueStore.test.ts returns ≥1 match; same grep against questionStore.test.ts returns ≥1 match."
  - criterion: All frontend tests pass.
    verification: pnpm --filter frontend test exits 0.
  - criterion: Frontend typecheck and lint clean.
    verification: pnpm --filter frontend typecheck exits 0; pnpm --filter frontend lint reports 0 errors.
depends_on:
  - TASK-773
estimated_complexity: medium
epic: ask-user-question-roundtrip
test_strategy:
  needed: true
  justification: "The bug is a latent recoverability hole: if the SECOND subscription drops independently of the FIRST, the store is stuck 'initialized' with no path to recover. Without a regression test mirroring the existing first-subscription onError test, the asymmetry would re-emerge on any future store refactor."
  targets:
    - behavior: "Triggering reviewQueueStore's onApprovalDecided.subscribe onError allows a subsequent init() to re-subscribe to both channels"
      test_file: frontend/src/stores/__tests__/reviewQueueStore.test.ts
      type: unit
    - behavior: "Triggering questionStore's onQuestionAnswered.subscribe onError allows a subsequent init() to re-subscribe to both channels"
      test_file: frontend/src/stores/__tests__/questionStore.test.ts
      type: unit
    - behavior: "Triggering the second-subscription onError calls BOTH subscriptions' unsubscribe (no leak)"
      test_file: frontend/src/stores/__tests__/reviewQueueStore.test.ts and frontend/src/stores/__tests__/questionStore.test.ts
      type: unit
---
# TASK-775 — Make second-subscription onError mirror first-subscription cleanup in both stores

## Objective

Close FIND-SPRINT-039-8: in both `reviewQueueStore.ts` and `questionStore.ts`, the SECOND subscription's `onError` handler (on `onApprovalDecided` and `onQuestionAnswered` respectively) only sets `connectionStatus: 'disconnected'`; it does NOT unsubscribe the first subscription, does NOT reset `initialized = false`, and does NOT clear `cachedUnsubscribe = null`. Result: if the second subscription channel drops independently of the first, the store is stuck "initialized" — every subsequent `init()` returns the cached unsubscribe without re-subscribing, and the user has no recovery path short of a full page reload. The first subscription's onError already does the full cleanup correctly. Make the second-subscription onError handler mirror the first in both stores, and add a regression test in each store's test file.

## Implementation Steps

1. **Run the completeness baseline:** `pnpm --filter frontend test -- reviewQueueStore.test.ts questionStore.test.ts`. After TASK-773 lands, all tests must be green; if not, surface failures before continuing. (This task `depends_on: [TASK-773]` because reviewQueueStore.test.ts must be passing on the baseline before adding new cases.)

2. **Update `reviewQueueStore.ts` line 236-239** (the `onApprovalDecided` subscription's onError) to mirror lines 212-219 (the `onApprovalCreated` subscription's onError). Current code:
   ```ts
   onError: (err: unknown) => {
     console.error('[reviewQueueStore] onApprovalDecided subscription error:', err);
     setConnectionStatus('disconnected');
   },
   ```
   Replace with:
   ```ts
   onError: (err: unknown) => {
     console.error('[reviewQueueStore] onApprovalDecided subscription error:', err);
     setConnectionStatus('disconnected');
     // Mirror the onApprovalCreated onError pattern: unsubscribe BOTH
     // subscriptions and clear closure state so a subsequent init()
     // re-subscribes. Without this, a second-subscription drop leaves the
     // store stuck "initialized" with no recovery path.
     subscription.unsubscribe();
     decidedSubscription.unsubscribe();
     initialized = false;
     cachedUnsubscribe = null;
   },
   ```
   Note: `decidedSubscription` is the variable being assigned (the `const decidedSubscription = trpc.cyboflow.events.onApprovalDecided.subscribe(...)` block on line 225) — there is a self-reference inside the onError. TypeScript permits this because `subscribe` returns synchronously before any data/error event can fire; the binding is initialized by the time the onError runs. Verify by checking the existing first-subscription pattern at lines 215-218 which already does this with `subscription.unsubscribe()`.

3. **Symmetrically update `questionStore.ts` line 248-251** (the `onQuestionAnswered` subscription's onError). Current code:
   ```ts
   onError: (err: unknown) => {
     console.error('[questionStore] onQuestionAnswered subscription error:', err);
     setConnectionStatus('disconnected');
   },
   ```
   Replace with:
   ```ts
   onError: (err: unknown) => {
     console.error('[questionStore] onQuestionAnswered subscription error:', err);
     setConnectionStatus('disconnected');
     // Mirror the onQuestionCreated onError pattern: unsubscribe BOTH
     // subscriptions and clear closure state so a subsequent init()
     // re-subscribes. Without this, a second-subscription drop leaves the
     // store stuck "initialized" with no recovery path.
     createdSubscription.unsubscribe();
     answeredSubscription.unsubscribe();
     initialized = false;
     cachedUnsubscribe = null;
   },
   ```

4. **Add the regression test to `frontend/src/stores/__tests__/reviewQueueStore.test.ts`** in the existing `describe('init() idempotency', ...)` block. The pattern mirrors the existing "onError resets closure state so a subsequent init() re-subscribes" test (which currently covers the FIRST subscription's onError, lines 245-279 post-TASK-773). The new test must capture the onError of the DECIDED subscription specifically:
   ```ts
   it('onError on onApprovalDecided resets closure state so a subsequent init() re-subscribes', () => {
     let capturedDecidedOnError: ((err: unknown) => void) | undefined;
     mockDecidedSubscribe = vi.fn().mockImplementation((_input, handlers: { onError?: (err: unknown) => void }) => {
       capturedDecidedOnError = handlers.onError;
       return { unsubscribe: mockDecidedSubscribeUnsubscribe };
     });

     const unsub1 = useReviewQueueStore.getState().init();
     activeUnsub = unsub1;

     expect(mockCreatedSubscribe).toHaveBeenCalledTimes(1);
     expect(mockDecidedSubscribe).toHaveBeenCalledTimes(1);
     expect(capturedDecidedOnError).toBeDefined();

     // Trigger the SECOND subscription's error
     capturedDecidedOnError!(new Error('decided channel dropped'));

     // Store should be disconnected AND closure state cleared
     expect(useReviewQueueStore.getState().connectionStatus).toBe('disconnected');
     // Both unsubscribes should have fired (no leak)
     expect(mockCreatedSubscribeUnsubscribe).toHaveBeenCalledTimes(1);
     expect(mockDecidedSubscribeUnsubscribe).toHaveBeenCalledTimes(1);

     // Reset for the recovery probe
     mockCreatedSubscribeUnsubscribe = vi.fn();
     mockCreatedSubscribe = vi.fn().mockReturnValue({ unsubscribe: mockCreatedSubscribeUnsubscribe });
     mockDecidedSubscribeUnsubscribe = vi.fn();
     mockDecidedSubscribe = vi.fn().mockReturnValue({ unsubscribe: mockDecidedSubscribeUnsubscribe });

     // A subsequent init() must NOT be a no-op
     const unsub2 = useReviewQueueStore.getState().init();
     activeUnsub = unsub2;

     expect(mockCreatedSubscribe).toHaveBeenCalledTimes(1); // fresh subscribe
     expect(mockDecidedSubscribe).toHaveBeenCalledTimes(1);
     expect(mockListPendingQuery).toHaveBeenCalledTimes(2); // listPending called again
   });
   ```
   The mutable-reference handles (`mockCreatedSubscribe`, `mockDecidedSubscribe`, etc.) come from TASK-773's renamed test scaffolding — this task depends on that scaffolding.

5. **Add the symmetric regression test to `frontend/src/stores/__tests__/questionStore.test.ts`**. The pattern is identical, swapping `Created` → `Created` (unchanged) and `Decided` → `Answered`:
   ```ts
   it('onError on onQuestionAnswered resets closure state so a subsequent init() re-subscribes', () => {
     let capturedAnsweredOnError: ((err: unknown) => void) | undefined;
     mockAnsweredSubscribe = vi.fn().mockImplementation((_input: undefined, handlers: { onError?: (err: unknown) => void }) => {
       capturedAnsweredOnError = handlers.onError;
       return { unsubscribe: mockAnsweredSubscribeUnsubscribe };
     });

     const unsub1 = useQuestionStore.getState().init();
     activeUnsub = unsub1;

     expect(mockCreatedSubscribe).toHaveBeenCalledTimes(1);
     expect(mockAnsweredSubscribe).toHaveBeenCalledTimes(1);
     expect(capturedAnsweredOnError).toBeDefined();

     capturedAnsweredOnError!(new Error('answered channel dropped'));

     expect(useQuestionStore.getState().connectionStatus).toBe('disconnected');
     expect(mockCreatedSubscribeUnsubscribe).toHaveBeenCalledTimes(1);
     expect(mockAnsweredSubscribeUnsubscribe).toHaveBeenCalledTimes(1);

     mockCreatedSubscribeUnsubscribe = vi.fn();
     mockCreatedSubscribe = vi.fn().mockReturnValue({ unsubscribe: mockCreatedSubscribeUnsubscribe });
     mockAnsweredSubscribeUnsubscribe = vi.fn();
     mockAnsweredSubscribe = vi.fn().mockReturnValue({ unsubscribe: mockAnsweredSubscribeUnsubscribe });

     const unsub2 = useQuestionStore.getState().init();
     activeUnsub = unsub2;

     expect(mockCreatedSubscribe).toHaveBeenCalledTimes(1);
     expect(mockAnsweredSubscribe).toHaveBeenCalledTimes(1);
     expect(mockListPendingQuery).toHaveBeenCalledTimes(2);
   });
   ```

6. **Run the completeness gate**:
   ```bash
   pnpm --filter frontend test
   pnpm --filter frontend typecheck
   pnpm --filter frontend lint
   ```
   All three exit 0. The two new test cases must pass.

## Acceptance Criteria

1. `grep -nA 8 'onError: (err: unknown) => {' frontend/src/stores/reviewQueueStore.ts | grep -c 'initialized = false'` returns 2.
2. `grep -nA 8 'onError: (err: unknown) => {' frontend/src/stores/questionStore.ts | grep -c 'initialized = false'` returns 2.
3. In each store, both subscriptions' `unsubscribe()` calls are present in the SECOND-subscription onError body (visible via `grep -nC 4 '<second-channel> subscription error' frontend/src/stores/<file>`).
4. Each store's test file gains a new `it()` case for the second-subscription onError recovery path; both new tests pass.
5. `pnpm --filter frontend test`, `pnpm --filter frontend typecheck`, `pnpm --filter frontend lint` all exit 0.

## Test Strategy

Two new `it()` blocks — one per store test file — inside the existing `describe('init() idempotency', ...)` block. Each test captures the SECOND subscription's onError handler via a `vi.fn().mockImplementation((..., handlers) => { captured = handlers.onError; return ...; })` pattern (mirroring the existing first-subscription onError test, lines 245-279 of reviewQueueStore.test.ts post-TASK-773). The test then triggers the captured onError and asserts: (a) `connectionStatus === 'disconnected'`, (b) BOTH unsubscribes were called once, (c) a subsequent `init()` re-subscribes BOTH channels and re-issues `listPending.query`.

## Hardest Decision

Whether the second-subscription onError should unsubscribe the FIRST subscription as part of cleanup. Picked **yes** because: (1) the first-subscription's onError already unsubscribes the second (line 217 of reviewQueueStore.ts: `subscription.unsubscribe()` refers to the first subscription itself, but reads as a "tear it all down" intent — extending symmetry means the second-subscription onError should similarly tear it all down); (2) leaving the first subscription live after the second drops creates a half-functional store where new approvals appear but decisions never clear them — worse UX than fully disconnecting and re-prompting recovery via init(); (3) the closure variable references (`subscription`, `decidedSubscription`) are in scope and synchronously initialized before any onError can fire, so the dual unsubscribe is safe. The alternative — only unsubscribe the SECOND and let the first stay live — leaves a phantom approval feed that grows without bound.

## Rejected Alternatives

- **Extract a shared `resetClosure(unsubs: Array<() => void>)` helper at the top of each store.** Rejected: micro-helpfulness at the cost of an extra abstraction layer; the inline cleanup blocks are already 4 lines each and self-documenting. Reconsider if a third subscription channel is ever added to either store.
- **Only set `connectionStatus = 'disconnected'` and `initialized = false`, without explicit unsubscribes.** Rejected: the FIRST subscription would remain live in the tRPC client, sending events to a store that thinks it's not initialized — race condition between disconnect signal and dangling delta.
- **Wrap both subscriptions in a single Promise.all-style helper.** Rejected: same as the first alternative, plus the per-channel `onError` debug message (`'onApprovalCreated subscription error'` vs `'onApprovalDecided subscription error'`) is genuinely useful diagnostic signal worth preserving.

## Lowest Confidence Area

Whether the test's `capturedDecidedOnError!(new Error(...))` call is synchronous enough to assert closure state immediately after. The store's onError handler is synchronous (no `await`, no `setTimeout`), so the assertions on the next line will see the post-cleanup state. The questionStore version uses `mockAnsweredSubscribe.mockImplementation((_input: undefined, handlers) => {...})` — note the `_input: undefined` type annotation matches what questionStore.test.ts's existing onError test uses on line 267. If the type mismatch causes a vitest mock-typing complaint, copy the exact handler-arg typing pattern from questionStore.test.ts:266-270 verbatim.
```

---

```markdown
