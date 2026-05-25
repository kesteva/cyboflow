---
id: TASK-740
sprint: SPRINT-036
epic: testing-infrastructure
status: done
summary: "Sweep two remaining local createTestDb declarations onto canonical orchestratorTestDb fixture."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-740 — Done

## Summary
Replaced local `function createTestDb` helpers in `runs.test.ts` and `claudeCodeManager.composeMcpServers.test.ts` with the canonical `createTestDb` from `orchestratorTestDb.ts`. `runs.test.ts` calls `createTestDb({ includeStuckDetectedAt: true })` to preserve migration-007 column presence. Orphan imports (`GATE_SCHEMA`, `readFileSync`, `join`, `SCHEMA_PATH`) pruned. `runs.test.ts` correctly downgrades `import Database` → `import type Database` since its only direct `new Database` use is gone.

## Verification
- `pnpm --filter main test` → 645/645 pass; targeted invocations both green (composeMcpServers 4/4, runs 7/7).
- `pnpm typecheck` → 0 errors.
- `pnpm lint` → 0 errors.
- All six acceptance criteria pass.
- Visual verification: not_applicable — test-file refactor.

## Code Review
CLEAN. One minor finding queued (FIND-SPRINT-036-3: residual runtime `Database` import in `composeMcpServers.test.ts:24` where only the type symbol is used — sibling-file consistency nit).

## Commit
- `b567215` — `refactor(TASK-740): sweep local createTestDb onto canonical orchestratorTestDb fixture`
