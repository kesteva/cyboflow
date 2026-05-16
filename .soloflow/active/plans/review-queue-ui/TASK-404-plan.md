---
id: TASK-404
idea: IDEA-009
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - frontend/src/hooks/useReviewQueueKeyboard.ts
  - frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts
  - frontend/src/components/ReviewQueueView.tsx
  - frontend/src/components/PendingApprovalCard.tsx
files_readonly:
  - frontend/src/stores/reviewQueueStore.ts
  - frontend/src/trpc/client.ts
  - shared/types/approvals.ts
  - .soloflow/active/research/ROADMAP-001-research-user-needs.md
acceptance_criteria:
  - criterion: "`useReviewQueueKeyboard` hook listens for j, k, y, n keydown events globally (window-level) when the review queue rail is visible"
    verification: "grep -n 'keydown\\|addEventListener' frontend/src/hooks/useReviewQueueKeyboard.ts returns matches; grep -n \"'j'\\|'k'\\|'y'\\|'n'\" frontend/src/hooks/useReviewQueueKeyboard.ts returns all four key handlers"
  - criterion: "j moves focus to next approval, k moves to previous; wraps at ends (j on last item = no-op or first; k on first = no-op or last — choose no-op for v1)"
    verification: "Unit test verifies focusedIndex transitions: from 0 with j → 1; from 0 with k → 0 (no-op); from N-1 with j → N-1 (no-op)"
  - criterion: y triggers approve mutation for currently focused approval; n triggers reject mutation
    verification: "Unit test asserts trpc.cyboflow.approvals.approve.mutate called with focused approval id on 'y'; .reject.mutate on 'n'"
  - criterion: ReviewQueueView consumes the hook and uses focusedIndex to apply a visible focus ring to the matching PendingApprovalCard
    verification: "grep -n 'focusedIndex\\|useReviewQueueKeyboard' frontend/src/components/ReviewQueueView.tsx returns matches; the rendered card at focusedIndex receives a className with 'ring-2' or equivalent visible-focus utility"
  - criterion: "Keyboard handlers ignore events when focus is inside an input/textarea/contenteditable (e.g., a search field elsewhere in the app)"
    verification: "grep -n 'INPUT\\|TEXTAREA\\|contentEditable\\|isContentEditable' frontend/src/hooks/useReviewQueueKeyboard.ts returns a guard check"
  - criterion: "When the queue is empty, j/k/y/n are no-ops (do not throw)"
    verification: "Unit test: focusedIndex on empty queue with j → no error, no state change"
  - criterion: Focus indicator scrolls into view if the focused card is outside the visible scroll area
    verification: "grep -n 'scrollIntoView' frontend/src/components/ReviewQueueView.tsx returns a match inside the focus-change effect"
depends_on:
  - TASK-401
  - TASK-402
  - TASK-403
estimated_complexity: medium
epic: review-queue-ui
test_strategy:
  needed: true
  justification: "Keyboard handling has multiple branches (each key, input-element guard, empty-queue edge case) and integrates with the store — explicit hook tests are the cheapest regression guard"
  targets:
    - behavior: j/k navigate focusedIndex with end-clamping
      test_file: frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts
      type: unit
    - behavior: y and n invoke approve/reject mutations on the focused approval
      test_file: frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts
      type: unit
    - behavior: Keys are ignored while focus is in an input field
      test_file: frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts
      type: unit
    - behavior: "Empty queue: keys are no-ops"
      test_file: frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts
      type: unit
---
# Keyboard Navigation: j/k/y/n + Visible Focus

## Objective

Implement Vim/Superhuman-style keyboard triage for the review queue: `j`/`k` to move between approvals, `y`/`n` to approve/reject the currently focused one. Targets IDEA-009 slice 3's stated UX goal: 60-second clear of a 15-item queue. This is the affordance that makes the 93%-rote-approval flow effortless (user-needs research §4). The focused card gets a visible ring; the focus auto-scrolls into view on j/k. Input-element guards prevent shortcuts firing while the user types in a search box elsewhere in the app.

## Implementation Steps

1. Create `frontend/src/hooks/useReviewQueueKeyboard.ts`:
   - Hook signature: `useReviewQueueKeyboard(queue: Approval[]): { focusedIndex: number; setFocusedIndex: (i: number) => void }`.
   - Internal state: `const [focusedIndex, setFocusedIndex] = useState(0)`.
   - Clamp focusedIndex when queue changes: `useEffect(() => { if (focusedIndex >= queue.length) setFocusedIndex(Math.max(0, queue.length - 1)); }, [queue.length])`.
   - Single global `keydown` listener registered on `window` in a `useEffect`, cleaned up on unmount.
   - Inside handler: early return if `event.target` is `HTMLInputElement | HTMLTextAreaElement | isContentEditable` — check via `instanceof` or `tagName === 'INPUT' || tagName === 'TEXTAREA'`.
   - Early return if `queue.length === 0`.
   - Key map:
     - `'j'`: `setFocusedIndex(i => Math.min(queue.length - 1, i + 1))`; `event.preventDefault()`.
     - `'k'`: `setFocusedIndex(i => Math.max(0, i - 1))`; `event.preventDefault()`.
     - `'y'`: `trpc.cyboflow.approvals.approve.mutate({ approvalId: queue[focusedIndex].id })`; `event.preventDefault()`.
     - `'n'`: `trpc.cyboflow.approvals.reject.mutate({ approvalId: queue[focusedIndex].id })`; `event.preventDefault()`.
   - Ignore if `event.metaKey || event.ctrlKey || event.altKey` (don't intercept Cmd-K, etc.).
2. Modify `frontend/src/components/ReviewQueueView.tsx`:
   - Call `const { focusedIndex } = useReviewQueueKeyboard(queue);`.
   - Pass `isFocused={i === focusedIndex}` to each `<PendingApprovalCard />`.
   - Add a scroll-into-view effect: `useEffect(() => { document.querySelector(`[data-approval-id="${queue[focusedIndex]?.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [focusedIndex])`.
3. Modify `frontend/src/components/PendingApprovalCard.tsx`:
   - Accept optional `isFocused?: boolean` prop.
   - When `isFocused`, add `ring-2 ring-accent-primary` (or codebase's equivalent visible-focus utility) to the outer container.
4. Write unit tests in `frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts` using React Testing Library's `renderHook` + `fireEvent.keyDown(window, { key: 'j' })`:
   - Setup with 3-item queue, focusedIndex starts 0; press j → focusedIndex 1; press j → 2; press j → still 2 (clamp).
   - Press k from 0 → still 0 (clamp).
   - Press y → assert mocked trpc.approve called with `{ approvalId: queue[focusedIndex].id }`.
   - Press n → mocked reject called.
   - Focus an `<input>` in the test DOM, press j → focusedIndex unchanged.
   - Empty queue, press y → no throw, no mutation call.

## Acceptance Criteria

All seven criteria above.

## Test Strategy

Four unit tests covering each branch. Mock the tRPC client at module level (the hook imports `trpc` from `frontend/src/trpc/client.ts`).

## Hardest Decision

**Where to mount the keyboard listener: window-global or rail-scoped.** Window-global wins because: (a) users will be in the main editor/session view 95% of the time; requiring focus inside the rail would force a click-into before each triage pass, defeating the keyboard-first goal; (b) the input-element guard handles the "typing somewhere" case correctly. The risk is collision with other app shortcuts — mitigated by ignoring meta/ctrl/alt and by the fact that `j`, `k`, `y`, `n` are bare letters not used elsewhere (verified by grep of existing keydown handlers).

## Rejected Alternatives

- **Rail-scoped focus via `tabIndex={0}` on the container.** Forces an extra click before keyboard triage; kills the flow.
- **Arrow keys instead of j/k.** Arrow keys are commonly captured by browsers for scrolling and by code editors. j/k is the Vim/Superhuman idiom users in this audience expect (user-needs research §4 cites Superhuman as the reference).
- **Hjkl with h/l doing something.** Out of scope for v1; future could add `h` to collapse a group and `l` to expand.

What would change my mind: if a self-host user reports collision with another shortcut (e.g., a Crystal handler we missed), make the keyboard listener rail-scoped behind a single-letter activator like `/` to enter "queue mode."

## Lowest Confidence Area

The interaction between this hook and the future grouped/collapsed cards from TASK-405. When a card represents a group of N repeated approvals, does `y` approve the whole group or just one? Plan: `y` approves the whole group (each PendingApprovalCard knows whether it's grouped and its onApprove callback handles the multi-approve case). TASK-405 owns this decision; TASK-404 wires the hook to invoke a card-level `onApprove` callback that TASK-405 will refine. To keep this task self-contained, the hook calls the mutation directly with the focused card's `approval.id` — TASK-405 will switch this to a callback if needed. If TASK-405 changes the contract, that task owns the refactor.
