---
sprint: SPRINT-029
findings_count:
  critical: 0
  important: 5
  minor: 1
---

# Sprint Code Review: SPRINT-029

## Scope
- Base: 28f828157262802b139d3f41c145c7eec44f6d8a
- Tasks reviewed: [TASK-303, TASK-305, TASK-654, TASK-694, TASK-695, TASK-706, TASK-707, TASK-708]
- Files changed: 30 (source + tests + migrations + docs + patch)
- Cross-task hotspots:
  - main/src/index.ts (touched by TASK-305, TASK-694, TASK-706, TASK-708)
  - main/src/orchestrator/approvalRouter.ts (touched by TASK-303, TASK-305, TASK-694)
  - main/src/orchestrator/__tests__/approvalRouter.test.ts (touched by TASK-303, TASK-305, TASK-694)

## Findings queued
6 new findings appended to `.soloflow/active/findings/SPRINT-029-findings.md` for the next `/soloflow:compound` run (sprint already had 6 pre-existing findings from verifiers; combined queue now totals 12, of which 11 are open). Severity breakdown for this review pass: critical=0, important=5, minor=1.

### Important
- **FIND-SPRINT-029-7** — DIAG-* console.error debug instrumentation left in production code (12 lines across approvalRouter.ts + preToolUseHookHelper.ts).
- **FIND-SPRINT-029-8** — Cross-task data drift: approvalCreated SSE bridge emits `workflowName=''` while listPending JOINs the real value.
- **FIND-SPRINT-029-9** — Duplicated payloadPreview 512-char truncation logic in bridge (TASK-694) and listPending (TASK-706).
- **FIND-SPRINT-029-10** — Duplicated `createTestDb`/`seedRun` helpers across three test files (TASK-303/305, TASK-706, TASK-708) with subtle schema-source divergence.

### Minor
- **FIND-SPRINT-029-11** — Boot recovery split across two locations (ApprovalRouter.recoverStaleAwaitingReview vs. recoverActiveStateOrphans) with overlapping concerns.
- **FIND-SPRINT-029-12** — `db: db` shorthand redundancy at index.ts:691.

## Hotspot notes
- **main/src/index.ts:** The four-task ordering reads coherently — orchestrator start → tRPC attach (with db) → ApprovalRouter.initialize → approvalCreated bridge wiring → recoverStaleAwaitingReview → recoverActiveStateOrphans. No dead imports or dangling bindings introduced. One trivial shorthand redundancy (FIND-12) and one structural concern about the split recovery (FIND-11).
- **main/src/orchestrator/approvalRouter.ts:** The three-task progression (TASK-303 added timeout + expireApproval; TASK-305 added recoverStaleAwaitingReview; TASK-694 added DIAG instrumentation + a defensive db undefined check) is internally consistent. clearTimeout is correctly cleared in respond(), clearPendingForRun(), and expireApproval(). The DIAG noise (FIND-7) is the only material issue.
