---
id: TASK-757
sprint: SPRINT-039
epic: ask-user-question-roundtrip
status: done
summary: "Shipped shared question wire types, DB migration 010 (questions table + workflow_runs awaiting_input CHECK rebuild), state-machine widening, and a FK-preservation fix for the migration runner so child rows (approvals/messages/raw_events) survive the workflow_runs DROP+RENAME."
executor_loops: 0
code_review_rounds: 1
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-757 — Shared Question types and DB migration 010

## Outcome

Foundation for the AskUserQuestion epic:

- **Wire types**: `shared/types/questions.ts` — pure-type module (zero runtime imports) with `QuestionPayload`, `Question`, `QuestionAnswer`, `QuestionCreatedEvent`, `QuestionAnsweredEvent`. Modeled on `approvals.ts`.
- **State machine**: `WorkflowRunStatus` widened to include `'awaiting_input'`. `ALLOWED_TRANSITIONS` updated: `running ↔ awaiting_input`, `awaiting_input → canceled`, `awaiting_input → failed`. Explicitly NO transition to `stuck` (per IDEA-025 Q2: awaiting_input runs are exempt from stuck classification).
- **DB schema**: migration 010 creates the `questions` table and rebuilds `workflow_runs` with the 9-status CHECK constraint. `schema.sql` updated for fresh installs. All 3 pre-existing `workflow_runs` indexes preserved; new `idx_questions_status_created` added.
- **FK preservation (critical fix, code-reviewer-driven)**: `runFileBasedMigrations` in `main/src/database/database.ts` now toggles `PRAGMA foreign_keys=OFF` OUTSIDE the per-file `this.transaction(...)` wrapper for migrations that need it (SQLite ignores pragma toggles inside transactions). A `finally` block restores `ON` unconditionally. Without this fix, `DROP TABLE workflow_runs` would have CASCADE-deleted every row in `approvals`, `messages`, and `raw_events` on upgrade.

## Verification

- Acceptance criteria 1–11: all met (verifier APPROVED on second pass after the FK fix).
- Unit tests: 671/671 main tests pass — includes migration010.test.ts (8 tests with the new FK-survival regression), stateMachine.test.ts (41 tests), stuckDetector.test.ts (13 tests with the new awaiting_input exemption), and fileMigrationRunner.test.ts (8 tests with the new `needsFkOff` runner-path regression).
- `pnpm typecheck` exits 0.
- `pnpm test:unit` exits non-zero ONLY because of 4 pre-existing failures in `frontend/src/stores/__tests__/reviewQueueStore.test.ts` (FIND-SPRINT-039-2, traced to TASK-750's trpc-shim removal). Not caused by this task — `git stash` baseline reproduces the failures without these changes.

## Process notes

- Code review caught a critical data-loss bug in the original migration that the verifier (and the dev-written tests) missed because the test path called `db.exec(...)` directly under autocommit, while the production path wraps in `this.transaction(...)` and silently no-ops the inner `PRAGMA foreign_keys` toggle. The new regression tests now exercise the production-path wrapper.
- Tier 2 `reconcileWorkflowRunsSchema` (`database.ts:1388`) still hard-codes the 8-status CHECK and only re-creates 2 of 3 indexes. Deferred per plan rationale — low probability of firing post-010, recoverable symptom (CHECK violation on awaiting_input insert). Worth a future task once TASK-758 exercises awaiting_input in production.

## Commits

- `b28c084` — feat(TASK-757): add questions wire types, migration 010, and awaiting_input state
- `638fd5d` — fix(TASK-757): remove awaiting_input from migration 010 SQL comments
- `5559bf9` — fix(TASK-757): preserve FK children during migration 010 workflow_runs rebuild
- `cfbc705` — test(TASK-757): add fileMigrationRunner FK-toggle regression
