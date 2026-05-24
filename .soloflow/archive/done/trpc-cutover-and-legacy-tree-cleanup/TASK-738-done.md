---
id: TASK-738
sprint: SPRINT-036
epic: trpc-cutover-and-legacy-tree-cleanup
status: done
summary: "Demote cyboflow.runs.cancel to throwNotImplemented stub; delete dead CancelDeps/setCancelDeps/cancelHandler surface."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-738 — Done

## Summary
Demoted `cyboflow.runs.cancel` to `.mutation(() => throwNotImplemented('workflow-runs'))`. Removed the never-wired DI surface (`CancelDeps` interface, `cancelDeps` singleton, `setCancelDeps` setter, `cancelHandler` function — ~90 LOC in `runs.ts`) and the corresponding `describe('cancelHandler', ...)` block + imports in `runLifecycle.test.ts` (~180 LOC). Orphan imports (`TERMINAL_RUN_STATUSES_SQL_IN`, `DatabaseLike`, `LoggerLike`, `ApprovalRouter`) pruned. Frontend has zero callers of bare `cyboflow.runs.cancel` — no regression. `cancelAndRestart` flow preserved.

## Verification
- `pnpm --filter main test` → 650/650 pass.
- `pnpm --filter main typecheck` → 0 errors.
- All seven acceptance criteria pass (grep + test gates).
- Coverage: existing `router.test.ts:98-102` (`cyboflow.runs.cancel throws NOT_IMPLEMENTED`) already exercises the new stub via the same `METHOD_NOT_SUPPORTED` assertion.
- Visual verification: not_applicable — backend tRPC router change.

## Code Review
CLEAN. Pre-existing minor docblock drift in `runs.ts:1-10` ("All procedure bodies are deliberate not-implemented placeholders") noted as out-of-scope — predates this task.

## Commit
- `fac9d4f` — `refactor(TASK-738): demote cyboflow.runs.cancel to throwNotImplemented stub`
