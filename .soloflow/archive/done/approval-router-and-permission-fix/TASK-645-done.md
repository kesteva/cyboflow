---
id: TASK-645
sprint: SPRINT-024
epic: approval-router-and-permission-fix
status: done
summary: "Extracted private decideRestOfRunHandler(db, runId, decision) in approvals.ts; rewrote approve/reject wrappers as 1-line delegations; parameterized SET status; preserved exported names + verbatim log wording. Added 2 error-prefix tests."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

## Summary

Collapsed the approve/reject clone in `main/src/trpc/routers/approvals.ts`. Single `for (const row of rows)` loop inside the new private `decideRestOfRunHandler`. SQL now uses `SET status = ?`. Log prefix derived from the `decision` parameter so `[approveRestOfRun]` / `[rejectRestOfRun]` messages still appear verbatim. Wrappers preserve names + signatures so orchestrator-side TODO grep-replace targets still match.

## Verifier

APPROVED — all 6 ACs met; 8/8 tests pass.

## Code review

CLEAN — no critical/important/minor findings.

## Test-writer

NO_TESTS_NEEDED. Executor already added the 2 required error-prefix tests; test_strategy fully covered.

## Commits

- `e15d9d9 refactor(TASK-645): extract decideRestOfRunHandler to eliminate approve/reject clone`
