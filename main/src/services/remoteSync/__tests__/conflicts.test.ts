/**
 * Sync conflicts, the user's side: the view the Conflicts UI renders, each
 * resolution as an ordinary user edit, and the note an agent's read carries.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { DatabaseService } from '../../../database/database';
import { TaskChangeRouter } from '../../../orchestrator/taskChangeRouter';
import { dbAdapter } from '../../../orchestrator/__test_fixtures__/dbAdapter';
import { openConflictNotes } from '../../../orchestrator/syncConflictNotes';
import type { ConflictRecord } from '../../../../../shared/types/remoteSyncWire';
import { listConflictViews, resolveConflict, type ConflictDeps } from '../conflicts';
import { SyncStore } from '../syncStore';

const NOW = Date.UTC(2026, 9, 8, 12);
const HLC_A = `${String(NOW - 60_000).padStart(13, '0')}:00000:dev-1`;
const HLC_B = `${String(NOW - 30_000).padStart(13, '0')}:00000:dev-2`;

let dir: string;
let svc: DatabaseService;
let db: Database.Database;
let projectId: number;
let router: TaskChangeRouter;
let store: SyncStore;
let deps: ConflictDeps;
let seq: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cyboflow-conflicts-'));
  svc = new DatabaseService(join(dir, 'test.db'));
  svc.initialize();
  db = svc.getDb();
  projectId = svc.createProject('P', join(dir, 'proj')).id;
  const adapter = dbAdapter(db);
  router = TaskChangeRouter.initialize(adapter);
  store = new SyncStore(adapter);
  store.optIn(projectId, 'rp', 'fp');
  deps = { db: adapter, router, store, deviceId: 'dev-1', now: () => NOW };
  seq = 0;
});

afterEach(() => {
  svc.close();
  rmSync(dir, { recursive: true, force: true });
});

function file(r: Partial<ConflictRecord> & Pick<ConflictRecord, 'id' | 'entityId' | 'kind'>): void {
  seq += 1;
  store.upsertServerConflict(projectId, {
    projectId: 'rp',
    entityRef: null,
    entityTitle: null,
    current: { value: null, device: null, hlc: null },
    other: { value: null, device: null, hlc: null },
    createdAt: NOW - 1000,
    seq,
    ...r,
  });
}

async function task(title: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await router.applyChange(projectId, { actor: 'user', entityType: 'task', title, ...extra })).taskId;
}
async function epic(title: string): Promise<string> {
  return (await router.applyChange(projectId, { actor: 'user', entityType: 'epic', title })).taskId;
}
const titleOf = (id: string) => (db.prepare('SELECT title FROM tasks WHERE id = ?').get(id) as { title: string } | undefined)?.title;
const open = () => listConflictViews(deps, projectId, 'open');

describe('field conflicts', () => {
  let id: string;
  beforeEach(async () => {
    id = await task('Studio title');
    file({
      id: 'c1', entityId: id, kind: 'field', field: 'title', entityRef: 'TASK-001', entityTitle: 'Studio title',
      current: { value: 'Studio title', device: 'dev-2', hlc: HLC_B },
      other: { value: 'My title', device: 'dev-1', hlc: HLC_A },
    });
  });

  it('lists both sides, who wrote them and when, with the actions that apply', () => {
    expect(open()).toEqual([
      expect.objectContaining({
        id: 'c1', entityType: 'task', field: 'title', changedSince: false, currentNow: 'Studio title',
        current: { value: 'Studio title', device: 'dev-2', thisDevice: false, at: NOW - 30_000 },
        other: { value: 'My title', device: 'dev-1', thisDevice: true, at: NOW - 60_000 },
        actions: ['keep', 'use_other', 'merge'],
        pendingResolution: null,
      }),
    ]);
  });

  it('says when the value changed again since', async () => {
    await router.applyChange(projectId, { actor: 'user', taskId: id, fields: { title: 'Newer' } });
    expect(open()[0]).toMatchObject({ changedSince: true, currentNow: 'Newer' });
  });

  it('"Use the other value" is a user edit, and the resolution waits for the next pass', async () => {
    expect(await resolveConflict(deps, 'c1', { kind: 'use_other' })).toEqual({ ok: true, projectId });
    expect(titleOf(id)).toBe('My title');
    expect(open()[0].pendingResolution).toBe('use_other');
    expect(store.listPendingResolutions(projectId)).toEqual([{ id: 'c1', resolution: 'use_other' }]);
    const events = db.prepare(`SELECT actor FROM entity_events WHERE entity_id = ? ORDER BY id DESC LIMIT 1`).get(id);
    expect(events).toEqual({ actor: 'user' });
  });

  it('merge writes the merged text; keep writes nothing', async () => {
    expect(await resolveConflict(deps, 'c1', { kind: 'merge', value: 'Studio + my title' })).toMatchObject({ ok: true });
    expect(titleOf(id)).toBe('Studio + my title');
    file({ id: 'c2', entityId: id, kind: 'field', field: 'title', current: { value: 'x', device: null, hlc: null }, other: { value: 'y', device: null, hlc: null } });
    expect(await resolveConflict(deps, 'c2', { kind: 'keep' })).toMatchObject({ ok: true });
    expect(titleOf(id)).toBe('Studio + my title');
    expect(store.listPendingResolutions(projectId)).toContainEqual({ id: 'c2', resolution: 'keep_current' });
  });

  it('refuses an action the kind does not offer, and an empty merged title', async () => {
    expect(await resolveConflict(deps, 'c1', { kind: 'recreate' })).toMatchObject({ ok: false });
    expect(await resolveConflict(deps, 'c1', { kind: 'merge', value: '  ' })).toEqual({ ok: false, message: 'A title cannot be empty' });
    expect(store.listPendingResolutions(projectId)).toEqual([]);
    expect(await resolveConflict(deps, 'nope', { kind: 'keep' })).toMatchObject({ ok: false });
  });

  it('a field that cannot be written as the user offers only keep', () => {
    file({ id: 'c3', entityId: id, kind: 'field', field: 'approved_at' });
    expect(open().find((c) => c.id === 'c3')?.actions).toEqual(['keep']);
  });
});

describe('delete vs edit', () => {
  it('recreates a deleted task as a new item from the lost values, linking back', async () => {
    const id = await task('Doomed');
    await router.applyDelete(projectId, { actor: 'user', taskId: id });
    file({
      id: 'd1', entityId: id, kind: 'delete_vs_edit', entityRef: 'TASK-001', entityTitle: 'Doomed',
      other: { value: { title: 'Doomed, edited', priority: 'P1' }, device: 'dev-1', hlc: HLC_A },
    });
    expect(open()[0]).toMatchObject({ entityType: 'task', actions: ['keep', 'recreate'] });
    expect(await resolveConflict(deps, 'd1', { kind: 'recreate' })).toMatchObject({ ok: true });
    const row = db.prepare('SELECT title, priority, body FROM tasks WHERE project_id = ?').get(projectId) as Record<string, string>;
    expect(row).toMatchObject({ title: 'Doomed, edited', priority: 'P1' });
    expect(row.body).toContain('Recreated from TASK-001');
    expect(store.listPendingResolutions(projectId)).toEqual([{ id: 'd1', resolution: 'recreated' }]);
  });
});

describe('dependency edge', () => {
  const edges = () =>
    db.prepare(`SELECT task_id AS t, depends_on_task_id AS d FROM task_dependencies ORDER BY task_id`).all() as Array<{ t: string; d: string }>;

  it('swap restores the removed edge and removes the kept one, as the user', async () => {
    const a = await task('a');
    const b = await task('b');
    await router.applyChange(projectId, { actor: 'user', taskId: b, dependsOnTaskId: a });
    file({
      id: 'e1', entityId: a, kind: 'dependency_edge', field: 'depends_on',
      extra: { removedEdge: { taskId: a, dependsOnId: b }, keptEdge: { taskId: b, dependsOnId: a } },
    });
    expect(open()[0].actions).toEqual(['keep', 'swap']);
    expect(await resolveConflict(deps, 'e1', { kind: 'swap' })).toMatchObject({ ok: true });
    expect(edges()).toEqual([{ t: a, d: b }]);
    expect(store.listPendingResolutions(projectId)).toEqual([{ id: 'e1', resolution: 'swapped' }]);
  });

  it('offers only keep when the record does not name the kept edge', async () => {
    const a = await task('a');
    const b = await task('b');
    file({ id: 'e2', entityId: a, kind: 'dependency_edge', extra: { removedEdge: { taskId: a, dependsOnId: b } } });
    expect(open()[0].actions).toEqual(['keep']);
    expect(await resolveConflict(deps, 'e2', { kind: 'swap' })).toMatchObject({ ok: false });
  });

  it('puts the kept edge back when restoring would close another cycle', async () => {
    const a = await task('a');
    const b = await task('b');
    const c = await task('c');
    // Kept b → a, plus a second path b → c → a: removing b → a leaves a cycle for a → b to close.
    await router.applyChange(projectId, { actor: 'user', taskId: b, dependsOnTaskId: a });
    await router.applyChange(projectId, { actor: 'user', taskId: b, dependsOnTaskId: c });
    await router.applyChange(projectId, { actor: 'user', taskId: c, dependsOnTaskId: a });
    file({
      id: 'e3', entityId: a, kind: 'dependency_edge',
      extra: { removedEdge: { taskId: a, dependsOnId: b }, keptEdge: { taskId: b, dependsOnId: a } },
    });
    const before = edges();
    expect(await resolveConflict(deps, 'e3', { kind: 'swap' })).toMatchObject({ ok: false });
    expect(edges()).toEqual(before);
    expect(store.listPendingResolutions(projectId)).toEqual([]);
  });
});

describe('orphaned children', () => {
  let a: string;
  let b: string;
  beforeEach(async () => {
    a = await task('child a');
    b = await task('child b');
    file({ id: 'o1', entityId: 'gone-epic', kind: 'orphaned', extra: { children: [{ id: a, ref: 'TASK-001', type: 'task' }, { id: b, ref: 'TASK-002', type: 'task' }] } });
  });

  it('moves them under another epic', async () => {
    const parent = await epic('New home');
    expect(open()[0].actions).toEqual(['keep', 'move', 'delete_children']);
    expect(await resolveConflict(deps, 'o1', { kind: 'move', parentId: parent })).toMatchObject({ ok: true });
    const parents = db.prepare('SELECT parent_epic_id AS p FROM tasks WHERE id IN (?, ?)').all(a, b);
    expect(parents).toEqual([{ p: parent }, { p: parent }]);
  });

  it('refuses a task as the new parent', async () => {
    expect(await resolveConflict(deps, 'o1', { kind: 'move', parentId: a })).toMatchObject({ ok: false });
  });

  it('deletes them', async () => {
    expect(await resolveConflict(deps, 'o1', { kind: 'delete_children' })).toMatchObject({ ok: true });
    expect(titleOf(a)).toBeUndefined();
    expect(titleOf(b)).toBeUndefined();
  });
});

describe('history and agent notes', () => {
  it('lists conflicts resolved in the last 30 days', async () => {
    const id = await task('t');
    file({ id: 'r1', entityId: id, kind: 'field', field: 'title', resolvedAt: NOW - 86_400_000, resolution: 'keep_current' });
    file({ id: 'r2', entityId: id, kind: 'field', field: 'title', resolvedAt: NOW - 40 * 86_400_000, resolution: 'keep_current' });
    expect(listConflictViews(deps, projectId, 'resolved').map((c) => c.id)).toEqual(['r1']);
    expect(open()).toEqual([]);
  });

  it("an agent's read says the item has an open conflict, until a person resolves it", async () => {
    const id = await task('t');
    file({ id: 'n1', entityId: id, kind: 'field', field: 'body' });
    expect(openConflictNotes(dbAdapter(db), id)).toEqual([
      'Open sync conflict: “body” was changed on two machines; one edit was applied and the other was set aside. A person reviews it; do not treat the current value as settled.',
    ]);
    await resolveConflict(deps, 'n1', { kind: 'keep' });
    expect(openConflictNotes(dbAdapter(db), id)).toEqual([]);
  });
});
