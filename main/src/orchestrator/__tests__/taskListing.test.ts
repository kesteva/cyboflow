/**
 * Unit tests for taskListing — the 3-table UNION read-side projection.
 *
 * Proves selectProjectBacklog / selectTaskById merge ideas/epics/tasks into one
 * BacklogTaskItem[] with the synthesized `type`, the markdown `body`, the
 * lineage fields (parent_epic_id / originating_idea_id), and the idea-only
 * `scope` — with epics nesting their child tasks.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectProjectBacklog, selectTaskById, boardsForProject } from '../taskListing';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';

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
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');

  const migDir = join(__dirname, '..', '..', 'database', 'migrations');
  db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
  return db;
}

function stageId(position: number): string {
  return `stage-board-1-default-${position}`;
}

/** Seed one idea (large), one epic (from idea), one child task (under epic, from idea). */
function seedFixture(db: Database.Database): { ideaId: string; epicId: string; taskId: string } {
  const ideaId = 'ide_1';
  const epicId = 'epc_1';
  const taskId = 'tsk_1';
  db.prepare(
    `INSERT INTO ideas (id, project_id, ref, title, summary, body, scope, board_id, stage_id, created_at)
     VALUES (?, 1, 'IDEA-001', 'My idea', 'idea summary', '# idea body', 'large', 'board-1-default', ?, '2026-01-01T00:00:00.000Z')`,
  ).run(ideaId, stageId(3));
  db.prepare(
    `INSERT INTO epics (id, project_id, ref, title, body, board_id, stage_id, originating_idea_id, created_at)
     VALUES (?, 1, 'EPIC-001', 'My epic', 'epic body', 'board-1-default', ?, ?, '2026-01-01T00:00:01.000Z')`,
  ).run(epicId, stageId(4), ideaId);
  db.prepare(
    `INSERT INTO tasks (id, project_id, ref, title, body, board_id, stage_id, parent_epic_id, originating_idea_id, created_at)
     VALUES (?, 1, 'TASK-001', 'My task', 'task body', 'board-1-default', ?, ?, ?, '2026-01-01T00:00:02.000Z')`,
  ).run(taskId, stageId(5), epicId, ideaId);
  return { ideaId, epicId, taskId };
}

describe('taskListing — 3-table UNION', () => {
  it('selectProjectBacklog merges ideas/epics/tasks with body/scope/lineage; epic nests its child task', () => {
    const db = buildDb();
    const { ideaId, epicId, taskId } = seedFixture(db);

    const backlog = selectProjectBacklog(dbAdapter(db), 1);

    // Top level: idea + epic (the task nests under the epic).
    const topRefs = backlog.map((t) => t.ref).sort();
    expect(topRefs).toEqual(['EPIC-001', 'IDEA-001']);

    const idea = backlog.find((t) => t.id === ideaId)!;
    expect(idea.type).toBe('idea');
    expect(idea.body).toBe('# idea body');
    expect(idea.scope).toBe('large');
    expect(idea.originating_idea_id).toBeNull();
    expect(idea.parent_epic_id).toBeNull();

    const epic = backlog.find((t) => t.id === epicId)!;
    expect(epic.type).toBe('epic');
    expect(epic.body).toBe('epic body');
    expect(epic.scope).toBeNull();
    expect(epic.originating_idea_id).toBe(ideaId);
    expect(epic.childCount).toBe(1);
    expect(epic.pendingTasks).toBe(1);

    const child = epic.children![0];
    expect(child.id).toBe(taskId);
    expect(child.type).toBe('task');
    expect(child.body).toBe('task body');
    expect(child.parent_epic_id).toBe(epicId);
    expect(child.originating_idea_id).toBe(ideaId);
  });

  it('selectTaskById resolves an entity from any of the three tables', () => {
    const db = buildDb();
    const { ideaId, epicId, taskId } = seedFixture(db);

    expect(selectTaskById(dbAdapter(db), ideaId)?.type).toBe('idea');
    expect(selectTaskById(dbAdapter(db), epicId)?.type).toBe('epic');
    expect(selectTaskById(dbAdapter(db), taskId)?.type).toBe('task');
    expect(selectTaskById(dbAdapter(db), 'missing')).toBeNull();

    // An epic fetched directly nests its children.
    const epic = selectTaskById(dbAdapter(db), epicId)!;
    expect(epic.children).toHaveLength(1);
    expect(epic.children![0].id).toBe(taskId);
  });

  it('boardsForProject returns the 12-stage board incl Decomposed', () => {
    const db = buildDb();
    const boards = boardsForProject(dbAdapter(db), 1);
    expect(boards).toHaveLength(1);
    expect(boards[0].stages).toHaveLength(12);
    const decomposed = boards[0].stages.find((s) => s.position === 12)!;
    expect(decomposed.label).toBe('Decomposed');
    expect(decomposed.is_terminal).toBe(true);
    expect(decomposed.hidden_by_default).toBe(false);
  });
});
