-- Migration 015: 3-table entity model rebuild (P1).
--
-- Replaces the single unified `tasks` table from migration 014 with three
-- dedicated entity tables — `ideas`, `epics`, `tasks` — each carrying its own
-- columns plus a single markdown `body` column and a `stage_id` onto the SHARED
-- board. The polymorphic `entity_events` log replaces the task-scoped
-- `task_events`. A 12th board stage ('Decomposed', idea-only terminal) is added.
--
-- Table identity IS the type discriminator: `ideas` has NO type column and NO
-- lineage FK; `epics` adds originating_idea_id; `tasks` adds parent_epic_id +
-- originating_idea_id + entry_stage_id. Lineage is validated in the chokepoint
-- (TaskChangeRouter.applyChange) AND enforced by the FKs below.
--
-- NO PROD DATA EXISTS — destructive-clean is intentional and safe. The four
-- task satellite tables (acceptance_criteria/dependencies/files/external_links)
-- are DROPPED + recreated FK->new tasks(id) because SQLite cannot re-target an
-- existing foreign key.
--
-- Authoritative spec: docs/cyboflow_system_design.md "Task backlog" feature +
-- the LOCKED 3-table entity-model design. Field-for-field source of truth for
-- the row shapes is main/src/database/models.ts (IdeaRow/EpicRow/TaskRow +
-- EntityEventRow) and shared/types/tasks.ts; entitySchemaParity.test.ts pins
-- them. The 12-stage board seed MUST stay field-for-field in sync with
-- database.ts seedDefaultBoard.
--
-- review_items lands in its OWN migration 016 (P2). 015 = entity model only;
-- it leaves the app green with the 3-table board working WITHOUT the inbox.
--
-- NOTE: No explicit BEGIN/COMMIT here — runFileBasedMigrations() in database.ts
-- wraps every file in a this.transaction(...) call, so an inner BEGIN would nest.
--
-- Idempotency: the DROPs use IF EXISTS; every CREATE uses IF NOT EXISTS; every
-- seed INSERT uses INSERT OR IGNORE keyed on deterministic ids, so re-applying
-- the file (after a ledger reset) is a no-op.

-- ---------------------------------------------------------------------------
-- 1. DROP the old unified model. Order matters: satellites + events first
--    (they FK->tasks), then tasks itself. boards/board_stages/ref counters are
--    PRESERVED — only the stage seed is extended (step 6) and the counters are
--    re-seeded per entity type (step 7).
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS task_external_links;
DROP TABLE IF EXISTS task_files;
DROP TABLE IF EXISTS task_dependencies;
DROP TABLE IF EXISTS task_acceptance_criteria;
DROP TABLE IF EXISTS task_events;
DROP TABLE IF EXISTS tasks;

-- ---------------------------------------------------------------------------
-- 2. ideas — table identity IS the discriminator (NO type column, NO lineage).
--    `scope` is the nullable size hint set at idea-spec time ('small'|'large').
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ideas (
  id          TEXT PRIMARY KEY,                          -- opaque unique (e.g. 'ide_'+rand)
  project_id  INTEGER NOT NULL,
  ref         TEXT NOT NULL,                             -- display ref, e.g. 'IDEA-007'
  title       TEXT NOT NULL,
  summary     TEXT,
  body        TEXT,                                      -- single markdown body
  scope       TEXT CHECK (scope IN ('small', 'large')),  -- nullable size hint (idea-spec time)
  priority    TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0', 'P1', 'P2')),
  repo        TEXT,
  board_id    TEXT NOT NULL,
  stage_id    TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,                -- optimistic concurrency
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (project_id, ref),
  FOREIGN KEY (project_id) REFERENCES projects(id)     ON DELETE CASCADE,
  FOREIGN KEY (board_id)   REFERENCES boards(id)       ON DELETE RESTRICT,
  FOREIGN KEY (stage_id)   REFERENCES board_stages(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_ideas_project_id  ON ideas(project_id);
CREATE INDEX IF NOT EXISTS idx_ideas_board_stage ON ideas(board_id, stage_id);

-- ---------------------------------------------------------------------------
-- 3. epics — same base + originating_idea_id lineage FK->ideas(id).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epics (
  id                   TEXT PRIMARY KEY,                 -- opaque unique (e.g. 'epc_'+rand)
  project_id           INTEGER NOT NULL,
  ref                  TEXT NOT NULL,                    -- display ref, e.g. 'EPIC-011'
  title                TEXT NOT NULL,
  summary              TEXT,
  body                 TEXT,                             -- single markdown body
  priority             TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0', 'P1', 'P2')),
  repo                 TEXT,
  board_id             TEXT NOT NULL,
  stage_id             TEXT NOT NULL,
  originating_idea_id  TEXT,                             -- lineage: epic came from this idea
  version              INTEGER NOT NULL DEFAULT 1,       -- optimistic concurrency
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (project_id, ref),
  FOREIGN KEY (project_id)          REFERENCES projects(id)     ON DELETE CASCADE,
  FOREIGN KEY (board_id)            REFERENCES boards(id)       ON DELETE RESTRICT,
  FOREIGN KEY (stage_id)            REFERENCES board_stages(id) ON DELETE RESTRICT,
  FOREIGN KEY (originating_idea_id) REFERENCES ideas(id)        ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_epics_project_id          ON epics(project_id);
CREATE INDEX IF NOT EXISTS idx_epics_board_stage         ON epics(board_id, stage_id);
CREATE INDEX IF NOT EXISTS idx_epics_originating_idea_id ON epics(originating_idea_id);

-- ---------------------------------------------------------------------------
-- 4. tasks — same base + parent_epic_id FK->epics + originating_idea_id
--    FK->ideas + entry_stage_id (planning stage captured at first execution;
--    revert target). NO type column, NO stored 'status' (derived from stage).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id                   TEXT PRIMARY KEY,                 -- opaque unique (e.g. 'tsk_'+rand)
  project_id           INTEGER NOT NULL,
  ref                  TEXT NOT NULL,                    -- display ref, e.g. 'TASK-642'
  title                TEXT NOT NULL,
  summary              TEXT,
  body                 TEXT,                             -- single markdown body
  priority             TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0', 'P1', 'P2')),
  repo                 TEXT,
  board_id             TEXT NOT NULL,
  stage_id             TEXT NOT NULL,
  entry_stage_id       TEXT,                             -- planning stage captured at first execution; revert target
  parent_epic_id       TEXT,                             -- lineage: task belongs to this epic
  originating_idea_id  TEXT,                             -- lineage: task carried from this idea (small-idea branch)
  version              INTEGER NOT NULL DEFAULT 1,       -- optimistic concurrency
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (project_id, ref),
  FOREIGN KEY (project_id)          REFERENCES projects(id)     ON DELETE CASCADE,
  FOREIGN KEY (board_id)            REFERENCES boards(id)       ON DELETE RESTRICT,
  FOREIGN KEY (stage_id)            REFERENCES board_stages(id) ON DELETE RESTRICT,
  FOREIGN KEY (parent_epic_id)      REFERENCES epics(id)        ON DELETE SET NULL,
  FOREIGN KEY (originating_idea_id) REFERENCES ideas(id)        ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id          ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_board_stage         ON tasks(board_id, stage_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_epic_id      ON tasks(parent_epic_id);
CREATE INDEX IF NOT EXISTS idx_tasks_originating_idea_id ON tasks(originating_idea_id);

-- ---------------------------------------------------------------------------
-- 5. entity_events — polymorphic append-only per-field delta log. Replaces the
--    task-scoped task_events. The (entity_type, entity_id) pair is the soft
--    polymorphic link; seq is minted per-(entity_type,entity_id) atomically
--    INSIDE the chokepoint transaction. 'review_item' is allowed by the CHECK
--    so P2 (016) can reuse this same log with no schema change.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entity_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('idea', 'epic', 'task', 'review_item')),
  entity_id    TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  actor        TEXT NOT NULL,                            -- 'user' | 'orchestrator' | 'agent:<role>' | 'linear'
  run_id       TEXT,
  changes_json TEXT,                                     -- JSON array [{field, from, to}]
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (entity_type, entity_id, seq),
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_entity_events_entity ON entity_events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_events_run_id ON entity_events(run_id);

-- ---------------------------------------------------------------------------
-- 6. task satellite tables — recreated FK->new tasks(id). Identical shapes to
--    migration 014; only the FK target table is the rebuilt `tasks`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_acceptance_criteria (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL,
  criterion  TEXT NOT NULL,
  completed  BOOLEAN NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_acceptance_criteria_task_id ON task_acceptance_criteria(task_id);

CREATE TABLE IF NOT EXISTS task_dependencies (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id            TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'blocking' CHECK (kind IN ('blocking', 'related')),
  UNIQUE (task_id, depends_on_task_id),
  FOREIGN KEY (task_id)            REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_task_id ON task_dependencies(task_id);

CREATE TABLE IF NOT EXISTS task_files (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id   TEXT NOT NULL,
  file_path TEXT NOT NULL,
  ownership TEXT NOT NULL DEFAULT 'readonly' CHECK (ownership IN ('owned', 'readonly')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_files_task_id ON task_files(task_id);

CREATE TABLE IF NOT EXISTS task_external_links (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL,
  provider      TEXT NOT NULL,
  external_id   TEXT,
  external_url  TEXT,
  synced_cursor TEXT,
  baseline_json TEXT,
  UNIQUE (task_id, provider),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_external_links_task_id ON task_external_links(task_id);

-- ---------------------------------------------------------------------------
-- 7. SEED: ensure the default board exists for every project, then insert the
--    12th stage 'Decomposed' (asserted, terminal=1, hidden=0) on EVERY board.
--    The board itself + stages 1..11 were seeded by migration 014; this only
--    EXTENDS the seed with position 12. Field-for-field in sync with
--    database.ts seedDefaultBoard.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO boards (id, project_id, name, kind, is_default)
SELECT 'board-' || id || '-default', id, 'Default board', 'default', 1
FROM projects;

INSERT OR IGNORE INTO board_stages (id, board_id, label, color_oklch, hint, position, write_policy, is_terminal, hidden_by_default)
SELECT 'stage-' || b.id || '-12', b.id, 'Decomposed', 'oklch(0.52 0.04 300)', 'Idea retired · children carry the flow', 12, 'asserted', 1, 0
FROM boards b;

-- ---------------------------------------------------------------------------
-- 8. RE-SEED task_ref_counters per (project, entity_type) for idea/epic/task.
--    Counters are PRESERVED across the rebuild (the table was not dropped); we
--    only guarantee a row exists for each entity type so the chokepoint's
--    UPDATE ... RETURNING never misses. The CHECK on tasks/epics/ideas is
--    table identity, so the counter `type` value matches the entity type.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO task_ref_counters (project_id, type, next_seq)
SELECT id, 'idea', 0 FROM projects;
INSERT OR IGNORE INTO task_ref_counters (project_id, type, next_seq)
SELECT id, 'epic', 0 FROM projects;
INSERT OR IGNORE INTO task_ref_counters (project_id, type, next_seq)
SELECT id, 'task', 0 FROM projects;
