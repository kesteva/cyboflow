-- Migration 022: Parallel-sprint batches (feat/parallel-sprint epic).
--
-- A "sprint batch" executes a set of tasks in parallel over ONE shared
-- integration branch (`sprint/<id8>`), with bounded concurrency (CAP=5) and a
-- single human review at finalize. Two new scheduler-owned tables back the
-- batch lifecycle, plus a soft `batch_id` link on workflow_runs so every
-- init/task/finalize run can be traced back to its batch.
--
-- These tables are BATCH-SCHEDULER-OWNED — they are NOT entity-model tables
-- (ideas/epics/tasks) and do NOT route through TaskChangeRouter. The scheduler
-- writes them directly under its own per-batch PQueue, the same way
-- workflow_runs is written directly by RunLauncher. Board-stage derivation of
-- the underlying tasks still flows through the chokepoint.
--
-- Idioms mirror migration 019: nullable soft-polymorphic links, NO hard FK on
-- the soft `batch_id` column (the referenced batch row may be deleted while the
-- run record survives for history). The two new tables DO declare FKs since
-- their rows are batch-lifecycle-scoped and CASCADE-clean with the batch.
--
-- NOTE: The `ALTER TABLE workflow_runs ADD COLUMN batch_id` line has no
-- `IF NOT EXISTS` (SQLite ALTER TABLE does not support it). Re-running this
-- migration raises 'duplicate column name: batch_id', which runFileBasedMigrations()
-- in database.ts treats as the already-applied idempotency signal (same
-- mechanism migrations 013 / 017 / 018 / 019 rely on).
--
-- NOTE: No explicit BEGIN/COMMIT here — runFileBasedMigrations() wraps every
-- file in a this.transaction(...) call.

CREATE TABLE IF NOT EXISTS sprint_batches (
  id                 TEXT PRIMARY KEY,                 -- uuid (hex, no dashes)
  project_id         INTEGER NOT NULL,
  substrate          TEXT NOT NULL DEFAULT 'sdk'
                       CHECK (substrate IN ('sdk','interactive')),
  status             TEXT NOT NULL DEFAULT 'planning'
                       CHECK (status IN ('planning','running','finalizing','completed','failed','canceled')),
  integration_branch TEXT,                             -- 'sprint/<id8>' (set at create)
  base_branch        TEXT,                             -- project main branch captured at create (triage)
  base_sha           TEXT,                             -- integration branch start sha (triage)
  concurrency        INTEGER NOT NULL DEFAULT 5,       -- CAP; substrate-independent
  init_run_id        TEXT,                             -- the sprint-init run (soft link)
  finalize_run_id    TEXT,                             -- the sprint-finalize run (soft link)
  error_message      TEXT,
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at       DATETIME
);
CREATE INDEX IF NOT EXISTS idx_sprint_batches_status ON sprint_batches(status);

CREATE TABLE IF NOT EXISTS sprint_batch_tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id      TEXT NOT NULL,
  task_id       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','integrated','failed','blocked')),
  run_id        TEXT,                                  -- the per-task run currently/last executing this task (soft)
  error_message TEXT,                                  -- merge-conflict / run-fail detail when status='failed'
  integrated_at DATETIME,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (batch_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_sprint_batch_tasks_batch ON sprint_batch_tasks(batch_id);
CREATE INDEX IF NOT EXISTS idx_sprint_batch_tasks_task  ON sprint_batch_tasks(task_id);

ALTER TABLE workflow_runs ADD COLUMN batch_id TEXT;    -- soft link; NULL for every non-batch run
CREATE INDEX IF NOT EXISTS idx_workflow_runs_batch_id ON workflow_runs(batch_id);
