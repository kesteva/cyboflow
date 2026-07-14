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
import {
  selectProjectBacklog,
  selectTaskById,
  selectIdeaDecomposition,
  selectRunDecomposition,
  boardsForProject,
  resolveBacklogRef,
  computeTaskOverlay,
} from '../taskListing';
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
  // Migration 042 adds the visibility stamps (ideas.decomposed_at,
  // epics/tasks.approved_at) AND collapses the board to four stages. We only
  // need the columns here — loading the full file would DELETE board_stages at
  // positions 2,3,4,5,7,8,12, breaking the position-based fixtures below (the
  // board-collapse test migration lives in a separate change). Apply just the
  // column ALTERs so the read-side UNION can project the new fields.
  db.exec('ALTER TABLE ideas ADD COLUMN decomposed_at TEXT');
  db.exec('ALTER TABLE epics ADD COLUMN approved_at TEXT');
  db.exec('ALTER TABLE tasks ADD COLUMN approved_at TEXT');
  // Migration 049 adds the A/B experiment sandbox tag to all three entity tables;
  // the read-side UNION now projects experiment_id, so the fixture needs it.
  db.exec('ALTER TABLE ideas ADD COLUMN experiment_id TEXT');
  db.exec('ALTER TABLE epics ADD COLUMN experiment_id TEXT');
  db.exec('ALTER TABLE tasks ADD COLUMN experiment_id TEXT');
  // Migration 057 adds the manual rank; the UNION projects sort_order unconditionally.
  db.exec(readFileSync(join(migDir, '057_entity_sort_order.sql'), 'utf-8'));
  // Migration 059 adds the entity `category` classification (feature|bug|chore,
  // NOT NULL DEFAULT 'feature'); the UNION now selects it bare (not NULL AS ...)
  // on every branch, so every fixture row needs the column.
  db.exec(readFileSync(join(migDir, '059_entity_category.sql'), 'utf-8'));
  // 017 (seed_idea_id) + 061 (seed_idea_ids) are needed by selectRunDecomposition's
  // listRunOwnedOrBatchIdeaIds resolution (the run-owned-ideas fixtures below).
  db.exec(readFileSync(join(migDir, '017_run_seed_idea.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '061_run_seed_idea_ids.sql'), 'utf-8'));
  return db;
}

/**
 * Seed a bare 'planner' workflow_runs row with seed_idea_id/seed_idea_ids
 * stamped (migrations 017/060), the fixture selectRunDecomposition's owned-idea
 * resolution (listRunOwnedOrBatchIdeaIds) reads. seed_idea_id is dual-written as
 * ideaIds[0] (the production invariant); an empty ideaIds leaves both NULL (a
 * run owning no idea).
 */
function seedRunWithIdeas(db: Database.Database, runId: string, ideaIds: string[]): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'planner', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, seed_idea_id, seed_idea_ids)
     VALUES (?, 'wf-1', 1, 'running', 'default', ?, ?)`,
  ).run(runId, ideaIds[0] ?? null, ideaIds.length > 0 ? JSON.stringify(ideaIds) : null);
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

  it('selectProjectBacklog and selectTaskById project category (migration 059) on the page-load read path', () => {
    const db = buildDb();
    const { ideaId, epicId, taskId } = seedFixture(db);
    // seedFixture's INSERTs don't specify category, so every row falls back to
    // the column's DEFAULT 'feature' — proving the bare (non-NULL-AS) UNION
    // select surfaces the default, not just an explicitly-written value.
    db.prepare(`UPDATE tasks SET category = 'bug' WHERE id = ?`).run(taskId);

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    const idea = backlog.find((t) => t.id === ideaId)!;
    const epic = backlog.find((t) => t.id === epicId)!;
    const task = epic.children!.find((c) => c.id === taskId)!;
    expect(idea.category).toBe('feature');
    expect(epic.category).toBe('feature');
    expect(task.category).toBe('bug');

    // Same read path exercised via selectTaskById (single-row projection).
    expect(selectTaskById(dbAdapter(db), taskId)!.category).toBe('bug');
    expect(selectTaskById(dbAdapter(db), ideaId)!.category).toBe('feature');

    // selectTaskById's epic-children lookup is a SEPARATE hand-written SELECT
    // (not entityUnionSql) — it must project category too, not just inherit it
    // by accident from the shared UNION column list used elsewhere.
    const epicViaSelectTaskById = selectTaskById(dbAdapter(db), epicId)!;
    expect(epicViaSelectTaskById.children![0].category).toBe('bug');
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

  it('projects decomposed_at (idea-only) and approved_at (epic/task-only), NULL across types', () => {
    const db = buildDb();
    const { ideaId, epicId, taskId } = seedFixture(db);
    const decStamp = '2026-06-05T00:00:00.000Z';
    const appStamp = '2026-06-06T00:00:00.000Z';
    db.prepare('UPDATE ideas SET decomposed_at = ? WHERE id = ?').run(decStamp, ideaId);
    db.prepare('UPDATE epics SET approved_at = ? WHERE id = ?').run(appStamp, epicId);
    db.prepare('UPDATE tasks SET approved_at = ? WHERE id = ?').run(appStamp, taskId);

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    const idea = backlog.find((t) => t.id === ideaId)!;
    const epic = backlog.find((t) => t.id === epicId)!;
    const child = epic.children![0];

    // decomposed_at is an IDEA-only column; epics/tasks read it back as null.
    expect(idea.decomposed_at).toBe(decStamp);
    expect(epic.decomposed_at).toBeNull();
    expect(child.decomposed_at).toBeNull();

    // approved_at is an EPIC/TASK column; ideas read it back as null.
    expect(idea.approved_at).toBeNull();
    expect(epic.approved_at).toBe(appStamp);
    expect(child.approved_at).toBe(appStamp);

    // Single-row + idea-decomposition reads carry the same stamps.
    expect(selectTaskById(dbAdapter(db), ideaId)?.decomposed_at).toBe(decStamp);
    expect(selectTaskById(dbAdapter(db), ideaId)?.approved_at).toBeNull();
    expect(selectTaskById(dbAdapter(db), epicId)?.approved_at).toBe(appStamp);
    expect(selectTaskById(dbAdapter(db), taskId)?.approved_at).toBe(appStamp);

    const decomp = selectIdeaDecomposition(dbAdapter(db), ideaId)!;
    expect(decomp.decomposed_at).toBe(decStamp);
    const decompEpic = decomp.children?.find((e) => e.id === epicId);
    expect(decompEpic?.approved_at).toBe(appStamp);
    expect(decompEpic?.decomposed_at).toBeNull();
    expect(decompEpic?.children?.[0].approved_at).toBe(appStamp);
  });

  it('decomposed_at/approved_at default to null when unstamped', () => {
    const db = buildDb();
    const { ideaId, epicId, taskId } = seedFixture(db);
    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    const idea = backlog.find((t) => t.id === ideaId)!;
    const epic = backlog.find((t) => t.id === epicId)!;
    expect(idea.decomposed_at).toBeNull();
    expect(idea.approved_at).toBeNull();
    expect(epic.approved_at).toBeNull();
    expect(epic.children![0].approved_at).toBeNull();
    expect(selectTaskById(dbAdapter(db), taskId)?.approved_at).toBeNull();
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

  it('selectIdeaDecomposition nests epics under the idea and tasks under each epic', () => {
    const db = buildDb();
    const { ideaId, epicId, taskId } = seedFixture(db);
    // A SECOND epic from the same idea, with its own child task, to prove the
    // tree nests per-epic (not all tasks flattened under the idea).
    const epic2 = 'epc_2';
    const task2 = 'tsk_2';
    db.prepare(
      `INSERT INTO epics (id, project_id, ref, title, body, board_id, stage_id, originating_idea_id, created_at)
       VALUES (?, 1, 'EPIC-002', 'Second epic', 'epic2 body', 'board-1-default', ?, ?, '2026-01-01T00:00:03.000Z')`,
    ).run(epic2, stageId(4), ideaId);
    db.prepare(
      `INSERT INTO tasks (id, project_id, ref, title, body, board_id, stage_id, parent_epic_id, originating_idea_id, created_at)
       VALUES (?, 1, 'TASK-002', 'Second task', 'task2 body', 'board-1-default', ?, ?, ?, '2026-01-01T00:00:04.000Z')`,
    ).run(task2, stageId(5), epic2, ideaId);

    const idea = selectIdeaDecomposition(dbAdapter(db), ideaId)!;
    expect(idea.type).toBe('idea');
    expect(idea.id).toBe(ideaId);

    // Epics nest under the idea (ASC by created_at), each with childCount rollup.
    const epics = idea.children ?? [];
    expect(epics.map((e) => e.id)).toEqual([epicId, epic2]);
    expect(idea.childCount).toBe(2);
    expect(epics.every((e) => e.type === 'epic')).toBe(true);

    // Each epic nests ONLY its own task (via parent_epic_id).
    expect(epics[0].children?.map((t) => t.id)).toEqual([taskId]);
    expect(epics[0].childCount).toBe(1);
    expect(epics[1].children?.map((t) => t.id)).toEqual([task2]);
    expect(epics[1].children?.[0].type).toBe('task');
  });

  it('selectIdeaDecomposition surfaces tasks decomposed DIRECTLY under the idea (small idea, no epic)', () => {
    const db = buildDb();
    // A small-idea decomposition: tasks created directly under the idea
    // (originating_idea_id set, parent_epic_id NULL) with NO epic layer. These
    // must surface as task-type children so the decomposed-stories artifact
    // renders them (the bug was: read-side only looked for tasks under epics).
    const ideaId = 'ide_small';
    db.prepare(
      `INSERT INTO ideas (id, project_id, ref, title, body, board_id, stage_id, created_at)
       VALUES (?, 1, 'IDEA-050', 'Small idea', 'body', 'board-1-default', ?, '2026-01-02T00:00:00.000Z')`,
    ).run(ideaId, stageId(1));
    db.prepare(
      `INSERT INTO tasks (id, project_id, ref, title, body, board_id, stage_id, parent_epic_id, originating_idea_id, created_at)
       VALUES ('tsk_d1', 1, 'TASK-101', 'Direct one', 'b', 'board-1-default', ?, NULL, ?, '2026-01-02T00:00:01.000Z')`,
    ).run(stageId(5), ideaId);
    db.prepare(
      `INSERT INTO tasks (id, project_id, ref, title, body, board_id, stage_id, parent_epic_id, originating_idea_id, created_at)
       VALUES ('tsk_d2', 1, 'TASK-102', 'Direct two', 'b', 'board-1-default', ?, NULL, ?, '2026-01-02T00:00:02.000Z')`,
    ).run(stageId(5), ideaId);

    const idea = selectIdeaDecomposition(dbAdapter(db), ideaId)!;
    const children = idea.children ?? [];
    // No epics → children are exactly the direct tasks, ASC by created_at.
    expect(children.map((c) => c.id)).toEqual(['tsk_d1', 'tsk_d2']);
    expect(children.every((c) => c.type === 'task')).toBe(true);
    expect(idea.childCount).toBe(2);
  });

  it('selectIdeaDecomposition projects category (migration 059) on its hand-written nested epic/task/direct-task queries', () => {
    const db = buildDb();
    // selectIdeaDecomposition's epic rows, an epic's task rows, and the
    // direct-task-under-idea rows are each a SEPARATE hand-written SELECT (not
    // entityUnionSql) — none is exercised for `category` elsewhere, so a typo
    // in any one of those three SELECT lists would silently read back
    // undefined without this test catching it.
    const { ideaId, epicId, taskId } = seedFixture(db);
    db.prepare(`UPDATE epics SET category = 'chore' WHERE id = ?`).run(epicId);
    db.prepare(`UPDATE tasks SET category = 'bug' WHERE id = ?`).run(taskId);
    // A task decomposed DIRECTLY under the idea (no epic) — its own
    // hand-written SELECT branch (directTaskRows).
    db.prepare(
      `INSERT INTO tasks (id, project_id, ref, title, body, board_id, stage_id, parent_epic_id, originating_idea_id, category, created_at)
       VALUES ('tsk_direct', 1, 'TASK-777', 'Direct', 'b', 'board-1-default', ?, NULL, ?, 'chore', '2026-01-01T00:00:07.000Z')`,
    ).run(stageId(5), ideaId);

    const decomp = selectIdeaDecomposition(dbAdapter(db), ideaId)!;
    expect(decomp.category).toBe('feature');

    const epic = decomp.children!.find((c) => c.id === epicId)!;
    expect(epic.category).toBe('chore');
    expect(epic.children![0].category).toBe('bug');

    const direct = decomp.children!.find((c) => c.id === 'tsk_direct')!;
    expect(direct.category).toBe('chore');
  });

  it('selectIdeaDecomposition handles an idea with no epics and rejects non-idea ids', () => {
    const db = buildDb();
    const { ideaId, epicId, taskId } = seedFixture(db);
    // An idea with no epics yet → empty children, not undefined.
    const lonely = 'ide_lonely';
    db.prepare(
      `INSERT INTO ideas (id, project_id, ref, title, body, board_id, stage_id, created_at)
       VALUES (?, 1, 'IDEA-009', 'Lonely idea', 'body', 'board-1-default', ?, '2026-01-01T00:00:05.000Z')`,
    ).run(lonely, stageId(1));

    const decomp = selectIdeaDecomposition(dbAdapter(db), lonely)!;
    expect(decomp.children).toEqual([]);
    expect(decomp.childCount).toBe(0);

    // Passing an epic or task id (not an idea) returns null — root must be an idea.
    expect(selectIdeaDecomposition(dbAdapter(db), epicId)).toBeNull();
    expect(selectIdeaDecomposition(dbAdapter(db), taskId)).toBeNull();
    expect(selectIdeaDecomposition(dbAdapter(db), 'missing')).toBeNull();
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
// selectRunDecomposition (run-scoped, multi-idea batch — IDEA-009 batch fix)
// ---------------------------------------------------------------------------

describe('taskListing — selectRunDecomposition', () => {
  it('projects one decomposition tree PER idea the run owns, in owned-idea order, DRAFTS included', () => {
    const db = buildDb();

    // Idea A: an epic (DRAFT — approved_at NULL) with a child task (also a draft).
    const ideaA = 'ide_a';
    db.prepare(
      `INSERT INTO ideas (id, project_id, ref, title, body, board_id, stage_id, created_at)
       VALUES (?, 1, 'IDEA-A', 'Idea A', 'body a', 'board-1-default', ?, '2026-01-01T00:00:00.000Z')`,
    ).run(ideaA, stageId(1));
    const epicA = 'epc_a';
    db.prepare(
      `INSERT INTO epics (id, project_id, ref, title, body, board_id, stage_id, originating_idea_id, approved_at, created_at)
       VALUES (?, 1, 'EPIC-A', 'Epic A', 'epic a body', 'board-1-default', ?, ?, NULL, '2026-01-01T00:00:01.000Z')`,
    ).run(epicA, stageId(4), ideaA);
    const taskA = 'tsk_a';
    db.prepare(
      `INSERT INTO tasks (id, project_id, ref, title, body, board_id, stage_id, parent_epic_id, originating_idea_id, approved_at, created_at)
       VALUES (?, 1, 'TASK-A', 'Task A', 'task a body', 'board-1-default', ?, ?, ?, NULL, '2026-01-01T00:00:02.000Z')`,
    ).run(taskA, stageId(5), epicA, ideaA);

    // Idea B: a small-idea decomposition — a task DIRECTLY under the idea
    // (no epic layer), also a draft (approved_at NULL).
    const ideaB = 'ide_b';
    db.prepare(
      `INSERT INTO ideas (id, project_id, ref, title, body, board_id, stage_id, created_at)
       VALUES (?, 1, 'IDEA-B', 'Idea B', 'body b', 'board-1-default', ?, '2026-01-02T00:00:00.000Z')`,
    ).run(ideaB, stageId(1));
    const taskB = 'tsk_b';
    db.prepare(
      `INSERT INTO tasks (id, project_id, ref, title, body, board_id, stage_id, parent_epic_id, originating_idea_id, approved_at, created_at)
       VALUES (?, 1, 'TASK-B', 'Task B', 'task b body', 'board-1-default', ?, NULL, ?, NULL, '2026-01-02T00:00:01.000Z')`,
    ).run(taskB, stageId(5), ideaB);

    seedRunWithIdeas(db, 'run-multi', [ideaA, ideaB]);

    const trees = selectRunDecomposition(dbAdapter(db), 'run-multi');
    expect(trees).toHaveLength(2);
    expect(trees.map((t) => t.id)).toEqual([ideaA, ideaB]);
    expect(trees.every((t) => t.type === 'idea')).toBe(true);

    // Idea A's tree: epic -> task, both drafts (approved_at NULL) surfaced.
    const treeA = trees[0];
    expect(treeA.children?.map((c) => c.id)).toEqual([epicA]);
    expect(treeA.children?.[0].approved_at).toBeNull();
    expect(treeA.children?.[0].children?.map((c) => c.id)).toEqual([taskA]);
    expect(treeA.children?.[0].children?.[0].approved_at).toBeNull();

    // Idea B's tree: direct task (no epic), also a draft.
    const treeB = trees[1];
    expect(treeB.children?.map((c) => c.id)).toEqual([taskB]);
    expect(treeB.children?.[0].type).toBe('task');
    expect(treeB.children?.[0].approved_at).toBeNull();
  });

  it('returns [] when the run owns no resolvable idea (empty seed, no sprint batch)', () => {
    const db = buildDb();
    seedRunWithIdeas(db, 'run-empty', []);
    expect(selectRunDecomposition(dbAdapter(db), 'run-empty')).toEqual([]);
  });

  it('returns [] for an unknown run id', () => {
    const db = buildDb();
    expect(selectRunDecomposition(dbAdapter(db), 'no-such-run')).toEqual([]);
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

  // A/B experiments (migration 049): experiment-tagged rows are hidden by default.
  it('selectProjectBacklog EXCLUDES experiment-tagged rows by default, includes them with the flag', () => {
    const db = buildDb();
    const { ideaId, epicId } = seedFixture(db);
    // Tag the idea + its epic into an experiment sandbox.
    db.prepare("UPDATE ideas SET experiment_id = 'exp-1' WHERE id = ?").run(ideaId);
    db.prepare("UPDATE epics SET experiment_id = 'exp-1' WHERE id = ?").run(epicId);

    const hidden = selectProjectBacklog(dbAdapter(db), 1);
    expect(hidden.some((t) => t.id === ideaId)).toBe(false);
    expect(hidden.some((t) => t.id === epicId)).toBe(false);

    const shown = selectProjectBacklog(dbAdapter(db), 1, { includeExperimentTagged: true });
    expect(shown.some((t) => t.id === ideaId)).toBe(true);
    const shownIdea = shown.find((t) => t.id === ideaId)!;
    expect(shownIdea.experiment_id).toBe('exp-1');
  });

  // BOARD-LEAK AUDIT (load-bearing for the ship-arm materialize fix): board
  // visibility is gated on the experiment_id TAG, not approved_at. An experiment-arm
  // task revealed for sprint-eligibility (approved_at STAMPED) must STILL be excluded
  // from the shared board while its tag is set — otherwise both arms' clones would
  // dirty the board mid-experiment. This is exactly the tagged+approved state a
  // revealed arm task sits in between its approve-plan gate and experiments.decide.
  it('selectProjectBacklog EXCLUDES a tagged row even when approved_at is stamped (tag, not approval, hides)', () => {
    const db = buildDb();
    const { epicId, taskId } = seedFixture(db);
    // Reveal for eligibility (approved_at set) BUT keep the experiment tag.
    const now = '2026-02-02T00:00:00.000Z';
    db.prepare('UPDATE epics SET approved_at = ?, experiment_id = ? WHERE id = ?').run(now, 'exp-1', epicId);
    db.prepare('UPDATE tasks SET approved_at = ?, experiment_id = ? WHERE id = ?').run(now, 'exp-1', taskId);

    const board = selectProjectBacklog(dbAdapter(db), 1);
    expect(board.some((t) => t.id === epicId)).toBe(false);
    // The task nests under its epic; assert it is absent from the entire projected tree.
    const allIds = board.flatMap((t) => [t.id, ...(t.children ?? []).map((c) => c.id)]);
    expect(allIds).not.toContain(taskId);
    expect(allIds).not.toContain(epicId);
  });
});

// ---------------------------------------------------------------------------
// sort_order (manual rank, migration 057)
// ---------------------------------------------------------------------------

describe('taskListing — sort_order manual rank (migration 057)', () => {
  it('ranked items sort BEFORE unranked, in rank order (unranked keep the legacy order)', () => {
    const db = buildDb();
    // Three top-level tasks, created_at ASC: a < b < c.
    db.prepare(
      `INSERT INTO tasks (id, project_id, ref, title, body, board_id, stage_id, created_at)
       VALUES ('tsk_a', 1, 'TASK-001', 'A', 'b', 'board-1-default', ?, '2026-01-01T00:00:00.000Z')`,
    ).run(stageId(6));
    db.prepare(
      `INSERT INTO tasks (id, project_id, ref, title, body, board_id, stage_id, created_at)
       VALUES ('tsk_b', 1, 'TASK-002', 'B', 'b', 'board-1-default', ?, '2026-01-01T00:00:01.000Z')`,
    ).run(stageId(6));
    db.prepare(
      `INSERT INTO tasks (id, project_id, ref, title, body, board_id, stage_id, created_at)
       VALUES ('tsk_c', 1, 'TASK-003', 'C', 'b', 'board-1-default', ?, '2026-01-01T00:00:02.000Z')`,
    ).run(stageId(6));
    // Rank the NEWEST first and the oldest second; middle stays unranked.
    db.prepare('UPDATE tasks SET sort_order = 1.0 WHERE id = ?').run('tsk_c');
    db.prepare('UPDATE tasks SET sort_order = 2.0 WHERE id = ?').run('tsk_a');

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    expect(backlog.map((t) => t.id)).toEqual(['tsk_c', 'tsk_a', 'tsk_b']);
    // The rank round-trips onto the projected item.
    expect(backlog[0].sort_order).toBe(1.0);
    expect(backlog[1].sort_order).toBe(2.0);
    expect(backlog[2].sort_order).toBeNull();
  });

  it('with every sort_order NULL the board order is identical to today (created_at, ref)', () => {
    const db = buildDb();
    seedFixture(db); // idea (t0) + epic (t1); the task nests under the epic

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    expect(backlog.map((t) => t.ref)).toEqual(['IDEA-001', 'EPIC-001']);
    expect(backlog.every((t) => t.sort_order === null)).toBe(true);
    // Nested child projects sort_order too (explicit null, never undefined).
    const epic = backlog.find((t) => t.ref === 'EPIC-001')!;
    expect(epic.children![0].sort_order).toBeNull();
  });

  it('mixed-type interleave: idea/epic/task in one list order by rank across tables', () => {
    const db = buildDb();
    const { ideaId, epicId } = seedFixture(db); // idea + epic + nested task
    // An orphan task so a task-type row is present at the TOP level.
    db.prepare(
      `INSERT INTO tasks (id, project_id, ref, title, body, board_id, stage_id, created_at)
       VALUES ('tsk_orphan', 1, 'TASK-050', 'Orphan', 'b', 'board-1-default', ?, '2026-01-01T00:00:06.000Z')`,
    ).run(stageId(6));
    // Rank across the three tables: task first, epic second, idea third.
    db.prepare('UPDATE tasks SET sort_order = 0.5 WHERE id = ?').run('tsk_orphan');
    db.prepare('UPDATE epics SET sort_order = 1.5 WHERE id = ?').run(epicId);
    db.prepare('UPDATE ideas SET sort_order = 3.0 WHERE id = ?').run(ideaId);

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    expect(backlog.map((t) => t.id)).toEqual(['tsk_orphan', epicId, ideaId]);
  });

  it('the MCP-visible flatten (top-level + epic children inline) follows sort_order', () => {
    const db = buildDb();
    const { ideaId, epicId, taskId } = seedFixture(db);
    // Rank the epic ahead of the idea; the nested task rides with its epic in
    // the flatten regardless of its own rank (mirrors handleListTasks).
    db.prepare('UPDATE epics SET sort_order = 1.0 WHERE id = ?').run(epicId);
    db.prepare('UPDATE ideas SET sort_order = 2.0 WHERE id = ?').run(ideaId);

    const tree = selectProjectBacklog(dbAdapter(db), 1);
    const flat: string[] = [];
    for (const item of tree) {
      flat.push(item.id);
      if (item.type === 'epic' && item.children) {
        flat.push(...item.children.map((c) => c.id));
      }
    }
    expect(flat).toEqual([epicId, taskId, ideaId]);
  });
});

// ---------------------------------------------------------------------------
// resolveBacklogRef (cyboflow_get_task's ref-resolution helper)
// ---------------------------------------------------------------------------

describe('taskListing — resolveBacklogRef', () => {
  it('resolves an idea ref, an epic ref, and a task ref to their opaque ids', () => {
    const db = buildDb();
    const { ideaId, epicId, taskId } = seedFixture(db);

    expect(resolveBacklogRef(dbAdapter(db), 1, 'IDEA-001')).toBe(ideaId);
    expect(resolveBacklogRef(dbAdapter(db), 1, 'EPIC-001')).toBe(epicId);
    expect(resolveBacklogRef(dbAdapter(db), 1, 'TASK-001')).toBe(taskId);
  });

  it('returns null for a ref that does not exist in any table', () => {
    const db = buildDb();
    seedFixture(db);

    expect(resolveBacklogRef(dbAdapter(db), 1, 'TASK-999')).toBeNull();
  });

  it('does not resolve a ref that belongs to a different project', () => {
    const db = buildDb();
    seedFixture(db); // project 1: IDEA-001 / EPIC-001 / TASK-001
    seedSecondProject(db); // project 2: IDEA-101 / TASK-101

    // The ref exists, but scoped to project 1 it must not resolve project 2's row.
    expect(resolveBacklogRef(dbAdapter(db), 1, 'IDEA-101')).toBeNull();
    expect(resolveBacklogRef(dbAdapter(db), 2, 'IDEA-101')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeTaskOverlay — inFlow (direct + sprint-batch, migration 061)
// ---------------------------------------------------------------------------

/**
 * Extends buildDb() with the sprint-batch schema (migration 022) plus a
 * minimal `sessions` table + `workflow_runs.session_id` column (mirrors
 * migration 019 without pulling in its full history) so the batch + session
 * LEFT JOIN arms of computeTaskOverlay have real tables/columns to hit.
 */
function buildOverlayDb(): Database.Database {
  const db = buildDb();
  const migDir = join(__dirname, '..', '..', 'database', 'migrations');
  db.exec(readFileSync(join(migDir, '022_sprint_batches.sql'), 'utf-8'));
  db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    )
  `);
  return db;
}

function seedWorkflow(db: Database.Database): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
  ).run();
}

function seedSession(db: Database.Database, id: string, name: string): void {
  db.prepare('INSERT INTO sessions (id, name) VALUES (?, ?)').run(id, name);
}

/** Seed a DIRECT run (workflow_runs.task_id) — optionally session-hosted. */
function seedDirectRun(
  db: Database.Database,
  opts: { runId: string; taskId: string; status: string; sessionId?: string | null },
): void {
  seedWorkflow(db);
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, task_id, session_id)
     VALUES (?, 'wf-1', 1, ?, 'default', ?, ?)`,
  ).run(opts.runId, opts.status, opts.taskId, opts.sessionId ?? null);
}

/** Seed a sprint-BATCH run (workflow_runs.batch_id, NO task_id) + its lane row for `taskId`. */
function seedBatchRun(
  db: Database.Database,
  opts: { runId: string; taskId: string; batchId: string; status: string; sessionId?: string | null },
): void {
  seedWorkflow(db);
  db.prepare(
    `INSERT OR IGNORE INTO sprint_batches (id, project_id, substrate, status) VALUES (?, 1, 'sdk', 'running')`,
  ).run(opts.batchId);
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, batch_id, session_id)
     VALUES (?, 'wf-1', 1, ?, 'default', ?, ?)`,
  ).run(opts.runId, opts.status, opts.batchId, opts.sessionId ?? null);
  db.prepare(`INSERT INTO sprint_batch_tasks (batch_id, task_id, status) VALUES (?, ?, 'queued')`).run(
    opts.batchId,
    opts.taskId,
  );
}

describe('computeTaskOverlay — inFlow (direct + sprint-batch runs)', () => {
  it('a direct RUNNING run projects an inFlow entry with runStatus + resolved session identity', () => {
    const db = buildOverlayDb();
    seedTask(db, 'tsk_a', 'TASK-001', 6);
    seedSession(db, 'sess-1', 'quick-20260714-100000');
    seedDirectRun(db, { runId: 'run-1', taskId: 'tsk_a', status: 'running', sessionId: 'sess-1' });

    const overlay = computeTaskOverlay(dbAdapter(db), { id: 'tsk_a', stage_id: stageId(6) });
    expect(overlay.inFlow).toEqual([
      {
        agent: 'agent',
        runId: 'run-1',
        stepId: null,
        runStatus: 'running',
        sessionId: 'sess-1',
        sessionName: 'quick-20260714-100000',
      },
    ]);
  });

  it('a TERMINAL run (completed) projects NO inFlow entry', () => {
    const db = buildOverlayDb();
    seedTask(db, 'tsk_a', 'TASK-001', 9);
    seedDirectRun(db, { runId: 'run-1', taskId: 'tsk_a', status: 'completed' });

    const overlay = computeTaskOverlay(dbAdapter(db), { id: 'tsk_a', stage_id: stageId(9) });
    expect(overlay.inFlow).toEqual([]);
  });

  it('a batch-pulled task (no task_id, non-terminal batch run) projects an inFlow entry carrying the session name', () => {
    const db = buildOverlayDb();
    seedTask(db, 'tsk_b', 'TASK-002', 7); // parked at the derived In-development stage
    seedSession(db, 'sess-2', 'quick-20260714-110000');
    seedBatchRun(db, { runId: 'run-2', taskId: 'tsk_b', batchId: 'bat-1', status: 'running', sessionId: 'sess-2' });

    const overlay = computeTaskOverlay(dbAdapter(db), { id: 'tsk_b', stage_id: stageId(7) });
    expect(overlay.inFlow).toEqual([
      {
        agent: 'agent',
        runId: 'run-2',
        stepId: null,
        runStatus: 'running',
        sessionId: 'sess-2',
        sessionName: 'quick-20260714-110000',
      },
    ]);
  });

  it('a batch run that has already gone terminal projects NO inFlow entry for its lane task', () => {
    const db = buildOverlayDb();
    seedTask(db, 'tsk_b', 'TASK-002', 6);
    seedBatchRun(db, { runId: 'run-2', taskId: 'tsk_b', batchId: 'bat-1', status: 'completed' });

    const overlay = computeTaskOverlay(dbAdapter(db), { id: 'tsk_b', stage_id: stageId(6) });
    expect(overlay.inFlow).toEqual([]);
  });

  it('a run matching BOTH arms (its own task_id AND a batch lane naming the same task) appears only once', () => {
    const db = buildOverlayDb();
    seedTask(db, 'tsk_c', 'TASK-003', 7);
    seedWorkflow(db);
    db.prepare(
      `INSERT OR IGNORE INTO sprint_batches (id, project_id, substrate, status) VALUES ('bat-2', 1, 'sdk', 'running')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, task_id, batch_id)
       VALUES ('run-3', 'wf-1', 1, 'running', 'default', 'tsk_c', 'bat-2')`,
    ).run();
    db.prepare(`INSERT INTO sprint_batch_tasks (batch_id, task_id, status) VALUES ('bat-2', 'tsk_c', 'running')`).run();

    const overlay = computeTaskOverlay(dbAdapter(db), { id: 'tsk_c', stage_id: stageId(7) });
    expect(overlay.inFlow).toHaveLength(1);
    expect(overlay.inFlow[0].runId).toBe('run-3');
  });

  it('direct runs still resolve (session fields null) against a pre-batch/pre-session schema', () => {
    // The base buildDb() has neither workflow_runs.batch_id (migration 022) nor
    // workflow_runs.session_id (migration 019) nor a sessions table — the
    // columnExists guards must degrade gracefully instead of throwing.
    const db = buildDb();
    seedTask(db, 'tsk_d', 'TASK-004', 6);
    db.prepare(
      `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, task_id)
       VALUES ('run-4', 'wf-1', 1, 'running', 'default', 'tsk_d')`,
    ).run();

    const overlay = computeTaskOverlay(dbAdapter(db), { id: 'tsk_d', stage_id: stageId(6) });
    expect(overlay.inFlow).toEqual([
      { agent: 'agent', runId: 'run-4', stepId: null, runStatus: 'running', sessionId: null, sessionName: null },
    ]);
  });
});
