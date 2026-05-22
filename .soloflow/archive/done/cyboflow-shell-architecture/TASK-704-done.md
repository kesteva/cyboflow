---
id: TASK-704
sprint: SPRINT-030
epic: cyboflow-shell-architecture
status: done
summary: "Remove dead sessionSortAscending plumbing from preload, IPC handler, service, electron.d.ts, and test mock"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---
# TASK-704 — Done

Completed the cleanup started by TASK-687. Removed unreachable `sessionSortAscending` plumbing across 5 files:
- `main/src/preload.ts`: dropped `saveSessionSortAscending` from the `uiState` contextBridge object.
- `main/src/ipc/uiState.ts`: deleted the `ipcMain.handle('ui-state:save-session-sort-ascending', ...)` block.
- `main/src/services/uiStateManager.ts`: removed `sessionSortAscending` field from local `UIState`, deleted `getSessionSortAscending()` and `saveSessionSortAscending()` methods, narrowed `getExpandedState()` return type to `{ expandedProjects: number[]; expandedFolders: string[] }`, and dropped `deleteUIState('treeView.sessionSortAscending')` from `clear()`.
- `frontend/src/types/electron.d.ts`: narrowed the `getExpanded` channel's `IPCResponse<T>` `T` to match, and deleted the `saveSessionSortAscending` declaration.
- `frontend/src/components/__tests__/DraggableProjectTreeView.runs.test.tsx`: removed the stale `sessionSortAscending: false` mock entry.

The orphan `treeView.sessionSortAscending` DB row is intentionally left behind — same rationale as TASK-685's `discord_shown` orphan column. The row is harmless and a migration adds cost for no visible benefit.

Tests: main 601/601, frontend 280/280, typecheck 0, lint 0 errors. Grep across `main/src/` and `frontend/src/` returns 0 matches for the four target identifiers.
