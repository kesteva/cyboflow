---
id: TASK-709
sprint: SPRINT-035
epic: orchestrator-and-trpc-router
status: done
summary: "Wire cyboflow.runs.getStuckInspection to its canonical handler via ctx.db; port handler into orchestrator subtree."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-709 — Done

Replaced the `NOT_IMPLEMENTED` stub at `main/src/orchestrator/trpc/routers/runs.ts:getStuckInspection` with a live handler invocation. Ported `getStuckInspectionHandler` from the legacy tree (`main/src/trpc/routers/runs.ts`) into a new orchestrator-subtree file `main/src/orchestrator/inspectorQueries.ts`, typed against `DatabaseLike` from `orchestrator/types.ts` (no electron / better-sqlite3 / services value imports). Procedure now asserts `ctx.userId === 'local'` (FORBIDDEN), `ctx.db` defined (PRECONDITION_FAILED), and maps handler null to `TRPCError NOT_FOUND`.

## Outcomes
- Executor: COMPLETED (commit `42539f0`).
- Verifier: APPROVED — all 8 ACs MET; visual not_applicable (backend tRPC handler).
- Code-reviewer: CLEAN — no critical/important/minor findings; queued FIND-SPRINT-035-1 for TASK-717 (stale comment in `shared/types/stuckInspection.ts`).
- Test-writer: NO_TESTS_NEEDED — plan's 4 integration tests already added by executor; 4/4 passing; 6/6 handler-level tests still passing.

## Files
- NEW: `main/src/orchestrator/inspectorQueries.ts`
- NEW: `main/src/orchestrator/trpc/routers/__tests__/runs.test.ts`
- Updated: `main/src/orchestrator/trpc/routers/runs.ts`
- Updated: `main/src/orchestrator/__tests__/inspectorQueries.test.ts`
- Updated: `main/src/trpc/routers/runs.ts` (handler removed; redirect comment only)
