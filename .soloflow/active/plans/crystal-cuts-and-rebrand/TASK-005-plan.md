---
id: TASK-005
idea: IDEA-001
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - frontend/src/components/panels/PanelTabBar.tsx
  - frontend/src/components/SessionView.tsx
  - frontend/src/components/ProjectView.tsx
files_readonly:
  - frontend/src/services/panelApi.ts
  - frontend/src/stores/panelStore.ts
  - frontend/src/types/panelComponents.ts
  - frontend/src/hooks/useCliPanel.ts
  - main/src/ipc/panels.ts
  - main/src/services/panelManager.ts
  - shared/types/panels.ts
  - docs/cyboflow_system_design.md
acceptance_criteria:
  - criterion: "The 'Add Tool' dropdown button is removed from `PanelTabBar.tsx`"
    verification: "`grep -nE 'Add Tool|onPanelCreate|handleAddPanel' frontend/src/components/panels/PanelTabBar.tsx` returns zero matches"
  - criterion: "The `<PanelTabBar>` component no longer accepts an `onPanelCreate` prop"
    verification: "`grep -nE 'onPanelCreate' frontend/src/components/panels/PanelTabBar.tsx` returns zero matches and `grep -nE 'onPanelCreate' frontend/src/types/panelComponents.ts` (file read-only — verify by reading the interface, the field is removed by this task if it was in the interface) returns zero matches"
  - criterion: "Callers in `SessionView.tsx` and `ProjectView.tsx` no longer pass `onPanelCreate` to `<PanelTabBar>`"
    verification: "`grep -nE 'onPanelCreate' frontend/src/components/SessionView.tsx frontend/src/components/ProjectView.tsx` returns zero matches"
  - criterion: "The `panels:create` IPC handler remains wired in `main/src/ipc/panels.ts` (NOT deleted — only the UI surface is gone)"
    verification: "`grep -n \"'panels:create'\" main/src/ipc/panels.ts` returns at least 1 match"
  - criterion: "`panelManager` service in main process is untouched"
    verification: "`test -f main/src/services/panelManager.ts` returns exit 0; file size matches pre-task"
  - criterion: "Build and typecheck succeed: `pnpm run build:frontend && pnpm typecheck` exit 0"
    verification: Run both commands from repo root
depends_on: []
estimated_complexity: low
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: false
  justification: "Pure UI surface removal. The data model (`tool_panels` table, `panelManager` service, `panels:create` IPC) is intentionally preserved so existing sessions with multiple panels still render. No new behavior is introduced. The build/typecheck gate catches type errors from the removed prop. A manual smoke test confirms no 'Add Tool' button is visible."
---
# Delete Multi-Panel-Per-Session UI Surfaces

## Objective

Crystal's mental model is "a session can host multiple AI/terminal/diff panels side by side for comparing approaches." Cyboflow's model is 1:1: one workflow run = one agent = one worktree. Exposing the multi-panel UI in v1 would actively confuse the product story — users would see "add another tool to this session" and wonder what it means for the review queue.

This task deletes ONLY the UI affordance that lets users create new panels: the "Add Tool" `<Plus />` dropdown button at the right end of `PanelTabBar.tsx` (lines 292–319). The underlying machinery (`panelManager` service in main process, `panels:create` IPC handler, the `tool_panels` database table, the `useCliPanel` hook, the `panelStore` Zustand state, the `ToolPanel` type definitions) stays untouched. Existing sessions that have multiple panels in the database will still load and render correctly — users just cannot add new panels via the UI.

This is consistent with the design doc §3 directive: *"The underlying data model can keep the panel abstraction temporarily (collapse "session = one panel" rather than refactoring tables on day one), but the UI surfaces that let users create multiple panels must be removed."*

## Implementation Steps

1. **Pre-flight grep**:
   