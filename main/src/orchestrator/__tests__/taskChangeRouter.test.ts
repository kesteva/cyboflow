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
 *  - decomposition: moving an idea to Decomposed (position 12) emits action
 *    'decomposed' and leaves children unchanged.
 *  - recomputeTaskExecutionStage aggregation over runs (done / indev / merge / revert).
 *  - taskChangeEvents emits on 'task-project-<id>'; the emitted item carries the
 *    body/scope/lineage fields.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TaskChangeRouter,
  taskChangeEvents,
  taskProjectChannel,
} from '../taskChangeRouter';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import type { DatabaseLike } from '../types';
import type { TaskChangedEvent } from '../../../../shared/types/tasks';

// ---------------------------------------------------------------------------
// Test DB builder: projects + 006 + 011 + 014 + 015, default board seeded.
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
  // 015 (entity-model rebuild: ideas/epics/tasks + entity_events + 12th stage).
  db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
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

    await expect(router.applyChange(1, { actor: 'user', taskId, stageId: stageId(6) })).rejects.toMatchObject({
      code: 'active_runs',
    });

    db.prepare("UPDATE workflow_runs SET status = 'completed' WHERE id = 'run-1'").run();
    await router.applyChange(1, { actor: 'user', taskId, stageId: stageId(6) });
    const task = db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(taskId) as { stage_id: string };
    expect(task.stage_id).toBe(stageId(6));
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
    it('moving an idea to Decomposed (position 12) emits action=decomposed and leaves children unchanged', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));

      const idea = await router.applyChange(1, { actor: 'user', entityType: 'idea', title: 'Big idea' });
      // The idea spawned an epic + task that carry the flow.
      const epic = await router.applyChange(1, {
        actor: 'user',
        entityType: 'epic',
        title: 'E',
        originatingIdeaId: idea.taskId,
      });
      const task = await router.applyChange(1, {
        actor: 'user',
        entityType: 'task',
        title: 'T',
        parentEpicId: epic.taskId,
        originatingIdeaId: idea.taskId,
      });

      const epicStageBefore = (db.prepare('SELECT stage_id FROM epics WHERE id = ?').get(epic.taskId) as {
        stage_id: string;
      }).stage_id;
      const taskStageBefore = (db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(task.taskId) as {
        stage_id: string;
      }).stage_id;

      const actions: string[] = [];
      taskChangeEvents.on(taskProjectChannel(1), (e: TaskChangedEvent) => actions.push(e.action));

      await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: idea.taskId, stageId: stageId(12) });

      const idea2 = db.prepare('SELECT stage_id FROM ideas WHERE id = ?').get(idea.taskId) as { stage_id: string };
      expect(idea2.stage_id).toBe(stageId(12));
      expect(actions).toContain('decomposed');

      // Children are UNCHANGED — they carry the flow.
      expect((db.prepare('SELECT stage_id FROM epics WHERE id = ?').get(epic.taskId) as { stage_id: string }).stage_id).toBe(
        epicStageBefore,
      );
      expect((db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(task.taskId) as { stage_id: string }).stage_id).toBe(
        taskStageBefore,
      );
    });

    it('an ordinary stage move (idea to a non-Decomposed stage) emits stageMoved, not decomposed', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const idea = await router.applyChange(1, { actor: 'user', entityType: 'idea', title: 'I' });

      const actions: string[] = [];
      taskChangeEvents.on(taskProjectChannel(1), (e: TaskChangedEvent) => actions.push(e.action));
      await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: idea.taskId, stageId: stageId(3) });
      expect(actions).toEqual(['stageMoved']);
    });
  });

  // -------------------------------------------------------------------------
  // emit + projection
  // -------------------------------------------------------------------------

  it('emits TaskChangedEvent carrying body/scope/lineage on task-project-<id>', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));

    const events: TaskChangedEvent[] = [];
    taskChangeEvents.on(taskProjectChannel(1), (e: TaskChangedEvent) => events.push(e));

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
      expect(task.stage_id).toBe(stageId(1));
    });

    it('any running run -> indev (position 7)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const taskId = await makeTaskWithEntry(db, router);
      seedRunForTask(db, { taskId, runId: 'r1', status: 'running' });
      await router.recomputeTaskExecutionStage(taskId);
      const task = db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(taskId) as { stage_id: string };
      expect(task.stage_id).toBe(stageId(7));
    });

    it('awaiting_review run -> merge (position 8)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const taskId = await makeTaskWithEntry(db, router);
      seedRunForTask(db, { taskId, runId: 'r1', status: 'awaiting_review' });
      await router.recomputeTaskExecutionStage(taskId);
      const task = db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(taskId) as { stage_id: string };
      expect(task.stage_id).toBe(stageId(8));
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
});

// Compile-time smoke: TaskChangeRouter satisfies a DatabaseLike-injected constructor.
const _typecheck = (db: DatabaseLike): TaskChangeRouter => new TaskChangeRouter(db);
void _typecheck;
