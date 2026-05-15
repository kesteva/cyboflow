---
id: TASK-604
idea: SPRINT-009-compound
status: ready
created: 2026-05-15T00:00:00Z
files_owned:
  - main/src/orchestrator/__test_fixtures__/dbAdapter.ts
  - main/src/orchestrator/__tests__/workflowRegistry.test.ts
  - main/src/orchestrator/__tests__/runLauncher.test.ts
  - main/src/ipc/__tests__/cyboflow.test.ts
  - tests/helpers/cyboflowTestHarness.ts
files_readonly:
  - main/src/orchestrator/types.ts
  - .soloflow/active/findings/SPRINT-009-findings.md
acceptance_criteria:
  - criterion: "A new fixture module exports `dbAdapter` returning a `DatabaseLike` over a `better-sqlite3.Database`"
    verification: "test -f main/src/orchestrator/__test_fixtures__/dbAdapter.ts && grep -nE 'export function dbAdapter|export const dbAdapter' main/src/orchestrator/__test_fixtures__/dbAdapter.ts returns at least one match"
  - criterion: "The fixture's return type is statically asserted to be `DatabaseLike` (compile-time check enforces conformance)"
    verification: "grep -nE ': DatabaseLike' main/src/orchestrator/__test_fixtures__/dbAdapter.ts returns at least one match (return type annotation OR a `satisfies DatabaseLike` clause OR `const _check: DatabaseLike = dbAdapter(...)` style assert)"
  - criterion: "All 4 prior inline `dbAdapter` definitions are replaced by an import from the new fixture"
    verification: "grep -rn 'function dbAdapter\\|const dbAdapter = (' main/src/orchestrator/__tests__/workflowRegistry.test.ts main/src/orchestrator/__tests__/runLauncher.test.ts main/src/ipc/__tests__/cyboflow.test.ts tests/helpers/cyboflowTestHarness.ts returns 0 matches"
  - criterion: "Each migrated file imports `dbAdapter` from the new fixture"
    verification: "grep -rnE \"from '.*__test_fixtures__/dbAdapter'|from '.*dbAdapter'\" main/src/orchestrator/__tests__/workflowRegistry.test.ts main/src/orchestrator/__tests__/runLauncher.test.ts main/src/ipc/__tests__/cyboflow.test.ts tests/helpers/cyboflowTestHarness.ts returns 4 matches"
  - criterion: "All affected test suites continue to pass"
    verification: "pnpm --filter main exec vitest run src/orchestrator/__tests__/workflowRegistry.test.ts src/orchestrator/__tests__/runLauncher.test.ts src/ipc/__tests__/cyboflow.test.ts exits 0 AND pnpm test:gate exits 0 (or skip-pass)"
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: false
  justification: "This is a fixture-extraction refactor with no behavior change; sibling tests (workflowRegistry.test.ts, runLauncher.test.ts, cyboflow.test.ts, cyboflow-day3-gate.spec.ts) are the regression surface and are listed in files_owned. The compile-time `: DatabaseLike` annotation IS the test for the fixture itself — if a future change to DatabaseLike breaks the adapter, typecheck fails. No new runtime test is needed."
---

# Extract shared dbAdapter() test helper

## Objective

Four test files (`workflowRegistry.test.ts:73-79`, `runLauncher.test.ts:66-72`, `cyboflow.test.ts:77-83`, `cyboflowTestHarness.ts:137-140`) each define an identical `dbAdapter` helper that wraps a `better-sqlite3.Database` to satisfy the orchestrator's `DatabaseLike` interface. Drift is inevitable: any future change to `DatabaseLike` (e.g. add `pragma()`) requires updating all 4 sites. This task extracts the helper into a single fixture module with a compile-time conformance check, paired with TASK-603's REGISTRY_SCHEMA extraction.

## Implementation Steps

1. Create `main/src/orchestrator/__test_fixtures__/dbAdapter.ts`:
   ```ts
   /**
    * Shared dbAdapter test fixture — wraps a better-sqlite3 Database so it
    * satisfies the orchestrator's DatabaseLike interface. The compile-time
    * `: DatabaseLike` return type ensures any future widening of DatabaseLike
    * fails the build here, not in 4 silently-drifting test copies.
    */
   import type Database from 'better-sqlite3';
   import type { DatabaseLike } from '../types';

   export function dbAdapter(db: Database.Database): DatabaseLike {
     return {
       prepare: (sql: string) => db.prepare(sql),
       transaction: <T>(fn: (...args: unknown[]) => T) =>
         db.transaction(fn as (...args: unknown[]) => T) as (...args: unknown[]) => T,
     };
   }
   ```
2. Replace each of the 4 inline `dbAdapter` definitions with an import:
   - `main/src/orchestrator/__tests__/workflowRegistry.test.ts:73-79` → `import { dbAdapter } from '../__test_fixtures__/dbAdapter';`
   - `main/src/orchestrator/__tests__/runLauncher.test.ts:66-72` → same import
   - `main/src/ipc/__tests__/cyboflow.test.ts:77-83` → `import { dbAdapter } from '../../orchestrator/__test_fixtures__/dbAdapter';`
   - `tests/helpers/cyboflowTestHarness.ts:137-140` → `import { dbAdapter } from '../../main/src/orchestrator/__test_fixtures__/dbAdapter';` and replace the `const dbLike: DatabaseLike = { ... }` block with `const dbLike = dbAdapter(db);`
3. Verify each migrated file still typechecks: `pnpm --filter main typecheck`.
4. Run the affected test files: `pnpm --filter main exec vitest run src/orchestrator/__tests__/workflowRegistry.test.ts src/orchestrator/__tests__/runLauncher.test.ts src/ipc/__tests__/cyboflow.test.ts`. All must exit 0.
5. Run `pnpm test:gate` to confirm `cyboflowTestHarness.ts` still works in the integration path. Skip-pass if claude is not installed; non-zero exit blocks.

## Acceptance Criteria

See frontmatter. The compile-time `: DatabaseLike` annotation on the helper return type is the load-bearing check — without it, the fixture could silently drift from the interface and tests would still pass against a stale shape.

## Test Strategy

`needed: false` — refactor, no new behavior. Pairs with TASK-603 (REGISTRY_SCHEMA fixture) and TASK-605 (`withTempDir` helper) to consolidate all four test files' boilerplate into a small fixtures module.

## Hardest Decision

Whether to expose `dbAdapter` as a function vs. a class. Picked function because the existing 4 copies are functions, the call-site shape is `dbAdapter(db)` everywhere, and a class adds construction ceremony with no benefit. The compile-time return-type annotation is the conformance check; no class needed.

## Rejected Alternatives

- **Add `dbAdapter` as a method on a `TestDb` class.** Rejected — adds construction ceremony for zero benefit; existing call sites all use the function form.
- **Make `dbAdapter` generic over a constrained `MinimalDb` instead of taking `better-sqlite3.Database` specifically.** Rejected because all 4 existing call sites pass `Database.Database` directly; generic-over-min-shape is over-engineering for one consumer family.

## Lowest Confidence Area

Whether the relative import path `from '../../main/src/orchestrator/__test_fixtures__/dbAdapter'` from `tests/helpers/cyboflowTestHarness.ts` works under the gate test's vitest config. The config uses `root: repoRoot` and the alias `@` maps to `main/src/`, so the relative path should be valid. If not, switch to the alias: `from '@/orchestrator/__test_fixtures__/dbAdapter'`.
