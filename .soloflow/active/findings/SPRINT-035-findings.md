---
sprint: SPRINT-035
pending_count: 2
last_updated: "2026-05-23T23:25:00.000Z"
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
- **status:** resolved
- **location:** main/src/orchestrator/trpc/__tests__/router.test.ts:87-90
- **description:** The router.test.ts comment claims `cyboflow.runs.list`'s tRPC wrapper guards (FORBIDDEN when `ctx.userId !== 'local'`, PRECONDITION_FAILED when `!ctx.db`) "are covered by integration tests that build a real DB context" — but no such integration test currently exists for `runs.list`. The handler is well covered by `listRunsHandler.test.ts` (4 unit tests), but the guard branches are uncovered. The sibling `runs.getStuckInspection` procedure has parallel guard tests in `main/src/orchestrator/trpc/routers/__tests__/runs.test.ts:158-200` (cases c + d) that mirror exactly what `runs.list` needs. Risk is low because the guard code is mechanically identical to the sibling (same import, same TRPCError codes, same `ctx.userId` / `ctx.db` checks), but the comment overstates the current state.
- **suggested_action:** Add `(c) non-local userId → FORBIDDEN` and `(d) missing ctx.db → PRECONDITION_FAILED` cases to `main/src/orchestrator/trpc/routers/__tests__/runs.test.ts` exercising `caller.cyboflow.runs.list({ projectId: 1 })` — mirroring the existing `getStuckInspection` cases at lines 158-200. Natural pickup for TASK-711 (router.test.ts cleanup task) since it already touches that test directory.
- **resolved_by:** TASK-711

## FIND-SPRINT-035-4
- **source:** TASK-711 (code-reviewer)
- **type:** anti-pattern
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/trpc/routers/workflows.ts:21,41 and main/src/orchestrator/trpc/routers/approvals.ts (whole file)
- **description:** Principal-scoping enforcement is inconsistent across the orchestrator tRPC routers. `runs.ts` re-asserts `ctx.userId !== 'local'` → `TRPCError FORBIDDEN` at the top of every procedure (list, cancel, cancelAndRestart, getStuckInspection — 4 sites), but the newly-implemented `workflows.list`/`workflows.get` (TASK-711) and the live `approvals.*` procedures rely only on `protectedProcedure`'s `userId` truthiness check. In v1 this is functionally equivalent because `createContext()` hard-codes `'local'`, but the docblock in `context.ts` explicitly anticipates a v2 team-tier swap that replaces `'local'` with a real session principal — at that point the workflows + approvals procedures would silently lose principal scoping while the runs procedures retain it. The TASK-711 plan ACs did not require this guard, so its omission is consistent with the plan and not a TASK-711 regression — it is a pre-existing project-wide inconsistency that the new procedures inherit.
- **suggested_action:** When the v2 session-token swap is planned (or sooner — under a small "tRPC principal-scoping hardening" task), choose one canonical pattern (either lift the `userId !== 'local'` check into a `localOnlyProcedure = protectedProcedure.use(...)` middleware reused everywhere, or remove it from `runs.ts` if it is redundant with the v2 plan) and apply it uniformly across `routers/runs.ts`, `routers/workflows.ts`, and `routers/approvals.ts`.
- **resolved_by:** 

## FIND-SPRINT-035-5
- **type:** scope_deviation
- **source:** TASK-712 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/orchestrator/trpc/__tests__/router.test.ts:94
- **description:** required to meet AC: test used projectId: string (old stub schema); after runs.start rewire, schema requires z.number().int().positive(). Test also expected NOT_IMPLEMENTED but now METHOD_NOT_SUPPORTED fires when deps absent. Test updated to match new schema and behavior.
- **resolved_by:** verifier — not actually a scope deviation: `main/src/orchestrator/trpc/__tests__/router.test.ts` is listed in TASK-712's `files_owned` (line 9 of plan). The executor mislabeled an in-scope edit as a deviation. The edit is also AC-prescribed (AC8: typecheck must exit 0 — the old `projectId: 'proj-1'` would have type-failed against the new `z.number().int().positive()` schema).
