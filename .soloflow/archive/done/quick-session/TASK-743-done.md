---
id: TASK-743
sprint: SPRINT-036
epic: quick-session
status: done
summary: "Add nullable run_id migration (009) to sessions table; harden file migration runner against duplicate-column errors."
executor_loops: 1
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-743 — Done

## Summary
Added migration `009_sessions_run_id.sql` — a single `ALTER TABLE sessions ADD COLUMN run_id TEXT` (nullable, no DEFAULT, no FK). Authored `sessionsRunIdMigration.test.ts` (shape + idempotency, real DatabaseService). 

First executor pass mis-classified a regression in `cyboflowSchema.test.ts:497` as pre-existing; verifier proved it was caused by 009 (when the ledger marker is erased but the column persists, the next initialize() raises `duplicate column name: run_id` → console.error → test fails). Follow-up commit hardened `runFileBasedMigrations` to treat `duplicate column name:` errors as idempotent: log at warn, still record the ledger marker. Final pass added a direct fixture-driven unit test for that branch.

Lays foundation for IDEA-024 quick-session epic; T2 can write `run_id = NULL` for quick sessions.

## Verification
- `pnpm test:unit` → 648 main + 322 frontend + schema parity + build scripts all pass.
- `pnpm typecheck` → 0 errors.
- `pnpm --filter main exec vitest run src/database/__tests__/cyboflowSchema.test.ts -t "auto-flags 003/004/005"` → passes.
- New tests: 2 in sessionsRunIdMigration.test.ts + 1 in fileMigrationRunner.test.ts.
- All six acceptance criteria pass.
- Visual verification: not_applicable — backend migration + runner fix.

## Code Review
CLEAN. Substring match on `duplicate column name:` documented (SQLite has no `ADD COLUMN IF NOT EXISTS` until 3.35). All other errors continue on the `console.error` + skip-marker path.

## Findings
Resolved: FIND-SPRINT-036-5 (mis-classified pre-existing), FIND-SPRINT-036-6 (root cause of regression), FIND-SPRINT-036-7 (direct-coverage gap addressed by 8be67d2).

## Commits
- `fcd455e` — `feat(TASK-743): add migration 009 — nullable run_id column on sessions`
- `7cd436a` — `fix(TASK-743): treat duplicate-column-name as idempotent in file migration runner`
- `8be67d2` — `test(TASK-743): add direct unit test for duplicate-column-name idempotency branch`
