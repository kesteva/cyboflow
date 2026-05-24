---
id: TASK-711
sprint: SPRINT-035
epic: orchestrator-and-trpc-router
status: done
summary: "Wire cyboflow.workflows.list and .get to WorkflowRegistry via ctx.workflowRegistry; preserve auto-seed of 5 SoloFlow defaults."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-711 — Done

Implemented `cyboflow.workflows.list` and `.get` (both were `NOT_IMPLEMENTED` stubs). Extended `ContextDeps` with `workflowRegistry?: WorkflowRegistryLike` (narrow structural interface so the tRPC subtree never depends on the concrete `WorkflowRegistry` class). `list` preserves the auto-seed behavior via `buildDefaultSoloFlowWorkflows` + `resolveSoloFlowPluginRoot`. `get` returns the matching row or throws `TRPCError NOT_FOUND`. Both procedures throw `PRECONDITION_FAILED` when `ctx.workflowRegistry` is undefined.

## Outcomes
- Executor: COMPLETED (commits `3a97752`, `cf17f4e`, `7b6e20e`, `4ec564b`, `0113ec6`); resolved FIND-SPRINT-035-3.
- Verifier: APPROVED — all 11 ACs MET; 669 tests pass.
- Code-reviewer: CLEAN — no critical/important findings. One minor (FIND-SPRINT-035-4) queued for compound: cross-router principal-scoping consistency (`runs.*` asserts `ctx.userId === 'local'`, `workflows.*` and `approvals.*` don't). Not a regression — uniform v2 session-token hardening pass.
- Test-writer: NO_TESTS_NEEDED — plan's 5 test_strategy behaviors covered by the executor's 6-test `workflows.test.ts`.

## Files
- Updated: `main/src/orchestrator/trpc/context.ts`
- Updated: `main/src/orchestrator/trpc/routers/workflows.ts`
- Updated: `main/src/index.ts`
- Updated: `main/src/orchestrator/trpc/__tests__/router.test.ts`
- NEW: `main/src/orchestrator/trpc/routers/__tests__/workflows.test.ts`
- Updated: `main/src/orchestrator/trpc/routers/__tests__/runs.test.ts`
