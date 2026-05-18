---
id: TASK-633
idea: SPRINT-015-compound
status: ready
created: "2026-05-18T00:00:00Z"
files_owned:
  - main/src/orchestrator/__tests__/cancelAndRestart.test.ts
  - main/src/orchestrator/__tests__/approvalRouter.test.ts
  - main/src/orchestrator/__tests__/stuckDetector.test.ts
  - main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts
files_readonly:
  - main/src/orchestrator/__test_fixtures__/dbAdapter.ts
  - main/src/orchestrator/types.ts
  - main/src/orchestrator/__tests__/inspectorQueries.test.ts
  - main/src/trpc/__tests__/approvals.test.ts
  - main/src/orchestrator/__tests__/workflowRegistry.test.ts
  - main/src/orchestrator/__tests__/runLauncher.test.ts
  - main/src/ipc/__tests__/cyboflow.test.ts
acceptance_criteria:
  - criterion: "All four target files import dbAdapter from the canonical fixture and contain zero local function dbAdapter definitions"
    verification: "grep -rn 'function dbAdapter' main/src/orchestrator/__tests__/cancelAndRestart.test.ts main/src/orchestrator/__tests__/approvalRouter.test.ts main/src/orchestrator/__tests__/stuckDetector.test.ts main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts returns 0 matches"
  - criterion: "Each of the four target files imports the canonical dbAdapter"
    verification: "grep -l \"from '\\.\\./__test_fixtures__/dbAdapter'\\|from '\\.\\./\\.\\./__test_fixtures__/dbAdapter'\" main/src/orchestrator/__tests__/cancelAndRestart.test.ts main/src/orchestrator/__tests__/approvalRouter.test.ts main/src/orchestrator/__tests__/stuckDetector.test.ts main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts | wc -l returns 4"
  - criterion: "Repo-wide, only the canonical fixture defines function dbAdapter — narrow exceptions for inspectorQueries.test.ts (uses InspectorDb shape) and trpc/__tests__/approvals.test.ts (uses narrower shape) remain"
    verification: "grep -rln 'function dbAdapter' main/src | sort returns exactly these 3 paths: main/src/orchestrator/__test_fixtures__/dbAdapter.ts, main/src/orchestrator/__tests__/inspectorQueries.test.ts, main/src/trpc/__tests__/approvals.test.ts"
  - criterion: "main workspace tests exit 0"
    verification: "pnpm --filter main test exits 0"
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: false
  justification: "Refactor only — replaces 4 identical inline copies with an import of an already-tested canonical fixture. The existing test suites in each touched file ARE the regression check; if any imported dbAdapter shape mismatches, those test files fail to typecheck or fail at runtime. No new behavior; no new tests warranted. Sibling-test scan: no separate sibling test files exist for these test files (tests testing tests is an anti-pattern). The canonical fixture's compile-time `: DatabaseLike` return ensures any future widening of DatabaseLike fails the build at the fixture, not in drift copies."
---

# Complete dbAdapter extraction to remaining 4 test files

## Objective

TASK-604 introduced the canonical `dbAdapter` fixture at `main/src/orchestrator/__test_fixtures__/dbAdapter.ts` and migrated `workflowRegistry.test.ts`, `runLauncher.test.ts`, `cyboflow.test.ts` to import it. Four other test files still carry byte-identical inline copies of the helper: `cancelAndRestart.test.ts:51-57`, `approvalRouter.test.ts:59-69`, `stuckDetector.test.ts:90-96`, and `mcpServer/__tests__/mcpQueryHandler.test.ts:90-96`. Replace each inline definition with an import from the canonical fixture. Two other files (`inspectorQueries.test.ts` and `trpc/__tests__/approvals.test.ts`) use intentionally narrower bespoke shapes (`InspectorDb` and a custom `{ prepare: { all, run } }` shape respectively) and are excluded — see Plan Decisions below.

## Plan Decisions

- **Excluded: `main/src/orchestrator/__tests__/inspectorQueries.test.ts`.** The local `dbAdapter` returns `{ prepare<Row>(sql): { get, all } }` to satisfy the `InspectorDb` interface defined in `main/src/trpc/routers/runs.ts:41`. The canonical fixture returns `DatabaseLike` which has a different `prepare`/`transaction` shape. Unifying would require either widening `InspectorDb` (out of scope, behavior change) or introducing a second canonical adapter (yagni until a third InspectorDb consumer appears). Leave as-is.
- **Excluded: `main/src/trpc/__tests__/approvals.test.ts`.** Local `dbAdapter` returns `{ prepare: (sql) => { all, run } }` — a narrow approveRestOfRun-specific shape with no `transaction` or `get`. Same rationale: shape mismatch, single consumer.

## Implementation Steps

1. **Pre-flight grep — confirm the 4 in-scope files have the inline pattern; confirm 2 excluded files have shape-divergent copies:**
   ```
   grep -rn 'function dbAdapter' main/src
   ```
   Expected 7 matches: 1 in `__test_fixtures__/dbAdapter.ts` (canonical) + 4 inline (in-scope) + 2 inline (excluded — inspectorQueries, trpc/approvals).

2. **Edit `main/src/orchestrator/__tests__/cancelAndRestart.test.ts`.**
   - Add at the top of the import block (after the existing `RunQueueRegistry` import on line 32): `import { dbAdapter } from '../__test_fixtures__/dbAdapter';`
   - Delete lines 51–57 (the inline `function dbAdapter(db: Database.Database): DatabaseLike { ... }` block).
   - The local `DatabaseLike` import on line 33 (`import type { DatabaseLike } from '../types';`) becomes unused IF no other reference exists in the file — verify with `grep -n 'DatabaseLike' main/src/orchestrator/__tests__/cancelAndRestart.test.ts`. If 0 matches after deletion, drop the import; otherwise keep it.

3. **Edit `main/src/orchestrator/__tests__/approvalRouter.test.ts`.**
   - Add after the `import type { DatabaseLike } from '../types';` line (31): `import { dbAdapter } from '../__test_fixtures__/dbAdapter';`
   - Delete lines 55–69 (the section header comment `Build a DatabaseLike adapter ...` block plus the `function dbAdapter(...)` definition; keep the database helper comment block above it intact).
   - Re-run the same `grep -n 'DatabaseLike'` check; drop the now-unused type import only if there are no remaining references.

4. **Edit `main/src/orchestrator/__tests__/stuckDetector.test.ts`.**
   - Add after the existing `import type { DatabaseLike, LoggerLike } from '../types';` line (36): `import { dbAdapter } from '../__test_fixtures__/dbAdapter';`
   - Delete lines 87–96 (the `/** Build a DatabaseLike adapter ... */` block plus the inline function).
   - `DatabaseLike` is still needed for the `LoggerLike` import line — keep the import as-is.

5. **Edit `main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts`.**
   - The relative path is one level deeper. Add: `import { dbAdapter } from '../../__test_fixtures__/dbAdapter';`
   - Delete lines 90–96 (the inline `function dbAdapter(...)` definition).
   - The `import type { DatabaseLike } from '../../types';` on line 25 may be unused after the deletion — check with grep on this file alone and remove if 0 matches.

6. **Run the completeness gate (this is the AC grep, re-run as step 1):**
   ```
   grep -rn 'function dbAdapter' main/src/orchestrator/__tests__/cancelAndRestart.test.ts main/src/orchestrator/__tests__/approvalRouter.test.ts main/src/orchestrator/__tests__/stuckDetector.test.ts main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts
   ```
   Expected 0 matches.

7. **Run `pnpm --filter main test`** — expect exit 0. All four test suites must continue to pass with no behavior change.

8. **Run `pnpm --filter main typecheck`** — expect exit 0. The canonical fixture's `: DatabaseLike` return type must align with each call site; if not, the type-error message will pinpoint the mismatch.

## Acceptance Criteria

- All four target files import `dbAdapter` from the canonical fixture.
- Zero `function dbAdapter` definitions remain in the four target files.
- Repo-wide grep limits `function dbAdapter` to: 1 canonical + 2 documented exceptions (inspectorQueries, trpc/approvals).
- `pnpm --filter main test` exits 0.

## Hardest Decision

Whether to also migrate `inspectorQueries.test.ts` to the canonical fixture. Decided against because the consumer (`getStuckInspectionHandler`) explicitly takes `InspectorDb` (a narrower read-only shape with generic `prepare<Row>`), not `DatabaseLike`. Forcing a unification would require either widening `InspectorDb` (behavior change to the production handler — out of scope) or producing a second canonical fixture (premature abstraction — single consumer today). Documented the exclusion in plan_decisions so it doesn't get re-litigated.

## Rejected Alternatives

- **Narrow the canonical fixture to a base interface** and have each test compose with overrides. Rejected: adds layers without solving the immediate problem (5 drifting inline copies). Worth revisiting if a 3rd `InspectorDb`-like consumer appears.
- **Inline a single shared file but keep the `DatabaseLike`/`InspectorDb` adapter separate.** Rejected for the same reason; the canonical fixture already exists and the four in-scope files have byte-identical bodies returning `DatabaseLike` — no architectural decision needed.

## Lowest Confidence Area

The `DatabaseLike` type import in each touched file may become unused after deletion. The plan instructs a follow-up grep before removing it (some tests reference `DatabaseLike` in type annotations elsewhere). Conservatively keeping the import causes only a TS6133 warning if unused — `pnpm typecheck` will catch it.
