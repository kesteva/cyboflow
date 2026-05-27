---
id: TASK-792
idea: IDEA-028
status: ready
created: 2026-05-27T18:00:00.000Z
files_owned:
  - frontend/src/components/cyboflow/CyboflowRoot.tsx
  - frontend/src/components/cyboflow/SessionLifecycleActionBar.tsx
  - frontend/src/components/cyboflow/SessionActionToast.tsx
  - frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
files_readonly:
  - frontend/src/stores/cyboflowStore.ts
  - frontend/src/stores/sessionStore.ts
  - frontend/src/types/session.ts
  - frontend/src/utils/cn.ts
acceptance_criteria:
  - criterion: "SessionLifecycleActionBar.tsx and SessionActionToast.tsx exist as new files"
    verification: "test -f frontend/src/components/cyboflow/SessionLifecycleActionBar.tsx && test -f frontend/src/components/cyboflow/SessionActionToast.tsx"
  - criterion: "CyboflowRoot imports and renders SessionLifecycleActionBar inside the header row div"
    verification: "grep -n 'SessionLifecycleActionBar' frontend/src/components/cyboflow/CyboflowRoot.tsx returns at least one import line and one JSX usage line"
  - criterion: "SessionLifecycleActionBar renders three buttons with data-testid attributes: session-action-merge, session-action-create-pr, session-action-dismiss"
    verification: "grep -n 'data-testid=\"session-action-merge\"' frontend/src/components/cyboflow/SessionLifecycleActionBar.tsx && grep -n 'data-testid=\"session-action-create-pr\"' frontend/src/components/cyboflow/SessionLifecycleActionBar.tsx && grep -n 'data-testid=\"session-action-dismiss\"' frontend/src/components/cyboflow/SessionLifecycleActionBar.tsx"
  - criterion: "Merge and Create PR buttons are disabled when the active session has status 'running'; Dismiss button is always enabled"
    verification: "grep -n 'disabled' frontend/src/components/cyboflow/SessionLifecycleActionBar.tsx shows disabled logic on merge and create-pr buttons but not on dismiss"
  - criterion: "The action bar is only rendered when activeQuickSessionId is non-null and the resolved session is not isMainRepo"
    verification: "grep -n 'activeQuickSessionId' frontend/src/components/cyboflow/SessionLifecycleActionBar.tsx shows a null check, and grep -n 'isMainRepo' returns a guard condition"
  - criterion: "SessionActionToast renders a message and auto-dismisses after a timeout"
    verification: "grep -n 'setTimeout' frontend/src/components/cyboflow/SessionActionToast.tsx returns at least one match"
  - criterion: "All existing tests plus new action-bar tests pass"
    verification: "pnpm --filter frontend test run"
depends_on: []
estimated_complexity: medium
epic: session-lifecycle-actions
test_strategy:
  needed: true
  justification: "CyboflowRoot.test.tsx already exists and covers the header row rendering. Adding a new component to the header row requires updating these tests. The new SessionLifecycleActionBar component also warrants its own unit tests for button enable/disable logic."
  targets:
    - behavior: "Action bar renders in CyboflowRoot header when an active quick session exists"
      test_file: "frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx"
      type: component
    - behavior: "Action bar does NOT render when no active quick session exists or when the session is the main repo session"
      test_file: "frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx"
      type: component
    - behavior: "Merge and Create PR buttons are disabled when session status is 'running'; Dismiss is always enabled"
      test_file: "frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx"
      type: component
    - behavior: "SessionActionToast auto-dismisses after timeout"
      test_file: "frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx"
      type: component
---

# Add SessionLifecycleActionBar shell to CyboflowRoot header

## Objective

Create the `SessionLifecycleActionBar` and `SessionActionToast` components and inject the action bar into the CyboflowRoot header row. The bar shows Merge, Create PR, and Dismiss buttons when a non-main-repo quick session is active. Merge and Create PR are disabled during a running session. All three buttons accept callback props that are stubs in this task — TASK-793, TASK-794, and TASK-795 will wire the real implementations.

## Implementation Steps

1. **Create `frontend/src/components/cyboflow/SessionActionToast.tsx`** — minimal auto-dismiss toast component:
   - Props: `message: string`, `isVisible: boolean`, `onDismiss: () => void`, `durationMs?: number` (default 3000)
   - Uses `useEffect` with `setTimeout` to call `onDismiss` after timeout
   - Returns `null` when not visible
   - Tailwind: `bg-green-600 text-white rounded px-4 py-2 text-sm font-medium shadow-lg`
   - `data-testid="session-action-toast"`

2. **Create `frontend/src/components/cyboflow/SessionLifecycleActionBar.tsx`** — shell with three action buttons:
   - Props: `onMerge?: () => void`, `onCreatePR?: () => void`, `onDismiss?: () => void`
   - Reads `activeQuickSessionId` from `useCyboflowStore` and resolves session from `useSessionStore`
   - Returns `null` if no active session or `isMainRepo === true`
   - Derives `isRunning` from session status
   - Renders three buttons with `data-testid` attributes
   - Merge and Create PR: `disabled={isRunning}`, Dismiss: never disabled
   - Visual separator before the action bar

3. **Modify `frontend/src/components/cyboflow/CyboflowRoot.tsx`** — inject `SessionLifecycleActionBar` in the header row after the Quick Session button, with a flex spacer to push it right.

4. **Update `frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx`** — add tests for action bar render/hide logic and button disable states.

## Acceptance Criteria

1. `SessionLifecycleActionBar.tsx` and `SessionActionToast.tsx` exist as new files
2. CyboflowRoot renders `SessionLifecycleActionBar` in the header row
3. Three buttons with correct `data-testid` attributes
4. Merge/Create PR disabled when running; Dismiss always enabled
5. Action bar self-hides when no eligible session active
6. Toast auto-dismisses after configured timeout
7. All tests pass
