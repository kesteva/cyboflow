---
id: TASK-598
idea: SPRINT-009-compound
status: ready
created: 2026-05-15T00:00:00Z
files_owned:
  - main/src/database/schema.sql
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/orchestrator/workflowRegistry.ts
  - main/src/orchestrator/runLauncher.ts
  - main/src/orchestrator/__tests__/workflowRegistry.test.ts
  - main/src/orchestrator/__tests__/runLauncher.test.ts
  - main/src/ipc/__tests__/cyboflow.test.ts
  - main/src/database/__tests__/cyboflowSchema.test.ts
  - tests/helpers/cyboflowTestHarness.ts
  - shared/types/workflows.ts
files_readonly:
  - main/src/database/database.ts
  - docs/cyboflow_system_design.md
  - docs/ARCHITECTURE.md
  - .soloflow/active/findings/SPRINT-009-findings.md
  - main/src/orchestrator/types.ts
acceptance_criteria:
  - criterion: "schema.sql and migration 006 declare identical column shapes for `workflows` and `workflow_runs`"
    verification: "diff `<(grep -A 10 'CREATE TABLE.*workflows' main/src/database/schema.sql)` and `<(grep -A 10 'CREATE TABLE.*workflows' main/src/database/migrations/006_cyboflow_schema.sql)` shows the column lists agree on type and order"
  - criterion: "workflows.id is a single canonical type across schema.sql, migration 006, and the runtime read paths"
    verification: "grep -rn 'workflows' main/src/database/schema.sql main/src/database/migrations/006_cyboflow_schema.sql shows the same `id` column type in both"
  - criterion: "workflow_runs has the columns the existing app reads/writes (status check constraint, permission_mode_snapshot, worktree_path, branch_name) AND the columns the design spec requires (policy_json, stuck_at, stuck_reason, error_message)"
    verification: "grep -E 'permission_mode_snapshot|policy_json|stuck_at|stuck_reason|error_message|branch_name|worktree_path' main/src/database/migrations/006_cyboflow_schema.sql returns 7 lines"
  - criterion: "All test fixture schemas (workflowRegistry.test.ts, runLauncher.test.ts, cyboflow.test.ts, cyboflowTestHarness.ts) match the canonical migration shape"
    verification: "node scripts/refiner/grep-preflight.js --pattern 'CREATE TABLE IF NOT EXISTS workflows' returns exactly the 5 fixture sites + schema.sql + migration 006, and a manual diff of column lists is identical across them"
  - criterion: "main/src/database/__tests__/cyboflowSchema.test.ts continues to pass after column reconciliation"
    verification: "pnpm --filter main exec vitest run src/database/__tests__/cyboflowSchema.test.ts exits 0"
  - criterion: "main/src/orchestrator/__tests__/workflowRegistry.test.ts continues to pass with the reconciled schema"
    verification: "pnpm --filter main exec vitest run src/orchestrator/__tests__/workflowRegistry.test.ts exits 0"
  - criterion: "main/src/orchestrator/__tests__/runLauncher.test.ts continues to pass"
    verification: "pnpm --filter main exec vitest run src/orchestrator/__tests__/runLauncher.test.ts exits 0"
  - criterion: "main/src/ipc/__tests__/cyboflow.test.ts continues to pass"
    verification: "pnpm --filter main exec vitest run src/ipc/__tests__/cyboflow.test.ts exits 0"
depends_on: []
estimated_complexity: medium
epic: orchestrator-and-trpc-router
test_strategy:
  needed: true
  justification: "The reconciliation changes the production migration's column types and adds new columns; existing schema and runtime tests must continue to pass and a new fixture-drift assertion is needed."
  targets:
    - behavior: "Reconciled migration 006 keeps the 5-table set, status CHECK constraint, and day-1 indexes intact"
      test_file: "main/src/database/__tests__/cyboflowSchema.test.ts"
      type: integration
    - behavior: "WorkflowRegistry.seed and createRun continue to work against the reconciled schema"
      test_file: "main/src/orchestrator/__tests__/workflowRegistry.test.ts"
      type: unit
    - behavior: "RunLauncher.launch continues to UPDATE worktree_path/branch_name/status against the reconciled workflow_runs row"
      test_file: "main/src/orchestrator/__tests__/runLauncher.test.ts"
      type: unit
    - behavior: "registerCyboflowHandlers continues to seed and start runs against the reconciled schema"
      test_file: "main/src/ipc/__tests__/cyboflow.test.ts"
      type: integration
---

# Reconcile schema.sql / migration 006 column-shape mismatch

## Objective

`main/src/database/schema.sql` and `main/src/database/migrations/006_cyboflow_schema.sql` currently declare the cyboflow tables with mutually incompatible column shapes (TEXT vs INTEGER primary keys, presence/absence of `spec_json`, `policy_json`, `stuck_at`, `stuck_reason`, `permission_mode_snapshot`, `branch_name`). The runtime auto-seed path and the integration tests ride two different shapes, so any code that reads from one and writes through the other will silently break. This task picks one canonical shape, propagates it through both files plus the four in-repo fixture copies of the same DDL, and adds the missing `error_message` column on `workflow_runs` that B9 will need.

## Implementation Steps

1. Run the grep-preflight to enumerate every in-repo copy of the workflows / workflow_runs DDL: `node scripts/refiner/grep-preflight.js --pattern 'CREATE TABLE IF NOT EXISTS workflows'` and `node scripts/refiner/grep-preflight.js --pattern 'CREATE TABLE IF NOT EXISTS workflow_runs'`. Confirm the result set matches the files listed in `files_owned`.
2. Pick the canonical shape. Use schema.sql's runtime shape as the base (INTEGER `workflows.id`, TEXT `workflow_runs.id`, `permission_mode_snapshot`, `worktree_path`, `branch_name`) because it is what the seeded code path and all four fixture copies already use. From migration 006 KEEP the 8-state CHECK constraint on `workflow_runs.status`, the `policy_json` column, the `stuck_at` / `stuck_reason` columns, and the day-1 indexes (`idx_raw_events_run_id`, `idx_raw_events_type_run`, `idx_approvals_status_created`, `idx_workflow_runs_status_created`).
3. Reconcile `main/src/database/schema.sql`: edit the `workflows` and `workflow_runs` blocks to add `policy_json TEXT`, `stuck_at DATETIME`, `stuck_reason TEXT`, `error_message TEXT`, and the 8-state CHECK on `workflow_runs.status`. Leave `id`/`workflow_id`/`project_id` as they currently are (INTEGER autoincrement workflows, TEXT runs).
4. Reconcile `main/src/database/migrations/006_cyboflow_schema.sql`: change `workflows.id` from `TEXT PRIMARY KEY` to `INTEGER PRIMARY KEY AUTOINCREMENT`, add `permission_mode TEXT NOT NULL DEFAULT 'default'` to `workflows`, change `workflow_runs.workflow_id` from `TEXT` to `INTEGER`, add `permission_mode_snapshot TEXT NOT NULL` and `branch_name TEXT` and `error_message TEXT` to `workflow_runs`, drop the now-redundant `spec_json` column on `workflows` (or repurpose it to a non-NULL DEFAULT '{}' if removing breaks the existing `cyboflowSchema.test.ts` INSERTs). Keep `worktree_path` NOT NULL? — relax to nullable (it is nullable in schema.sql and RunLauncher writes it after the row exists). Preserve `stuck_at`, `stuck_reason`, `policy_json`, the 8-state CHECK, all FK clauses, and all day-1 indexes.
5. Update `main/src/database/__tests__/cyboflowSchema.test.ts` INSERT statements that reference `spec_json` and any other dropped/renamed columns so the tests still compile and pass. The test currently inserts `INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', ...)`; rewrite to `(id, project_id, name)` if `spec_json` is dropped, or to `(project_id, name, workflow_path)` if INTEGER PK requires omitting `id`. Adjust the test's `wf-1` foreign key references to `workflow_runs.workflow_id` to use the new INTEGER value (e.g. `last_insert_rowid()` or a fixed `1`).
6. Reconcile the four fixture copies of the DDL. For each of `main/src/orchestrator/__tests__/workflowRegistry.test.ts`, `main/src/orchestrator/__tests__/runLauncher.test.ts`, `main/src/ipc/__tests__/cyboflow.test.ts`, `tests/helpers/cyboflowTestHarness.ts`: extend the inline `REGISTRY_SCHEMA` / `GATE_SCHEMA` constant to include the newly-added columns (`policy_json TEXT`, `stuck_at DATETIME`, `stuck_reason TEXT`, `error_message TEXT`) and the 8-state CHECK constraint on `workflow_runs.status`. The fixtures already use INTEGER `workflows.id` and TEXT `workflow_runs.id` so those stay.
7. Update `shared/types/workflows.ts` (the `WorkflowRunRow` interface) to add the new optional columns: `policy_json?: string | null`, `stuck_at?: string | null`, `stuck_reason?: string | null`, `error_message?: string | null`. Add to `WorkflowRow` the fields needed by the canonical shape.
8. Update `WorkflowRegistry.createRun` (`main/src/orchestrator/workflowRegistry.ts`) to write a sensible default for `policy_json` (e.g. `'{}'`) on the INSERT statement so the NOT NULL constraint is satisfied — or keep the column nullable in the migration. Prefer keeping it nullable to avoid touching the registry insert.
9. Update `WorkflowRegistry.getRunById` SELECT clause to project the new columns (`policy_json, stuck_at, stuck_reason, error_message`) into the returned `WorkflowRunRow`.
10. Run the full test suite to confirm everything passes: `pnpm --filter main test`, then `pnpm test:gate` if Claude is available locally. Update `docs/cyboflow_system_design.md` only if the canonical column shape diverges from §5.3 — leave a comment in the migration referencing the design doc section.

## Acceptance Criteria

Every AC in the frontmatter must pass. The reconciled migration must (a) match what schema.sql declares, (b) keep the 8-state CHECK constraint, (c) add the design-spec columns (`policy_json`, `stuck_at`, `stuck_reason`), (d) add `error_message` for B9. The fixture sites must adopt the same column set so a future test that copy-pastes from one fixture into another doesn't reintroduce drift.

## Test Strategy

No new test file is needed; the existing four test files cover the affected surface. The reconciliation is essentially a column-list edit; existing tests will catch any regression in the read or write paths. After the edit, run `pnpm --filter main test` and the four affected files must remain green. The `cyboflowSchema.test.ts` "rejects an invalid status value" test is the canary that the 8-state CHECK survived the reconciliation; the "fresh-install migration runner integration" test is the canary that the FK chain still holds.

## Hardest Decision

Whether to break the existing `cyboflowSchema.test.ts` INSERTs (which assume migration 006's TEXT PK + `spec_json`) or break the four fixture sites (which assume schema.sql's INTEGER PK + `permission_mode`). I chose to break the migration test: the runtime auto-seed path in `cyboflow.ts` and `WorkflowRegistry.seed` is keyed off INTEGER PK / `permission_mode`, and the four fixture sites all use the runtime shape. Picking the migration-test shape would require rewriting `WorkflowRegistry.seed`'s INSERT, the `WorkflowRow` type, and four fixtures — far more change. Picking the runtime shape requires rewriting one test file's INSERT statements only.

## Rejected Alternatives

- **Spawn a new `007_*` migration that ALTERs migration 006 to match schema.sql.** Rejected because migration 006 has not yet shipped to any user (the cyboflow-schema-migration epic is in `archive/done/` but no production install exists) — a single in-place fix is cleaner than a corrective migration. Would change my mind if this codebase had any prior shipped install whose `~/.cyboflow/sessions.db` already runs migration 006 as-written.
- **Delete migration 006 entirely and rely on schema.sql alone.** Rejected because the design spec (`cyboflow_system_design.md` §5.3) explicitly calls for a numbered migration; the file-based migration runner (TASK-151) needs a 006 entry to record in the ledger; and the `cyboflowSchema.test.ts` integration test reads from the migration file directly.

## Lowest Confidence Area

Whether keeping `policy_json` nullable in the reconciled migration breaks a downstream consumer. The design doc claims `policy_json` is the snapshot-at-start of the approval policy and should be required. But `WorkflowRegistry.createRun` does not write it today — it writes `permission_mode_snapshot` instead. The right answer may be to make `policy_json` an alias for the JSON-encoded `permission_mode_snapshot`, not a separate field. Settled for "nullable" to avoid bundling that policy decision into a schema-reconciliation task.
