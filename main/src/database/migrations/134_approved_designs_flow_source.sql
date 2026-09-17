-- Migration 133: admit FLOW-sourced rows into `approved_designs`.
--
-- WHY. Until now the only writer of this table was Design Mode's Approve state
-- machine (main/src/orchestrator/design/designHandoffService.ts), which always
-- has a `design_handoffs` row and a Design Mode `sessions` row to point at — so
-- 082 minted `handoff_id` and `session_id` NOT NULL. A Launch/Planner/Ship run
-- that clears its `approve-design` / `approve-ideas` gate has NEITHER: there is
-- no draft, no CAS target, and no design session. The durable thing that run DOES
-- have is the prototype snapshot, and pinning it to the idea is the whole point —
-- `approved_designs` deliberately carries no FKs (082's header) precisely so the
-- snapshot survives the run's `artifacts` ON DELETE CASCADE.
--
-- Two changes:
--   * `source` ('design-mode' | 'flow') + `source_run_id` — provenance, so a
--     Design Mode approval can be recognized and left alone by the flow binder
--     ("arrived with an approved design → don't overwrite it").
--   * `handoff_id` / `session_id` widened to NULLable — a flow row has neither.
--     Source-compatible: no production code dereferences either column
--     (approvedDesigns.ts copies them into the read model and nothing reads them
--     back off an `ApprovedDesign`), so widening breaks no consumer.
--
-- WHY A RECREATE. SQLite cannot drop a NOT NULL constraint in place, and the
-- file-keyed migration ledger applies each .sql exactly once, so editing 082 in
-- place would never re-apply on a migrated DB (the 062 lesson).
--
-- REPLAY SAFETY — CONVERGENT, not conditional (105/129's argument). A ledger-wiped
-- DB re-runs this file end to end. The two leading ALTERs are idempotent (the
-- runner tolerates `duplicate column name` per statement), and the recreate's copy
-- is column-for-column VERBATIM — including `source` and `source_run_id`, so a
-- second pass does NOT silently rewrite a `source='flow'` row back to
-- 'design-mode'. Omitting those two columns from the copy lists is exactly the bug
-- this note exists to prevent: it would invert the precedence rule above and pin
-- every flow-bound design as an un-overridable Design Mode approval.
--
-- The `_new` CREATE is BARE, not `IF NOT EXISTS`, deliberately (105/129 again): a
-- leftover `_new` from a half-applied pass must fail LOUDLY rather than be
-- silently reused and renamed over live data. The `_new` name is free at the start
-- of every pass because the previous pass renamed it away.
--
-- `PRAGMA foreign_keys=OFF` is hoisted outside the wrapping transaction by the
-- migration runner (docs/CODE-PATTERNS.md). `approved_designs` has no FK children
-- today, but the recreate is the house pattern and this costs nothing.
--
-- SCHEMA PARITY: none required. `approved_designs` is migration-only — it does not
-- appear in main/src/database/schema.sql, so `pnpm run verify:schema` compares
-- identical migration-derived shapes on both paths, and entitySchemaParity.test.ts
-- pins only ideas/tasks/review_items.
--
-- NEW INDEX. `idx_approved_designs_current` is a PARTIAL UNIQUE index enforcing
-- the invariant the read model already assumes: exactly one current row per idea
-- (`getCurrentApprovedDesign`'s `WHERE idea_id=? AND superseded_at IS NULL LIMIT 1`
-- — the LIMIT 1 is the only thing hiding a split brain today). With a SECOND
-- independent writer (flowDesignBinding) plus a settle-time reconciliation that
-- re-runs the same bind, a bug in either path would otherwise produce two current
-- rows and `getCurrentApprovedDesign` would pick one at random. As a constraint it
-- fails loudly inside the binder's own transaction instead.

PRAGMA foreign_keys=OFF;

-- Idempotent per statement (`duplicate column name` is tolerated by the runner),
-- so the verbatim copy below can name both columns on EVERY pass.
ALTER TABLE approved_designs ADD COLUMN source TEXT NOT NULL DEFAULT 'design-mode';
ALTER TABLE approved_designs ADD COLUMN source_run_id TEXT;

CREATE TABLE approved_designs_new (
  id TEXT PRIMARY KEY,
  idea_id TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  handoff_id TEXT,
  session_id TEXT,
  draft_revision INTEGER NOT NULL DEFAULT 0,
  prototype_artifact_id TEXT NOT NULL,
  prototype_revision INTEGER NOT NULL,
  snapshot_path TEXT NOT NULL,
  approved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  superseded_at DATETIME,
  source TEXT NOT NULL DEFAULT 'design-mode' CHECK (source IN ('design-mode','flow')),
  source_run_id TEXT
);

INSERT INTO approved_designs_new (
  id, idea_id, project_id, handoff_id, session_id, draft_revision,
  prototype_artifact_id, prototype_revision, snapshot_path, approved_at,
  superseded_at, source, source_run_id
)
  SELECT id, idea_id, project_id, handoff_id, session_id, draft_revision,
         prototype_artifact_id, prototype_revision, snapshot_path, approved_at,
         superseded_at, source, source_run_id
    FROM approved_designs;

DROP TABLE approved_designs;
ALTER TABLE approved_designs_new RENAME TO approved_designs;

CREATE INDEX IF NOT EXISTS idx_approved_designs_idea ON approved_designs(idea_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_approved_designs_current
  ON approved_designs(idea_id) WHERE superseded_at IS NULL;

PRAGMA foreign_keys=ON;
