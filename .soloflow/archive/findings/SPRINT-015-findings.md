---
sprint: SPRINT-015
pending_count: 17
last_updated: "2026-05-18T07:36:51.604Z"
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
- **status:** resolved
- **location:** frontend/src/utils/cyboflowApi.ts:72, frontend/src/components/cyboflow/WorkflowPicker.tsx:19,35,75
- **description:** TASK-598 changed `WorkflowRow.id` and the `cyboflow:startRun` IPC arg `workflowId` from `number` to `string` in shared/types/workflows.ts and main/src/ipc/cyboflow.ts. The frontend was readonly for this task so two consumers were not updated: (1) `cyboflowApi.startRun` declares `workflowId: number` in its parameter type; (2) `WorkflowPicker.tsx` declares `useState<number | null>` for `selectedId`, calls `setSelectedId(rows[0].id)` (string → number assignment), and casts the select value via `Number(e.target.value)`. Result: `pnpm --filter frontend typecheck` exits 2 with `error TS2345: Argument of type 'string' is not assignable to parameter of type 'SetStateAction<number | null>'` at WorkflowPicker.tsx:35. The main-workspace tests still pass (309/309) because the type contract crosses the IPC boundary at runtime and only fails the renderer typecheck. CI `pnpm typecheck` (root, all workspaces) will fail.
- **suggested_action:** Spawn a small follow-up task that owns the two frontend files and: (a) flip `cyboflowApi.startRun({ workflowId: number })` to `workflowId: string`; (b) in `WorkflowPicker.tsx`, change `useState<number | null>` to `useState<string | null>` and drop the `Number(e.target.value)` cast (`<select value>` already returns a string). Verify with `pnpm --filter frontend typecheck` exit 0 and a manual smoke of the workflow picker if visual verify is available.
- **resolved_by:** TASK-630

## FIND-SPRINT-015-8
- **source:** TASK-598 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/workflowRegistry.ts:102-110
- **description:** The `seed()` docstring still claims "Uses INSERT OR IGNORE on the `(project_id, name)` unique constraint so re-seeding the same project is idempotent". TASK-598 dropped that UNIQUE constraint from both schema.sql and migration 006, and the new idempotence story is "use a deterministic PK `wf-<projectId>-<name>` so INSERT OR IGNORE collides on the PK". The runtime behavior is correct — the docstring is the only thing that's stale.
- **suggested_action:** Update the docstring to: "Uses INSERT OR IGNORE on the deterministic primary key `wf-<projectId>-<name>` so re-seeding the same project is idempotent — existing rows are not updated." Also consider re-introducing an explicit `UNIQUE(project_id, name)` constraint as a defense-in-depth measure for any non-seed INSERT path that bypasses the deterministic-ID helper.
- **resolved_by:** 

## FIND-SPRINT-015-9
- **type:** scope_deviation
- **source:** TASK-630 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/components/Settings.tsx, frontend/src/hooks/useSessionView.ts, frontend/src/components/StravuFileSearch.tsx, frontend/src/components/panels/diff/CombinedDiffView.tsx, frontend/src/components/DraggableProjectTreeView.tsx, frontend/src/components/cyboflow/WorkflowPicker.tsx, frontend/src/components/StravuStatusIndicator.tsx, frontend/src/components/StravuConnection.tsx, frontend/src/hooks/useClaudePanel.ts, frontend/src/components/ProjectDashboard.tsx, frontend/src/components/ProjectTreeView.tsx, frontend/src/components/ProjectSelector.tsx, frontend/src/components/ProjectView.tsx, frontend/src/components/PromptHistory.tsx, frontend/src/components/PromptHistoryModal.tsx, frontend/src/components/SessionListItem.tsx, frontend/src/components/panels/claude/SessionStats.tsx, frontend/src/components/panels/claude/PromptNavigation.tsx, frontend/src/components/panels/ai/RichOutputView.tsx, frontend/src/components/panels/ai/MessagesView.tsx, frontend/src/components/CreateSessionDialog.tsx, frontend/src/components/cyboflow/WorkflowPicker.tsx
- **description:** Required to meet typecheck AC: callers access result.data without undefined checks, which T=any previously masked. These files must be narrowed with type guards or explicit casts to fix the errors surfaced by the IPCResponse<T=unknown> change.
- **resolved_by:** verifier — plan-prescribed: every listed file is already declared in TASK-630-plan.md `files_owned`, and Implementation Step 6 explicitly mandates fixing all typecheck errors that surface in caller files. Not a real scope deviation — executor misclassified files that were in-scope from the start.

## FIND-SPRINT-015-14
- **source:** TASK-630 (code-reviewer)
- **type:** bug
- **severity:** low
- **status:** open
- **location:** frontend/src/components/DraggableProjectTreeView.tsx:1199
- **description:** In `handleAddProject`, after `if (!response.success) return;` the code calls `(response.data as Project)` without a separate `response.data` undefined check. With `IPCResponse<T = unknown>` enforced, `response.data` is `Project | undefined` even when `success === true` (the type allows `{ success: true }` with no `data`). The runtime handler at `main/src/ipc/project.ts:70` does return `data` on success today, so this is latent — but it's the exact silent-bypass pattern TASK-630 aimed to eliminate. The cast lies about whether `data` is defined. Same pattern existed pre-task as `setProjectsWithSessions(response.data)` (also unguarded), so this isn't a regression — but TASK-630's audit pass missed correcting it.
- **suggested_action:** Replace the cast with a proper narrow: change `if (!response.success) return;` to `if (!response.success || !response.data) { /* show error */ return; }`, then drop the `as Project` and let `response.data` flow as `Project` directly. Same pattern check at any other `as Project` / `as Session` cast-after-success-only-guard sites surfaced during the audit.
- **resolved_by:** 

## FIND-SPRINT-015-13
- **source:** TASK-630 (code-reviewer)
- **type:** anti-pattern
- **severity:** medium
- **status:** open
- **location:** frontend/src/types/electron.d.ts:37
- **description:** TASK-630 introduces `type IPCDataResponse<T> = Omit<IPCResponse<T>, 'data'> & { data: T };` so callers can drop the `&& response.data` narrow after a `if (response.success)` check. The helper is type-unsound when the underlying handler can return `{ success: false, error }` without `data` (which most handlers do — see `main/src/ipc/session.ts:1684` for one example). The declared shape asserts `data: T` is always present regardless of `success`, re-introducing the same class of silent-bypass bug TASK-630 was designed to eliminate, just in the other direction: a future caller could write `result.data.foo` without checking `result.success`, the typecheck would pass, and a `{ success: false }` response at runtime would dereference `undefined`. In practice every current IPCDataResponse caller still gates with `if (response.success && response.data)` (see ProjectDashboard.tsx:81), so no concrete defect has shipped — but the helper exists specifically to enable dropping that gate, and the type system no longer enforces it. The discriminated-union shape `{ success: true; data: T } | { success: false; error: string }` would give the same call-site ergonomics under TS control-flow narrowing while preserving the contract.
- **suggested_action:** Spawn a follow-up task that owns `frontend/src/types/electron.d.ts` and `frontend/src/utils/api.ts` and either (a) deletes `IPCDataResponse` and reverts the ~14 channel signatures to `IPCResponse<T>` (callers already write the guard), or (b) refactors `IPCResponse<T>` itself to a tagged discriminated union — `{ success: true; data: T } | { success: false; error: string; details?: string; command?: string }` — so `if (result.success)` automatically narrows `result.data` to `T`. Option (b) is the more durable fix and aligns with the typed-IPC direction; verify with the existing component tests in TASK-630-plan.md AC8.
- **resolved_by:** 

## FIND-SPRINT-015-11
- **source:** TASK-630 (code-reviewer)
- **type:** anti-pattern
- **severity:** medium
- **status:** open
- **location:** frontend/src/App.tsx:34, frontend/src/components/DiscordPopup.tsx:5, frontend/src/components/OnboardingCard.tsx:4, frontend/src/components/ReviewQueueView.tsx:9
- **description:** Four files declare their own local `interface IPCResponse<T = unknown>` that duplicates the canonical type now defined in `frontend/src/types/electron.d.ts:26` and `frontend/src/utils/api.ts:10`. These pre-date TASK-630 but were not deduplicated by it. With the canonical type now stabilised to `<T = unknown>`, the local duplicates create a drift risk — any future change to the canonical shape (e.g. adding a new field like `requestId`) silently won't propagate, and casts like `as IPCResponse<string>` will succeed against the local definition with the stale shape. Audit grep: `grep -n "interface IPCResponse" frontend/src/{App.tsx,components/{DiscordPopup,OnboardingCard,ReviewQueueView}.tsx}` returns all 4.
- **suggested_action:** Replace each local declaration with `import type { IPCResponse } from '../utils/api';` (or `'./utils/api'` per relative depth). Verify with `pnpm --filter frontend typecheck` — the cast sites in each file already pass `<T>` explicitly so they should keep working unchanged. Pair with a CLAUDE.md bullet warning planners not to introduce a local `IPCResponse` interface — always import from the canonical location.
- **resolved_by:** 

## FIND-SPRINT-015-12
- **source:** TASK-630 (code-reviewer)
- **type:** anti-pattern
- **severity:** low
- **status:** open
- **location:** frontend/src/components/panels/ai/MessagesView.tsx:55, frontend/src/components/panels/ai/RichOutputView.tsx:219
- **description:** Two callers use `(response.data as unknown as LocalType[])` double-casts after `IPCResponse<ClaudeJsonMessage[]>` could not flow directly into local `JSONMessage[]` / `UserPromptMessage[]` types. The double-cast is the executor's path of least resistance for a pre-existing type-coherence gap: the local `JSONMessage` (MessagesView.tsx:12) declares `data: string` (always-string), but the runtime forEach loop accesses `msg.data` as if it were a `ClaudeJsonMessage` (string-or-object) and even handles the object case. The previous `<T=any>` masked this incoherence. Per the plan's "last-resort cast" guidance, the `as unknown as T` is allowed, but it papers over the fact that the local types diverge from the IPC payload shape — a future change to either side won't fail the typecheck. This is a legacy Crystal-era type-modelling debt, not a new defect.
- **suggested_action:** Spawn a follow-up task that owns the two `panels/ai/` view files and either (a) unifies the local `JSONMessage` / `UserPromptMessage` types with `ClaudeJsonMessage` from `frontend/src/types/session.ts`, or (b) introduces an explicit `function parseJsonMessage(raw: ClaudeJsonMessage): JSONMessage` adapter that performs the runtime sniffing the forEach loops do today, so the type cast is replaced by a real boundary. Keep the cast as `// FIXME(SPRINT-015): see FIND-SPRINT-015-12` for now.
- **resolved_by:** 

## FIND-SPRINT-015-10
- **type:** improvement
- **severity:** medium
- **source:** TASK-603 (verifier)
- **status:** open
- **location:** main/src/services/cyboflow/__tests__/transitions.test.ts:27, main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts:32
- **description:** TASK-603 extracted the shared REGISTRY_SCHEMA/GATE_SCHEMA fixture and migrated the 4 files listed in files_owned. But the codebase contains TWO ADDITIONAL inline-DDL sites that the planner missed: (1) `main/src/services/cyboflow/__tests__/transitions.test.ts:27` declares its own `SCHEMA_DDL` with a workflows + workflow_runs DDL that already DRIFTS from schema.sql (has `description`, `updated_at` on workflows; omits `permission_mode`, `permission_mode_snapshot`, `workflow_path`, `branch_name`, `error_message` on workflow_runs); (2) `main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts:32` declares a `MINIMAL_SCHEMA` with yet another divergent shape. Both files were added by TASK-452/TASK-153 before TASK-603 was planned, so the planner could have discovered them. The plan's preflight grep enumerated only 4 sites and missed these. The stated goal (`subsequent column additions are made in exactly one place`) is therefore NOT fully met — there are still 2 in-repo sites + schema.sql + migration 006 where DDL changes must be mirrored. Pairs with FIND-SPRINT-015-3's observation about discovery-pattern gaps.
- **suggested_action:** Spawn a follow-on task that owns the two test files and migrates them to import REGISTRY_SCHEMA (or a new MINIMAL_SCHEMA variant) from the fixture module. Beforehand, decide whether `mcpQueryHandler.test.ts` actually needs a minimal-only subset (worth keeping its `MINIMAL_SCHEMA` separate) or can share REGISTRY_SCHEMA (now that REGISTRY_SCHEMA contains all required columns). Either way, `transitions.test.ts` has DDL that drifts from the canonical shape today — its tests may pass only because they use minimal INSERT/SELECT statements that don't touch the missing columns, but any code change that exercises full row shape will fail there first.

## FIND-SPRINT-015-15
- **source:** TASK-604 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/__tests__/cancelAndRestart.test.ts:51, main/src/orchestrator/__tests__/approvalRouter.test.ts:59, main/src/orchestrator/__tests__/stuckDetector.test.ts:90, main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts:90, main/src/orchestrator/__tests__/inspectorQueries.test.ts:64
- **description:** TASK-604 extracted `dbAdapter` into `main/src/orchestrator/__test_fixtures__/dbAdapter.ts` and migrated the 4 sites enumerated in files_owned. But 5 additional test files outside scope still define identical `function dbAdapter(db: Database.Database): DatabaseLike` helpers with the exact same body (`prepare: (sql) => db.prepare(sql)` + the standard `transaction<T>` cast). These are direct drop-in replacement candidates — same signature, same body. (A 6th site, `main/src/trpc/__tests__/approvals.test.ts:39`, uses a narrower bespoke shape and is NOT substitutable.) Same DRY rationale as TASK-604: any future widening of `DatabaseLike` (e.g. adding `pragma()`) requires updating 5 silently-drifting copies. Mirrors FIND-SPRINT-015-10's "planner discovered only the listed sites" pattern.
- **suggested_action:** Spawn a low-complexity follow-up task that owns the 5 listed test files and replaces each inline `function dbAdapter(...)` block with `import { dbAdapter } from '<rel>/__test_fixtures__/dbAdapter';`. Leave `main/src/trpc/__tests__/approvals.test.ts` alone (different shape, intentional local narrowing).





- **resolved_by:*

## FIND-SPRINT-015-16
- **source:** TASK-605 (code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/utils/gitignoreWriter.test.ts:11-13, main/src/orchestrator/__tests__/workflowRegistry.test.ts:88
- **description:** TASK-605 created the `withTempDir` helper and migrated the 6 sites listed in `files_owned`. Two additional `mkdtempSync` sites outside that scope leak their temp dirs with no cleanup whatsoever — same class of leak the task targeted, just missed by the planner's discovery grep. (1) `gitignoreWriter.test.ts:11-13` defines `makeTempDir()` which calls `mkdtempSync(...,'gitignore-test-')` and is invoked from many `it` blocks; no `afterEach`/`afterAll` hook exists in the file. (2) `workflowRegistry.test.ts:88` calls `mkdtempSync(...,'workflow-registry-test-')` in `beforeEach` with no matching cleanup hook in the file. Both leave directories named `gitignore-test-*` and `workflow-registry-test-*` in `$TMPDIR` after every test run. The TASK-605 AC check (`ls $TMPDIR | grep -E 'runlauncher-test-|cyboflow-ipc-test-|cyboflow-gate-wf-|cyboflow-day3-'`) intentionally only covers the 4 prefixes the task was scoped to, so this leakage is invisible to the in-scope verification but real. Mirrors the same "planner discovered only the listed sites" pattern as FIND-SPRINT-015-10 and FIND-SPRINT-015-15.
- **suggested_action:** Spawn a low-complexity follow-up task that owns the two files and migrates each `it` body to `await withTempDir('gitignore-test-', ...)` / `await withTempDir('workflow-registry-test-', ...)` — replacing `makeTempDir()` in `gitignoreWriter.test.ts` and the `beforeEach` temp-dir creation in `workflowRegistry.test.ts`. Verify post-migration with `ls $TMPDIR | grep -E 'gitignore-test-|workflow-registry-test-'` returning no rows after `pnpm --filter main test`.





- **resolved_by:*

## FIND-SPRINT-015-17
- **source:** SPRINT-015 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/workflowRegistry.ts:200-205, shared/types/workflows.ts:20-42
- **description:** getRunById SELECT omits started_at and ended_at columns added by the SPRINT-015 schema reconciliation.
- **suggested_action:** In workflowRegistry.ts:202, extend the SELECT list to `..., started_at, ended_at, created_at, updated_at`. In shared/types/workflows.ts WorkflowRunRow, add `started_at?: string | null;` and `ended_at?: string | null;`. Add a regression test in workflowRegistry.test.ts mirroring the existing `reads back policy_json...` test pattern to round-trip these two fields.
- **resolved_by:** 





TASK-598 added `started_at DATETIME` and `ended_at DATETIME` to workflow_runs in both schema.sql (lines 70-71) and migration 006 (lines 31-32). However:
  1. workflowRegistry.ts:202 SELECT projects 13 columns and OMITS started_at/ended_at
  2. shared/types/workflows.ts:20-42 WorkflowRunRow type OMITS both fields

Callers that need run timing (stuck-detector epic, cancel/restart in cancelAndRestartHandler.ts:148 which already writes ended_at) cannot read these timestamps back through the registry. The columns exist in DDL only. This is an end-to-end gap that only surfaces when viewing the sprint as a whole — TASK-598 added the columns, but the projector + type were not extended.

Suspected tasks: TASK-598

## FIND-SPRINT-015-18
- **source:** SPRINT-015 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/preload.ts:170, frontend/src/types/electron.d.ts:26, frontend/src/utils/api.ts:10
- **description:** IPCResponse<T = unknown> is declared in THREE active-code files across two processes — the cross-process drift risk extends beyond FIND-SPRINT-015-11.
- **suggested_action:** Introduce `shared/types/ipc.ts` exporting the single canonical `IPCResponse<T>` and `IPCDataResponse<T>` (or its discriminated-union replacement per FIND-13). Migrate frontend/src/utils/api.ts, frontend/src/types/electron.d.ts, AND main/src/preload.ts to import from there. As a separate task, audit the ~200 `Promise<IPCResponse>` bare sites in preload.ts and either (a) parameterize each with a concrete T matching the handler return shape, or (b) at minimum confirm that `<T = unknown>` (not `<T = any>`) is what the bare uses resolve to. Update CLAUDE.md audit grep to also cover `main/src/preload.ts`.
- **resolved_by:** 




FIND-11 captured 4 frontend duplicates (App.tsx, DiscordPopup, OnboardingCard, ReviewQueueView) of the canonical type. This finding adds the THIRD canonical-tier site missed by both FIND-11 and the CLAUDE.md audit grep: `main/src/preload.ts:170` declares its own `interface IPCResponse<T = unknown> { success, data?, error? }` and applies it to ~200 `Promise<IPCResponse>` sites (note: bare, no T arg).

This is structurally trickier than the frontend duplicates because preload runs in the Electron preload context and cannot import from `frontend/src/utils/api.ts`. But the project does have a `shared/types/` directory, and currently neither `electron.d.ts` nor `api.ts` import the type from a shared module — they ALSO redeclare it. So the canonical type itself is duplicated 3 times before counting the 4 local frontend copies.

Project CLAUDE.md mandates `grep -rnE "IPCResponse[^<A-Za-z]" frontend/src` as the audit pattern. That grep deliberately excludes main/src, so preload.ts is technically out of mandated scope. But every one of the ~200 `Promise<IPCResponse>` sites in preload.ts is also a `<T = unknown>` bare site that the same TASK-630 logic would tighten — they ARE silent-bypass-prone.

Suspected tasks: TASK-630

## FIND-SPRINT-015-19
- **source:** SPRINT-015 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/utils/cyboflowApi.ts:55-60, 76-81, 146-150
- **description:** cyboflowApi.ts inlines three IPCResponse-shaped types instead of using the canonical IPCResponse<T>.
- **suggested_action:** Refactor cyboflowApi.ts to `import type { IPCResponse } from ./api;` and rewrite each `as { success: ..., data?: T, error? }` cast as `as IPCResponse<T>`. Then re-verify the helper functions with the standard `if (!res.success) throw ...; if (!res.data) throw ...;` narrow already used. This also future-proofs cyboflowApi for the discriminated-union refactor proposed in FIND-13.
- **resolved_by:** 



The new IPCResponse<T = unknown> is exported from `frontend/src/utils/api.ts`, but `cyboflowApi.ts` (in the same `utils/` directory) declares its own ad-hoc inline shape at each of three call sites:

  listWorkflows: `as { success: boolean; data?: WorkflowRow[]; error?: string }`
  startRun:      `as { success: boolean; data?: StartRunResult; error?: string }`
  approveRun:    `as { success: boolean; error?: string }`

Each call site re-writes the same `{ success, data?, error? }` shape rather than `as IPCResponse<WorkflowRow[]>`. This is the same drift-risk pattern flagged in FIND-SPRINT-015-11 for component-level local declarations, just expressed inline instead of as a named interface. Because TASK-630 explicitly excluded cyboflowApi.ts from its files_owned (it focuses on UI components and api.ts), these inline shapes were not normalised.

Suspected tasks: TASK-630 (out of declared scope)

## FIND-SPRINT-015-20
- **source:** SPRINT-015 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** docs/CODE-PATTERNS.md (new section)
- **description:** Cross-task meta-pattern: planner files_owned discovery missed sibling sites across THREE consecutive testing-infrastructure tasks (FIND-10, FIND-15, FIND-16).
- **suggested_action:** Add a `Refactor Discovery Pattern` section to docs/CODE-PATTERNS.md documenting the rule: for any extract-shared-utility task, run a structural grep across main/src + frontend/src + tests/ for the pre-refactor pattern (e.g. inline DDL `CREATE TABLE workflow_runs`, inline `function dbAdapter`, raw `mkdtempSync`). Every match must appear in files_owned or be explicitly excluded in plan_decisions with a reason. The planner-skeptic agent should reject plans that fail this check.
- **resolved_by:** 


Viewed individually each task did what its plan said. Viewed as a whole sprint, the same root cause repeats:

  TASK-603 (extract REGISTRY_SCHEMA/GATE_SCHEMA): missed 2 more in-repo inline DDL sites (FIND-10 — transitions.test.ts, mcpQueryHandler.test.ts)
  TASK-604 (extract dbAdapter): missed 5 more identical dbAdapter inline copies (FIND-15)
  TASK-605 (withTempDir helper): missed 2 more mkdtempSync leak sites, including workflowRegistry.test.ts which was IN the same sprint`s task chain (FIND-16)

Each planner used files_owned to enumerate scope, then verified only those sites — exactly the discovery pattern that misses adjacent code. The verifier of each task confirmed the in-scope sites worked; the leak only becomes visible when the sprint reviewer scans the whole codebase.

The rule that would have caught all three: when a refactor extracts a shared utility, the planner MUST run a structural grep for the OLD pattern (inline DDL, inline dbAdapter, raw mkdtempSync) across the WHOLE codebase, not just the listed scope — and include every match in files_owned (or explicitly justify exclusions).

This is also a SoloFlow workflow defect candidate: the planner-skeptic could add a checkbox `did the planner grep ALL of main/src and frontend/src for the pre-refactor pattern, not just files_owned?`

Also consider adding a soloflow-dev:planner hook: after files_owned is finalised, auto-grep for the most common refactor anti-patterns (mkdtempSync without rmSync; duplicate interface declarations; inline DDL) and surface unmatched hits as a planning warning.

## FIND-SPRINT-015-21
- **source:** SPRINT-015 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/database/schema.sql:43-75, main/src/database/migrations/006_cyboflow_schema.sql:5-34, main/src/database/__test_fixtures__/registrySchema.ts:21-53
- **description:** workflows + workflow_runs DDL is now declared in THREE active sites that must be kept in sync — and FIND-10 found 2 more in-repo divergent declarations. That is FIVE sites total for the same two tables.

The three reconciled sites (this finding):
  1. main/src/database/schema.sql (fresh-install path)
  2. main/src/database/migrations/006_cyboflow_schema.sql (upgrade path)
  3. main/src/database/__test_fixtures__/registrySchema.ts REGISTRY_SCHEMA (test fixture)

The two divergent sites flagged by FIND-10:
  4. main/src/services/cyboflow/__tests__/transitions.test.ts:27 SCHEMA_DDL (already drifted)
  5. main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts:32 MINIMAL_SCHEMA (already drifted)

The registrySchema.ts comment block instructs `Any column added to those tables at the canonical site MUST be mirrored here too` but does not name which of the 5 sites is canonical or what the verification recipe is. TASK-598`s end-of-task verification used grep that was insufficient (see FIND-3 + FIND-4).

This is multi-task synthesis: TASK-598 reconciled sites 1 + 2, TASK-603 extracted site 3, FIND-10 surfaced sites 4 + 5. Viewed individually no task is wrong; viewed as a whole the schema-drift surface has GROWN (one declaration is now five) and the only verification is human inspection.

Suspected tasks: TASK-598, TASK-603 (collectively)
- **suggested_action:** Add to docs/CODE-PATTERNS.md (or new docs/SCHEMA.md):
  (a) Designate ONE canonical source. The natural choice is migration 006 (last applied → authoritative final shape). schema.sql becomes a `derived` view: schema.sql should be the union of the inherited Crystal schema PLUS what migrations 003..006 produce. Ideally schema.sql is generated by `sqlite3 :memory: .schema` after running all migrations in CI.
  (b) Add a CI check: `node scripts/verify-schema-parity.js` that opens an in-memory DB, runs schema.sql, then re-runs every CREATE/ALTER from migrations 003..006, and asserts no new CREATE TABLE actually creates new tables (everything should be IF NOT EXISTS no-ops).
  (c) Co-locate REGISTRY_SCHEMA: in registrySchema.ts, replace the inline `REGISTRY_SCHEMA = ...` string with `readFileSync(join(__dirname, ..., "schema.sql"))` so the test fixture cannot drift from the real schema — at the cost of one runtime file read at test setup, which is fine.
- **resolved_by:** 
