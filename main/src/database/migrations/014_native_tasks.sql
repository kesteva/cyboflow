-- Migration 014: Native task backlog (Phase 0 + Phase 1).
--
-- Adds the native planning-pipeline data model: boards, board_stages, tasks,
-- task ref counters, task events, and the task satellite tables (acceptance
-- criteria, dependencies, files, external links). Also extends workflow_runs
-- with the canonical run->task link and DB-canonical close-out signal columns.
--
-- Authoritative spec: docs/cyboflow_system_design.md "Task backlog" feature.
-- Field-for-field source of truth for the row shapes is shared/types/tasks.ts.
--
-- NOTE: No explicit BEGIN/COMMIT here — runFileBasedMigrations() in database.ts
-- wraps every file in a this.transaction(...) call, so an inner BEGIN would nest.
--
-- Idempotency: every CREATE uses IF NOT EXISTS; every seed INSERT uses
-- INSERT OR IGNORE keyed on deterministic ids, so re-applying the file (after a
-- ledger reset) is a no-op. The ALTER TABLE statements on workflow_runs are NOT
-- idempotent (SQLite has no ADD COLUMN IF NOT EXISTS); runFileBasedMigrations()
-- treats "duplicate column name" as the idempotency signal.

-- ---------------------------------------------------------------------------
-- 1. boards — one default board per project (custom boards deferred).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS boards (
  id         TEXT PRIMARY KEY,                          -- 'board-{projectId}-default'
  project_id INTEGER NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'default' CHECK (kind IN ('default', 'custom')),
  is_default BOOLEAN NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (project_id, name),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_boards_project_id ON boards(project_id);

-- ---------------------------------------------------------------------------
-- 2. board_stages — ordered columns within a board.
--    write_policy is the AUTHORITY axis: 'derived' = orchestrator-only,
--    'asserted' = user/agent-settable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS board_stages (
  id                TEXT PRIMARY KEY,                   -- 'stage-{boardId}-{position}'
  board_id          TEXT NOT NULL,
  label             TEXT NOT NULL,
  color_oklch       TEXT NOT NULL,
  hint              TEXT,
  position          INTEGER NOT NULL,
  write_policy      TEXT NOT NULL CHECK (write_policy IN ('asserted', 'derived')),
  is_terminal       BOOLEAN NOT NULL DEFAULT 0,
  hidden_by_default BOOLEAN NOT NULL DEFAULT 0,
  UNIQUE (board_id, position),
  FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_board_stages_board_id ON board_stages(board_id);

-- ---------------------------------------------------------------------------
-- 3. tasks — the planning items (idea | epic | task).
--    No inline external_* columns. No stored 'status' (derived from stage).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,                     -- opaque unique (e.g. 'tsk_'+rand)
  project_id      INTEGER NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('idea', 'epic', 'task')),
  ref             TEXT NOT NULL,                        -- display ref, e.g. 'EPIC-011'
  parent_epic_id  TEXT,                                 -- only type='task' may set; validated in chokepoint
  board_id        TEXT NOT NULL,
  stage_id        TEXT NOT NULL,
  entry_stage_id  TEXT,                                 -- planning stage captured at first execution; revert target
  title           TEXT NOT NULL,
  summary         TEXT,
  priority        TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0', 'P1', 'P2')),
  repo            TEXT,
  version         INTEGER NOT NULL DEFAULT 1,           -- optimistic concurrency
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (project_id, ref),
  FOREIGN KEY (project_id)     REFERENCES projects(id)      ON DELETE CASCADE,
  FOREIGN KEY (parent_epic_id) REFERENCES tasks(id)         ON DELETE SET NULL,
  FOREIGN KEY (board_id)       REFERENCES boards(id)        ON DELETE RESTRICT,
  FOREIGN KEY (stage_id)       REFERENCES board_stages(id)  ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id        ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_board_stage       ON tasks(board_id, stage_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_epic_id    ON tasks(parent_epic_id);

-- ---------------------------------------------------------------------------
-- 4. task_ref_counters — per (project, type) monotonic ref sequence.
--    Minted inside the chokepoint txn via UPDATE ... RETURNING next_seq.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_ref_counters (
  project_id INTEGER NOT NULL,
  type       TEXT NOT NULL,
  next_seq   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, type)
);

-- ---------------------------------------------------------------------------
-- 5. task_events — append-only per-field delta log (no JSON-diffing by consumers).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  actor        TEXT NOT NULL,                           -- 'user' | 'orchestrator' | 'agent:<role>' | 'linear'
  run_id       TEXT,
  changes_json TEXT,                                    -- JSON array [{field, from, to}]
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (task_id, seq),
  FOREIGN KEY (task_id) REFERENCES tasks(id)         ON DELETE CASCADE,
  FOREIGN KEY (run_id)  REFERENCES workflow_runs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_task_events_task_seq ON task_events(task_id, seq);
CREATE INDEX IF NOT EXISTS idx_task_events_run_id   ON task_events(run_id);

-- ---------------------------------------------------------------------------
-- 6. task_acceptance_criteria
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

-- ---------------------------------------------------------------------------
-- 7. task_dependencies
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 8. task_files
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_files (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id   TEXT NOT NULL,
  file_path TEXT NOT NULL,
  ownership TEXT NOT NULL DEFAULT 'readonly' CHECK (ownership IN ('owned', 'readonly')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_files_task_id ON task_files(task_id);

-- ---------------------------------------------------------------------------
-- 9. task_external_links — Linear-ready; sync engine deferred (Phase 2).
-- ---------------------------------------------------------------------------
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
-- 10. workflow_runs extension — canonical run->task link + close-out signal +
--     triage/reconcile fields. NOT idempotent (see header note).
-- ---------------------------------------------------------------------------
ALTER TABLE workflow_runs ADD COLUMN task_id TEXT;              -- one run -> one task; a task has 0..N runs
ALTER TABLE workflow_runs ADD COLUMN outcome TEXT;             -- 'merged'|'pr_open'|'dismissed'|'failed'|'canceled'|NULL
ALTER TABLE workflow_runs ADD COLUMN base_branch TEXT;         -- captured at launch (future git triage only)
ALTER TABLE workflow_runs ADD COLUMN base_sha TEXT;            -- captured at launch (future git triage only)
ALTER TABLE workflow_runs ADD COLUMN steps_snapshot_json TEXT; -- step->agent map frozen at launch
CREATE INDEX IF NOT EXISTS idx_workflow_runs_task_id ON workflow_runs(task_id);

-- ---------------------------------------------------------------------------
-- 11. SEED: default board + 11 stages for every EXISTING project.
--     (Project creation re-runs this same logic via database.ts createProject.)
--     Deterministic ids keep INSERT OR IGNORE idempotent.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO boards (id, project_id, name, kind, is_default)
SELECT 'board-' || id || '-default', id, 'Default board', 'default', 1
FROM projects;

-- Stage seeds. Each row is keyed on the deterministic stage id
-- 'stage-{boardId}-{position}'. The board id is itself deterministic
-- ('board-{projectId}-default'), so positions 1..11 fan out per existing project.
-- Positions / write_policy / is_terminal / hidden_by_default match the canonical
-- BACKLOG_STAGES seed table in the spec exactly.

INSERT OR IGNORE INTO board_stages (id, board_id, label, color_oklch, hint, position, write_policy, is_terminal, hidden_by_default)
SELECT 'stage-' || b.id || '-1', b.id, 'Idea',                  'oklch(0.58 0.15 262)', 'Raw input captured',            1,  'asserted', 0, 0 FROM boards b
UNION ALL
SELECT 'stage-' || b.id || '-2', b.id, 'Research',              'oklch(0.58 0.15 284)', 'Optional · prior art',          2,  'asserted', 0, 0 FROM boards b
UNION ALL
SELECT 'stage-' || b.id || '-3', b.id, 'Idea spec',             'oklch(0.58 0.15 306)', 'Spec drafted',                  3,  'asserted', 0, 0 FROM boards b
UNION ALL
SELECT 'stage-' || b.id || '-4', b.id, 'Epics extracted',       'oklch(0.58 0.16 330)', 'Grouped into epics',            4,  'asserted', 0, 0 FROM boards b
UNION ALL
SELECT 'stage-' || b.id || '-5', b.id, 'Tasks extracted',       'oklch(0.59 0.16 354)', 'Tasks written',                 5,  'asserted', 0, 0 FROM boards b
UNION ALL
SELECT 'stage-' || b.id || '-6', b.id, 'Ready for development', 'oklch(0.64 0.15 28)',  'Approved · queued',             6,  'asserted', 0, 0 FROM boards b
UNION ALL
SELECT 'stage-' || b.id || '-7', b.id, 'In development',        'oklch(0.63 0.16 45)',  'Executor verifier loop',        7,  'derived',  0, 0 FROM boards b
UNION ALL
SELECT 'stage-' || b.id || '-8', b.id, 'Ready to merge',        'oklch(0.64 0.13 120)', 'Checks green · awaiting merge', 8,  'derived',  0, 0 FROM boards b
UNION ALL
SELECT 'stage-' || b.id || '-9', b.id, 'Done',                  'oklch(0.56 0.13 152)', 'Merged & archived',             9,  'asserted', 1, 0 FROM boards b
UNION ALL
SELECT 'stage-' || b.id || '-10', b.id, 'Won''t do',            'oklch(0.55 0.02 30)',  'Decided not to pursue',         10, 'asserted', 1, 1 FROM boards b
UNION ALL
SELECT 'stage-' || b.id || '-11', b.id, 'Archived',             'oklch(0.50 0.01 0)',   'Parked / cleaned up',           11, 'asserted', 1, 1 FROM boards b;
