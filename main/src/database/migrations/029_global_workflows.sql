-- Migration 029: Global built-in workflows + re-point run history.
--
-- Until now the standard flows (planner/sprint/compound) were seeded ONCE PER
-- PROJECT (`wf-<projectId>-<name>` rows minted by the old per-project
-- reconcileBuiltIns). The gallery therefore showed 3×{planner,sprint,compound}
-- instead of one shared set. This migration makes the built-ins GLOBAL — one
-- `wf-global-<name>` row each, `project_id NULL` — while keeping project scope
-- available as an explicit choice (a NON-NULL project_id row).
--
-- Scope encoding (the contract every later phase binds to): `workflows.project_id`
-- is NULLABLE — NULL ⇒ GLOBAL, an integer ⇒ project-scoped. There is no separate
-- column.
--
-- The work, in strict order (re-point history BEFORE any delete so no run loses
-- its workflow link):
--   1. Rebuild `workflows` to make project_id NULLABLE and add the missing
--      `FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE`
--      (closes a known gap; NULL is allowed by an FK).
--   2. Create one global row per built-in (`wf-global-<name>`, project_id NULL,
--      spec_json '{}'), sourcing workflow_path/permission_mode from any existing
--      per-project built-in row (they are uniform across projects).
--   3. Re-point history: every workflow_runs / workflow_revisions row that points
--      at an UNEDITED per-project built-in (the rows step 4 deletes) is re-pointed
--      to the matching global id. This runs BEFORE the delete in step 4, so the
--      FK-cascade can never orphan or delete a run's history. History attached to
--      an EDITED per-project built-in (preserved in step 4) stays pointing at that
--      preserved row.
--   4. Delete the now-redundant per-project built-in rows that were NEVER edited
--      (spec_json='{}'). EDITED ones (non-empty spec_json) are KEPT — they remain
--      project-scoped flows (the user's "project copy"), disambiguated in the UI
--      by the project chip. No user data is renamed.
--
-- FK-cascade safety: `workflow_runs.workflow_id` and `workflow_revisions.workflow_id`
-- both reference `workflows(id) ON DELETE CASCADE`. Both the table rebuild (DROP
-- workflows) AND the per-project-row delete in step 4 would cascade-delete those
-- child rows if FKs were live. We toggle `PRAGMA foreign_keys=OFF` for the whole
-- migration so the DROP/RENAME in step 1 preserves child rows, and we explicitly
-- re-point (step 3) before the delete (step 4). The runner at database.ts detects
-- foreign_keys=OFF and manages the restore.
--
-- NOTE: No explicit BEGIN/COMMIT here — runFileBasedMigrations() in database.ts
-- wraps every file in a this.transaction(...) call, so an inner BEGIN would nest.
-- The PRAGMA toggles are applied OUTSIDE that transaction by the runner.
--
-- Idempotency: step 1's DROP/RENAME is a one-shot (a second exec finds no
-- workflows_new and reproduces the identical shape); steps 2/4 use
-- INSERT OR IGNORE / a self-narrowing DELETE; the production runner gates the
-- whole file to a single application via the user_preferences ledger anyway.

PRAGMA foreign_keys=OFF;

-- ---------------------------------------------------------------------------
-- 1. Rebuild `workflows` with NULLABLE project_id + the projects FK.
--    Mirrors the table-rebuild recipe of migrations 010 and 020: create _new,
--    INSERT ... SELECT every column in order, DROP old, RENAME, recreate the
--    one index that existed on workflows (idx_workflows_project_id, day-1 / 006).
--    Column set is the authoritative 7-column shape from migration 006.
-- ---------------------------------------------------------------------------
CREATE TABLE workflows_new (
  id TEXT PRIMARY KEY,
  project_id INTEGER,                       -- NULLABLE: NULL ⇒ global, integer ⇒ project-scoped
  name TEXT NOT NULL,
  spec_json TEXT NOT NULL DEFAULT '{}',
  workflow_path TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'default',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

INSERT INTO workflows_new (
  id, project_id, name, spec_json, workflow_path, permission_mode, created_at
)
SELECT
  id, project_id, name, spec_json, workflow_path, permission_mode, created_at
FROM workflows;

DROP TABLE workflows;
ALTER TABLE workflows_new RENAME TO workflows;

-- Recreate the only index that existed on workflows (006 day-1).
CREATE INDEX IF NOT EXISTS idx_workflows_project_id ON workflows(project_id);

-- ---------------------------------------------------------------------------
-- 2. Create one GLOBAL row per built-in: id = 'wf-global-'||name, project_id
--    NULL, spec_json '{}'. workflow_path/permission_mode are sourced from any
--    existing per-project built-in row (uniform across projects — GROUP BY name
--    collapses them to one). INSERT OR IGNORE so a re-apply (or a DB that already
--    has the global rows) is a no-op. Uses the SQLite `||` concat operator.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO workflows (id, project_id, name, workflow_path, permission_mode, spec_json)
SELECT 'wf-global-' || name, NULL, name, workflow_path, permission_mode, '{}'
FROM (
  SELECT name, workflow_path, permission_mode
  FROM workflows
  WHERE name IN ('planner', 'sprint', 'compound')
  GROUP BY name
);

-- ---------------------------------------------------------------------------
-- 3. Re-point history to the global rows, BEFORE any delete. For every
--    workflow_runs / workflow_revisions row whose workflow_id points at a
--    PER-PROJECT built-in that step 4 is about to DELETE (project_id IS NOT
--    NULL, name in planner/sprint/compound, AND spec_json='{}' — i.e. the
--    UNEDITED rows), set workflow_id = 'wf-global-'||<that row's name>. A
--    correlated subquery resolves the name (portable SQLite; avoids
--    UPDATE...FROM).
--
--    The `spec_json='{}'` predicate is what keeps the re-point set EXACTLY the
--    delete set of step 4: history attached to an EDITED per-project built-in
--    (preserved as a project-scoped flow in step 4) stays pointing at that
--    preserved row — so the edited flow keeps its own run/revision history. The
--    WHERE clause also leaves global rows, customs, and the __quick__ sentinel
--    untouched.
-- ---------------------------------------------------------------------------
UPDATE workflow_runs
SET workflow_id = 'wf-global-' || (
  SELECT w.name FROM workflows w WHERE w.id = workflow_runs.workflow_id
)
WHERE workflow_id IN (
  SELECT w.id FROM workflows w
  WHERE w.project_id IS NOT NULL
    AND w.name IN ('planner', 'sprint', 'compound')
    AND w.spec_json = '{}'
);

UPDATE workflow_revisions
SET workflow_id = 'wf-global-' || (
  SELECT w.name FROM workflows w WHERE w.id = workflow_revisions.workflow_id
)
WHERE workflow_id IN (
  SELECT w.id FROM workflows w
  WHERE w.project_id IS NOT NULL
    AND w.name IN ('planner', 'sprint', 'compound')
    AND w.spec_json = '{}'
);

-- ---------------------------------------------------------------------------
-- 4. Delete the now-unreferenced per-project built-in rows that were NEVER
--    edited (spec_json='{}'). History was re-pointed in step 3, so nothing is
--    orphaned. EDITED rows (non-empty spec_json) are KEPT — they survive as
--    project-scoped flows (the user's "project copy"), shown alongside the
--    global one and disambiguated by the project chip.
-- ---------------------------------------------------------------------------
DELETE FROM workflows
WHERE name IN ('planner', 'sprint', 'compound')
  AND project_id IS NOT NULL
  AND spec_json = '{}';

PRAGMA foreign_keys=ON;
