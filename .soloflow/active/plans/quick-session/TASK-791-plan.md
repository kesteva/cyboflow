---
id: TASK-791
idea: IDEA-027
status: ready
created: "2026-05-27T17:00:00Z"
files_owned:
  - frontend/src/hooks/useQuickSession.ts
  - frontend/src/hooks/__tests__/useQuickSession.test.tsx
  - frontend/src/components/cyboflow/WorkflowPicker.tsx
  - frontend/src/components/cyboflow/__tests__/WorkflowPicker.test.tsx
  - WorkflowPicker.tsx
files_readonly:
  - frontend/src/stores/cyboflowStore.ts
  - frontend/src/services/panelApi.ts
  - frontend/src/utils/api.ts
acceptance_criteria:
  - criterion: start() takes no arguments
    verification: "grep 'start(' frontend/src/hooks/useQuickSession.ts shows start(): Promise<void>"
  - criterion: "isStarting is boolean, not string union"
    verification: "grep 'isStarting' shows useState<boolean>"
  - criterion: createQuick call sends no permissionMode or toolType
    verification: "grep -c 'permissionMode\\|toolType' frontend/src/hooks/useQuickSession.ts returns 0"
  - criterion: start() always creates both Claude panel (first) and Terminal panel
    verification: "grep -c 'panelApi.createPanel' frontend/src/hooks/useQuickSession.ts returns 2"
  - criterion: WorkflowPicker has single Quick Session button
    verification: "grep -c 'quick-session-button' WorkflowPicker.tsx returns 1 AND grep -c 'quick-chat-button\\|quick-terminal-button' returns 0"
  - criterion: All tests pass
    verification: pnpm --filter frontend test -- --run useQuickSession WorkflowPicker exits 0
depends_on:
  - TASK-788
  - TASK-789
estimated_complexity: low
epic: quick-session
test_strategy:
  needed: true
  justification: Both test files exercise the exact interfaces being changed.
  targets:
    - behavior: start() with no args calls createQuick without toolType or permissionMode
      test_file: frontend/src/hooks/__tests__/useQuickSession.test.tsx
      type: unit
    - behavior: "start() creates Claude panel first, then Terminal panel"
      test_file: frontend/src/hooks/__tests__/useQuickSession.test.tsx
      type: unit
    - behavior: "isStarting is true while in-flight, false after"
      test_file: frontend/src/hooks/__tests__/useQuickSession.test.tsx
      type: unit
    - behavior: WorkflowPicker renders single Quick Session button
      test_file: frontend/src/components/cyboflow/__tests__/WorkflowPicker.test.tsx
      type: component
---
# Remove toolType param from useQuickSession and always create both panels

## Objective

Refactor useQuickSession to remove toolType, always create both Claude + Terminal panels, remove permissionMode:'ignore' hardcode, and simplify WorkflowPicker to a single Quick Session button.

## Implementation Steps

1. Change start(toolType) to start() with no args. Change isStarting to boolean.
2. Remove toolType and permissionMode from createQuick call.
3. Always create both panels: Claude first (default active), then Terminal with cwd=worktreePath.
4. WorkflowPicker: replace Quick Chat/Quick Terminal buttons with single Quick Session button.
5. Update both test files.

## Acceptance Criteria

See frontmatter.
