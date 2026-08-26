-- Migration 103: widen the agent provider/runtime CHECK constraints so a third
-- provider is storable.
--
-- WHY. Six CHECK constraints hardcode the two-provider world:
--   sessions.agent_provider           (059)  IN ('claude','codex')
--   sessions.agent_runtime            (060)  IN ('claude-sdk','claude-interactive','codex-sdk','codex-pty')
--   workflow_runs.agent_provider      (062)  IN ('claude','codex')
--   workflow_runs.agent_runtime       (063)  IN ('claude-sdk','claude-interactive','codex-sdk')
--   agent_invocations.agent_provider  (065)  IN ('claude','codex')
--   agent_invocations.agent_runtime   (065)  IN ('claude-sdk','claude-interactive','codex-sdk')
--   workflow_variants.agent_provider  (068)  IS NULL OR IN ('claude','codex')
--   workflow_variants.agent_runtime   (068)  IS NULL OR IN ('claude-sdk','claude-interactive','codex-sdk')
-- SQLite cannot ALTER a CHECK, and the file-keyed migration ledger applies each
-- .sql exactly once, so editing those files in place would silently never
-- re-apply on an already-migrated DB (the 062_approve_ideas_atype lesson). We
-- widen all eight here, in one atomic file, so later provider work is pure code
-- and no fifth constraint surfaces mid-phase.
--
-- The widened sets deliberately differ per table, mirroring how codex-pty is
-- already admitted on sessions but not on workflow runs:
--   provider         + 'omp'                everywhere
--   sessions         + 'omp-sdk','omp-pty'  (quick sessions can run the OMP TUI)
--                    + 'omp-fleet'           (carried forward from 101: the fleet
--                                             supervisor is a session runtime)
--   workflow_runs    + 'omp-sdk'            (workflows need structured events)
--                    + 'omp-fleet'           (the quick-session SENTINEL mints a
--                                             workflow_runs row carrying the
--                                             session's runtime identity — never
--                                             a launch target, but storable)
--   workflow_variants+ 'omp-sdk'            (a variant resolves to a workflow runtime)
--   agent_invocations+ 'omp-sdk','omp-pty'  (an invocation row records what actually ran,
--                                            including a PTY turn in a quick session)
--
-- WHY NOT the 062 create-new/copy/drop/rename recipe on all four tables.
-- Three of them are unsafe to retype by hand:
--   * `sessions` is Crystal-legacy: ~40 columns accreted through ALTER TABLE
--     (several added imperatively by database.ts, not by any .sql), and five
--     tables FK-reference it ON DELETE CASCADE. A hardcoded CREATE TABLE would
--     silently drop any column a given install has but this file does not list.
--   * `workflow_runs` is FK-referenced by 21 tables (CASCADE / SET NULL) and has
--     the same accreted shape.
--   * `workflow_variants` is small, but its columns were ALTER-added too, so the
--     same drift argument applies at lower stakes.
-- For all three the constraint lives in a column-level CHECK on a column that is
-- in no index, no trigger, no view, and no other CHECK — so SQLite can simply
-- DROP the column and re-ADD it with the widened CHECK (ALTER TABLE DROP COLUMN
-- needs SQLite >= 3.35 and refuses a column referenced from anywhere else in the
-- schema; better-sqlite3 bundles 3.49). That is shape-agnostic:
-- it names only the column being widened, leaves every other column, index and
-- foreign key untouched, and needs no FK re-pointing. Values are parked in a
-- temp column across the drop. The sequence is idempotent, so a re-run after a
-- cleared ledger marker is harmless.
--
-- `agent_invocations` IS rebuilt the 062 way, because its two columns are
-- NOT NULL with NO default: re-ADDing them would require inventing a default,
-- and `DEFAULT 'claude'` on a provider column is exactly the silent-fallback-to-
-- Claude failure mode this widening exists to prevent. The table is young (065 +
-- 087's panel_id), nothing FK-references it, and its full shape is reproduced
-- below with both indexes.
--
-- The leading `PRAGMA foreign_keys=OFF` is detected by the migration runner,
-- which toggles FK enforcement OFF *outside* the wrapping transaction (pragma
-- toggles are no-ops inside one) so the agent_invocations copy cannot be aborted
-- by a pre-existing orphan row and DROP TABLE does not cascade.

PRAGMA foreign_keys=OFF;

-- ---------------------------------------------------------------------------
-- sessions.agent_provider / sessions.agent_runtime
-- ---------------------------------------------------------------------------

ALTER TABLE sessions ADD COLUMN agent_provider_widen_103 TEXT;
UPDATE sessions SET agent_provider_widen_103 = agent_provider;
ALTER TABLE sessions DROP COLUMN agent_provider;
ALTER TABLE sessions
  ADD COLUMN agent_provider TEXT NOT NULL DEFAULT 'claude'
    CHECK (agent_provider IN ('claude','codex','omp'));
UPDATE sessions SET agent_provider = COALESCE(agent_provider_widen_103, 'claude');
ALTER TABLE sessions DROP COLUMN agent_provider_widen_103;

ALTER TABLE sessions ADD COLUMN agent_runtime_widen_103 TEXT;
UPDATE sessions SET agent_runtime_widen_103 = agent_runtime;
ALTER TABLE sessions DROP COLUMN agent_runtime;
ALTER TABLE sessions
  ADD COLUMN agent_runtime TEXT NOT NULL DEFAULT 'claude-sdk'
    CHECK (agent_runtime IN ('claude-sdk','claude-interactive','codex-sdk','codex-pty','omp-sdk','omp-pty','omp-fleet'));
UPDATE sessions SET agent_runtime = COALESCE(agent_runtime_widen_103, 'claude-sdk');
ALTER TABLE sessions DROP COLUMN agent_runtime_widen_103;

-- ---------------------------------------------------------------------------
-- workflow_runs.agent_provider / workflow_runs.agent_runtime
-- ---------------------------------------------------------------------------

ALTER TABLE workflow_runs ADD COLUMN agent_provider_widen_103 TEXT;
UPDATE workflow_runs SET agent_provider_widen_103 = agent_provider;
ALTER TABLE workflow_runs DROP COLUMN agent_provider;
ALTER TABLE workflow_runs
  ADD COLUMN agent_provider TEXT NOT NULL DEFAULT 'claude'
    CHECK (agent_provider IN ('claude','codex','omp'));
UPDATE workflow_runs SET agent_provider = COALESCE(agent_provider_widen_103, 'claude');
ALTER TABLE workflow_runs DROP COLUMN agent_provider_widen_103;

-- omp-pty is absent for the same reason codex-pty is: a workflow run needs
-- structured events, usage, MCP progress and review-queue integration.
-- omp-fleet is admitted WITHOUT being launchable: it is storable-only (a fleet
-- supervisor is never a per-step workflow agent), but the quick-session
-- sentinel is a workflow_runs ROW and must carry the session's resolved
-- runtime — the dispatch facade reads it back to pick the owning manager.
ALTER TABLE workflow_runs ADD COLUMN agent_runtime_widen_103 TEXT;
UPDATE workflow_runs SET agent_runtime_widen_103 = agent_runtime;
ALTER TABLE workflow_runs DROP COLUMN agent_runtime;
ALTER TABLE workflow_runs
  ADD COLUMN agent_runtime TEXT NOT NULL DEFAULT 'claude-sdk'
    CHECK (agent_runtime IN ('claude-sdk','claude-interactive','codex-sdk','omp-sdk','omp-fleet'));
UPDATE workflow_runs SET agent_runtime = COALESCE(agent_runtime_widen_103, 'claude-sdk');
ALTER TABLE workflow_runs DROP COLUMN agent_runtime_widen_103;

-- ---------------------------------------------------------------------------
-- workflow_variants.agent_provider / workflow_variants.agent_runtime
--
-- Both are nullable (NULL = inherit the launch default), so the IS NULL arm is
-- carried forward and the value copy leaves NULLs as NULL.
-- ---------------------------------------------------------------------------

ALTER TABLE workflow_variants ADD COLUMN agent_provider_widen_103 TEXT;
UPDATE workflow_variants SET agent_provider_widen_103 = agent_provider;
ALTER TABLE workflow_variants DROP COLUMN agent_provider;
ALTER TABLE workflow_variants
  ADD COLUMN agent_provider TEXT
    CHECK (agent_provider IS NULL OR agent_provider IN ('claude','codex','omp'));
UPDATE workflow_variants SET agent_provider = agent_provider_widen_103;
ALTER TABLE workflow_variants DROP COLUMN agent_provider_widen_103;

ALTER TABLE workflow_variants ADD COLUMN agent_runtime_widen_103 TEXT;
UPDATE workflow_variants SET agent_runtime_widen_103 = agent_runtime;
ALTER TABLE workflow_variants DROP COLUMN agent_runtime;
ALTER TABLE workflow_variants
  ADD COLUMN agent_runtime TEXT
    CHECK (agent_runtime IS NULL OR agent_runtime IN ('claude-sdk','claude-interactive','codex-sdk','omp-sdk'));
UPDATE workflow_variants SET agent_runtime = agent_runtime_widen_103;
ALTER TABLE workflow_variants DROP COLUMN agent_runtime_widen_103;

-- ---------------------------------------------------------------------------
-- agent_invocations — full recreate (065 shape + 087's panel_id, both indexes).
-- ---------------------------------------------------------------------------

CREATE TABLE agent_invocations_new (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_invocation_id   TEXT NOT NULL UNIQUE,
  run_id                TEXT NOT NULL,
  step_id               TEXT,
  agent_provider        TEXT NOT NULL
                          CHECK (agent_provider IN ('claude', 'codex', 'omp')),
  agent_runtime         TEXT NOT NULL
                          CHECK (agent_runtime IN ('claude-sdk', 'claude-interactive', 'codex-sdk', 'omp-sdk', 'omp-pty')),
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

-- Carry AUTOINCREMENT's high-water mark across the rebuild. Copying explicit ids
-- only sets the new table's mark to max(id) among the rows that SURVIVE, and the
-- old mark is higher whenever the newest invocations were CASCADE-deleted with
-- their run — which is the normal case. Letting it regress would hand a later
-- insert a retired rowid, precisely what AUTOINCREMENT (rather than a plain
-- INTEGER PRIMARY KEY) exists to promise. sqlite_sequence is an ordinary table
-- and both rows exist at this point; the first statement covers the copy having
-- moved zero rows, which leaves the new table with no sequence row at all.
INSERT INTO sqlite_sequence (name, seq)
  SELECT 'agent_invocations_new', 0
   WHERE EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'agent_invocations')
     AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'agent_invocations_new');

UPDATE sqlite_sequence
   SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'agent_invocations'), 0))
 WHERE name = 'agent_invocations_new';

-- Drops the old table's sqlite_sequence row; the rename carries the new one over.
DROP TABLE agent_invocations;
ALTER TABLE agent_invocations_new RENAME TO agent_invocations;

CREATE INDEX IF NOT EXISTS idx_agent_invocations_run_step_latest
  ON agent_invocations (run_id, step_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_invocations_run_panel_latest
  ON agent_invocations (run_id, panel_id, id DESC);

PRAGMA foreign_keys=ON;
