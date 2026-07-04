-- Migration 046: workflow A/B testing — variant registry + run tagging.
-- Owns the workflow_variants table AND all four workflow_runs ALTERs (shared
-- contract). Nullable columns, no CHECK (mirrors 037/044); ALTER ADD COLUMN is
-- idempotent via the filename-keyed ledger. Runs inside runFileBasedMigrations'
-- transaction wrapper (no explicit BEGIN/COMMIT). PRAGMA foreign_keys is OFF
-- during migration (database.ts), so the FK below is recorded, not enforced now.
--
-- Variant status semantics (rotation is EXPLICIT opt-in): a new variant defaults
-- to 'draft' — defined, pinnable, usable in side-by-side experiments, but NEVER
-- auto-rotated. 'active' = in rotation; 'paused' = temporarily out; 'retired' =
-- hidden from pickers, kept for stats. The rotation resolver selects only
-- status='active' AND weight>0; an explicit pin loads a variant of ANY status.
--
-- ⚠️ MIGRATION-NUMBER COLLISION: sibling branches have previously claimed 043/044.
-- The ledger is filename-keyed; whichever lands second must renumber. The
-- integrator MUST verify no other 046_*.sql exists at merge time.

CREATE TABLE IF NOT EXISTS workflow_variants (
  id                   TEXT PRIMARY KEY,                 -- 'wfv_' + hex
  workflow_id          TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  label                TEXT NOT NULL,                    -- UNIQUE per workflow (index below)
  spec_json            TEXT NOT NULL DEFAULT '{}',       -- frozen snapshot of the resolved definition
  agent_overrides_json TEXT,                             -- nullable JSON: { [agentKey]: { systemPrompt?, model? } }
  model                TEXT,                             -- nullable per-variant model-alias default
  execution_model      TEXT,                             -- nullable 'orchestrated' | 'programmatic'
  weight               INTEGER NOT NULL DEFAULT 1,       -- rotation weight (>=0, enforced in code)
  status               TEXT NOT NULL DEFAULT 'draft',    -- 'draft' | 'active' | 'paused' | 'retired'
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_variants_wf_label
  ON workflow_variants(workflow_id, label);

-- Rotation candidate scan: variants of one workflow keyed by status.
CREATE INDEX IF NOT EXISTS idx_workflow_variants_wf_status
  ON workflow_variants(workflow_id, status);

-- workflow_runs tagging columns (all nullable, soft links, immutable @ createRun).
-- variant_id is a SOFT link (NO FK) so a retired/deleted variant never orphans a
-- historical run; variant_label is the denormalized snapshot that survives
-- rename/delete. experiment_id / experiment_arm are stamped by slice 2's
-- experiment launcher (columns land here so createRun can stamp them uniformly).
ALTER TABLE workflow_runs ADD COLUMN experiment_id TEXT;
ALTER TABLE workflow_runs ADD COLUMN experiment_arm TEXT;   -- 'A' | 'B'
ALTER TABLE workflow_runs ADD COLUMN variant_id TEXT;
ALTER TABLE workflow_runs ADD COLUMN variant_label TEXT;

-- Attribution scan: runs by variant (per-variant stats in slices 2/3).
CREATE INDEX IF NOT EXISTS idx_workflow_runs_variant_id
  ON workflow_runs(variant_id);
