---
id: TASK-703
idea: SPRINT-028-compounder
status: in-flight
created: "2026-05-21T00:00:00Z"
files_owned:
  - frontend/src/components/DraggableProjectTreeView.tsx
  - frontend/src/components/__tests__/DraggableProjectTreeView.runs.test.tsx
files_readonly:
  - frontend/src/stores/navigationStore.ts
  - frontend/src/stores/cyboflowStore.ts
  - frontend/src/App.tsx
  - frontend/src/utils/cyboflowApi.ts
  - docs/SHELL-LAYOUT.md
acceptance_criteria:
  - criterion: handleRunClick no longer calls navigateToSessions(); it calls setActiveProjectId(run.project_id) after setActiveRun
    verification: "grep -nE 'navigateToSessions\\(\\)' frontend/src/components/DraggableProjectTreeView.tsx returns 0 matches AND grep -nE 'setActiveProjectId\\(run\\.project_id\\)' frontend/src/components/DraggableProjectTreeView.tsx returns >=1 match"
  - criterion: "runs test asserts setActiveProjectId is called with the run's project_id"
    verification: "grep -nE 'setActiveProjectId' frontend/src/components/__tests__/DraggableProjectTreeView.runs.test.tsx returns >=2 matches"
  - criterion: pnpm --filter frontend test exits 0
    verification: pnpm --filter frontend test exits 0
  - criterion: pnpm typecheck exits 0
    verification: pnpm typecheck exits 0
depends_on: []
estimated_complexity: low
epic: cyboflow-shell-architecture
test_strategy:
  needed: true
  justification: REG-SPRINT-028-1 was missed because navigationStore mock returned only navigateToSessions; need an assertion locking the new contract.
  targets:
    - behavior: Clicking a run row calls useNavigationStore.getState().setActiveProjectId(run.project_id) and does NOT call navigateToSessions
      test_file: frontend/src/components/__tests__/DraggableProjectTreeView.runs.test.tsx
      type: component
---
# B1 — Fix REG-SPRINT-028-1: handleRunClick un-mounts CyboflowRoot

## Objective

Fix the merge-blocker REG-SPRINT-028-1 in `frontend/src/components/DraggableProjectTreeView.tsx`. `handleRunClick` calls `setActiveRun(run.id)` then `navigateToSessions()` — the second call nulls `activeProjectId`, which unmounts `CyboflowRoot` (App.tsx gate), so `RunView` never renders. Replace `navigateToSessions()` with `setActiveProjectId(run.project_id)`. Extend the existing runs test to assert `activeProjectId` is set (not nulled) on click.

## Implementation Steps

1. In `DraggableProjectTreeView.tsx`, locate `handleRunClick`. Replace `useNavigationStore.getState().navigateToSessions();` with `useNavigationStore.getState().setActiveProjectId(run.project_id);` after the existing `setActiveRun(run.id)` call.

2. In `DraggableProjectTreeView.runs.test.tsx`, update the navigationStore mock's `getState()` to expose a `setActiveProjectId` spy alongside the existing spies. Add `mockSetActiveProjectId.mockReset()` to `beforeEach`.

3. Update existing case (e) to also assert `expect(mockSetActiveProjectId).toHaveBeenCalledWith(<project_id>)` and `expect(mockNavigateToSessions).not.toHaveBeenCalled()`.

4. Add new test case (g): clicking a run row sets activeProjectId (does not call navigateToSessions).

5. Run `pnpm --filter frontend test` and `pnpm typecheck`. Both exit 0.

6. Do NOT modify other `navigateToSessions` call sites — those are gated behind the legacy SessionView path that TASK-690 retires.

## Hardest Decision

Inline `setActiveProjectId(run.project_id)` (Option 1) vs new `selectRun(runId, projectId)` action (Option 2). Option 1 wins on smallest diff — project_id is already on `WorkflowRunListRow`.

## Rejected Alternatives

- New `selectRun` action — premature API surface.
- Modify `navigateToSessions` to not null `activeProjectId` — silently breaks SessionListItem, ProjectDashboard.
- Full App.tsx integration test — scope creep.

## Lowest Confidence Area

Mock uses both hook-call and `getState()` forms; the fix only touches `getState()`. If a future refactor switches to the hook form, the selector branch will need the field too.
