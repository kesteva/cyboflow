---
id: TASK-733
idea: SPRINT-033-compound
status: in-flight
created: "2026-05-22T00:00:00Z"
files_owned:
  - main/src/orchestrator/__tests__/cancelAndRestart.test.ts
  - main/src/orchestrator/__tests__/runLauncher.test.ts
  - main/src/orchestrator/__tests__/workflowRegistry.test.ts
  - main/src/orchestrator/__tests__/runExecutor.test.ts
  - main/src/orchestrator/__tests__/inspectorQueries.test.ts
  - main/src/orchestrator/__tests__/runLifecycle.test.ts
  - main/src/orchestrator/__tests__/stuckDetector.test.ts
  - main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts
  - main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts
  - main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts
  - main/src/ipc/__tests__/cyboflow.test.ts
files_readonly:
  - main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts
  - main/src/orchestrator/__test_fixtures__/__tests__/orchestratorTestDb.test.ts
  - main/src/database/__test_fixtures__/registrySchema.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/database/migrations/007_add_stuck_reason.sql
  - docs/CODE-PATTERNS.md
acceptance_criteria:
  - criterion: All 11 listed test files import `createTestDb` from `__test_fixtures__/orchestratorTestDb` (and pass options where required for migration-007 or FK-off cases) — no local `function createTestDb` or `function createTestDbNoFk` definitions remain.
    verification: "Run `grep -rn 'function createTestDb' main/src --include='*.test.ts'` — output must be empty."
  - criterion: "Files that previously applied migration 007 (cancelAndRestart.test.ts, stuckDetector.test.ts) now call `createTestDb({ includeStuckDetectedAt: true })` and no longer use `readFileSync(SCHEMA_007, …)` for migration 007."
    verification: "grep -n 'SCHEMA_007\\|MIGRATION_007\\|007_add_stuck_reason' main/src/orchestrator/__tests__/cancelAndRestart.test.ts main/src/orchestrator/__tests__/stuckDetector.test.ts returns 0 matches in code."
  - criterion: "inspectorQueries.test.ts's inline `ALTER TABLE workflow_runs ADD COLUMN stuck_detected_at` stub is replaced by `createTestDb({ includeStuckDetectedAt: true })`."
    verification: "grep -n 'ALTER TABLE workflow_runs' main/src/orchestrator/__tests__/inspectorQueries.test.ts returns 0 matches."
  - criterion: "claudeCodeManagerWiring.test.ts's `createTestDbNoFk` is replaced by `createTestDb({ disableForeignKeys: true })` at every call site."
    verification: "grep -n 'createTestDbNoFk' main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts returns 0 matches."
  - criterion: "mcpQueryHandler.test.ts's local createTestDb is replaced by `createTestDb({ disableForeignKeys: true })`."
    verification: "grep -n 'function createTestDb\\|foreign_keys = OFF' main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts returns 0 matches for `function createTestDb`."
  - criterion: All 11 migrated test files still pass after consolidation — `pnpm --filter main test` exits 0.
    verification: Run `pnpm --filter main test` from repo root; expect exit code 0.
depends_on:
  - TASK-732
estimated_complexity: medium
epic: testing-infrastructure
test_strategy:
  needed: true
  justification: "Pure refactor toward a shared fixture. The 11 migrated test files are themselves the regression coverage — they were green before and must remain green after. No new behaviors are introduced; no new test cases need to be authored. The parity test in __test_fixtures__/__tests__/orchestratorTestDb.test.ts now implicitly covers all 11 files (that's the entire point of the consolidation)."
  targets:
    - behavior: cancelAndRestart integration tests still pass (FK ON + migration 007 columns present)
      test_file: main/src/orchestrator/__tests__/cancelAndRestart.test.ts
      type: integration
    - behavior: runLauncher integration tests still pass
      test_file: main/src/orchestrator/__tests__/runLauncher.test.ts
      type: integration
    - behavior: workflowRegistry tests still pass (REGISTRY_SCHEMA → GATE_SCHEMA upgrade is a no-op because workflowRegistry only touches workflows/workflow_runs)
      test_file: main/src/orchestrator/__tests__/workflowRegistry.test.ts
      type: unit
    - behavior: runExecutor RunLauncher integration block still passes
      test_file: main/src/orchestrator/__tests__/runExecutor.test.ts
      type: integration
    - behavior: inspectorQueries handler tests still pass (stuck_detected_at column present via canonical option)
      test_file: main/src/orchestrator/__tests__/inspectorQueries.test.ts
      type: integration
    - behavior: runLifecycle transition + cancel handler tests still pass
      test_file: main/src/orchestrator/__tests__/runLifecycle.test.ts
      type: unit
    - behavior: stuckDetector tests still pass (FK ON + migration 007 columns)
      test_file: main/src/orchestrator/__tests__/stuckDetector.test.ts
      type: unit
    - behavior: mcpQueryHandler tests still pass (FK off preserved via canonical option)
      test_file: main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts
      type: unit
    - behavior: claudeCodeManager.killProcess tests still pass
      test_file: main/src/services/panels/claude/__tests__/claudeCodeManager.killProcess.test.ts
      type: unit
    - behavior: claudeCodeManagerWiring tests still pass (both FK-on and FK-off describe blocks)
      test_file: main/src/services/panels/claude/__tests__/claudeCodeManagerWiring.test.ts
      type: unit
    - behavior: ipc/cyboflow handler tests still pass
      test_file: main/src/ipc/__tests__/cyboflow.test.ts
      type: integration
---
# Consolidate the 11 local createTestDb definitions onto the canonical orchestratorTestDb fixture

## Objective

`createTestDb()` in `main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts` is the canonical fixture for orchestrator test bootstrapping. It uses GATE_SCHEMA (column-pinned to migration 006 by the parity test) — a schema-drift tripwire that fires on every test run. But 11 test files still define their own local `createTestDb` (12 declarations once you count `createTestDbNoFk` in claudeCodeManagerWiring.test.ts). This task migrates every one to import the canonical fixture, deletes the local copies, and lets the parity test transitively guard schema correctness for all 11 previously-uncovered files. Sequenced after TASK-732 because three files need the option flags TASK-732 adds.

## Implementation Steps

1. **Completeness gate (pre-flight grep)** — record current sites so step 14 can re-run the same grep as a completion check:
   ```
   grep -rn 'function createTestDb' main/src --include='*.test.ts'
   grep -rn 'function createTestDbNoFk' main/src --include='*.test.ts'
   ```
   Expected before sweep: 11 + 1 = 12 declarations across 11 test files. After sweep: 0.

2. **Verify TASK-732 has landed.** Run:
   ```
   grep -n 'CreateTestDbOptions\|disableForeignKeys\|includeStuckDetectedAt' main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts
   ```
   Matches must be present.

3. **Migrate `cancelAndRestart.test.ts:44`.** Delete local createTestDb + SCHEMA_006/SCHEMA_007 constants. Remove unused readFileSync/join imports. Add canonical import. Rewrite every call site `createTestDb()` → `createTestDb({ includeStuckDetectedAt: true })`.

4. **Migrate `runLauncher.test.ts:33`.** Delete local. Add canonical import. Remove unused REGISTRY_SCHEMA import. Calls stay as `createTestDb()`.

5. **Migrate `workflowRegistry.test.ts:33`.** Same as step 4.

6. **Migrate `runExecutor.test.ts:865`.** Delete local createTestDb declared inside the RunLauncher integration describe block. Add canonical import. Verify REGISTRY_SCHEMA isn't used elsewhere in the file before removing the import.

7. **Migrate `inspectorQueries.test.ts:48`.** Delete local createTestDb (including the inline ALTER stub at lines 55-57). Add canonical import. Rewrite every call site to `createTestDb({ includeStuckDetectedAt: true })`. Leave the local `dbAdapter` helper alone (out of scope).

8. **Migrate `runLifecycle.test.ts:38`.** Same as step 4.

9. **Migrate `stuckDetector.test.ts:60`.** Delete local createTestDb + MIGRATION_006/MIGRATION_007 constants. Remove readFileSync/join imports if unused. Add canonical import. Rewrite calls to `createTestDb({ includeStuckDetectedAt: true })`. Delete the now-redundant column-presence sanity checks (the canonical option is itself unit-tested in TASK-732).

10. **Migrate `mcpQueryHandler.test.ts:33`.** Delete local createTestDb. Add canonical import. Rewrite calls to `createTestDb({ disableForeignKeys: true })` (preserves the FK-off contract).

11. **Migrate `claudeCodeManager.killProcess.test.ts:84`.** Delete local createTestDb + SCHEMA_PATH constant. Remove unused readFileSync/join imports. Add canonical import (`../../../../orchestrator/__test_fixtures__/orchestratorTestDb`). Calls stay as `createTestDb()`.

12. **Migrate `claudeCodeManagerWiring.test.ts` (createTestDb at line 99 + createTestDbNoFk at line 112).** Delete both local declarations + SCHEMA_PATH. Remove unused imports. Add canonical import. Keep `createTestDb()` calls as-is. Rewrite `createTestDbNoFk()` calls → `createTestDb({ disableForeignKeys: true })`.

13. **Migrate `ipc/__tests__/cyboflow.test.ts:40`.** Delete local createTestDb. Add canonical import (`../../orchestrator/__test_fixtures__/orchestratorTestDb`). Remove unused REGISTRY_SCHEMA import. Calls stay as `createTestDb()`.

14. **Re-run completeness greps** (same as step 1) — both must return 0 matches.

15. **Run gates:**
    ```
    pnpm --filter main typecheck
    pnpm --filter main lint
    pnpm --filter main test
    ```
    Each must exit 0. Pay attention to unused-import lint warnings — every removed REGISTRY_SCHEMA / GATE_SCHEMA / readFileSync / join / MIGRATION_* / SCHEMA_* is a potential source.

## Hardest Decision

**Upgrade REGISTRY_SCHEMA-only test files (runLauncher, workflowRegistry, runLifecycle, cyboflow IPC) to GATE_SCHEMA?** Yes. GATE_SCHEMA is a strict superset — extra tables sit unused — but a single canonical fixture is far easier to reason about than maintaining two. The parity test only covers GATE_SCHEMA, so a REGISTRY_SCHEMA-only fixture would dilute its coverage. Future tests that genuinely don't want approvals/raw_events can still call `createTestDb()` — they just get extra tables they ignore.

## Lowest Confidence Area

**Relative import paths across the 11 files** vary by file depth. The TypeScript compiler will catch any miscount immediately. The greater risk is a stale leftover import (`REGISTRY_SCHEMA`, `GATE_SCHEMA`, `readFileSync`, `join`, `MIGRATION_006`, `MIGRATION_007`, `SCHEMA_PATH`, `SCHEMA_006`, `SCHEMA_007`) — each removal must be grepped for residual references in the same file before deletion.
