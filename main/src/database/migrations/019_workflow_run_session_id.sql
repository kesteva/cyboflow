-- Migration 019: Add session_id to workflow_runs (session<->run restructure, Phase 0).
--
-- Inverts the 1:1 sessions.run_id link (migration 009) into a true
-- one-session -> many-runs association: a single chat session can own multiple
-- workflow runs over its lifetime, so the link belongs on the run, not the session.
-- This column is INERT in Phase 0 — no reader consumes it yet; it only seeds the
-- read model so later slices can flip over from the sessions.run_id back-reference.
--
-- Backfill: for every existing run that a quick session already points at via
-- sessions.run_id, copy that session's id forward into workflow_runs.session_id so
-- the new forward link matches the historical back link. Legacy parentless flow runs
-- (no owning session row) stay session_id = NULL.
--
-- Nullable, NO FK on purpose (soft-polymorphic, mirrors entity_events.run_id and
-- the seed_idea_id link in migration 017) — the referenced session row may be
-- deleted while the run record survives for history, so a hard FK would be wrong.
--
-- NOTE: No `IF NOT EXISTS` — SQLite ALTER TABLE does not support it. Re-running this
-- migration raises 'duplicate column name: session_id', which is exactly the
-- idempotency signal runFileBasedMigrations() in database.ts uses to skip
-- already-applied files (same mechanism migrations 013 / 017 / 018 rely on).
--
-- NOTE: No explicit BEGIN/COMMIT here — runFileBasedMigrations() in database.ts
-- wraps every file in a this.transaction(...) call.

ALTER TABLE workflow_runs ADD COLUMN session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_workflow_runs_session_id ON workflow_runs(session_id);

UPDATE workflow_runs SET session_id = (SELECT s.id FROM sessions s WHERE s.run_id = workflow_runs.id) WHERE session_id IS NULL;
