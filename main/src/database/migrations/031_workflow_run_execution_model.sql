-- Migration 031: Add execution_model column to workflow_runs.
--
-- This is the orchestrated-vs-programmatic execution-model seam — the axis that
-- decides WHO walks a run's DAG (its WorkflowDefinition). Sibling to the
-- substrate column (migration 013). Every workflow run is stamped at launch with
-- the model it executes under:
--   'orchestrated' — an orchestrator AGENT reads and manages the DAG (today's
--                    behavior; the only model the interactive/PTY substrate can
--                    run). Default.
--   'programmatic' — host CODE (a WorkflowController) walks the DAG; a repurposed
--                    agent runs alongside as monitor + human seam + triage.
--                    SDK substrate only.
--
-- The value is resolved once (see executionModelResolver.ts) and is IMMUTABLE
-- for the lifetime of a run — there is intentionally no UPDATE path. Every legacy
-- row reads back 'orchestrated' via the NOT NULL DEFAULT, so existing runs are
-- byte-identical in behavior (zero-behavior-change invariant). The column is
-- stamped-but-dormant until the programmatic consumer (the host-side
-- WorkflowController + facade branch) lands — exactly as `substrate` was dormant
-- between migration 013 and the interactive manager.
--
-- The CHECK domain is kept literally ('orchestrated','programmatic') to match
-- the ExecutionModel union in shared/types/executionModel.ts. If a future model
-- is ever added, this CHECK domain and the ExecutionModel union MUST be widened
-- together — they are a single contract split across SQL + TypeScript.
--
-- NOTE: No `IF NOT EXISTS` — SQLite ALTER TABLE does not support it. Re-running
-- this migration raises 'duplicate column name: execution_model', which is
-- exactly the idempotency signal runFileBasedMigrations() in database.ts uses to
-- skip already-applied files (same mechanism migration 013 relies on).
--
-- NOTE: No explicit BEGIN/COMMIT here — runFileBasedMigrations() in database.ts
-- wraps every file in a this.transaction(...) call.

ALTER TABLE workflow_runs
  ADD COLUMN execution_model TEXT NOT NULL DEFAULT 'orchestrated'
    CHECK (execution_model IN ('orchestrated','programmatic'));
