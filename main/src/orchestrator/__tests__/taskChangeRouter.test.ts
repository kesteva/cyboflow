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

      // An idea with NO children — an explicit move to Decomposed must surface
      // 'decomposed'. (Created children would auto-decompose the idea via FIX
      // (B); this case isolates the explicit-move emit semantics.)
      const idea = await router.applyChange(1, { actor: 'user', entityType: 'idea', title: 'Big idea' });

      const actions: string[] = [];
      taskChangeEvents.on(taskProjectChannel(1), (e: TaskChangedEvent) => actions.push(e.action));

      await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: idea.taskId, stageId: stageId(12) });

      const idea2 = db.prepare('SELECT stage_id FROM ideas WHERE id = ?').get(idea.taskId) as { stage_id: string };
      expect(idea2.stage_id).toBe(stageId(12));
      expect(actions).toContain('decomposed');
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

    // FIX-STAGE-MODEL (B): creating the FIRST child (epic OR task) of an idea
    // retires the originating idea to Decomposed automatically; children keep
    // their own create stages (they carry the flow).
    it('creating an epic with originatingIdeaId auto-retires the idea to Decomposed (children unchanged)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));

      const idea = await router.applyChange(1, { actor: 'user', entityType: 'idea', title: 'Big idea' });
      // Idea starts at Idea (position 1) per the type-default.
      expect((db.prepare('SELECT stage_id FROM ideas WHERE id = ?').get(idea.taskId) as { stage_id: string }).stage_id).toBe(
        stageId(1),
      );

      const epic = await router.applyChange(1, {
        actor: 'user',
        entityType: 'epic',
        title: 'E',
        originatingIdeaId: idea.taskId,
      });
      // Let the follow-on decomposition settle on the project queue.
      await router._queueForProject(1).onIdle();

      // The idea retired to Decomposed (position 12)...
      expect((db.prepare('SELECT stage_id FROM ideas WHERE id = ?').get(idea.taskId) as { stage_id: string }).stage_id).toBe(
        stageId(12),
      );
      // ...via an orchestrator-attributed 'decomposed' entity_event.
      const ev = db
        .prepare(
          "SELECT actor, kind FROM entity_events WHERE entity_type = 'idea' AND entity_id = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(idea.taskId) as { actor: string; kind: string };
      expect(ev.actor).toBe('orchestrator');
      expect(ev.kind).toBe('decomposed');

      // The epic child keeps its create stage (Epics extracted, position 4).
      expect((db.prepare('SELECT stage_id FROM epics WHERE id = ?').get(epic.taskId) as { stage_id: string }).stage_id).toBe(
        stageId(4),
      );
    });

    it('creating a task with originatingIdeaId auto-retires the idea to Decomposed', async () => {
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

      expect((db.prepare('SELECT stage_id FROM ideas WHERE id = ?').get(idea.taskId) as { stage_id: string }).stage_id).toBe(
        stageId(12),
      );
      // Task child keeps its create stage (Tasks extracted, position 5).
      expect((db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(task.taskId) as { stage_id: string }).stage_id).toBe(
        stageId(5),
      );
    });

    it('auto-decompose is idempotent: a SECOND child does not double-write the idea decomposition', async () => {
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
      const eventsAfterFirst = eventCount(db, 'idea', idea.taskId);

      // A second child (task under the epic, same originating idea) must NOT
      // re-write the decomposition — the idea is already terminal.
      await router.applyChange(1, {
        actor: 'user',
        entityType: 'task',
        title: 'T',
        parentEpicId: epic.taskId,
        originatingIdeaId: idea.taskId,
      });
      await router._queueForProject(1).onIdle();

      expect(eventCount(db, 'idea', idea.taskId)).toBe(eventsAfterFirst);
      expect((db.prepare('SELECT stage_id FROM ideas WHERE id = ?').get(idea.taskId) as { stage_id: string }).stage_id).toBe(
        stageId(12),
      );
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

    it('epic defaults to Epics extracted (position 4) when no explicit stage is given', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'epic', title: 'E' });
      expect((db.prepare('SELECT stage_id FROM epics WHERE id = ?').get(taskId) as { stage_id: string }).stage_id).toBe(
        stageId(4),
      );
    });

    it('task defaults to Tasks extracted (position 5) when no explicit stage is given', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { taskId } = await router.applyChange(1, { actor: 'user', entityType: 'task', title: 'T' });
      expect((db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(taskId) as { stage_id: string }).stage_id).toBe(
        stageId(5),
      );
    });

    it('an explicit initialStageId STILL wins over the type-default (hybrid override)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      // A task explicitly created at Research (position 2) lands there, not the
      // type-default Tasks-extracted (position 5).
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

    // The SAME event object also went out on the cross-project channel.
    expect(allEvents).toHaveLength(1);
    expect(allEvents[0]).toBe(events[0]);
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
      expect(row.stage_id).toBe(stageId(5)); // NOT a stage move — the column is untouched
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
     * and one direct task on the idea. The follow-on auto-decompose of the
     * idea is allowed to settle before returning.
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
      // create + auto-decompose rows).
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
      expect(ideaEvent?.task.stage_position).toBe(12); // auto-decomposed before delete
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
      // The task's create stage (Tasks extracted, position 5 per the FIX-STAGE
      // type-default) is left untouched when there are no runs to aggregate.
      expect(task.stage_id).toBe(stageId(5));
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
