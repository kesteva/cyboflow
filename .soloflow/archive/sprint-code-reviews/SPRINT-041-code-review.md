---
sprint: SPRINT-041
findings_count:
  critical: 0
  important: 3
  minor: 2
---

# Sprint Code Review: SPRINT-041

## Scope
- Base: 7c20aebb6dfb6dbca5022a97a132dac01c9b007d
- Tasks reviewed: [TASK-754, TASK-772, TASK-773, TASK-774, TASK-775, TASK-776, TASK-777, TASK-778, TASK-779, TASK-780, TASK-781]
- Files changed: 39 source + test files (excluding `.soloflow/` plan/archive churn); +2013/-2521 lines
- Cross-task hotspots:
  - `main/src/orchestrator/__tests__/approvalRouter.test.ts` — touched by 2 TASK-777 commits (already resolved as FIND-SPRINT-041-5)
  - `main/src/index.ts` — TASK-774 + TASK-777 (clean, narrow edits)
  - `main/src/orchestrator/approvalRouter.ts` + `questionRouter.ts` — twin classes touched across TASK-774/TASK-777
  - `frontend/src/stores/reviewQueueStore.ts` + `questionStore.ts` — twin stores touched by TASK-773/TASK-775
  - `frontend/src/components/cyboflow/CyboflowRoot.tsx` + `WorkflowProgressTimeline.tsx` — both subscribe to `useWorkflowPhaseState(activeRunId)` across TASK-780/TASK-781

## Findings queued
5 new cross-task findings appended to `.soloflow/active/findings/SPRINT-041-findings.md` for the next `/soloflow:compound` run. Severity breakdown: critical=0, important=3, minor=2.

### Important
- **FIND-SPRINT-041-7** — Duplicate `useWorkflowPhaseState(activeRunId)` subscription created across TASK-780 + TASK-781 (CyboflowRoot.tsx:37 + WorkflowProgressTimeline.tsx:176 — 2 concurrent tRPC subscriptions per run).
- **FIND-SPRINT-041-8** — `ApprovalRouter` and `QuestionRouter` are ~70% structural twins (singleton + per-run PQueue + pending Map + request/respond/clearPendingForRun/recoverStale\*).
- **FIND-SPRINT-041-9** — `reviewQueueStore` and `questionStore` are ~80% structural twins (init() + Created/Settled subscription pair + mirrored onError teardown + pure reducer exports); TASK-775 had to write the onError fix into BOTH.

### Minor
- **FIND-SPRINT-041-10** — ResizeObserver `beforeAll` shim duplicated across CyboflowRoot.test.tsx, RunRightRail.test.tsx, WorkflowCanvas.test.tsx (3 copies); belongs in `frontend/src/test/setup.ts`.
- **FIND-SPRINT-041-11** — TASK-778 was a documented no-op (ACs satisfied earlier in the same sprint by TASK-773 + TASK-775); compounder-scheduling-blindspot — SoloFlow plugin feedback, not a cyboflow code task.

## Notes
- The convention check (per CLAUDE.md TypeScript rules and `onData: (evt: unknown)` audit) flagged 4 pre-existing hits in the two stores; none of them was introduced by this sprint, so they are not filed.
- Cross-cutting store-action sweep found no redundant or mid-flow `clearPendingForRun` calls — both call sites (claudeCodeManager.ts finally + cancelAndRestartHandler.ts) symmetrically clear both routers, in documented order.
- No new security surface introduced; both routers persist request bodies via parameterized inserts.
