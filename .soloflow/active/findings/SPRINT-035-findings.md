---
sprint: SPRINT-035
pending_count: 2
last_updated: "2026-05-23T23:10:00.000Z"
---
# Findings Queue

## FIND-SPRINT-035-1
- **source:** TASK-709 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** shared/types/stuckInspection.ts:5
- **description:** The header docblock still names `main/src/trpc/routers/runs.ts (getStuckInspectionHandler + re-export)` as the handler's home and lists "an import cycle that would otherwise exist between the two router files." After TASK-709, the handler now lives in `main/src/orchestrator/inspectorQueries.ts`, the legacy `main/src/trpc/routers/runs.ts` no longer hosts it, and the cycle motivation is obsolete. The file is out of TASK-709's diff (in `files_readonly`), so the stale comment was not corrected in this task. TASK-717 (legacy-tree deletion) is a natural place to refresh this header — at that point the bullet list collapses to a single canonical handler location.
- **suggested_action:** When TASK-717 runs, rewrite the file-header docblock to list `main/src/orchestrator/inspectorQueries.ts` as the handler home and drop the import-cycle paragraph (cycle no longer possible — legacy tree is gone).
- **resolved_by:** 

## FIND-SPRINT-035-2
- **type:** bug
- **source:** TASK-710 (executor)
- **severity:** medium
- **status:** resolved
- **location:** main/src/orchestrator/trpc/__tests__/router.test.ts:87,143
- **description:** TASK-710 changed cyboflow.runs.list input schema from z.object({ projectId: z.string().optional() }) to z.object({ projectId: z.number().int().positive() }). Two tests in router.test.ts (owned by TASK-711) now fail: (1) line 87 passes {} and expects METHOD_NOT_SUPPORTED but gets BAD_REQUEST; (2) line 143 same call expects METHOD_NOT_SUPPORTED code. Both tests also fail TypeScript type checking. TASK-711 must update or remove these two stale assertions when it modifies router.test.ts.
- **suggested_action:** In TASK-711, update or remove the two runs.list stale assertions in router.test.ts: the test at line 87 (cyboflow.runs.list throws NOT_IMPLEMENTED) and the test at line 139 (protectedProcedure accepts a context — asserts METHOD_NOT_SUPPORTED from runs.list({})).
- **resolved_by:** verifier — AC-prescribed: TASK-710's AC9 (pnpm typecheck must exit 0) forced the consumer-test edit in commit 2742847; assertions at lines 87 and 141 were updated/removed to match the new input schema, and the full main test suite (662 tests) now passes. The follow-up TASK-711 no longer needs to fix these — it can pick up other tests in router.test.ts.

## FIND-SPRINT-035-3
- **source:** TASK-710 (code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/trpc/__tests__/router.test.ts:87-90
- **description:** The router.test.ts comment claims `cyboflow.runs.list`'s tRPC wrapper guards (FORBIDDEN when `ctx.userId !== 'local'`, PRECONDITION_FAILED when `!ctx.db`) "are covered by integration tests that build a real DB context" — but no such integration test currently exists for `runs.list`. The handler is well covered by `listRunsHandler.test.ts` (4 unit tests), but the guard branches are uncovered. The sibling `runs.getStuckInspection` procedure has parallel guard tests in `main/src/orchestrator/trpc/routers/__tests__/runs.test.ts:158-200` (cases c + d) that mirror exactly what `runs.list` needs. Risk is low because the guard code is mechanically identical to the sibling (same import, same TRPCError codes, same `ctx.userId` / `ctx.db` checks), but the comment overstates the current state.
- **suggested_action:** Add `(c) non-local userId → FORBIDDEN` and `(d) missing ctx.db → PRECONDITION_FAILED` cases to `main/src/orchestrator/trpc/routers/__tests__/runs.test.ts` exercising `caller.cyboflow.runs.list({ projectId: 1 })` — mirroring the existing `getStuckInspection` cases at lines 158-200. Natural pickup for TASK-711 (router.test.ts cleanup task) since it already touches that test directory.
- **resolved_by:**
