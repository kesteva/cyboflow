-- Migration 148: drop dead Crystal-era tables and columns.
--
-- Nothing reads or writes any of these any more, and database.ts's inline
-- runMigrations() no longer creates or re-adds them (removed in the same
-- commit, so the next boot cannot bring them back):
--
--   sessions.auto_commit / commit_mode / commit_mode_settings
--       Crystal's per-session commit modes, retired with the commit-mode
--       machinery; only the inline adders and their backfill touched them.
--   sessions.last_output / pid
--       Accepted by updateSession() but never written by anything.
--       (sessions.exit_code stays: the SDK substrate's per-turn exit writes it.)
--   projects.main_branch / lastUsedModel / commit_mode /
--   commit_structured_prompt_template / commit_checkpoint_prefix
--       main_branch was written at create time and never read (the runtime
--       always re-detects the branch); the rest had no reader or writer.
--   project_run_commands
--       Write-only duplicate of projects.run_script; its manager is gone.
--   app_opens
--       Per-launch rows nothing ever read.
--   messages (migration 006)
--       Empty by design: chat history is reconstructed from raw_events.
--
-- IDEMPOTENCE. The runner tolerates `duplicate column name` per statement but
-- NOT `no such column`, so a bare DROP COLUMN would block boot on a fresh DB
-- (which never had these columns) and on a ledger-wiped replay. Each column is
-- therefore ADDed first — a no-op duplicate on DBs that still carry it, a real
-- add on DBs that do not — and then DROPped, which always succeeds. None of the
-- dropped columns sits in an index, CHECK, foreign key, trigger or view, which
-- is what SQLite requires for DROP COLUMN.
--
-- ORDER. scripts/verify-schema-parity.js replays each file with a single
-- db.exec() and stops at the first error. Its replays have no `projects` table
-- (created imperatively by database.ts), so the projects statements come LAST:
-- everything above them still applies there.
--
-- No `PRAGMA foreign_keys=OFF` marker: every dropped table is an FK child only
-- (nothing references it), so the implicit DELETE cascades nowhere.

ALTER TABLE sessions ADD COLUMN auto_commit BOOLEAN;
ALTER TABLE sessions DROP COLUMN auto_commit;
ALTER TABLE sessions ADD COLUMN commit_mode TEXT;
ALTER TABLE sessions DROP COLUMN commit_mode;
ALTER TABLE sessions ADD COLUMN commit_mode_settings TEXT;
ALTER TABLE sessions DROP COLUMN commit_mode_settings;
ALTER TABLE sessions ADD COLUMN last_output TEXT;
ALTER TABLE sessions DROP COLUMN last_output;
ALTER TABLE sessions ADD COLUMN pid INTEGER;
ALTER TABLE sessions DROP COLUMN pid;

DROP TABLE IF EXISTS project_run_commands;
DROP TABLE IF EXISTS app_opens;
DROP TABLE IF EXISTS messages;

ALTER TABLE projects ADD COLUMN main_branch TEXT;
ALTER TABLE projects DROP COLUMN main_branch;
ALTER TABLE projects ADD COLUMN lastUsedModel TEXT;
ALTER TABLE projects DROP COLUMN lastUsedModel;
ALTER TABLE projects ADD COLUMN commit_mode TEXT;
ALTER TABLE projects DROP COLUMN commit_mode;
ALTER TABLE projects ADD COLUMN commit_structured_prompt_template TEXT;
ALTER TABLE projects DROP COLUMN commit_structured_prompt_template;
ALTER TABLE projects ADD COLUMN commit_checkpoint_prefix TEXT;
ALTER TABLE projects DROP COLUMN commit_checkpoint_prefix;
