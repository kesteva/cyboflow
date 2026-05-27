---
id: TASK-777
sprint: SPRINT-041
epic: orchestrator-and-trpc-router
status: done
summary: "Removed dead _getQueueForRun param from both routers + 18 test call sites; rationale comment about §no-recursive-enqueue; approvalRouter.test.ts barriers rewired."
executor_loops: 0
code_review_rounds: 1
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-777 — Remove dead `_getQueueForRun` constructor param

## Outcome

Closed FIND-SPRINT-039-20: both routers narrowed to single-arg constructors and `static initialize`. Rationale comment on each constructor encodes the `§no-recursive-enqueue` invariant. 11 files touched (one expanded via FIND-SPRINT-041-4: `tests/helpers/cyboflowTestHarness.ts` had a direct `new ApprovalRouter(db, factory)` that required the same narrowing for typecheck). Code-review round 1 surfaced a dead-barrier issue in approvalRouter.test.ts (FIND-SPRINT-041-5: `qf.getOrCreate(runId).onIdle()` calls were no-ops after the param was removed) — fixed by swapping to `router['getApprovalQueue'](runId).onIdle()`.

## Changes

- `main/src/orchestrator/approvalRouter.ts`, `questionRouter.ts` — constructor + initialize narrowed; rationale JSDoc added.
- `main/src/index.ts` — `setCancelAndRestartDeps` and `XxxRouter.initialize(db)` calls.
- 7 test files in files_owned + `tests/helpers/cyboflowTestHarness.ts` — 18+ call sites updated; dead `makeQueueFactory` helpers removed; `PQueue` imports removed where unused; `RunQueueRegistry` imports removed where unused.
- `main/src/orchestrator/__tests__/approvalRouter.test.ts` (round 1) — 14 standalone `qf.getOrCreate(runId).onIdle()` + 2 dual-run Promise.all barriers swapped to `router['getApprovalQueue'](runId).onIdle()`; `makeQueueFactory` helper removed.

## Commits

- `d13964e` refactor(TASK-777): remove dead _getQueueForRun constructor param from ApprovalRouter and QuestionRouter
- `c7a315d` refactor(TASK-777): narrow ApprovalRouter.initialize and QuestionRouter.initialize to 1-arg in index.ts
- `76bc32d` test(TASK-777): update all 18+ Router.initialize call sites in test files to 1-arg form
- `65af958` chore(TASK-777): remove dead makeQueueFactory/RunQueueRegistry dead code from test files
- `2f1137f` fix(TASK-777): replace dead qf synchronization barriers in approvalRouter.test.ts

## Tests

- pnpm --filter main test: 79 files, 736/736 pass.
- typecheck: clean across 3 workspaces.
- lint: 0 errors.

## Findings

- FIND-SPRINT-041-4 (executor scope deviation, resolved) — tests/helpers/cyboflowTestHarness.ts narrowed.
- FIND-SPRINT-041-5 (code-reviewer, resolved in round 1) — dead `qf` barriers replaced with real-queue observation.
