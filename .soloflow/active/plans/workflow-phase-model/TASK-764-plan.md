---
id: TASK-764
idea: IDEA-026
status: in-flight
created: "2026-05-26T16:00:00Z"
files_owned:
  - main/src/database/migrations/011_workflow_step_tracking.sql
  - shared/types/workflows.ts
  - main/src/database/__tests__/migration011.test.ts
files_readonly:
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/database/migrations/007_add_stuck_reason.sql
  - main/src/database/migrations/010_questions.sql
  - main/src/database/database.ts
  - main/src/database/__tests__/migration007.test.ts
  - main/src/database/__tests__/migration010.test.ts
  - main/src/orchestrator/runQueries.ts
acceptance_criteria:
  - criterion: Migration file main/src/database/migrations/011_workflow_step_tracking.sql exists and contains an ALTER TABLE statement adding current_step_id TEXT to workflow_runs.
    verification: "grep -n 'ALTER TABLE workflow_runs ADD COLUMN current_step_id TEXT' main/src/database/migrations/011_workflow_step_tracking.sql returns exactly 1 match."
  - criterion: The migration filename uses the 011_ numeric prefix matching the PREFIX_RE regex in database.ts so runFileBasedMigrations picks it up automatically.
    verification: ls main/src/database/migrations/011_workflow_step_tracking.sql succeeds (exit 0).
  - criterion: Migration 011 does NOT contain BEGIN/COMMIT statements (the runFileBasedMigrations wrapper provides the transaction) and does NOT contain PRAGMA foreign_keys=OFF (pure ADD COLUMN).
    verification: "grep -cE '^(BEGIN|COMMIT|PRAGMA foreign_keys)' main/src/database/migrations/011_workflow_step_tracking.sql returns 0."
  - criterion: "shared/types/workflows.ts WorkflowRunRow has a current_step_id?: string | null member."
    verification: "grep -nE 'current_step_id\\?:\\s*string\\s*\\|\\s*null' shared/types/workflows.ts returns exactly 1 match within the WorkflowRunRow interface block."
  - criterion: Applying migration 006 then migration 011 to an in-memory SQLite DB adds current_step_id TEXT to workflow_runs (verified by PRAGMA table_info).
    verification: pnpm --filter main test -- --run main/src/database/__tests__/migration011.test.ts passes (exit 0).
  - criterion: "Migration 011 is idempotent in the duplicate-column-name path: re-executing the SQL yields a SqliteError with message 'duplicate column name: current_step_id' (matching the runFileBasedMigrations idempotent regex)."
    verification: "migration011.test.ts asserts the second db.exec throws and the error message contains 'duplicate column name: current_step_id'."
  - criterion: Typecheck passes for the entire workspace after the WorkflowRunRow extension.
    verification: pnpm typecheck exits 0.
depends_on:
  - TASK-763
estimated_complexity: low
epic: workflow-phase-model
test_strategy:
  needed: true
  justification: The migrations directory has an established sibling-test convention (migration007.test.ts asserts column type via PRAGMA table_info; migration010.test.ts asserts table-recreation result). Migration 011 must follow the same pattern — lowest-cost safety net against a typo in the column name or type.
  targets:
    - behavior: Applying 006 then 011 against in-memory SQLite adds current_step_id TEXT to workflow_runs
      test_file: main/src/database/__tests__/migration011.test.ts
      type: integration
    - behavior: current_step_id column is nullable (default NULL) and accepts string values
      test_file: main/src/database/__tests__/migration011.test.ts
      type: integration
    - behavior: "Re-executing 011 raises 'duplicate column name: current_step_id' SqliteError that runFileBasedMigrations catches as idempotent"
      test_file: main/src/database/__tests__/migration011.test.ts
      type: integration
---
# TASK-764: Add current_step_id migration and extend WorkflowRunRow type

## Objective

Add a new file-based migration `011_workflow_step_tracking.sql` introducing the `current_step_id TEXT` column on `workflow_runs`, and extend the `WorkflowRunRow` TypeScript type to declare this column. This is the schema foundation that TASK-765 (runner instrumentation) writes to and TASK-766 (`getPhaseState` tRPC) reads from. Coverage gap closed by a sibling-style integration test under `main/src/database/__tests__/migration011.test.ts`.

## Scope split with sibling TASK-763

Both this task and TASK-763 modify `shared/types/workflows.ts`. The split is by disjoint export regions:

- **TASK-763 owns**: the new exports `WorkflowPhase`, `WorkflowStep`, `WorkflowDefinition`, `WorkflowStepState`, and the hardcoded `WORKFLOW_DEFINITIONS` map. These are net-new additions appended after the existing exports.
- **TASK-764 (this task) owns**: a single new optional field `current_step_id?: string | null` inside the existing `WorkflowRunRow` interface body.

Because the regions are non-overlapping, the executor can complete this task without coordinating commit order with TASK-763 beyond the depends_on declaration.

## Implementation Steps

1. **Create `main/src/database/migrations/011_workflow_step_tracking.sql`** with a single `ALTER TABLE workflow_runs ADD COLUMN current_step_id TEXT;` statement. No inline BEGIN/COMMIT; no PRAGMA toggle. Match the 007 convention.

2. **Edit `shared/types/workflows.ts`** to add `current_step_id?: string | null;` inside the existing `WorkflowRunRow` interface between `error_message?` and `started_at?`. Do NOT touch any other declaration in this file. Add a JSDoc reference to IDEA-026 / TASK-764.

3. **Create `main/src/database/__tests__/migration011.test.ts`** mirroring the structure of `migration007.test.ts`:
   - `applyMigrations006And011()` helper using in-memory better-sqlite3.
   - Test 1: PRAGMA table_info confirms current_step_id TEXT exists and is nullable.
   - Test 2: round-trip insert/select with both NULL and string values.
   - Test 3: re-executing migration 011 raises `duplicate column name: current_step_id` SqliteError.

4. **Verify the migration runner picks up the file** — PREFIX_RE at `database.ts:1555` is `/^(\\d{3})_.*\\.sql$/`. `011_workflow_step_tracking.sql` matches.

5. **Verify build assets are copied** — run `pnpm build:main` and confirm `dist/main/src/database/migrations/011_workflow_step_tracking.sql` is present.

6. **Run the verifier gate**: `pnpm --filter main test -- --run main/src/database/__tests__/migration011.test.ts` then `pnpm typecheck`. Both must exit 0.

## Acceptance Criteria

See frontmatter for canonical list with verification commands.

## Test Strategy

Integration tests in `main/src/database/__tests__/migration011.test.ts`. Three test cases (column shape, NULL/string round-trip, idempotency). Pattern is copied from `migration007.test.ts`. No mocking.

## Hardest Decision

**Where to insert `current_step_id` in `WorkflowRunRow` field ordering.** Chose after `error_message?` and before `started_at?` — mirrors how migrations stack columns physically and produces a small focused diff. Keeps type ordering aligned with SQL column ordering for future PRAGMA table_info debugging.

## Rejected Alternatives

- **INTEGER or BLOB for current_step_id.** Rejected — step IDs are dotted-string identifiers per IDEA-026 Slice 1.
- **NOT NULL DEFAULT '' instead of nullable.** Rejected — TASK-765 needs to distinguish "no step active" from "step X running"; sentinel values create brittleness.
- **Bundle current_phase_id "for symmetry".** Rejected — YAGNI; phase is derivable from step via WorkflowDefinition.
- **TypeScript-only declaration with no SQL change.** Rejected — current_step_id must survive an app reload mid-run.

## Lowest Confidence Area

**Field insertion position in `WorkflowRunRow`.** The executor must not accidentally reorder adjacent declarations. The AC grep for `current_step_id?:` is precise enough that Prettier reflow would still pass.

Secondary: the `copy:assets` build step must include `*.sql`. Step 5 has the executor cross-check by running `pnpm build:main` and confirming the file appears in `dist/`.
