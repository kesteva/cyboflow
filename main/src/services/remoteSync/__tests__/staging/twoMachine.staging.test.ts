/**
 * Two-machine convergence scenarios against the STAGING sync service
 * (desktop doc, "Testing" → the named scenarios). Skipped unless
 * CYBOFLOW_SYNC_STAGING_SECRET is set; see stagingHarness.ts.
 *
 * Every scenario ends with a convergence check: both machines' synced
 * projections hash equal to each other AND to the server's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TwoMachines, stagingEnabled, type Machine } from './stagingHarness';
import { projectionHash } from '../../canonical';

const TIMEOUT = 120_000;

async function expectConverged(t: TwoMachines): Promise<void> {
  await t.settle();
  const ha = projectionHash(t.a.engine.syncedState(t.a.projectId));
  const hb = projectionHash(t.b.engine.syncedState(t.b.projectId));
  expect(ha).toBe(hb);
  expect(await t.a.engine.checksum(t.a.projectId)).toBe('match');
  expect(await t.b.engine.checksum(t.b.projectId)).toBe('match');
}

function createTask(m: Machine, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  return m.edit({ entityType: 'task', title, ...extra });
}

describe.skipIf(!stagingEnabled)('remote sync against staging: two machines', () => {
  let t: TwoMachines;

  beforeEach(async () => {
    t = await TwoMachines.create();
  }, TIMEOUT);

  afterEach(async () => {
    await t?.dispose();
  }, TIMEOUT);

  it('a create on A arrives on B with the same id, ref, stage and created_at', async () => {
    const id = await createTask(t.a, 'From A', { initialStageId: t.a.stageId(6) });
    await expectConverged(t);
    const onB = t.b.row('tasks', id);
    expect(onB).toBeDefined();
    expect(onB).toMatchObject({
      ref: t.a.row('tasks', id)?.ref,
      title: 'From A',
      stage_id: t.b.stageId(6),
      created_at: t.a.row('tasks', id)?.created_at,
      approved_at: t.a.row('tasks', id)?.approved_at,
    });
    expect(String(onB?.ref)).toMatch(/^TASK-AAA-\d{3}$/);
  }, TIMEOUT);

  it('different-field edits on both machines converge', async () => {
    const id = await createTask(t.a, 'Original');
    await expectConverged(t);
    await t.a.edit({ taskId: id, fields: { title: 'Title from A' } });
    await t.b.edit({ taskId: id, fields: { body: 'Body from B' } });
    await expectConverged(t);
    for (const m of [t.a, t.b]) expect(m.row('tasks', id)).toMatchObject({ title: 'Title from A', body: 'Body from B' });
  }, TIMEOUT);

  it('a same-field race: the later edit wins everywhere, the loser is never re-pushed, one conflict is recorded', async () => {
    const id = await createTask(t.a, 'Original');
    await expectConverged(t);
    await t.a.edit({ taskId: id, fields: { title: 'A wrote first' } });
    await new Promise((r) => setTimeout(r, 20));
    await t.b.edit({ taskId: id, fields: { title: 'B wrote later' } });
    expect((await t.a.sync()).status).toBe('ok');
    expect((await t.b.sync()).status).toBe('ok');
    const pushesBefore = t.b.net.pushes().length + t.a.net.pushes().length;
    await expectConverged(t);
    for (const m of [t.a, t.b]) expect(m.row('tasks', id)).toMatchObject({ title: 'B wrote later' });
    // After settling, nobody pushes the losing value again.
    const a = await t.a.sync();
    const b = await t.b.sync();
    expect(a.status === 'ok' && a.pushed).toBe(0);
    expect(b.status === 'ok' && b.pushed).toBe(0);
    expect(t.a.net.pushes().length + t.b.net.pushes().length).toBeGreaterThanOrEqual(pushesBefore);
    const open = [...t.a.store.listOpenConflicts(t.a.projectId), ...t.b.store.listOpenConflicts(t.b.projectId)];
    const ids = new Set(open.filter((c) => c.kind === 'field' && c.entityId === id).map((c) => c.id));
    expect(ids.size).toBe(1);
  }, TIMEOUT);

  it('a push whose response is lost is re-sent identically and applies once', async () => {
    await createTask(t.a, 'One');
    await createTask(t.a, 'Two');
    t.a.net.faults.push({ kind: 'drop_response', match: /POST .*\/push$/ });
    expect((await t.a.sync()).status).toBe('failed');
    expect(t.a.store.getBatch(t.a.projectId)).not.toBeNull();
    expect((await t.a.sync()).status).toBe('ok');
    const pushes = t.a.net.pushes();
    expect(pushes[0].batchId).toBe(pushes[1].batchId);
    expect(t.a.store.getBatch(t.a.projectId)).toBeNull();
    await expectConverged(t);
    expect((t.b.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?`).get(t.b.projectId) as { n: number }).n).toBe(2);
  }, TIMEOUT);

  it('refs minted offline on both machines never collide', async () => {
    const ids = [await createTask(t.a, 'a1'), await createTask(t.a, 'a2'), await createTask(t.b, 'b1'), await createTask(t.b, 'b2')];
    await expectConverged(t);
    const refs = ids.map((id) => String(t.a.row('tasks', id)?.ref));
    expect(new Set(refs).size).toBe(4);
    expect(refs.filter((r) => r.startsWith('TASK-AAA-'))).toHaveLength(2);
    expect(refs.filter((r) => r.startsWith('TASK-BBB-'))).toHaveLength(2);
  }, TIMEOUT);

  it('a delete on A removes the entity on B', async () => {
    const id = await createTask(t.a, 'Doomed');
    await expectConverged(t);
    await t.a.router.applyDelete(t.a.projectId, { actor: 'user', taskId: id });
    await expectConverged(t);
    expect(t.b.row('tasks', id)).toBeUndefined();
    expect(t.b.store.listTombstones(t.b.projectId)).toEqual([]);
  }, TIMEOUT);

  it('delete vs. a new local child: the child survives orphaned and one orphaned conflict is filed', async () => {
    const epicId = await t.a.edit({ entityType: 'epic', title: 'Epic' });
    await expectConverged(t);
    // B adds a child offline while A deletes the epic.
    const child = await createTask(t.b, 'Child on B', { parentEpicId: epicId });
    await t.a.router.applyDelete(t.a.projectId, { actor: 'user', taskId: epicId });
    expect((await t.a.sync()).status).toBe('ok');
    await expectConverged(t);
    for (const m of [t.a, t.b]) {
      expect(m.row('epics', epicId)).toBeUndefined();
      expect(m.row('tasks', child)).toMatchObject({ parent_epic_id: null });
    }
    const orphaned = t.a.store.listOpenConflicts(t.a.projectId).filter((c) => c.kind === 'orphaned');
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].entityId).toBe(epicId);
  }, TIMEOUT);

  it('a remote stage move held by a live run applies once the run ends', async () => {
    const id = await createTask(t.a, 'Work', { initialStageId: t.a.stageId(6) });
    await expectConverged(t);
    t.b.db.prepare(`INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-h', ?, 'sprint', '{}')`).run(t.b.projectId);
    t.b.db
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, status, policy_json, task_id)
         VALUES ('run-h', 'wf-h', ?, '/tmp/x', 'running', '{}', ?)`,
      )
      .run(t.b.projectId, id);
    await t.a.edit({ taskId: id, stageId: t.a.stageId(9) });
    expect((await t.a.sync()).status).toBe('ok');
    expect((await t.b.sync()).status).toBe('ok');
    expect(t.b.row('tasks', id)).toMatchObject({ stage_id: t.b.stageId(6) });
    expect(t.b.store.getEntity('task', id)?.inbox.stage?.reason).toBe('deferred');
    t.b.db.prepare(`UPDATE workflow_runs SET status = 'completed' WHERE id = 'run-h'`).run();
    await expectConverged(t);
    expect(t.b.row('tasks', id)).toMatchObject({ stage_id: t.b.stageId(9) });
  }, TIMEOUT);

  it('a cross-machine dependency cycle keeps exactly one edge, the same on both machines', async () => {
    const x = await createTask(t.a, 'X');
    const y = await createTask(t.a, 'Y');
    await expectConverged(t);
    await t.a.edit({ taskId: x, dependsOnTaskId: y });
    await new Promise((r) => setTimeout(r, 20));
    await t.b.edit({ taskId: y, dependsOnTaskId: x });
    await expectConverged(t);
    const edges = (m: Machine): string[] =>
      (m.db.prepare(`SELECT task_id || '>' || depends_on_task_id AS e FROM task_dependencies ORDER BY e`).all() as Array<{ e: string }>).map(
        (r) => r.e,
      );
    expect(edges(t.a)).toEqual([`${x}>${y}`]);
    expect(edges(t.b)).toEqual(edges(t.a));
    // One record for the dropped edge, visible on both machines.
    const records = (m: Machine) => m.store.listOpenConflicts(m.projectId).filter((c) => c.kind === 'dependency_edge');
    expect(records(t.a)).toHaveLength(1);
    expect(records(t.b).map((c) => c.id)).toEqual(records(t.a).map((c) => c.id));
    expect(records(t.a)[0].entityId).toBe(y);
  }, TIMEOUT);

  it('removing a project locally records no tombstones', async () => {
    await createTask(t.a, 'Stays on the server');
    await expectConverged(t);
    t.a.db.prepare(`DELETE FROM projects WHERE id = ?`).run(t.a.projectId);
    expect(t.a.db.prepare(`SELECT COUNT(*) AS n FROM remote_sync_tombstones`).get()).toEqual({ n: 0 });
    expect(t.a.store.getProject(t.a.projectId)).toBeNull();
  }, TIMEOUT);

  it('quiescence: a settled pair pushes and pulls nothing more', async () => {
    await createTask(t.a, 'q1');
    await createTask(t.b, 'q2');
    await expectConverged(t);
    const a = await t.a.sync();
    const b = await t.b.sync();
    expect(a).toMatchObject({ status: 'ok', pushed: 0, pulled: 0 });
    expect(b).toMatchObject({ status: 'ok', pushed: 0, pulled: 0 });
  }, TIMEOUT);
});
