---
id: TASK-687
sprint: SPRINT-028
epic: cyboflow-shell-architecture
status: done
summary: "Remodeled DraggableProjectTreeView to show project > workflow_runs (newest first); removed sessionSortAscending toggle from Sidebar; added cyboflow:listRuns IPC handler + listRuns helper; new test file with 6 assertions."
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: not_applicable
visual_macos: skipped_unable
---

# TASK-687 — done

## Commits
- f9601a1 feat(TASK-687): add cyboflow:listRuns IPC handler and listRuns API helper
- a323b15 feat(TASK-687): remodel sidebar to show project > workflow runs
- 3e7058a test(TASK-687): add DraggableProjectTreeView.runs.test.tsx
- 2e983e7 fix(TASK-687): remove sessionSortAscending from comment to satisfy AC4 grep
- 6beac49 refactor(TASK-687): rename WorkflowRunRow → WorkflowRunListRow in frontend lite shape

## Changes
- main/src/ipc/cyboflow.ts — new cyboflow:listRuns handler (SELECT ... ORDER BY created_at DESC)
- frontend/src/utils/cyboflowApi.ts — listRuns helper + WorkflowRunListRow type (renamed in CR round 1)
- frontend/src/components/DraggableProjectTreeView.tsx — full remodel: workflow_runs data source, no run-row drag, empty-state "No runs yet. Use Start Run.", click → setActiveRun + navigateToSessions
- frontend/src/components/Sidebar.tsx — removed sessionSortAscending state, loadUIState effect, toggleSessionSortOrder, ArrowUpDown import, Sort IconButton
- frontend/src/components/__tests__/DraggableProjectTreeView.runs.test.tsx — new (6 assertions: count, ordering, last-6 id, status class, click handler, empty state)

## Verifier
APPROVED_WITH_DEFERRED — AC3..AC11 MET functionally; AC1/AC2 visual deferred (no live pnpm dev). 265 frontend tests pass. Goal-backward checks all pass (graceful failure path, server-side sort, no event-listener leaks).

## Code review
IMPROVEMENTS_NEEDED → fixed in 6beac49. FIND-SPRINT-028-5 (duplicate WorkflowRunRow name across 3 modules) resolved by renaming frontend lite shape to WorkflowRunListRow.

## Tests
TESTS_WRITTEN — new DraggableProjectTreeView.runs.test.tsx; 6 assertions cover the new behavior. Sidebar.mcpHealth.test.tsx remained green.
