-- Migration 017: Add seed_idea_id to workflow_runs (Planner pre-launch idea selection).
--
-- Dedicated soft-polymorphic link to the backlog idea chosen (or minted) at launch
-- and injected as the planner's first input by RunExecutor.getPrompt. NOT a reuse of
-- task_id: task_id drives recomputeTaskExecutionStage (which throws not_found for any
-- id absent from the tasks table). seed_idea_id participates in NO stage derivation.
--
-- Nullable, NO FK (matches the review_items soft-link convention) — the referenced
-- idea row may be retired/decomposed; the run record survives for history.
--
-- NOTE: No `IF NOT EXISTS` — SQLite ALTER TABLE does not support it. Re-running this
-- migration raises 'duplicate column name: seed_idea_id', which is exactly the
-- idempotency signal runFileBasedMigrations() in database.ts uses to skip
-- already-applied files (same mechanism migration 013 relies on).
--
-- NOTE: No explicit BEGIN/COMMIT here — runFileBasedMigrations() in database.ts
-- wraps every file in a this.transaction(...) call.

ALTER TABLE workflow_runs
  ADD COLUMN seed_idea_id TEXT;
