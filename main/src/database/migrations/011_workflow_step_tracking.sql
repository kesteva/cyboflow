-- Migration 011: Add current_step_id column to workflow_runs (IDEA-026 / TASK-764).
--
-- This column stores the dotted-string identifier of the workflow step
-- currently executing within a live run (e.g. 'plan.context', 'execute.implement').
-- NULL means no step is currently active (run not started, completed, or failed).
--
-- Column added after error_message and before started_at to mirror the order
-- in which WorkflowRunRow was extended in shared/types/workflows.ts.
--
-- NOTE: No explicit BEGIN/COMMIT here — runFileBasedMigrations() in database.ts
-- wraps every file in a this.transaction(...) call.

ALTER TABLE workflow_runs ADD COLUMN current_step_id TEXT;
