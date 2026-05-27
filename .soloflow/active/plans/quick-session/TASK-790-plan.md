---
id: TASK-790
idea: IDEA-027
status: done
created: "2026-05-27T20:00:00Z"
files_owned:
  - frontend/src/components/cyboflow/CyboflowRoot.tsx
  - frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
  - CyboflowRoot.tsx
files_readonly:
  - frontend/src/stores/cyboflowStore.ts
  - frontend/src/components/cyboflow/RunBottomPane.tsx
  - frontend/src/hooks/useQuickSession.ts
  - frontend/src/hooks/usePanelSurface.ts
  - frontend/src/hooks/useAddQuickSessionShortcut.ts
acceptance_criteria:
  - criterion: "When activeRunId is null and mainRepoSession is non-null, RunBottomPane renders (not empty-state CTA)"
    verification: "CyboflowRoot.test.tsx test with session mock asserts RunBottomPane present and 'Choose a workflow' absent"
  - criterion: "When both activeRunId and mainRepoSession are null, empty-state CTA still renders"
    verification: Existing empty-state test continues to pass
  - criterion: "Mode-picker dropdown removed (no isQuickModePickerOpen, quick-mode-chat, quick-mode-terminal)"
    verification: "grep -rn 'isQuickModePickerOpen\\|quick-mode-chat\\|quick-mode-terminal' CyboflowRoot.tsx returns 0"
  - criterion: Quick Session button calls start() directly
    verification: CyboflowRoot.test.tsx test clicking start-quick-session calls createQuick
  - criterion: activeQuickSessionId render branch removed
    verification: "grep -n 'activeQuickSessionId\\|qsPanels\\|qsActivePanel' CyboflowRoot.tsx returns 0"
  - criterion: Tests pass
    verification: pnpm --filter frontend test -- --run CyboflowRoot exits 0
depends_on:
  - TASK-789
estimated_complexity: high
epic: quick-session
test_strategy:
  needed: true
  justification: CyboflowRoot.test.tsx (451 lines) must be substantially rewritten for new render branches.
  targets:
    - behavior: "Session-alive: RunBottomPane renders when activeRunId null but mainRepoSession non-null"
      test_file: frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
      type: component
    - behavior: Quick Session button directly invokes start() without picker
      test_file: frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
      type: component
    - behavior: Empty state still renders when no session
      test_file: frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
      type: component
    - behavior: Quick Session disabled when projectId null
      test_file: frontend/src/components/cyboflow/__tests__/CyboflowRoot.test.tsx
      type: component
---
# Keep session panels alive after run completion in CyboflowRoot

## Objective

Restructure CyboflowRoot so the main content area shows RunBottomPane whenever a session is open (even without an active run). Remove mode-picker dropdown. Remove the activeQuickSessionId render branch.

## Implementation Steps

1. Remove quick-session panel surface state/effects (qsPanels, qsActivePanel, quickSession_session, related useEffects).
2. Remove mode-picker state/UI (isQuickModePickerOpen, quickPickerRef, handleOpenQuickPicker, escape/click-outside effect).
3. Replace Quick Session button with direct start() call.
4. Restructure render: activeRunId ? Canvas+RunBottomPane : mainRepoSession ? RunBottomPane : empty-state.
5. Clean up unused imports.
6. Update tests: remove mode-picker tests, add session-alive and direct-start tests.

## Acceptance Criteria

See frontmatter.
