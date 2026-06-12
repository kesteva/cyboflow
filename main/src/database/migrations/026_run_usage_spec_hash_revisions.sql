-- Migration 026: Insights Phase-2 persistence — run spec_hash + run_usage rollup
-- table + workflow_revisions snapshot + a (project_id, workflow_id) run index.
--
-- Phase 1 of Insights (already committed) computes token/cost rollups on the fly
-- from raw_events. Phase 2 adds the durable schema those queries persist into and
-- the spec-versioning columns the Insights view groups by:
--
--   1. workflow_runs.spec_hash — sha256 hex of the workflow's spec_json frozen at
--      RUN CREATION (computeSpecHash in main/src/orchestrator/specHash.ts, owned by
--      the spec-capture task). Lets Insights bucket runs by the EXACT workflow
--      revision they executed, even after the workflow's spec_json is later edited.
--      NULL for historic runs (forward-only; see no-backfill note below).
--
--   2. run_usage — one durable token/cost rollup row per run (run_id PRIMARY KEY).
--      The persisted twin of shared/types/insights.ts RunUsageRollup: insightsQueries
--      computes the rollup from raw_events; the Phase-2 writer upserts it here so the
--      Insights view reads a precomputed row instead of re-scanning raw_events.
--      FK run_id -> workflow_runs(id) ON DELETE CASCADE (the rollup dies with its run).
--
--   3. workflow_revisions — append-only (workflow_id, spec_hash) snapshot of every
--      distinct spec_json a workflow has carried, so a run's frozen spec_hash always
--      resolves to the spec text that produced it even after the workflow row's
--      live spec_json moves on. UNIQUE(workflow_id, spec_hash) makes the writer's
--      "record this revision if new" an idempotent INSERT OR IGNORE. FK
--      workflow_id -> workflows(id) ON DELETE CASCADE (revisions die with the workflow).
--
--   4. idx_workflow_runs_project_workflow — the dominant Insights read is
--      "all runs for (project, workflow)"; this composite index serves it.
--
-- FK semantics: both new tables hard-FK their parent (workflow_runs / workflows)
-- ON DELETE CASCADE — these are derived rollup/snapshot rows with no independent
-- life, unlike the SOFT polymorphic links in 016/017.
--
-- FORWARD-ONLY, NO BACKFILL: spec_hash stays NULL for every pre-026 run and
-- run_usage / workflow_revisions start empty. The Phase-2 writers populate them
-- going forward; Insights queries already tolerate the absent rollup (Phase 1
-- falls back to the raw_events computation). No data is reconstructed here.
--
-- NOTE: No `IF NOT EXISTS` on the ALTER — SQLite ALTER TABLE does not support it.
-- Re-running this file (after a ledger reset) raises 'duplicate column name:
-- spec_hash' on the FIRST statement, which is exactly the idempotency signal
-- runFileBasedMigrations() in database.ts uses to skip already-applied files
-- (same mechanism as 011/014/017/018). Because the runner wraps the file in a
-- transaction, the CREATE TABLE / CREATE INDEX statements below never re-execute
-- once the ALTER has been applied. The CREATEs themselves DO use IF NOT EXISTS so
-- the tables/index are individually re-applicable if reached on a fresh chain.
--
-- NOTE: No explicit BEGIN/COMMIT here — runFileBasedMigrations() in database.ts
-- wraps every file in a this.transaction(...) call, so an inner BEGIN would nest.

-- ---------------------------------------------------------------------------
-- 1. workflow_runs.spec_hash — sha256 hex of spec_json frozen at run creation.
--    Column added after session_id (the post-024 tail) to mirror the order in
--    which WorkflowRunRow is extended in shared/types/workflows.ts. NOT idempotent
--    (see header note). NULL for historic runs.
-- ---------------------------------------------------------------------------
ALTER TABLE workflow_runs ADD COLUMN spec_hash TEXT;

-- ---------------------------------------------------------------------------
-- 2. run_usage — durable per-run token/cost rollup (one row per run).
--    Persisted twin of RunUsageRollup (shared/types/insights.ts). total_tokens
--    is input + output (mirrors the rollup convention). cost_usd / num_turns are
--    nullable — NULL when no terminal result payload carried them (SDK-only).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS run_usage (
  run_id                  TEXT PRIMARY KEY,            -- one rollup per run
  input_tokens            INTEGER NOT NULL DEFAULT 0,
  output_tokens           INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens   INTEGER NOT NULL DEFAULT 0,
  total_tokens            INTEGER NOT NULL DEFAULT 0,  -- input + output
  cost_usd                REAL,                        -- NULL when no result carried total_cost_usd
  num_turns               INTEGER,                     -- NULL when no result carried num_turns
  assistant_message_count INTEGER NOT NULL DEFAULT 0,  -- count of assistant payloads with a usage object
  computed_at             DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- 3. workflow_revisions — append-only spec_json snapshot keyed by (workflow_id,
--    spec_hash). UNIQUE(workflow_id, spec_hash) makes "record if new" an
--    idempotent INSERT OR IGNORE for the Phase-2 writer.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflow_revisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL,
  spec_hash   TEXT NOT NULL,                           -- sha256 hex of spec_json (computeSpecHash)
  spec_json   TEXT NOT NULL,                           -- the exact spec text this hash was computed over
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workflow_id, spec_hash),
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- 4. The dominant Insights read: all runs for a (project, workflow) pair.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_workflow_runs_project_workflow ON workflow_runs(project_id, workflow_id);
