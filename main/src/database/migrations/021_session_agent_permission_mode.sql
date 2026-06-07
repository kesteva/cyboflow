-- Migration 021: Add nullable agent_permission_mode to sessions for the
-- per-session 4-mode agent-permission override (Session Start Wizard step 3 +
-- quick-session config page).
--
-- This is the 4-mode PermissionMode ('default'|'acceptEdits'|'auto'|'dontAsk')
-- from shared/types/workflows.ts, DISTINCT from the legacy
-- sessions.permission_mode ('approve'|'ignore'). When set, the quick/legacy SDK
-- session spawn (resolveSessionAgentPermissionMode → getDbSession) PREFERS it
-- over the global default (Settings → Agent Permission Mode); NULL means
-- "inherit the global default" (byte-identical to before this column existed).
--
-- Workflow RUNS are unaffected — they read workflow_runs.permission_mode_snapshot
-- via RunExecutor, never this column.
--
-- NOTE: runFileBasedMigrations() in database.ts wraps every file in a
-- this.transaction(...) call, so no explicit BEGIN/COMMIT here. Mirrors the
-- nullable ALTER pattern of migration 009 (sessions.run_id).

ALTER TABLE sessions ADD COLUMN agent_permission_mode TEXT;
