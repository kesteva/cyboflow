---
id: TASK-795
idea: IDEA-028
status: done
created: 2026-05-27T12:00:00Z
files_owned:
  - frontend/src/components/cyboflow/SessionDismissDialog.tsx
  - frontend/src/components/cyboflow/__tests__/SessionDismissDialog.test.tsx
files_readonly:
  - frontend/src/components/cyboflow/SessionLifecycleActionBar.tsx
  - frontend/src/components/ConfirmDialog.tsx
  - frontend/src/utils/api.ts
  - frontend/src/types/electron.d.ts
acceptance_criteria:
  - criterion: "SessionDismissDialog.tsx exists and exports a named SessionDismissDialog component"
    verification: "grep -n 'export function SessionDismissDialog' frontend/src/components/cyboflow/SessionDismissDialog.tsx returns 1 match"
  - criterion: "The dialog wraps ConfirmDialog with destructive styling — title 'Dismiss session?', red confirm button, AlertTriangle icon"
    verification: "grep -n 'Dismiss session' frontend/src/components/cyboflow/SessionDismissDialog.tsx returns at least 1 match; grep -n 'bg-red' frontend/src/components/cyboflow/SessionDismissDialog.tsx returns at least 1 match"
  - criterion: "The dialog message warns explicitly about unmerged changes being lost and the worktree being removed"
    verification: "grep -n 'unmerged' frontend/src/components/cyboflow/SessionDismissDialog.tsx returns at least 1 match"
  - criterion: "On confirm, calls API.sessions.delete with the provided sessionId"
    verification: "grep -n 'API.sessions.delete' frontend/src/components/cyboflow/SessionDismissDialog.tsx returns 1 match"
  - criterion: "The component accepts props isOpen, onClose, and sessionId"
    verification: "grep -n 'interface SessionDismissDialogProps' frontend/src/components/cyboflow/SessionDismissDialog.tsx returns 1 match"
  - criterion: "Unit tests pass for SessionDismissDialog"
    verification: "pnpm --filter frontend test -- --run SessionDismissDialog exits 0"
depends_on: [TASK-792]
estimated_complexity: low
epic: session-lifecycle-actions
test_strategy:
  needed: true
  justification: "New component with dialog interaction and API call on confirm — warrants unit tests."
  targets:
    - behavior: "Renders nothing when isOpen is false"
      test_file: "frontend/src/components/cyboflow/__tests__/SessionDismissDialog.test.tsx"
      type: component
    - behavior: "Renders ConfirmDialog with correct title, message, and destructive confirm button when isOpen is true"
      test_file: "frontend/src/components/cyboflow/__tests__/SessionDismissDialog.test.tsx"
      type: component
    - behavior: "Clicking confirm calls API.sessions.delete with the sessionId and then calls onClose"
      test_file: "frontend/src/components/cyboflow/__tests__/SessionDismissDialog.test.tsx"
      type: component
    - behavior: "Clicking cancel calls onClose without calling API.sessions.delete"
      test_file: "frontend/src/components/cyboflow/__tests__/SessionDismissDialog.test.tsx"
      type: component
---

# Wire Dismiss action with ConfirmDialog

## Objective

Create `SessionDismissDialog.tsx`, a thin wrapper around the existing `ConfirmDialog` that shows a destructive-action warning about unmerged changes and on confirm calls `API.sessions.delete`. Designed to plug into the Dismiss slot of `SessionLifecycleActionBar` from TASK-792.

## Implementation Steps

1. **Create `frontend/src/components/cyboflow/SessionDismissDialog.tsx`** with:
   - Props: `isOpen`, `onClose`, `sessionId`
   - Wraps `ConfirmDialog` with:
     - `title="Dismiss session?"`
     - `message="Any unmerged changes in this session will be lost. The worktree will be permanently removed and the session archived. This cannot be undone."`
     - `confirmText="Dismiss"`, `cancelText="Cancel"`
     - `confirmButtonClass="bg-red-600 hover:bg-red-700 text-white"`
     - `icon={<AlertTriangle className="w-6 h-6 text-red-500" />}`
   - `handleConfirm`: calls `API.sessions.delete(sessionId)` then `onClose()`

2. **Create `frontend/src/components/cyboflow/__tests__/SessionDismissDialog.test.tsx`** with 4 test cases covering render/hide, content, confirm flow, and cancel flow.

## Acceptance Criteria

1. SessionDismissDialog.tsx exists with correct ConfirmDialog wrapping
2. Destructive styling and warning message
3. On confirm: calls `API.sessions.delete` with sessionId
4. Props contract: `isOpen`, `onClose`, `sessionId`
5. All tests pass
