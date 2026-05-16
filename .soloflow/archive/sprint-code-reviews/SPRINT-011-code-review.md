---
sprint: SPRINT-011
findings_count:
  critical: 0
  important: 3
  minor: 0
---

# Sprint Code Review: SPRINT-011

## Scope
- Base: 0f98ece6c889deeb1489b9a7765624f240ac412d
- Tasks reviewed: [TASK-401, TASK-402, TASK-403, TASK-404, TASK-405, TASK-406, TASK-407]
- Files changed in this sprint's run-branch: 7 production files (most TASK-401..407 implementation merged in SPRINT-010 via 0f98ece; only the per-task done commits + TASK-404 round-2/round-3 fixes + TASK-401 wiring fix were new in SPRINT-011)
- Cross-task hotspots: frontend/src/trpc/client.ts ⇄ frontend/src/utils/trpcClient.ts (TASK-401 + every consumer in TASK-403/404/406/407); main/src/orchestrator/trpc/routers/approvals.ts ⇄ main/src/trpc/routers/approvals.ts (TASK-401 + TASK-406); frontend/src/hooks/useReviewQueueKeyboard.ts (TASK-404 + 2 fix commits)

## Findings queued
3 new findings appended to `.soloflow/active/findings/SPRINT-011-findings.md` for the next `/soloflow:compound` run. Severity breakdown: critical=0, important=3, minor=0.

(Prior queue at sprint start: 6 open + 1 resolved = 7 entries from per-task reviewers/verifier. After this pass: 9 open + 1 resolved = 10 total. Existing FIND-SPRINT-011-1..7 were NOT re-filed per orchestrator instruction; this review only adds cross-task patterns invisible to per-task reviewers.)

### Important (3)
- **FIND-SPRINT-011-8** — Stub `approveRestOfRun` tRPC mutation silently no-ops: full handler exists in `main/src/trpc/routers/approvals.ts` (TASK-406) but the orchestrator-side mutation returns fake `{ decided: 0 }` and the UI looks like it works. No CI tripwire prevents shipping this stub. Spans TASK-401 (handler), TASK-406 (stub), TASK-403 (button caller); verifier confirmed against a stub fixture so the silent-failure was invisible at every prior gate.
- **FIND-SPRINT-011-9** — Inconsistent vi.mock paths for the same `trpc` symbol across sprint tests. Three production consumers all import `'../utils/trpcClient'` but two of three test files (PendingApprovalCard.test, useReviewQueueKeyboard.test) mock `'../../trpc/client'` while reviewQueueStore.test mocks `'../../utils/trpcClient'`. Works today by accident of the shim re-export; breaks if FIND-SPRINT-011-1 is resolved by inverting canonical direction.
- **FIND-SPRINT-011-10** — Asymmetric per-run atomicity between approve and reject. TASK-406 added atomic `approveRestOfRun` to eliminate partial-failure exposure for group-card Approve, but no `rejectRestOfRun` exists — group-card Reject (TASK-403/406) and keyboard `n` on group (TASK-404, also flagged by FIND-3) both fan out N mutations. The "highest-harm failure mode" rationale that justified atomic approve applies symmetrically to reject.

### Out-of-scope observations
None this pass. Sprint touched a narrow surface (7 prod files, 3 commits); all open issues lived inside the changed surface.
