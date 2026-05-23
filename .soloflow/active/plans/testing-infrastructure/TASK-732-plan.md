---
id: TASK-732
idea: SPRINT-033-compound
status: ready
created: 2026-05-22T00:00:00Z
files_owned:
  - main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts
  - main/src/orchestrator/__test_fixtures__/__tests__/orchestratorTestDb.test.ts
  - main/src/database/__tests__/cyboflowSchema.test.ts
  - main/src/services/cyboflow/__tests__/transitions.test.ts
  - main/src/orchestrator/__tests__/approvalRouter.test.ts
  - main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts
files_readonly:
  - docs/CODE-PATTERNS.md
  - main/src/database/__test_fixtures__/registrySchema.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/database/migrations/007_add_stuck_reason.sql
  - main/src/orchestrator/approvalRouter.ts
  - main/src/services/cyboflow/transitions.ts
acceptance_criteria:
  - criterion: "createTestDb accepts an optional options object: `createTestDb({ disableForeignKeys?: boolean, includeStuckDetectedAt?: boolean })`. Default behavior (called as `createTestDb()` with no args) is unchanged — FK ON, GATE_SCHEMA only."
    verification: "grep -n 'export function createTestDb' main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts shows the new signature accepting an optional options object; orchestratorTestDb.test.ts has new cases covering both flags."
  - criterion: "When called with `disableForeignKeys: true`, the returned DB has `pragma foreign_keys` === 0."
    verification: "A new test in orchestratorTestDb.test.ts asserts `db.pragma('foreign_keys', { simple: true })` === 0 after `createTestDb({ disableForeignKeys: true })`."
  - criterion: "When called with `includeStuckDetectedAt: true`, the workflow_runs table has the `stuck_detected_at` column (added by migration 007)."
    verification: "A new test in orchestratorTestDb.test.ts asserts `PRAGMA table_info(workflow_runs)` includes a row with name='stuck_detected_at' after `createTestDb({ includeStuckDetectedAt: true })`."
  - criterion: "The GATE_SCHEMA parity test still passes for the default `createTestDb()` call path (the new options do NOT widen GATE_SCHEMA itself; they only layer additional SQL after exec)."
    verification: "`pnpm --filter main test -- orchestratorTestDb.test` passes; the 'GATE_SCHEMA parity vs 006_cyboflow_schema.sql' describe block remains green."
  - criterion: "All 6 inline `INSERT INTO approvals` sites in test files are replaced with calls to the canonical `seedApproval` fixture. After the sweep, `grep -rn 'INSERT INTO approvals' main/src --include='*.test.ts'` returns 0 matches."
    verification: "Run `grep -rn 'INSERT INTO approvals' main/src --include='*.test.ts'` from the repo's main/ workspace — output must be empty."
  - criterion: "All 4 modified test files import `seedApproval` from `__test_fixtures__/orchestratorTestDb` and their local `seedApproval` helpers (if any) are deleted to avoid name shadowing."
    verification: "grep -n 'from .*__test_fixtures__/orchestratorTestDb' main/src/database/__tests__/cyboflowSchema.test.ts main/src/services/cyboflow/__tests__/transitions.test.ts main/src/orchestrator/__tests__/approvalRouter.test.ts main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts shows the import in each; grep -n 'function seedApproval' across those four files returns 0 matches."
  - criterion: "All migrated tests still pass after the sweep — `pnpm --filter main test` exits 0."
    verification: "Run `pnpm --filter main test` from repo root; expect exit code 0 with no test failures in the 4 swept files."
depends_on: []
estimated_complexity: medium
epic: testing-infrastructure
test_strategy:
  needed: true
  justification: "Adds new public surface to orchestratorTestDb (two options) — the existing parity-pinned test file is the natural home for new cases. Each migrated test file is itself a test file; running them after the sweep validates the migration."
  targets:
    - behavior: "createTestDb({ disableForeignKeys: true }) returns a DB with FK enforcement off"
      test_file: "main/src/orchestrator/__test_fixtures__/__tests__/orchestratorTestDb.test.ts"
      type: unit
    - behavior: "createTestDb({ includeStuckDetectedAt: true }) returns a DB whose workflow_runs has the stuck_detected_at column"
      test_file: "main/src/orchestrator/__test_fixtures__/__tests__/orchestratorTestDb.test.ts"
      type: unit
    - behavior: "createTestDb() with no args preserves the existing default contract (FK ON, no stuck_detected_at column) — parity test stays green"
      test_file: "main/src/orchestrator/__test_fixtures__/__tests__/orchestratorTestDb.test.ts"
      type: unit
    - behavior: "All 6 sites that previously inserted approvals inline still pass after switching to seedApproval"
      test_file: "main/src/database/__tests__/cyboflowSchema.test.ts"
      type: integration
    - behavior: "transitions.test.ts cases still pass after local seedApproval helper is replaced by the canonical fixture"
      test_file: "main/src/services/cyboflow/__tests__/transitions.test.ts"
      type: unit
    - behavior: "approvalRouter Case 12 (recoverStaleAwaitingReview) still passes after the inline INSERT is replaced by seedApproval"
      test_file: "main/src/orchestrator/__tests__/approvalRouter.test.ts"
      type: unit
    - behavior: "mcpQueryHandler tests still pass after local seedApproval helper is replaced; the file's FK-off DB is now provided by createTestDb({ disableForeignKeys: true })"
      test_file: "main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts"
      type: unit
---

# Extend orchestratorTestDb with disableForeignKeys + includeStuckDetectedAt options, then sweep the 6 remaining inline INSERT INTO approvals sites

## Objective

TASK-727 made `seedApproval` the canonical fixture and `docs/CODE-PATTERNS.md` now reads `Do NOT inline INSERT INTO approvals in new test files`. But 6 test sites were explicitly deferred as out-of-scope, leaving the canonical doc with 6 counter-examples that grep-gate sweeps would flag forever. This task closes the gap by (1) extending `createTestDb()` with the two option flags B2 also needs (`disableForeignKeys`, `includeStuckDetectedAt`) so dependent migrations don't have to reinvent them, and (2) sweeping the 6 remaining `INSERT INTO approvals` sites in test code so the rule becomes a true grep-gate invariant. Sequenced as the prerequisite for TASK-733, which inherits these options.

## Implementation Steps

1. **Completeness gate (pre-flight grep)** — record the current set of counter-example sites so step 8 can re-run the same grep as a completion check:
   ```
   grep -rn 'INSERT INTO approvals' main/src --include='*.test.ts'
   ```
   Expected 6 matches before the sweep: `cyboflowSchema.test.ts:218,251,292`; `transitions.test.ts:48`; `approvalRouter.test.ts:899`; `mcpQueryHandler.test.ts:79`.

2. **Extend `createTestDb` signature in `main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts`.** Replace the current zero-arg signature with:
   ```ts
   export interface CreateTestDbOptions {
     /** If true, FK enforcement is disabled (PRAGMA foreign_keys=OFF). Defaults to false (FK ON). */
     disableForeignKeys?: boolean;
     /** If true, additionally apply migration 007's ALTER (adds stuck_detected_at INTEGER to workflow_runs). Defaults to false. */
     includeStuckDetectedAt?: boolean;
   }

   export function createTestDb(options?: CreateTestDbOptions): Database.Database {
     const db = new Database(':memory:');
     db.pragma(options?.disableForeignKeys ? 'foreign_keys = OFF' : 'foreign_keys = ON');
     db.exec(GATE_SCHEMA);
     if (options?.includeStuckDetectedAt) {
       db.exec('ALTER TABLE workflow_runs ADD COLUMN stuck_detected_at INTEGER');
     }
     return db;
   }
   ```
   - Keep the JSDoc on the new signature explaining the GATE_SCHEMA + parity-test contract (the option is layered ON TOP of GATE_SCHEMA, not folded into it — the parity test must continue to compare unadulterated GATE_SCHEMA vs migration 006).
   - The `ALTER TABLE` statement intentionally does NOT use `IF NOT EXISTS` (SQLite ALTER doesn't support that clause); callers must not double-apply `includeStuckDetectedAt: true`.

3. **Add three new cases to `main/src/orchestrator/__test_fixtures__/__tests__/orchestratorTestDb.test.ts`.** Inside the existing `describe('createTestDb', …)` block, add:
   - `it('FK enforcement is OFF when called with { disableForeignKeys: true }')` — asserts `db.pragma('foreign_keys', { simple: true })` === 0.
   - `it('workflow_runs has stuck_detected_at column when called with { includeStuckDetectedAt: true }')` — asserts `PRAGMA table_info(workflow_runs)` includes a row with `name === 'stuck_detected_at'` and `type === 'INTEGER'`.
   - `it('default call (no options) still has FK ON and no stuck_detected_at column')` — asserts both the existing FK-on contract AND that the column is absent (this guards the parity test invariant from regressing).
   - Do NOT modify the existing `'GATE_SCHEMA parity vs 006_cyboflow_schema.sql'` describe block — it must continue to compare GATE_SCHEMA-only (no options) against migration 006.

4. **Sweep `main/src/database/__tests__/cyboflowSchema.test.ts` (3 sites: lines 218, 251, 292).** These three INSERTs assert CHECK-constraint behavior. Replace each `INSERT INTO approvals … VALUES (...)` block with a `seedApproval(freshDb, { runId, ... })` call:
   - Line 218 (rejects 'maybe'): wrap `seedApproval` with the `as any` cast for the invalid status (with a lint-disable comment).
   - Line 251 (defaults to 'pending'): call `seedApproval(freshDb, { runId: 'wr-1', id: 'ap-1' })` then assert the SELECT returns `status='pending'`.
   - Line 292 (loops over 4 valid statuses): replace with `seedApproval(freshDb, { runId, id, status })` inside the loop.
   - Add `import { seedApproval } from '../../orchestrator/__test_fixtures__/orchestratorTestDb';`. Do NOT touch the existing migration-runner integration tests (lines 309+).

5. **Sweep `main/src/services/cyboflow/__tests__/transitions.test.ts` (1 site: line 48, plus a colliding local helper).** Delete the local `function seedApproval(db, status)` (lines 46-51). Add the canonical import. Rewrite every call site from `seedApproval(db, 'pending')` to `seedApproval(db, { id: APPROVAL_ID, runId: RUN_ID, toolUseId: 'tu-001', status: 'pending' })`. Verify no assertion reads `tool_use_id` (it doesn't — assertions read `status`, `decided_at`, `decided_by`).

6. **Sweep `main/src/orchestrator/__tests__/approvalRouter.test.ts` (1 site: line 899).** Inside Case 12 (recoverStaleAwaitingReview). Replace the inline INSERT with `seedApproval(db, { id: approvalId, runId, toolUseId: approvalId });`. Add `seedApproval` to the existing import on line 30. Delete the local `const now = new Date().toISOString();` if it's no longer used after the migration.

7. **Sweep `main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts` (1 site: line 79, plus a colliding local helper).** Delete the local `function seedApproval(db, id, runId, status, createdAt)` (lines 71-82). Add the canonical import. Migrate every call site to `seedApproval(db, { id, runId, status, createdAt, toolUseId: id, toolInputJson: '{"cmd":"ls"}' })`. The local `seedRun` and `createTestDb` stay for this task — TASK-733 handles them.

8. **Re-run the completeness gate (same grep as step 1)** to prove the sweep is complete:
   ```
   grep -rn 'INSERT INTO approvals' main/src --include='*.test.ts'
   ```
   Expected: 0 matches.

9. **Run the affected test suites** to confirm all 4 swept files still pass:
   ```
   pnpm --filter main test -- orchestratorTestDb.test cyboflowSchema.test transitions.test approvalRouter.test mcpQueryHandler.test
   pnpm --filter main test
   ```

## Hardest Decision

**Option naming: `includeStuckDetectedAt` vs the brief's `includeStuckReason`.** Chose `includeStuckDetectedAt` because `stuck_reason` is already in GATE_SCHEMA — the column migration 007 actually adds is `stuck_detected_at`. Renaming aligns the option to the real column.

## Lowest Confidence Area

The exact behavior of `transitions.test.ts` after the local `seedApproval(db, status)` helper is replaced — the canonical `seedApproval` defaults `tool_use_id` to the approval's `id`, not the literal `'tu-001'`. Reviewed: no transitions.test.ts assertion inspects `tool_use_id`. Re-grep `tool_use_id` in transitions.test.ts and mcpQueryHandler.test.ts before running the suite.
