---
sprint: SPRINT-028
findings_count:
  critical: 0
  important: 3
  minor: 3
---

# Sprint Code Review: SPRINT-028

## Scope
- Base: c360d9dea6bff48b96390179ddcac1001118e53c
- Tasks reviewed: [TASK-684, TASK-685, TASK-686, TASK-687, TASK-688]
- Files changed: 14 source files (excluding `.soloflow/` state)
- Cross-task hotspots: [frontend/src/App.tsx (TASK-684 + TASK-686)]
- Single-task files reviewed for cross-cutting impact: main/src/database/database.ts, main/src/ipc/app.ts, frontend/src/components/DraggableProjectTreeView.tsx, frontend/src/components/Sidebar.tsx, frontend/src/components/cyboflow/CyboflowRoot.tsx, main/src/ipc/cyboflow.ts, frontend/src/utils/cyboflowApi.ts

## Findings queued
6 findings appended to `.soloflow/active/findings/SPRINT-028-findings.md` for the next `/soloflow:compound` run. Severity breakdown: critical=0, important=3, minor=3.

### Important
- **FIND-SPRINT-028-6** — `navigateToSessions` multi-field reset nulls `activeProjectId`; collides with TASK-688 CyboflowRoot mount gate (underlying convention behind REG-SPRINT-028-1).
- **FIND-SPRINT-028-7** — `discord_shown` column still in `app_opens` CREATE TABLE; fresh installs inherit the orphan despite TASK-685 cleanup comment.
- **FIND-SPRINT-028-8** — `sessionSortAscending` backend (preload + IPC + service + DB key + test mock) is dead after TASK-687 UI removal.

### Minor
- **FIND-SPRINT-028-9** — `_SessionListItem` placeholder import still incurs module load; TASK-689 contract could be satisfied by a comment marker.
- **FIND-SPRINT-028-10** — JSDoc on `WorkflowRunListRow` is self-referential after the rename in commit 6beac49; should point to `WorkflowRunRow`.
- **FIND-SPRINT-028-11** — `cyboflow:listRuns` lacks projectId runtime validation; consistent with other handlers but flagged per CLAUDE.md IPC parity rule.

## Notes
- Pre-existing findings FIND-SPRINT-028-2..5 (4 minor) remain open in the same findings file; the next `/compound` run triages them together with the 6 added here.
- REG-SPRINT-028-1 (sprint-verifier; TASK-687×TASK-688 run-row click breaks CyboflowRoot mount) NOT refiled per orchestrator instruction; FIND-SPRINT-028-6 captures the underlying convention drift.
