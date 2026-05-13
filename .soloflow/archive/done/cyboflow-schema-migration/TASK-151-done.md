---
id: TASK-151
sprint: SPRINT-005
epic: cyboflow-schema-migration
status: done
summary: "Add numeric-prefix file-based migration runner with legacy 003/004/005 backfill bridge"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-151 — Done Report

## Summary

Added `runFileBasedMigrations()` and `backfillLegacyFileMigrationFlags()` private methods to `DatabaseService` in `main/src/database/database.ts`, wired as the final phase of `runMigrations()`. The runner scans `__dirname/migrations`, filters with `/^(\d{3})_.*\.sql$/`, sorts numerically by the 3-digit prefix, and applies each unapplied file inside a per-file `this.transaction()` with idempotency tracked via `user_preferences` keys (`file_migration_applied:<filename>`). The backfill bridge pre-flags 003/004/005 as already-applied on existing installs by probing for the `tool_panels` table (003) and the `claude_panels_migrated` / `unified_panel_settings_migrated` markers (004/005), preventing double-apply on upgrade.

An internal-only test seam (`setMigrationsDirForTesting`) allows tests to point the runner at fixture dirs without disturbing the production constructor surface.

## Changes

- `main/src/database/database.ts` — added `readdirSync` to fs import; added `migrationsDirOverride` private field + `setMigrationsDirForTesting()`; added `backfillLegacyFileMigrationFlags()` and `runFileBasedMigrations()`; wired the runner call as the last line of `runMigrations()`.
- `main/src/database/__tests__/fileMigrationRunner.test.ts` (new) — 6 unit tests: fresh-DB apply, idempotency, broken-file tolerance, legacy 003/004/005 backfill, non-numeric-prefix skipping (with WARN), and numeric (not lexicographic) sort order.

## Commits

- `023ef96` — `feat(TASK-151): add numeric-prefix file-based migration runner`
- `f45d069` — `test(TASK-151): add unit tests for file-based migration runner`
- `275b954` — `test(TASK-151): add coverage for prefix filtering and numeric sort`

## Verification

- Tests: 6/6 fileMigrationRunner cases pass; 28/28 main workspace total.
- Typecheck: PASS.
- Lint: 0 errors (305 pre-existing warnings in frontend/, unrelated).
- Per-task visual: skipped (parallel mode).

## Notes

- Environment quirk: `better-sqlite3` native addon is built for Electron's Node ABI; vitest running under system Node v24 required a one-time `npm rebuild better-sqlite3` in the worktree. Pre-existing project concern, not introduced by this task.
- One out-of-diff finding logged for the sprint: ~18 legacy non-prefixed `.sql` files in `main/src/database/migrations/` will now emit WARN log lines on every boot. Cleanup is a separate concern (filed as `FIND-SPRINT-005-1`).
