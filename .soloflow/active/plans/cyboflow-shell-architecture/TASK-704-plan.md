---
id: TASK-704
idea: SPRINT-028-compounder
status: ready
created: 2026-05-21T00:00:00Z
files_owned:
  - main/src/preload.ts
  - main/src/ipc/uiState.ts
  - main/src/services/uiStateManager.ts
  - frontend/src/types/electron.d.ts
  - frontend/src/components/__tests__/DraggableProjectTreeView.runs.test.tsx
files_readonly:
  - main/src/database/database.ts
  - frontend/src/components/DraggableProjectTreeView.tsx
  - frontend/src/components/Sidebar.tsx
acceptance_criteria:
  - criterion: "Zero references to sessionSortAscending|saveSessionSortAscending|getSessionSortAscending|save-session-sort-ascending in main/src/ and frontend/src/"
    verification: "grep -rnE 'sessionSortAscending|saveSessionSortAscending|getSessionSortAscending|save-session-sort-ascending' main/src/ frontend/src/ returns 0 matches"
  - criterion: "preload no longer exposes saveSessionSortAscending"
    verification: "grep -n 'saveSessionSortAscending' main/src/preload.ts returns 0"
  - criterion: "ui-state:save-session-sort-ascending handler removed"
    verification: "grep -n 'ui-state:save-session-sort-ascending' main/src/ipc/uiState.ts returns 0"
  - criterion: "uiStateManager has neither saveSessionSortAscending nor getSessionSortAscending method"
    verification: "grep -nE 'saveSessionSortAscending|getSessionSortAscending' main/src/services/uiStateManager.ts returns 0"
  - criterion: "electron.d.ts has no saveSessionSortAscending channel"
    verification: "grep -n 'saveSessionSortAscending' frontend/src/types/electron.d.ts returns 0"
  - criterion: "test mock no longer references sessionSortAscending in the getExpanded payload"
    verification: "grep -n 'sessionSortAscending' frontend/src/components/__tests__/DraggableProjectTreeView.runs.test.tsx returns 0"
  - criterion: "pnpm typecheck + main + frontend tests all exit 0"
    verification: "pnpm typecheck && pnpm --filter main test && pnpm --filter frontend test all exit 0"
depends_on: []
estimated_complexity: low
epic: cyboflow-shell-architecture
test_strategy:
  needed: false
  justification: "Pure dead-code cut following TASK-687. No new behavior; the existing DraggableProjectTreeView.runs.test.tsx mock entry for sessionSortAscending must be cleaned up but no new test cases are needed."
---

# B2 — Remove dead sessionSortAscending backend plumbing

## Objective

Complete the cleanup started by TASK-687: remove unreachable `sessionSortAscending` plumbing from preload, the `ui-state:save-session-sort-ascending` IPC handler, the `saveSessionSortAscending`/`getSessionSortAscending` service methods plus the `treeView.sessionSortAscending` DB key reference in `clear()`, the `saveSessionSortAscending` channel in `electron.d.ts`, and the stale mock entry in `DraggableProjectTreeView.runs.test.tsx`.

## Implementation Steps

1. Pre-flight grep: `grep -rnE 'sessionSortAscending|saveSessionSortAscending|getSessionSortAscending|save-session-sort-ascending' main/src/ frontend/src/`.

2. `main/src/preload.ts` — remove the `saveSessionSortAscending` entry from the `uiState` object.

3. `main/src/ipc/uiState.ts` — delete the entire `ipcMain.handle('ui-state:save-session-sort-ascending', ...)` block.

4. `main/src/services/uiStateManager.ts`:
   - Remove `sessionSortAscending: boolean;` from the local `UIState` interface.
   - Delete `getSessionSortAscending()` method.
   - Delete `saveSessionSortAscending()` method.
   - In `getExpandedState()`, change the return type to `{ expandedProjects: number[]; expandedFolders: string[] }` and drop the `sessionSortAscending` field.
   - In `clear()`, remove the `this.db.deleteUIState('treeView.sessionSortAscending');` call.

5. `frontend/src/types/electron.d.ts` — narrow the `getExpanded` return-type generic to `{ expandedProjects: number[]; expandedFolders: string[] }` and delete the `saveSessionSortAscending` declaration.

6. `frontend/src/components/__tests__/DraggableProjectTreeView.runs.test.tsx` — remove the `sessionSortAscending: false,` line from the mocked `getExpanded.mockResolvedValue` payload.

7. Re-run the grep from step 1 — expect 0 matches.

8. `pnpm typecheck && pnpm --filter main test && pnpm --filter frontend test` all exit 0.

## Hardest Decision

Delete the `treeView.sessionSortAscending` DB row vs leave it. Leave it — same rationale as TASK-685's discord_shown orphan column. The row is harmless and a migration adds cost for no visible benefit.

## Rejected Alternatives

- Mark backend `@cyboflow-hidden` — no plan to re-enable.
- Write a migration to drop the DB key — orphan is harmless.

## Lowest Confidence Area

The `UIState` interface in `uiStateManager.ts` is local (not exported). Removing `sessionSortAscending` from it should have no downstream impact; `pnpm typecheck` catches any hidden importer.
