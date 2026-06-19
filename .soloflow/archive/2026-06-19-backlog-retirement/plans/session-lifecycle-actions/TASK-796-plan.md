---
id: TASK-796
idea: IDEA-028
status: ready
created: 2026-05-28T00:00:00Z
source: compound-B1-SPRINT-043
files_owned:
  - frontend/src/components/cyboflow/CyboflowRoot.tsx
  - frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
files_readonly:
  - frontend/src/components/cyboflow/SessionLifecycleActionBar.tsx
  - frontend/src/components/cyboflow/SessionMergeDialog.tsx
  - frontend/src/components/cyboflow/SessionCreatePrDialog.tsx
  - frontend/src/components/cyboflow/SessionDismissDialog.tsx
  - frontend/src/components/cyboflow/SessionActionToast.tsx
  - frontend/src/stores/cyboflowStore.ts
  - frontend/src/stores/sessionStore.ts
acceptance_criteria:
  - criterion: "CyboflowRoot imports and renders SessionMergeDialog, SessionCreatePrDialog, SessionDismissDialog, and SessionActionToast"
    verification: "grep -n 'SessionMergeDialog\\|SessionCreatePrDialog\\|SessionDismissDialog\\|SessionActionToast' frontend/src/components/cyboflow/CyboflowRoot.tsx returns import and JSX usage lines for all four"
  - criterion: "SessionLifecycleActionBar receives onMerge, onCreatePR, and onDismiss callbacks that open the corresponding dialogs"
    verification: "grep -n 'onMerge=\\|onCreatePR=\\|onDismiss=' frontend/src/components/cyboflow/CyboflowRoot.tsx returns matches for all three"
  - criterion: "Each dialog receives sessionId derived from activeQuickSessionId"
    verification: "grep -n 'activeQuickSessionId' frontend/src/components/cyboflow/CyboflowRoot.tsx shows it is read from cyboflowStore and passed to dialogs"
  - criterion: "SessionActionToast renders success messages after merge/PR/dismiss actions"
    verification: "grep -n 'SessionActionToast' frontend/src/components/cyboflow/CyboflowRoot.tsx returns JSX usage"
  - criterion: "pnpm test:unit exits 0"
    verification: "pnpm test:unit"
depends_on: [TASK-792, TASK-793, TASK-794, TASK-795]
estimated_complexity: small
epic: session-lifecycle-actions
test_strategy:
  needed: true
  justification: "Wiring integration changes CyboflowRoot behavior — needs tests for dialog open/close cycles."
  targets:
    - behavior: "Clicking Merge button opens SessionMergeDialog"
      test_file: frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
      type: component
    - behavior: "Clicking Create PR button opens SessionCreatePrDialog"
      test_file: frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
      type: component
    - behavior: "Clicking Dismiss button opens SessionDismissDialog"
      test_file: frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
      type: component
---

# Wire session lifecycle dialogs to CyboflowRoot action bar callbacks

## Objective

Connect the three session lifecycle dialogs (TASK-793..795) to the action bar shell (TASK-792) by importing them into CyboflowRoot, managing isOpen state for each, and passing open-dialog callbacks to SessionLifecycleActionBar. This is the missing integration glue that makes the entire session lifecycle flow functional end-to-end.

## Implementation Steps

1. Import SessionMergeDialog, SessionCreatePrDialog, SessionDismissDialog, and SessionActionToast into CyboflowRoot.
2. Add three isOpen boolean state variables and a toastMessage string state.
3. Read activeQuickSessionId from useCyboflowStore — pass to each dialog as sessionId.
4. Pass open-dialog callbacks to SessionLifecycleActionBar (onMerge, onCreatePR, onDismiss).
5. Render each dialog conditionally with isOpen, onClose, sessionId, and onSuccess (sets toast message).
6. Render SessionActionToast with isVisible + onDismiss.
7. Add CyboflowRoot.test.tsx tests for dialog open/close cycles.
