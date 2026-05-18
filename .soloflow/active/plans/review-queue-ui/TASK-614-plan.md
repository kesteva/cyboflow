---
id: TASK-614
idea: IDEA-009
status: in-flight
created: "2026-05-15T00:00:00Z"
files_owned:
  - frontend/src/hooks/useReviewQueueKeyboard.ts
  - frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts
files_readonly:
  - frontend/src/components/ReviewQueueView.tsx
  - frontend/src/App.tsx
  - frontend/src/components/PendingApprovalCard.tsx
acceptance_criteria:
  - criterion: The keyboard handler returns early when document.activeElement is not document.body and not null.
    verification: "grep -n 'document.activeElement' frontend/src/hooks/useReviewQueueKeyboard.ts shows a guard at the top of handleKeyDown that returns when activeElement is neither document.body nor null."
  - criterion: "Existing input-element guards (HTMLInputElement, HTMLTextAreaElement, contentEditable) continue to short-circuit unchanged."
    verification: "grep -n 'HTMLInputElement\\|HTMLTextAreaElement\\|isContentEditable' frontend/src/hooks/useReviewQueueKeyboard.ts still matches three lines."
  - criterion: "When document.activeElement === document.body, j/k/y/n still fire normally."
    verification: "Vitest case sets body as activeElement, presses j, asserts focusedIndex advances to 1."
  - criterion: "When a Radix-style focused element (a <div tabIndex={0}> outside any input) has focus, j/k/y/n are no-ops."
    verification: "Vitest case creates <div tabIndex={0}>, focuses it, fires keydown {key: 'y'}, asserts no mutation called."
  - criterion: "The hook's tRPC mock path matches the actual import path."
    verification: "grep -n \"vi.mock('../../utils/trpcClient'\" frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts returns the mock declaration."
depends_on:
  - TASK-612
estimated_complexity: low
epic: review-queue-ui
test_strategy:
  needed: true
  justification: New control-flow branch (focus-guard short-circuit). Positive + negative cases prove the guard is neither too tight nor too loose.
  targets:
    - behavior: "j is a no-op when an unrelated focusable <div> has focus (Radix focus-trap simulation)"
      test_file: frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts
      type: unit
    - behavior: y is a no-op when an unrelated focusable element has focus (no mutation fires)
      test_file: frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts
      type: unit
    - behavior: j still fires when document.activeElement === document.body (default state)
      test_file: frontend/src/hooks/__tests__/useReviewQueueKeyboard.test.ts
      type: unit
---
# Tighten global keyboard shortcut scoping in useReviewQueueKeyboard

## Objective

`ReviewQueueView` is always-mounted (App.tsx). The hook's window-level keydown listener fires app-wide regardless of which panel the user is looking at. Add a top-level guard: `if (document.activeElement !== document.body && document.activeElement !== null) return;` This forces j/k/y/n to fire only when the user has clicked away from any focused element.

## Implementation Steps

1. In `frontend/src/hooks/useReviewQueueKeyboard.ts`, inside `handleKeyDown`, AFTER the modifier-key guard and BEFORE the existing input-instanceof guards, insert the focus guard:
   ```ts
   if (document.activeElement !== document.body && document.activeElement !== null) return;
   ```
2. Update the JSDoc to note the focus-guard contract.
3. Add a new `describe('useReviewQueueKeyboard — focus guard for non-input focusable elements')` block with three cases per the test_strategy targets.
4. Run `pnpm --filter frontend test` and `pnpm typecheck`.

## Acceptance Criteria

All five criteria above.

## Test Strategy

Three new cases under a new describe block. Positive (body-focused → fires) + negative (non-input element focused → no-op) prove the guard's correctness.
