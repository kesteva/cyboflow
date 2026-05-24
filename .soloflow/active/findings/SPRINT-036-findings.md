---
sprint: SPRINT-036
pending_count: 5
last_updated: "2026-05-24T21:05:00.000Z"
---
# Findings Queue

- SPRINT-036 started with missing infra: docker; tests deferred.

## FIND-SPRINT-036-1
- **source:** TASK-735 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/ipc/prompt.ts:26, main/src/preload.ts:323, frontend/src/utils/api.ts:399, frontend/src/types/electron.d.ts:207
- **description:** After TASK-735 deleted the `navigateToPrompt` dispatch block in `PromptHistoryModal.tsx`, the `prompts:get-by-id` IPC channel and its full call chain (`API.prompts.getByPromptId` wrapper, preload binding, `ipcMain.handle('prompts:get-by-id', ...)`) have zero remaining consumers in `frontend/src/`. The only call site was the now-removed `try { const response = await API.prompts.getByPromptId(promptItem.id); ... }` block. The handler, wrapper, and type declaration are now dead infrastructure preserved only for symmetry with the deleted dispatch.
- **suggested_action:** Either (a) delete the orphan chain (`ipcMain.handle('prompts:get-by-id', ...)`, the preload binding, the `api.ts` wrapper, and the `prompts.getByPromptId` line in `electron.d.ts`) in a follow-up cleanup task, or (b) mark them with `@cyboflow-hidden` annotations explicitly documenting they are preserved for a future "navigate-to-specific-prompt" feature (per the TASK-735 plan's "Lowest Confidence Area" — re-introducing the listener+routing in CyboflowRoot). Default recommendation: (a), with (b) only if a v2 prompt-navigation feature is on the near roadmap.
- **resolved_by:** 

## FIND-SPRINT-036-2
- **source:** TASK-739 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/trpc/routers/__tests__/runs.test.ts:249-260
- **description:** TASK-739 removed the `(c) Non-'local' userId → FORBIDDEN` test from the `cyboflow.runs.start` describe block, which was the only test inside that describe that intentionally left `startRunDeps` unwired. The remaining `(a)` and `(b)` tests each wire their own stub deps inside a `try/finally`. The describe's `afterEach` block is now an empty function body decorated with a ~10-line comment that explains its purpose by referencing the deleted test ("For the METHOD_NOT_SUPPORTED test we simply don't call setStartRunDeps at all... afterEach from a preceding test must have reset it"). The rationale no longer matches the code — the `afterEach` does nothing and the comment names a test that no longer exists.
- **suggested_action:** Delete the empty `afterEach(() => { /* comment */ })` block entirely (lines 249-260), since both surviving tests handle their own deps reset in `finally` blocks. Alternatively, replace the comment with a one-liner explaining the per-test `try/finally` pattern is the new reset mechanism.
- **resolved_by:** 

## FIND-SPRINT-036-3
- **source:** TASK-740 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts:24
- **description:** After TASK-740 removed the local `createTestDb` (the sole runtime user of `new Database(':memory:')`), the only remaining reference to the `better-sqlite3` `Database` import in this file is the type annotation `db: Database.Database` on line 139. The import is still a runtime `import Database from 'better-sqlite3'`, but the sibling sweep in `runs.test.ts` correctly downgraded its parallel import to `import type Database from 'better-sqlite3'` in the same commit. This is a small consistency drift — both swept files should treat the type-only `Database` symbol identically.
- **suggested_action:** Change `import Database from 'better-sqlite3';` to `import type Database from 'better-sqlite3';` at line 24 of `claudeCodeManager.composeMcpServers.test.ts`. Verify via `grep -n "new Database\|Database\\.prepare\|Database\\.exec" main/src/services/panels/claude/__tests__/claudeCodeManager.composeMcpServers.test.ts` returns 0 hits (confirming type-only usage) before the change.
- **resolved_by:** 

## FIND-SPRINT-036-4
- **type:** claude-md
- **severity:** low
- **status:** open
- **source:** TASK-742 (verifier)
- **location:** package.json:52
- **description:** The package.json scripts.test:e2e uses a shell wrapper (`sh -c 'while [ "$1" = "--" ]; do shift; done; playwright test "$@"' --`) rather than the literal `playwright test` the plan prescribed. Empirically verified: plain `"test:e2e": "playwright test"` causes `pnpm test:e2e -- tests/smoke.spec.ts --list` to fail AC5 (Playwright ignores `--list` and actually runs the tests, which then fail because the renderer cannot bootstrap). The wrapper is required because pnpm forwards the `--` separator into the inner command, where Playwright treats it as an unknown positional arg and discards flags after it. This is a non-obvious pnpm-Playwright interaction worth documenting.
- **suggested_action:** Add a brief note to docs/CODE-PATTERNS.md (or wherever script-wiring patterns live) explaining the pnpm `--` separator quirk and the shell-wrapper workaround, so future plan-authors don't prescribe the simpler-looking plain form and have it fail AC checks like AC5.

## FIND-SPRINT-036-5
- **type:** bug
- **source:** TASK-743 (executor)
- **severity:** medium
- **status:** resolved
- **location:** main/src/database/__tests__/cyboflowSchema.test.ts:497
- **description:** ~~Pre-existing test failure (confirmed present before TASK-743 changes).~~ **CORRECTED BY VERIFIER (FIND-SPRINT-036-6):** the failure is directly caused by migration 009 added in TASK-743. The executor's stash methodology was flawed — see FIND-SPRINT-036-6 for the corrected root cause and reproduction.
- **suggested_action:** ~~Investigate what console.error is fired during the second initialize() in this test and either fix the error source or update the test assertion to allow the expected benign error.~~ Superseded by FIND-SPRINT-036-6.
- **resolved_by:** TASK-743

## FIND-SPRINT-036-6
- **type:** bug
- **source:** TASK-743 (verifier)
- **severity:** high
- **status:** resolved
- **location:** main/src/database/migrations/009_sessions_run_id.sql + main/src/database/__tests__/cyboflowSchema.test.ts:497
- **description:** Migration 009 (`ALTER TABLE sessions ADD COLUMN run_id TEXT`) causes the existing test `006_cyboflow_schema — existing-install migration runner integration > auto-flags 003/004/005 and applies 006 exactly once with no errors` to fail AC "no console.error calls during second initialize()". Reproduction (verifier-confirmed): (1) `mv main/src/database/migrations/009_sessions_run_id.sql /tmp/ && pnpm --filter main exec vitest run src/database/__tests__/cyboflowSchema.test.ts -t "auto-flags 003/004/005"` → PASS. (2) Restore 009 and re-run → FAIL with `[Database] Migration 009_sessions_run_id.sql failed: SqliteError: duplicate column name: run_id`. Root cause: the test sequence creates DB → svc1.initialize() runs all migrations including 009 (adds run_id to sessions) → test DROPs the 5 Cyboflow tables (workflows, workflow_runs, raw_events, messages, approvals) but NOT the sessions table → test DELETEs all `file_migration_applied:*` ledger entries → svc2.initialize() re-runs all file migrations. 009 has no ledger row so it re-executes its ALTER, but run_id already exists on sessions → SqliteError thrown, caught by runFileBasedMigrations (database.ts:1600), logged as console.error. The migration runner uses `IF NOT EXISTS` semantics indirectly via the ledger marker, but the test artificially bypasses the marker for 006 while preserving 009's prior effects, exposing 009's lack of intrinsic idempotency. The plan's Lowest Confidence Area discussed schema-parity path-2 (no-such-table tolerance) but did NOT anticipate this test scenario. The executor's "pre-existing" classification was incorrect — verifier confirmed by removing only 009 (not the new test file) and observing the failure disappears. The executor's stash likely removed both the migration AND the new sessionsRunIdMigration test, which is irrelevant; the affected test is cyboflowSchema.test.ts.
- **suggested_action:** Two viable fixes — (a) Make migration 009 intrinsically idempotent by emitting a SQLite-compatible idempotent form (e.g. wrap in a `SELECT ... PRAGMA table_info` check via separate logic, or split into a runtime check in database.ts since SQLite has no `ADD COLUMN IF NOT EXISTS` until 3.35). The simplest pattern matching repo precedent: change 009 to call `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE`, but here we already have sessions; use a noop guard like wrapping in a transaction that pre-checks via `pragma_table_info`. (b) Update cyboflowSchema.test.ts:497 to either also DROP sessions table OR assert "no console.error calls from non-009 sources" — but this widens the test contract and is a worse change than fixing 009. Default recommendation: (a) — make 009 self-idempotent in the migration runner or in the SQL itself, since this same pattern will recur for any future ALTER-only migration in a sessions-survives-reset test fixture. The cheapest concrete fix: amend `runFileBasedMigrations` to swallow `duplicate column name:` errors with a warn (not error) and ledger the migration as applied (treat the column already existing as a successful idempotent application), then no migration-file change is needed.
- **resolved_by:** TASK-743

## FIND-SPRINT-036-7
- **source:** TASK-743 (code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** main/src/database/__tests__/fileMigrationRunner.test.ts
- **description:** Commit 7cd436a added a new branch to `runFileBasedMigrations` (database.ts:1597-1613) that treats SqliteError messages containing `duplicate column name:` as a successful idempotent application — it records the ledger marker and logs at `console.warn` instead of `console.error`. This is the AC6-prescribed fix for FIND-SPRINT-036-6, and the plan explicitly listed `fileMigrationRunner.test.ts` in `files_owned` for this task. However, the new branch is not directly covered by a synthetic-fixture test in the runner's own suite — coverage today is indirect (the `cyboflowSchema.test.ts` "auto-flags 003/004/005" test exercises it via the real migration 009, and `sessionsRunIdMigration.test.ts` exercises the happy-path ledger-marker idempotency without hitting the duplicate-column branch). If a future SQLite or better-sqlite3 upgrade changes the error message format, the substring match will silently regress to logging `error` again and the only failing test will be the `cyboflowSchema` "no console.error" assertion, several layers removed from the runner contract.
- **suggested_action:** Add one fixture-driven test in `main/src/database/__tests__/fileMigrationRunner.test.ts` that writes a synthetic two-step migration: `000_seed.sql` creates a small table with one column, and `001_dup.sql` runs an `ALTER TABLE … ADD COLUMN` for that same column. After `svc.initialize()`, assert (a) no throw, (b) ledger marker `file_migration_applied:001_dup.sql` is recorded, (c) `console.warn` was called with a message mentioning `001_dup.sql`, (d) `console.error` was NOT called for `001_dup.sql`. This pins the runner contract without depending on migration 009's specific SQL and would catch any future drift in the error-message substring.
- **resolved_by:** 
