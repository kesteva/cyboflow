---
id: TASK-155
sprint: SPRINT-005
epic: cyboflow-schema-migration
status: done
summary: "Migration ordering integration tests + ARCHITECTURE.md two-phase migration rewrite"
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-155 — Done Report

## Summary

Extended `main/src/database/__tests__/cyboflowSchema.test.ts` with 3 integration tests (now 10 total): fresh-install ordering with ledger marker + idempotency proof; existing-install auto-backfill (tightened by the test-writer to clear all `file_migration_applied:*` entries between two `DatabaseService` instances so the backfill path is genuinely exercised); EXPLAIN QUERY PLAN string match confirming SQLite chooses `idx_raw_events_run_id` for the canonical `raw_events` tail-read query.

Rewrote `docs/ARCHITECTURE.md` §Data Model to replace the misleading "plain SQL files applied in filename order" claim with the actual two-phase pattern: Phase 1 inline migrations in `runMigrations()` gated on `PRAGMA table_info` + `user_preferences` markers; Phase 2 file-based `runFileBasedMigrations()` using `file_migration_applied:<filename>` ledger keys; backfill behavior for legacy 003/004/005 on upgrade.

## Changes

- `main/src/database/__tests__/cyboflowSchema.test.ts` (extended +3 tests; later tightened the backfill-isolation case + dropped unused imports)
- `docs/ARCHITECTURE.md` (§Data Model rewrite)

## Commits

- `a7cddbe` — `test(TASK-155): add 3 migration-runner integration tests to cyboflowSchema.test.ts`
- `153a64f` — `docs(TASK-155): rewrite ARCHITECTURE.md §Data Model to describe two-phase migration`
- `a8bafa1` — `test(TASK-155): isolate backfill path and drop unused imports`

## Verification

- Tests: 10/10 cyboflowSchema cases pass.
- Typecheck: PASS.
- Lint: 0 errors.
- AC-4 grep `runFileBasedMigrations|file_migration_applied` → 5 matches in ARCHITECTURE.md (≥ 2 required).
- Per-task visual: skipped (parallel mode).

## Deferred Checks (queued for human review)

- **AC-1 manual Electron-boot smoke** (bucket: testing, severity: medium): `rm -rf ~/.cyboflow; pnpm --filter main build; pnpm electron-dev` then tail `cyboflow-backend-debug.log` for `[Database] Applied file migration: 006_cyboflow_schema.sql` on first boot; second boot must NOT log it. Verifies the `__dirname` resolution under real Electron asar packaging, which the test harness mocks.

## Notes

- Plan referenced `idx_raw_events_run_id_id` but the actual index name in `006_cyboflow_schema.sql` is `idx_raw_events_run_id`. Test uses the correct actual name; EXPLAIN QUERY PLAN confirms SQLite chooses it. Plan-text was authoritatively wrong; implementation is correct.
- FIND-SPRINT-005-2 (test isolation gap) and FIND-SPRINT-005-3 (unused imports) were resolved by the test-writer in the same task; remaining sprint findings are FIND-SPRINT-005-1 (legacy non-prefixed .sql files), FIND-SPRINT-005-4 (cosmetic cast in TASK-154), FIND-SPRINT-005-5 (parseClaudeStreamEvent duplication with TypedEventNarrowing — out-of-diff, deferred to TASK-205 wiring).
