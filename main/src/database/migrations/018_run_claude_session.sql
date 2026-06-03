-- Migration 018: Add claude_session_id to workflow_runs (idle-chat nudge / conversation resume).
--
-- Captures the SDK `session_id` from the first system/init event of a workflow run's
-- SDK query (claudeCodeManager.runSdkQuery). When the user nudges a run that has
-- drained to awaiting_review, nudgeRunHandler re-spawns with `--resume <session_id>`
-- so the agent keeps full conversation context — the nudge is a true follow-up turn,
-- not a fresh planner re-run.
--
-- Workflow runs never create a `panels` row, so the existing panel-customState
-- session-id store (getPanelClaudeSessionId) is empty for them — hence this column.
-- Quick sessions keep their own sessions.claude_session_id capture untouched.
--
-- Nullable, NO FK (free-form SDK identifier, not a row reference) — populated lazily
-- on the run's first init event; NULL until then and for any run that never spawned.
--
-- NOTE: No `IF NOT EXISTS` — SQLite ALTER TABLE does not support it. Re-running this
-- migration raises 'duplicate column name: claude_session_id', which is exactly the
-- idempotency signal runFileBasedMigrations() in database.ts uses to skip
-- already-applied files (same mechanism migrations 013 / 017 rely on).
--
-- NOTE: No explicit BEGIN/COMMIT here — runFileBasedMigrations() in database.ts
-- wraps every file in a this.transaction(...) call.

ALTER TABLE workflow_runs
  ADD COLUMN claude_session_id TEXT;
