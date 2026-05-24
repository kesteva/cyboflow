---
id: TASK-710
sprint: SPRINT-035
epic: orchestrator-and-trpc-router
status: done
summary: "Implement cyboflow.runs.list against ctx.db via listRunsHandler; promote WorkflowRunListRow into shared/types/workflows.ts."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-710 — Done

Implemented `cyboflow.runs.list` (was `NOT_IMPLEMENTED`) by extracting a pure `listRunsHandler(db, projectId): WorkflowRunListRow[]` into `main/src/orchestrator/runQueries.ts` and wiring the tRPC procedure to call it through `ctx.db`. Added the `WorkflowRunListRow` interface to `shared/types/workflows.ts`. SQL projection matches the legacy raw-IPC handler at `main/src/ipc/cyboflow.ts` byte-for-byte (excluding `policy_json`).

## Outcomes
- Executor: COMPLETED (commits `668e765`, `60ba915`).
- Orchestrator caller-update: `2742847` — patched two stale `runs.list` stubs in `router.test.ts` after the procedure went live (AC9 prescribed via typecheck pass).
- Verifier: APPROVED — all 9 ACs MET; flagged caller-update as AC-prescribed scope deviation; resolved FIND-SPRINT-035-2.
- Code-reviewer: CLEAN — no critical/important. One minor (FIND-SPRINT-035-3) queued for compound: wrapper-layer integration tests missing.
- Test-writer: TESTS_WRITTEN (commit `7384c99`) — added 3 integration tests covering happy-path, FORBIDDEN, PRECONDITION_FAILED to close FIND-SPRINT-035-3. All 665 main-workspace tests pass.

## Files
- NEW: `main/src/orchestrator/runQueries.ts`
- NEW: `main/src/orchestrator/__tests__/listRunsHandler.test.ts`
- Updated: `shared/types/workflows.ts`
- Updated: `main/src/orchestrator/trpc/routers/runs.ts`
- Updated: `main/src/orchestrator/trpc/__tests__/router.test.ts`
- Updated: `main/src/orchestrator/trpc/routers/__tests__/runs.test.ts`
