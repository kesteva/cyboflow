# Cyboflow Shell Layout

Status: locked as of TASK-686 (IDEA-017, epic `cyboflow-shell-architecture`).

## Column geometry

| Column        | Component         | Width   | Role                                                |
|---------------|-------------------|---------|-----------------------------------------------------|
| Left rail     | `ReviewQueueView` | ~360 px | Cross-workflow human review queue (LOAD-BEARING).   |
| Second column | `Sidebar`         | ~256 px | Project tree (Crystal-derived; remodeled in TASK-687). |
| Main area    | `CyboflowRoot`    | flex-1  | Run mount point — hosts the active workflow run.    |

The `ReviewQueueView` left rail is the differentiator surface described in
`docs/cyboflow_system_design.md` §5.7 (Human Review Queue).

## Assumption order

1. Review queue rail is load-bearing; width/position are fixed first.
2. Project sidebar takes the next-widest band of fixed width.
3. `CyboflowRoot` gets the remaining horizontal space via `flex-1`.

## Deferred decisions (resolved by downstream tasks in this epic)

- **Sidebar info model — TASK-687.** Default: project > workflow runs (newest first).
- **CyboflowRoot disposition — TASK-688.** Default: survives as RunView mount point; `WorkflowPicker` relocates.
- **Legacy `useLegacyCrystalView` toggle and `SessionView` branch — TASK-690.** Default: retire.
- **Crystal-era session descendants — TASK-691.** Default: delete after toggle is retired.
- **Legacy Crystal DB tables — TASK-692.** Default: drop via reconcile migration (option C — Crystal-session subgraph only).

## Cross-references

- Product framing: `docs/cyboflow_system_design.md` §5.7.
- Current mount site: `frontend/src/App.tsx` lines 317-375.
- Epic: `.soloflow/active/plans/cyboflow-shell-architecture/EPIC-cyboflow-shell-architecture.md`.

## Navigation store contract

`CyboflowRoot` is mounted **only when `activeProjectId !== null`** (App.tsx gate at the
`<div className="flex flex-1 overflow-hidden">` block).

`navigateToSessions()` (`frontend/src/stores/navigationStore.ts`) is a **multi-field reset**:
it sets `{ activeView: 'sessions', activeProjectId: null }`. Calling it while activating
a run un-mounts `CyboflowRoot` immediately (REG-SPRINT-028-1). Rules:

- Do NOT call `navigateToSessions()` in a click handler that also calls `setActiveRun()`.
  Use `setActiveProjectId(run.project_id)` or a dedicated `selectRun(runId, projectId)`
  action instead.
- Other `navigateToSessions` call sites (`DraggableProjectTreeView`, `SessionListItem`,
  `ProjectDashboard`) should be audited before TASK-690 retires `useLegacyCrystalView`.
- When adding a new App-level mount condition, document it in this section.
