---
id: TASK-625
idea: SPRINT-013
status: in-flight
created: "2026-05-17T00:00:00Z"
files_owned:
  - frontend/src/components/ReviewQueueView.tsx
  - frontend/src/components/PendingApprovalCard.tsx
  - frontend/src/components/ReviewQueue/PendingApprovalCard.tsx
  - frontend/src/hooks/useReviewQueueKeyboard.ts
  - frontend/src/components/__tests__/PendingApprovalCard.test.tsx
  - frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx
  - frontend/src/components/__tests__/ReviewQueueView.test.tsx
files_readonly:
  - frontend/src/components/OnboardingCard.tsx
  - frontend/src/utils/reviewQueueSelectors.ts
acceptance_criteria:
  - criterion: "PendingApprovalCard (both root-level and ReviewQueue variant) accepts an optional onDecide?: () => void prop, and invokes it on successful approve and reject mutation completion."
    verification: "grep -nE 'onDecide\\??:\\s*\\(\\)' frontend/src/components/PendingApprovalCard.tsx frontend/src/components/ReviewQueue/PendingApprovalCard.tsx returns at least 4 matches (prop definition + at least one invocation in each file's approve and reject handlers)."
  - criterion: "useReviewQueueKeyboard accepts an optional onDecide?: () => void second argument and invokes it from the y/n switch arms after the mutate call."
    verification: "Read useReviewQueueKeyboard.ts — the signature now is `useReviewQueueKeyboard(queue, onDecide?)` (or accepts an options object containing onDecide). The y and n switch arms call onDecide?.() after the mutation is fired."
  - criterion: "ReviewQueueView wires onDecide to a single shared callback that runs dismissOnboarding() + setOnboardingDismissed(true) the first time it fires, and is idempotent thereafter."
    verification: "grep -n 'onDecide' frontend/src/components/ReviewQueueView.tsx returns at least 2 matches (one for the keyboard hook, one passed to PendingApprovalCard via QueueRow or directly). Read the callback: it must guard via onboardingDismissedRef.current and be a no-op on subsequent invocations."
  - criterion: The duplicate window.keydown listener block in ReviewQueueView.tsx (lines 57–84 of the pre-task file — the y/n dismissal listener) is removed.
    verification: "grep -nE 'window\\.addEventListener\\(.keydown.|onboardingDismissedRef' frontend/src/components/ReviewQueueView.tsx — the existing y/n keydown listener block must be gone; only the useEffect that initializes onboardingDismissedRef on mount may remain."
  - criterion: "Existing 'y/n dismisses onboarding card' behavior continues to work end-to-end through the consolidated path (useReviewQueueKeyboard.onDecide → ReviewQueueView callback)."
    verification: "Add a ReviewQueueView component test: render with an onboarding card visible and a queue item, press 'y' on window, assert the OnboardingCard role='status' element is no longer in the DOM."
  - criterion: "New behavior: clicking the Approve or Reject button in a PendingApprovalCard also dismisses the onboarding card."
    verification: "Add ReviewQueueView component tests for both: render with onboarding visible and a queue item, fire click on Approve (then separately Reject) — assert OnboardingCard is removed from DOM after the mutation resolves."
  - criterion: All existing PendingApprovalCard / ReviewQueue/PendingApprovalCard / ReviewQueueView tests still pass.
    verification: "Run 'pnpm --filter cyboflow-frontend test -- --run frontend/src/components/__tests__ frontend/src/components/ReviewQueue/__tests__ frontend/src/hooks/__tests__/useReviewQueueKeyboard'; exit 0."
  - criterion: pnpm typecheck succeeds across all workspaces with no new errors.
    verification: "Run 'pnpm typecheck' from repo root; exit 0."
depends_on: []
estimated_complexity: medium
epic: first-run-onboarding-and-self-host-acceptance
test_strategy:
  needed: true
  justification: "Three new dismissal paths (mouse-Approve, mouse-Reject, consolidated keyboard) plus a refactor of the keyboard hook signature need direct coverage."
  targets:
    - behavior: Mouse click on Approve dismisses the onboarding card.
      test_file: frontend/src/components/__tests__/ReviewQueueView.test.tsx
      type: component
    - behavior: Mouse click on Reject dismisses the onboarding card.
      test_file: frontend/src/components/__tests__/ReviewQueueView.test.tsx
      type: component
    - behavior: Keyboard y / n still dismiss the onboarding card through the consolidated path.
      test_file: frontend/src/components/__tests__/ReviewQueueView.test.tsx
      type: component
    - behavior: useReviewQueueKeyboard invokes onDecide?() after both y and n switch arms (group + single variants).
      test_file: frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts (create if absent)
      type: unit
    - behavior: PendingApprovalCard.onDecide is called exactly once per successful approve / reject (and not called if the prop is omitted).
      test_file: frontend/src/components/__tests__/PendingApprovalCard.test.tsx and frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx
      type: component
---
# Mouse-click approve/reject dismisses onboarding card; consolidate keyboard dismissal path

## Objective

TASK-551 AC3 says the onboarding card dismisses on "approving/rejecting any queue item." Today only the "Got it" click and the y/n keypress (handled by a duplicate window.keydown listener inside ReviewQueueView) dismiss it; mouse clicks on Approve/Reject buttons fire the mutation but leave the card visible until the next y/n. This task adds an `onDecide` callback to PendingApprovalCard (both variants) and to useReviewQueueKeyboard, and consolidates the dismissal path in ReviewQueueView so all three triggers (mouse approve, mouse reject, y/n key) flow through a single dismiss callback. The duplicate window.keydown listener in ReviewQueueView is removed (closing FIND-SPRINT-013-14).

## Implementation Steps

1. **Add `onDecide?: () => void` prop to PendingApprovalCard (root-level)** in `frontend/src/components/PendingApprovalCard.tsx`:
   - Add to `PendingApprovalCardProps`:
     ```ts
     /** Called once after a successful approve or reject mutation. Optional. */
     onDecide?: () => void;
     ```
   - Plumb it into the inner `handleApprove` / `handleReject` of both the single and group variants:
     ```ts
     function handleApprove(): void {
       setBusy(true);
       void trpc.cyboflow.approvals.approve.mutate({ approvalId: approval.id })
         .then(() => { onDecide?.(); })
         .finally(() => { setBusy(false); });
     }
     ```
   Same pattern for reject and for the group's `approveRestOfRun` + `Promise.all(reject)` paths. Wire `onDecide?.()` into the `.then()` (after-success) branch — NOT the `.finally()` — so dismissal does not fire on mutation error.

2. **Repeat for ReviewQueue/PendingApprovalCard** in `frontend/src/components/ReviewQueue/PendingApprovalCard.tsx`. Same prop addition, same plumbing into both the single and group `handleApprove` / `handleReject`. Do NOT add `onDecide?.()` to the `handleCancelAndRestart` flow — Cancel-and-restart is a separate flow that does not constitute "the user made a triage decision."

3. **Refactor useReviewQueueKeyboard** in `frontend/src/hooks/useReviewQueueKeyboard.ts`:
   - Update the signature:
     ```ts
     export function useReviewQueueKeyboard(
       queue: QueueItem[],
       onDecide?: () => void,
     ): { focusedIndex: number; setFocusedIndex: (i: number) => void }
     ```
   - Inside `handleKeyDown`, after the `case 'y':` and `case 'n':` mutation calls, add `onDecide?.();`. Mirror the existing approach in the .map: invoke the callback in the same tick as firing the mutations (not inside `.then()`) — the consolidation goal is symmetry with mouse-click dismissal, but unlike mouse paths the keyboard does not await success; firing immediately matches the existing dismissal behavior the user has today.
   - Keep `onDecide` out of the handler's `useEffect` dependency array — read it via a ref to avoid re-registering the global listener on every render:
     ```ts
     const onDecideRef = useRef(onDecide);
     useEffect(() => { onDecideRef.current = onDecide; }, [onDecide]);
     // inside handleKeyDown: onDecideRef.current?.();
     ```

4. **Consolidate ReviewQueueView dismissal** in `frontend/src/components/ReviewQueueView.tsx`:
   - Define a single dismissal callback near the top of the component:
     ```ts
     const handleDecide = useCallback(() => {
       if (onboardingDismissedRef.current) return;
       onboardingDismissedRef.current = true;
       setOnboardingDismissed(true);
       void dismissOnboarding();
     }, []);
     ```
     Import `useCallback`.
   - Pass `handleDecide` to the keyboard hook: `const { focusedIndex } = useReviewQueueKeyboard(allItems, handleDecide);`
   - Pass `handleDecide` to each `<PendingApprovalCard ... onDecide={handleDecide} />` (via QueueRow if TASK-622 introduced it).
   - **Delete** the entire `useEffect` block (lines 57–84 of the pre-task file) that registered the duplicate `window.addEventListener('keydown', handleKeyDown)` for y/n dismissal. That logic is now owned by useReviewQueueKeyboard.onDecide.
   - Keep the mount-time preference-read effect (lines 38–55 of the pre-task file) — that initializes `onboardingDismissedRef` from the persisted preference and must remain.

5. **Update ReviewQueueView.test.tsx mocks** to forward `onDecide` so the new dismissal tests work:
   - The PendingApprovalCard mock should accept `onDecide` and expose a button that calls it on click, e.g.:
     ```tsx
     vi.mock('../ReviewQueue/PendingApprovalCard', () => ({
       PendingApprovalCard: ({ item, onDecide }: { item: QueueItem; onDecide?: () => void }) => {
         const toolName = item.kind === 'single' ? item.approval.toolName : item.toolName;
         return (
           <div data-testid="pending-approval-card">
             {toolName}
             <button onClick={() => onDecide?.()}>Approve</button>
             <button onClick={() => onDecide?.()}>Reject</button>
           </div>
         );
       },
     }));
     ```
     This makes the dismissal test independent of real mutation behavior — clicking the mock's Approve fires the prop, and the parent should dismiss.
   - The useReviewQueueKeyboard mock should accept the `onDecide` second arg and expose a way to fire it (or test the consolidated path separately in a hook unit test — see step 6).

6. **Add or extend useReviewQueueKeyboard tests** in `frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts`:
   - Check if a test file exists (it may not — verify via `ls`). If absent, create it. If present, extend.
   - Add tests:
     - "y dispatches approve mutation AND calls onDecide once."
     - "n dispatches reject mutation AND calls onDecide once."
     - "y on an empty queue does not call onDecide."
     - "modifier-key combos (Cmd-y) do not call onDecide."
   - Use renderHook + window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y' })) plus a mocked tRPC client (same pattern as the existing PendingApprovalCard tests).

7. **Add new ReviewQueueView tests**:
   - Render with mock queue containing 1 item, `useReviewQueueSlice.setState({ runStatusMap: {} })` and onboarding preference unset. Assert `screen.getByRole('status')` (the OnboardingCard) is present. Click "Approve" inside the mocked card. Assert `screen.queryByRole('status')` is null after a `waitFor`.
   - Same for "Reject".
   - Same for keyboard `fireEvent.keyDown(window, { key: 'y' })` — though the keyboard hook is mocked in tests, you'll need to expose `onDecide` from the mock so the test can trigger it. Alternatively, replace the keyboard mock for this one test with a stub that fires onDecide on mount, then assert dismissal.

8. **Add per-card tests for `onDecide`** in both `frontend/src/components/__tests__/PendingApprovalCard.test.tsx` and `frontend/src/components/ReviewQueue/__tests__/PendingApprovalCard.test.tsx`:
   - "onDecide is called once after successful Approve mutation."
   - "onDecide is called once after successful Reject mutation."
   - "onDecide is not called when the prop is omitted (no errors thrown)."
   - "onDecide is NOT called when the mutation rejects" — use a mock that returns `Promise.reject(...)` and assert via `expect(onDecide).not.toHaveBeenCalled()` inside a `waitFor`.

9. **Run typecheck + targeted tests as completeness gate:**
   ```
   pnpm typecheck
   pnpm --filter cyboflow-frontend test -- --run frontend/src/components/__tests__ frontend/src/components/ReviewQueue/__tests__ frontend/src/hooks/__tests__
   ```

## Acceptance Criteria

- All criteria in the frontmatter list. The three new dismissal paths (mouse-Approve, mouse-Reject, consolidated keyboard) work and the duplicate window.keydown listener is gone.

## Test Strategy

Five behavior groups: per-card `onDecide` invocation (4 cases × 2 card files), keyboard-hook `onDecide` invocation (4 cases in a new or extended test file), and ReviewQueueView end-to-end dismissal on mouse + keyboard (3 cases). Mutation rejection handling is explicitly tested to ensure the user doesn't lose the onboarding card after a failed approve they didn't mean to fire.

## Hardest Decision

Whether `onDecide` should fire synchronously on click (matching the keyboard path's existing fire-and-forget) or after the mutation resolves successfully (`.then()` rather than the click handler body). Chose `.then()` for mouse paths because (a) the user has explicitly committed via a click and seeing the card disappear *after* the mutation succeeds reinforces the cause-and-effect, (b) we get free error-path protection — a failed mutation leaves the card visible, which is more discoverable than silently dropping it. The keyboard path stays synchronous to preserve the existing UX (the dismissal is intentionally racy with the mutation today, matching the j/k fluidity expectation). Documented in the JSDoc on `onDecide`.

## Rejected Alternatives

- **Fire onDecide unconditionally in `.finally()` so error paths also dismiss.** Rejected — losing the onboarding card after a misclick that errored hurts user trust more than the inconsistency saves.
- **Move dismissal logic into PendingApprovalCard itself by passing `dismissOnboarding` as a prop.** Rejected: cards shouldn't know about onboarding state. The callback pattern keeps the responsibility in the view.
- **Make useReviewQueueKeyboard accept an options object `{ onDecide }` instead of a positional second arg.** Stylistically nicer but would force changes at every existing call site. Positional is one call site (ReviewQueueView) — keep it.

## Lowest Confidence Area

The interaction between the new test for "keyboard y dismisses onboarding" and the existing useReviewQueueKeyboard mock in ReviewQueueView.test.tsx. Two test files exercise overlapping paths and the mock currently returns `{ focusedIndex: 0, setFocusedIndex: vi.fn() }` without honoring the new `onDecide` arg. A simple fix is to update the mock to capture the `onDecide` arg and expose it on a test handle (`(useReviewQueueKeyboard as any).__lastOnDecide` or similar). Verify the test exposes it cleanly; if it feels brittle, drop the keyboard-driven test from ReviewQueueView's file and rely on the unit test in useReviewQueueKeyboard.test.ts plus the mouse-driven dismissal tests for full coverage of the dismissal paths.
