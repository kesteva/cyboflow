---
id: TASK-722
idea: SPRINT-029-compounder
status: ready
created: 2026-05-21T00:00:00Z
files_owned:
  - main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts
  - main/src/orchestrator/__test_fixtures__/__tests__/orchestratorTestDb.test.ts
  - main/src/orchestrator/__tests__/approvalRouter.test.ts
  - main/src/orchestrator/__tests__/runRecovery.test.ts
  - main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts
files_readonly:
  - main/src/database/__test_fixtures__/registrySchema.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/orchestrator/__test_fixtures__/dbAdapter.ts
  - scripts/verify-schema-parity.js
  - .soloflow/active/findings/SPRINT-029-findings.md
  - .soloflow/active/compound/SPRINT-029-proposal.md
acceptance_criteria:
  - criterion: "Shared fixture module exists at main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts exporting createTestDb and seedRun."
    verification: "test -f main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts AND grep -nE '^export function (createTestDb|seedRun)' main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts | wc -l outputs at least 2"
  - criterion: "createTestDb uses GATE_SCHEMA only — no readFileSync, no 006_cyboflow_schema.sql."
    verification: "grep -nE 'readFileSync|006_cyboflow_schema\\.sql' main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts returns 0 matches AND grep -n 'GATE_SCHEMA' main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts returns at least 1 match"
  - criterion: "seedRun has one canonical signature: seedRun(db, overrides?: SeedRunOverrides): { workflowId, runId }."
    verification: "grep -nE 'export function seedRun\\(db,\\s*overrides' main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts returns at least 1 match"
  - criterion: "All three migrated test files import from the shared fixture and no longer define their own createTestDb/seedRun."
    verification: "grep -nE '^function (createTestDb|createE2ETestDb|seedRun)\\(' main/src/orchestrator/__tests__/approvalRouter.test.ts main/src/orchestrator/__tests__/runRecovery.test.ts main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts returns 0 matches AND each file has at least one import from '__test_fixtures__/orchestratorTestDb'"
  - criterion: "No test file references 006_cyboflow_schema.sql or readFileSync anymore."
    verification: "grep -nE 'readFileSync|006_cyboflow_schema\\.sql' main/src/orchestrator/__tests__/approvalRouter.test.ts main/src/orchestrator/__tests__/runRecovery.test.ts main/src/orchestrator/trpc/routers/__tests__/approvals.test.ts returns 0 matches"
  - criterion: "Column-level parity test asserts GATE_SCHEMA columns match 006_cyboflow_schema.sql for workflows, workflow_runs, approvals, raw_events."
    verification: "test -f main/src/orchestrator/__test_fixtures__/__tests__/orchestratorTestDb.test.ts AND pnpm --filter main exec vitest run main/src/orchestrator/__test_fixtures__/__tests__/orchestratorTestDb.test.ts exits 0"
  - criterion: "All three migrated suites preserve their original case counts (no test loss in refactor)."
    verification: "Before/after grep -cE \"^\\s*it\\(\" on each file must match. Document in done report."
  - criterion: pnpm --filter main test + pnpm typecheck + pnpm lint exit 0.
    verification: "pnpm --filter main test && pnpm typecheck && pnpm lint"
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: true
  justification: "This task introduces a shared fixture module that becomes a schema source-of-truth proxy for three live test suites. The three migrated suites are the primary behavioral regression test. The parity test pins GATE_SCHEMA against migration 006 — the only safeguard against silent schema drift between fixture and canonical migration."
  targets:
    - behavior: "createTestDb returns a fresh in-memory better-sqlite3 Database with workflows/workflow_runs/approvals/raw_events tables and FK enforcement ON"
      test_file: main/src/orchestrator/__test_fixtures__/__tests__/orchestratorTestDb.test.ts
      type: unit
    - behavior: "seedRun with defaults inserts a single workflow + workflow_run row in 'running' status"
      test_file: main/src/orchestrator/__test_fixtures__/__tests__/orchestratorTestDb.test.ts
      type: unit
    - behavior: "seedRun with overrides.status='awaiting_review' honors the override"
      test_file: main/src/orchestrator/__test_fixtures__/__tests__/orchestratorTestDb.test.ts
      type: unit
    - behavior: "GATE_SCHEMA column-level parity vs 006_cyboflow_schema.sql for workflows/workflow_runs/approvals/raw_events"
      test_file: main/src/orchestrator/__test_fixtures__/__tests__/orchestratorTestDb.test.ts
      type: unit
---

# Consolidate duplicated createTestDb/seedRun test helpers

## Objective

Extract near-identical createTestDb and seedRun helpers from three SPRINT-029 test files (approvalRouter.test.ts, runRecovery.test.ts, approvals.test.ts) into a shared fixture module. Standardize on GATE_SCHEMA (in-memory, no file I/O). Pin invariant with column-level parity test against 006_cyboflow_schema.sql.

## Scope clarification

Migrate ONLY the three files named in FIND-SPRINT-029-10. ~14 other createTestDb/seedRun callsites exist across the test tree — explicitly OUT OF SCOPE. The parity test added here will catch their drift symptoms either way.

## Implementation Steps

1. Baseline grep to capture case counts on each file (record in done report).

2. **Create main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts** with:
   - `export function createTestDb(): Database.Database` using GATE_SCHEMA + FK ON
   - `export interface SeedRunOverrides { id?; status?; workflowId?; projectId?; workflowName?; worktreePath?; policyJson? }`
   - `export function seedRun(db, overrides?: SeedRunOverrides): { workflowId, runId }` with sensible defaults

3. **Migrate approvalRouter.test.ts**: remove local createTestDb/createE2ETestDb/seedRun, add import from shared fixture, update ~18 seedRun call sites from positional to object-overrides.

4. **Migrate runRecovery.test.ts**: same pattern, 5 cases.

5. **Migrate approvals.test.ts**: same pattern. Note: file already uses GATE_SCHEMA so this is mostly signature alignment.

6. **Create parity test** at main/src/orchestrator/__test_fixtures__/__tests__/orchestratorTestDb.test.ts:
   - Load 006_cyboflow_schema.sql + GATE_SCHEMA into separate :memory: DBs
   - For each table (workflows, workflow_runs, approvals, raw_events): assert PRAGMA table_info() column sets match
   - Assert messages table is intentionally absent from GATE_SCHEMA

7. Manual sanity check: temporarily rename a column in 006_cyboflow_schema.sql, confirm parity test fails. Restore.

8. Run `pnpm --filter main test && pnpm typecheck && pnpm lint`. All exit 0.

9. Verify case counts preserved (step-1 baseline vs post-refactor).

## Hardest Decision

seedRun signature: positional (db, id, status) vs object overrides (db, overrides?). Chose object — the three callsites have subtly different shapes, and the object form gives a natural extension point for future fields (projectId, workflowName, policyJson) without further breaking changes.

## Rejected Alternatives

- Keep positional signature: minimizes churn but freezes API at lowest-common-denominator.
- Use readFileSync('006_cyboflow_schema.sql') everywhere: reintroduces file I/O and ENOENT risk.
- Move helpers to main/src/database/__test_fixtures__/: siblings (dbAdapter, loggerLikeSpy) already in orchestrator/__test_fixtures__/.
- Migrate all ~14 callsites: exceeds B5's scope.
- Extend verify-schema-parity.js: script explicitly excludes test fixtures.

## Lowest Confidence Area

PRAGMA table_info comparison fidelity — both DBs go through SQLite's own parser, so output should match byte-for-byte, but if subtle whitespace/quoting differences appear in CHECK defaults, normalization may be needed. Step 7's sanity check is the safeguard. Secondary concern: PRAGMA table_info doesn't report CHECK constraints, so a CHECK-only drift wouldn't fail the test. Document this limitation in a code comment.
