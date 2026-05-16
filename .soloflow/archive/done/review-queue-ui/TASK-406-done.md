---
id: TASK-406
sprint: SPRINT-011
epic: review-queue-ui
status: done
summary: "approveRestOfRun (run-scoped) mutation + handler + group-card integration + NO-global-approve-all sweep guard (cumulative from SPRINT-010)"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_unable
---

# TASK-406 — Done (SPRINT-011)

## Context
TASK-406 work fully delivered in SPRINT-010 (commits 161df62, c31794a, af63228, 26522a2, 98dbb95, 6012a32). Verifier APPROVED all 5 ACs; code reviewer CLEAN.

## Files in Scope
- `shared/types/approvals.ts` (ApproveRestOfRunInput / ApproveRestOfRunResult)
- `main/src/trpc/routers/approvals.ts` (approveRestOfRunHandler with per-run mutex, `WHERE run_id = ? AND status = 'pending'` guard, best-effort iteration, NO-global-approve-all comment)
- `main/src/orchestrator/trpc/routers/approvals.ts` (approveRestOfRun protectedProcedure stub pending ctx.db wiring per approval-router epic)
- `main/src/trpc/__tests__/approvals.test.ts` (3 tests including runtime sweep)
- `frontend/src/components/PendingApprovalCard.tsx` (group Approve = single atomic mutation)
- `frontend/src/components/__tests__/PendingApprovalCard.test.tsx` (asserts approveRestOfRun called once; per-item approve never called)

## Verification
- Tests: 3/3 approvals.test.ts, 30/30 PendingApprovalCard.test.tsx, 227/227 main, 99/99 frontend
- Typecheck + lint: PASS
- Sweep: 0 matches for `approveAll|approve_all|approveGlobal` outside `__tests__`
- Visual: mobile skipped (user pref); web skipped_unable per-task — deferred to sprint-level verifier

## Findings
No new findings. Pre-existing open items unrelated to this task remain queued for compounder.
