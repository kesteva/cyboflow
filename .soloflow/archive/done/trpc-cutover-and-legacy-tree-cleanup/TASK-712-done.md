---
id: TASK-712
sprint: SPRINT-035
epic: trpc-cutover-and-legacy-tree-cleanup
status: done
summary: "Wire cyboflow.runs.start tRPC mutation via setStartRunDeps (Pattern B); delegate to runLauncher.launch + sessionManager.getProjectById."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-712 — Done

Implemented `cyboflow.runs.start` (was `NOT_IMPLEMENTED`) using Pattern B (module-level `setStartRunDeps`) mirroring the existing `setCancelDeps` / `setCancelAndRestartDeps` precedent. Defined narrow `RunLauncherLike` / `SessionManagerLike` / `StartRunDeps` interfaces locally in `runs.ts`. The procedure asserts `FORBIDDEN` (non-local userId), `METHOD_NOT_SUPPORTED` (deps unwired), `NOT_FOUND` (project missing), then delegates to `runLauncher.launch(workflowId, project.path)` and returns `{ runId, worktreePath, branchName }`.

## Outcomes
- Executor: COMPLETED (commit `b57bf72`).
- Verifier: APPROVED — all 8 ACs MET; resolved FIND-SPRINT-035-5 (executor mislabeled router.test.ts as out-of-scope).
- Code-reviewer: CLEAN — no findings; security clean (Zod input validation; project lookup through SessionManager).
- Test-writer: TESTS_WRITTEN (commit `cd8ed34`) — added 3 procedure-level integration tests (happy-path, FORBIDDEN, NOT_FOUND) since `runs.start` has no extracted handler (unlike `cancel`). 672 tests pass.

## Files
- Updated: `main/src/orchestrator/trpc/routers/runs.ts`
- Updated: `main/src/index.ts`
- Updated: `main/src/orchestrator/trpc/__tests__/router.test.ts`
- Updated: `main/src/orchestrator/trpc/routers/__tests__/runs.test.ts`
