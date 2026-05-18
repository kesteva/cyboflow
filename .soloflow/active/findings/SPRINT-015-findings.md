---
sprint: SPRINT-015
pending_count: 6
last_updated: "2026-05-17T00:00:00.000Z"
---
# Findings Queue

## FIND-SPRINT-015-1
- **source:** TASK-563 (executor)
- **type:** bug
- **severity:** low
- **status:** open
- **location:** TASK-563 acceptance_criteria[3]
- **description:** AC4 verification grep `(4 passed|Tests\s+4\s+passed)` was written assuming only the 4 migrateLocalStorageKey tests existed in the frontend workspace. Parallel sprint tasks added additional test files, so the summary line now reads `83 passed (91)` rather than `4 passed`. The migrateLocalStorageKey.test.ts file itself runs and all 4 cases pass (`src/utils/migrateLocalStorageKey.test.ts (4 tests) 4ms`), satisfying the task objective. The verification grep pattern in the plan should be updated to match `migrateLocalStorageKey.test.ts.*4 tests` or similar to be robust to additional test files.
- **suggested_action:** Update AC4 verification to: `pnpm --filter frontend test 2>&1 | grep -E migrateLocalStorageKey.*4.tests` or check for the file-level pass line rather than the summary line.
- **resolved_by:** 

## FIND-SPRINT-015-2
- **source:** TASK-563 (verifier)
- **type:** claude-md
- **severity:** medium
- **status:** open
- **location:** docs/CODE-PATTERNS.md (or a new docs/TESTING.md)
- **description:** TASK-563's plan asserted via sibling-test scan that only `frontend/src/utils/migrateLocalStorageKey.test.ts` existed under `frontend/src/`. That scan was already out of date at plan-write time — `frontend/src/test/setup.ts` and 13 other `.test.tsx`/`.test.ts` files existed in tree (TASK-402, TASK-404, TASK-551, etc.). The plan therefore did not require `setupFiles: ['./src/test/setup.ts']` on the new `vitest.config.ts`, and the executor faithfully omitted it. Result: `pnpm --filter frontend test` exits 1 because `@testing-library/jest-dom` extends a global `expect` that doesn't exist under `globals: false` without a setup file. This is a classic "wire-up task with an outdated worldview" — the planner sampled the file system but missed sibling tests added by parallel tasks earlier in the sprint. A short testing pattern doc (or a CLAUDE.md bullet) noting "frontend vitest config must reference `frontend/src/test/setup.ts` whenever `@testing-library/jest-dom` is in use; pair `globals: false` with explicit imports in every spec" would have caught this. The main workspace's `main/vitest.config.ts` already shows the canonical setup-files pattern; the frontend config should mirror it.
- **suggested_action:** Add a `Frontend Testing` section to `docs/CODE-PATTERNS.md` (or a new `docs/TESTING.md`) capturing the `setupFiles` contract for jest-dom matchers + the rationale for `globals: false` requiring explicit vitest imports in every spec. Also: planners that wire test infrastructure should grep for `'@testing-library/jest-dom'` and existing `test/setup.ts` files, not just `.test.*` globs.
- **resolved_by:** 

## FIND-SPRINT-015-3
- **source:** TASK-598 (verifier)
- **type:** claude-md
- **severity:** high
- **status:** open
- **location:** docs/CODE-PATTERNS.md or a new docs/MIGRATIONS.md
- **description:** TASK-598's plan instructed reconciling schema.sql and migration 006 to a single canonical shape and listed FOUR fixture sites in `files_owned` (workflowRegistry.test.ts, runLauncher.test.ts, cyboflow.test.ts, cyboflowTestHarness.ts). The plan missed that FIVE OTHER test files load `006_cyboflow_schema.sql` via `readFileSync` and seed `workflows` rows with `INSERT INTO workflows (id, project_id, name, spec_json)` — approvalRouter.test.ts, cancelAndRestart.test.ts, inspectorQueries.test.ts, stuckDetector.test.ts, trpc/approvals.test.ts. The plan also missed that schema.sql lacks `started_at`/`ended_at` while `cancelAndRestartHandler.ts:148` writes `ended_at`, and that the FK on `workflow_runs.workflow_id` lacks `ON DELETE CASCADE` in schema.sql while having it in migration 006. The planner's grep for fixture sites used the `files_owned` discovery loop but did NOT extend to consumers that load the migration file at runtime. The AC4 verification recipe (grep-preflight for `CREATE TABLE IF NOT EXISTS workflows`) does not catch consumers that use `readFileSync(SCHEMA_006)` + raw INSERT. Result: this reconciliation broke 34 tests across 5 files in the full main suite while the 4-file in-scope tests still passed, and AC1 ("identical column shapes") is not actually met because column order, `started_at`/`ended_at`, and the FK CASCADE clause still diverge.
- **suggested_action:** Add a `Schema Reconciliation` section to `docs/CODE-PATTERNS.md` (or a new `docs/MIGRATIONS.md`) documenting: (a) two discovery patterns are required — `grep 'CREATE TABLE IF NOT EXISTS <table>'` for inline-DDL fixtures AND `grep 'readFileSync.*<migration_file>\|join.*migrations/.*\.sql'` for migration-file consumers; (b) when dropping/renaming a column in a shipped migration, search every test file's INSERT/SELECT for the old column name; (c) schema.sql and the highest-numbered migration must remain BIDIRECTIONALLY equivalent — re-running the file-based migration runner on a fresh schema.sql must be a no-op (use `IF NOT EXISTS` + `ALTER TABLE` patterns). Also: in planning, AC verifications that compare DDL blocks should `diff` the full column block, not `grep -A 10` (which truncates and gives a false-positive pass).
- **resolved_by:** 

## FIND-SPRINT-015-4
- **source:** TASK-598 (verifier)
- **type:** bug
- **severity:** high
- **status:** resolved
- **location:** main/src/database/schema.sql:56-71
- **description:** Post-reconciliation `schema.sql` declares `workflow_runs` WITHOUT `started_at DATETIME` and `ended_at DATETIME` columns, but `main/src/orchestrator/cancelAndRestartHandler.ts:148` executes `UPDATE workflow_runs SET status = 'canceled', ended_at = ?, updated_at = ?`. On a fresh install, `Database.initializeSchema()` runs `schema.sql` first; migration 006's `CREATE TABLE IF NOT EXISTS workflow_runs` is then a no-op (table exists), so `started_at`/`ended_at` are NEVER added. Any cancel/restart operation will fail at runtime with `SqliteError: no such column: ended_at`. Additionally, `shared/types/cyboflow.ts` declares both fields on `WorkflowRunRow` as required-ish (`string | null`), confirming the code path expects these columns.
- **suggested_action:** Add `started_at DATETIME` and `ended_at DATETIME` to schema.sql's `workflow_runs` block. Also align the FK clause to `FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE` so cascade deletes match migration 006. Re-verify AC1 with a column-by-column diff (not `grep -A 10`).
- **resolved_by:** TASK-598

## FIND-SPRINT-015-5
- **source:** TASK-564 (code-reviewer)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** main/package.json (scripts.test)
- **description:** TASK-564 added a new root `test:unit` script that chains `pnpm --filter main test && pnpm --filter frontend test && pnpm run test:build`. The `main` workspace defines `"test": "vitest"` (no `run` subcommand), and vitest defaults to **watch mode** when stdout is a TTY. As a result, a developer running `pnpm run test:unit` from an interactive terminal will hang at the first tier — vitest will sit in watch mode and the `&&` chain will never advance to frontend or build asserts. The script only behaves as advertised in non-TTY contexts (CI, piped output). The frontend workspace already uses the canonical one-shot form `"test": "vitest run"`, which is what the new `test:unit` script reasonably assumes for `main` too. `main/package.json` was `files_readonly` for TASK-564, so this could not have been fixed in that diff.
- **suggested_action:** In `main/package.json`, change `"test": "vitest"` to `"test": "vitest run"` (one-shot) and move the existing watch behavior to a `test:watch` entry — mirroring the pattern frontend already uses. This restores the intended fail-fast sequencing of root `test:unit` for interactive devs and keeps CI behavior identical. Optionally, also add a planner rule to `docs/CODE-PATTERNS.md`: any workspace `test` script that participates in a multi-tier `&&` chain MUST be one-shot (`vitest run` / `--watchAll=false` / equivalent), never the bare watching form.
- **resolved_by:** 

## FIND-SPRINT-015-6
- **type:** scope_deviation
- **source:** TASK-598 (executor)
- **severity:** low
- **status:** resolved
- **location:** main/src/ipc/cyboflow.ts
- **description:** required to meet AC: workflowId type changed from number to string in launcher.launch() signature; cyboflow.ts startRun handler must be updated to match
- **resolved_by:** TASK-598

## FIND-SPRINT-015-7
- **source:** TASK-598 (code-reviewer)
- **type:** bug
- **severity:** high
- **status:** open
- **location:** frontend/src/utils/cyboflowApi.ts:72, frontend/src/components/cyboflow/WorkflowPicker.tsx:19,35,75
- **description:** TASK-598 changed `WorkflowRow.id` and the `cyboflow:startRun` IPC arg `workflowId` from `number` to `string` in shared/types/workflows.ts and main/src/ipc/cyboflow.ts. The frontend was readonly for this task so two consumers were not updated: (1) `cyboflowApi.startRun` declares `workflowId: number` in its parameter type; (2) `WorkflowPicker.tsx` declares `useState<number | null>` for `selectedId`, calls `setSelectedId(rows[0].id)` (string → number assignment), and casts the select value via `Number(e.target.value)`. Result: `pnpm --filter frontend typecheck` exits 2 with `error TS2345: Argument of type 'string' is not assignable to parameter of type 'SetStateAction<number | null>'` at WorkflowPicker.tsx:35. The main-workspace tests still pass (309/309) because the type contract crosses the IPC boundary at runtime and only fails the renderer typecheck. CI `pnpm typecheck` (root, all workspaces) will fail.
- **suggested_action:** Spawn a small follow-up task that owns the two frontend files and: (a) flip `cyboflowApi.startRun({ workflowId: number })` to `workflowId: string`; (b) in `WorkflowPicker.tsx`, change `useState<number | null>` to `useState<string | null>` and drop the `Number(e.target.value)` cast (`<select value>` already returns a string). Verify with `pnpm --filter frontend typecheck` exit 0 and a manual smoke of the workflow picker if visual verify is available.
- **resolved_by:** 

## FIND-SPRINT-015-8
- **source:** TASK-598 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/workflowRegistry.ts:102-110
- **description:** The `seed()` docstring still claims "Uses INSERT OR IGNORE on the `(project_id, name)` unique constraint so re-seeding the same project is idempotent". TASK-598 dropped that UNIQUE constraint from both schema.sql and migration 006, and the new idempotence story is "use a deterministic PK `wf-<projectId>-<name>` so INSERT OR IGNORE collides on the PK". The runtime behavior is correct — the docstring is the only thing that's stale.
- **suggested_action:** Update the docstring to: "Uses INSERT OR IGNORE on the deterministic primary key `wf-<projectId>-<name>` so re-seeding the same project is idempotent — existing rows are not updated." Also consider re-introducing an explicit `UNIQUE(project_id, name)` constraint as a defense-in-depth measure for any non-seed INSERT path that bypasses the deterministic-ID helper.
- **resolved_by:** 
