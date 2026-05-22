---
id: TASK-703
sprint: SPRINT-030
epic: cyboflow-shell-architecture
status: done
summary: "Fix REG-SPRINT-028-1: handleRunClick now sets activeProjectId instead of calling navigateToSessions, keeping CyboflowRoot mounted"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---
# TASK-703 — Done

Resolved REG-SPRINT-028-1. `handleRunClick` in `DraggableProjectTreeView.tsx` previously called `setActiveRun(run.id)` followed by `navigateToSessions()`, but `navigateToSessions` nulls `activeProjectId`, which trips App.tsx's `activeProjectId !== null` gate and unmounts `CyboflowRoot` — so `RunView` never rendered.

Replaced the `navigateToSessions()` call with `setActiveProjectId(run.project_id)`. The project ID is already on `WorkflowRunListRow`, so this is the smallest-diff fix that preserves the gate. Other `navigateToSessions` call sites in `ProjectDashboard` and `SessionListItem` are inside the legacy SessionView path slated for retirement in TASK-690 and were left untouched per plan step 6.

Extended `DraggableProjectTreeView.runs.test.tsx`:
- Added `mockSetActiveProjectId` spy to the `useNavigationStore.getState()` mock.
- Added `mockSetActiveProjectId.mockReset()` to `beforeEach`.
- Updated case (e) to assert `setActiveProjectId(1)` is called and `navigateToSessions` is not.
- Added case (g) locking in the new contract end-to-end.

Tests: frontend 278/278 pass. typecheck 0.
