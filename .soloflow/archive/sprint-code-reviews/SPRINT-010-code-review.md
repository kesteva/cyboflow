---
sprint: SPRINT-010
findings_count:
  critical: 0
  important: 4
  minor: 6
---

# Sprint Code Review: SPRINT-010

## Scope
- Base: 4a43ebc0638c6de7db0288c4b735cf2c1bf4ba9f
- Tasks reviewed: [TASK-401, TASK-402, TASK-403, TASK-404, TASK-405, TASK-406, TASK-407]
- Files changed: ~52 (4154 insertions / 864 deletions)
- Cross-task hotspots:
  - frontend/src/components/PendingApprovalCard.tsx (5 tasks: 403/404/405/406)
  - frontend/src/components/ReviewQueueView.tsx (3 tasks: 402/404/405)
  - frontend/src/stores/reviewQueueStore.ts (3 tasks: 401/405/407)
  - frontend/src/hooks/useReviewQueueKeyboard.ts (2 tasks: 404/405)
  - shared/types/approvals.ts (2 tasks: 401/406)
  - main/src/orchestrator/trpc/routers/{approvals,events}.ts (2 tasks: 401/406, 401/407)

## Findings queued

10 new findings appended to `.soloflow/active/findings/SPRINT-010-findings.md` (FIND-SPRINT-010-19 through FIND-SPRINT-010-28). Combined with the 18 prior per-task findings, the queue now holds 28 entries (pending_count=22). Severity breakdown for the new entries: critical=0, important=4, minor=6.

### Important (medium severity — cross-task patterns)
- **FIND-SPRINT-010-19** ReviewQueueView discards the `init()` unsubscribe; subscription leaks under StrictMode and any future remount (TASK-401 + TASK-402).
- **FIND-SPRINT-010-20** Group-approve has divergent semantics: mouse uses atomic `approveRestOfRun`, keyboard y-key fires N individual mutations (TASK-404 + TASK-406).
- **FIND-SPRINT-010-21** Approve/reject mutation switch (`single | group`) is duplicated four times across PendingApprovalCard and useReviewQueueKeyboard (TASK-403/404/405/406).
- **FIND-SPRINT-010-22** Two coexisting frontend vitest configs with conflicting `environment` (node vs jsdom); only per-file pragmas keep both green (TASK-401 + TASK-402/403).

### Minor (low severity — cleanup / convention)
- **FIND-SPRINT-010-23** Two coexisting tRPC client import paths (`../trpc/client` re-shim vs canonical `../utils/trpcClient`) (TASK-401 + TASK-403/404).
- **FIND-SPRINT-010-24** `main/src/trpc/` orphan subtree — no live consumers, only a tested handler awaiting approval-router epic (TASK-401 + TASK-406).
- **FIND-SPRINT-010-25** Test-file placement drift: pre-existing sibling pattern (`*.test.ts`) vs sprint-introduced `__tests__/` subfolders.
- **FIND-SPRINT-010-26** Plain-key (j/k/y/n) global keydown hook is mounted app-wide with input-element-only guards; can fire mutations from unrelated focus contexts (TASK-404/405).
- **FIND-SPRINT-010-27** Store `init()` has no reconnect strategy; `disconnected` status is set but never read or recovered (TASK-401 + TASK-407).
- **FIND-SPRINT-010-28** Stub mutations (`approve`/`reject`/`approveRestOfRun`) return success silently with no UX feedback; user clicks look like dead buttons until approval-router lands (TASK-401 + TASK-406).
