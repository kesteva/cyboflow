-- Migration 034: findings-triage redesign (Direction A).
--
-- review_items:
--   priority    P0/P1/P2 first-class column (D2). NULL = un-prioritized legacy
--               finding; the UI renders NULL as an explicit "unset" badge and
--               SORTS it as P2 — NULL is never relabeled in data.
--   staged_at   non-NULL == the human approved this finding into READY. Doubles
--               as staging order. NULL == untriaged.
--   selected    0/1 — the per-finding "compound this" checkbox (D1).
--
-- workflow_runs:
--   seed_finding_ids  JSON string array of selected review_items.id seeded into
--               a compound run at launch (D1/D4). Mirrors seed_idea_id (017) /
--               batch_id (022) — soft link, no FK. workflow_runs has NO write
--               chokepoint; the seed is a post-create UPDATE, the sanctioned
--               pattern (see runLauncher SET seed_idea_id / SET batch_id).
--
-- INVARIANT: status is NOT overloaded. A finding is status='pending' for BOTH
-- untriaged (staged_at NULL) and ready (staged_at set). Only Dismiss
-- (status->'dismissed') and compound-consume (status->'resolved') change status.
-- A future reader filtering status='pending' MUST also check staged_at.
--
-- priority/staged_at/selected apply table-wide but are only meaningful for
-- kind='finding' (same convention as severity, migration 016).
--
-- Idempotency: SQLite ADD COLUMN is NOT IF-NOT-EXISTS. Re-applying outside the
-- production ledger throws "duplicate column name: priority" on the FIRST ALTER;
-- the runner's transaction wrapper rolls the whole file back (so the later three
-- ALTERs never execute) and the ledger marks it applied. Proven behavior (024).
-- schema.sql is intentionally NOT edited: review_items is migrations-only, and
-- workflow_runs' prior ALTER columns (seed_idea_id/batch_id/substrate) are
-- likewise absent from schema.sql, so parity stays green with zero schema edits.
--
-- NOTE: No explicit BEGIN/COMMIT here — runFileBasedMigrations() in database.ts
-- wraps every file in a this.transaction(...) call, so an inner BEGIN would nest.
--
-- CROSS-BRANCH COLLISION (renumbered 032 -> 034 on rebase onto main): sibling
-- worktrees collided on 029/030/031, and main later took 032 (execution_model)
-- + 033 (step_results), so this file moved to the next free number, 034. Keep
-- ALL feature schema in this SINGLE file. On the next merge, if 034 is taken,
-- renumber to the next free number and update the test chain + test filename
-- in one pass.

ALTER TABLE review_items ADD COLUMN priority TEXT CHECK (priority IN ('P0','P1','P2'));
ALTER TABLE review_items ADD COLUMN staged_at DATETIME;
ALTER TABLE review_items ADD COLUMN selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0,1));
ALTER TABLE workflow_runs ADD COLUMN seed_finding_ids TEXT;

CREATE INDEX IF NOT EXISTS idx_review_items_project_staged   ON review_items(project_id, staged_at);
CREATE INDEX IF NOT EXISTS idx_review_items_project_selected ON review_items(project_id, selected);
