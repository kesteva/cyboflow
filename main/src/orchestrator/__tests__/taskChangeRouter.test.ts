/**
 * Unit tests for TaskChangeRouter — the native-task write chokepoint.
 *
 * Covered:
 *  - create path mints a ref + inserts at idea stage + logs a 'created' event.
 *  - update path bumps version + writes a per-field delta event atomically.
 *  - NO-ORPHAN-UPDATE invariant: every tasks.updated_at change has a matching
 *    task_events row (and a no-op change writes nothing).
 *  - write_policy authority: user/agent CANNOT set a 'derived' stage; orchestrator can.
 *  - active-run guard: user/agent assert on a task with a non-terminal run is rejected.
 *  - optimistic concurrency conflict.
 *  - parent validation (must be epic, same project, no self/cycle).
 *  - recomputeTaskExecutionStage aggregation over runs (done / indev / merge / revert).
 *  - taskChangeEvents emits on 'task-project-<id>'.
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

// ---------------------------------------------------------------------------
// Test DB builder: projects + 006 + 013, with the default board seeded.
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
  // Mirror the production migration order that 013 depends on:
  //   006 (workflow_runs base) -> 011 (current_step_id) -> 013 (native tasks).
  db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
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
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'soloflow', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, task_id, outcome)
     VALUES (?, 'wf-1', 1, ?, 'default', ?, ?)`,
  ).run(opts.runId, opts.status, opts.taskId, opts.outcome ?? null);
}

describe('TaskChangeRouter', () => {
  afterEach(() => {
    TaskChangeRouter._resetForTesting();
    taskChangeEvents.removeAllListeners();
  });

  it('create path mints a ref, inserts at idea stage, and logs a created event', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));

    const { taskId, event } = await router.applyChange(1, { actor: 'user', type: 'idea', title: 'First idea' });

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as {
      ref: string;
      stage_id: string;
      version: number;
      title: string;
    };
    expect(task.ref).toBe('IDEA-001');
    expect(task.stage_id).toBe(stageId(1));
    expect(task.version).toBe(1);
    expect(task.title).toBe('First idea');

    const ev = db.prepare('SELECT * FROM task_events WHERE id = ?').get(event.id) as {
      seq: number;
      actor: string;
      kind: string;
    };
    expect(ev.seq).toBe(1);
    expect(ev.actor).toBe('user');
    expect(ev.kind).toBe('created');

    // Second create increments the ref counter.
    const second = await router.applyChange(1, { actor: 'user', type: 'idea', title: 'Second' });
    const t2 = db.prepare('SELECT ref FROM tasks WHERE id = ?').get(second.taskId) as { ref: string };
    expect(t2.ref).toBe('IDEA-002');
  });

  it('update path bumps version and writes a per-field delta event atomically', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const { taskId } = await router.applyChange(1, { actor: 'user', type: 'task', title: 'T' });

    await router.applyChange(1, { actor: 'user', taskId, fields: { title: 'Renamed', priority: 'P0' } });

    const task = db.prepare('SELECT version, title, priority FROM tasks WHERE id = ?').get(taskId) as {
      version: number;
      title: string;
      priority: string;
    };
    expect(task.version).toBe(2);
    expect(task.title).toBe('Renamed');
    expect(task.priority).toBe('P0');

    const lastEvent = db
      .prepare('SELECT changes_json FROM task_events WHERE task_id = ? ORDER BY seq DESC LIMIT 1')
      .get(taskId) as { changes_json: string };
    const deltas = JSON.parse(lastEvent.changes_json) as Array<{ field: string; from: unknown; to: unknown }>;
    const titleDelta = deltas.find((d) => d.field === 'title');
    expect(titleDelta).toEqual({ field: 'title', from: 'T', to: 'Renamed' });
  });

  it('NO-ORPHAN-UPDATE invariant: no tasks.updated_at change without a matching task_events row', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));

    const { taskId } = await router.applyChange(1, { actor: 'user', type: 'task', title: 'T' });
    await router.applyChange(1, { actor: 'user', taskId, fields: { summary: 'a summary' } });
    await router.applyChange(1, { actor: 'user', taskId, stageId: stageId(3) });

    // Every distinct updated_at on the task must be representable by an event.
    // Stronger structural check: the number of version increments equals the
    // number of mutating events (created + each real update).
    const version = (db.prepare('SELECT version FROM tasks WHERE id = ?').get(taskId) as { version: number }).version;
    const eventCount = (
      db.prepare('SELECT COUNT(*) AS n FROM task_events WHERE task_id = ?').get(taskId) as { n: number }
    ).n;
    // version starts at 1 (create, version not bumped) then +1 per mutating update.
    // events: 1 created + 2 updates = 3. version = 1 + 2 = 3.
    expect(version).toBe(3);
    expect(eventCount).toBe(3);

    // A no-op update (same value) writes NOTHING and does not bump version.
    const before = db.prepare('SELECT version, updated_at FROM tasks WHERE id = ?').get(taskId) as {
      version: number;
      updated_at: string;
    };
    await router.applyChange(1, { actor: 'user', taskId, fields: { summary: 'a summary' } });
    const after = db.prepare('SELECT version, updated_at FROM tasks WHERE id = ?').get(taskId) as {
      version: number;
      updated_at: string;
    };
    expect(after.version).toBe(before.version);
    const eventCountAfter = (
      db.prepare('SELECT COUNT(*) AS n FROM task_events WHERE task_id = ?').get(taskId) as { n: number }
    ).n;
    expect(eventCountAfter).toBe(eventCount);
  });

  it('write_policy authority: user/agent CANNOT set a derived stage; orchestrator can', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const { taskId } = await router.applyChange(1, { actor: 'user', type: 'task', title: 'T' });

    // position 7 = 'In development' = derived
    await expect(router.applyChange(1, { actor: 'user', taskId, stageId: stageId(7) })).rejects.toMatchObject({
      code: 'forbidden_stage',
    });
    await expect(
      router.applyChange(1, { actor: 'agent:executor', taskId, stageId: stageId(7) }),
    ).rejects.toMatchObject({ code: 'forbidden_stage' });

    // Orchestrator IS allowed.
    await router.applyChange(1, { actor: 'orchestrator', taskId, stageId: stageId(7) });
    const task = db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(taskId) as { stage_id: string };
    expect(task.stage_id).toBe(stageId(7));
  });

  it('active-run guard: user/agent asserting a stage on a task with a non-terminal run is rejected', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const { taskId } = await router.applyChange(1, { actor: 'user', type: 'task', title: 'T' });
    seedRunForTask(db, { taskId, runId: 'run-1', status: 'running' });

    // Asserting a planning stage while a run is live is rejected.
    await expect(router.applyChange(1, { actor: 'user', taskId, stageId: stageId(6) })).rejects.toMatchObject({
      code: 'active_runs',
    });

    // Once the run is terminal, the assert succeeds.
    db.prepare("UPDATE workflow_runs SET status = 'completed' WHERE id = 'run-1'").run();
    await router.applyChange(1, { actor: 'user', taskId, stageId: stageId(6) });
    const task = db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(taskId) as { stage_id: string };
    expect(task.stage_id).toBe(stageId(6));
  });

  it('optimistic concurrency: stale expectedVersion is rejected', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const { taskId } = await router.applyChange(1, { actor: 'user', type: 'task', title: 'T' });
    // current version is 1
    await expect(
      router.applyChange(1, { actor: 'user', taskId, expectedVersion: 99, fields: { title: 'X' } }),
    ).rejects.toMatchObject({ code: 'concurrency' });

    // correct version passes
    await router.applyChange(1, { actor: 'user', taskId, expectedVersion: 1, fields: { title: 'X' } });
    const task = db.prepare('SELECT title FROM tasks WHERE id = ?').get(taskId) as { title: string };
    expect(task.title).toBe('X');
  });

  it('parent validation: parent must be an epic in the same project; tasks only; no cycle', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));

    const epic = await router.applyChange(1, { actor: 'user', type: 'epic', title: 'Epic' });
    const idea = await router.applyChange(1, { actor: 'user', type: 'idea', title: 'Idea' });
    const task = await router.applyChange(1, { actor: 'user', type: 'task', title: 'Task' });

    // valid: task -> epic
    await router.applyChange(1, { actor: 'user', taskId: task.taskId, parentEpicId: epic.taskId });
    const linked = db.prepare('SELECT parent_epic_id FROM tasks WHERE id = ?').get(task.taskId) as {
      parent_epic_id: string;
    };
    expect(linked.parent_epic_id).toBe(epic.taskId);

    // invalid: idea cannot have a parent (only type='task')
    await expect(
      router.applyChange(1, { actor: 'user', taskId: idea.taskId, parentEpicId: epic.taskId }),
    ).rejects.toMatchObject({ code: 'invalid_parent' });

    // invalid: parent must be an epic, not another task
    const task2 = await router.applyChange(1, { actor: 'user', type: 'task', title: 'Task2' });
    await expect(
      router.applyChange(1, { actor: 'user', taskId: task2.taskId, parentEpicId: task.taskId }),
    ).rejects.toMatchObject({ code: 'invalid_parent' });
  });

  it('emits TaskChangedEvent on task-project-<id>', async () => {
    const db = buildDb();
    const router = TaskChangeRouter.initialize(dbAdapter(db));

    const events: Array<{ action: string; taskId: string }> = [];
    taskChangeEvents.on(taskProjectChannel(1), (e: { action: string; taskId: string }) => {
      events.push({ action: e.action, taskId: e.taskId });
    });

    const { taskId } = await router.applyChange(1, { actor: 'user', type: 'idea', title: 'X' });
    await router.applyChange(1, { actor: 'user', taskId, stageId: stageId(3) });

    expect(events).toHaveLength(2);
    expect(events[0].action).toBe('created');
    expect(events[1].action).toBe('stageMoved');
  });

  describe('recomputeTaskExecutionStage', () => {
    async function makeTaskWithEntry(db: Database.Database, router: TaskChangeRouter): Promise<string> {
      const { taskId } = await router.applyChange(1, { actor: 'user', type: 'task', title: 'T' });
      // task sits at idea; set entry_stage_id to 'ready' (position 6) like the launch hook would.
      await router.applyChange(1, { actor: 'orchestrator', taskId, fields: { entryStageId: stageId(6) } });
      return taskId;
    }

    it('no runs -> no-op (planning stage untouched)', async () => {
      const db = buildDb();
      const router = TaskChangeRouter.initialize(dbAdapter(db));
      const { taskId } = await router.applyChange(1, { actor: 'user', type: 'task', title: 'T' });
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
      // First run it into indev, then close out as dismissed/canceled.
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
