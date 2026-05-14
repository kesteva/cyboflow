---
id: TASK-254
sprint: SPRINT-006
epic: orchestrator-and-trpc-router
status: done
summary: "Add tRPC router skeleton, auth context, 60Hz throttle, and shared AppRouter re-export"
executor_loops: 1
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-254 — Done

## Summary

Built the typed renderer↔orchestrator surface: a tRPC v11 `appRouter` rooted at `cyboflow.*` with four sub-routers (runs, approvals, workflows, events), an injected `Context` carrying a placeholder `userId: 'local'` principal, and a server-side 60Hz async-iterator throttle (`throttleAsyncIterator<T>(source, hz)`) used by the `onStreamEvent` subscription. All query/mutation bodies throw `TRPCError(NOT_IMPLEMENTED)` placeholders for downstream epics; subscriptions yield from an abort-aware placeholder source. The `AppRouter` type is re-exported from `shared/types/trpc.ts` so the renderer can import it without crossing the main/ boundary directly.

## Changes

- `main/src/orchestrator/trpc/context.ts` (new)
- `main/src/orchestrator/trpc/trpc.ts` (new — initTRPC with superjson, publicProcedure, protectedProcedure middleware)
- `main/src/orchestrator/trpc/router.ts` (new — `appRouter` under `cyboflow` namespace, `type AppRouter`)
- `main/src/orchestrator/trpc/routers/runs.ts` (new — list, start, cancel, get)
- `main/src/orchestrator/trpc/routers/approvals.ts` (new — listPending, approve, reject)
- `main/src/orchestrator/trpc/routers/workflows.ts` (new — list, get)
- `main/src/orchestrator/trpc/routers/events.ts` (new — onStreamEvent, onApprovalCreated; throttle wired at 60Hz)
- `main/src/orchestrator/trpc/throttle.ts` (new — latest-wins coalescing, setInterval(1000/hz), backpressure)
- `main/src/orchestrator/trpc/__tests__/throttle.test.ts` (new — 2 tests, fake timers)
- `main/src/orchestrator/trpc/__tests__/router.test.ts` (new — 13 tests including subscription placeholder semantics)
- `shared/types/trpc.ts` (new — type-only AppRouter re-export)

## Commits

- `33fb4b8 feat(TASK-254): add tRPC router skeleton with auth context and sub-routers`
- `17255f9 feat(TASK-254): add throttleAsyncIterator 60Hz coalescing utility`
- `27c6d2d feat(TASK-254): re-export AppRouter from shared/types/trpc.ts`
- `7818ac5 test(TASK-254): add throttle rate-cap/coalescing and router shape tests`
- `6dcf088 fix(TASK-254): resolve require-yield ESLint error in makePlaceholderAsyncIterator` (verifier retry)
- `138a9aa test(TASK-254): add subscription placeholder semantics tests`

## Verification

- All 15 TASK-254 tests pass (throttle 2/2, router 13/13)
- `pnpm --filter main typecheck` exit 0
- `pnpm --filter main lint` 0 errors / 228 warnings (baseline preserved)
- 10/10 acceptance criteria met
- Standalone-typecheck invariant intact: 0 electron imports under `main/src/orchestrator/trpc/`
- Code review: CLEAN (2 minor findings, FIND-SPRINT-006-5/6 logged for compound)

## Notes

- Verifier retry: initial run flagged a require-yield lint error in events.ts; fix landed in 6dcf088 (placeholder iterator converted to non-generator-returning function with scoped eslint-disable on the inner generator).
- FIND-SPRINT-006-4: pre-existing better-sqlite3 NODE_MODULE_VERSION mismatch (136 vs 137) blocks 22 unrelated tests — environmental, not regression.
- FIND-SPRINT-006-6: frontend/tsconfig.json lacks `../shared` path; will block renderer-side AppRouter import in the next epic task.
