/**
 * Unit tests for TaskChangeRouter — the entity-aware native-entity write
 * chokepoint (3-table model, migration 015).
 *
 * Covered:
 *  - create path for all 3 types: idea (-> ideas, IDEA-001), epic (-> epics,
 *    EPIC-001), task (-> tasks, TASK-001); each mints a ref + inserts at the
 *    position-1 stage + logs a 'created' entity_events row keyed (type, id).
 *  - update path bumps version + writes a per-field delta event atomically; body
 *    edits are captured.
 *  - NO-ORPHAN-UPDATE invariant: every updated_at change has a matching
 *    entity_events row (and a no-op change writes nothing).
 *  - write_policy authority: user/agent CANNOT set a 'derived' stage; orchestrator can.
 *  - active-run guard; optimistic concurrency conflict.
 *  - lineage: task rejects a non-epic parent + idea-as-parent; epic
 *    originating_idea_id must reference a real idea; cycle rejected.
 *  - decomposition: the `decomposed` toggle stamps ideas.decomposed_at (idea-only,
 *    NOT a stage move), emits action 'decomposed', leaves children unchanged, and
 *    is rejected on epics/tasks; creating a child NO LONGER auto-retires the idea
 *    (retirement is gate-only).
 *  - recomputeTaskExecutionStage aggregation over runs (merged -> done; every other
 *    non-merged run-state -> entry stage, Ready-for-development fallback).
 *  - taskChangeEvents emits on BOTH 'task-project-<id>' AND the cross-project
 *    TASK_ALL_CHANNEL; the emitted item carries the body/scope/lineage fields
 *    plus archived_at + stage_position.
 *  - archive-in-place (migration 024): the `archived` toggle stamps/clears
 *    archived_at (kind 'archived'/'unarchived', version bump, action 'updated');
 *    archiving is guarded by non-terminal runs (non-orchestrator), unarchiving
 *    never is.
 *  - applyDelete: cascade idea -> epics -> tasks (deduped), entity_events
 *    purge, pre-delete snapshots on the 'deleted' emits (both channels),
 *    active-run guard over the cascade, leaf deletes leave siblings/parents
 *    intact, best-effort review_items dismissal (failures swallowed).
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TASK_ALL_CHANNEL,
  TaskChangeRouter,
  taskChangeEvents,
  taskProjectChannel,
} from '../taskChangeRouter';
import { ReviewItemRouter } from '../reviewItemRouter';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import type { DatabaseLike } from '../types';
import type { TaskChangedEvent } from '../../../../shared/types/tasks';

// ---------------------------------------------------------------------------
// Test DB builder: projects + 006 + 011 + 014 + 015 + 016 + 024, default board seeded.
// ---------------------------------------------------------------------------

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
  // 006 (workflow_runs base) -> 011 (current_step_id) -> 014 (unified tasks) ->
  // 015 (entity-model rebuild: ideas/epics/tasks + entity_events + 12th stage) ->
  // 016 (review_items inbox) -> 024 (archive-in-place archived_at + drop stage 11).
  db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '016_review_items.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '024_archive_in_place.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '028_idea_attachments.sql'), 'utf-8'));
  // Migration 042 replaces the position-12 'Decomposed' stage with the
  // ideas.decomposed_at retire stamp AND adds the plan-gate approval stamps
  // (epics/tasks.approved_at + workflow_runs.plan_approved_at). The board
  // collapse itself (removing positions 2,3,4,5,7,8,12) is exercised by
  // migration036.test.ts; here we only add the columns the router now
  // reads/writes, keeping the 12-stage board intact for this file's
  // stage-authority/create-default cases.
  db.exec('ALTER TABLE ideas ADD COLUMN decomposed_at TEXT;');
  db.exec('ALTER TABLE epics ADD COLUMN approved_at TEXT;');
  db.exec('ALTER TABLE tasks ADD COLUMN approved_at TEXT;');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN plan_approved_at TEXT;');
  // Migration 057: manual rank column the sortOrder field-delta writes.
  db.exec(readFileSync(join(migDir, '057_entity_sort_order.sql'), 'utf-8'));
  return db;
}

function stageId(position: number, projectId = 1): string {
  return `stage-board-${projectId}-default-${position}`;
}

function seedRunForTask(
  db: Database.Database,
  opts: { taskId: string; runId: string; status: string; outcome?: string | null },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, task_id, outcome)
     VALUES (?, 'wf-1', 1, ?, 'default', ?, ?)`,
  ).run(opts.runId, opts.status, opts.taskId, opts.outcome ?? null);
}

/** Count the entity_events rows for a (type, id). */
function eventCount(db: Database.Database, type: string, id: string): number {
  return (
    db
      .prepare('SELECT COUNT(*) AS n FROM entity_events WHERE entity_type = ? AND entity_id = ?')
      .get(type, id) as { n: number }
  ).n;
}

describe('TaskChangeRouter (3-table entity model)', () => {
  afterEach(() => {
    TaskChangeRouter._resetForTesting();
    ReviewItemRouter._resetForTesting();
    taskChangeEvents.removeAllListeners();
  });

  // -------------------------------------------------------------------------
  // create — all 3 entity types
  // -------------------------------------------------------------------------

  it('create idea -> ideas table, IDEA-001 at position-1 stage, created entity_event', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));

    const { taskId, event } = await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'First idea',
      body: '# Spec',
      scope: 'large',
    });

    const idea = db.prepare('SELECT * FROM ideas WHERE id = ?').get(taskId) as {
      ref: string;
      stage_id: string;
      version: number;
      title: string;
      body: string | null;
      scope: string | null;
    };
    expect(idea.ref).toBe('IDEA-001');
    expect(idea.stage_id).toBe(stageId(1));
    expect(idea.version).toBe(1);
    expect(idea.title).toBe('First idea');
    expect(idea.body).toBe('# Spec');
    expect(idea.scope).toBe('large');
    expect(taskId.startsWith('ide_')).toBe(true);

    const ev = db
      .prepare('SELECT * FROM entity_events WHERE id = ?')
      .get(event.id) as { seq: number; actor: string; kind: string; entity_type: string };
    expect(ev.seq).toBe(1);
    expect(ev.actor).toBe('user');
    expect(ev.kind).toBe('created');
    expect(ev.entity_type).toBe('idea');

    // Second idea increments the per-type ref counter.
    const second = await router.applyChange(1, { actor: 'user', entityType: 'idea', title: 'Second' });
    const t2 = db.prepare('SELECT ref FROM ideas WHERE id = ?').get(second.taskId) as { ref: string };
    expect(t2.ref).toBe('IDEA-002');
  });

  it('create epic -> epics table, EPIC-001, id prefix epc_', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'epic', title: 'An epic' });
    const epic = db.prepare('SELECT ref FROM epics WHERE id = ?').get(taskId) as { ref: string };
    expect(epic.ref).toBe('EPIC-001');
    expect(taskId.startsWith('epc_')).toBe(true);
    expect(eventCount(db, 'epic', taskId)).toBe(1);
  });

  it('create task -> tasks table, TASK-001, id prefix tsk_', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'task', title: 'A task' });
    const task = db.prepare('SELECT ref FROM tasks WHERE id = ?').get(taskId) as { ref: string };
    expect(task.ref).toBe('TASK-001');
    expect(taskId.startsWith('tsk_')).toBe(true);
    expect(eventCount(db, 'task', taskId)).toBe(1);
  });

  it('per-type ref counters are independent', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const i = await router.applyChange(1, { actor: 'user', entityType: 'idea', title: 'i' });
    const e = await router.applyChange(1, { actor: 'user', entityType: 'epic', title: 'e' });
    const t = await router.applyChange(1, { actor: 'user', entityType: 'task', title: 't' });
    expect((db.prepare('SELECT ref FROM ideas WHERE id = ?').get(i.taskId) as { ref: string }).ref).toBe('IDEA-001');
    expect((db.prepare('SELECT ref FROM epics WHERE id = ?').get(e.taskId) as { ref: string }).ref).toBe('EPIC-001');
    expect((db.prepare('SELECT ref FROM tasks WHERE id = ?').get(t.taskId) as { ref: string }).ref).toBe('TASK-001');
  });

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  it('update path (entityType resolved by id-lookup) bumps version + writes a per-field delta', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'task', title: 'T' });

    // No entityType passed -> resolved by the 3-table id lookup.
    await router.applyChange(1, {
      actor: 'user',
      taskId,
      fields: { title: 'Renamed', priority: 'P0', body: 'new body' },
    });

    const task = db.prepare('SELECT version, title, priority, body FROM tasks WHERE id = ?').get(taskId) as {
      version: number;
      title: string;
      priority: string;
      body: string | null;
    };
    expect(task.version).toBe(2);
    expect(task.title).toBe('Renamed');
    expect(task.priority).toBe('P0');
    expect(task.body).toBe('new body');

    const lastEvent = db
      .prepare(
        "SELECT changes_json FROM entity_events WHERE entity_type = 'task' AND entity_id = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(taskId) as { changes_json: string };
    const deltas = JSON.parse(lastEvent.changes_json) as Array<{ field: string; from: unknown; to: unknown }>;
    expect(deltas.find((d) => d.field === 'title')).toEqual({ field: 'title', from: 'T', to: 'Renamed' });
    expect(deltas.find((d) => d.field === 'body')).toEqual({ field: 'body', from: null, to: 'new body' });
  });

  it('NO-ORPHAN-UPDATE invariant: no version bump without a matching entity_events row', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));

    const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'task', title: 'T' });
    await router.applyChange(1, { actor: 'user', taskId, fields: { summary: 'a summary' } });
    await router.applyChange(1, { actor: 'user', taskId, stageId: stageId(3) });

    const version = (db.prepare('SELECT version FROM tasks WHERE id = ?').get(taskId) as { version: number }).version;
    expect(version).toBe(3);
    expect(eventCount(db, 'task', taskId)).toBe(3);

    // A no-op update writes NOTHING and does not bump version.
    const before = (db.prepare('SELECT version FROM tasks WHERE id = ?').get(taskId) as { version: number }).version;
    await router.applyChange(1, { actor: 'user', taskId, fields: { summary: 'a summary' } });
    const after = (db.prepare('SELECT version FROM tasks WHERE id = ?').get(taskId) as { version: number }).version;
    expect(after).toBe(before);
    expect(eventCount(db, 'task', taskId)).toBe(3);
  });

  it('write_policy authority: user/agent CANNOT set a derived stage; orchestrator can', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'task', title: 'T' });

    await expect(router.applyChange(1, { actor: 'user', taskId, stageId: stageId(7) })).rejects.toMatchObject({
      code: 'forbidden_stage',
    });
    await expect(
      router.applyChange(1, { actor: 'agent:executor', taskId, stageId: stageId(7) }),
    ).rejects.toMatchObject({ code: 'forbidden_stage' });

    await router.applyChange(1, { actor: 'orchestrator', taskId, stageId: stageId(7) });
    const task = db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(taskId) as { stage_id: string };
    expect(task.stage_id).toBe(stageId(7));
  });

  it('active-run guard: user/agent asserting a stage on a task with a non-terminal run is rejected', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'task', title: 'T' });
    seedRunForTask(db, { taskId, runId: 'run-1', status: 'running' });

    // The task already lands at its create default (Ready for development,
    // position 6), so assert a DIFFERENT asserted stage to exercise an actual move.
    await expect(router.applyChange(1, { actor: 'user', taskId, stageId: stageId(1) })).rejects.toMatchObject({
      code: 'active_runs',
    });

    db.prepare("UPDATE workflow_runs SET status = 'completed' WHERE id = 'run-1'").run();
    await router.applyChange(1, { actor: 'user', taskId, stageId: stageId(1) });
    const task = db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(taskId) as { stage_id: string };
    expect(task.stage_id).toBe(stageId(1));
  });

  it('optimistic concurrency: stale expectedVersion is rejected', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'task', title: 'T' });
    await expect(
      router.applyChange(1, { actor: 'user', taskId, expectedVersion: 99, fields: { title: 'X' } }),
    ).rejects.toMatchObject({ code: 'concurrency' });

    await router.applyChange(1, { actor: 'user', taskId, expectedVersion: 1, fields: { title: 'X' } });
    const task = db.prepare('SELECT title FROM tasks WHERE id = ?').get(taskId) as { title: string };
    expect(task.title).toBe('X');
  });

  // -------------------------------------------------------------------------
  // sortOrder (manual rank, migration 057)
  // -------------------------------------------------------------------------

  describe('sortOrder (manual rank, migration 057)', () => {
    it.each([['idea', 'ideas'], ['epic', 'epics'], ['task', 'tasks']] as const)(
      'sortOrder on a %s writes the column + exactly one sort_order delta event',
      async (entityType, table) => {
        const db = buildDb();
        const router = TaskChangeRouter.initialize(dbAdapter(db));
        const { taskId } = await router.applyChange(1, { actor: 'user', entityType, title: 'T' });
        const eventsBefore = eventCount(db, entityType, taskId);

        await router.applyChange(1, { actor: 'user', taskId, fields: { sortOrder: 1.5 } });

        const row = db
          .prepare(`SELECT sort_order, version FROM ${table} WHERE id = ?`)
          .get(taskId) as { sort_order: number | null; version: number };
        expect(row.sort_order).toBe(1.5);
        expect(row.version).toBe(2);

        // Exactly ONE new entity_events row, carrying the sort_order delta.
        expect(eventCount(db, entityType, taskId)).toBe(eventsBefore + 1);
        const lastEvent = db
          .prepare(
            'SELECT changes_json FROM entity_events WHERE entity_type = ? AND entity_id = ? ORDER BY seq DESC LIMIT 1',
          )
          .get(entityType, taskId) as { changes_json: string };
        const deltas = JSON.parse(lastEvent.changes_json) as Array<{
          field: string;
          from: unknown;
          to: unknown;
        }>;
        expect(deltas).toEqual([{ field: 'sort_order', from: null, to: 1.5 }]);
      },
    );

    it('unchanged sortOrder is a no-op: no event, no version bump', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'task', title: 'T' });
      await router.applyChange(1, { actor: 'user', taskId, fields: { sortOrder: 2 } });

      const before = db
        .prepare('SELECT version FROM tasks WHERE id = ?')
        .get(taskId) as { version: number };
      const eventsBefore = eventCount(db, 'task', taskId);

      await router.applyChange(1, { actor: 'user', taskId, fields: { sortOrder: 2 } });

      const after = db
        .prepare('SELECT version FROM tasks WHERE id = ?')
        .get(taskId) as { version: number };
      expect(after.version).toBe(before.version);
      expect(eventCount(db, 'task', taskId)).toBe(eventsBefore);
    });

    it('sortOrder: null clears a set rank (delta from rank to null)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'task', title: 'T' });
      await router.applyChange(1, { actor: 'user', taskId, fields: { sortOrder: 3 } });

      await router.applyChange(1, { actor: 'user', taskId, fields: { sortOrder: null } });

      const row = db
        .prepare('SELECT sort_order FROM tasks WHERE id = ?')
        .get(taskId) as { sort_order: number | null };
      expect(row.sort_order).toBeNull();

      const lastEvent = db
        .prepare(
          "SELECT changes_json FROM entity_events WHERE entity_type = 'task' AND entity_id = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(taskId) as { changes_json: string };
      expect(JSON.parse(lastEvent.changes_json)).toEqual([
        { field: 'sort_order', from: 3, to: null },
      ]);
    });

    it('stale expectedVersion on a sortOrder write is rejected with the concurrency code', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'task', title: 'T' });

      await expect(
        router.applyChange(1, { actor: 'user', taskId, expectedVersion: 99, fields: { sortOrder: 1 } }),
      ).rejects.toMatchObject({ code: 'concurrency' });

      // The rank stays unset and no delta event was written.
      const row = db
        .prepare('SELECT sort_order, version FROM tasks WHERE id = ?')
        .get(taskId) as { sort_order: number | null; version: number };
      expect(row.sort_order).toBeNull();
      expect(row.version).toBe(1);
      expect(eventCount(db, 'task', taskId)).toBe(1); // only 'created'
    });

    it('the emitted event snapshot carries sort_order (live-upsert emit path)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'task', title: 'T' });

      const events: TaskChangedEvent[] = [];
      taskChangeEvents.on(taskProjectChannel(1), (e: TaskChangedEvent) => events.push(e));
      await router.applyChange(1, { actor: 'user', taskId, fields: { sortOrder: 7.25 } });

      expect(events).toHaveLength(1);
      expect(events[0].task?.sort_order).toBe(7.25);
    });
  });

  // -------------------------------------------------------------------------
  // lineage validation
  // -------------------------------------------------------------------------

  describe('lineage', () => {
    it('task parent must be an epic in the same project; reject idea-parent and task-parent', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));

      const epic = await router.applyChange(1, { actor: 'user', entityType: 'epic', title: 'Epic' });
      const idea = await router.applyChange(1, { actor: 'user', entityType: 'idea', title: 'Idea' });
      const task = await router.applyChange(1, { actor: 'user', entityType: 'task', title: 'Task' });

      // valid: task -> epic
      await router.applyChange(1, { actor: 'user', taskId: task.taskId, parentEpicId: epic.taskId });
      const linked = db.prepare('SELECT parent_epic_id FROM tasks WHERE id = ?').get(task.taskId) as {
        parent_epic_id: string;
      };
      expect(linked.parent_epic_id).toBe(epic.taskId);

      // invalid: parent must be an epic — pointing at an idea is rejected (FK + validation).
      await expect(
        router.applyChange(1, { actor: 'user', taskId: task.taskId, parentEpicId: idea.taskId }),
      ).rejects.toMatchObject({ code: 'invalid_parent' });

      // invalid: parent must be an epic, not another task.
      const task2 = await router.applyChange(1, { actor: 'user', entityType: 'task', title: 'Task2' });
      await expect(
        router.applyChange(1, { actor: 'user', taskId: task2.taskId, parentEpicId: task.taskId }),
      ).rejects.toMatchObject({ code: 'invalid_parent' });
    });

    it('only type=task may carry a parent epic (idea/epic rejected)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const epic = await router.applyChange(1, { actor: 'user', entityType: 'epic', title: 'E' });
      const idea = await router.applyChange(1, { actor: 'user', entityType: 'idea', title: 'I' });
      const epic2 = await router.applyChange(1, { actor: 'user', entityType: 'epic', title: 'E2' });

      await expect(
        router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: idea.taskId, parentEpicId: epic.taskId }),
      ).rejects.toMatchObject({ code: 'invalid_parent' });
      await expect(
        router.applyChange(1, { actor: 'user', entityType: 'epic', taskId: epic2.taskId, parentEpicId: epic.taskId }),
      ).rejects.toMatchObject({ code: 'invalid_parent' });
    });

    it('epic originating_idea_id must reference a real idea in the same project', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const idea = await router.applyChange(1, { actor: 'user', entityType: 'idea', title: 'I' });

      // valid: epic created with a real originating idea.
      const epic = await router.applyChange(1, {
        actor: 'user',
        entityType: 'epic',
        title: 'E',
        originatingIdeaId: idea.taskId,
      });
      const row = db.prepare('SELECT originating_idea_id FROM epics WHERE id = ?').get(epic.taskId) as {
        originating_idea_id: string;
      };
      expect(row.originating_idea_id).toBe(idea.taskId);

      // invalid: a missing idea is rejected with invalid_lineage.
      await expect(
        router.applyChange(1, {
          actor: 'user',
          entityType: 'epic',
          title: 'E2',
          originatingIdeaId: 'ide_does_not_exist',
        }),
      ).rejects.toMatchObject({ code: 'invalid_lineage' });
    });

    it('rejects a parent/child cycle: a task cannot be its own parent, and an epic that originates from the child task is rejected', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));

      const task = await router.applyChange(1, { actor: 'user', entityType: 'task', title: 'T' });

      // Self-parent is rejected (the parent must be an epic anyway, so a task id
      // is both a non-epic AND a self reference).
      await expect(
        router.applyChange(1, { actor: 'user', taskId: task.taskId, parentEpicId: task.taskId }),
      ).rejects.toMatchObject({ code: 'invalid_parent' });

      // The cross-table cycle vector (an epic whose originating_idea_id points at
      // the child task) is structurally impossible: that FK targets ideas(id), so
      // a task id cannot be stored there at all.
      expect(() =>
        db
          .prepare(
            `INSERT INTO epics (id, project_id, ref, title, board_id, stage_id, originating_idea_id)
             VALUES ('epc_cycle', 1, 'EPIC-900', 'Cycle epic', 'board-1-default', ?, ?)`,
          )
          .run(stageId(4), task.taskId),
      ).toThrow(/FOREIGN KEY/i);
    });
  });

  // -------------------------------------------------------------------------
  // decomposition
  // -------------------------------------------------------------------------

  describe('decomposition', () => {
    it('the decomposed toggle stamps decomposed_at, emits action=decomposed, keeps the stage', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));

      const idea = await router.applyChange(1, { actor: 'user', entityType: 'idea', title: 'Big idea' });

      const actions: string[] = [];
      taskChangeEvents.on(taskProjectChannel(1), (e: TaskChangedEvent) => actions.push(e.action));

      await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: idea.taskId, decomposed: true });

      const row = db
        .prepare('SELECT stage_id, decomposed_at FROM ideas WHERE id = ?')
        .get(idea.taskId) as { stage_id: string; decomposed_at: string | null };
      // Stamped off the board, but NOT a stage move — the idea keeps position 1.
      expect(row.decomposed_at).not.toBeNull();
      expect(row.stage_id).toBe(stageId(1));
      expect(actions).toContain('decomposed');
      // The stamp is captured as a per-field delta + 'decomposed' event kind.
      const ev = db
        .prepare(
          "SELECT kind, changes_json FROM entity_events WHERE entity_type = 'idea' AND entity_id = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(idea.taskId) as { kind: string; changes_json: string };
      expect(ev.kind).toBe('decomposed');
      const deltas = JSON.parse(ev.changes_json) as Array<{ field: string; from: unknown; to: unknown }>;
      expect(deltas).toHaveLength(1);
      expect(deltas[0].field).toBe('decomposed_at');
      expect(deltas[0].from).toBeNull();
      expect(typeof deltas[0].to).toBe('string');
    });

    it('the decomposed toggle is rejected on an epic/task (idea-only)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const epic = await router.applyChange(1, { actor: 'user', entityType: 'epic', title: 'E' });
      const task = await router.applyChange(1, { actor: 'user', entityType: 'task', title: 'T' });
      await expect(
        router.applyChange(1, { actor: 'user', taskId: epic.taskId, decomposed: true }),
      ).rejects.toMatchObject({ code: 'invalid_lineage' });
      await expect(
        router.applyChange(1, { actor: 'user', taskId: task.taskId, decomposed: true }),
      ).rejects.toMatchObject({ code: 'invalid_lineage' });
    });

    it('a no-op decomposed toggle (already in the requested state) writes nothing', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const idea = await router.applyChange(1, { actor: 'user', entityType: 'idea', title: 'I' });

      await router.applyChange(1, { actor: 'user', taskId: idea.taskId, decomposed: false }); // already on-board
      const row = db.prepare('SELECT version FROM ideas WHERE id = ?').get(idea.taskId) as { version: number };
      expect(row.version).toBe(1);
      expect(eventCount(db, 'idea', idea.taskId)).toBe(1); // only the create event
    });

    it('an ordinary stage move (idea to another stage) emits stageMoved, not decomposed', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const idea = await router.applyChange(1, { actor: 'user', entityType: 'idea', title: 'I' });

      const actions: string[] = [];
      taskChangeEvents.on(taskProjectChannel(1), (e: TaskChangedEvent) => actions.push(e.action));
      await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: idea.taskId, stageId: stageId(3) });
      expect(actions).toEqual(['stageMoved']);
    });

    // Idea retirement is now EXCLUSIVELY gate-driven: creating the first child of
    // an idea NO LONGER auto-retires it (required so the Q1 guard's post-approval
    // child-create does not prematurely retire the idea before the plan settles).
    it('creating an epic with originatingIdeaId does NOT auto-retire the idea (gate-only)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));

      const idea = await router.applyChange(1, { actor: 'user', entityType: 'idea', title: 'Big idea' });

      const epic = await router.applyChange(1, {
        actor: 'user',
        entityType: 'epic',
        title: 'E',
        originatingIdeaId: idea.taskId,
      });
      await router._queueForProject(1).onIdle();

      // The idea stays on the board — decomposed_at NULL, stage unchanged, and no
      // 'decomposed' event was written (only its 'created' row).
      const ideaRow = db
        .prepare('SELECT stage_id, decomposed_at FROM ideas WHERE id = ?')
        .get(idea.taskId) as { stage_id: string; decomposed_at: string | null };
      expect(ideaRow.decomposed_at).toBeNull();
      expect(ideaRow.stage_id).toBe(stageId(1));
      expect(eventCount(db, 'idea', idea.taskId)).toBe(1);

      // The epic child keeps its create stage (Ready for development, position 6).
      expect((db.prepare('SELECT stage_id FROM epics WHERE id = ?').get(epic.taskId) as { stage_id: string }).stage_id).toBe(
        stageId(6),
      );
    });

    it('creating a task with originatingIdeaId does NOT auto-retire the idea (gate-only)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));

      const idea = await router.applyChange(1, { actor: 'user', entityType: 'idea', title: 'Small idea' });
      const task = await router.applyChange(1, {
        actor: 'user',
        entityType: 'task',
        title: 'T',
        originatingIdeaId: idea.taskId,
      });
      await router._queueForProject(1).onIdle();

      const ideaRow = db
        .prepare('SELECT stage_id, decomposed_at FROM ideas WHERE id = ?')
        .get(idea.taskId) as { stage_id: string; decomposed_at: string | null };
      expect(ideaRow.decomposed_at).toBeNull();
      expect(ideaRow.stage_id).toBe(stageId(1));
      expect(eventCount(db, 'idea', idea.taskId)).toBe(1);
      // Task child keeps its create stage (Ready for development, position 6).
      expect((db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(task.taskId) as { stage_id: string }).stage_id).toBe(
        stageId(6),
      );
    });

    // The ship materialize-batch seam has no planner-style human Archive gate, so
    // it calls this public method directly to retire a shipped run's seed idea
    // once the approved plan is materialized into sprint lanes (see
    // mcpQueryHandler.retireRunOwnedIdeas). Lock its contract: stamp decomposed_at
    // (NOT a stage move), idempotent, and a safe no-op for a missing idea.
    it('retireIdeaToDecomposed stamps decomposed_at, idempotently and fail-soft', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));

      const idea = await router.applyChange(1, { actor: 'user', entityType: 'idea', title: 'Shipped idea' });
      expect(
        (db.prepare('SELECT decomposed_at FROM ideas WHERE id = ?').get(idea.taskId) as { decomposed_at: string | null })
          .decomposed_at,
      ).toBeNull();

      // First retire: stamps decomposed_at via an orchestrator 'decomposed' event;
      // the idea keeps its stage (NOT a stage move).
      await router.retireIdeaToDecomposed(1, idea.taskId);
      await router._queueForProject(1).onIdle();
      const retired = db
        .prepare('SELECT stage_id, decomposed_at FROM ideas WHERE id = ?')
        .get(idea.taskId) as { stage_id: string; decomposed_at: string | null };
      expect(retired.decomposed_at).not.toBeNull();
      expect(retired.stage_id).toBe(stageId(1));
      const ev = db
        .prepare(
          "SELECT actor, kind FROM entity_events WHERE entity_type = 'idea' AND entity_id = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(idea.taskId) as { actor: string; kind: string };
      expect(ev).toMatchObject({ actor: 'orchestrator', kind: 'decomposed' });
      const eventsAfterFirst = eventCount(db, 'idea', idea.taskId);

      // Second retire: already stamped -> idempotent no-op, no new event.
      await router.retireIdeaToDecomposed(1, idea.taskId);
      await router._queueForProject(1).onIdle();
      expect(
        (db.prepare('SELECT decomposed_at FROM ideas WHERE id = ?').get(idea.taskId) as { decomposed_at: string | null })
          .decomposed_at,
      ).not.toBeNull();
      expect(eventCount(db, 'idea', idea.taskId)).toBe(eventsAfterFirst);

      // A missing idea is a safe no-op (best-effort housekeeping must never throw).
      await expect(router.retireIdeaToDecomposed(1, 'ide_missing')).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // FIX-STAGE-MODEL (A): create type-default stage
  // -------------------------------------------------------------------------

  describe('create type-default stage', () => {
    it('idea defaults to Idea (position 1) when no explicit stage is given', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'idea', title: 'I' });
      expect((db.prepare('SELECT stage_id FROM ideas WHERE id = ?').get(taskId) as { stage_id: string }).stage_id).toBe(
        stageId(1),
      );
    });

    it('epic defaults to Ready for development (position 6) when no explicit stage is given', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'epic', title: 'E' });
      expect((db.prepare('SELECT stage_id FROM epics WHERE id = ?').get(taskId) as { stage_id: string }).stage_id).toBe(
        stageId(6),
      );
    });

    it('task defaults to Ready for development (position 6) when no explicit stage is given', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'task', title: 'T' });
      expect((db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(taskId) as { stage_id: string }).stage_id).toBe(
        stageId(6),
      );
    });

    it('an explicit initialStageId STILL wins over the type-default (hybrid override)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      // A task explicitly created at Research (position 2) lands there, not the
      // type-default Ready for development (position 6).
      const { taskId } = await router.applyChange(1, {
        actor: 'user',
        entityType: 'task',
        title: 'T',
        initialStageId: stageId(2),
      });
      expect((db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(taskId) as { stage_id: string }).stage_id).toBe(
        stageId(2),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Q1 GUARD: approved_at stamped PENDING at create for plan-gated runs
  // -------------------------------------------------------------------------

  describe('Q1 plan-gate (approved_at on create)', () => {
    /**
     * Seed a workflow_run (workflow id `wf-<name>`) with an optional
     * steps_snapshot_json + plan_approved_at, so the create path can read the
     * creating run's plan-gate status. current_step_id='epics' (a mid-plan step)
     * matches when epics/tasks are minted.
     */
    function seedRun(
      db: Database.Database,
      opts: {
        runId: string;
        workflowName: string;
        stepsSnapshot?: Record<string, string> | null;
        planApprovedAt?: string | null;
      },
    ): void {
      const wfId = `wf-${opts.workflowName}`;
      db.prepare(
        `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, ?, '{}')`,
      ).run(wfId, opts.workflowName);
      db.prepare(
        `INSERT INTO workflow_runs
           (id, workflow_id, project_id, status, permission_mode_snapshot, current_step_id, steps_snapshot_json, plan_approved_at)
         VALUES (?, ?, 1, 'running', 'default', 'epics', ?, ?)`,
      ).run(
        opts.runId,
        wfId,
        opts.stepsSnapshot ? JSON.stringify(opts.stepsSnapshot) : null,
        opts.planApprovedAt ?? null,
      );
    }

    /** The frozen step->agent map a planner/ship run carries (includes the approve-plan gate). */
    const PLAN_GATED_SNAPSHOT = {
      context: 'planner',
      epics: 'planner',
      tasks: 'planner',
      'approve-plan': 'planner',
    } as const;

    function approvedAtOf(db: Database.Database, table: 'epics' | 'tasks', id: string): string | null {
      return (
        db.prepare(`SELECT approved_at FROM ${table} WHERE id = ?`).get(id) as {
          approved_at: string | null;
        }
      ).approved_at;
    }

    it('a TASK created under a plan-gated run with plan_approved_at NULL is PENDING (approved_at NULL)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      seedRun(db, { runId: 'run-plan', workflowName: 'planner', stepsSnapshot: PLAN_GATED_SNAPSHOT });

      const { taskId } = await router.applyChange(1, {
        actor: 'agent:cyboflow-tasks',
        entityType: 'task',
        title: 'Planned task',
        runId: 'run-plan',
      });

      expect(approvedAtOf(db, 'tasks', taskId)).toBeNull();
    });

    it('an EPIC created under a plan-gated run with plan_approved_at NULL is PENDING (approved_at NULL)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      seedRun(db, { runId: 'run-plan', workflowName: 'ship', stepsSnapshot: PLAN_GATED_SNAPSHOT });

      const { taskId } = await router.applyChange(1, {
        actor: 'agent:cyboflow-epics',
        entityType: 'epic',
        title: 'Planned epic',
        runId: 'run-plan',
      });

      expect(approvedAtOf(db, 'epics', taskId)).toBeNull();
    });

    it('a user/manual create (no runId) is VISIBLE (approved_at stamped now)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));

      const { taskId } = await router.applyChange(1, {
        actor: 'user',
        entityType: 'task',
        title: 'Manual task',
      });

      expect(approvedAtOf(db, 'tasks', taskId)).not.toBeNull();
    });

    it('a NON-plan-gated run (sprint snapshot without approve-plan) is VISIBLE', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      seedRun(db, {
        runId: 'run-sprint',
        workflowName: 'sprint',
        stepsSnapshot: { plan: 'sprint', execute: 'sprint' },
      });

      const { taskId } = await router.applyChange(1, {
        actor: 'agent:cyboflow-sprint',
        entityType: 'task',
        title: 'Sprint task',
        runId: 'run-sprint',
      });

      expect(approvedAtOf(db, 'tasks', taskId)).not.toBeNull();
    });

    it('a plan-gated run whose plan is ALREADY approved (plan_approved_at set) is VISIBLE', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      seedRun(db, {
        runId: 'run-approved',
        workflowName: 'planner',
        stepsSnapshot: PLAN_GATED_SNAPSHOT,
        planApprovedAt: '2026-06-30T00:00:00.000Z',
      });

      const { taskId } = await router.applyChange(1, {
        actor: 'agent:cyboflow-tasks',
        entityType: 'task',
        title: 'Post-approval task',
        runId: 'run-approved',
      });

      expect(approvedAtOf(db, 'tasks', taskId)).not.toBeNull();
    });

    it('FALLBACK: a planner run with NO steps_snapshot but plan_approved_at NULL is PENDING', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      seedRun(db, { runId: 'run-nosnap', workflowName: 'planner', stepsSnapshot: null });

      const { taskId } = await router.applyChange(1, {
        actor: 'agent:cyboflow-tasks',
        entityType: 'task',
        title: 'Snapshotless planned task',
        runId: 'run-nosnap',
      });

      expect(approvedAtOf(db, 'tasks', taskId)).toBeNull();
    });

    it('an IDEA is unaffected by the guard (no approved_at column; always on-board)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      seedRun(db, { runId: 'run-plan', workflowName: 'planner', stepsSnapshot: PLAN_GATED_SNAPSHOT });

      // Creating an idea under a plan-gated run still works (ideas carry no
      // approved_at) and lands on the board (decomposed_at NULL).
      const { taskId } = await router.applyChange(1, {
        actor: 'agent:cyboflow-context',
        entityType: 'idea',
        title: 'Planned idea',
        runId: 'run-plan',
      });

      const idea = db
        .prepare('SELECT stage_id, decomposed_at FROM ideas WHERE id = ?')
        .get(taskId) as { stage_id: string; decomposed_at: string | null };
      expect(idea.decomposed_at).toBeNull();
      expect(idea.stage_id).toBe(stageId(1));
    });
  });

  // -------------------------------------------------------------------------
  // emit + projection
  // -------------------------------------------------------------------------

  it('emits TaskChangedEvent carrying body/scope/lineage + archived_at/stage_position on BOTH channels', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));

    const events: TaskChangedEvent[] = [];
    const allEvents: TaskChangedEvent[] = [];
    taskChangeEvents.on(taskProjectChannel(1), (e: TaskChangedEvent) => events.push(e));
    taskChangeEvents.on(TASK_ALL_CHANNEL, (e: TaskChangedEvent) => allEvents.push(e));

    const { taskId } = await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'X',
      body: 'body text',
      scope: 'small',
    });
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('created');
    expect(events[0].task.type).toBe('idea');
    expect(events[0].task.body).toBe('body text');
    expect(events[0].task.scope).toBe('small');
    expect(events[0].task.originating_idea_id).toBeNull();
    expect(events[0].task.id).toBe(taskId);
    // Archive-in-place + cross-project bucketing fields on the projection.
    expect(events[0].task.archived_at).toBeNull();
    expect(events[0].task.stage_position).toBe(1); // idea type-default stage
    // Visibility stamps (migration 042) MUST ride the emit snapshot as explicit
    // null (never undefined): the frontend selectors compare `!== null`, so an
    // omitted stamp hides live-created ideas / reveals pending drafts.
    expect(events[0].task.decomposed_at).toBeNull();
    expect(events[0].task.approved_at).toBeNull();

    // The SAME event object also went out on the cross-project channel.
    expect(allEvents).toHaveLength(1);
    expect(allEvents[0]).toBe(events[0]);
  });

  it('approved toggle is orchestrator-only (agents must not self-approve their drafts)', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'task', title: 'T' });

    await expect(
      router.applyChange(1, { actor: 'agent:cyboflow-tasks', taskId, entityType: 'task', approved: true }),
    ).rejects.toMatchObject({ code: 'forbidden_stage' });
    await expect(
      router.applyChange(1, { actor: 'user', taskId, entityType: 'task', approved: true }),
    ).rejects.toMatchObject({ code: 'forbidden_stage' });
  });

  it('approved toggle rejects ideas (invalid_lineage) and stamps epics via the chokepoint', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const idea = await router.applyChange(1, { actor: 'user', entityType: 'idea', title: 'I' });
    const epic = await router.applyChange(1, { actor: 'user', entityType: 'epic', title: 'E' });

    await expect(
      router.applyChange(1, { actor: 'orchestrator', taskId: idea.taskId, entityType: 'idea', approved: true }),
    ).rejects.toMatchObject({ code: 'invalid_lineage' });

    // Orchestrator reveal: stamps approved_at + mints an entity_event.
    db.prepare('UPDATE epics SET approved_at = NULL WHERE id = ?').run(epic.taskId);
    await router.applyChange(1, {
      actor: 'orchestrator',
      taskId: epic.taskId,
      entityType: 'epic',
      approved: true,
      kind: 'plan-approved',
    });
    const row = db.prepare('SELECT approved_at, version FROM epics WHERE id = ?').get(epic.taskId) as {
      approved_at: string | null;
      version: number;
    };
    expect(row.approved_at).not.toBeNull();
    expect(row.version).toBe(2); // version bumped — a real chokepoint write, not a raw UPDATE
  });

  it('emit snapshot carries approved_at for epics/tasks (visible create -> stamped, not undefined)', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));

    const events: TaskChangedEvent[] = [];
    taskChangeEvents.on(taskProjectChannel(1), (e: TaskChangedEvent) => events.push(e));

    // User create (no runId) -> approved_at = now (visible) and present on the emit.
    await router.applyChange(1, { actor: 'user', entityType: 'task', title: 'T' });
    expect(events).toHaveLength(1);
    expect(typeof events[0].task.approved_at).toBe('string');
    expect(events[0].task.decomposed_at).toBeNull(); // NULL-pattern on non-ideas
  });

  // -------------------------------------------------------------------------
  // archive-in-place (migration 024)
  // -------------------------------------------------------------------------

  describe('archive-in-place', () => {
    it('archived=true stamps archived_at, bumps version, kind=archived, action stays updated', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'task', title: 'T' });

      const actions: string[] = [];
      taskChangeEvents.on(taskProjectChannel(1), (e: TaskChangedEvent) => actions.push(e.action));

      await router.applyChange(1, { actor: 'user', taskId, archived: true });

      const row = db
        .prepare('SELECT archived_at, stage_id, version FROM tasks WHERE id = ?')
        .get(taskId) as { archived_at: string | null; stage_id: string; version: number };
      expect(row.archived_at).not.toBeNull();
      expect(row.stage_id).toBe(stageId(6)); // NOT a stage move — the column is untouched
      expect(row.version).toBe(2);
      expect(actions).toEqual(['updated']);

      const ev = db
        .prepare(
          "SELECT kind, changes_json FROM entity_events WHERE entity_type = 'task' AND entity_id = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(taskId) as { kind: string; changes_json: string };
      expect(ev.kind).toBe('archived');
      const deltas = JSON.parse(ev.changes_json) as Array<{ field: string; from: unknown; to: unknown }>;
      expect(deltas).toHaveLength(1);
      expect(deltas[0].field).toBe('archived_at');
      expect(deltas[0].from).toBeNull();
      expect(typeof deltas[0].to).toBe('string');
    });

    it('archived=false clears archived_at with kind=unarchived (and a version bump)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'epic', title: 'E' });
      await router.applyChange(1, { actor: 'user', taskId, archived: true });

      await router.applyChange(1, { actor: 'user', taskId, archived: false });

      const row = db
        .prepare('SELECT archived_at, version FROM epics WHERE id = ?')
        .get(taskId) as { archived_at: string | null; version: number };
      expect(row.archived_at).toBeNull();
      expect(row.version).toBe(3);

      const ev = db
        .prepare(
          "SELECT kind FROM entity_events WHERE entity_type = 'epic' AND entity_id = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(taskId) as { kind: string };
      expect(ev.kind).toBe('unarchived');
    });

    it('a no-op toggle (already in the requested state) writes nothing', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'task', title: 'T' });

      await router.applyChange(1, { actor: 'user', taskId, archived: false }); // already unarchived
      const row = db.prepare('SELECT version FROM tasks WHERE id = ?').get(taskId) as { version: number };
      expect(row.version).toBe(1);
      expect(eventCount(db, 'task', taskId)).toBe(1); // only the create event
    });

    it('archiving a task with a non-terminal run is rejected for non-orchestrator actors', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'task', title: 'T' });
      seedRunForTask(db, { taskId, runId: 'run-1', status: 'running' });

      await expect(router.applyChange(1, { actor: 'user', taskId, archived: true })).rejects.toMatchObject({
        code: 'active_runs',
      });
      await expect(
        router.applyChange(1, { actor: 'agent:executor', taskId, archived: true }),
      ).rejects.toMatchObject({ code: 'active_runs' });

      // The orchestrator is exempt (it owns run teardown).
      await router.applyChange(1, { actor: 'orchestrator', taskId, archived: true });
      const row = db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get(taskId) as {
        archived_at: string | null;
      };
      expect(row.archived_at).not.toBeNull();
    });

    it('UNarchiving is never guarded, even with an active run', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'task', title: 'T' });
      await router.applyChange(1, { actor: 'orchestrator', taskId, archived: true });
      seedRunForTask(db, { taskId, runId: 'run-1', status: 'running' });

      await router.applyChange(1, { actor: 'user', taskId, archived: false });
      const row = db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get(taskId) as {
        archived_at: string | null;
      };
      expect(row.archived_at).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // applyDelete — hard delete + cascade
  // -------------------------------------------------------------------------

  describe('applyDelete', () => {
    /**
     * Seed an idea family: the idea, one epic originating from it, one task
     * under that epic (ALSO carrying originating_idea_id — exercises dedup),
     * and one direct task on the idea. Any project-queue follow-ons are allowed
     * to settle before returning (the idea is NOT auto-retired — gate-only).
     */
    async function seedFamily(router: TaskChangeRouter): Promise<{
      ideaId: string;
      epicId: string;
      epicTaskId: string;
      directTaskId: string;
    }> {
      const idea = await router.applyChange(1, { actor: 'user', entityType: 'idea', title: 'Idea' });
      const epic = await router.applyChange(1, {
        actor: 'user',
        entityType: 'epic',
        title: 'Epic',
        originatingIdeaId: idea.taskId,
      });
      const epicTask = await router.applyChange(1, {
        actor: 'user',
        entityType: 'task',
        title: 'Epic task',
        parentEpicId: epic.taskId,
        originatingIdeaId: idea.taskId,
      });
      const directTask = await router.applyChange(1, {
        actor: 'user',
        entityType: 'task',
        title: 'Direct task',
        originatingIdeaId: idea.taskId,
      });
      await router._queueForProject(1).onIdle();
      return {
        ideaId: idea.taskId,
        epicId: epic.taskId,
        epicTaskId: epicTask.taskId,
        directTaskId: directTask.taskId,
      };
    }

    function rowCount(db: Database.Database, table: string, id: string): number {
      return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`).get(id) as { n: number }).n;
    }

    it('idea delete cascades epics + tasks (direct AND via epics, deduped) and purges entity_events', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { ideaId, epicId, epicTaskId, directTaskId } = await seedFamily(router);

      const { taskId, deletedIds } = await router.applyDelete(1, { actor: 'user', taskId: ideaId });

      expect(taskId).toBe(ideaId);
      // Deduped: the epic task is reachable BOTH directly and via the epic.
      expect(deletedIds).toHaveLength(4);
      expect(new Set(deletedIds)).toEqual(new Set([ideaId, epicId, epicTaskId, directTaskId]));

      expect(rowCount(db, 'ideas', ideaId)).toBe(0);
      expect(rowCount(db, 'epics', epicId)).toBe(0);
      expect(rowCount(db, 'tasks', epicTaskId)).toBe(0);
      expect(rowCount(db, 'tasks', directTaskId)).toBe(0);

      // entity_events purged for EVERY deleted entity (incl. the idea's
      // 'created' row).
      expect(eventCount(db, 'idea', ideaId)).toBe(0);
      expect(eventCount(db, 'epic', epicId)).toBe(0);
      expect(eventCount(db, 'task', epicTaskId)).toBe(0);
      expect(eventCount(db, 'task', directTaskId)).toBe(0);
    });

    it('epic delete cascades its child tasks only (idea + direct task survive)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { ideaId, epicId, epicTaskId, directTaskId } = await seedFamily(router);

      const { deletedIds } = await router.applyDelete(1, { actor: 'user', taskId: epicId });

      expect(new Set(deletedIds)).toEqual(new Set([epicId, epicTaskId]));
      expect(rowCount(db, 'epics', epicId)).toBe(0);
      expect(rowCount(db, 'tasks', epicTaskId)).toBe(0);
      expect(rowCount(db, 'ideas', ideaId)).toBe(1);
      expect(rowCount(db, 'tasks', directTaskId)).toBe(1);
    });

    it('deleting a leaf task leaves siblings + parent epic intact', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { ideaId, epicId, epicTaskId, directTaskId } = await seedFamily(router);

      const { deletedIds } = await router.applyDelete(1, { actor: 'user', taskId: epicTaskId });

      expect(deletedIds).toEqual([epicTaskId]);
      expect(rowCount(db, 'tasks', epicTaskId)).toBe(0);
      expect(eventCount(db, 'task', epicTaskId)).toBe(0);
      // Siblings + lineage survive untouched.
      expect(rowCount(db, 'tasks', directTaskId)).toBe(1);
      expect(rowCount(db, 'epics', epicId)).toBe(1);
      expect(rowCount(db, 'ideas', ideaId)).toBe(1);
    });

    it("emits action='deleted' with pre-delete snapshots on BOTH channels, root last", async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { ideaId, epicId, epicTaskId, directTaskId } = await seedFamily(router);

      const events: TaskChangedEvent[] = [];
      const allEvents: TaskChangedEvent[] = [];
      taskChangeEvents.on(taskProjectChannel(1), (e: TaskChangedEvent) => events.push(e));
      taskChangeEvents.on(TASK_ALL_CHANNEL, (e: TaskChangedEvent) => allEvents.push(e));

      await router.applyDelete(1, { actor: 'user', taskId: ideaId });

      expect(events).toHaveLength(4);
      expect(events.every((e) => e.action === 'deleted')).toBe(true);
      // Children first, root last (the cascade order).
      expect(events[events.length - 1].taskId).toBe(ideaId);
      expect(new Set(events.map((e) => e.taskId))).toEqual(
        new Set([ideaId, epicId, epicTaskId, directTaskId]),
      );

      // The snapshots were taken BEFORE deletion — full read-model items even
      // though the rows are gone now.
      const ideaEvent = events.find((e) => e.taskId === ideaId);
      expect(ideaEvent?.task.title).toBe('Idea');
      expect(ideaEvent?.task.type).toBe('idea');
      expect(ideaEvent?.task.stage_position).toBe(1); // idea stays on the board (no auto-retire)
      const taskEvent = events.find((e) => e.taskId === epicTaskId);
      expect(taskEvent?.task.parent_epic_id).toBe(epicId);

      // Mirrored 1:1 on the cross-project channel.
      expect(allEvents).toHaveLength(4);
      expect(allEvents.map((e) => e.taskId)).toEqual(events.map((e) => e.taskId));
    });

    it("blocked ('active_runs') by a non-terminal run on a cascade task — nothing is deleted", async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { ideaId, epicId, epicTaskId, directTaskId } = await seedFamily(router);
      seedRunForTask(db, { taskId: epicTaskId, runId: 'run-1', status: 'running' });

      await expect(router.applyDelete(1, { actor: 'user', taskId: ideaId })).rejects.toMatchObject({
        code: 'active_runs',
      });

      // Whole cascade intact — the guard fires before any DELETE.
      expect(rowCount(db, 'ideas', ideaId)).toBe(1);
      expect(rowCount(db, 'epics', epicId)).toBe(1);
      expect(rowCount(db, 'tasks', epicTaskId)).toBe(1);
      expect(rowCount(db, 'tasks', directTaskId)).toBe(1);

      // A terminal run unblocks the delete.
      db.prepare("UPDATE workflow_runs SET status = 'completed' WHERE id = 'run-1'").run();
      const { deletedIds } = await router.applyDelete(1, { actor: 'user', taskId: ideaId });
      expect(deletedIds).toHaveLength(4);
    });

    it('deleting a missing entity rejects with not_found', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      await expect(router.applyDelete(1, { actor: 'user', taskId: 'tsk_missing' })).rejects.toMatchObject({
        code: 'not_found',
      });
    });

    it('pending review_items linked to deleted entities are dismissed via ReviewItemRouter', async () => {
      const db = buildDb();
      const adapter = dbAdapter(db);
      const router = TaskChangeRouter.initialize(adapter);
      const reviewRouter = ReviewItemRouter.initialize(adapter);
      const { ideaId, epicTaskId } = await seedFamily(router);

      // One pending item on the root idea, one on a cascade task.
      const onIdea = await reviewRouter.applyReviewItem(1, {
        op: 'create',
        actor: 'orchestrator',
        kind: 'decision',
        title: 'Pick a direction',
        entityType: 'idea',
        entityId: ideaId,
      });
      const onTask = await reviewRouter.applyReviewItem(1, {
        op: 'create',
        actor: 'orchestrator',
        kind: 'finding',
        title: 'Found a thing',
        entityType: 'task',
        entityId: epicTaskId,
      });

      await router.applyDelete(1, { actor: 'user', taskId: ideaId });

      for (const id of [onIdea.reviewItemId, onTask.reviewItemId]) {
        const row = db
          .prepare('SELECT status, resolution FROM review_items WHERE id = ?')
          .get(id) as { status: string; resolution: string | null };
        expect(row.status).toBe('dismissed');
        expect(row.resolution).toBe('entity deleted');
      }
    });

    it('review-item dismissal failures are swallowed (uninitialized router) — the delete still succeeds', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      // ReviewItemRouter deliberately NOT initialized — getInstance() throws.
      const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'task', title: 'T' });
      db.prepare(
        `INSERT INTO review_items (id, project_id, entity_type, entity_id, kind, title)
         VALUES ('rvw_orphan', 1, 'task', ?, 'finding', 'Linked finding')`,
      ).run(taskId);

      const { deletedIds } = await router.applyDelete(1, { actor: 'user', taskId });
      expect(deletedIds).toEqual([taskId]);
      expect(rowCount(db, 'tasks', taskId)).toBe(0);

      // The dismissal was attempted and failed silently — the item is untouched.
      const row = db.prepare("SELECT status FROM review_items WHERE id = 'rvw_orphan'").get() as {
        status: string;
      };
      expect(row.status).toBe('pending');
    });
  });

  // -------------------------------------------------------------------------
  // deleteRunCreatedEntities — Q1 guard: decline/cancel/dismiss draft cleanup
  // -------------------------------------------------------------------------

  describe('deleteRunCreatedEntities (Q1 guard — decline/cancel/dismiss draft cleanup)', () => {
    function rowCount(db: Database.Database, table: string, id: string): number {
      return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`).get(id) as { n: number }).n;
    }

    /** Seed a workflow_run (FK target for entity_events.run_id) with an optional plan_approved_at. */
    function seedRun(db: Database.Database, opts: { runId: string; planApprovedAt?: string | null }): void {
      db.prepare(
        `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-q1', 1, 'planner', '{}')`,
      ).run();
      db.prepare(
        `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, plan_approved_at)
         VALUES (?, 'wf-q1', 1, 'running', 'default', ?)`,
      ).run(opts.runId, opts.planApprovedAt ?? null);
    }

    /**
     * Seed an idea + one epic (under it) + one ORPHAN task (direct off the idea)
     * + one EPIC-CHILD task (under the epic), ALL created under `runId` (each
     * carries run_id on its 'created' entity_event). Returns their ids.
     */
    async function seedRunDrafts(
      router: TaskChangeRouter,
      runId: string,
    ): Promise<{ ideaId: string; epicId: string; orphanTaskId: string; epicTaskId: string }> {
      const idea = await router.applyChange(1, { actor: 'user', entityType: 'idea', title: 'Idea', runId });
      const epic = await router.applyChange(1, {
        actor: 'user',
        entityType: 'epic',
        title: 'Epic',
        originatingIdeaId: idea.taskId,
        runId,
      });
      const orphanTask = await router.applyChange(1, {
        actor: 'user',
        entityType: 'task',
        title: 'Orphan task',
        originatingIdeaId: idea.taskId,
        runId,
      });
      const epicTask = await router.applyChange(1, {
        actor: 'user',
        entityType: 'task',
        title: 'Epic task',
        parentEpicId: epic.taskId,
        originatingIdeaId: idea.taskId,
        runId,
      });
      await router._queueForProject(1).onIdle();
      return {
        ideaId: idea.taskId,
        epicId: epic.taskId,
        orphanTaskId: orphanTask.taskId,
        epicTaskId: epicTask.taskId,
      };
    }

    it('deletes the run-created epic (with its child tasks) + orphan tasks, but NEVER the seed idea', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      seedRun(db, { runId: 'run-q1' });
      const { ideaId, epicId, orphanTaskId, epicTaskId } = await seedRunDrafts(router, 'run-q1');

      await router.deleteRunCreatedEntities(1, 'run-q1');
      await router._queueForProject(1).onIdle();

      expect(rowCount(db, 'epics', epicId)).toBe(0);
      expect(rowCount(db, 'tasks', epicTaskId)).toBe(0); // taken by the epic cascade
      expect(rowCount(db, 'tasks', orphanTaskId)).toBe(0); // orphan-task pass
      // The seed idea is never in the created-epic/task projection — left intact.
      expect(rowCount(db, 'ideas', ideaId)).toBe(1);
      // entity_events for the deleted entities are purged with them.
      expect(eventCount(db, 'epic', epicId)).toBe(0);
      expect(eventCount(db, 'task', orphanTaskId)).toBe(0);
    });

    it("keyed on run_id: a SIBLING run's created entities are untouched", async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      seedRun(db, { runId: 'run-a' });
      seedRun(db, { runId: 'run-b' });
      const a = await seedRunDrafts(router, 'run-a');
      const b = await seedRunDrafts(router, 'run-b');

      await router.deleteRunCreatedEntities(1, 'run-a');
      await router._queueForProject(1).onIdle();

      // run-a's drafts are gone...
      expect(rowCount(db, 'epics', a.epicId)).toBe(0);
      expect(rowCount(db, 'tasks', a.orphanTaskId)).toBe(0);
      expect(rowCount(db, 'tasks', a.epicTaskId)).toBe(0);
      // ...but run-b's are fully intact (different run_id).
      expect(rowCount(db, 'epics', b.epicId)).toBe(1);
      expect(rowCount(db, 'tasks', b.orphanTaskId)).toBe(1);
      expect(rowCount(db, 'tasks', b.epicTaskId)).toBe(1);
      expect(rowCount(db, 'ideas', b.ideaId)).toBe(1);
    });

    it('no-op when the run is already plan-approved (an approved run survives cancel)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      seedRun(db, { runId: 'run-approved', planApprovedAt: '2026-06-30T00:00:00.000Z' });
      const { ideaId, epicId, orphanTaskId, epicTaskId } = await seedRunDrafts(router, 'run-approved');

      await router.deleteRunCreatedEntities(1, 'run-approved');
      await router._queueForProject(1).onIdle();

      // Nothing deleted — the approved run's revealed entities survive.
      expect(rowCount(db, 'epics', epicId)).toBe(1);
      expect(rowCount(db, 'tasks', orphanTaskId)).toBe(1);
      expect(rowCount(db, 'tasks', epicTaskId)).toBe(1);
      expect(rowCount(db, 'ideas', ideaId)).toBe(1);
    });

    it('no-op for a NON-plan-gated run (compound clean-up tasks survive cancel/dismiss)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      // A compound run: no approve-plan step, non-plan-gated name — its creates
      // land approved_at=now (visible) and plan_approved_at stays NULL forever.
      db.prepare(
        `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-compound', 1, 'compound', '{}')`,
      ).run();
      db.prepare(
        `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
         VALUES ('run-compound', 'wf-compound', 1, 'running', 'default')`,
      ).run();
      const task = await router.applyChange(1, {
        actor: 'agent:cyboflow-compound',
        entityType: 'task',
        title: 'Clean-up task',
        runId: 'run-compound',
      });
      await router._queueForProject(1).onIdle();
      // Sanity: the compound create is VISIBLE (approved at create).
      const approvedAt = (
        db.prepare('SELECT approved_at FROM tasks WHERE id = ?').get(task.taskId) as {
          approved_at: string | null;
        }
      ).approved_at;
      expect(approvedAt).not.toBeNull();

      await router.deleteRunCreatedEntities(1, 'run-compound');
      await router._queueForProject(1).onIdle();

      // plan_approved_at IS NULL for the compound run, but the run is NOT
      // plan-gated — the sweep must not touch its visible entities.
      expect(rowCount(db, 'tasks', task.taskId)).toBe(1);
    });

    it('per-entity gate: an approved_at-stamped draft survives even when the run row says pending', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      seedRun(db, { runId: 'run-mixed' });
      const { epicId, orphanTaskId, epicTaskId } = await seedRunDrafts(router, 'run-mixed');
      // Simulate an inconsistent state: one draft was individually revealed.
      db.prepare('UPDATE tasks SET approved_at = ? WHERE id = ?').run(
        '2026-06-30T00:00:00.000Z',
        orphanTaskId,
      );

      await router.deleteRunCreatedEntities(1, 'run-mixed');
      await router._queueForProject(1).onIdle();

      // Pending drafts swept; the revealed task survives.
      expect(rowCount(db, 'epics', epicId)).toBe(0);
      expect(rowCount(db, 'tasks', epicTaskId)).toBe(0);
      expect(rowCount(db, 'tasks', orphanTaskId)).toBe(1);
    });

    it('F2: a pending run-created epic with a FOREIGN visible child is SPARED (epic + foreign child survive; this run\'s pending child is deleted individually)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      seedRun(db, { runId: 'run-a' }); // plan-gated planner run -> its drafts land PENDING
      const { ideaId, epicId, orphanTaskId, epicTaskId } = await seedRunDrafts(router, 'run-a');

      // A DIFFERENT, non-plan-gated run parents a VISIBLE task under run-a's still-
      // pending epic (the cascade would otherwise destroy it on decline).
      db.prepare(
        `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-vis', 1, 'compound', '{}')`,
      ).run();
      db.prepare(
        `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
         VALUES ('run-vis', 'wf-vis', 1, 'running', 'default')`,
      ).run();
      const foreign = await router.applyChange(1, {
        actor: 'agent:cyboflow-compound',
        entityType: 'task',
        title: 'Foreign visible task',
        parentEpicId: epicId,
        runId: 'run-vis',
      });
      await router._queueForProject(1).onIdle();
      // Sanity: the foreign child is visible (approved at create, foreign run_id).
      expect(
        (db.prepare('SELECT approved_at FROM tasks WHERE id = ?').get(foreign.taskId) as {
          approved_at: string | null;
        }).approved_at,
      ).not.toBeNull();

      await router.deleteRunCreatedEntities(1, 'run-a');
      await router._queueForProject(1).onIdle();

      // The epic is SPARED — its cascade would have destroyed the foreign child.
      expect(rowCount(db, 'epics', epicId)).toBe(1);
      // The foreign visible child survives.
      expect(rowCount(db, 'tasks', foreign.taskId)).toBe(1);
      // This run's OWN pending child under the spared epic is deleted individually.
      expect(rowCount(db, 'tasks', epicTaskId)).toBe(0);
      // The run's orphan pending task (off the idea) is still swept by the orphan pass.
      expect(rowCount(db, 'tasks', orphanTaskId)).toBe(0);
      // The seed idea is untouched.
      expect(rowCount(db, 'ideas', ideaId)).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // recomputeTaskExecutionStage
  // -------------------------------------------------------------------------

  describe('recomputeTaskExecutionStage', () => {
    async function makeTaskWithEntry(db: Database.Database, router: TaskChangeRouter): Promise<string> {
      const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'task', title: 'T' });
      await router.applyChange(1, { actor: 'orchestrator', taskId, fields: { entryStageId: stageId(6) } });
      return taskId;
    }

    it('no runs -> no-op (planning stage untouched)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'task', title: 'T' });
      await router.recomputeTaskExecutionStage(taskId);
      const task = db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(taskId) as { stage_id: string };
      // The task's create stage (Ready for development, position 6 per the
      // type-default) is left untouched when there are no runs to aggregate.
      expect(task.stage_id).toBe(stageId(6));
    });

    it('any running run -> entry stage (no in-development stage; position 6)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const taskId = await makeTaskWithEntry(db, router);
      seedRunForTask(db, { taskId, runId: 'r1', status: 'running' });
      await router.recomputeTaskExecutionStage(taskId);
      const task = db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(taskId) as { stage_id: string };
      expect(task.stage_id).toBe(stageId(6)); // entry_stage_id
    });

    it('awaiting_review run -> entry stage (no ready-to-merge stage; position 6)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const taskId = await makeTaskWithEntry(db, router);
      seedRunForTask(db, { taskId, runId: 'r1', status: 'awaiting_review' });
      await router.recomputeTaskExecutionStage(taskId);
      const task = db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(taskId) as { stage_id: string };
      expect(task.stage_id).toBe(stageId(6)); // entry_stage_id
    });

    it('merged outcome -> done (position 9)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const taskId = await makeTaskWithEntry(db, router);
      seedRunForTask(db, { taskId, runId: 'r1', status: 'completed', outcome: 'merged' });
      await router.recomputeTaskExecutionStage(taskId);
      const task = db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(taskId) as { stage_id: string };
      expect(task.stage_id).toBe(stageId(9));
    });

    it("integrated outcome on a completed run -> entry stage (collapsed, no ready-to-merge stage)", async () => {
      // Parallel-sprint per-task close-out: the run is terminal ('completed') but
      // its outcome='integrated' (merged into the integration branch, not main).
      // With the board collapsed there is no ready-to-merge stage, so — like every
      // other non-merged run-state — it holds the task at its entry stage until a
      // run actually merges into main.
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const taskId = await makeTaskWithEntry(db, router);
      seedRunForTask(db, { taskId, runId: 'r1', status: 'completed', outcome: 'integrated' });
      await router.recomputeTaskExecutionStage(taskId);
      const task = db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(taskId) as { stage_id: string };
      expect(task.stage_id).toBe(stageId(6)); // entry_stage_id
    });

    it('all runs terminal-without-merge -> revert to entry_stage_id', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const taskId = await makeTaskWithEntry(db, router);
      seedRunForTask(db, { taskId, runId: 'r1', status: 'canceled', outcome: 'dismissed' });
      await router.recomputeTaskExecutionStage(taskId);
      const task = db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(taskId) as { stage_id: string };
      expect(task.stage_id).toBe(stageId(6)); // entry_stage_id
    });
  });

  // -------------------------------------------------------------------------
  // recomputeEpicStage — the ROLLUP over an epic's child tasks
  // -------------------------------------------------------------------------

  describe('recomputeEpicStage', () => {
    /** Create an epic (lands at Ready for development, position 6) + N child tasks. */
    async function makeEpicWithChildren(
      db: Database.Database,
      router: TaskChangeRouter,
      n: number,
    ): Promise<{ epicId: string; childIds: string[] }> {
      const { taskId: epicId } = await router.applyChange(1, { actor: 'user', entityType: 'epic', title: 'E' });
      const childIds: string[] = [];
      for (let i = 0; i < n; i++) {
        const { taskId } = await router.applyChange(1, {
          actor: 'user',
          entityType: 'task',
          title: `T${i}`,
          parentEpicId: epicId,
        });
        childIds.push(taskId);
      }
      return { epicId, childIds };
    }

    /** Force a child task onto a board position (direct stage_id set — bypasses the rollup). */
    function setChildStage(db: Database.Database, taskId: string, position: number): void {
      db.prepare('UPDATE tasks SET stage_id = ? WHERE id = ?').run(stageId(position), taskId);
    }

    it('all non-archived children at Done (position 9) -> epic rolls up to Done (9)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { epicId, childIds } = await makeEpicWithChildren(db, router, 2);
      childIds.forEach((id) => setChildStage(db, id, 9));
      await router.recomputeEpicStage(epicId);
      const epic = db.prepare('SELECT stage_id FROM epics WHERE id = ?').get(epicId) as { stage_id: string };
      expect(epic.stage_id).toBe(stageId(9));
    });

    it('one child not-done -> epic holds at Ready for development (6)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { epicId, childIds } = await makeEpicWithChildren(db, router, 2);
      // Pre-stamp the epic at Done to prove the rollup MOVES it back to 6.
      db.prepare('UPDATE epics SET stage_id = ? WHERE id = ?').run(stageId(9), epicId);
      setChildStage(db, childIds[0], 9); // done
      // childIds[1] left at its create stage (position 6) -> not done.
      await router.recomputeEpicStage(epicId);
      const epic = db.prepare('SELECT stage_id FROM epics WHERE id = ?').get(epicId) as { stage_id: string };
      expect(epic.stage_id).toBe(stageId(6));
    });

    it('no (non-archived) children -> unchanged (early-return leaves stage untouched)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { epicId } = await makeEpicWithChildren(db, router, 0);
      // Park the epic somewhere non-default to prove the no-children path is a no-op.
      db.prepare('UPDATE epics SET stage_id = ? WHERE id = ?').run(stageId(9), epicId);
      await router.recomputeEpicStage(epicId);
      const epic = db.prepare('SELECT stage_id FROM epics WHERE id = ?').get(epicId) as { stage_id: string };
      expect(epic.stage_id).toBe(stageId(9));
    });

    it('an archived child is ignored: only non-archived children count toward the rollup', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { epicId, childIds } = await makeEpicWithChildren(db, router, 2);
      setChildStage(db, childIds[0], 9); // done, non-archived
      // childIds[1] is NOT done (position 6) but ARCHIVED -> excluded from the rollup,
      // so the only counted child is Done -> epic rolls up to Done (9).
      db.prepare('UPDATE tasks SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), childIds[1]);
      await router.recomputeEpicStage(epicId);
      const epic = db.prepare('SELECT stage_id FROM epics WHERE id = ?').get(epicId) as { stage_id: string };
      expect(epic.stage_id).toBe(stageId(9));
    });

    it("a Won't-do (position 10) child neither blocks Done nor demotes: done + won't-do children -> epic Done", async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { epicId, childIds } = await makeEpicWithChildren(db, router, 3);
      setChildStage(db, childIds[0], 9);
      setChildStage(db, childIds[1], 9);
      setChildStage(db, childIds[2], 10); // explicit human retirement
      await router.recomputeEpicStage(epicId);
      const epic = db.prepare('SELECT stage_id FROM epics WHERE id = ?').get(epicId) as { stage_id: string };
      expect(epic.stage_id).toBe(stageId(9));
    });

    it("ALL children at Won't-do -> no countable children -> epic stage untouched", async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { epicId, childIds } = await makeEpicWithChildren(db, router, 2);
      childIds.forEach((id) => setChildStage(db, id, 10));
      await router.recomputeEpicStage(epicId);
      const epic = db.prepare('SELECT stage_id FROM epics WHERE id = ?').get(epicId) as { stage_id: string };
      expect(epic.stage_id).toBe(stageId(6)); // create stage — not rewritten
    });

    it("an epic the human parked at Won't-do is NEVER resurrected by the rollup", async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { epicId, childIds } = await makeEpicWithChildren(db, router, 1);
      db.prepare('UPDATE epics SET stage_id = ? WHERE id = ?').run(stageId(10), epicId);
      // Child stage-move fires hook (b) -> recompute -> must respect the parking.
      await router.applyChange(1, { actor: 'orchestrator', taskId: childIds[0], stageId: stageId(9) });
      const epic = db.prepare('SELECT stage_id FROM epics WHERE id = ?').get(epicId) as { stage_id: string };
      expect(epic.stage_id).toBe(stageId(10));
    });

    it('F9: an epic hand-parked at Idea (position 1) is NEVER re-derived by a child move to Done', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { epicId, childIds } = await makeEpicWithChildren(db, router, 1);
      // The rollup owns only the derived pair {6, 9}; a hand-set Idea is asserted.
      db.prepare('UPDATE epics SET stage_id = ? WHERE id = ?').run(stageId(1), epicId);
      await router.applyChange(1, { actor: 'orchestrator', taskId: childIds[0], stageId: stageId(9) });
      await router._queueForProject(1).onIdle();
      const epic = db.prepare('SELECT stage_id FROM epics WHERE id = ?').get(epicId) as { stage_id: string };
      expect(epic.stage_id).toBe(stageId(1));
    });

    it('F9: an epic hand-parked at Idea (position 1) is untouched when a child is archived', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { epicId, childIds } = await makeEpicWithChildren(db, router, 1);
      db.prepare('UPDATE epics SET stage_id = ? WHERE id = ?').run(stageId(1), epicId);
      await router.applyChange(1, { actor: 'user', taskId: childIds[0], archived: true });
      await router._queueForProject(1).onIdle();
      const epic = db.prepare('SELECT stage_id FROM epics WHERE id = ?').get(epicId) as { stage_id: string };
      expect(epic.stage_id).toBe(stageId(1));
    });

    it('F7: re-parenting the last not-Done child re-derives BOTH epics (source rolls to Done, target demotes to Ready-for-dev)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      // Epic A: one Done child + one not-Done child (the "last not-Done" task).
      const a = await makeEpicWithChildren(db, router, 2);
      setChildStage(db, a.childIds[0], 9); // done
      // a.childIds[1] stays at its create stage (position 6) — not done.
      // Epic B: a single Done child, parked at Done (9).
      const b = await makeEpicWithChildren(db, router, 1);
      setChildStage(db, b.childIds[0], 9);
      db.prepare('UPDATE epics SET stage_id = ? WHERE id = ?').run(stageId(9), b.epicId);

      // Re-parent A's not-Done child into B through the chokepoint (fires hook (b)).
      await router.applyChange(1, { actor: 'user', taskId: a.childIds[1], parentEpicId: b.epicId });
      await router._queueForProject(1).onIdle();

      const epicA = db.prepare('SELECT stage_id FROM epics WHERE id = ?').get(a.epicId) as { stage_id: string };
      const epicB = db.prepare('SELECT stage_id FROM epics WHERE id = ?').get(b.epicId) as { stage_id: string };
      expect(epicA.stage_id).toBe(stageId(9)); // A now all-Done -> Done (9)
      expect(epicB.stage_id).toBe(stageId(6)); // B gained a not-Done child -> Ready-for-dev (6)
    });

    it('a PENDING draft child (approved_at NULL) is invisible to the rollup', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { epicId, childIds } = await makeEpicWithChildren(db, router, 2);
      childIds.forEach((id) => setChildStage(db, id, 9));
      db.prepare('UPDATE epics SET stage_id = ? WHERE id = ?').run(stageId(9), epicId);
      // A plan-gated run mints a pending draft under the visible all-Done epic:
      // board-invisible, so it must NOT drag the epic back to 6.
      const draft = await router.applyChange(1, {
        actor: 'user',
        entityType: 'task',
        title: 'pending draft',
        parentEpicId: epicId,
      });
      db.prepare('UPDATE tasks SET approved_at = NULL WHERE id = ?').run(draft.taskId);
      await router.recomputeEpicStage(epicId);
      const epic = db.prepare('SELECT stage_id FROM epics WHERE id = ?').get(epicId) as { stage_id: string };
      expect(epic.stage_id).toBe(stageId(9));
    });

    it('ARCHIVE-TOGGLE hook: archiving the last not-Done child rolls the epic to Done', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { epicId, childIds } = await makeEpicWithChildren(db, router, 2);
      setChildStage(db, childIds[0], 9);
      // childIds[1] not done — archive it THROUGH the chokepoint; the follow-on
      // hook must re-derive the epic without an explicit recompute call.
      await router.applyChange(1, { actor: 'user', taskId: childIds[1], archived: true });
      const epic = db.prepare('SELECT stage_id FROM epics WHERE id = ?').get(epicId) as { stage_id: string };
      expect(epic.stage_id).toBe(stageId(9));
    });

    it('DELETE hook: deleting the last not-Done child rolls the surviving epic to Done', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { epicId, childIds } = await makeEpicWithChildren(db, router, 2);
      setChildStage(db, childIds[0], 9);
      await router.applyDelete(1, { actor: 'user', taskId: childIds[1], entityType: 'task' });
      const epic = db.prepare('SELECT stage_id FROM epics WHERE id = ?').get(epicId) as { stage_id: string };
      expect(epic.stage_id).toBe(stageId(9));
    });

    it('post-commit follow-on: merging all child tasks rolls the epic to Done (9); a new child reverts it to 6', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { epicId, childIds } = await makeEpicWithChildren(db, router, 2);

      // STAGE-MOVE hook (b): move each child to Done (9) via the orchestrator
      // stage-move path (merge / sprint close-out). The post-commit hook rolls the
      // parent epic up after the LAST child reaches Done -> epic auto-moves to 9.
      for (const id of childIds) {
        await router.applyChange(1, { actor: 'orchestrator', taskId: id, stageId: stageId(9) });
      }
      let epic = db.prepare('SELECT stage_id FROM epics WHERE id = ?').get(epicId) as { stage_id: string };
      expect(epic.stage_id).toBe(stageId(9));

      // CHILD-CREATE hook (a): a NEW child (lands at Ready-for-development, 6)
      // revives the all-done epic back to 6 — no rollup call from the test itself.
      await router.applyChange(1, {
        actor: 'user',
        entityType: 'task',
        title: 'T-new',
        parentEpicId: epicId,
      });
      epic = db.prepare('SELECT stage_id FROM epics WHERE id = ?').get(epicId) as { stage_id: string };
      expect(epic.stage_id).toBe(stageId(6));
    });
  });

  // -------------------------------------------------------------------------
  // add-dependency path (task_dependencies write + cycle detection)
  // -------------------------------------------------------------------------

  describe('addDependency', () => {
    /** Create N tasks and return their ids (TASK-001..). */
    async function makeTasks(
      db: Database.Database,
      router: TaskChangeRouter,
      n: number,
    ): Promise<string[]> {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const { taskId } = await router.applyChange(1, {
          actor: 'user',
          entityType: 'task',
          title: `T${i}`,
        });
        ids.push(taskId);
      }
      return ids;
    }

    function depCount(db: Database.Database, taskId: string): number {
      return (
        db
          .prepare('SELECT COUNT(*) AS n FROM task_dependencies WHERE task_id = ?')
          .get(taskId) as { n: number }
      ).n;
    }

    /** The display ref (e.g. TASK-001) the chokepoint minted for an opaque id. */
    function refOf(db: Database.Database, id: string): string {
      return (db.prepare('SELECT ref FROM tasks WHERE id = ?').get(id) as { ref: string }).ref;
    }

    it('inserts a blocking edge + appends a dependency-added entity_event on the blocked task', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const [a, b] = await makeTasks(db, router, 2);

      const before = eventCount(db, 'task', a);
      const { taskId, event } = await router.applyChange(1, {
        actor: 'agent:executor',
        entityType: 'task',
        taskId: a,
        dependsOnTaskId: b,
      });

      expect(taskId).toBe(a);
      const row = db
        .prepare('SELECT task_id, depends_on_task_id, kind FROM task_dependencies WHERE task_id = ?')
        .get(a) as { task_id: string; depends_on_task_id: string; kind: string };
      expect(row).toEqual({ task_id: a, depends_on_task_id: b, kind: 'blocking' });

      // A new entity_events row keyed (task, a) with kind 'dependency-added'.
      expect(eventCount(db, 'task', a)).toBe(before + 1);
      const ev = db
        .prepare('SELECT kind, actor FROM entity_events WHERE entity_type = ? AND entity_id = ? AND seq = ?')
        .get('task', a, event.seq) as { kind: string; actor: string };
      expect(ev.kind).toBe('dependency-added');
      expect(ev.actor).toBe('agent:executor');
    });

    it('records a related edge without participating in the cycle guard', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const [a, b] = await makeTasks(db, router, 2);

      await router.applyChange(1, {
        actor: 'user',
        entityType: 'task',
        taskId: a,
        dependsOnTaskId: b,
        dependencyKind: 'related',
      });

      const row = db
        .prepare('SELECT kind FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?')
        .get(a, b) as { kind: string };
      expect(row.kind).toBe('related');
    });

    it('is idempotent: re-adding the same edge does not double-write the row or a new event', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const [a, b] = await makeTasks(db, router, 2);

      await router.applyChange(1, { actor: 'user', entityType: 'task', taskId: a, dependsOnTaskId: b });
      const eventsAfterFirst = eventCount(db, 'task', a);

      await router.applyChange(1, { actor: 'user', entityType: 'task', taskId: a, dependsOnTaskId: b });

      expect(depCount(db, a)).toBe(1);
      expect(eventCount(db, 'task', a)).toBe(eventsAfterFirst); // no new event
    });

    it('rejects a self-edge with invalid_dependency', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const [a] = await makeTasks(db, router, 1);

      await expect(
        router.applyChange(1, { actor: 'user', entityType: 'task', taskId: a, dependsOnTaskId: a }),
      ).rejects.toMatchObject({ code: 'invalid_dependency' });
      expect(depCount(db, a)).toBe(0);
    });

    it('rejects an edge to a missing task with invalid_dependency', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const [a] = await makeTasks(db, router, 1);

      await expect(
        router.applyChange(1, { actor: 'user', entityType: 'task', taskId: a, dependsOnTaskId: 'tsk_missing' }),
      ).rejects.toMatchObject({ code: 'invalid_dependency' });
    });

    // Ref-or-id resolution (FIND 2026-06-22): agents reasoning over the seeded
    // sprint set only see display refs (the `# Sprint tasks` block renders refs,
    // not opaque ids), so a ref-keyed `cyboflow_add_task_dependency` was rejected
    // `invalid_dependency` even though the task was real. The chokepoint now
    // resolves either endpoint id-or-ref to the canonical id before storage.
    it('resolves both endpoints by display ref, storing the canonical opaque id', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const [a, b] = await makeTasks(db, router, 2);

      const { taskId, dependsOnTaskId } = await router.applyChange(1, {
        actor: 'agent:executor',
        entityType: 'task',
        taskId: refOf(db, a),
        dependsOnTaskId: refOf(db, b),
      });

      // The returned ids AND the stored edge are the OPAQUE ids — not the refs the
      // caller sent — so the edge aligns with the fan-out lane/DAG item ids and the
      // MCP response echoes what was actually stored.
      expect(taskId).toBe(a);
      expect(dependsOnTaskId).toBe(b);
      const row = db
        .prepare('SELECT task_id, depends_on_task_id, kind FROM task_dependencies WHERE task_id = ?')
        .get(a) as { task_id: string; depends_on_task_id: string; kind: string };
      expect(row).toEqual({ task_id: a, depends_on_task_id: b, kind: 'blocking' });
    });

    it('resolves a mixed ref/id edge (ref on one endpoint, opaque id on the other)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const [a, b] = await makeTasks(db, router, 2);

      await router.applyChange(1, {
        actor: 'user',
        entityType: 'task',
        taskId: refOf(db, a), // ref
        dependsOnTaskId: b, // opaque id
      });

      expect(depCount(db, a)).toBe(1);
      const row = db
        .prepare('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?')
        .get(a) as { depends_on_task_id: string };
      expect(row.depends_on_task_id).toBe(b);
    });

    it('rejects a mixed ref/id self-edge (ref + its own opaque id) with invalid_dependency', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const [a] = await makeTasks(db, router, 1);

      await expect(
        router.applyChange(1, { actor: 'user', entityType: 'task', taskId: refOf(db, a), dependsOnTaskId: a }),
      ).rejects.toMatchObject({ code: 'invalid_dependency' });
      expect(depCount(db, a)).toBe(0);
    });

    it('rejects an unknown display ref with invalid_dependency', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const [a] = await makeTasks(db, router, 1);

      await expect(
        router.applyChange(1, { actor: 'user', entityType: 'task', taskId: a, dependsOnTaskId: 'TASK-404' }),
      ).rejects.toMatchObject({ code: 'invalid_dependency' });
      expect(depCount(db, a)).toBe(0);
    });

    it('rejects a back-edge that would create a cycle with dependency_cycle', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const [a, b, c] = await makeTasks(db, router, 3);

      // Build A->B->C (A blocked by B, B blocked by C).
      await router.applyChange(1, { actor: 'user', entityType: 'task', taskId: a, dependsOnTaskId: b });
      await router.applyChange(1, { actor: 'user', entityType: 'task', taskId: b, dependsOnTaskId: c });

      // C blocked by A would close the cycle C->A->B->C.
      await expect(
        router.applyChange(1, { actor: 'user', entityType: 'task', taskId: c, dependsOnTaskId: a }),
      ).rejects.toMatchObject({ code: 'dependency_cycle' });
      // The rejected edge was NOT written.
      expect(depCount(db, c)).toBe(0);
    });

    it('rejects a direct back-edge (A->B then B->A) with dependency_cycle', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const [a, b] = await makeTasks(db, router, 2);

      await router.applyChange(1, { actor: 'user', entityType: 'task', taskId: a, dependsOnTaskId: b });
      await expect(
        router.applyChange(1, { actor: 'user', entityType: 'task', taskId: b, dependsOnTaskId: a }),
      ).rejects.toMatchObject({ code: 'dependency_cycle' });
    });

    it('serializes the write on the per-project queue and commits before resolving', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const [a, b] = await makeTasks(db, router, 2);

      await router.applyChange(1, { actor: 'user', entityType: 'task', taskId: a, dependsOnTaskId: b });
      // The per-project queue is drained once applyChange resolves.
      await router._queueForProject(1).onIdle();
      expect(depCount(db, a)).toBe(1);
    });
  });
});

// Compile-time smoke: TaskChangeRouter satisfies a DatabaseLike-injected constructor.
const _typecheck = (db: DatabaseLike): TaskChangeRouter => new TaskChangeRouter(db);
void _typecheck;
