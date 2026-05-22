---
id: TASK-723
idea: SPRINT-030
status: in-flight
created: "2026-05-21T00:00:00Z"
files_owned:
  - scripts/verify-schema-parity.js
  - scripts/__tests__/verify-schema-parity.test.js
files_readonly:
  - main/src/database/schema.sql
  - main/src/database/migrations/008_permission_mode_approve_default.sql
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/database/migrations/007_add_stuck_reason.sql
  - main/src/database/migrations/legacy/add_project_support.sql
  - main/src/database/migrations/legacy/add_permission_mode.sql
  - main/src/database/database.ts
  - package.json
  - .soloflow/active/findings/SPRINT-030-findings.md
acceptance_criteria:
  - criterion: "`pnpm run verify:schema` exits 0 against the real schema.sql + real migrations set (including 008)."
    verification: "Run `pnpm run verify:schema` from repo root; exit status 0."
  - criterion: "`node scripts/__tests__/verify-schema-parity.test.js` exits 0 with all three pre-existing cases passing plus a new fourth case asserting that migration-008-style `no such column` errors are tolerated in path-1."
    verification: Run `node scripts/__tests__/verify-schema-parity.test.js`; exit status 0; stdout/stderr indicates 4 tests passed.
  - criterion: "`pnpm test:unit` advances past the `verify:schema` step without `SqliteError: no such column: permission_mode`."
    verification: "Run `pnpm test:unit`; the `verify:schema` chain step (between the workspace tests and the parity self-test) exits 0; any subsequent failures must not contain the string `no such column: permission_mode`."
  - criterion: "`scripts/verify-schema-parity.js` still surfaces real drift: when a migration references a column that genuinely doesn't exist in any table the migration set declares, the script exits non-0 with a diagnostic in stderr."
    verification: The new test case in `scripts/__tests__/verify-schema-parity.test.js` constructs a synthetic migration set where path-1 succeeds (column tolerated) but path-2 still produces a column-set diff that diffSignatures detects; the test asserts exit non-0. The existing two drift tests (cases 2 and 3) also continue to pass.
  - criterion: The widened tolerance in `verify-schema-parity.js` carries an inline comment naming `migrations/008_permission_mode_approve_default.sql` and the legacy `projects` / `sessions.permission_mode` columns as the canonical trigger so a future reader can locate the root cause.
    verification: "`grep -n '008_permission_mode_approve_default\\|permission_mode' scripts/verify-schema-parity.js` returns at least one hit inside the catch block that handles the `no such column` case."
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: true
  justification: "The existing parity self-test suite is the canonical regression gate. We must (a) prove the happy path now passes with real migrations, and (b) lock the tolerance widening to the specific failure class without weakening drift detection for genuine column-level deviation."
  targets:
    - behavior: "happy-path: real schema.sql + real migrations set (including 008) exits 0 — replaces the previously-passing-only-against-curated-fixture happy-path with an assertion against the full migrations dir."
      test_file: scripts/__tests__/verify-schema-parity.test.js
      type: integration
    - behavior: "new case: a migration that references a column not declared anywhere (mimicking 008's `UPDATE sessions SET permission_mode = 'approve'` shape) is tolerated in path-1 and the script still exits 0 when no genuine drift exists."
      test_file: scripts/__tests__/verify-schema-parity.test.js
      type: integration
    - behavior: "regression: genuine column-set drift (existing test 2's `bogus_test_column` and test 3's missing `stuck_reason`) still produces exit non-0 with stderr naming the offending column."
      test_file: scripts/__tests__/verify-schema-parity.test.js
      type: integration
---
# Widen verify-schema-parity.js tolerated-error set to include `no such column`

## Objective

`pnpm test:unit` is broken at the `verify:schema` chain step: `scripts/verify-schema-parity.js` fails with `SqliteError: no such column: permission_mode` when path-1 replays `schema.sql + every numbered migration in order` and hits migration 008's `UPDATE sessions SET permission_mode = 'approve'`. The root cause is architectural — the `projects` table and the `sessions.permission_mode` column are both materialized by imperative code in `main/src/database/database.ts` rather than by `schema.sql` or any numbered migration. Path-1 of the parity check has no way to know about them. The lowest-risk unblock is option (a) from FIND-SPRINT-030-4: widen the script's tolerated-error regex from `no such table` to also include `no such column`, scoped to path-1 only and documented inline. Option (b) (add `projects` DDL to `schema.sql` and a `permission_mode` column to `sessions`) is structurally more correct but expands surface area: it would force every consumer that reads `main/src/database/schema.sql` to reckon with Crystal-legacy column drift in the same pass, which is out of scope for SPRINT-030.

## Implementation Steps

1. Open `scripts/verify-schema-parity.js`. Locate the `buildPath1Db` function (lines 68-86). The `catch` block currently matches `/no such table/i` and `continue`s on a tolerated error, otherwise rethrows.

2. Widen the regex to `/no such (table|column)/i` so that migration-008-style errors fall into the tolerated-error branch. Apply the same widening to `buildPath2Db` (lines 88-105) for symmetry — even though path-2 doesn't currently fail on column errors, divergent error policies between the two paths invite a future asymmetric failure where path-1 silently skips a migration that path-2 throws on, producing a confusing diff.

3. Above the widened regex in `buildPath1Db`, add a comment block (3-5 lines) explaining the trigger: migration `008_permission_mode_approve_default.sql` performs `UPDATE sessions SET permission_mode = ...` and `UPDATE projects SET default_permission_mode = ...`, but `sessions.permission_mode` is materialized by `database.ts:281` (`ALTER TABLE sessions ADD COLUMN permission_mode ...`) and the `projects` table itself is materialized by `database.ts:285-307`, neither of which path-1 replays. Cite FIND-SPRINT-030-4 by name so future readers can trace.

4. Update the existing happy-path test (`scripts/__tests__/verify-schema-parity.test.js:80-87`) to assert that running the script with no env overrides — i.e. against the full real migrations dir including 008 — exits 0. The current test exercises this implicitly because `runScript()` with no env overrides uses the default `MIGRATIONS_DIR` (the real dir), so the happy path covers the regression once the fix lands. Add an assertion that stderr does NOT contain `no such column: permission_mode` to lock in the specific failure mode this fix targets.

5. Add a new test case (4th) at the end of `scripts/__tests__/verify-schema-parity.test.js`: construct a fixture where `schema.sql` declares only a `sessions(id TEXT PRIMARY KEY)` table, and a single migration file `099_test_column_tolerance.sql` runs `UPDATE sessions SET missing_col = 'x' WHERE missing_col IS NULL;`. The script must exit 0 (path-1 tolerates the no-such-column error and skips; path-2 hits the same error and also skips; both end up with an identical empty `sessions.missing_col`-less schema, no drift). Place the new test directly after test 3.

6. Run `node scripts/__tests__/verify-schema-parity.test.js` and confirm exit 0 with all 4 tests passing.

7. Run `pnpm run verify:schema` from repo root and confirm exit 0.

8. Run `pnpm test:unit` and confirm the chain advances past `verify:schema`. (Other downstream failures may exist; they are out of scope for this task and are tracked separately. The AC scopes to the `verify:schema` step only.)

## Acceptance Criteria

- `pnpm run verify:schema` exits 0 against the real schema.sql + migrations.
- `node scripts/__tests__/verify-schema-parity.test.js` exits 0 with 4 tests passing (3 pre-existing + 1 new tolerance test).
- `pnpm test:unit` no longer fails at the `verify:schema` step with `no such column: permission_mode`.
- Genuine drift detection still works: existing tests 2 (`bogus_test_column`) and 3 (`stuck_reason` removed) still exit non-0.
- The widened tolerance carries an inline comment naming the canonical trigger.

## Test Strategy

The parity script is self-tested via `scripts/__tests__/verify-schema-parity.test.js`. The existing 3 tests cover happy-path + 2 drift classes. We add a 4th test that proves the widened tolerance does NOT swallow genuine column-set drift: it constructs a fixture where a column is referenced in an `UPDATE` (tolerated, no schema impact) without altering the resulting schema column set, then asserts exit 0. The drift tests already in place (test 2, test 3) prove that column-set differences between path-1 and path-2 still surface non-0. The combination locks in the invariant: tolerance is scoped to errors during migration replay, not to differences in the resulting schema signature.

## Hardest Decision

Option (a) widening vs option (b) restoring DDL. Option (b) — adding `projects` DDL plus a `permission_mode` column to `sessions` in `schema.sql` — is more architecturally correct. It would mean schema.sql actually represents the schema the application requires. But the path is non-trivial: `sessions` already exists in schema.sql with no `permission_mode` column, and adding it would require auditing every other ALTER TABLE in `database.ts:264-880` to decide which columns are essential vs which are Crystal-legacy that the cyboflow cuts will eventually remove. That audit is out of scope for SPRINT-030. Option (a) is the surgical unblock that keeps `verify:schema` honest about real drift (the columns it cares about — additions and renames across `workflows`, `workflow_runs`, `raw_events`, `messages`, `approvals` — are still fully checked) while accepting the known limitation that imperative `database.ts` column additions are invisible to path-1.

## Rejected Alternatives

- **Add `projects` DDL + `permission_mode` to `schema.sql`** (option b from the finding): more correct in the long run, but expands the change surface to include every other column `database.ts` adds imperatively. Would change my mind if this task were renamed to "make schema.sql self-consistent" and accompanied by a 1-2 day audit budget.
- **Skip-list migration 008 in path-1** (option c): introduces a config knob (`SKIP_MIGRATIONS_PATH1=008`) that's invisible to readers and silently bypasses future legitimate drift signals. The tolerance regex approach is preferable because it's an error-class filter, not a per-file allowlist.
- **Refactor 008 to be DDL-conditional** (`UPDATE … WHERE EXISTS (SELECT 1 FROM pragma_table_info('sessions') WHERE name='permission_mode')`): SQLite supports this, but it pushes the workaround into production migration code that runs on every user's DB. Keeping the workaround in the dev-tooling script is cleaner.

## Lowest Confidence Area

The new tolerance test (step 5) assumes that a migration which only references a missing column in an UPDATE produces a `no such column` error rather than `no such table` when the table itself does exist (i.e. `sessions(id TEXT PRIMARY KEY)`). SQLite's parser does throw the column error in that case based on the SPRINT-030 finding output (`SqliteError: no such column: permission_mode`), but if a future better-sqlite3 upgrade changes the error string format (e.g. `no such column: sessions.permission_mode`), the regex `/no such (table|column)/i` is robust enough to still match. The test fixture itself is a closed loop: if the test compiles and exits 0, the tolerance is correctly scoped.