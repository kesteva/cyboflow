-- Migration 043: run_evals — one durable LLM-judge evaluation rollup per
-- (workflow_run, rubric_version).
--
-- The eval feature scores a completed built-in workflow run against the 7-dimension
-- code-review rubric (docs/proposals/code-review-eval-checklist.md, rubric v1.1). The
-- EvalWorker captures the frozen diff AT TRIGGER (the sprint/ship "human-review begins"
-- step transition) into this table, then runs a K-sample LLM jury and writes the verdict
-- back onto the SAME row. Everything the worker needs to survive worktree teardown
-- (diff_text, base_sha, denormalized workflow name/id) is snapshotted here at trigger
-- time — the row is self-contained, not a pointer into a worktree the human may merge
-- and delete out from under an async judge.
--
-- Keying: PRIMARY KEY (run_id, rubric_version). An interactive resume or a
-- request-changes loop can re-report 'human-review'/'running' for the same run; the
-- composite PK + INSERT OR IGNORE gives re-fire dedup for free, and the second fire is
-- the human_influenced=1 signal (do NOT create a second row).
--
-- FK run_id -> workflow_runs(id) ON DELETE CASCADE — the eval rollup is a derived row
-- with no independent life; it dies with its run (mirrors run_usage in migration 026,
-- "the rollup dies with its run").
--
-- State machine: eval_status pending -> running -> complete | failed. All verdict
-- columns (overall_score, band, ci_low/high, dimensions_json, per_sample_json, ...) stay
-- NULL until 'complete'; error is populated on 'failed'.
--
-- FORWARD-ONLY, NEW TABLE: created ONLY here with CREATE TABLE IF NOT EXISTS (never
-- added to schema.sql) so the schema-parity path (schema.sql + migrations vs migrations
-- only) stays identical, mirroring run_usage / review_items.
--
-- NOTE: No explicit BEGIN/COMMIT — runFileBasedMigrations() in database.ts wraps every
-- file in a this.transaction(...) call, so an inner BEGIN would nest.

CREATE TABLE IF NOT EXISTS run_evals (
  run_id                  TEXT NOT NULL,                 -- FK -> workflow_runs(id); half of composite PK
  rubric_version          TEXT NOT NULL,                 -- e.g. '1.1'; other half of composite PK

  eval_status             TEXT NOT NULL DEFAULT 'pending'
                            CHECK (eval_status IN ('pending', 'running', 'complete', 'failed')),

  -- Frozen inputs captured AT TRIGGER (survive worktree teardown) --------------
  base_sha                TEXT,                          -- copied from workflow_runs.base_sha (NULL on legacy runs)
  diff_text               TEXT,                          -- the frozen unified diff (NULL if worktree unmaterialized)
  diff_stats_json         TEXT,                          -- RunGitDiff aggregate stats JSON from the same capture
  gate_results_json       TEXT,                          -- folded step_results (sprint-verify) rows if present, else NULL
  human_influenced        INTEGER NOT NULL DEFAULT 0,    -- 0 at first trigger; 1 if human-review re-fires (request-changes loop)
  snapshot_at             TEXT NOT NULL,                 -- ISO timestamp of the trigger capture

  -- Verdict (NULL until eval_status = 'complete') -----------------------------
  overall_score           INTEGER,                       -- 0-100
  band                    TEXT,                          -- Excellent / Good / Fair / Poor
  ci_low                  REAL,                          -- across K samples
  ci_high                 REAL,
  gated                   INTEGER NOT NULL DEFAULT 0,     -- deterministic-gate-failure sentinel
  security_flag           INTEGER NOT NULL DEFAULT 0,     -- confirmed high/critical security soft-cap fired
  dimensions_json         TEXT,                          -- per-dimension {score, active, passCount, failCount, unknownCount}
  per_sample_json         TEXT,                          -- raw K jury structured outputs verbatim

  -- Judge provenance ----------------------------------------------------------
  judge_model             TEXT,                          -- concrete id, e.g. 'claude-opus-4-8' (NULL until running)
  sample_count            INTEGER,                       -- K actually completed
  prompt_hash             TEXT,                          -- sha256 of judge prompt (computeSpecHash precedent)
  judge_build_id          TEXT,                          -- app version string from package.json

  -- Denormalized run provenance (workflows are user-editable/deletable) --------
  workflow_id             TEXT NOT NULL,                 -- from workflow_runs.workflow_id at trigger
  workflow_name           TEXT NOT NULL,                 -- denormalized at trigger
  spec_hash               TEXT,                          -- workflow_runs.spec_hash (NULL on pre-026 runs)
  run_model               TEXT,                          -- workflow_runs.model (NULL/'auto' = SDK default)
  subagent_models_json    TEXT,                          -- step->agent model map (optional; NULL in v1)
  difficulty_proxy_prerun REAL,                          -- reserved; no pre-run difficulty signal exists (NULL in v1)

  error                   TEXT,                          -- populated when eval_status = 'failed'
  created_at              TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at              TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),

  PRIMARY KEY (run_id, rubric_version),
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);
