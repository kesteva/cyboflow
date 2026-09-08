-- Migration 130: admit the native 'agy' (Antigravity) provider on agent_provider
-- CHECKs and the agy runtimes on agent_runtime CHECKs across all four
-- provider-stamped tables (sessions, workflow_runs, workflow_variants,
-- agent_invocations).

PRAGMA foreign_keys=OFF;

-- ---------------------------------------------------------------------------
-- sessions.agent_provider  (123 list + 'agy')
-- ---------------------------------------------------------------------------

ALTER TABLE sessions ADD COLUMN agent_provider_widen_130 TEXT;
UPDATE sessions SET agent_provider_widen_130 = agent_provider;
ALTER TABLE sessions DROP COLUMN agent_provider;
ALTER TABLE sessions
  ADD COLUMN agent_provider TEXT NOT NULL DEFAULT 'claude'
    CHECK (agent_provider IN ('claude','codex','omp','pi','agy'));
UPDATE sessions SET agent_provider = COALESCE(agent_provider_widen_130, 'claude');
ALTER TABLE sessions DROP COLUMN agent_provider_widen_130;

-- ---------------------------------------------------------------------------
-- sessions.agent_runtime  (123 list + 'agy-sdk' + 'agy-pty')
-- ---------------------------------------------------------------------------

ALTER TABLE sessions ADD COLUMN agent_runtime_widen_130 TEXT;
UPDATE sessions SET agent_runtime_widen_130 = agent_runtime;
ALTER TABLE sessions DROP COLUMN agent_runtime;
ALTER TABLE sessions
  ADD COLUMN agent_runtime TEXT NOT NULL DEFAULT 'claude-sdk'
    CHECK (agent_runtime IN ('claude-sdk','claude-interactive','codex-sdk','codex-pty','omp-sdk','omp-pty','omp-fleet','pi-sdk','pi-pty','agy-sdk','agy-pty'));
UPDATE sessions SET agent_runtime = COALESCE(agent_runtime_widen_130, 'claude-sdk');
ALTER TABLE sessions DROP COLUMN agent_runtime_widen_130;

-- ---------------------------------------------------------------------------
-- workflow_runs.agent_provider  (123 list + 'agy')
-- workflow_runs.agent_runtime   (123 list + 'agy-sdk')
-- ---------------------------------------------------------------------------

ALTER TABLE workflow_runs ADD COLUMN agent_provider_widen_130 TEXT;
UPDATE workflow_runs SET agent_provider_widen_130 = agent_provider;
ALTER TABLE workflow_runs DROP COLUMN agent_provider;
ALTER TABLE workflow_runs
  ADD COLUMN agent_provider TEXT NOT NULL DEFAULT 'claude'
    CHECK (agent_provider IN ('claude','codex','omp','pi','agy'));
UPDATE workflow_runs SET agent_provider = COALESCE(agent_provider_widen_130, 'claude');
ALTER TABLE workflow_runs DROP COLUMN agent_provider_widen_130;

ALTER TABLE workflow_runs ADD COLUMN agent_runtime_widen_130 TEXT;
UPDATE workflow_runs SET agent_runtime_widen_130 = agent_runtime;
ALTER TABLE workflow_runs DROP COLUMN agent_runtime;
ALTER TABLE workflow_runs
  ADD COLUMN agent_runtime TEXT NOT NULL DEFAULT 'claude-sdk'
    CHECK (agent_runtime IN ('claude-sdk','claude-interactive','codex-sdk','omp-sdk','omp-fleet','pi-sdk','agy-sdk'));
UPDATE workflow_runs SET agent_runtime = COALESCE(agent_runtime_widen_130, 'claude-sdk');
ALTER TABLE workflow_runs DROP COLUMN agent_runtime_widen_130;

-- ---------------------------------------------------------------------------
-- workflow_variants.agent_provider / workflow_variants.agent_runtime
-- ---------------------------------------------------------------------------

ALTER TABLE workflow_variants ADD COLUMN agent_provider_widen_130 TEXT;
UPDATE workflow_variants SET agent_provider_widen_130 = agent_provider;
ALTER TABLE workflow_variants DROP COLUMN agent_provider;
ALTER TABLE workflow_variants
  ADD COLUMN agent_provider TEXT
    CHECK (agent_provider IS NULL OR agent_provider IN ('claude','codex','omp','pi','agy'));
UPDATE workflow_variants SET agent_provider = agent_provider_widen_130;
ALTER TABLE workflow_variants DROP COLUMN agent_provider_widen_130;

ALTER TABLE workflow_variants ADD COLUMN agent_runtime_widen_130 TEXT;
UPDATE workflow_variants SET agent_runtime_widen_130 = agent_runtime;
ALTER TABLE workflow_variants DROP COLUMN agent_runtime;
ALTER TABLE workflow_variants
  ADD COLUMN agent_runtime TEXT
    CHECK (agent_runtime IS NULL OR agent_runtime IN ('claude-sdk','claude-interactive','codex-sdk','omp-sdk','pi-sdk','agy-sdk'));
UPDATE workflow_variants SET agent_runtime = agent_runtime_widen_130;
ALTER TABLE workflow_variants DROP COLUMN agent_runtime_widen_130;

-- ---------------------------------------------------------------------------
-- agent_invocations — full recreate
-- Note: Mirrors migration 123. Unlike sessions and workflow_runs which use
-- single-column ALTER/DROP pairs, agent_invocations carries an ON DELETE CASCADE
-- foreign key against workflow_runs(id) and a UNIQUE constraint on
-- agent_invocation_id. Recreating the table cleanly re-applies the FK and
-- unique index without intermediate constraint violations.
-- ---------------------------------------------------------------------------

CREATE TABLE agent_invocations_new (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_invocation_id   TEXT NOT NULL UNIQUE,
  run_id                TEXT NOT NULL,
  step_id               TEXT,
  agent_provider        TEXT NOT NULL
                          CHECK (agent_provider IN ('claude', 'codex', 'omp', 'pi', 'agy')),
  agent_runtime         TEXT NOT NULL
                          CHECK (agent_runtime IN ('claude-sdk', 'claude-interactive', 'codex-sdk', 'omp-sdk', 'omp-pty', 'pi-sdk', 'pi-pty', 'agy-sdk', 'agy-pty')),
  model                 TEXT,
  external_session_id   TEXT,
  created_at            TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  panel_id              TEXT,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

INSERT INTO agent_invocations_new (id, agent_invocation_id, run_id, step_id, agent_provider,
                                   agent_runtime, model, external_session_id, created_at, panel_id)
  SELECT id, agent_invocation_id, run_id, step_id, agent_provider,
         agent_runtime, model, external_session_id, created_at, panel_id
  FROM agent_invocations;

INSERT INTO sqlite_sequence (name, seq)
  SELECT 'agent_invocations_new', 0
   WHERE EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'agent_invocations')
     AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'agent_invocations_new');

UPDATE sqlite_sequence
   SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'agent_invocations'), 0))
 WHERE name = 'agent_invocations_new';

DROP TABLE agent_invocations;
ALTER TABLE agent_invocations_new RENAME TO agent_invocations;

CREATE INDEX IF NOT EXISTS idx_agent_invocations_run_step_latest
  ON agent_invocations (run_id, step_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_invocations_run_panel_latest
  ON agent_invocations (run_id, panel_id, id DESC);

PRAGMA foreign_keys=ON;
