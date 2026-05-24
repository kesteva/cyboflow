-- Migration 009: Add nullable run_id to sessions for quick-session support.
--
-- Context: IDEA-024 ("quick-session") establishes that quick sessions
-- created outside any flow are not associated with a workflow_runs row.
-- The chosen design (user-locked answer to Q1) is a nullable run_id on
-- sessions — quick sessions persist run_id = NULL; flow sessions will
-- continue to be backfilled by their owning run when the runtime path
-- that writes this column lands (T2: sessions:create-quick handler;
-- flow-side backfill is out of scope for this migration).

ALTER TABLE sessions ADD COLUMN run_id TEXT;
