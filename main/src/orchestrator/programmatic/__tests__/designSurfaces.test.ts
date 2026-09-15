/**
 * Unit tests for composeDesignSurfaces — the `# Design surfaces` block threaded
 * into a sprint/ship run's step prompts.
 *
 * Exercised against a REAL in-memory sqlite built from the repo's own migration
 * files, because the whole function is a lineage walk (batch → tasks → epic →
 * idea → approved design) and a mocked DB would only prove the mock. The
 * behaviours that matter are the ones that decide whether a builder ever sees the
 * design: both lineage paths resolve, an idea with no design contributes nothing,
 * and any read failure degrades to `undefined` rather than failing the step.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { composeDesignSurfaces } from '../designSurfaces';
import type { DatabaseLike } from '../../types';

const MIGRATIONS = join(__dirname, '..', '..', '..', 'database', 'migrations');

function applyMigration(db: Database.Database, file: string): void {
  db.exec(readFileSync(join(MIGRATIONS, file), 'utf-8'));
}

let db: Database.Database;

function buildDb(): Database.Database {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  d.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('P', '/tmp/p');
  applyMigration(d, '006_cyboflow_schema.sql'); // workflows + workflow_runs
  applyMigration(d, '011_workflow_step_tracking.sql');
  applyMigration(d, '014_native_tasks.sql');
  applyMigration(d, '015_entity_model_rebuild.sql'); // ideas / epics / tasks
  applyMigration(d, '022_sprint_batches.sql'); // sprint_batch_tasks + runs.batch_id
  // 082 ALTERs `sessions` and `artifacts`, which this test does not otherwise
  // need — the same minimal stand-ins migration082.test.ts uses (ADD COLUMN only
  // cares that the table exists).
  d.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, atype TEXT NOT NULL, label TEXT NOT NULL);
  `);
  applyMigration(d, '082_design_mode_v0.sql'); // approved_designs
  applyMigration(d, '134_approved_designs_flow_source.sql'); // source / source_run_id

  d.prepare(
    "INSERT INTO workflows (id, project_id, name) VALUES ('wf1', 1, 'sprint')",
  ).run();
  d.prepare(
    "INSERT INTO workflow_runs (id, workflow_id, project_id, status, batch_id) VALUES ('run1', 'wf1', 1, 'running', 'batch1')",
  ).run();
  // The board columns are NOT NULL on every entity; nothing here reads them.
  d.prepare(
    "INSERT INTO boards (id, project_id, name) VALUES ('b1', 1, 'Board')",
  ).run();
  d.prepare(
    `INSERT INTO board_stages (id, board_id, label, color_oklch, position, write_policy)
     VALUES ('s1', 'b1', 'Backlog', 'oklch(0 0 0)', 0, 'asserted')`,
  ).run();
  return d;
}

function addIdea(id: string, ref: string, title: string, body: string | null): void {
  db.prepare(
    'INSERT INTO ideas (id, project_id, ref, title, body, board_id, stage_id) VALUES (?, 1, ?, ?, ?, ?, ?)',
  ).run(id, ref, title, body, 'b1', 's1');
}

function addEpic(id: string, ref: string, ideaId: string | null): void {
  db.prepare(
    'INSERT INTO epics (id, project_id, ref, title, board_id, stage_id, originating_idea_id) VALUES (?, 1, ?, ?, ?, ?, ?)',
  ).run(id, ref, `Epic ${ref}`, 'b1', 's1', ideaId);
}

function addTask(id: string, ref: string, opts: { ideaId?: string; epicId?: string } = {}): void {
  db.prepare(
    'INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id, originating_idea_id, parent_epic_id) VALUES (?, 1, ?, ?, ?, ?, ?, ?)',
  ).run(id, ref, `Task ${ref}`, 'b1', 's1', opts.ideaId ?? null, opts.epicId ?? null);
  db.prepare("INSERT INTO sprint_batch_tasks (batch_id, task_id) VALUES ('batch1', ?)").run(id);
}

function approveDesign(
  ideaId: string,
  snapshotPath: string,
  opts: { source?: string; approvedAt?: string } = {},
): void {
  db.prepare(
    `INSERT INTO approved_designs
       (id, idea_id, project_id, handoff_id, session_id, draft_revision,
        prototype_artifact_id, prototype_revision, snapshot_path, approved_at, source, source_run_id)
     VALUES (?, ?, 1, NULL, NULL, 0, 'art1', 1, ?, ?, ?, 'run0')`,
  ).run(
    `ad_${ideaId}`,
    ideaId,
    snapshotPath,
    opts.approvedAt ?? '2026-09-15 10:00:00',
    opts.source ?? 'flow',
  );
}

const SPEC = '## Design spec\n\nSpend screen. Reached from Home → Spend.\nCopy: "Add entry".';

beforeEach(() => {
  db = buildDb();
});
afterEach(() => {
  db.close();
});

describe('composeDesignSurfaces', () => {
  it('renders an idea reached through its own lineage, with snapshot, provenance and spec', () => {
    addIdea('idea1', 'IDEA-004', 'Spend flow', `Body.\n\n${SPEC}`);
    approveDesign('idea1', '/snap/idea1/flow-run0.html');
    addTask('t1', 'TASK-031', { ideaId: 'idea1' });
    addTask('t2', 'TASK-032', { ideaId: 'idea1' });

    const out = composeDesignSurfaces(db as unknown as DatabaseLike, 'run1');
    expect(out).toBeDefined();
    expect(out).toContain('# Design surfaces');
    expect(out).toContain('## IDEA-004 · Spend flow');
    // Both of this idea's batch tasks are named, so a lane can tell whether the
    // block is about its own work.
    expect(out).toContain('(tasks: TASK-031, TASK-032)');
    expect(out).toContain('Approved design snapshot: /snap/idea1/flow-run0.html');
    expect(out).toContain('approved 2026-09-15 10:00:00');
    expect(out).toContain('source: flow');
    expect(out).toContain('Reached from Home → Spend');
    // The contract the whole section exists to state.
    expect(out).toContain('reachable from');
    expect(out).toContain('placeholder');
  });

  it('resolves an idea through the task → epic → idea chain when the task has no direct lineage', () => {
    addIdea('idea2', 'IDEA-009', 'Reports', 'Body.');
    approveDesign('idea2', '/snap/idea2/flow-run0.html');
    addEpic('epic1', 'EPIC-002', 'idea2');
    addTask('t3', 'TASK-040', { epicId: 'epic1' });

    const out = composeDesignSurfaces(db as unknown as DatabaseLike, 'run1');
    expect(out).toContain('## IDEA-009 · Reports');
    expect(out).toContain('(tasks: TASK-040)');
    expect(out).toContain('/snap/idea2/flow-run0.html');
  });

  it('includes an idea with only a Design spec, and omits one with neither design nor spec', () => {
    // Spec but no approved design: still the design contract a builder must match.
    addIdea('idea3', 'IDEA-010', 'Settings', `Body.\n\n${SPEC}`);
    addTask('t4', 'TASK-050', { ideaId: 'idea3' });
    // Neither: contributes nothing rather than an empty heading.
    addIdea('idea4', 'IDEA-011', 'Plumbing', 'Body with no design at all.');
    addTask('t5', 'TASK-051', { ideaId: 'idea4' });

    const out = composeDesignSurfaces(db as unknown as DatabaseLike, 'run1');
    expect(out).toContain('## IDEA-010 · Settings');
    expect(out).toContain('Add entry');
    expect(out).not.toContain('Approved design snapshot');
    expect(out).not.toContain('IDEA-011');
  });

  it('returns undefined when the run has no batch, no traceable idea, or no qualifying design', () => {
    // No batch at all (a planner/launch run).
    db.prepare("UPDATE workflow_runs SET batch_id = NULL WHERE id = 'run1'").run();
    addIdea('idea5', 'IDEA-012', 'X', `Body.\n\n${SPEC}`);
    addTask('t6', 'TASK-060', { ideaId: 'idea5' });
    expect(composeDesignSurfaces(db as unknown as DatabaseLike, 'run1')).toBeUndefined();

    // Batch restored, but every task is lineage-less.
    db.prepare("UPDATE workflow_runs SET batch_id = 'batch1' WHERE id = 'run1'").run();
    db.prepare("UPDATE tasks SET originating_idea_id = NULL WHERE id = 't6'").run();
    expect(composeDesignSurfaces(db as unknown as DatabaseLike, 'run1')).toBeUndefined();

    // Lineage restored, but the idea carries no design of any kind.
    db.prepare("UPDATE tasks SET originating_idea_id = 'idea5' WHERE id = 't6'").run();
    db.prepare("UPDATE ideas SET body = 'nothing here' WHERE id = 'idea5'").run();
    expect(composeDesignSurfaces(db as unknown as DatabaseLike, 'run1')).toBeUndefined();
  });

  it('prefers the CURRENT approved design and ignores a superseded one', () => {
    addIdea('idea6', 'IDEA-013', 'Feed', 'Body.');
    approveDesign('idea6', '/snap/idea6/old.html');
    db.prepare(
      "UPDATE approved_designs SET superseded_at = '2026-09-16 09:00:00' WHERE idea_id = 'idea6'",
    ).run();
    db.prepare(
      `INSERT INTO approved_designs
         (id, idea_id, project_id, handoff_id, session_id, draft_revision,
          prototype_artifact_id, prototype_revision, snapshot_path, approved_at, source, source_run_id)
       VALUES ('ad_new', 'idea6', 1, NULL, NULL, 0, 'art2', 2, '/snap/idea6/new.html', '2026-09-16 10:00:00', 'design-mode', NULL)`,
    ).run();
    addTask('t7', 'TASK-070', { ideaId: 'idea6' });

    const out = composeDesignSurfaces(db as unknown as DatabaseLike, 'run1');
    expect(out).toContain('/snap/idea6/new.html');
    expect(out).toContain('source: design-mode');
    expect(out).not.toContain('/snap/idea6/old.html');
  });

  it('degrades to undefined rather than throwing when a read fails', () => {
    // A pre-022 database: the batch table the walk starts from does not exist.
    // Losing an enrichment must never fail the step that renders it.
    const bare = new Database(':memory:');
    try {
      expect(composeDesignSurfaces(bare as unknown as DatabaseLike, 'run1')).toBeUndefined();
    } finally {
      bare.close();
    }
  });
});
