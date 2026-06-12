-- Migration 027: Add nullable substrate to sessions for opt-in interactive
-- PTY quick sessions (Session Start Wizard substrate picker).
--
-- This is the CliSubstrate union ('sdk'|'interactive') from
-- shared/types/substrate.ts, stamped by sessions:create-quick alongside the
-- sentinel __quick__ workflow_runs.substrate. NULL means "legacy/SDK"
-- (byte-identical behavior to before this column existed). Validation happens
-- at the write chokepoint (isCliSubstrate) — no CHECK constraint, mirroring
-- the nullable ALTER pattern of migration 021 (sessions.agent_permission_mode).
--
-- NOTE: runFileBasedMigrations() in database.ts wraps every file in a
-- this.transaction(...) call, so no explicit BEGIN/COMMIT here. Renumbered
-- 025 -> 027 on rebase: main owns 025 (sprint lane attempts) and 026
-- (run_usage/spec_hash). Dev DBs that already applied this file under its old
-- name re-run it as 027; the runner's duplicate-column tolerance marks it
-- applied (filename-keyed ledger).

ALTER TABLE sessions ADD COLUMN substrate TEXT;
