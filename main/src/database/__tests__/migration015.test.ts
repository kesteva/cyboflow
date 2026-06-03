/**
 * Migration 015_entity_model_rebuild.sql — schema + seed integration tests.
 *
 * Applies 006 -> 011 -> 014 -> 015 against an in-memory SQLite instance (with a
 * minimal `projects` table seeded first so the FKs + project-scoped seed have
 * something to attach to). Proves:
 *   1. The 3 entity tables (ideas/epics/tasks) + entity_events exist with the
 *      spec'd columns; the unified task_events table is gone.
 *   2. Lineage FKs are enforced: epics.originating_idea_id -> ideas(id),
 *      tasks.parent_epic_id -> epics(id), tasks.originating_idea_id -> ideas(id).
 *   3. The board now has EXACTLY 12 stages incl 'Decomposed' at position 12
 *      (asserted, terminal, NOT hidden).
 *   4. task_ref_counters is seeded per (project, entity_type) for idea/epic/task.
 *   5. The 4 task satellite tables are recreated FK->new tasks(id).
 *
 * Field-for-field row-shape parity lives in entitySchemaParity.test.ts.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface StageRow {
  id: string;
  board_id: string;
  position: number;
  write_policy: string;
  is_terminal: number;
  hidden_by_default: number;
  label: string;
}

function buildDb(): Database.Database {
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

  const migDir = join(__dirname, '..', 'migrations');
  db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
  return db;
}

/** Seed an idea + epic on board-1 so we can attach lineage children. */
function seedLineageRoots(db: Database.Database): { ideaId: string; epicId: string } {
  const ideaId = 'ide_root';
  const epicId = 'epc_root';
  db.prepare(
    `INSERT INTO ideas (id, project_id, ref, title, board_id, stage_id)
     VALUES (?, 1, 'IDEA-001', 'Root idea', 'board-1-default', 'stage-board-1-default-1')`,
  ).run(ideaId);
  db.prepare(
    `INSERT INTO epics (id, project_id, ref, title, board_id, stage_id, originating_idea_id)
     VALUES (?, 1, 'EPIC-001', 'Root epic', 'board-1-default', 'stage-board-1-default-4', ?)`,
  ).run(epicId, ideaId);
  return { ideaId, epicId };
}

describe('Migration 015: 3-table entity model', () => {
  it('creates ideas/epics/tasks + entity_events and drops task_events', () => {
    const db = buildDb();
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    for (const t of ['ideas', 'epics', 'tasks', 'entity_events']) {
      expect(names).toContain(t);
    }
    expect(names).not.toContain('task_events');
    db.close();
  });

  it('recreates the 4 task satellite tables FK->tasks(id)', () => {
    const db = buildDb();
    for (const sat of ['task_acceptance_criteria', 'task_dependencies', 'task_files', 'task_external_links']) {
      const fks = db.prepare(`PRAGMA foreign_key_list(${sat})`).all() as { table: string; from: string }[];
      const toTasks = fks.find((f) => f.table === 'tasks' && f.from === 'task_id');
      expect(toTasks, `${sat} should FK task_id -> tasks`).toBeDefined();
    }
    db.close();
  });

  it('seeds exactly 12 stages incl Decomposed (position 12, asserted, terminal, not hidden)', () => {
    const db = buildDb();

    const boards = db.prepare('SELECT id FROM boards ORDER BY project_id').all() as { id: string }[];
    expect(boards).toHaveLength(2);

    for (const board of boards) {
      const stages = db
        .prepare('SELECT * FROM board_stages WHERE board_id = ? ORDER BY position')
        .all(board.id) as StageRow[];
      expect(stages).toHaveLength(12);

      const decomposed = stages.find((s) => s.position === 12)!;
      expect(decomposed.id).toBe(`stage-${board.id}-12`);
      expect(decomposed.label).toBe('Decomposed');
      expect(decomposed.write_policy).toBe('asserted');
      expect(decomposed.is_terminal).toBe(1);
      expect(decomposed.hidden_by_default).toBe(0);

      // Positions 7 + 8 remain the only DERIVED stages.
      const derived = stages.filter((s) => s.write_policy === 'derived').map((s) => s.position);
      expect(derived.sort((a, b) => a - b)).toEqual([7, 8]);

      // Terminal stages: 9 (done), 10 (won't do), 11 (archived), 12 (decomposed).
      const terminal = stages.filter((s) => s.is_terminal === 1).map((s) => s.position);
      expect(terminal.sort((a, b) => a - b)).toEqual([9, 10, 11, 12]);
    }
    db.close();
  });

  it('enforces epics.originating_idea_id FK -> ideas(id)', () => {
    const db = buildDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO epics (id, project_id, ref, title, board_id, stage_id, originating_idea_id)
           VALUES ('epc_bad', 1, 'EPIC-099', 'Orphan epic', 'board-1-default', 'stage-board-1-default-4', 'ide_missing')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });

  it('enforces tasks.parent_epic_id FK -> epics(id) and originating_idea_id FK -> ideas(id)', () => {
    const db = buildDb();
    const { ideaId, epicId } = seedLineageRoots(db);

    // Bad parent epic -> rejected.
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id, parent_epic_id)
           VALUES ('tsk_bad1', 1, 'TASK-099', 'T', 'board-1-default', 'stage-board-1-default-5', 'epc_missing')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);

    // Bad originating idea -> rejected.
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id, originating_idea_id)
           VALUES ('tsk_bad2', 1, 'TASK-100', 'T', 'board-1-default', 'stage-board-1-default-5', 'ide_missing')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);

    // Valid lineage -> accepted.
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id, parent_epic_id, originating_idea_id)
           VALUES ('tsk_ok', 1, 'TASK-101', 'T', 'board-1-default', 'stage-board-1-default-5', ?, ?)`,
        )
        .run(epicId, ideaId),
    ).not.toThrow();
    db.close();
  });

  it('seeds task_ref_counters per (project, entity_type) for idea/epic/task', () => {
    const db = buildDb();
    for (const projectId of [1, 2]) {
      const counters = (
        db.prepare('SELECT type FROM task_ref_counters WHERE project_id = ? ORDER BY type').all(projectId) as {
          type: string;
        }[]
      ).map((r) => r.type);
      expect(counters).toEqual(['epic', 'idea', 'task']);
    }
    db.close();
  });

  it('is idempotent — re-applying 015 does not duplicate stages or counters', () => {
    const db = buildDb();
    const migDir = join(__dirname, '..', 'migrations');
    db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));

    const stageCount = (
      db.prepare('SELECT COUNT(*) AS n FROM board_stages WHERE board_id = ?').get('board-1-default') as { n: number }
    ).n;
    expect(stageCount).toBe(12);

    const counterCount = (
      db.prepare('SELECT COUNT(*) AS n FROM task_ref_counters WHERE project_id = 1').get() as { n: number }
    ).n;
    expect(counterCount).toBe(3);
    db.close();
  });
});
