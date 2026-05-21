---
id: TASK-687
idea: IDEA-017
status: in-flight
created: "2026-05-20T00:00:00Z"
files_owned:
  - frontend/src/components/DraggableProjectTreeView.tsx
  - frontend/src/components/Sidebar.tsx
  - frontend/src/utils/cyboflowApi.ts
  - frontend/src/types/electron.d.ts
  - main/src/ipc/cyboflow.ts
  - frontend/src/components/__tests__/Sidebar.mcpHealth.test.tsx
  - frontend/src/components/__tests__/DraggableProjectTreeView.runs.test.tsx
  - frontend/src/components/CreateSessionDialog.tsx
  - frontend/src/components/SessionListItem.tsx
  - frontend/src/components/cyboflow/CyboflowRoot.tsx
  - frontend/src/components/cyboflow/WorkflowPicker.tsx
files_readonly:
  - frontend/src/stores/sessionStore.ts
  - frontend/src/stores/navigationStore.ts
  - frontend/src/stores/cyboflowStore.ts
  - frontend/src/utils/timestampUtils.ts
  - frontend/src/App.tsx
  - frontend/src/utils/api.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/trpc/routers/runs.ts
  - main/src/orchestrator/trpc/routers/runs.ts
  - main/src/services/uiStateManager.ts
  - main/src/ipc/types.ts
  - main/src/database/database.ts
  - shared/types/cyboflow.ts
  - shared/types/workflows.ts
acceptance_criteria:
  - criterion: "DraggableProjectTreeView renders each expanded project's children as a workflow_runs list (newest first), not Crystal sessions."
    verification: Run `pnpm dev`; expand a project that has at least one workflow_run. Children render as run rows. No `SessionListItem` instance appears under a project node.
  - criterion: Clicking a run row navigates the main pane to that run via `useCyboflowStore.setActiveRun(runId)`.
    verification: "Click a run row, observe `cyboflow-frontend-debug.log` for a stream event subscription for the clicked runId."
  - criterion: The sidebar sort-order toggle and `sessionSortAscending` prop are removed from the Sidebar header.
    verification: "`grep -n 'sessionSortAscending\\|ArrowUpDown\\|toggleSessionSortOrder' frontend/src/components/Sidebar.tsx` returns zero matches."
  - criterion: "`DraggableProjectTreeViewProps` no longer declares `sessionSortAscending`, and runs are always sorted by `created_at DESC`."
    verification: "`grep -n 'sessionSortAscending' frontend/src/components/DraggableProjectTreeView.tsx` returns zero matches."
  - criterion: "A project with zero runs renders an inline empty state with the copy 'No runs yet. Use Start Run.'"
    verification: "`grep -rn 'Click New Session' frontend/src/components/DraggableProjectTreeView.tsx frontend/src/components/Sidebar.tsx` returns zero matches. `grep -n 'No runs yet' frontend/src/components/DraggableProjectTreeView.tsx` returns ≥1 match."
  - criterion: Project-row drag-and-drop reordering still works.
    verification: "Drag a project, reload, confirm order persists. `grep -n 'API.projects.reorder' frontend/src/components/DraggableProjectTreeView.tsx` returns ≥1 match."
  - criterion: Run rows are NOT drag-reorderable.
    verification: "`grep -n 'handleRunDragStart\\|draggable' frontend/src/components/DraggableProjectTreeView.tsx` shows no `draggable=\\{true\\}` on run-row JSX."
  - criterion: "A new `cyboflow:listRuns` IPC handler is registered and a corresponding `listRuns` helper exists in cyboflowApi.ts."
    verification: "`grep -n \"'cyboflow:listRuns'\" main/src/ipc/cyboflow.ts` returns ≥1 match. `grep -n 'export async function listRuns' frontend/src/utils/cyboflowApi.ts` returns 1 match. `pnpm typecheck` exits 0."
  - criterion: CreateSessionDialog.tsx and SessionListItem.tsx are NOT deleted by this task. (TASK-689 owns their removal).
    verification: "`test -f frontend/src/components/CreateSessionDialog.tsx && test -f frontend/src/components/SessionListItem.tsx && echo OK`."
  - criterion: "`pnpm typecheck` and `pnpm lint` exit 0; existing Sidebar.mcpHealth.test.tsx still passes."
    verification: "`pnpm typecheck && pnpm lint && pnpm --filter @cyboflow/frontend test -- src/components/__tests__/Sidebar.mcpHealth.test.tsx` exits 0."
  - criterion: CyboflowRoot.tsx and WorkflowPicker.tsx are not modified by this task.
    verification: "`git diff main -- frontend/src/components/cyboflow/CyboflowRoot.tsx frontend/src/components/cyboflow/WorkflowPicker.tsx` returns empty."
depends_on:
  - TASK-686
estimated_complexity: high
epic: cyboflow-shell-architecture
test_strategy:
  needed: true
  justification: "Sidebar.mcpHealth.test.tsx already exists; it MUST stay green after Sidebar refactor. A new tree-renderer test for the run-centric tree is in scope so the executor doesn't ship a renderer with no test coverage."
  targets:
    - behavior: "Sidebar renders without crashing and no longer shows the 'Sort sessions:' IconButton."
      test_file: frontend/src/components/__tests__/Sidebar.mcpHealth.test.tsx
      type: component
    - behavior: "DraggableProjectTreeView fetches runs via cyboflowApi.listRuns (mocked), renders each run row sorted newest-first; clicking calls useCyboflowStore.setActiveRun."
      test_file: frontend/src/components/__tests__/DraggableProjectTreeView.runs.test.tsx
      type: component
    - behavior: "DraggableProjectTreeView shows the empty-state copy 'No runs yet. Use Start Run.' when a project has zero runs."
      test_file: frontend/src/components/__tests__/DraggableProjectTreeView.runs.test.tsx
      type: component
---
# Remodel Sidebar to show project > workflow runs (run-centric tree)

## Objective

Replace `DraggableProjectTreeView.tsx`'s Crystal-session-based data source with a workflow_runs data source (newest first), and strip the sort-order toggle from `Sidebar.tsx`. CreateSessionDialog and SessionListItem are intentionally left in source (TASK-689 owns their deletion); only the in-tree rendering of run rows changes here.

## Implementation Steps

1. **Pre-flight grep** to confirm scope boundaries:
   ```
   grep -rn "sessionSortAscending\|toggleSessionSortOrder\|ArrowUpDown" frontend/src
   grep -rn "Click New Session to start" frontend/src
   grep -rn "cyboflow:listRuns\|listRuns" frontend/src main/src
   ```

2. **Add `cyboflow:listRuns` IPC handler in `main/src/ipc/cyboflow.ts`.** Mirror the `cyboflow:listWorkflows` handler. Args: `{ projectId: number }`. SQL: `SELECT id, workflow_id, project_id, status, worktree_path, branch_name, created_at, updated_at, started_at, ended_at, stuck_reason FROM workflow_runs WHERE project_id = ? ORDER BY created_at DESC`. Return `{ success: true, data: rows }` or `{ success: false, error }`.

3. **Add `listRuns` helper to `frontend/src/utils/cyboflowApi.ts`** mirroring `listWorkflows`:
   ```ts
   export async function listRuns({ projectId }: { projectId: number }): Promise<WorkflowRunRow[]> {
     const electron = requireElectron();
     const res = await electron.invoke('cyboflow:listRuns', { projectId }) as IPCResponse<WorkflowRunRow[]>;
     if (!res.success) throw new Error(res.error ?? 'listRuns failed');
     return res.data ?? [];
   }
   ```

4. **Refactor `DraggableProjectTreeView.tsx`:**
   - Remove `sessionSortAscending` prop and ascending/descending toggle; replace with fixed `created_at DESC` comparator.
   - Replace `API.sessions.getAllWithProjects()` call with `API.projects.getAll()` + per-project `cyboflowApi.listRuns({ projectId })` parallelized via `Promise.all`.
   - Remove session-event listeners (`handleSessionCreated` / `handleSessionUpdated` / `handleSessionDeleted`); keep folder event listeners.
   - Render each run with: status indicator dot, workflow_id last-6 (with `// TODO: enrich with workflow.name` comment), relative timestamp via `formatDistanceToNow`.
   - Click handler: `useCyboflowStore.getState().setActiveRun(run.id)` + `useNavigationStore.getState().navigateToSessions()`.
   - No drag-and-drop on run rows; preserve project-row drag handles.
   - Empty state when `project.runs.length === 0 && project.folders.length === 0`: `<div className="px-4 py-2 text-xs text-text-tertiary">No runs yet. Use Start Run.</div>`.
   - PRESERVE: `CreateSessionDialog` import and render path (TASK-689 deletes), "New Session" button (TASK-689 deletes), play-button `▶️` for `handleRunProjectScript` (unrelated; stays), right-click context menu, ProjectSettings modal, AddProjectDialog modal.

5. **Refactor `frontend/src/components/Sidebar.tsx`:**
   - Remove `sessionSortAscending` state, `uiState.saveSessionSortAscending` read/write, `toggleSessionSortOrder` function.
   - Remove `ArrowUpDown` icon import.
   - Remove the Sort IconButton JSX.
   - Update `<DraggableProjectTreeView />` to omit `sessionSortAscending` prop.
   - Leave "Projects & Sessions" label text as-is (TASK-686 settled shell copy).
   - Leave `uiState.saveSessionSortAscending` channel in `electron.d.ts` (IPC contract preserved).

6. **Update `frontend/src/components/__tests__/Sidebar.mcpHealth.test.tsx`** only if necessary. Run the test to confirm; only edit if it fails.

7. **Add new test file `frontend/src/components/__tests__/DraggableProjectTreeView.runs.test.tsx`** asserting:
   (a) 3 mocked runs render under an expanded project
   (b) ordering is newest-first by `created_at`
   (c) each row shows last-6 of run id
   (d) status indicator class differs across statuses
   (e) clicking a row triggers `setActiveRun` on mocked store
   (f) empty `listRuns` response renders the empty state copy

8. **Run gates:** `pnpm typecheck && pnpm lint && pnpm --filter @cyboflow/frontend test -- src/components/__tests__/Sidebar.mcpHealth.test.tsx src/components/__tests__/DraggableProjectTreeView.runs.test.tsx`. All exit 0.

9. **Visual verification:** Run `pnpm dev`. Confirm golden path: sidebar shows project > runs tree; clicking a run navigates; Sort IconButton is gone.

10. **Re-run pre-flight greps** as completeness gate.

## Acceptance Criteria

See frontmatter.

## Test Strategy

New `DraggableProjectTreeView.runs.test.tsx` is the primary coverage for the new run-row rendering. Mock `cyboflowApi.listRuns`, `API.projects.getAll`, `useCyboflowStore`, `useNavigationStore`. Use `@testing-library/react` + `vitest`.

## Hardest Decision

**How to source workflow_runs given IDEA's instruction to use tRPC `runs.list.query`** — that procedure is currently a `throwNotImplemented` stub, and no `cyboflow:listRuns` IPC channel exists. Three options considered:
1. **Add new `cyboflow:listRuns` IPC channel + helper** — chosen. Matches existing transport pattern (`listWorkflows`, `startRun`), stays consistent with the architecture doc's "raw-IPC is live, tRPC is placeholder" decision.
2. **Wire the tRPC procedure here** — rejected. Requires plumbing `ctx.db` through tRPC context, gated on approval-router epic.
3. **Reuse `sessions` data source mapped to fake `runs`** — rejected. Defeats the refactor's purpose.

## Rejected Alternatives

- **Eliminate the project sidebar entirely** (candidate 4 of open_question 2). Decomposer-resolved default is candidate 1.
- **Project > workflows > runs** (candidate 2). Resolved default is flatter project > runs.
- **Run reordering via drag-and-drop.** Runs have canonical newest-first ordering.
- **Render workflow.name instead of workflow_id last-6.** Would require a JOIN or extra round-trip. Deferred with `// TODO: enrich` comment.

## Lowest Confidence Area

**The shape of the `loadProjectsWithSessions` refactor.** The current implementation is ~70 lines of state synchronization that assume `project.sessions` exists and gets mutated by IPC events. The plan opts for "keep field naming, treat `sessions` field as always-empty and add a `runs` field" rather than full rename. Folders rendering is the other minor risk: kept alive but always-empty.
