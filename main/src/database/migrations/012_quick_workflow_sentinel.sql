-- Migration 012: Add is_quick column to sessions and seed __quick__ sentinel workflows
--
-- Context: TASK-787 (IDEA-027 quick-session pipeline). Quick sessions need to
-- participate in the workflow_runs pipeline. This migration:
--   1. Adds is_quick BOOLEAN DEFAULT 0 to sessions.
--   2. Backfills is_quick = 1 for existing quick sessions (run_id IS NULL,
--      non-main-repo rows — the same predicate that getQuickSessions() used
--      before this migration).
--   3. Inserts a sentinel __quick__ workflow row for every existing project so
--      that quick sessions can reference a stable workflow_id.
--
-- The sentinel id format matches the deterministic id used by WorkflowRegistry.seed:
--   wf-{projectId}-__quick__
--
-- NOTE: No explicit BEGIN/COMMIT here — runFileBasedMigrations() in database.ts
-- wraps every file in a this.transaction(...) call.

ALTER TABLE sessions ADD COLUMN is_quick BOOLEAN DEFAULT 0;

UPDATE sessions SET is_quick = 1 WHERE run_id IS NULL AND (is_main_repo = 0 OR is_main_repo IS NULL);

INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json, permission_mode, created_at)
SELECT
  'wf-' || id || '-__quick__',
  id,
  '__quick__',
  '{}',
  'default',
  datetime('now')
FROM projects;
