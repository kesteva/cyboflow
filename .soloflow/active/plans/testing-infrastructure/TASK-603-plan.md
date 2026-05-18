---
id: TASK-603
idea: SPRINT-009-compound
status: in-flight
created: "2026-05-15T00:00:00Z"
files_owned:
  - main/src/database/__test_fixtures__/registrySchema.ts
  - main/src/orchestrator/__tests__/workflowRegistry.test.ts
  - main/src/orchestrator/__tests__/runLauncher.test.ts
  - main/src/ipc/__tests__/cyboflow.test.ts
  - tests/helpers/cyboflowTestHarness.ts
files_readonly:
  - main/src/database/schema.sql
  - main/src/database/migrations/006_cyboflow_schema.sql
  - .soloflow/active/findings/SPRINT-009-findings.md
acceptance_criteria:
  - criterion: A new fixture module exports `REGISTRY_SCHEMA` and `GATE_SCHEMA` SQL constants
    verification: "test -f main/src/database/__test_fixtures__/registrySchema.ts && grep -nE 'export const REGISTRY_SCHEMA|export const GATE_SCHEMA' main/src/database/__test_fixtures__/registrySchema.ts returns 2 matches"
  - criterion: All four prior copies of REGISTRY_SCHEMA / GATE_SCHEMA are replaced by an import from the new fixture
    verification: "grep -rn 'CREATE TABLE IF NOT EXISTS workflows' main/src/orchestrator/__tests__/workflowRegistry.test.ts main/src/orchestrator/__tests__/runLauncher.test.ts main/src/ipc/__tests__/cyboflow.test.ts tests/helpers/cyboflowTestHarness.ts returns 0 matches (each file imports the constant instead)"
  - criterion: Each migrated file imports REGISTRY_SCHEMA (or GATE_SCHEMA for cyboflowTestHarness.ts) from the new fixture module
    verification: "grep -rnE \"from '.*__test_fixtures__/registrySchema'|from '.*registrySchema'\" main/src/orchestrator/__tests__/workflowRegistry.test.ts main/src/orchestrator/__tests__/runLauncher.test.ts main/src/ipc/__tests__/cyboflow.test.ts tests/helpers/cyboflowTestHarness.ts returns 4 matches"
  - criterion: All affected test files continue to pass
    verification: "pnpm --filter main exec vitest run src/orchestrator/__tests__/workflowRegistry.test.ts src/orchestrator/__tests__/runLauncher.test.ts src/ipc/__tests__/cyboflow.test.ts exits 0; pnpm test:gate exits 0 (or skip-pass)"
  - criterion: "The fixture module's schema agrees with main/src/database/schema.sql for the workflows + workflow_runs tables (no fixture-vs-runtime drift)"
    verification: "manual: diff the column lists for workflows and workflow_runs in main/src/database/__test_fixtures__/registrySchema.ts against main/src/database/schema.sql; they must match identically"
depends_on:
  - TASK-598
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: false
  justification: "This is a refactor of test fixtures, not new behavior. Sibling test files (workflowRegistry.test.ts, runLauncher.test.ts, cyboflow.test.ts, cyboflow-day3-gate.spec.ts) are the existing coverage for any regression — they ARE the test_strategy targets and are listed in files_owned because the imports change. After the refactor, the existing test surfaces must continue to pass; the AC enforces this via the pnpm vitest run command. No new behavior tests are warranted because the fixture module is data-only (no logic to test in isolation)."
---
# Extract shared REGISTRY_SCHEMA SQL fixture (eliminate 4-file DDL drift)

## Objective

Four test files (`workflowRegistry.test.ts:29`, `runLauncher.test.ts:30`, `cyboflow.test.ts:38`, `cyboflowTestHarness.ts:28`) each declare their own copy of the workflows + workflow_runs DDL. Drift is inevitable: TASK-598 reconciles the column shape but only because the planner enumerates all 4 sites; the next contributor adding a column will touch one and miss the others. This task extracts a single shared fixture module so subsequent column additions are made in exactly one place.

## Implementation Steps

1. Run pre-flight grep to confirm the 4 sites: `node scripts/refiner/grep-preflight.js --pattern 'CREATE TABLE IF NOT EXISTS workflows'`. Confirm the result set is exactly the 4 files in `files_owned` plus the canonical `schema.sql` and migration `006`. Plus the new fixture file we are about to create.
2. Create `main/src/database/__test_fixtures__/registrySchema.ts` with two exports:
   ```ts
   /**
    * Shared SQL fixture for cyboflow registry tests.
    *
    * Source of truth: main/src/database/schema.sql (post-TASK-598 reconciliation).
    * Any column added to workflows or workflow_runs in schema.sql MUST be added
    * here too. The fixture intentionally inlines the DDL (rather than reading
    * schema.sql) so the test surface is hermetic — adding a `sentinel-comment
    * slicing of schema.sql` would couple test runtime to the schema file's
    * exact byte layout, which is fragile.
    */
   export const REGISTRY_SCHEMA = `
   CREATE TABLE IF NOT EXISTS workflows (
     ... mirror schema.sql workflows table verbatim ...
   );
   CREATE INDEX IF NOT EXISTS idx_workflows_project_id ON workflows(project_id);

   CREATE TABLE IF NOT EXISTS workflow_runs (
     ... mirror schema.sql workflow_runs table verbatim ...
   );
   CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_created ON workflow_runs(status, created_at);
   CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);
   `;

   /**
    * GATE_SCHEMA extends REGISTRY_SCHEMA with the approvals + raw_events tables
    * needed by the day-3 gate integration harness.
    */
   export const GATE_SCHEMA = REGISTRY_SCHEMA + `
   CREATE TABLE IF NOT EXISTS approvals (...);
   CREATE INDEX IF NOT EXISTS idx_approvals_status_created ON approvals(status, created_at);
   CREATE TABLE IF NOT EXISTS raw_events (...);
   CREATE INDEX IF NOT EXISTS idx_raw_events_run_id ON raw_events(run_id, id);
   `;
   ```
   Mirror the post-TASK-598 schema (TASK-598 finishes first per `depends_on`).
3. Replace each of the 4 sites' inline `REGISTRY_SCHEMA` (or `GATE_SCHEMA` in the harness) constant with an import from the new fixture:
   - `main/src/orchestrator/__tests__/workflowRegistry.test.ts`: replace lines 29-55 with `import { REGISTRY_SCHEMA } from '../../database/__test_fixtures__/registrySchema';`
   - `main/src/orchestrator/__tests__/runLauncher.test.ts`: replace lines 30-53 with the same import
   - `main/src/ipc/__tests__/cyboflow.test.ts`: replace lines 38-64 with the same import
   - `tests/helpers/cyboflowTestHarness.ts`: replace lines 28-79 with `import { GATE_SCHEMA } from '../../main/src/database/__test_fixtures__/registrySchema';` and use `GATE_SCHEMA` in `db.exec(GATE_SCHEMA)`
4. (Optional bonus) Add a per-fixture comment that documents the relationship to `schema.sql`. Do NOT implement sentinel-comment slicing of `schema.sql` — keep the fixture self-contained.
5. Run the full main test suite and the gate test:
   - `pnpm --filter main test`
   - `pnpm test:gate` (skip-pass if claude is not in PATH)
   Both must exit 0.

## Acceptance Criteria

See frontmatter. The post-task state has exactly ONE in-repo definition of the workflows / workflow_runs DDL outside of `schema.sql` and migration `006`.

## Test Strategy

`needed: false` — this is a refactor; the existing 3 unit tests + day-3 gate test are the regression surface. Pairs with TASK-604 (B7) and TASK-605 (B8) to extract shared `dbAdapter()` helper and `withTempDir()` test helper from the same files; the three together turn 4 fragmented copies into a small consistent test-fixtures module.

## Hardest Decision

Whether to implement sentinel-comment slicing of `schema.sql` (the bonus called out in the work-item description) or to inline the DDL in the fixture module. Picked inlined DDL because slicing couples the test runtime to the byte layout of schema.sql; any cosmetic edit to the SQL file (rewrap, comment add) breaks tests. Inlined-with-doc-comment-pointing-at-schema.sql is the standard fixture pattern in this codebase (see `main/src/test/setup.ts`).

## Rejected Alternatives

- **Sentinel-comment slicing of schema.sql** (per the work-item bonus suggestion). Rejected because it couples test runtime to schema.sql byte layout. Would change my mind if a future task introduces a CI gate that diffs the fixture against the schema and fails on drift, which would catch the manual-sync risk inlining creates.
- **Generate the fixture at build time from schema.sql.** Rejected as overkill for a 5-minute manual sync task that happens once per schema column add.

## Lowest Confidence Area

Whether `cyboflowTestHarness.ts` needs the workflows index `idx_workflows_project_id` (which the existing inline harness DDL omits at line 28-79). The reconciled fixture will include it, which is strictly more permissive — a test that wasn't depending on the index won't break. But there is a chance the harness deliberately omitted it for a reason I'm not seeing; if the gate test starts failing for an indexing reason, drop the index from `GATE_SCHEMA` (or split it into a separate `GATE_SCHEMA_NO_INDEXES` variant).
