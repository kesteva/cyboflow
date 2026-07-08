/**
 * Unit tests for taskMutationHandler — the monitor's non-stopping add/remove/edit
 * task actions on an in-flight programmatic sprint run.
 *
 * The handler funnels task-record writes through an injected applyTaskChange
 * (TaskChangeRouter at the composition root) and lane writes through an injected
 * laneStore (SprintLaneStore). Here applyTaskChange is a realistic fake that
 * actually mutates a minimal in-memory SQLite so the handler's follow-up reads
 * (board_id, ref, stage promotion) behave like production; laneStore is a spy.
 *
 * Standalone: no electron / services imports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import {
  addTaskToRun,
  removeTaskFromRun,
  editRunTask,
  type TaskMutationDeps,
  type TaskMutationLaneStore,
} from '../taskMutationHandler';
import type { TaskChange } from '../taskChangeRouter';

// ---------------------------------------------------------------------------
// Minimal schema covering only what the handler reads/writes.
// ---------------------------------------------------------------------------

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY, project_id INTEGER, batch_id TEXT, execution_model TEXT
    );
    CREATE TABLE sprint_batches (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE sprint_batch_tasks (batch_id TEXT, task_id TEXT, status TEXT);
    CREATE TABLE boards (id TEXT PRIMARY KEY, project_id INTEGER);
    CREATE TABLE board_stages (id TEXT PRIMARY KEY, board_id TEXT, position INTEGER, is_terminal INTEGER DEFAULT 0);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, project_id INTEGER, ref TEXT, title TEXT, body TEXT,
      priority TEXT, board_id TEXT, stage_id TEXT, approved_at TEXT, archived_at TEXT
    );
  `);
  // One board with a Backlog (pos 0) and Ready-for-Dev (pos 6) stage.
  db.prepare('INSERT INTO boards (id, project_id) VALUES (?, ?)').run('board-1', 1);
  db.prepare('INSERT INTO board_stages (id, board_id, position, is_terminal) VALUES (?, ?, ?, 0)').run(
    'stage-backlog',
    'board-1',
    0,
  );
  db.prepare('INSERT INTO board_stages (id, board_id, position, is_terminal) VALUES (?, ?, ?, 0)').run(
    'stage-ready',
    'board-1',
    6,
  );
  return db;
}

function seedRun(
  db: Database.Database,
  opts: { id: string; projectId?: number; batchId?: string | null; model?: string },
): void {
  db.prepare(
    'INSERT INTO workflow_runs (id, project_id, batch_id, execution_model) VALUES (?, ?, ?, ?)',
  ).run(opts.id, opts.projectId ?? 1, opts.batchId ?? null, opts.model ?? 'programmatic');
}

function seedBatch(db: Database.Database, id: string, status = 'running'): void {
  db.prepare('INSERT INTO sprint_batches (id, status) VALUES (?, ?)').run(id, status);
}

function seedLane(db: Database.Database, batchId: string, taskId: string, status = 'queued'): void {
  db.prepare('INSERT INTO sprint_batch_tasks (batch_id, task_id, status) VALUES (?, ?, ?)').run(
    batchId,
    taskId,
    status,
  );
}

function seedTask(
  db: Database.Database,
  opts: {
    id: string;
    ref?: string;
    stageId?: string;
    approvedAt?: string | null;
    projectId?: number;
  },
): void {
  db.prepare(
    `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id, approved_at)
     VALUES (?, ?, ?, ?, 'board-1' , ?, ?)`,
  ).run(
    opts.id,
    opts.projectId ?? 1,
    opts.ref ?? null,
    opts.id,
    opts.stageId ?? 'stage-ready',
    opts.approvedAt ?? '2026-07-07T00:00:00Z',
  );
}

/**
 * A realistic applyTaskChange fake: create inserts a task (Backlog, unapproved)
 * and returns its id; updates mutate stage_id / approved_at / fields in place.
 */
function makeApplyTaskChange(db: Database.Database): {
  fn: (projectId: number, change: TaskChange) => Promise<{ taskId: string }>;
  spy: ReturnType<typeof vi.fn>;
} {
  let seq = 0;
  const spy = vi.fn(async (projectId: number, change: TaskChange) => {
    if (!change.taskId) {
      const id = `task-new-${++seq}`;
      db.prepare(
        `INSERT INTO tasks (id, project_id, ref, title, body, priority, board_id, stage_id, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, 'board-1', 'stage-backlog', NULL)`,
      ).run(id, projectId, `TASK-${100 + seq}`, change.title ?? null, change.body ?? null, change.priority ?? null);
      return { taskId: id };
    }
    if (change.stageId) {
      db.prepare('UPDATE tasks SET stage_id = ? WHERE id = ?').run(change.stageId, change.taskId);
    }
    if (change.approved === true) {
      db.prepare("UPDATE tasks SET approved_at = '2026-07-07T00:00:00Z' WHERE id = ?").run(change.taskId);
    }
    if (change.fields) {
      const f = change.fields;
      if (f.title !== undefined) db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run(f.title, change.taskId);
      if (f.body !== undefined) db.prepare('UPDATE tasks SET body = ? WHERE id = ?').run(f.body, change.taskId);
      if (f.priority !== undefined)
        db.prepare('UPDATE tasks SET priority = ? WHERE id = ?').run(f.priority, change.taskId);
    }
    return { taskId: change.taskId };
  });
  return { fn: spy, spy };
}

class SprintLaneError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

function makeDeps(
  db: Database.Database,
  laneStore: Partial<TaskMutationLaneStore> = {},
): { deps: TaskMutationDeps; applySpy: ReturnType<typeof vi.fn>; deleteSpy: ReturnType<typeof vi.fn> } {
  const { fn, spy } = makeApplyTaskChange(db);
  // Fake applyTaskDelete (TaskChangeRouter.applyDelete at the composition root) —
  // injected for every test, not just Finding-3's compensation cases, so any
  // addTaskToRun call site that hits the addLane-failure path has a real dep.
  const deleteSpy = vi.fn(async (_projectId: number, opts: { taskId: string }) => ({
    taskId: opts.taskId,
    deletedIds: [opts.taskId],
  }));
  const deps: TaskMutationDeps = {
    db: dbAdapter(db),
    applyTaskChange: fn,
    applyTaskDelete: deleteSpy as unknown as TaskMutationDeps['applyTaskDelete'],
    laneStore: {
      addLane: laneStore.addLane ?? (vi.fn(() => ({}) as never) as never),
      removeLane: laneStore.removeLane ?? (vi.fn(() => ({ removed: true })) as never),
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { deps, applySpy: spy, deleteSpy };
}

// ---------------------------------------------------------------------------
// add_task
// ---------------------------------------------------------------------------

describe('addTaskToRun', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('creates + promotes to Ready-for-Dev + approves + enrolls a queued lane', async () => {
    seedRun(db, { id: 'run-1', batchId: 'batch-1' });
    seedBatch(db, 'batch-1', 'running');
    const addLane = vi.fn((_args: { projectId: number; batchId: string; taskId: string }) => ({}) as never);
    const { deps, applySpy, deleteSpy } = makeDeps(db, { addLane });

    const res = await addTaskToRun('run-1', { title: 'New task', body: 'do it' }, deps);

    expect(res.ok).toBe(true);
    // No compensation on the happy path — nothing to undo.
    expect(deleteSpy).not.toHaveBeenCalled();
    // The created task ends up approved + at Ready-for-Dev.
    const t = db.prepare('SELECT stage_id, approved_at FROM tasks ORDER BY rowid DESC LIMIT 1').get() as {
      stage_id: string;
      approved_at: string | null;
    };
    expect(t.stage_id).toBe('stage-ready');
    expect(t.approved_at).not.toBeNull();
    // Lane enrolled with the created task id + batch.
    expect(addLane).toHaveBeenCalledTimes(1);
    const laneArg = addLane.mock.calls[0][0];
    expect(laneArg.batchId).toBe('batch-1');
    expect(laneArg.projectId).toBe(1);
    // create + stage-move + approve = 3 chokepoint writes.
    expect(applySpy).toHaveBeenCalledTimes(3);
  });

  it('refuses not_found / not_programmatic / no_batch', async () => {
    const { deps } = makeDeps(db);
    expect(await addTaskToRun('missing', { title: 'x' }, deps)).toMatchObject({ ok: false, reason: 'not_found' });

    seedRun(db, { id: 'orch', batchId: 'b', model: 'orchestrated' });
    seedBatch(db, 'b');
    expect(await addTaskToRun('orch', { title: 'x' }, deps)).toMatchObject({
      ok: false,
      reason: 'not_programmatic',
    });

    seedRun(db, { id: 'nobatch', batchId: null });
    expect(await addTaskToRun('nobatch', { title: 'x' }, deps)).toMatchObject({ ok: false, reason: 'no_batch' });
  });

  it('refuses a terminal batch WITHOUT creating an orphan task', async () => {
    seedRun(db, { id: 'run-2', batchId: 'batch-done' });
    seedBatch(db, 'batch-done', 'completed');
    const { deps, applySpy, deleteSpy } = makeDeps(db);

    const res = await addTaskToRun('run-2', { title: 'late' }, deps);
    expect(res).toMatchObject({ ok: false, reason: 'no_batch' });
    expect(applySpy).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toMatchObject({ n: 0 });
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('maps a lane no_eligible_tasks failure to not_eligible AND compensates by deleting the orphaned task', async () => {
    seedRun(db, { id: 'run-3', batchId: 'batch-1' });
    seedBatch(db, 'batch-1', 'running');
    const addLane = vi.fn((_args: { projectId: number; batchId: string; taskId: string }) => {
      throw new SprintLaneError('no_eligible_tasks', 'nope');
    });
    const { deps, deleteSpy } = makeDeps(db, { addLane: addLane as never });

    const res = await addTaskToRun('run-3', { title: 'x' }, deps);
    expect(res).toMatchObject({ ok: false, reason: 'not_eligible' });

    // Compensation: the task created + promoted + approved above must be
    // deleted so the refused add leaves no orphan behind.
    const createdTaskId = addLane.mock.calls[0][0].taskId;
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ actor: 'orchestrator', taskId: createdTaskId, entityType: 'task' }),
    );
  });

  it('compensates the orphan when the approval stamp (step 3) throws — never reaching enrollment', async () => {
    seedRun(db, { id: 'run-3b', batchId: 'batch-1' });
    seedBatch(db, 'batch-1', 'running');

    // applyTaskChange: create + stage-move succeed, but the approve stamp throws.
    const createdId = 'task-approve-fail';
    const applyTaskChange = vi.fn(async (projectId: number, change: TaskChange) => {
      if (!change.taskId) {
        db.prepare(
          `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id, approved_at)
           VALUES (?, ?, 'TASK-9', ?, 'board-1', 'stage-backlog', NULL)`,
        ).run(createdId, projectId, change.title ?? null);
        return { taskId: createdId };
      }
      if (change.approved === true) throw new Error('approve boom');
      if (change.stageId) db.prepare('UPDATE tasks SET stage_id = ? WHERE id = ?').run(change.stageId, change.taskId);
      return { taskId: change.taskId };
    });
    const deleteSpy = vi.fn(async (_p: number, opts: { taskId: string }) => ({
      taskId: opts.taskId,
      deletedIds: [opts.taskId],
    }));
    const addLane = vi.fn(() => ({}) as never);
    const deps: TaskMutationDeps = {
      db: dbAdapter(db),
      applyTaskChange: applyTaskChange as never,
      applyTaskDelete: deleteSpy as unknown as TaskMutationDeps['applyTaskDelete'],
      laneStore: { addLane: addLane as never, removeLane: vi.fn(() => ({ removed: true })) as never },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    const res = await addTaskToRun('run-3b', { title: 'boom' }, deps);
    expect(res).toMatchObject({ ok: false, reason: 'lane_error' });
    // The failure was before enrollment, so no lane was created...
    expect(addLane).not.toHaveBeenCalled();
    // ...and the orphaned task was compensated away.
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith(1, expect.objectContaining({ taskId: createdId, entityType: 'task' }));
  });
});

// ---------------------------------------------------------------------------
// remove_task
// ---------------------------------------------------------------------------

describe('removeTaskFromRun', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('removes a queued lane by ref and returns ok', async () => {
    seedRun(db, { id: 'run-1', batchId: 'batch-1' });
    seedBatch(db, 'batch-1');
    seedTask(db, { id: 'task-a', ref: 'TASK-1' });
    const removeLane = vi.fn(() => ({ removed: true }));
    const { deps } = makeDeps(db, { removeLane });

    const res = await removeTaskFromRun('run-1', { taskRef: 'TASK-1' }, deps);
    expect(res).toMatchObject({ ok: true, taskRef: 'TASK-1' });
    expect(removeLane).toHaveBeenCalledWith({ projectId: 1, batchId: 'batch-1', taskId: 'TASK-1' });
  });

  it('maps already-started (bad_request) and unknown (lane_not_found)', async () => {
    seedRun(db, { id: 'run-1', batchId: 'batch-1' });
    seedBatch(db, 'batch-1');
    const started = makeDeps(db, {
      removeLane: vi.fn(() => {
        throw new SprintLaneError('bad_request', 'already running');
      }) as never,
    });
    expect(await removeTaskFromRun('run-1', { taskRef: 'TASK-1' }, started.deps)).toMatchObject({
      ok: false,
      reason: 'already_started',
    });

    const unknown = makeDeps(db, {
      removeLane: vi.fn(() => {
        throw new SprintLaneError('lane_not_found', 'no lane');
      }) as never,
    });
    expect(await removeTaskFromRun('run-1', { taskRef: 'NOPE' }, unknown.deps)).toMatchObject({
      ok: false,
      reason: 'task_not_found',
    });
  });

  it('refuses no_batch', async () => {
    seedRun(db, { id: 'nobatch', batchId: null });
    const { deps } = makeDeps(db);
    expect(await removeTaskFromRun('nobatch', { taskRef: 'TASK-1' }, deps)).toMatchObject({
      ok: false,
      reason: 'no_batch',
    });
  });
});

// ---------------------------------------------------------------------------
// edit_task
// ---------------------------------------------------------------------------

describe('editRunTask', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('updates title/body/priority via the chokepoint (queued lane in this batch)', async () => {
    seedRun(db, { id: 'run-1', batchId: 'batch-1' });
    seedBatch(db, 'batch-1');
    seedTask(db, { id: 'task-a', ref: 'TASK-1' });
    seedLane(db, 'batch-1', 'task-a', 'queued');
    const { deps, applySpy } = makeDeps(db);

    // 'high' is coerced to the canonical Priority 'P0'.
    const res = await editRunTask('run-1', { taskRef: 'TASK-1', title: 'Renamed', priority: 'high' }, deps);
    expect(res).toMatchObject({ ok: true, taskRef: 'TASK-1' });
    expect(applySpy).toHaveBeenCalledTimes(1);
    const change = applySpy.mock.calls[0][1] as TaskChange;
    expect(change.fields).toMatchObject({ title: 'Renamed', priority: 'P0' });
    const t = db.prepare('SELECT title FROM tasks WHERE id = ?').get('task-a') as { title: string };
    expect(t.title).toBe('Renamed');
  });

  it('refuses nothing_to_change and task_not_found', async () => {
    seedRun(db, { id: 'run-1', batchId: 'batch-1' });
    seedBatch(db, 'batch-1');
    seedTask(db, { id: 'task-a', ref: 'TASK-1' });
    seedLane(db, 'batch-1', 'task-a', 'queued');
    const { deps, applySpy } = makeDeps(db);

    expect(await editRunTask('run-1', { taskRef: 'TASK-1' }, deps)).toMatchObject({
      ok: false,
      reason: 'nothing_to_change',
    });
    expect(await editRunTask('run-1', { taskRef: 'GHOST', title: 'x' }, deps)).toMatchObject({
      ok: false,
      reason: 'task_not_found',
    });
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('drops an unrecognized priority (only that field) → nothing_to_change when it was the sole edit', async () => {
    seedRun(db, { id: 'run-1', batchId: 'batch-1' });
    seedBatch(db, 'batch-1');
    seedTask(db, { id: 'task-a', ref: 'TASK-1' });
    seedLane(db, 'batch-1', 'task-a', 'queued');
    const { deps, applySpy } = makeDeps(db);

    // 'someday' is not a valid Priority and maps to nothing, so the edit is empty.
    expect(await editRunTask('run-1', { taskRef: 'TASK-1', priority: 'someday' }, deps)).toMatchObject({
      ok: false,
      reason: 'nothing_to_change',
    });
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('refuses a task whose lane already started (running) as already_started', async () => {
    seedRun(db, { id: 'run-1', batchId: 'batch-1' });
    seedBatch(db, 'batch-1');
    seedTask(db, { id: 'task-a', ref: 'TASK-1' });
    seedLane(db, 'batch-1', 'task-a', 'running');
    const { deps, applySpy } = makeDeps(db);

    expect(await editRunTask('run-1', { taskRef: 'TASK-1', title: 'x' }, deps)).toMatchObject({
      ok: false,
      reason: 'already_started',
    });
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('refuses a task with no lane in this batch as not_in_sprint', async () => {
    seedRun(db, { id: 'run-1', batchId: 'batch-1' });
    seedBatch(db, 'batch-1');
    // task-a exists (same project) but was never enrolled as a lane in batch-1.
    seedTask(db, { id: 'task-a', ref: 'TASK-1' });
    const { deps, applySpy } = makeDeps(db);

    expect(await editRunTask('run-1', { taskRef: 'TASK-1', title: 'x' }, deps)).toMatchObject({
      ok: false,
      reason: 'not_in_sprint',
    });
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('refuses a run with no batchId as no_batch', async () => {
    seedRun(db, { id: 'run-1', batchId: null });
    seedTask(db, { id: 'task-a', ref: 'TASK-1' });
    const { deps, applySpy } = makeDeps(db);

    expect(await editRunTask('run-1', { taskRef: 'TASK-1', title: 'x' }, deps)).toMatchObject({
      ok: false,
      reason: 'no_batch',
    });
    expect(applySpy).not.toHaveBeenCalled();
  });
});
