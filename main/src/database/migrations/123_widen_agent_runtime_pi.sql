-- Migration 123: admit the native 'pi' provider on agent_provider CHECKs and
-- the pi runtimes on agent_runtime CHECKs across all four provider-stamped
-- tables (sessions, workflow_runs, workflow_variants, agent_invocations).

-- The runner detects this marker and wraps every statement in an explicit
-- transaction with foreign keys disabled — required here because
-- agent_invocations is recreated via DROP TABLE (103's recipe), which would
-- otherwise cascade-delete every invocation row.
PRAGMA foreign_keys=OFF;

-- ---------------------------------------------------------------------------
-- sessions.agent_provider  (103 list + 'pi')
-- ---------------------------------------------------------------------------

ALTER TABLE sessions ADD COLUMN agent_provider_widen_123 TEXT;
UPDATE sessions SET agent_provider_widen_123 = agent_provider;
ALTER TABLE sessions DROP COLUMN agent_provider;
ALTER TABLE sessions
  ADD COLUMN agent_provider TEXT NOT NULL DEFAULT 'claude'
    CHECK (agent_provider IN ('claude','codex','omp','pi'));
UPDATE sessions SET agent_provider = COALESCE(agent_provider_widen_123, 'claude');
ALTER TABLE sessions DROP COLUMN agent_provider_widen_123;

-- ---------------------------------------------------------------------------
-- sessions.agent_runtime  (122 list + 'pi-sdk' + 'pi-pty')
--
-- pi-pty IS admitted on sessions, exactly as omp-pty/codex-pty are: a quick
-- terminal session is a first-class chat session. The workflow tables below
-- stay narrower.
-- ---------------------------------------------------------------------------

ALTER TABLE sessions ADD COLUMN agent_runtime_widen_123 TEXT;
UPDATE sessions SET agent_runtime_widen_123 = agent_runtime;
ALTER TABLE sessions DROP COLUMN agent_runtime;
ALTER TABLE sessions
  ADD COLUMN agent_runtime TEXT NOT NULL DEFAULT 'claude-sdk'
    CHECK (agent_runtime IN ('claude-sdk','claude-interactive','codex-sdk','codex-pty','omp-sdk','omp-pty','omp-fleet','pi-sdk','pi-pty'));
UPDATE sessions SET agent_runtime = COALESCE(agent_runtime_widen_123, 'claude-sdk');
ALTER TABLE sessions DROP COLUMN agent_runtime_widen_123;

-- ---------------------------------------------------------------------------
-- workflow_runs.agent_provider  (103 list + 'pi')
-- workflow_runs.agent_runtime   (122 list + 'pi-sdk')
--
-- pi-pty stays absent from the runtime list for the same reason codex-pty/
-- omp-pty are: a workflow run needs structured events, usage and review-queue
-- integration, which a TUI driven by keystrokes cannot supply. pi-sdk
-- qualifies (pi --mode json).
-- ---------------------------------------------------------------------------

ALTER TABLE workflow_runs ADD COLUMN agent_provider_widen_123 TEXT;
UPDATE workflow_runs SET agent_provider_widen_123 = agent_provider;
ALTER TABLE workflow_runs DROP COLUMN agent_provider;
ALTER TABLE workflow_runs
  ADD COLUMN agent_provider TEXT NOT NULL DEFAULT 'claude'
    CHECK (agent_provider IN ('claude','codex','omp','pi'));
UPDATE workflow_runs SET agent_provider = COALESCE(agent_provider_widen_123, 'claude');
ALTER TABLE workflow_runs DROP COLUMN agent_provider_widen_123;

ALTER TABLE workflow_runs ADD COLUMN agent_runtime_widen_123 TEXT;
UPDATE workflow_runs SET agent_runtime_widen_123 = agent_runtime;
ALTER TABLE workflow_runs DROP COLUMN agent_runtime;
ALTER TABLE workflow_runs
  ADD COLUMN agent_runtime TEXT NOT NULL DEFAULT 'claude-sdk'
    CHECK (agent_runtime IN ('claude-sdk','claude-interactive','codex-sdk','omp-sdk','omp-fleet','pi-sdk'));
UPDATE workflow_runs SET agent_runtime = COALESCE(agent_runtime_widen_123, 'claude-sdk');
ALTER TABLE workflow_runs DROP COLUMN agent_runtime_widen_123;

-- ---------------------------------------------------------------------------
-- workflow_variants.agent_provider / workflow_variants.agent_runtime
--
-- Both are nullable (NULL = inherit the launch default), so the IS NULL arm is
-- carried forward and the value copy leaves NULLs as NULL. pi-sdk joins the
-- launchable runtime list; pi-pty stays out (keystroke TUI, same as omp-pty).
-- ---------------------------------------------------------------------------

ALTER TABLE workflow_variants ADD COLUMN agent_provider_widen_123 TEXT;
UPDATE workflow_variants SET agent_provider_widen_123 = agent_provider;
ALTER TABLE workflow_variants DROP COLUMN agent_provider;
ALTER TABLE workflow_variants
  ADD COLUMN agent_provider TEXT
    CHECK (agent_provider IS NULL OR agent_provider IN ('claude','codex','omp','pi'));
UPDATE workflow_variants SET agent_provider = agent_provider_widen_123;
ALTER TABLE workflow_variants DROP COLUMN agent_provider_widen_123;

ALTER TABLE workflow_variants ADD COLUMN agent_runtime_widen_123 TEXT;
UPDATE workflow_variants SET agent_runtime_widen_123 = agent_runtime;
ALTER TABLE workflow_variants DROP COLUMN agent_runtime;
ALTER TABLE workflow_variants
  ADD COLUMN agent_runtime TEXT
    CHECK (agent_runtime IS NULL OR agent_runtime IN ('claude-sdk','claude-interactive','codex-sdk','omp-sdk','pi-sdk'));
UPDATE workflow_variants SET agent_runtime = agent_runtime_widen_123;
ALTER TABLE workflow_variants DROP COLUMN agent_runtime_widen_123;

-- ---------------------------------------------------------------------------
-- agent_invocations — full recreate (103's shape: NOT NULL columns plus FK and
-- both indexes). pi joins the provider list; pi-sdk AND pi-pty join the
-- runtime list, matching omp-pty's historical presence on this table (an
-- invocation row records the transport that actually served a turn).
-- ---------------------------------------------------------------------------

CREATE TABLE agent_invocations_new (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_invocation_id   TEXT NOT NULL UNIQUE,
  run_id                TEXT NOT NULL,
  step_id               TEXT,
  agent_provider        TEXT NOT NULL
                          CHECK (agent_provider IN ('claude', 'codex', 'omp', 'pi')),
  agent_runtime         TEXT NOT NULL
                          CHECK (agent_runtime IN ('claude-sdk', 'claude-interactive', 'codex-sdk', 'omp-sdk', 'omp-pty', 'pi-sdk', 'pi-pty')),
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

-- Carry AUTOINCREMENT's high-water mark across the rebuild (103's comment
-- applies verbatim: copying explicit ids only sets the mark to max(id) among
-- SURVIVING rows, and CASCADE deletions make that regress).
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
