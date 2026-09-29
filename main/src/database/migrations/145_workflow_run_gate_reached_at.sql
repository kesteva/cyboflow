-- Migration 145: workflow_runs.gate_reached_at — the instant an experiment arm
-- first lands on its FINAL human-review gate (awaiting_review AND settled-for-
-- grading per experimentStore.isArmSettledForGrading), separate from ended_at
-- (a run may sit at this gate for a long human-review wait before it later
-- transitions to completed/failed/canceled). Stamped by
-- experimentStore.stampArmGateReachedAt from terminalEvalSubscriber, first-write
-- wins (idempotent). NULL for every run that never reaches a terminal gate, and
-- for all historical rows.
ALTER TABLE workflow_runs ADD COLUMN gate_reached_at DATETIME;
