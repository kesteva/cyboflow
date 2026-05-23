---
sprint: SPRINT-033
findings_count:
  critical: 0
  important: 3
  minor: 4
---

# Sprint Code Review: SPRINT-033

## Scope
- Base: 117b0e6fb027f93e5501db9bde4810ed393ed7f0
- Tasks reviewed: [TASK-727, TASK-728, TASK-730, TASK-731]
- Files changed: 17 production/test files (+ 12 SoloFlow state files)
- Cross-task hotspots:
  - `main/src/orchestrator/__tests__/approvalCreatedBridge.test.ts` (touched by TASK-727 + TASK-728 — fixture migration + listPending extraction)
  - `main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts` (TASK-727 added `seedApproval`; consumed indirectly by every other approvals test)
  - `frontend/src/hooks/usePanelSurface.ts` + `CyboflowRoot.tsx` + `ProjectView.tsx` (TASK-731 — single hook, two render trees)

## Findings queued
5 new findings appended to `.soloflow/active/findings/SPRINT-033-findings.md` for the next `/soloflow:compound` run (joining 2 prior verifier findings → 7 total).

Severity breakdown for this sprint-code-review pass: critical=0, important=3, minor=2.
(File total: critical=0, important=3, minor=4 — includes 2 pre-existing verifier findings.)

### Critical (0)
_None._

### Important (3) — sprint-code-reviewer
- FIND-SPRINT-033-3 — Partial migration to canonical `seedApproval` leaves 6 inline `INSERT INTO approvals` sites across 4 test files (cyboflowSchema, transitions, approvalRouter, mcpQueryHandler).
- FIND-SPRINT-033-4 — Local `createTestDb` duplicated across 11 test files post-TASK-727; canonical fixture only consumed by 6 migrated files.
- FIND-SPRINT-033-5 — `usePanelSurface.handlePanelClose` has duplicated tail across both `autoCreatePermanentPanels` branches; re-introduces the duplication the hook extraction was meant to eliminate.

### Minor (2) — sprint-code-reviewer
- FIND-SPRINT-033-6 — `TypedEventNarrowing` constructed without logger at 2 sites; silent verbose drop on unknown variants.
- FIND-SPRINT-033-7 — Fragile two-`useEffect` `isLoadingSession` dance in `ProjectView`; fully derivable from `mainRepoSession`.

### Pre-existing (verifier handoff, in same findings file)
- FIND-SPRINT-033-1 — Missing `projectId === null` no-op test (TASK-731 AC #5 prose gap).
- FIND-SPRINT-033-2 — `TASK-731-plan.md` "Rejected Alternatives" went stale against `abe52ae` (TASK-693).
