-- Migration 025: Add nullable substrate to sessions for opt-in interactive
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
-- this.transaction(...) call, so no explicit BEGIN/COMMIT here. Numbers
-- 022/023 are reserved by the unmerged feat/parallel-sprint branch.

ALTER TABLE sessions ADD COLUMN substrate TEXT;
