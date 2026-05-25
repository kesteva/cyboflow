---
id: TASK-739
sprint: SPRINT-036
epic: orchestrator-and-trpc-router
status: done
summary: "Drop statically-dead ctx.userId !== 'local' FORBIDDEN guards from runs router; paired test cases removed."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-739 — Done

## Summary
Removed the 4 remaining `ctx.userId !== 'local'` FORBIDDEN guards in `runs.ts` (the 5th was already gone via TASK-738's cancel-stub demotion), plus the 3 paired `'someone-else' as 'local'` test cases in `runs.test.ts`. Also cleaned up two stale sibling tests in `inspectorQueries.test.ts` (Case 2 hand-rolled simulation + Case 2b structural-grep that asserted `runs.ts` source contains `ctx.userId` — directly broke after the deletions). `runs.ts` is now consistent with `workflows.ts` and `approvals.ts` — none of the three routers carries a `ctx.userId` check. The v2 swap points (`context.ts:userId: 'local' as const` and `trpc.ts:isAuthed` truthiness gate) are unchanged. Resolves FIND-SPRINT-035-4.

## Verification
- `pnpm --filter main typecheck` → 0 errors.
- `pnpm --filter main test` → 645/645 pass.
- All 8 acceptance criteria pass.
- Visual verification: not_applicable — backend tRPC refactor.

## Execution Notes
The executor's first attempt hit a socket error after completing edits in `runs.ts` + `runs.test.ts` but before committing. Orchestrator resumed: verified the staged state, ran the test suite which surfaced the `inspectorQueries.test.ts` sibling break (out-of-scope file but AC-required for `pnpm --filter main test exits 0`), removed the two stale test blocks and orphan imports, then committed the bundle.

## Code Review
CLEAN. One minor finding queued (FIND-SPRINT-036-2: stale `afterEach` comment in `runs.test.ts` references the now-deleted FORBIDDEN test).

## Commit
- `bfac467` — `refactor(TASK-739): drop dead ctx.userId !== 'local' guards from runs router`
