---
id: TASK-793
idea: IDEA-028
status: ready
created: 2026-05-27T12:00:00Z
files_owned:
  - frontend/src/components/cyboflow/SessionMergeDialog.tsx
  - frontend/src/components/cyboflow/__tests__/SessionMergeDialog.test.tsx
files_readonly:
  - frontend/src/components/cyboflow/SessionLifecycleActionBar.tsx
  - frontend/src/components/cyboflow/SessionActionToast.tsx
  - frontend/src/components/ErrorDialog.tsx
  - frontend/src/components/ui/Modal.tsx
  - frontend/src/components/ui/Button.tsx
  - frontend/src/components/ui/Textarea.tsx
  - frontend/src/components/CommitDialog.tsx
  - frontend/src/components/MainBranchWarningDialog.tsx
  - frontend/src/utils/api.ts
  - frontend/src/stores/errorStore.ts
  - frontend/src/types/session.ts
  - frontend/src/utils/cn.ts
acceptance_criteria:
  - criterion: "SessionMergeDialog.tsx exports a SessionMergeDialog component that accepts isOpen, onClose, and sessionId props"
    verification: "grep -n 'export.*SessionMergeDialog' frontend/src/components/cyboflow/SessionMergeDialog.tsx returns a match"
  - criterion: "The dialog presents two equal merge strategy options: squash merge and preserve commits"
    verification: "grep -n 'squash\\|preserve' frontend/src/components/cyboflow/SessionMergeDialog.tsx returns matches for both strategy labels"
  - criterion: "Selecting squash merge reveals a commit message textarea input that must be non-empty to confirm"
    verification: "grep -n 'commitMessage\\|Textarea\\|textarea' frontend/src/components/cyboflow/SessionMergeDialog.tsx returns matches"
  - criterion: "Selecting preserve commits does NOT require a commit message"
    verification: "Unit test verifies confirm button is enabled when preserve-commits is selected without entering a message"
  - criterion: "On confirm with squash strategy, calls API.sessions.squashAndRebaseToMain then API.sessions.delete on success"
    verification: "Unit test verifies the correct API call sequence for squash merge"
  - criterion: "On confirm with preserve strategy, calls API.sessions.rebaseToMain then API.sessions.delete on success"
    verification: "Unit test verifies the correct API call sequence for preserve-commits merge"
  - criterion: "On merge success, calls onSuccess callback and closes"
    verification: "Unit test verifies onSuccess callback is invoked after successful merge+delete"
  - criterion: "On merge failure, shows error via useErrorStore.showError and does NOT call API.sessions.delete"
    verification: "Unit test verifies showError is called and delete is NOT called when merge API returns success: false"
  - criterion: "The confirm button shows a loading state during the merge operation"
    verification: "Unit test verifies loading state is shown while merge is in progress"
  - criterion: "pnpm test:unit passes"
    verification: "Run pnpm test:unit and confirm exit code 0"
depends_on: [TASK-792]
estimated_complexity: medium
epic: session-lifecycle-actions
test_strategy:
  needed: true
  justification: "New component with branching merge logic, API call sequencing, error handling, and conditional UI — all require coverage."
  targets:
    - behavior: "Renders two strategy option cards as equal choices"
      test_file: frontend/src/components/cyboflow/__tests__/SessionMergeDialog.test.tsx
      type: component
    - behavior: "Squash option shows commit message textarea; preserve option does not"
      test_file: frontend/src/components/cyboflow/__tests__/SessionMergeDialog.test.tsx
      type: component
    - behavior: "Confirm disabled when squash selected but commit message is empty"
      test_file: frontend/src/components/cyboflow/__tests__/SessionMergeDialog.test.tsx
      type: component
    - behavior: "Confirm enabled when preserve-commits selected (no message needed)"
      test_file: frontend/src/components/cyboflow/__tests__/SessionMergeDialog.test.tsx
      type: component
    - behavior: "Squash confirm calls squashAndRebaseToMain then delete then onSuccess"
      test_file: frontend/src/components/cyboflow/__tests__/SessionMergeDialog.test.tsx
      type: component
    - behavior: "Preserve confirm calls rebaseToMain then delete then onSuccess"
      test_file: frontend/src/components/cyboflow/__tests__/SessionMergeDialog.test.tsx
      type: component
    - behavior: "Merge failure triggers useErrorStore.showError and skips delete"
      test_file: frontend/src/components/cyboflow/__tests__/SessionMergeDialog.test.tsx
      type: component
    - behavior: "Loading state shown on confirm button during merge"
      test_file: frontend/src/components/cyboflow/__tests__/SessionMergeDialog.test.tsx
      type: component
    - behavior: "Cmd/Ctrl+Enter keyboard shortcut triggers confirm when enabled"
      test_file: frontend/src/components/cyboflow/__tests__/SessionMergeDialog.test.tsx
      type: component
---

# Implement local Merge dialog (squash vs preserve-commits)

## Objective

Create `SessionMergeDialog.tsx` — a modal dialog that lets the user choose between squash merge (single commit with user-supplied message) and preserve-commits merge (all worktree commits replayed onto main). On confirm, calls the appropriate merge API, then `sessions:delete` for cleanup on success, and fires `onSuccess` for the toast. On failure, surfaces the error through `useErrorStore` and does NOT delete.

## Implementation Steps

1. **Create `frontend/src/components/cyboflow/SessionMergeDialog.tsx`** with:
   - Props: `isOpen`, `onClose`, `sessionId`, `onSuccess?: () => void`
   - State: `strategy: 'squash' | 'preserve' | null` (initially null, no pre-selection), `commitMessage: string`, `isMerging: boolean`
   - Two strategy option cards with equal visual weight, `data-testid="strategy-squash"` and `data-testid="strategy-preserve"`
   - Conditional commit message textarea when squash is selected
   - Confirm handler: calls `squashAndRebaseToMain(sessionId, commitMessage)` or `rebaseToMain(sessionId)`, then `delete(sessionId)` on success
   - Error handling via `useErrorStore.getState().showError()`
   - Loading state on confirm button
   - Reset state when dialog opens/closes
   - Cmd/Ctrl+Enter keyboard shortcut

2. **Create `frontend/src/components/cyboflow/__tests__/SessionMergeDialog.test.tsx`** with tests for all 9 behaviors in test_strategy.

## Acceptance Criteria

1. Two equal strategy options rendered as clickable cards
2. Commit message textarea shown for squash only
3. Confirm disabled when no strategy selected or squash with empty message
4. Correct API call sequence for both strategies
5. Error handling: showError on failure, no delete
6. Loading state during merge
7. All tests pass
