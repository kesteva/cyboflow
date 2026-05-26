---
sprint: SPRINT-038
findings_count:
  critical: 0
  important: 2
  minor: 3
---

# Sprint Code Review: SPRINT-038

## Scope
- Base: b5d5bff4473abc99b4c59dd014e3369de807b295
- Tasks reviewed: [TASK-751, TASK-752, TASK-753]
- Files changed: 10 production files + 4 test files
- Cross-task hotspots:
  - `frontend/src/types/session.ts` + `main/src/types/session.ts` (TASK-753 sync-comment touched both)
  - Quick-session lifecycle surface: `useQuickSession.ts` (new, TASK-752), `WorkflowPicker.tsx` (TASK-752), `CyboflowRoot.tsx` (TASK-752)
  - `runId` data path: `models.ts` (TASK-751), `sessionManager.ts` (TASK-751), `database.ts` (untouched — gap)

## Findings queued
5 new findings appended to `.soloflow/active/findings/SPRINT-038-findings.md` for the next `/soloflow:compound` run, in addition to the 3 per-task findings already there. Severity breakdown for sprint-level only: critical=0, important=2, minor=3.

### Important (medium severity)
- FIND-SPRINT-038-4 — FIND-SPRINT-037-1 (Quick-badge inversion) is mapper-correct but observably unfixed: no code path writes a non-null `sessions.run_id`, so every session still shows the Quick badge.
- FIND-SPRINT-038-5 — Third `CreateSessionRequest` declaration in `frontend/src/stores/sessionStore.ts` not covered by TASK-753's new in-sync comment.

### Minor (low severity)
- FIND-SPRINT-038-6 — `WorkflowPicker.onWorkflowStarted: (runId: string) => void` now fires with a sessionId in the quick path; prop name and param type are factually wrong after TASK-752.
- FIND-SPRINT-038-7 — `WorkflowPicker` Start Run button does not check `quickSession.isStarting`, leaving a click-race window where a workflow run and a quick session can both launch and clobber the mutually-exclusive cyboflowStore state.
- FIND-SPRINT-038-8 — TASK-752 added two tests using `vi.mock(`../../../utils/api`)` for `API.sessions.createQuick`; the sibling `WorkflowPicker.test.tsx` still patches `window.electronAPI` directly. Pattern inconsistency only — both work today.

(Per-task findings FIND-SPRINT-038-1, -2, -3 retained as-is — already accurate.)
