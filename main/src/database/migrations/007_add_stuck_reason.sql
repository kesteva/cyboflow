-- Migration 007: Add stuck_detected_at column to workflow_runs.
--
-- Context: 006_cyboflow_schema.sql already added stuck_reason TEXT to workflow_runs.
-- This migration adds the complementary stuck_detected_at INTEGER (unix epoch ms)
-- used by StuckDetector to record when the stuck transition fired.
--
-- Column inventory after this migration:
--   stuck_reason TEXT       — discriminated-union tag set by StuckDetector
--                             ('self_deadlock' | 'cross_run_deadlock' | 'orphan_pty' | 'stale_socket')
--   stuck_detected_at INTEGER — unix epoch milliseconds when StuckDetector transitioned the run

ALTER TABLE workflow_runs ADD COLUMN stuck_detected_at INTEGER;

-- Index for stuck-queue card queries: scan stuck runs ordered by detection time.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_stuck_at ON workflow_runs(status, stuck_detected_at);
