/**
 * Integration tests for migration 030_global_workflows.sql.
 *
 * Migration 030 makes the standard flows (planner/sprint/compound) GLOBAL —
 * collapsing the old per-project `wf-<projectId>-<name>` rows to a single
 * `wf-global-<name>` row each (project_id NULL) — while re-pointing all run +
 * revision history to the global ids BEFORE deleting the redundant per-project
 * rows, so no history is orphaned. Edited per-project built-ins (non-empty
 * spec_json) are preserved as project-scoped flows. The `workflows.project_id`
 * column becomes NULLABLE with a projects FK ON DELETE CASCADE.
 *
 * We build the pre-030 shape from the real .sql files: a minimal `projects`
 * table, then 006 (workflows + workflow_runs), then the workflow_revisions DDL
 * from 026 applied inline (mirrors migration020.test.ts inlining only the columns
 * it needs — the rest of 026 / run_usage is irrelevant here). We then read +
 * apply the real 030 SQL via the production path so this proves the file itself
 * is correct (not a hand-copied inline string).
 *
 * Targets:
 *   (a) one `wf-global-<name>` row per built-in exists with project_id NULL.
 *   (b) workflow_runs + workflow_revisions are re-pointed to the global ids
 *       (no orphaned / lost history).
 *   (c) unedited per-project built-in rows (spec_json='{}') are gone.
 *   (d) an edited per-project built-in (non-empty spec_json) is preserved,
 *       still project-scoped.
 *   (e) workflows.project_id is nullable.
 *   (f) the projects FK on workflows exists.
 *   (g) the __quick__ sentinel + customs are untouched.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

/**
 * Apply a migration SQL the way the production runner does: PRAGMA foreign_keys
 * toggles are no-ops inside a transaction (SQLite docs), so the table-rebuild
 * recipe needs the pragma toggled OUTSIDE the transaction wrapper. Mirrors
 * runFileBasedMigrations() in database.ts and migration010/020.test.ts.
 */
function runMigrationViaProductionPath(db: Database.Database, sql: string): void {
  const needsFkOff = sql.includes('PRAGMA foreign_keys=OFF');
  if (needsFkOff) db.pragma('foreign_keys = OFF');
  try {
    const txn = db.transaction(() => {
      db.exec(sql);
    });
    txn();
  } finally {
    if (needsFkOff) db.pragma('foreign_keys = ON');
  }
}

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

interface FkRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

/**
 * Build the pre-030 DB: projects + the 006 workflows/workflow_runs tables + the
 * 026 workflow_revisions table, then seed per-project built-ins, runs, and
 * revisions pointing at them.
 *
 * Seeds (across two projects):
 *   - wf-1-planner / wf-1-sprint / wf-1-compound (spec_json '{}', UNEDITED)
 *   - wf-2-planner (spec_json '{}', UNEDITED)
 *   - wf-2-sprint  (NON-EMPTY spec_json — EDITED, must be preserved)
 *   - wf-1-custom-aaaa (a project custom — untouched)
 *   - wf-1-__quick__ (sentinel — untouched)
 * plus workflow_runs + workflow_revisions pointing at several of these.
 */
function buildPre030Db(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj One', '/tmp/p1');
  db.prepare('INSERT INTO projects (id, name, path) VALUES (2, ?, ?)').run('Proj Two', '/tmp/p2');

  // 006: workflows + workflow_runs (+ the rest of the orchestrator schema).
  db.exec(readMigration('006_cyboflow_schema.sql'));

  // 026's workflow_revisions DDL, applied inline (the run_usage / spec_hash /
  // index parts of 026 are irrelevant to 030's re-point).
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_revisions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL,
      spec_hash   TEXT NOT NULL,
      spec_json   TEXT NOT NULL,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (workflow_id, spec_hash),
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
    );
  `);

  // Per-project built-ins (the rows the old reconcileBuiltIns minted).
  const insWf = db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json, workflow_path, permission_mode)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insWf.run('wf-1-planner', 1, 'planner', '{}', '/wf/planner.md', 'default');
  insWf.run('wf-1-sprint', 1, 'sprint', '{}', '/wf/sprint.md', 'acceptEdits');
  insWf.run('wf-1-compound', 1, 'compound', '{}', '/wf/compound.md', 'default');
  insWf.run('wf-2-planner', 2, 'planner', '{}', '/wf/planner.md', 'default');
  // EDITED per-project built-in — non-empty spec_json, must survive.
  insWf.run('wf-2-sprint', 2, 'sprint', '{"id":"sprint","phases":[]}', '/wf/sprint.md', 'dontAsk');
  // A project custom + the quick sentinel — both untouched by 030.
  insWf.run('wf-1-custom-aaaa', 1, 'My Custom', '{"id":"x","phases":[]}', null, 'default');
  insWf.run('wf-1-__quick__', 1, '__quick__', '{}', null, 'default');

  // Runs pointing at the per-project built-ins (workflow_runs.project_id is its
  // OWN NOT-NULL column — runs keep their project even when the workflow goes
  // global).
  const insRun = db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES (?, ?, ?, ?, 'default')`,
  );
  insRun.run('wr-1-planner', 'wf-1-planner', 1, 'completed');
  insRun.run('wr-1-sprint', 'wf-1-sprint', 1, 'completed');
  insRun.run('wr-2-planner', 'wf-2-planner', 2, 'completed');
  insRun.run('wr-2-sprint-edited', 'wf-2-sprint', 2, 'completed');
  insRun.run('wr-1-custom', 'wf-1-custom-aaaa', 1, 'completed');

  // Revisions pointing at the per-project built-ins.
  const insRev = db.prepare(
    `INSERT INTO workflow_revisions (workflow_id, spec_hash, spec_json) VALUES (?, ?, ?)`,
  );
  insRev.run('wf-1-planner', 'hash-1-planner', '{"id":"planner","phases":[]}');
  insRev.run('wf-2-sprint', 'hash-2-sprint', '{"id":"sprint","phases":[]}');

  return db;
}

function applyMigration030(db: Database.Database): void {
  runMigrationViaProductionPath(db, readMigration('030_global_workflows.sql'));
}

describe('Migration 030: global built-in workflows + re-point run history', () => {
  it('(a) creates exactly one wf-global-<name> row per built-in with project_id NULL', () => {
    const db = buildPre030Db();
    applyMigration030(db);

    for (const name of ['planner', 'sprint', 'compound']) {
      const rows = db
        .prepare('SELECT id, project_id FROM workflows WHERE id = ?')
        .all(`wf-global-${name}`) as Array<{ id: string; project_id: number | null }>;
      expect(rows, `expected one wf-global-${name} row`).toHaveLength(1);
      expect(rows[0].project_id, `wf-global-${name} must be global (NULL project_id)`).toBeNull();
    }

    db.close();
  });

  it('(a) sources workflow_path / permission_mode from the per-project rows', () => {
    const db = buildPre030Db();
    applyMigration030(db);

    const sprint = db
      .prepare('SELECT workflow_path, permission_mode, spec_json FROM workflows WHERE id = ?')
      .get('wf-global-sprint') as {
      workflow_path: string | null;
      permission_mode: string;
      spec_json: string;
    };
    expect(sprint.workflow_path).toBe('/wf/sprint.md');
    expect(sprint.permission_mode).toBe('acceptEdits');
    // The global row always starts at the built-in default spec.
    expect(sprint.spec_json).toBe('{}');

    db.close();
  });

  it('(b) re-points workflow_runs to the global ids without losing any history', () => {
    const db = buildPre030Db();
    const before = (db.prepare('SELECT COUNT(*) AS n FROM workflow_runs').get() as { n: number }).n;

    applyMigration030(db);

    // No run lost.
    const after = (db.prepare('SELECT COUNT(*) AS n FROM workflow_runs').get() as { n: number }).n;
    expect(after).toBe(before);

    // Unedited per-project built-in runs re-pointed to the global ids, project_id kept.
    const planner1 = db
      .prepare('SELECT workflow_id, project_id FROM workflow_runs WHERE id = ?')
      .get('wr-1-planner') as { workflow_id: string; project_id: number };
    expect(planner1.workflow_id).toBe('wf-global-planner');
    expect(planner1.project_id).toBe(1);

    const sprint1 = db
      .prepare('SELECT workflow_id FROM workflow_runs WHERE id = ?')
      .get('wr-1-sprint') as { workflow_id: string };
    expect(sprint1.workflow_id).toBe('wf-global-sprint');

    const planner2 = db
      .prepare('SELECT workflow_id, project_id FROM workflow_runs WHERE id = ?')
      .get('wr-2-planner') as { workflow_id: string; project_id: number };
    expect(planner2.workflow_id).toBe('wf-global-planner');
    expect(planner2.project_id).toBe(2);

    // The EDITED per-project sprint row is preserved → its run still points at it.
    const sprintEdited = db
      .prepare('SELECT workflow_id FROM workflow_runs WHERE id = ?')
      .get('wr-2-sprint-edited') as { workflow_id: string };
    expect(sprintEdited.workflow_id).toBe('wf-2-sprint');

    // No orphaned workflow_id — every run points at an existing workflows row.
    const orphans = db
      .prepare(
        `SELECT COUNT(*) AS n FROM workflow_runs r
         WHERE NOT EXISTS (SELECT 1 FROM workflows w WHERE w.id = r.workflow_id)`,
      )
      .get() as { n: number };
    expect(orphans.n).toBe(0);

    db.close();
  });

  it('(b) re-points workflow_revisions to the global ids without losing history', () => {
    const db = buildPre030Db();
    const before = (
      db.prepare('SELECT COUNT(*) AS n FROM workflow_revisions').get() as { n: number }
    ).n;

    applyMigration030(db);

    const after = (
      db.prepare('SELECT COUNT(*) AS n FROM workflow_revisions').get() as { n: number }
    ).n;
    expect(after).toBe(before);

    // Unedited planner revision → re-pointed to the global id.
    const plannerRev = db
      .prepare('SELECT workflow_id FROM workflow_revisions WHERE spec_hash = ?')
      .get('hash-1-planner') as { workflow_id: string };
    expect(plannerRev.workflow_id).toBe('wf-global-planner');

    // The edited sprint revision stays on the preserved project-scoped row.
    const sprintRev = db
      .prepare('SELECT workflow_id FROM workflow_revisions WHERE spec_hash = ?')
      .get('hash-2-sprint') as { workflow_id: string };
    expect(sprintRev.workflow_id).toBe('wf-2-sprint');

    // No orphaned revision workflow_id.
    const orphans = db
      .prepare(
        `SELECT COUNT(*) AS n FROM workflow_revisions rev
         WHERE NOT EXISTS (SELECT 1 FROM workflows w WHERE w.id = rev.workflow_id)`,
      )
      .get() as { n: number };
    expect(orphans.n).toBe(0);

    db.close();
  });

  it('(c) deletes the unedited per-project built-in rows', () => {
    const db = buildPre030Db();
    applyMigration030(db);

    for (const id of ['wf-1-planner', 'wf-1-sprint', 'wf-1-compound', 'wf-2-planner']) {
      const row = db.prepare('SELECT id FROM workflows WHERE id = ?').get(id);
      expect(row, `expected unedited per-project built-in ${id} to be deleted`).toBeUndefined();
    }

    db.close();
  });

  it('(d) preserves an edited per-project built-in as a project-scoped flow', () => {
    const db = buildPre030Db();
    applyMigration030(db);

    const edited = db
      .prepare('SELECT id, project_id, name, spec_json FROM workflows WHERE id = ?')
      .get('wf-2-sprint') as
      | { id: string; project_id: number | null; name: string; spec_json: string }
      | undefined;
    expect(edited, 'edited per-project built-in must be preserved').toBeDefined();
    expect(edited?.project_id).toBe(2);
    expect(edited?.name).toBe('sprint');
    expect(edited?.spec_json).toBe('{"id":"sprint","phases":[]}');

    db.close();
  });

  it('(e) makes workflows.project_id nullable', () => {
    const db = buildPre030Db();
    applyMigration030(db);

    const cols = db.prepare('PRAGMA table_info(workflows)').all() as TableInfoRow[];
    const projectId = cols.find((c) => c.name === 'project_id');
    expect(projectId, 'project_id column must exist').toBeDefined();
    // notnull = 0 means the column is nullable.
    expect(projectId?.notnull).toBe(0);

    // And a NULL project_id row actually inserts (the global rows already prove
    // this, but assert directly against the live constraint).
    expect(() =>
      db
        .prepare(
          `INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-global-custom-deadbeef', NULL, 'New Global', '{"id":"g","phases":[]}')`,
        )
        .run(),
    ).not.toThrow();

    db.close();
  });

  it('(f) adds the projects FK on workflows (ON DELETE CASCADE)', () => {
    const db = buildPre030Db();
    applyMigration030(db);

    const fks = db.prepare('PRAGMA foreign_key_list(workflows)').all() as FkRow[];
    const projectsFk = fks.find((fk) => fk.table === 'projects');
    expect(projectsFk, 'workflows must have an FK to projects').toBeDefined();
    expect(projectsFk?.from).toBe('project_id');
    expect(projectsFk?.to).toBe('id');
    expect(projectsFk?.on_delete).toBe('CASCADE');

    db.close();
  });

  it('(f) the projects FK cascades: deleting a project drops its project-scoped flows but not globals', () => {
    const db = buildPre030Db();
    applyMigration030(db);
    db.pragma('foreign_keys = ON');

    // Delete project 2 → its preserved edited sprint flow cascades away.
    db.prepare('DELETE FROM projects WHERE id = 2').run();

    expect(db.prepare('SELECT id FROM workflows WHERE id = ?').get('wf-2-sprint')).toBeUndefined();
    // Globals (project_id NULL) survive a project delete.
    expect(
      db.prepare('SELECT id FROM workflows WHERE id = ?').get('wf-global-sprint'),
    ).toBeDefined();

    db.close();
  });

  it('(g) leaves the __quick__ sentinel and project customs untouched', () => {
    const db = buildPre030Db();
    applyMigration030(db);

    const quick = db
      .prepare('SELECT id, project_id, name FROM workflows WHERE id = ?')
      .get('wf-1-__quick__') as { id: string; project_id: number | null; name: string } | undefined;
    expect(quick).toBeDefined();
    expect(quick?.project_id).toBe(1);
    expect(quick?.name).toBe('__quick__');

    const custom = db
      .prepare('SELECT id, project_id FROM workflows WHERE id = ?')
      .get('wf-1-custom-aaaa') as { id: string; project_id: number | null } | undefined;
    expect(custom).toBeDefined();
    expect(custom?.project_id).toBe(1);

    // The custom's run still points at it (custom workflow_id not re-pointed).
    const customRun = db
      .prepare('SELECT workflow_id FROM workflow_runs WHERE id = ?')
      .get('wr-1-custom') as { workflow_id: string };
    expect(customRun.workflow_id).toBe('wf-1-custom-aaaa');

    db.close();
  });

  it('preserves the idx_workflows_project_id index across the rebuild', () => {
    const db = buildPre030Db();
    applyMigration030(db);

    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='workflows'")
      .all() as Array<{ name: string }>;
    expect(idx.map((r) => r.name)).toContain('idx_workflows_project_id');

    // No leftover scratch table.
    const scratch = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workflows_new'")
      .get();
    expect(scratch).toBeUndefined();

    db.close();
  });
});
