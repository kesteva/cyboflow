/**
 * Recovery and conflict-lifecycle scenarios against the STAGING sync service.
 * Skipped unless CYBOFLOW_SYNC_STAGING_SECRET is set; see stagingHarness.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { TwoMachines, stagingEnabled, type Machine } from './stagingHarness';
import { projectionHash } from '../../canonical';

const TIMEOUT = 120_000;

async function expectConverged(t: TwoMachines): Promise<void> {
  await t.settle();
  expect(projectionHash(t.a.engine.syncedState(t.a.projectId))).toBe(projectionHash(t.b.engine.syncedState(t.b.projectId)));
  expect(await t.a.engine.checksum(t.a.projectId)).toBe('match');
  expect(await t.b.engine.checksum(t.b.projectId)).toBe('match');
}

const createTask = (m: Machine, title: string, extra: Record<string, unknown> = {}): Promise<string> =>
  m.edit({ entityType: 'task', title, ...extra });

describe.skipIf(!stagingEnabled)('remote sync against staging: recovery and conflicts', () => {
  let t: TwoMachines;

  beforeEach(async () => {
    t = await TwoMachines.create();
  }, TIMEOUT);

  afterEach(async () => {
    await t?.dispose();
  }, TIMEOUT);

  it('field conflict lifecycle: filed once, visible on both, "use the other value" wins everywhere and closes it', async () => {
    const id = await createTask(t.a, 'Original');
    await expectConverged(t);
    await t.a.edit({ taskId: id, fields: { title: 'From A' } });
    await new Promise((r) => setTimeout(r, 20));
    await t.b.edit({ taskId: id, fields: { title: 'From B' } });
    await expectConverged(t);
    const [onA] = t.a.store.listOpenConflicts(t.a.projectId).filter((c) => c.kind === 'field');
    const [onB] = t.b.store.listOpenConflicts(t.b.projectId).filter((c) => c.kind === 'field');
    expect(onA.id).toBe(onB.id);
    expect(onA.current.value).toBe('From B');
    expect(onA.other.value).toBe('From A');

    // On A the user picks "Use the other value": an ordinary edit, then resolve.
    await t.a.edit({ taskId: id, fields: { title: onA.other.value as string } });
    t.a.store.setPendingResolution(onA.id, 'use_other');
    await expectConverged(t);
    for (const m of [t.a, t.b]) {
      expect(m.row('tasks', id)).toMatchObject({ title: 'From A' });
      expect(m.store.listOpenConflicts(m.projectId).filter((c) => c.id === onA.id)).toEqual([]);
    }
  }, TIMEOUT);

  it('delete vs. edit, edit pushed after the delete: the edit is rejected and its values recorded', async () => {
    const id = await createTask(t.a, 'Contested');
    await expectConverged(t);
    await t.a.router.applyDelete(t.a.projectId, { actor: 'user', taskId: id });
    expect((await t.a.sync()).status).toBe('ok');
    await t.b.edit({ taskId: id, fields: { title: 'Edited on B' } });
    await expectConverged(t);
    expect(t.b.row('tasks', id)).toBeUndefined();
    const records = t.a.store.listOpenConflicts(t.a.projectId).filter((c) => c.kind === 'delete_vs_edit' && c.entityId === id);
    expect(records).toHaveLength(1);
    expect(records[0].other.value).toMatchObject({ title: 'Edited on B' });
  }, TIMEOUT);

  it('delete vs. edit, delete pushed after the edit: the tombstone wins and the newer values are recorded', async () => {
    const id = await createTask(t.a, 'Contested');
    await expectConverged(t);
    await t.b.edit({ taskId: id, fields: { body: 'Body from B' } });
    expect((await t.b.sync()).status).toBe('ok');
    await t.a.router.applyDelete(t.a.projectId, { actor: 'user', taskId: id });
    await expectConverged(t);
    for (const m of [t.a, t.b]) expect(m.row('tasks', id)).toBeUndefined();
    const records = t.b.store.listOpenConflicts(t.b.projectId).filter((c) => c.kind === 'delete_vs_edit' && c.entityId === id);
    expect(records).toHaveLength(1);
    expect(records[0].other.value).toMatchObject({ body: 'Body from B' });
  }, TIMEOUT);

  it('epic rollup: a child finishing on A rolls the epic up on both machines with no epic stage pushes', async () => {
    const epic = await t.a.edit({ entityType: 'epic', title: 'Epic' });
    const child = await createTask(t.a, 'Only child', { parentEpicId: epic, initialStageId: t.a.stageId(6) });
    await expectConverged(t);
    await t.a.edit({ taskId: child, stageId: t.a.stageId(9) });
    await expectConverged(t);
    for (const m of [t.a, t.b]) {
      expect(m.row('epics', epic)).toMatchObject({ stage_id: m.stageId(9) });
      expect(m.store.getEntity('epic', epic)?.base.stage?.value).toBe('rollup');
    }
    const epicStagePushes = [...t.a.net.log, ...t.b.net.log].filter(
      (l) => l.body?.includes(`"entityId":"${epic}"`) && l.body.includes('"stage"') && l.method === 'POST' && /push$/.test(l.url),
    );
    // Only the create carried the epic's stage.
    expect(epicStagePushes).toHaveLength(1);
  }, TIMEOUT);

  it('a crash between the router write and the base stamp is stamped on restart, not pushed back', async () => {
    const id = await createTask(t.a, 'Original');
    await expectConverged(t);
    await t.a.edit({ taskId: id, fields: { title: 'New title' } });
    expect((await t.a.sync()).status).toBe('ok');
    // B "applied" the value through the router but crashed before stamping its base.
    await t.b.router.applyChange(t.b.projectId, {
      actor: 'cyboflow-remote',
      taskId: id,
      expectedVersion: t.b.version('tasks', id),
      fields: { title: 'New title' },
    });
    const outcome = await t.b.sync();
    expect(outcome).toMatchObject({ status: 'ok', pushed: 0 });
    expect(t.b.store.getEntity('task', id)?.base.title?.value).toBe('New title');
    await expectConverged(t);
  }, TIMEOUT);

  it('restore drill: a new epoch re-bootstraps from the snapshot and keeps unacknowledged edits', async () => {
    const id = await createTask(t.a, 'Before the restore');
    await expectConverged(t);
    // An edit B never got to push.
    await t.b.edit({ taskId: id, fields: { body: 'Unpushed on B' } });
    await t.bumpEpoch();
    expect((await t.b.sync()).status).toBe('ok');
    expect(t.b.store.listProjects()[0].epoch).toBeGreaterThan(1);
    await expectConverged(t);
    for (const m of [t.a, t.b]) expect(m.row('tasks', id)).toMatchObject({ title: 'Before the restore', body: 'Unpushed on B' });
  }, TIMEOUT);

  it('rewind: a local restore pauses with "rewound", and resuming re-applies the feed', async () => {
    const id = await createTask(t.a, 'Seen before the rewind');
    await expectConverged(t);
    // A second round, so B has proved a non-zero cursor to the server.
    await createTask(t.a, 'Second');
    await expectConverged(t);
    await createTask(t.a, 'Created after');
    expect((await t.a.sync()).status).toBe('ok');
    // B's database went back in time: its cursor is behind what it proved it committed.
    t.b.store.updateProject(t.b.projectId, { cursor: 0 });
    expect(await t.b.sync()).toMatchObject({ status: 'paused', reason: 'rewound' });
    expect(t.b.store.getProject(t.b.projectId)?.status).toBe('rewound');
    expect(await t.b.sync()).toMatchObject({ status: 'skipped' });
    t.b.engine.resumeAfterRewind(t.b.projectId);
    await expectConverged(t);
    expect(t.b.row('tasks', id)).toBeDefined();
    expect((t.b.db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n).toBe(3);
    expect(existsSync(t.b.dir)).toBe(true);
  }, TIMEOUT);
});
