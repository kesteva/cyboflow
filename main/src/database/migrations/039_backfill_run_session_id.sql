-- 039_backfill_run_session_id.sql
-- Idempotent. Re-run migration 019's recovery for workflow_runs that became NULL
-- after 019 (SDK quick sentinels created post-019 left session_id NULL by design).
-- Hard enforcement of the never-session-less invariant is the createRun throw
-- (slice 1b); this is best-effort history cleanup.
UPDATE workflow_runs
   SET session_id = (SELECT s.id FROM sessions s WHERE s.run_id = workflow_runs.id)
 WHERE session_id IS NULL
   AND EXISTS (SELECT 1 FROM sessions s WHERE s.run_id = workflow_runs.id);
