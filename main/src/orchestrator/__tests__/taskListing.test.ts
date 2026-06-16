/**
 * Unit tests for taskListing — the 3-table UNION read-side projection.
 *
 * Proves selectProjectBacklog / selectTaskById merge ideas/epics/tasks into one
 * BacklogTaskItem[] with the synthesized `type`, the markdown `body`, the
 * lineage fields (parent_epic_id / originating_idea_id), and the idea-only
 * `scope` — with epics nesting their child tasks. Also pins the nullable
 * project scope (null = ALL projects), the LEFT-JOINed `stage_position`, and
 * the archive-in-place `archived_at` passthrough (archived rows are ALWAYS
 * returned — visibility is a client concern).
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
  // Two projects BEFORE the migrations so each gets its default board seeded
  // (the all-projects scope tests need two boards' worth of entities).
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');
  db.prepare('INSERT INTO projects (id, name, path) VALUES (2, ?, ?)').run('Proj Two', '/tmp/p2');

  const migDir = join(__dirname, '..', '..', 'database', 'migrations');
  db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '024_archive_in_place.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '028_idea_attachments.sql'), 'utf-8'));
  return db;
}

function stageId(position: number, projectId = 1): string {
  return `stage-board-${projectId}-default-${position}`;
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

/** Seed project 2 with one idea + one orphan task (on board-2-default). */
function seedSecondProject(db: Database.Database): { ideaId: string; taskId: string } {
  const ideaId = 'ide_p2';
  const taskId = 'tsk_p2';
  db.prepare(
    `INSERT INTO ideas (id, project_id, ref, title, body, board_id, stage_id, created_at)
     VALUES (?, 2, 'IDEA-101', 'P2 idea', 'p2 idea body', 'board-2-default', ?, '2026-01-02T00:00:00.000Z')`,
  ).run(ideaId, stageId(1, 2));
  db.prepare(
    `INSERT INTO tasks (id, project_id, ref, title, body, board_id, stage_id, created_at)
     VALUES (?, 2, 'TASK-101', 'P2 task', 'p2 task body', 'board-2-default', ?, '2026-01-02T00:00:01.000Z')`,
  ).run(taskId, stageId(6, 2));
  return { ideaId, taskId };
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

  it('selectProjectBacklog(null) merges entities from EVERY project into one list', () => {
    const db = buildDb();
    seedFixture(db);
    seedSecondProject(db);

    const all = selectProjectBacklog(dbAdapter(db), null);

    expect(new Set(all.map((t) => t.project_id))).toEqual(new Set([1, 2]));
    // P1 top level: idea + epic (task nested). P2 top level: idea + orphan task.
    expect(all.map((t) => t.ref).sort()).toEqual([
      'EPIC-001',
      'IDEA-001',
      'IDEA-101',
      'TASK-101',
    ]);
    // Nesting still applies inside the merged set.
    const epic = all.find((t) => t.ref === 'EPIC-001')!;
    expect(epic.children).toHaveLength(1);
    expect(epic.children![0].ref).toBe('TASK-001');
  });

  it('scoped selectProjectBacklog stays scoped when other projects have entities', () => {
    const db = buildDb();
    seedFixture(db);
    seedSecondProject(db);

    const scoped = selectProjectBacklog(dbAdapter(db), 1);
    expect(scoped.map((t) => t.ref).sort()).toEqual(['EPIC-001', 'IDEA-001']);
    expect(scoped.every((t) => t.project_id === 1)).toBe(true);
  });

  it('projects stage_position from the joined stage; archived_at defaults to null', () => {
    const db = buildDb();
    const { ideaId, epicId } = seedFixture(db);

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    const idea = backlog.find((t) => t.id === ideaId)!;
    const epic = backlog.find((t) => t.id === epicId)!;

    expect(idea.stage_position).toBe(3);
    expect(epic.stage_position).toBe(4);
    expect(epic.children![0].stage_position).toBe(5);
    expect(idea.archived_at).toBeNull();
    expect(epic.archived_at).toBeNull();
    expect(epic.children![0].archived_at).toBeNull();
  });

  it('archived rows are ALWAYS returned and archived_at round-trips (visibility is client-side)', () => {
    const db = buildDb();
    const { ideaId, taskId } = seedFixture(db);
    const stamp = '2026-06-01T00:00:00.000Z';
    db.prepare('UPDATE ideas SET archived_at = ? WHERE id = ?').run(stamp, ideaId);
    db.prepare('UPDATE tasks SET archived_at = ? WHERE id = ?').run(stamp, taskId);

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    const idea = backlog.find((t) => t.id === ideaId)!;
    expect(idea.archived_at).toBe(stamp);
    // The archived idea keeps its in-place stage (no stage move on archive).
    expect(idea.stage_position).toBe(3);

    // Archived child task still nests under its epic with the stamp.
    const epic = backlog.find((t) => t.ref === 'EPIC-001')!;
    expect(epic.children![0].archived_at).toBe(stamp);

    // Single-row read agrees.
    expect(selectTaskById(dbAdapter(db), ideaId)?.archived_at).toBe(stamp);
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

  it('selectTaskById carries stage_position + archived_at on the entity AND its epic children', () => {
    const db = buildDb();
    const { epicId, taskId } = seedFixture(db);
    const stamp = '2026-06-02T00:00:00.000Z';
    db.prepare('UPDATE tasks SET archived_at = ? WHERE id = ?').run(stamp, taskId);

    const epic = selectTaskById(dbAdapter(db), epicId)!;
    expect(epic.stage_position).toBe(4);
    expect(epic.archived_at).toBeNull();

    const child = epic.children![0];
    expect(child.stage_position).toBe(5);
    expect(child.archived_at).toBe(stamp);
  });

  it('boardsForProject returns the 11-stage board (position 11 removed by migration 024)', () => {
    const db = buildDb();
    const boards = boardsForProject(dbAdapter(db), 1);
    expect(boards).toHaveLength(1);
    expect(boards[0].stages).toHaveLength(11);
    expect(boards[0].stages.some((s) => s.position === 11)).toBe(false);
    const decomposed = boards[0].stages.find((s) => s.position === 12)!;
    expect(decomposed.label).toBe('Decomposed');
    expect(decomposed.is_terminal).toBe(true);
    expect(decomposed.hidden_by_default).toBe(false);
  });

  it('boardsForProject(null) lists every project\'s boards ordered by project_id', () => {
    const db = buildDb();
    const boards = boardsForProject(dbAdapter(db), null);
    expect(boards.map((b) => b.project_id)).toEqual([1, 2]);
    expect(boards.every((b) => b.is_default)).toBe(true);
    // Each board still carries its own full stage set.
    expect(boards[1].stages).toHaveLength(11);
  });
});

// ---------------------------------------------------------------------------
// Dependency overlay (blockedBy / relatedTo / readyToWork)
// ---------------------------------------------------------------------------

/** Insert a bare top-level task at a given stage position. Returns its id. */
function seedTask(db: Database.Database, id: string, ref: string, position: number): void {
  db.prepare(
    `INSERT INTO tasks (id, project_id, ref, title, body, board_id, stage_id, created_at)
     VALUES (?, 1, ?, ?, 'b', 'board-1-default', ?, '2026-01-01T00:00:00.000Z')`,
  ).run(id, ref, `Title ${ref}`, stageId(position));
}

function addEdge(
  db: Database.Database,
  taskId: string,
  dependsOn: string,
  kind: 'blocking' | 'related' = 'blocking',
): void {
  db.prepare(
    'INSERT INTO task_dependencies (task_id, depends_on_task_id, kind) VALUES (?, ?, ?)',
  ).run(taskId, dependsOn, kind);
}

describe('taskListing — dependency overlay', () => {
  it('a task with no dependencies is readyToWork with empty edge arrays', () => {
    const db = buildDb();
    seedTask(db, 'tsk_a', 'TASK-001', 6);

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    const a = backlog.find((t) => t.id === 'tsk_a')!;
    expect(a.blockedBy).toEqual([]);
    expect(a.relatedTo).toEqual([]);
    expect(a.readyToWork).toBe(true);
  });

  it('a task blocked by an unfinished prereq is NOT readyToWork and surfaces blockedBy ref/title', () => {
    const db = buildDb();
    seedTask(db, 'tsk_a', 'TASK-001', 6); // blocked task at Ready-for-dev
    seedTask(db, 'tsk_b', 'TASK-002', 5); // prereq still at Tasks-extracted (not done)
    addEdge(db, 'tsk_a', 'tsk_b');

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    const a = backlog.find((t) => t.id === 'tsk_a')!;
    expect(a.readyToWork).toBe(false);
    expect(a.blockedBy).toEqual([{ taskId: 'tsk_b', ref: 'TASK-002', title: 'Title TASK-002' }]);
    expect(a.relatedTo).toEqual([]);

    // The prereq itself has no blockers ⇒ ready.
    const b = backlog.find((t) => t.id === 'tsk_b')!;
    expect(b.readyToWork).toBe(true);
    expect(b.blockedBy).toEqual([]);
  });

  it('a task becomes readyToWork once ALL blocking prereqs reach the Done stage (position 9)', () => {
    const db = buildDb();
    seedTask(db, 'tsk_a', 'TASK-001', 6);
    seedTask(db, 'tsk_b', 'TASK-002', 9); // prereq at Done
    seedTask(db, 'tsk_c', 'TASK-003', 9); // prereq at Done
    addEdge(db, 'tsk_a', 'tsk_b');
    addEdge(db, 'tsk_a', 'tsk_c');

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    const a = backlog.find((t) => t.id === 'tsk_a')!;
    expect(a.readyToWork).toBe(true);
    expect(a.blockedBy!.map((d) => d.ref).sort()).toEqual(['TASK-002', 'TASK-003']);
  });

  it('one of several blocking prereqs not done keeps the task blocked', () => {
    const db = buildDb();
    seedTask(db, 'tsk_a', 'TASK-001', 6);
    seedTask(db, 'tsk_b', 'TASK-002', 9); // done
    seedTask(db, 'tsk_c', 'TASK-003', 7); // in dev — NOT done
    addEdge(db, 'tsk_a', 'tsk_b');
    addEdge(db, 'tsk_a', 'tsk_c');

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    const a = backlog.find((t) => t.id === 'tsk_a')!;
    expect(a.readyToWork).toBe(false);
    expect(a.blockedBy).toHaveLength(2);
  });

  it('related edges populate relatedTo and never gate readyToWork', () => {
    const db = buildDb();
    seedTask(db, 'tsk_a', 'TASK-001', 6);
    seedTask(db, 'tsk_b', 'TASK-002', 5); // not done, but only a related peer
    addEdge(db, 'tsk_a', 'tsk_b', 'related');

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    const a = backlog.find((t) => t.id === 'tsk_a')!;
    expect(a.relatedTo).toEqual([{ taskId: 'tsk_b', ref: 'TASK-002', title: 'Title TASK-002' }]);
    expect(a.blockedBy).toEqual([]);
    expect(a.readyToWork).toBe(true);
  });

  it('selectTaskById carries the same dependency overlay for a single task', () => {
    const db = buildDb();
    seedTask(db, 'tsk_a', 'TASK-001', 6);
    seedTask(db, 'tsk_b', 'TASK-002', 5);
    addEdge(db, 'tsk_a', 'tsk_b');

    const a = selectTaskById(dbAdapter(db), 'tsk_a')!;
    expect(a.readyToWork).toBe(false);
    expect(a.blockedBy).toEqual([{ taskId: 'tsk_b', ref: 'TASK-002', title: 'Title TASK-002' }]);
  });
});
