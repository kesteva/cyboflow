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
import { IDEA_COMPONENT_KEYS } from '../../../../shared/types/ideaComponents';

function buildDb(opts?: { skipSeedIdeaIds?: boolean }): Database.Database {
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
  // Migration 137 adds tasks.executor (agent|human). The UNION and the
  // dependency-overlay JOIN both project it (columnExists-gated), so the fixture
  // carries it to exercise the PRESENT path rather than the pre-137 fallback.
  db.exec(readFileSync(join(migDir, '137_task_executor.sql'), 'utf-8'));
  // 017 (seed_idea_id) + 061 (seed_idea_ids) are needed by selectRunDecomposition's
  // listRunOwnedOrBatchIdeaIds resolution (the run-owned-ideas fixtures below).
  db.exec(readFileSync(join(migDir, '017_run_seed_idea.sql'), 'utf-8'));
  if (!opts?.skipSeedIdeaIds) {
    db.exec(readFileSync(join(migDir, '061_run_seed_idea_ids.sql'), 'utf-8'));
  }
  // Migration 101 adds the idea component ledger table that selectProjectBacklog/
  // selectTaskById/selectIdeaDecomposition now resolve for every idea row. It is
  // self-contained (no dependency on other new tables), so the full file applies
  // cleanly. resolveIdeaComponentsBatch's 'prototype' derivation arm also reads
  // `approved_designs` (unconditionally) and `artifacts` (when a linked run is
  // found) — both are real migrations (082/035) that pull in `sessions`/`artifacts`
  // column ALTERs this fixture doesn't otherwise need, so — mirroring
  // resolveIdeaComponents.test.ts's own minimal ad-hoc schema — hand-roll just the
  // columns the resolver actually selects.
  db.exec(readFileSync(join(migDir, '101_idea_component_ledger.sql'), 'utf-8'));
  db.exec(`
    CREATE TABLE approved_designs (
      id TEXT PRIMARY KEY,
      idea_id TEXT NOT NULL,
      superseded_at TEXT
    );
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      atype TEXT NOT NULL
    );
  `);
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

/** Insert a bare top-level idea at a given stage position. */
function seedIdea(db: Database.Database, id: string, ref: string, position: number): void {
  db.prepare(
    `INSERT INTO ideas (id, project_id, ref, title, body, board_id, stage_id, created_at)
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
// computeTaskOverlay — inFlow (direct + sprint-batch, migration 066)
// ---------------------------------------------------------------------------

/**
 * Extends buildDb() with the sprint-batch schema (migration 022) plus a
 * minimal `sessions` table + `workflow_runs.session_id` column (mirrors
 * migration 019 without pulling in its full history) so the batch + session
 * LEFT JOIN arms of computeTaskOverlay have real tables/columns to hit.
 */
function buildOverlayDb(opts?: { skipSeedIdeaIds?: boolean }): Database.Database {
  const db = buildDb(opts);
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

// ---------------------------------------------------------------------------
// computeTaskOverlay — inFlow for IDEAS seeded into a live Planner/Ship run
// (TASK-224: seed_idea_id / seed_idea_ids, migrations 017/061)
// ---------------------------------------------------------------------------

/**
 * Seed a workflow_runs row stamped with the Planner/Ship idea-seed link:
 * `seed_idea_id` (migration 017, single-idea) and/or `seed_idea_ids` (migration
 * 061, JSON array — multi-idea). Probes for the seed_idea_ids column so the
 * SAME helper works against both `buildOverlayDb()` (has it) and
 * `buildOverlayDb({ skipSeedIdeaIds: true })` (pre-061 — the column literally
 * doesn't exist, so the INSERT must omit it rather than erroring).
 */
function seedIdeaSeededRun(
  db: Database.Database,
  opts: {
    runId: string;
    status: string;
    seedIdeaId?: string | null;
    seedIdeaIds?: string[] | null;
    sessionId?: string | null;
  },
): void {
  seedWorkflow(db);
  const hasSeedIdeaIds = (db.pragma('table_info(workflow_runs)') as Array<{ name: string }>).some(
    (c) => c.name === 'seed_idea_ids',
  );
  if (hasSeedIdeaIds) {
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, seed_idea_id, seed_idea_ids, session_id)
       VALUES (?, 'wf-1', 1, ?, 'default', ?, ?, ?)`,
    ).run(
      opts.runId,
      opts.status,
      opts.seedIdeaId ?? null,
      opts.seedIdeaIds ? JSON.stringify(opts.seedIdeaIds) : null,
      opts.sessionId ?? null,
    );
  } else {
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, seed_idea_id, session_id)
       VALUES (?, 'wf-1', 1, ?, 'default', ?, ?)`,
    ).run(opts.runId, opts.status, opts.seedIdeaId ?? null, opts.sessionId ?? null);
  }
}

describe('computeTaskOverlay — inFlow for ideas seeded into a live Planner/Ship run', () => {
  it('a single-idea seed_idea_id RUNNING run projects an inFlow entry with resolved session identity', () => {
    const db = buildOverlayDb();
    seedIdea(db, 'ide_a', 'IDEA-801', 1);
    seedSession(db, 'sess-3', 'quick-20260715-090000');
    seedIdeaSeededRun(db, { runId: 'run-single', status: 'running', seedIdeaId: 'ide_a', sessionId: 'sess-3' });

    const overlay = computeTaskOverlay(dbAdapter(db), { id: 'ide_a', stage_id: stageId(1), type: 'idea' });
    expect(overlay.inFlow).toEqual([
      {
        agent: 'agent',
        runId: 'run-single',
        stepId: null,
        runStatus: 'running',
        sessionId: 'sess-3',
        sessionName: 'quick-20260715-090000',
      },
    ]);
  });

  it('a multi-idea seed_idea_ids JSON array run lights EVERY seeded idea', () => {
    const db = buildOverlayDb();
    seedIdea(db, 'ide_b', 'IDEA-802', 1);
    seedIdea(db, 'ide_c', 'IDEA-803', 1);
    seedIdeaSeededRun(db, {
      runId: 'run-multi',
      status: 'running',
      seedIdeaId: 'ide_b', // dual-written to the first element (production invariant)
      seedIdeaIds: ['ide_b', 'ide_c'],
    });

    const overlayB = computeTaskOverlay(dbAdapter(db), { id: 'ide_b', stage_id: stageId(1), type: 'idea' });
    const overlayC = computeTaskOverlay(dbAdapter(db), { id: 'ide_c', stage_id: stageId(1), type: 'idea' });
    expect(overlayB.inFlow).toHaveLength(1);
    expect(overlayB.inFlow[0].runId).toBe('run-multi');
    expect(overlayC.inFlow).toHaveLength(1);
    expect(overlayC.inFlow[0].runId).toBe('run-multi');
  });

  it('a TERMINAL idea-seeded run (completed) projects NO inFlow entry', () => {
    const db = buildOverlayDb();
    seedIdea(db, 'ide_d', 'IDEA-804', 9);
    seedIdeaSeededRun(db, { runId: 'run-done', status: 'completed', seedIdeaId: 'ide_d' });

    const overlay = computeTaskOverlay(dbAdapter(db), { id: 'ide_d', stage_id: stageId(9), type: 'idea' });
    expect(overlay.inFlow).toEqual([]);
  });

  it('pre-061 schema (seed_idea_ids column absent) falls back to seed_idea_id alone', () => {
    const db = buildOverlayDb({ skipSeedIdeaIds: true });
    seedIdea(db, 'ide_e', 'IDEA-805', 1);
    seedIdeaSeededRun(db, { runId: 'run-pre061', status: 'running', seedIdeaId: 'ide_e' });

    const overlay = computeTaskOverlay(dbAdapter(db), { id: 'ide_e', stage_id: stageId(1), type: 'idea' });
    expect(overlay.inFlow).toEqual([
      { agent: 'agent', runId: 'run-pre061', stepId: null, runStatus: 'running', sessionId: null, sessionName: null },
    ]);
  });

  it('an idea with no seeded run projects an empty inFlow (untouched idea)', () => {
    const db = buildOverlayDb();
    seedIdea(db, 'ide_f', 'IDEA-806', 1);

    const overlay = computeTaskOverlay(dbAdapter(db), { id: 'ide_f', stage_id: stageId(1), type: 'idea' });
    expect(overlay.inFlow).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Idea component ledger overlay (migration 101) — components on IDEA items only
// ---------------------------------------------------------------------------

describe('taskListing — idea component ledger overlay (migration 101)', () => {
  it('selectProjectBacklog stamps all FIVE components on an idea, batched in one resolveIdeaComponentsBatch call', () => {
    const db = buildDb();
    const { ideaId } = seedFixture(db);

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    const idea = backlog.find((t) => t.id === ideaId)!;

    expect(idea.components).toBeDefined();
    expect(idea.components!.map((c) => c.component)).toEqual([...IDEA_COMPONENT_KEYS]);
    // No ledger rows exist yet -> every component is DERIVED, never 'skipped'.
    expect(idea.components!.every((c) => c.source === 'derived')).toBe(true);
    expect(idea.components!.every((c) => c.state === 'complete' || c.state === 'incomplete')).toBe(true);
  });

  it('selectProjectBacklog leaves components undefined for epics/tasks — ledger is ideas-only', () => {
    const db = buildDb();
    const { epicId, taskId } = seedFixture(db);

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    const epic = backlog.find((t) => t.id === epicId)!;
    const child = epic.children!.find((c) => c.id === taskId)!;

    expect(epic.components).toBeUndefined();
    expect(child.components).toBeUndefined();
  });

  it('a ledger row wins over derivation, and only for its own idea', () => {
    const db = buildDb();
    const { ideaId } = seedFixture(db);
    const other = seedSecondProject(db).ideaId;
    db.prepare(
      `INSERT INTO idea_components
         (idea_id, project_id, component, state, source, created_at, updated_at)
       VALUES (?, '1', 'architecture', 'skipped', 'manual', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run(ideaId);

    const backlog = selectProjectBacklog(dbAdapter(db), null);
    const idea = backlog.find((t) => t.id === ideaId)!;
    const architecture = idea.components!.find((c) => c.component === 'architecture')!;
    expect(architecture.state).toBe('skipped');
    expect(architecture.source).toBe('manual');

    // The OTHER project's idea has no ledger row -> still purely derived.
    const otherIdea = backlog.find((t) => t.id === other)!;
    const otherArchitecture = otherIdea.components!.find((c) => c.component === 'architecture')!;
    expect(otherArchitecture.source).toBe('derived');
  });

  it('selectTaskById stamps components for an idea and leaves epic/task undefined', () => {
    const db = buildDb();
    const { ideaId, epicId, taskId } = seedFixture(db);

    const idea = selectTaskById(dbAdapter(db), ideaId)!;
    expect(idea.components?.map((c) => c.component)).toEqual([...IDEA_COMPONENT_KEYS]);

    expect(selectTaskById(dbAdapter(db), epicId)!.components).toBeUndefined();
    expect(selectTaskById(dbAdapter(db), taskId)!.components).toBeUndefined();
    // The epic's nested child (a task) also stays undefined.
    const epic = selectTaskById(dbAdapter(db), epicId)!;
    expect(epic.children![0].components).toBeUndefined();
  });

  it('selectIdeaDecomposition stamps components on the root idea only, not its epics/tasks', () => {
    const db = buildDb();
    const { ideaId, epicId, taskId } = seedFixture(db);

    const decomp = selectIdeaDecomposition(dbAdapter(db), ideaId)!;
    expect(decomp.components?.map((c) => c.component)).toEqual([...IDEA_COMPONENT_KEYS]);

    const epic = decomp.children!.find((c) => c.id === epicId)!;
    expect(epic.components).toBeUndefined();
    expect(epic.children!.find((c) => c.id === taskId)!.components).toBeUndefined();
  });

  it('an idea whose body carries the "## Idea spec" heading derives idea-spec complete', () => {
    const db = buildDb();
    const ideaId = 'ide_spec';
    db.prepare(
      `INSERT INTO ideas (id, project_id, ref, title, body, board_id, stage_id, created_at)
       VALUES (?, 1, 'IDEA-200', 'Specced idea', ?, 'board-1-default', ?, '2026-01-03T00:00:00.000Z')`,
    ).run(ideaId, '## Idea spec\n\nThe spec body.', stageId(1));

    const idea = selectTaskById(dbAdapter(db), ideaId)!;
    const ideaSpec = idea.components!.find((c) => c.component === 'idea-spec')!;
    expect(ideaSpec.state).toBe('complete');
    expect(ideaSpec.source).toBe('derived');
    // No heading for the others -> incomplete.
    expect(idea.components!.find((c) => c.component === 'architecture')!.state).toBe('incomplete');
  });
});

// ---------------------------------------------------------------------------
// Membership overlay (sprint-batch + experiment, IDEA-053 / TASK-202)
// ---------------------------------------------------------------------------

/**
 * Extends buildOverlayDb() (sprint-batch schema + sessions table) with the
 * minimal experiment schema (migrations 048/049/051) the membership overlay
 * hits: workflow_variants, experiments, experiment_seed_tasks, plus the
 * workflow_runs.variant_id/variant_label denormalized columns. Hand-rolled
 * (not the full migration files) because buildDb() already ALTERs
 * ideas/epics/tasks.experiment_id (049's entity-sandbox columns) — re-running
 * 049_experiments.sql's ALTERs on top would throw 'duplicate column name'.
 */
function buildMembershipDb(): Database.Database {
  const db = buildOverlayDb();
  db.exec(`
    CREATE TABLE workflow_variants (
      id TEXT PRIMARY KEY, tuning_level TEXT,
      workflow_id TEXT NOT NULL,
      label TEXT NOT NULL,
      spec_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE experiments (
      id TEXT PRIMARY KEY, tuning_level TEXT,
      project_id INTEGER,
      workflow_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'side_by_side',
      base_branch TEXT,
      base_sha TEXT,
      variant_a_id TEXT,
      variant_b_id TEXT,
      run_a_id TEXT,
      run_b_id TEXT,
      session_a_id TEXT,
      session_b_id TEXT,
      status TEXT NOT NULL DEFAULT 'running'
    );
    CREATE TABLE experiment_seed_tasks (
      experiment_id TEXT NOT NULL,
      arm TEXT NOT NULL,
      original_task_id TEXT NOT NULL,
      clone_task_id TEXT NOT NULL
    );
  `);
  db.exec('ALTER TABLE workflow_runs ADD COLUMN variant_id TEXT');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN variant_label TEXT');
  return db;
}

/** Seed a sprint_batches row (status only; no hosting run). */
function seedBatch(db: Database.Database, id: string, status: string): void {
  db.prepare(
    `INSERT INTO sprint_batches (id, project_id, substrate, status) VALUES (?, 1, 'sdk', ?)`,
  ).run(id, status);
}

/** Add `taskId` as a lane member of `batchId` (sprint_batch_tasks row). */
function seedBatchTask(db: Database.Database, batchId: string, taskId: string): void {
  db.prepare(`INSERT INTO sprint_batch_tasks (batch_id, task_id, status) VALUES (?, ?, 'queued')`).run(
    batchId,
    taskId,
  );
}

/** Seed a workflows row with an explicit name (buildMembershipDb has no default). */
function seedNamedWorkflow(db: Database.Database, id: string, name: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, ?, '{}')`,
  ).run(id, name);
}

/** Seed the batch-owning workflow_runs row (workflow_runs.batch_id) — the hosting run resolveSprintBatchLabels reads. */
function seedBatchOwningRun(
  db: Database.Database,
  opts: { runId: string; batchId: string; workflowId: string; sessionId?: string | null },
): void {
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, batch_id, session_id)
     VALUES (?, ?, 1, 'running', 'default', ?, ?)`,
  ).run(opts.runId, opts.workflowId, opts.batchId, opts.sessionId ?? null);
}

/** Seed an experiments row. */
function seedExperiment(
  db: Database.Database,
  opts: {
    id: string;
    workflowId: string;
    status: string;
    variantAId: string;
    variantBId: string;
    runAId?: string | null;
    runBId?: string | null;
    sessionAId?: string | null;
    sessionBId?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO experiments
       (id, project_id, workflow_id, kind, base_branch, base_sha, variant_a_id, variant_b_id,
        run_a_id, run_b_id, session_a_id, session_b_id, status)
     VALUES (?, 1, ?, 'side_by_side', 'main', 'sha1', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.workflowId,
    opts.variantAId,
    opts.variantBId,
    opts.runAId ?? null,
    opts.runBId ?? null,
    opts.sessionAId ?? null,
    opts.sessionBId ?? null,
    opts.status,
  );
}

/** Seed both arm mapping rows (A + B) for one original task -> its per-arm clones. */
function seedExperimentSeedTask(
  db: Database.Database,
  opts: { experimentId: string; originalTaskId: string; cloneTaskIdA: string; cloneTaskIdB: string },
): void {
  db.prepare(
    `INSERT INTO experiment_seed_tasks (experiment_id, arm, original_task_id, clone_task_id) VALUES (?, 'A', ?, ?)`,
  ).run(opts.experimentId, opts.originalTaskId, opts.cloneTaskIdA);
  db.prepare(
    `INSERT INTO experiment_seed_tasks (experiment_id, arm, original_task_id, clone_task_id) VALUES (?, 'B', ?, ?)`,
  ).run(opts.experimentId, opts.originalTaskId, opts.cloneTaskIdB);
}

describe('taskListing — sprint-batch membership overlay', () => {
  it('a task in an active batch (running) projects exactly one sprint membership using the session-name label', () => {
    const db = buildMembershipDb();
    seedTask(db, 'tsk_a', 'TASK-001', 6);
    seedNamedWorkflow(db, 'wf-sprint-1', 'sprint');
    seedBatch(db, 'bat_1', 'running');
    seedBatchTask(db, 'bat_1', 'tsk_a');
    seedSession(db, 'sess-1', 'quick-20260714-100000');
    seedBatchOwningRun(db, { runId: 'run-1', batchId: 'bat_1', workflowId: 'wf-sprint-1', sessionId: 'sess-1' });

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    const task = backlog.find((t) => t.id === 'tsk_a')!;
    // The exact contract: label = `${base} · ${batchId.slice(0, 8)}` where base
    // is the trimmed session name (session wins over workflow name).
    expect(task.memberships).toEqual([
      { kind: 'sprint', id: 'bat_1', label: 'quick-20260714-100000 · bat_1', status: 'running' },
    ]);
  });

  it.each(['completed', 'failed', 'canceled'] as const)(
    'a batch that has gone terminal (%s) contributes NO membership',
    (status) => {
      const db = buildMembershipDb();
      seedTask(db, 'tsk_a', 'TASK-001', 9);
      seedBatch(db, 'bat_1', status);
      seedBatchTask(db, 'bat_1', 'tsk_a');

      const backlog = selectProjectBacklog(dbAdapter(db), 1);
      expect(backlog.find((t) => t.id === 'tsk_a')!.memberships).toEqual([]);
    },
  );

  it('two tasks sharing the SAME active batch both resolve the identical label (dedup by batch id)', () => {
    const db = buildMembershipDb();
    seedTask(db, 'tsk_a', 'TASK-001', 6);
    seedTask(db, 'tsk_b', 'TASK-002', 6);
    seedNamedWorkflow(db, 'wf-sprint-1', 'sprint');
    seedBatch(db, 'bat_1', 'running');
    seedBatchTask(db, 'bat_1', 'tsk_a');
    seedBatchTask(db, 'bat_1', 'tsk_b');
    seedSession(db, 'sess-1', 'shared-session');
    seedBatchOwningRun(db, { runId: 'run-1', batchId: 'bat_1', workflowId: 'wf-sprint-1', sessionId: 'sess-1' });

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    const a = backlog.find((t) => t.id === 'tsk_a')!;
    const b = backlog.find((t) => t.id === 'tsk_b')!;
    // The label is resolved ONCE per unique batch id (not once per task row) —
    // both tasks in the SAME batch must read back the IDENTICAL entry.
    expect(a.memberships).toEqual([{ kind: 'sprint', id: 'bat_1', label: 'shared-session · bat_1', status: 'running' }]);
    expect(b.memberships).toEqual(a.memberships);
  });

  it('planning and finalizing (the other two active lifecycles) both project a membership', () => {
    const db = buildMembershipDb();
    seedTask(db, 'tsk_p', 'TASK-001', 1);
    seedTask(db, 'tsk_f', 'TASK-002', 1);
    seedBatch(db, 'bat_p', 'planning');
    seedBatch(db, 'bat_f', 'finalizing');
    seedBatchTask(db, 'bat_p', 'tsk_p');
    seedBatchTask(db, 'bat_f', 'tsk_f');

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    expect(backlog.find((t) => t.id === 'tsk_p')!.memberships).toEqual([
      { kind: 'sprint', id: 'bat_p', label: 'Sprint · bat_p', status: 'planning' },
    ]);
    expect(backlog.find((t) => t.id === 'tsk_f')!.memberships).toEqual([
      { kind: 'sprint', id: 'bat_f', label: 'Sprint · bat_f', status: 'finalizing' },
    ]);
  });

  it('label falls back to the hosting run workflow name when no session is hosted', () => {
    const db = buildMembershipDb();
    seedTask(db, 'tsk_a', 'TASK-001', 6);
    seedNamedWorkflow(db, 'wf-sprint-1', 'nightly-sprint');
    seedBatch(db, 'bat_1', 'running');
    seedBatchTask(db, 'bat_1', 'tsk_a');
    seedBatchOwningRun(db, { runId: 'run-1', batchId: 'bat_1', workflowId: 'wf-sprint-1' }); // no session

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    expect(backlog.find((t) => t.id === 'tsk_a')!.memberships[0].label).toBe('nightly-sprint · bat_1');
  });

  it('label falls back to the literal "Sprint" when there is no hosting run at all', () => {
    const db = buildMembershipDb();
    seedTask(db, 'tsk_a', 'TASK-001', 6);
    seedBatch(db, 'bat_1', 'running');
    seedBatchTask(db, 'bat_1', 'tsk_a');
    // No workflow_runs row stamped with batch_id = 'bat_1' at all.

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    expect(backlog.find((t) => t.id === 'tsk_a')!.memberships[0].label).toBe('Sprint · bat_1');
  });

  it('a task with no active batch reads back memberships: []', () => {
    const db = buildMembershipDb();
    seedTask(db, 'tsk_a', 'TASK-001', 6);

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    expect(backlog.find((t) => t.id === 'tsk_a')!.memberships).toEqual([]);
  });

  it('ideas/epics never carry a sprint membership even when their nested task does', () => {
    const db = buildMembershipDb();
    const { ideaId, epicId, taskId } = seedFixture(db);
    seedBatch(db, 'bat_1', 'running');
    seedBatchTask(db, 'bat_1', taskId);

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    const idea = backlog.find((t) => t.id === ideaId)!;
    const epic = backlog.find((t) => t.id === epicId)!;
    expect(idea.memberships).toEqual([]);
    expect(epic.memberships).toEqual([]);
    expect(epic.children![0].memberships).toEqual([
      { kind: 'sprint', id: 'bat_1', label: 'Sprint · bat_1', status: 'running' },
    ]);
  });

  it('selectTaskById and selectIdeaDecomposition agree with selectProjectBacklog on the same membership', () => {
    const db = buildMembershipDb();
    const { epicId, taskId } = seedFixture(db);
    seedBatch(db, 'bat_1', 'running');
    seedBatchTask(db, 'bat_1', taskId);

    const viaListing = selectProjectBacklog(dbAdapter(db), 1).find((t) => t.id === epicId)!.children![0]
      .memberships;
    const viaTaskById = selectTaskById(dbAdapter(db), taskId)!.memberships;
    const viaEpicChildren = selectTaskById(dbAdapter(db), epicId)!.children![0].memberships;

    expect(viaTaskById).toEqual(viaListing);
    expect(viaEpicChildren).toEqual(viaListing);
  });

  it('an EXPERIMENT membership on a nested epic-child task propagates identically across selectProjectBacklog, selectTaskById, and selectIdeaDecomposition', () => {
    const db = buildMembershipDb();
    const { ideaId, epicId, taskId } = seedFixture(db);
    seedNamedWorkflow(db, 'wf-1', 'sprint');
    seedExperiment(db, { id: 'exp_1', workflowId: 'wf-1', status: 'running', variantAId: 'wfv_a', variantBId: 'wfv_b' });
    seedExperimentSeedTask(db, {
      experimentId: 'exp_1',
      originalTaskId: taskId,
      cloneTaskIdA: 'tsk_clone_a',
      cloneTaskIdB: 'tsk_clone_b',
    });
    db.prepare(`INSERT INTO workflow_variants (id, workflow_id, label) VALUES ('wfv_a', 'wf-1', 'Variant A')`).run();
    db.prepare(`INSERT INTO workflow_variants (id, workflow_id, label) VALUES ('wfv_b', 'wf-1', 'Variant B')`).run();

    const expected = [
      { kind: 'experiment', id: 'exp_1', label: 'sprint: Variant A vs Variant B · exp_1', status: 'running' },
    ];

    const viaListing = selectProjectBacklog(dbAdapter(db), 1).find((t) => t.id === epicId)!.children![0]
      .memberships;
    expect(viaListing).toEqual(expected);

    const viaTaskById = selectTaskById(dbAdapter(db), taskId)!.memberships;
    expect(viaTaskById).toEqual(expected);

    const viaEpicChildren = selectTaskById(dbAdapter(db), epicId)!.children![0].memberships;
    expect(viaEpicChildren).toEqual(expected);

    // selectIdeaDecomposition's epic-children pass is a SEPARATE nested query
    // path from selectTaskById's — exercise it too.
    const viaDecomposition = selectIdeaDecomposition(dbAdapter(db), ideaId)!.children!.find(
      (c) => c.id === epicId,
    )!.children![0].memberships;
    expect(viaDecomposition).toEqual(expected);
  });
});

describe('taskListing — experiment membership overlay', () => {
  it('a LIVE experiment (running) projects exactly ONE membership despite the two per-arm mapping rows', () => {
    const db = buildMembershipDb();
    seedTask(db, 'tsk_orig', 'TASK-001', 6);
    seedNamedWorkflow(db, 'wf-1', 'sprint');
    seedExperiment(db, {
      id: 'exp_1',
      workflowId: 'wf-1',
      status: 'running',
      variantAId: 'wfv_a',
      variantBId: 'wfv_b',
    });
    seedExperimentSeedTask(db, {
      experimentId: 'exp_1',
      originalTaskId: 'tsk_orig',
      cloneTaskIdA: 'tsk_clone_a',
      cloneTaskIdB: 'tsk_clone_b',
    });
    db.prepare(`INSERT INTO workflow_variants (id, workflow_id, label) VALUES ('wfv_a', 'wf-1', 'Variant A')`).run();
    db.prepare(`INSERT INTO workflow_variants (id, workflow_id, label) VALUES ('wfv_b', 'wf-1', 'Variant B')`).run();

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    const task = backlog.find((t) => t.id === 'tsk_orig')!;
    expect(task.memberships).toEqual([
      { kind: 'experiment', id: 'exp_1', label: 'sprint: Variant A vs Variant B · exp_1', status: 'running' },
    ]);
  });

  it('grading is also a live status; decided/abandoned/superseded are excluded', () => {
    const db = buildMembershipDb();
    seedTask(db, 'tsk_a', 'TASK-001', 6);
    seedTask(db, 'tsk_b', 'TASK-002', 6);
    seedNamedWorkflow(db, 'wf-1', 'sprint');
    seedExperiment(db, { id: 'exp_a', workflowId: 'wf-1', status: 'grading', variantAId: 'wfv_a', variantBId: 'wfv_b' });
    seedExperiment(db, { id: 'exp_b', workflowId: 'wf-1', status: 'decided', variantAId: 'wfv_a', variantBId: 'wfv_b' });
    seedExperimentSeedTask(db, { experimentId: 'exp_a', originalTaskId: 'tsk_a', cloneTaskIdA: 'c1', cloneTaskIdB: 'c2' });
    seedExperimentSeedTask(db, { experimentId: 'exp_b', originalTaskId: 'tsk_b', cloneTaskIdA: 'c3', cloneTaskIdB: 'c4' });

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    expect(backlog.find((t) => t.id === 'tsk_a')!.memberships).toHaveLength(1);
    expect(backlog.find((t) => t.id === 'tsk_a')!.memberships[0].status).toBe('grading');
    expect(backlog.find((t) => t.id === 'tsk_b')!.memberships).toEqual([]);
  });

  it.each(['decided', 'abandoned', 'superseded'] as const)(
    'a terminal experiment status (%s) contributes NO membership',
    (status) => {
      const db = buildMembershipDb();
      seedTask(db, 'tsk_a', 'TASK-001', 6);
      seedNamedWorkflow(db, 'wf-1', 'sprint');
      seedExperiment(db, { id: 'exp_a', workflowId: 'wf-1', status, variantAId: 'wfv_a', variantBId: 'wfv_b' });
      seedExperimentSeedTask(db, { experimentId: 'exp_a', originalTaskId: 'tsk_a', cloneTaskIdA: 'c1', cloneTaskIdB: 'c2' });

      const backlog = selectProjectBacklog(dbAdapter(db), 1);
      expect(backlog.find((t) => t.id === 'tsk_a')!.memberships).toEqual([]);
    },
  );

  it('only the VISIBLE ORIGINAL task gets a membership — a hidden per-arm clone does not', () => {
    const db = buildMembershipDb();
    seedTask(db, 'tsk_orig', 'TASK-001', 6);
    seedNamedWorkflow(db, 'wf-1', 'sprint');
    seedExperiment(db, { id: 'exp_1', workflowId: 'wf-1', status: 'running', variantAId: 'wfv_a', variantBId: 'wfv_b' });
    seedExperimentSeedTask(db, {
      experimentId: 'exp_1',
      originalTaskId: 'tsk_orig',
      cloneTaskIdA: 'tsk_clone_a',
      cloneTaskIdB: 'tsk_clone_b',
    });
    // The clone tasks are real rows too (experiment-tagged, hence normally
    // hidden from the default backlog) — pass includeExperimentTagged to make
    // them visible here and prove they still carry NO membership entry.
    db.prepare(
      `INSERT INTO tasks (id, project_id, ref, title, body, board_id, stage_id, experiment_id, created_at)
       VALUES ('tsk_clone_a', 1, 'TASK-CLONE-A', 'clone a', 'b', 'board-1-default', ?, 'exp_1', '2026-01-01T00:00:00.000Z')`,
    ).run(stageId(6));

    const backlog = selectProjectBacklog(dbAdapter(db), 1, { includeExperimentTagged: true });
    expect(backlog.find((t) => t.id === 'tsk_clone_a')!.memberships).toEqual([]);
  });

  it('a real variant arm falls back to the run\'s denormalized variant_label when the variant row is gone', () => {
    const db = buildMembershipDb();
    seedTask(db, 'tsk_orig', 'TASK-001', 6);
    seedNamedWorkflow(db, 'wf-1', 'sprint');
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, variant_label)
       VALUES ('run-a', 'wf-1', 1, 'completed', 'default', 'Snapshot Label A')`,
    ).run();
    seedExperiment(db, {
      id: 'exp_1',
      workflowId: 'wf-1',
      status: 'running',
      variantAId: 'wfv_deleted',
      variantBId: 'wfv_b',
      runAId: 'run-a',
    });
    seedExperimentSeedTask(db, {
      experimentId: 'exp_1',
      originalTaskId: 'tsk_orig',
      cloneTaskIdA: 'tsk_clone_a',
      cloneTaskIdB: 'tsk_clone_b',
    });
    db.prepare(`INSERT INTO workflow_variants (id, workflow_id, label) VALUES ('wfv_b', 'wf-1', 'Variant B')`).run();
    // No 'wfv_deleted' row in workflow_variants — the variant was deleted.

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    expect(backlog.find((t) => t.id === 'tsk_orig')!.memberships[0].label).toBe(
      'sprint: Snapshot Label A vs Variant B · exp_1',
    );
  });

  it('a real variant arm falls back to "Variant <id8>" when neither the variant row nor a run label exists', () => {
    const db = buildMembershipDb();
    seedTask(db, 'tsk_orig', 'TASK-001', 6);
    seedNamedWorkflow(db, 'wf-1', 'sprint');
    seedExperiment(db, {
      id: 'exp_1',
      workflowId: 'wf-1',
      status: 'running',
      variantAId: 'wfv_deleted1',
      variantBId: 'wfv_b',
    });
    seedExperimentSeedTask(db, {
      experimentId: 'exp_1',
      originalTaskId: 'tsk_orig',
      cloneTaskIdA: 'tsk_clone_a',
      cloneTaskIdB: 'tsk_clone_b',
    });
    db.prepare(`INSERT INTO workflow_variants (id, workflow_id, label) VALUES ('wfv_b', 'wf-1', 'Variant B')`).run();

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    expect(backlog.find((t) => t.id === 'tsk_orig')!.memberships[0].label).toBe(
      'sprint: Variant wfv_dele vs Variant B · exp_1',
    );
  });

  it('the baseline sentinel always renders "Current workflow"', () => {
    const db = buildMembershipDb();
    seedTask(db, 'tsk_orig', 'TASK-001', 6);
    seedNamedWorkflow(db, 'wf-1', 'sprint');
    seedExperiment(db, {
      id: 'exp_1',
      workflowId: 'wf-1',
      status: 'running',
      variantAId: '__baseline__',
      variantBId: 'wfv_b',
    });
    seedExperimentSeedTask(db, {
      experimentId: 'exp_1',
      originalTaskId: 'tsk_orig',
      cloneTaskIdA: 'tsk_clone_a',
      cloneTaskIdB: 'tsk_clone_b',
    });
    db.prepare(`INSERT INTO workflow_variants (id, workflow_id, label) VALUES ('wfv_b', 'wf-1', 'Variant B')`).run();

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    expect(backlog.find((t) => t.id === 'tsk_orig')!.memberships[0].label).toBe(
      'sprint: Current workflow vs Variant B · exp_1',
    );
  });

  it('the quick sentinel renders the arm session\'s trimmed name, falling back to "Quick session"', () => {
    const db = buildMembershipDb();
    seedTask(db, 'tsk_orig', 'TASK-001', 6);
    seedTask(db, 'tsk_orig2', 'TASK-002', 6);
    seedNamedWorkflow(db, 'wf-1', 'sprint');
    seedSession(db, 'sess-quick', 'my-quick-session');
    seedExperiment(db, {
      id: 'exp_1',
      workflowId: 'wf-1',
      status: 'running',
      variantAId: '__quick__',
      variantBId: 'wfv_b',
      sessionAId: 'sess-quick',
    });
    seedExperiment(db, {
      id: 'exp_2',
      workflowId: 'wf-1',
      status: 'running',
      variantAId: '__quick__',
      variantBId: 'wfv_b',
      // no sessionAId — the quick session was never hosted / already gone.
    });
    seedExperimentSeedTask(db, {
      experimentId: 'exp_1',
      originalTaskId: 'tsk_orig',
      cloneTaskIdA: 'tsk_clone_a',
      cloneTaskIdB: 'tsk_clone_b',
    });
    seedExperimentSeedTask(db, {
      experimentId: 'exp_2',
      originalTaskId: 'tsk_orig2',
      cloneTaskIdA: 'tsk_clone_c',
      cloneTaskIdB: 'tsk_clone_d',
    });
    db.prepare(`INSERT INTO workflow_variants (id, workflow_id, label) VALUES ('wfv_b', 'wf-1', 'Variant B')`).run();

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    expect(backlog.find((t) => t.id === 'tsk_orig')!.memberships[0].label).toBe(
      'sprint: my-quick-session vs Variant B · exp_1',
    );
    expect(backlog.find((t) => t.id === 'tsk_orig2')!.memberships[0].label).toBe(
      'sprint: Quick session vs Variant B · exp_2',
    );
  });

  it('the workflow-name base falls back to "Experiment" when the workflow row is gone', () => {
    const db = buildMembershipDb();
    seedTask(db, 'tsk_orig', 'TASK-001', 6);
    seedExperiment(db, {
      id: 'exp_1',
      workflowId: 'wf-missing',
      status: 'running',
      variantAId: '__baseline__',
      variantBId: '__quick__',
    });
    seedExperimentSeedTask(db, {
      experimentId: 'exp_1',
      originalTaskId: 'tsk_orig',
      cloneTaskIdA: 'tsk_clone_a',
      cloneTaskIdB: 'tsk_clone_b',
    });

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    expect(backlog.find((t) => t.id === 'tsk_orig')!.memberships[0].label).toBe(
      'Experiment: Current workflow vs Quick session · exp_1',
    );
  });

  it('a task with no live experiment reads back memberships: []', () => {
    const db = buildMembershipDb();
    seedTask(db, 'tsk_orig', 'TASK-001', 6);

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    expect(backlog.find((t) => t.id === 'tsk_orig')!.memberships).toEqual([]);
  });

  it('a task can carry BOTH a sprint and an experiment membership at once', () => {
    const db = buildMembershipDb();
    seedTask(db, 'tsk_orig', 'TASK-001', 6);
    seedNamedWorkflow(db, 'wf-1', 'sprint');
    seedBatch(db, 'bat_1', 'running');
    seedBatchTask(db, 'bat_1', 'tsk_orig');
    seedExperiment(db, {
      id: 'exp_1',
      workflowId: 'wf-1',
      status: 'running',
      variantAId: '__baseline__',
      variantBId: '__quick__',
    });
    seedExperimentSeedTask(db, {
      experimentId: 'exp_1',
      originalTaskId: 'tsk_orig',
      cloneTaskIdA: 'tsk_clone_a',
      cloneTaskIdB: 'tsk_clone_b',
    });

    const backlog = selectProjectBacklog(dbAdapter(db), 1);
    const memberships = backlog.find((t) => t.id === 'tsk_orig')!.memberships;
    expect(memberships).toHaveLength(2);
    expect(memberships.map((m) => m.kind).sort()).toEqual(['experiment', 'sprint']);
  });
});

// ---------------------------------------------------------------------------
// Human prerequisites (migration 137) — recorded, but NON-gating
// ---------------------------------------------------------------------------

describe('taskListing — human prerequisites do not gate readiness', () => {
  function makeHuman(db: Database.Database, id: string): void {
    db.prepare("UPDATE tasks SET executor = 'human' WHERE id = ?").run(id);
  }

  it('a blocking prereq that is a HUMAN task keeps the dependent readyToWork and names it in waitingOnHuman', () => {
    const db = buildDb();
    seedTask(db, 'tsk_a', 'TASK-001', 6);
    seedTask(db, 'tsk_h', 'TASK-009', 5); // NOT at Done — an agent prereq here would block.
    makeHuman(db, 'tsk_h');
    addEdge(db, 'tsk_a', 'tsk_h');

    const a = selectProjectBacklog(dbAdapter(db), 1).find((t) => t.id === 'tsk_a')!;
    // The edge is still TRUTH — it stays in blockedBy.
    expect(a.blockedBy).toEqual([{ taskId: 'tsk_h', ref: 'TASK-009', title: 'Title TASK-009' }]);
    // …but it is not a gate.
    expect(a.readyToWork).toBe(true);
    expect(a.waitingOnHuman).toEqual(['TASK-009']);
  });

  it('an AGENT prereq still blocks, even alongside a human one', () => {
    const db = buildDb();
    seedTask(db, 'tsk_a', 'TASK-001', 6);
    seedTask(db, 'tsk_h', 'TASK-009', 5);
    seedTask(db, 'tsk_b', 'TASK-002', 5);
    makeHuman(db, 'tsk_h');
    addEdge(db, 'tsk_a', 'tsk_h');
    addEdge(db, 'tsk_a', 'tsk_b');

    const a = selectProjectBacklog(dbAdapter(db), 1).find((t) => t.id === 'tsk_a')!;
    expect(a.readyToWork).toBe(false);
    expect(a.waitingOnHuman).toEqual(['TASK-009']);
    expect(a.blockedBy!.map((d) => d.ref).sort()).toEqual(['TASK-002', 'TASK-009']);
  });

  it('a RELATED edge to a human task is advisory only — not in blockedBy, not in waitingOnHuman', () => {
    const db = buildDb();
    seedTask(db, 'tsk_a', 'TASK-001', 6);
    seedTask(db, 'tsk_h', 'TASK-009', 5);
    makeHuman(db, 'tsk_h');
    addEdge(db, 'tsk_a', 'tsk_h', 'related');

    const a = selectProjectBacklog(dbAdapter(db), 1).find((t) => t.id === 'tsk_a')!;
    expect(a.blockedBy).toEqual([]);
    expect(a.waitingOnHuman).toEqual([]);
    expect(a.relatedTo!.map((d) => d.ref)).toEqual(['TASK-009']);
  });

  it('selectTaskById carries the same waitingOnHuman overlay, and projects executor on the row', () => {
    const db = buildDb();
    seedTask(db, 'tsk_a', 'TASK-001', 6);
    seedTask(db, 'tsk_h', 'TASK-009', 5);
    makeHuman(db, 'tsk_h');
    addEdge(db, 'tsk_a', 'tsk_h');

    const a = selectTaskById(dbAdapter(db), 'tsk_a')!;
    expect(a.executor).toBe('agent');
    expect(a.readyToWork).toBe(true);
    expect(a.waitingOnHuman).toEqual(['TASK-009']);

    const h = selectTaskById(dbAdapter(db), 'tsk_h')!;
    expect(h.executor).toBe('human');
  });

  it('ideas and epics project executor agent (they have no such column)', () => {
    const db = buildDb();
    const { ideaId, epicId } = seedFixture(db);
    expect(selectTaskById(dbAdapter(db), ideaId)!.executor).toBe('agent');
    expect(selectTaskById(dbAdapter(db), epicId)!.executor).toBe('agent');
  });

  it('a task with no dependencies reads waitingOnHuman as []', () => {
    const db = buildDb();
    seedTask(db, 'tsk_a', 'TASK-001', 6);
    const a = selectProjectBacklog(dbAdapter(db), 1).find((t) => t.id === 'tsk_a')!;
    expect(a.waitingOnHuman).toEqual([]);
  });
});
