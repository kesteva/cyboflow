-- Migration 016: review_items unified human-attention inbox (P2).
--
-- Adds the single `review_items` table that aggregates every item needing
-- human attention across all runs in a project:
--   kind in (finding | permission | decision | human_task)
--   status in (pending | resolved | dismissed)
--   per-item `blocking` boolean (a run stays awaiting_review until ALL its
--   blocking review_items resolve — aggregate-unblock lands in P4).
--
-- SOFT polymorphic entity link: (entity_type, entity_id) are BOTH nullable and
-- validated in code (the chokepoint ReviewItemRouter), NOT split into per-type
-- FK columns. entity_type is CHECK-constrained to (idea|epic|task) so a review
-- item can reference any of the three entity tables without a hard FK (the
-- referenced row may be deleted; the review item survives for the audit trail).
--
-- Audit log REUSE: review-item lifecycle deltas are appended to the existing
-- polymorphic `entity_events` log (migration 015 already widened its
-- entity_type CHECK to include 'review_item'), so NO new event table is needed.
--
-- FORWARD-ONLY, NO BACKFILL: 015 left the app green WITHOUT the inbox; 016 only
-- adds the table + indexes. No agent/approval wiring lands here (P3/P4).
--
-- Authoritative spec: docs/cyboflow_system_design.md "Review queue" feature +
-- the LOCKED review-queue design. Field-for-field source of truth for the row
-- shape is main/src/database/models.ts (ReviewItemRow) and
-- shared/types/reviews.ts (ReviewItem); reviewItemSchemaParity (in
-- entitySchemaParity.test.ts) pins them.
--
-- NOTE: No explicit BEGIN/COMMIT here — runFileBasedMigrations() in database.ts
-- wraps every file in a this.transaction(...) call, so an inner BEGIN would nest.
--
-- Idempotency: the CREATE uses IF NOT EXISTS; every index uses IF NOT EXISTS, so
-- re-applying the file (after a ledger reset) is a no-op.

-- ---------------------------------------------------------------------------
-- review_items — the unified human-attention inbox.
--
--   project_id      FK->projects ON DELETE CASCADE (the item dies with the project).
--   run_id          FK->workflow_runs ON DELETE SET NULL (nullable; a manual /
--                   triage-created item has no run; SET NULL keeps history when a
--                   run is pruned).
--   entity_type     CHECK(idea|epic|task) NULL — soft polymorphic link, code-validated.
--   entity_id       NULL — paired with entity_type; NO hard FK (the row may be deleted).
--   kind            CHECK(finding|permission|decision|human_task).
--   status          CHECK(pending|resolved|dismissed) DEFAULT 'pending'.
--   blocking        BOOLEAN DEFAULT 0 — whether this item gates run resume.
--   severity        CHECK(info|warning|error) NULL — only meaningful for findings.
--   source          TEXT — free-form provenance (e.g. 'agent:executor', 'approval', 'gate:approve-plan').
--   payload_json    TEXT — per-kind payload union, serialized (see shared/types/reviews.ts).
--   resolved_by     TEXT NULL — actor that resolved/dismissed the item.
--   resolution      TEXT NULL — free-form resolution note (e.g. 'promoted:tsk_...').
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS review_items (
  id           TEXT PRIMARY KEY,                                       -- opaque unique (e.g. 'rvw_'+rand)
  project_id   INTEGER NOT NULL,
  run_id       TEXT,                                                   -- nullable: manual/triage items have no run
  entity_type  TEXT CHECK (entity_type IN ('idea', 'epic', 'task')),  -- soft polymorphic link (code-validated)
  entity_id    TEXT,                                                   -- paired with entity_type; NO hard FK
  kind         TEXT NOT NULL CHECK (kind IN ('finding', 'permission', 'decision', 'human_task')),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
  blocking     BOOLEAN NOT NULL DEFAULT 0,                             -- whether this item gates run resume
  title        TEXT NOT NULL,
  body         TEXT,                                                   -- markdown detail
  severity     TEXT CHECK (severity IN ('info', 'warning', 'error')), -- nullable; finding-only
  source       TEXT,                                                   -- free-form provenance
  payload_json TEXT,                                                   -- per-kind payload union (serialized)
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_by  TEXT,                                                   -- actor that resolved/dismissed
  resolution   TEXT,                                                   -- free-form resolution note
  FOREIGN KEY (project_id) REFERENCES projects(id)      ON DELETE CASCADE,
  FOREIGN KEY (run_id)     REFERENCES workflow_runs(id) ON DELETE SET NULL
);

-- Inbox listing for a project, filtered by status (the dominant read).
CREATE INDEX IF NOT EXISTS idx_review_items_project_status ON review_items(project_id, status);
-- Per-run findings/permissions lookup (used by the aggregate-unblock check in P4).
CREATE INDEX IF NOT EXISTS idx_review_items_run_kind ON review_items(run_id, kind);
-- Fast "are there blocking items still pending?" probe.
CREATE INDEX IF NOT EXISTS idx_review_items_blocking_status ON review_items(blocking, status);
