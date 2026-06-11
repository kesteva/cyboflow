/**
 * Integration tests for the cyboflow.tasks tRPC router — the thin wrapper over
 * TaskChangeRouter (chokepoint) + taskListing (read side).
 *
 * Covered (task-board changes: nullable scope, archive-in-place, hard delete,
 * global subscription channel):
 *  - list / boardsForProject accept `projectId: null` (ALL projects) and still
 *    scope correctly when given a number; zod keeps rejecting non-positive ints.
 *  - archive mutation forwards the `archived` flag to applyChange as
 *    actor='user': true stamps archived_at IN PLACE (stage_id unchanged),
 *    false clears it.
 *  - delete mutation forwards to applyDelete; a non-terminal run on the task
 *    surfaces code:'active_runs' as TRPCError 'CONFLICT' and nothing is
 *    deleted; the happy path removes the entity and returns { taskId }.
 *  - onTaskChanged channel selection: `projectId: null` bridges the
 *    cross-project TASK_ALL_CHANNEL; a number bridges taskProjectChannel(n).
 *
 * Chokepoint semantics (cascades, guards, event emission on both channels) are
 * covered in main/src/orchestrator/__tests__/taskChangeRouter.test.ts — these
 * tests only exercise the wrapper's forwarding + error mapping + bridging.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { isAsyncIterable, callProcedure } from '@trpc/server/unstable-core-do-not-import';
import Database from 'better-sqlite3';
import { TRPCError } from '@trpc/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import {
  TASK_ALL_CHANNEL,
  TaskChangeRouter,
  taskChangeEvents,
  taskProjectChannel,
} from '../../../taskChangeRouter';
import type { BacklogTaskItem, TaskChangedEvent } from '../../../../../../shared/types/tasks';

// ---------------------------------------------------------------------------
// Test DB builder: projects 1 + 2 inserted BEFORE the migrations so 014/015
// seed a default board (+ stages) for BOTH — the nullable-scope tests need two
// projects' worth of boards/entities. Mirrors taskChangeRouter.test.ts.
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
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj 1', '/tmp/p1');
  db.prepare('INSERT INTO projects (id, name, path) VALUES (2, ?, ?)').run('Proj 2', '/tmp/p2');

  const migDir = join(__dirname, '..', '..', '..', '..', 'database', 'migrations');
  // 006 (workflow_runs base) -> 011 (current_step_id) -> 014 (unified tasks) ->
  // 015 (entity-model rebuild) -> 016 (review_items) -> 024 (archive-in-place).
  db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '016_review_items.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '024_archive_in_place.sql'), 'utf-8'));
  return db;
}

/** Build a wired caller: chokepoint initialized + db in tRPC context. */
function buildCaller(db: Database.Database) {
  const adapter = dbAdapter(db);
  TaskChangeRouter.initialize(adapter);
  return appRouter.createCaller(createContext({ db: adapter }));
}

/** Seed a workflow + workflow_run row attached to a task. */
function seedRunForTask(
  db: Database.Database,
  opts: { taskId: string; runId: string; status: string },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, task_id)
     VALUES (?, 'wf-1', 1, ?, 'default', ?)`,
  ).run(opts.runId, opts.status, opts.taskId);
}

/** Minimal BacklogTaskItem for fabricated subscription events. */
function fakeItem(taskId: string, projectId: number): BacklogTaskItem {
  const now = new Date().toISOString();
  return {
    id: taskId,
    project_id: projectId,
    type: 'idea',
    ref: 'IDEA-001',
    title: 'fabricated',
    summary: null,
    body: null,
    priority: 'P2',
    repo: null,
    parent_epic_id: null,
    originating_idea_id: null,
    scope: null,
    board_id: `board-${projectId}-default`,
    stage_id: `stage-board-${projectId}-default-1`,
    archived_at: null,
    version: 1,
    stage_position: 1,
    inFlow: [],
    awaitingReview: false,
    isDone: false,
    created_at: now,
    updated_at: now,
  };
}

function fakeEvent(taskId: string, projectId: number): TaskChangedEvent {
  return { projectId, taskId, action: 'updated', task: fakeItem(taskId, projectId) };
}

describe('cyboflow.tasks router (nullable scope, archive, delete, global subscription)', () => {
  afterEach(() => {
    TaskChangeRouter._resetForTesting();
    taskChangeEvents.removeAllListeners();
  });

  // -------------------------------------------------------------------------
  // list / boardsForProject — nullable projectId
  // -------------------------------------------------------------------------

  it('list accepts projectId: null and returns entities from ALL projects; a number still scopes', async () => {
    const db = buildDb();
    const caller = buildCaller(db);

    const { taskId: idP1 } = await caller.cyboflow.tasks.create({ projectId: 1, title: 'In P1' });
    const { taskId: idP2 } = await caller.cyboflow.tasks.create({ projectId: 2, title: 'In P2' });

    const all = await caller.cyboflow.tasks.list({ projectId: null });
    expect(all.map((t) => t.id).sort()).toEqual([idP1, idP2].sort());

    const scoped = await caller.cyboflow.tasks.list({ projectId: 1 });
    expect(scoped.map((t) => t.id)).toEqual([idP1]);
  });

  it('boardsForProject accepts projectId: null and returns every project board; a number still scopes', async () => {
    const db = buildDb();
    const caller = buildCaller(db);

    const all = await caller.cyboflow.tasks.boardsForProject({ projectId: null });
    expect(all.map((b) => b.id).sort()).toEqual(['board-1-default', 'board-2-default']);

    const scoped = await caller.cyboflow.tasks.boardsForProject({ projectId: 2 });
    expect(scoped.map((b) => b.id)).toEqual(['board-2-default']);
  });

  it('list zod still rejects non-positive projectId numbers', async () => {
    const db = buildDb();
    const caller = buildCaller(db);

    await expect(caller.cyboflow.tasks.list({ projectId: 0 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  // -------------------------------------------------------------------------
  // archive — forwards the archived flag to the chokepoint
  // -------------------------------------------------------------------------

  it('archive {archived:true} stamps archived_at in place (stage unchanged); {archived:false} clears it', async () => {
    const db = buildDb();
    const caller = buildCaller(db);

    const { taskId } = await caller.cyboflow.tasks.create({ projectId: 1, title: 'To archive' });
    const before = await caller.cyboflow.tasks.get({ taskId });
    expect(before?.archived_at).toBeNull();

    const archived = await caller.cyboflow.tasks.archive({
      projectId: 1,
      taskId,
      archived: true,
    });
    expect(archived).toEqual({ taskId });

    const afterArchive = await caller.cyboflow.tasks.get({ taskId });
    expect(afterArchive?.archived_at).not.toBeNull();
    // Archive-in-place: the item KEEPS its stage — no move to a terminal column.
    expect(afterArchive?.stage_id).toBe(before?.stage_id);

    await caller.cyboflow.tasks.archive({ projectId: 1, taskId, archived: false });
    const afterUnarchive = await caller.cyboflow.tasks.get({ taskId });
    expect(afterUnarchive?.archived_at).toBeNull();
  });

  it('archive surfaces a stale expectedVersion as CONFLICT (concurrency)', async () => {
    const db = buildDb();
    const caller = buildCaller(db);

    const { taskId } = await caller.cyboflow.tasks.create({ projectId: 1, title: 'Versioned' });

    await expect(
      caller.cyboflow.tasks.archive({ projectId: 1, taskId, archived: true, expectedVersion: 99 }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('concurrency') });
  });

  // -------------------------------------------------------------------------
  // delete — forwards to applyDelete; active_runs maps to CONFLICT
  // -------------------------------------------------------------------------

  it('delete surfaces active_runs as CONFLICT when the task has a non-terminal run (nothing deleted)', async () => {
    const db = buildDb();
    const caller = buildCaller(db);

    const { taskId } = await caller.cyboflow.tasks.create({
      projectId: 1,
      type: 'task',
      title: 'Running task',
    });
    seedRunForTask(db, { taskId, runId: 'run-live', status: 'running' });

    let thrown: unknown;
    try {
      await caller.cyboflow.tasks.delete({ projectId: 1, taskId });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TRPCError);
    expect((thrown as TRPCError).code).toBe('CONFLICT');
    expect((thrown as TRPCError).message).toContain('active_runs');

    // Guard rejected the whole delete — the row survives.
    const survivor = await caller.cyboflow.tasks.get({ taskId });
    expect(survivor?.id).toBe(taskId);
  });

  it('delete happy path removes the entity and returns { taskId }', async () => {
    const db = buildDb();
    const caller = buildCaller(db);

    const { taskId } = await caller.cyboflow.tasks.create({ projectId: 1, title: 'Doomed' });

    const result = await caller.cyboflow.tasks.delete({ projectId: 1, taskId });
    expect(result).toEqual({ taskId });

    const gone = await caller.cyboflow.tasks.get({ taskId });
    expect(gone).toBeNull();
  });

  // -------------------------------------------------------------------------
  // onTaskChanged — channel selection (null -> TASK_ALL_CHANNEL)
  // -------------------------------------------------------------------------

  /**
   * Subscribe via callProcedure (createCaller doesn't support subscriptions in
   * tRPC v11), emit a probe on the channel the subscriber must NOT be on, then
   * the expected event on the channel it must bridge. If the wrapper picked the
   * wrong channel the probe would arrive first — asserting the FIRST collected
   * event pins the channel selection.
   */
  async function firstSubscribedEvent(
    projectId: number | null,
    emitInOrder: Array<{ channel: string; event: TaskChangedEvent }>,
  ): Promise<TaskChangedEvent> {
    const controller = new AbortController();
    const result = await callProcedure({
      router: appRouter,
      ctx: createContext(),
      path: 'cyboflow.tasks.onTaskChanged',
      type: 'subscription',
      getRawInput: async () => ({ projectId }),
      input: { projectId },
      signal: controller.signal,
      batchIndex: 0,
    });
    expect(isAsyncIterable(result)).toBe(true);
    const iterable = result as AsyncIterable<TaskChangedEvent>;

    // Emit on a macrotask so the for-await iterator has registered its listener.
    setTimeout(() => {
      for (const { channel, event } of emitInOrder) {
        taskChangeEvents.emit(channel, event);
      }
    }, 0);

    const collected: TaskChangedEvent[] = [];
    for await (const ev of iterable) {
      collected.push(ev);
      controller.abort(); // first event is enough — exit the loop
    }
    expect(collected).toHaveLength(1);
    return collected[0];
  }

  it('projectId: null bridges TASK_ALL_CHANNEL (ignores project-scoped channels)', async () => {
    const received = await firstSubscribedEvent(null, [
      { channel: taskProjectChannel(1), event: fakeEvent('task_probe_project', 1) },
      { channel: TASK_ALL_CHANNEL, event: fakeEvent('task_expected_all', 2) },
    ]);
    expect(received.taskId).toBe('task_expected_all');
    // Per-event projectId rides on the payload — the all-channel consumer can
    // still scope per event without a per-project subscription.
    expect(received.projectId).toBe(2);
  }, 10000);

  it('projectId: number bridges taskProjectChannel(n) (ignores TASK_ALL_CHANNEL)', async () => {
    const received = await firstSubscribedEvent(1, [
      { channel: TASK_ALL_CHANNEL, event: fakeEvent('task_probe_all', 2) },
      { channel: taskProjectChannel(1), event: fakeEvent('task_expected_project', 1) },
    ]);
    expect(received.taskId).toBe('task_expected_project');
  }, 10000);
});
