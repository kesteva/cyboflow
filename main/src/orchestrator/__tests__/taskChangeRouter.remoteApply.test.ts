/**
 * TaskChangeRouter remote-apply mode (cross-machine backlog sync, desktop doc
 * "Router remote-apply mode"), against a FULLY migrated DB.
 *
 * Pinned here:
 *   - remote creates keep the other machine's id, ref, created_at and stamps
 *     verbatim (a pending draft stays pending), tolerate idea_needs_epic, and
 *     reject ref / id collisions with typed codes;
 *   - the remote actor is fenced: no runId, no now-stamping toggles, no
 *     cascading delete, no edge writes outside applyRemoteEdges, and
 *     expectedVersion on every update; remote fields from any other actor fail;
 *   - archive and delete are DEFERRED while a live run (ideas and epics too) or
 *     a pending blocking review item references the entity (spike ruling D1);
 *   - applyRemoteDelete never cascades, treats a missing entity as success, and
 *     re-broadcasts the children whose lineage the FK nulled;
 *   - applyRemoteEdges replaces edge sets atomically and reports cycles and
 *     missing endpoints instead of throwing;
 *   - applyRemoteRefRenames swaps refs through temporaries and records aliases;
 *   - a signed-in machine mints device-prefixed refs in EVERY project (ruling D2).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../../database/database';
import {
  TaskChangeRouter,
  TaskChangeError,
  taskChangeEvents,
  TASK_ALL_CHANNEL,
  type TaskChange,
} from '../taskChangeRouter';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import type { TaskChangedEvent } from '../../../../shared/types/tasks';

const REMOTE = 'cyboflow-remote' as const;
const T0 = '2026-01-02T03:04:05.678Z';

let dir: string;
let svc: DatabaseService;
let db: Database.Database;
let router: TaskChangeRouter;
let projectId: number;
const events: TaskChangedEvent[] = [];
const onEvent = (e: TaskChangedEvent): void => {
  events.push(e);
};

const stage = (pos: number): string => `stage-board-${projectId}-default-${pos}`;
const row = (table: string, id: string): Record<string, unknown> | undefined =>
  db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
const versionOf = (table: string, id: string): number => row(table, id)?.version as number;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    if (err instanceof TaskChangeError) return err.code;
    throw err;
  }
}

function remoteCreate(
  entityType: 'idea' | 'epic' | 'task',
  id: string,
  ref: string,
  extra: Partial<TaskChange> = {},
): Promise<{ taskId: string }> {
  const { remote, ...rest } = extra;
  return router.applyChange(projectId, {
    actor: REMOTE,
    entityType,
    title: `${entityType} ${id}`,
    ...rest,
    remote: { id, ref, createdAt: T0, ...remote },
  });
}

function seedRun(fields: { taskId?: string; seedIdeaId?: string; status?: string }): string {
  const runId = `run-${Math.random().toString(36).slice(2)}`;
  db.prepare(`INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-t', ?, 'sprint', '{}')`).run(projectId);
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, status, policy_json, task_id, seed_idea_id)
     VALUES (?, 'wf-t', ?, '/tmp/x', ?, '{}', ?, ?)`,
  ).run(runId, projectId, fields.status ?? 'running', fields.taskId ?? null, fields.seedIdeaId ?? null);
  return runId;
}

function seedReviewItem(entityType: string, entityId: string, blocking: boolean): string {
  const id = `rvw_${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO review_items (id, project_id, entity_type, entity_id, kind, status, blocking, title)
     VALUES (?, ?, ?, ?, 'finding', 'pending', ?, 'x')`,
  ).run(id, projectId, entityType, entityId, blocking ? 1 : 0);
  return id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cyboflow-remote-apply-'));
  svc = new DatabaseService(join(dir, 'test.db'));
  svc.initialize();
  db = svc.getDb();
  projectId = svc.createProject('P', join(dir, 'proj')).id;
  router = TaskChangeRouter.initialize(dbAdapter(db));
  events.length = 0;
  taskChangeEvents.on(TASK_ALL_CHANNEL, onEvent);
});

afterEach(() => {
  taskChangeEvents.off(TASK_ALL_CHANNEL, onEvent);
  TaskChangeRouter._resetForTesting();
  svc.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('remote create', () => {
  it('keeps the remote id, ref, created_at and a NULL approval verbatim', async () => {
    const { taskId } = await remoteCreate('task', 'tsk_remote1', 'TASK-HOM-007', {
      initialStageId: stage(6),
      remote: { approvedAt: null, archivedAt: '2026-02-01T00:00:00.000Z' },
      fields: { sortOrder: 3 },
    });
    expect(taskId).toBe('tsk_remote1');
    const r = row('tasks', taskId)!;
    expect(r).toMatchObject({
      ref: 'TASK-HOM-007',
      created_at: T0,
      approved_at: null,
      archived_at: '2026-02-01T00:00:00.000Z',
      sort_order: 3,
      version: 1,
    });
    const ev = db.prepare(`SELECT actor, run_id, kind FROM entity_events WHERE entity_id = ?`).get(taskId);
    expect(ev).toEqual({ actor: REMOTE, run_id: null, kind: 'created' });
    expect(events.map((e) => [e.action, e.actor])).toEqual([['created', REMOTE]]);
    // The local counter is untouched: the next local mint is still 001.
    const local = await router.applyChange(projectId, { actor: 'user', entityType: 'task', title: 'l' });
    expect(row('tasks', local.taskId)!.ref).toBe('TASK-001');
  });

  it('writes an idea decomposed stamp verbatim', async () => {
    await remoteCreate('idea', 'ide_r1', 'IDEA-HOM-001', { remote: { decomposedAt: T0 } });
    expect(row('ideas', 'ide_r1')).toMatchObject({ decomposed_at: T0, created_at: T0 });
  });

  it('tolerates a second epic-less task under an idea (idea_needs_epic is accept-then-repair)', async () => {
    await remoteCreate('idea', 'ide_r1', 'IDEA-HOM-001');
    await remoteCreate('task', 'tsk_a', 'TASK-HOM-001', { originatingIdeaId: 'ide_r1' });
    expect(await code(remoteCreate('task', 'tsk_b', 'TASK-HOM-002', { originatingIdeaId: 'ide_r1' }))).toBe('ok');
    // A local write is still held to the invariant.
    expect(
      await code(router.applyChange(projectId, { actor: 'user', entityType: 'task', title: 'c', originatingIdeaId: 'ide_r1' })),
    ).toBe('idea_needs_epic');
  });

  it('rejects a ref or id collision with typed codes', async () => {
    const local = await router.applyChange(projectId, { actor: 'user', entityType: 'task', title: 'l' });
    expect(await code(remoteCreate('task', 'tsk_x', 'TASK-001'))).toBe('ref_conflict');
    expect(await code(remoteCreate('task', local.taskId, 'TASK-HOM-001'))).toBe('concurrency');
    expect(row('tasks', 'tsk_x')).toBeUndefined();
  });
});

describe('remote actor fencing', () => {
  it('rejects malformed remote requests before writing anything', async () => {
    const { taskId } = await remoteCreate('task', 'tsk_r', 'TASK-HOM-001');
    const v = versionOf('tasks', taskId);
    const cases: TaskChange[] = [
      { actor: REMOTE, entityType: 'task', title: 'no remote envelope' },
      { actor: REMOTE, entityType: 'task', title: 't', runId: 'run-x', remote: { id: 'tsk_y', ref: 'TASK-HOM-009', createdAt: T0 } },
      { actor: REMOTE, taskId, fields: { title: 'no expectedVersion' } },
      { actor: REMOTE, taskId, expectedVersion: v, archived: true },
      { actor: REMOTE, taskId, expectedVersion: v, approved: true },
      { actor: REMOTE, taskId, expectedVersion: v, remote: { ref: 'TASK-HOM-099' } },
      { actor: REMOTE, taskId, dependsOnTaskId: taskId },
      { actor: 'user', taskId, remote: { approvedAt: null } },
    ];
    for (const c of cases) expect(await code(router.applyChange(projectId, c))).toBe('remote_only');
    expect(await code(router.applyDelete(projectId, { actor: REMOTE, taskId }))).toBe('remote_only');
    expect(versionOf('tasks', taskId)).toBe(v);
  });

  it('still enforces stage authority and the active-run guard on stage moves', async () => {
    const { taskId } = await remoteCreate('task', 'tsk_r', 'TASK-HOM-001', { initialStageId: stage(6) });
    expect(await code(router.applyChange(projectId, { actor: REMOTE, taskId, expectedVersion: 1, stageId: stage(7) }))).toBe(
      'forbidden_stage',
    );
    seedRun({ taskId });
    expect(await code(router.applyChange(projectId, { actor: REMOTE, taskId, expectedVersion: 1, stageId: stage(9) }))).toBe(
      'active_runs',
    );
    // Content still applies while the run is live.
    expect(
      await code(router.applyChange(projectId, { actor: REMOTE, taskId, expectedVersion: 1, fields: { title: 'new' } })),
    ).toBe('ok');
  });
});

describe('remote update stamps', () => {
  it('writes approved_at verbatim in both directions', async () => {
    const { taskId } = await remoteCreate('task', 'tsk_r', 'TASK-HOM-001', { remote: { approvedAt: null } });
    await router.applyChange(projectId, { actor: REMOTE, taskId, expectedVersion: 1, remote: { approvedAt: T0 } });
    expect(row('tasks', taskId)).toMatchObject({ approved_at: T0, version: 2 });
    await router.applyChange(projectId, { actor: REMOTE, taskId, expectedVersion: 2, remote: { approvedAt: null } });
    expect(row('tasks', taskId)).toMatchObject({ approved_at: null, version: 3 });
  });

  it('defers an archive while a live run or a blocking review item holds an idea, and never guards unarchive', async () => {
    await remoteCreate('idea', 'ide_r', 'IDEA-HOM-001');
    const runId = seedRun({ seedIdeaId: 'ide_r' });
    const archive = (v: number, archivedAt: string | null): Promise<unknown> =>
      router.applyChange(projectId, { actor: REMOTE, taskId: 'ide_r', expectedVersion: v, remote: { archivedAt } });
    expect(await code(archive(1, T0))).toBe('active_runs');

    db.prepare(`UPDATE workflow_runs SET status = 'completed' WHERE id = ?`).run(runId);
    const item = seedReviewItem('idea', 'ide_r', true);
    expect(await code(archive(1, T0))).toBe('active_runs');

    db.prepare(`UPDATE review_items SET status = 'resolved' WHERE id = ?`).run(item);
    expect(await code(archive(1, T0))).toBe('ok');
    seedRun({ seedIdeaId: 'ide_r' });
    expect(await code(archive(2, null))).toBe('ok');
    expect(row('ideas', 'ide_r')).toMatchObject({ archived_at: null });
  });
});

describe('applyRemoteDelete', () => {
  it('deletes exactly one entity, nulls its children and re-broadcasts them', async () => {
    await remoteCreate('epic', 'epc_r', 'EPIC-HOM-001');
    await remoteCreate('task', 'tsk_c', 'TASK-HOM-001', { parentEpicId: 'epc_r' });
    events.length = 0;
    const result = await router.applyRemoteDelete(projectId, { entityType: 'epic', entityId: 'epc_r' });
    expect(result).toEqual({ status: 'deleted' });
    expect(row('epics', 'epc_r')).toBeUndefined();
    expect(row('tasks', 'tsk_c')).toMatchObject({ parent_epic_id: null });
    expect(events.map((e) => [e.action, e.taskId, e.actor])).toEqual([
      ['deleted', 'epc_r', REMOTE],
      ['updated', 'tsk_c', REMOTE],
    ]);
  });

  it('treats a missing entity as not_found without throwing', async () => {
    expect(await router.applyRemoteDelete(projectId, { entityType: 'task', entityId: 'tsk_none' })).toEqual({
      status: 'not_found',
    });
  });

  it('defers while a blocking review item or a live run references the entity (epics included)', async () => {
    await remoteCreate('task', 'tsk_r', 'TASK-HOM-001');
    seedReviewItem('task', 'tsk_r', true);
    const held = await router.applyRemoteDelete(projectId, { entityType: 'task', entityId: 'tsk_r' });
    expect(held.status).toBe('deferred');
    expect(row('tasks', 'tsk_r')).toBeDefined();

    await remoteCreate('epic', 'epc_r', 'EPIC-HOM-001');
    const runId = seedRun({});
    db.prepare(
      `INSERT INTO entity_events (entity_type, entity_id, seq, kind, actor, run_id, changes_json, created_at)
       VALUES ('epic', 'epc_r', 99, 'updated', 'agent:x', ?, '[]', ?)`,
    ).run(runId, T0);
    expect((await router.applyRemoteDelete(projectId, { entityType: 'epic', entityId: 'epc_r' })).status).toBe('deferred');
    db.prepare(`UPDATE workflow_runs SET status = 'failed' WHERE id = ?`).run(runId);
    // A live run on a child task holds the epic too.
    await remoteCreate('task', 'tsk_child', 'TASK-HOM-002', { parentEpicId: 'epc_r' });
    const childRun = seedRun({ taskId: 'tsk_child' });
    expect((await router.applyRemoteDelete(projectId, { entityType: 'epic', entityId: 'epc_r' })).status).toBe('deferred');
    db.prepare(`UPDATE workflow_runs SET status = 'completed' WHERE id = ?`).run(childRun);
    expect((await router.applyRemoteDelete(projectId, { entityType: 'epic', entityId: 'epc_r' })).status).toBe('deleted');
  });
});

describe('applyRemoteEdges', () => {
  beforeEach(async () => {
    for (const n of ['a', 'b', 'c']) await remoteCreate('task', `tsk_${n}`, `TASK-HOM-${n}`);
  });
  const edges = (): Array<{ task_id: string; depends_on_task_id: string; kind: string }> =>
    db.prepare(`SELECT task_id, depends_on_task_id, kind FROM task_dependencies ORDER BY task_id, depends_on_task_id`).all() as Array<{
      task_id: string;
      depends_on_task_id: string;
      kind: string;
    }>;

  it('replaces each set, changes kinds, and reports missing endpoints', async () => {
    let res = await router.applyRemoteEdges(projectId, [
      { taskId: 'tsk_a', dependsOn: [{ id: 'tsk_b', kind: 'blocking' }, { id: 'tsk_gone', kind: 'blocking' }] },
    ]);
    expect(res).toEqual({ changedTaskIds: ['tsk_a'], cycles: [], missing: [{ taskId: 'tsk_a', dependsOnId: 'tsk_gone' }] });
    res = await router.applyRemoteEdges(projectId, [
      { taskId: 'tsk_a', dependsOn: [{ id: 'tsk_b', kind: 'related' }, { id: 'tsk_c', kind: 'blocking' }] },
    ]);
    expect(res.changedTaskIds).toEqual(['tsk_a']);
    expect(edges()).toEqual([
      { task_id: 'tsk_a', depends_on_task_id: 'tsk_b', kind: 'related' },
      { task_id: 'tsk_a', depends_on_task_id: 'tsk_c', kind: 'blocking' },
    ]);
    // Re-applying the same set is a no-op.
    expect((await router.applyRemoteEdges(projectId, [{ taskId: 'tsk_a', dependsOn: [{ id: 'tsk_b', kind: 'related' }, { id: 'tsk_c', kind: 'blocking' }] }])).changedTaskIds).toEqual([]);
  });

  it('applies the earlier edge of a cross-machine cycle and reports the later one', async () => {
    const res = await router.applyRemoteEdges(projectId, [
      { taskId: 'tsk_a', dependsOn: [{ id: 'tsk_b', kind: 'blocking' }] },
      { taskId: 'tsk_b', dependsOn: [{ id: 'tsk_a', kind: 'blocking' }] },
    ]);
    expect(res.cycles).toEqual([{ taskId: 'tsk_b', dependsOnId: 'tsk_a' }]);
    expect(edges()).toEqual([{ task_id: 'tsk_a', depends_on_task_id: 'tsk_b', kind: 'blocking' }]);
  });
});

describe('applyRemoteRefRenames', () => {
  it('swaps two refs atomically and records aliases', async () => {
    await remoteCreate('task', 'tsk_a', 'TASK-042');
    await remoteCreate('task', 'tsk_b', 'TASK-043');
    await router.applyRemoteRefRenames(
      projectId,
      [
        { entityType: 'task', entityId: 'tsk_a', newRef: 'TASK-043' },
        { entityType: 'task', entityId: 'tsk_b', newRef: 'TASK-042' },
      ],
      { recordAliases: true },
    );
    expect(row('tasks', 'tsk_a')).toMatchObject({ ref: 'TASK-043', version: 2 });
    expect(row('tasks', 'tsk_b')).toMatchObject({ ref: 'TASK-042', version: 2 });
    const aliases = db.prepare(`SELECT ref, entity_id, renamed_to FROM entity_ref_aliases ORDER BY ref`).all();
    expect(aliases).toEqual([
      { ref: 'TASK-042', entity_id: 'tsk_a', renamed_to: 'TASK-043' },
      { ref: 'TASK-043', entity_id: 'tsk_b', renamed_to: 'TASK-042' },
    ]);
  });

  it('rejects the whole batch when a target ref is held outside it', async () => {
    await remoteCreate('task', 'tsk_a', 'TASK-042');
    await remoteCreate('task', 'tsk_b', 'TASK-043');
    expect(
      await code(router.applyRemoteRefRenames(projectId, [{ entityType: 'task', entityId: 'tsk_a', newRef: 'TASK-043' }])),
    ).toBe('ref_conflict');
    expect(row('tasks', 'tsk_a')).toMatchObject({ ref: 'TASK-042', version: 1 });
  });
});

describe('device-prefixed minting', () => {
  function signIn(codeValue: string): void {
    db.prepare(
      `INSERT OR REPLACE INTO remote_sync_device (singleton, account_id, device_id, device_code, active, updated_at)
       VALUES (1, 'acc', 'dev', ?, 1, ?)`,
    ).run(codeValue, T0);
  }

  it('prefixes every project once signed in, sharing the existing counter', async () => {
    await router.applyChange(projectId, { actor: 'user', entityType: 'task', title: 'before' });
    signIn('WRK');
    const other = svc.createProject('Unsynced', join(dir, 'other')).id;
    const a = await router.applyChange(projectId, { actor: 'user', entityType: 'task', title: 'a' });
    const b = await router.applyChange(other, { actor: 'user', entityType: 'idea', title: 'b' });
    expect(row('tasks', a.taskId)!.ref).toBe('TASK-WRK-002');
    expect(row('ideas', b.taskId)!.ref).toBe('IDEA-WRK-001');
  });

  it('ignores a malformed code and reverts to plain refs when sync goes inactive or the device is gone', async () => {
    signIn('wr1');
    const a = await router.applyChange(projectId, { actor: 'user', entityType: 'task', title: 'a' });
    expect(row('tasks', a.taskId)!.ref).toBe('TASK-001');
    signIn('HOM');
    db.prepare(`UPDATE remote_sync_device SET active = 0`).run();
    const b = await router.applyChange(projectId, { actor: 'user', entityType: 'task', title: 'b' });
    expect(row('tasks', b.taskId)!.ref).toBe('TASK-002');
    db.prepare(`DELETE FROM remote_sync_device`).run();
    const c = await router.applyChange(projectId, { actor: 'user', entityType: 'task', title: 'c' });
    expect(row('tasks', c.taskId)!.ref).toBe('TASK-003');
  });
});
