# Cyboflow Shell Layout

Status: locked as of TASK-686 (IDEA-017, epic `cyboflow-shell-architecture`).
Updated by the Protoflow UI refresh: human review folded into the rail (see below).

## Column geometry

| Column     | Component                          | Width      | Role                                                                 |
|------------|------------------------------------|------------|----------------------------------------------------------------------|
| Left rail  | `Sidebar` (agent rail)             | resizable  | Project tree + sessions, a **Human review** primary item with pending-count badge, and the user footer (avatar · settings). |
| Main area  | `CyboflowRoot` **or** `ReviewQueueView` | flex-1 | Run surface (CyboflowRoot) by default; swaps to the full-width human-review pane (`ReviewQueueView`) when the rail's Human-review item is active. |

The human-review queue is the differentiator surface described in
`docs/cyboflow_system_design.md` §5.7. Per the Protoflow refresh it is no longer a
standing ~360px left column; it is reached via the rail's **Human review** item,
which swaps the center to a full-width review pane (App-level `showHumanReview`
state). The review queue store is initialised at the App-shell level
(`useReviewQueueStore.getState().init()` in `App.tsx`) so the rail badge and the
macOS dock badge stay live even when the pane is unmounted.

## Assumption order

1. The agent rail (Sidebar) is leftmost; the title bar (38px) spans above the row.
2. The center takes the remaining horizontal space via `flex-1` and hosts either
   the run surface or the full-width human-review pane.

## Deferred decisions (resolved by downstream tasks in this epic)

- **Sidebar info model — TASK-687.** Default: project > workflow runs (newest first).
- **CyboflowRoot disposition — TASK-688.** Default: survives as RunView mount point; `WorkflowPicker` relocates.
- **Legacy `useLegacyCrystalView` toggle and `SessionView` branch — TASK-690.** Default: retire.
- **Crystal-era session descendants — TASK-691.** Default: delete after toggle is retired.
- **Legacy Crystal DB tables — TASK-692.** Default: drop via reconcile migration (option C — Crystal-session subgraph only).

## Cross-references

- Product framing: `docs/cyboflow_system_design.md` §5.7.
- Current mount site: `frontend/src/App.tsx` lines 317-375.

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
