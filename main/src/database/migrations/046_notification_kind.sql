-- Migration 046: add the `notification` review-item kind.
--
-- review_items gains a FIFTH first-class kind alongside
-- finding | permission | decision | human_task:
--   notification — an informational, NEVER-blocking FYI whose only triage is
--                  Dismiss (no Resolve, no Promote-to-task). The first emitter is
--                  the DynamicWorkflowTracker's "Dynamic workflow finished/stalled"
--                  items, which were previously mis-filed as `human_task`.
--
-- SQLite cannot ALTER a CHECK constraint in place, so widening
-- review_items.kind requires the table-rebuild recipe (mirrors migrations 010 /
-- 020 / 030): create review_items_new with the FULL current schema — every 016
-- column PLUS the three 034 columns (priority/staged_at/selected) — but with the
-- kind CHECK now listing 'notification', copy the rows across with an explicit
-- column list, DROP the old table, RENAME, and recreate all FIVE indexes.
--
-- FK-cascade safety: review_items has two FOREIGN KEYs — project_id -> projects
-- ON DELETE CASCADE and run_id -> workflow_runs ON DELETE SET NULL. Nothing
-- references review_items, so a DROP would not cascade to children, but we still
-- toggle `PRAGMA foreign_keys=OFF` for the rebuild so the DROP/RENAME can never
-- fire a CASCADE/SET NULL side effect mid-migration. The runner at database.ts
-- detects the foreign_keys=OFF literal and manages the restore OUTSIDE the
-- transaction (a pragma toggle is a no-op inside a transaction).
--
-- Backfill: the pre-existing dynamic-workflow items (source = 'dynamic_workflow')
-- that were minted as human_task are re-filed as notification. They carry NULL
-- payload_json, so no payload rewrite is needed — a plain UPDATE of the kind
-- column suffices. human_task rows from any OTHER source are left untouched.
--
-- NOTE: No explicit BEGIN/COMMIT here — runFileBasedMigrations() in database.ts
-- wraps every file in a this.transaction(...) call, so an inner BEGIN would nest.
-- The PRAGMA toggles are applied OUTSIDE that transaction by the runner.
--
-- Idempotency: the DROP/RENAME rebuild is a one-shot (a second exec finds no
-- review_items_new and reproduces the identical shape); the backfill UPDATE is
-- self-narrowing; the production runner gates the whole file to a single
-- application via the user_preferences ledger anyway.

PRAGMA foreign_keys=OFF;

-- ---------------------------------------------------------------------------
-- 1. Rebuild review_items with the widened kind CHECK. Column set is the
--    authoritative post-034 shape: the 016 columns in their original order,
--    with priority/staged_at/selected (034) inserted before source (matching
--    the ReviewItemRow / ReviewItemDbRow field order the parity test pins).
-- ---------------------------------------------------------------------------
CREATE TABLE review_items_new (
  id           TEXT PRIMARY KEY,
  project_id   INTEGER NOT NULL,
  run_id       TEXT,
  entity_type  TEXT CHECK (entity_type IN ('idea', 'epic', 'task')),
  entity_id    TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('finding', 'permission', 'decision', 'human_task', 'notification')),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
  blocking     BOOLEAN NOT NULL DEFAULT 0,
  title        TEXT NOT NULL,
  body         TEXT,
  severity     TEXT CHECK (severity IN ('info', 'warning', 'error')),
  priority     TEXT CHECK (priority IN ('P0', 'P1', 'P2')),               -- migration 034
  staged_at    DATETIME,                                                  -- migration 034
  selected     INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),     -- migration 034
  source       TEXT,
  payload_json TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  resolved_by  TEXT,
  resolution   TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id)      ON DELETE CASCADE,
  FOREIGN KEY (run_id)     REFERENCES workflow_runs(id) ON DELETE SET NULL
);

INSERT INTO review_items_new (
  id, project_id, run_id, entity_type, entity_id, kind, status, blocking,
  title, body, severity, priority, staged_at, selected, source, payload_json,
  created_at, updated_at, resolved_by, resolution
)
SELECT
  id, project_id, run_id, entity_type, entity_id, kind, status, blocking,
  title, body, severity, priority, staged_at, selected, source, payload_json,
  created_at, updated_at, resolved_by, resolution
FROM review_items;

DROP TABLE review_items;
ALTER TABLE review_items_new RENAME TO review_items;

-- Recreate ALL FIVE indexes: the three from 016 + the two from 034.
CREATE INDEX IF NOT EXISTS idx_review_items_project_status   ON review_items(project_id, status);
CREATE INDEX IF NOT EXISTS idx_review_items_run_kind         ON review_items(run_id, kind);
CREATE INDEX IF NOT EXISTS idx_review_items_blocking_status  ON review_items(blocking, status);
CREATE INDEX IF NOT EXISTS idx_review_items_project_staged   ON review_items(project_id, staged_at);
CREATE INDEX IF NOT EXISTS idx_review_items_project_selected ON review_items(project_id, selected);

-- ---------------------------------------------------------------------------
-- 2. Backfill: re-file the dynamic-workflow finished/stalled items (the only
--    notification emitter today) from human_task to notification. These rows
--    carry NULL payload_json, so only the kind column changes. human_task rows
--    from any other source keep their kind.
-- ---------------------------------------------------------------------------
UPDATE review_items SET kind = 'notification'
WHERE kind = 'human_task' AND source = 'dynamic_workflow';

PRAGMA foreign_keys=ON;
