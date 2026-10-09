/**
 * Version skew, offline (a scripted fake service behind the FetchLike seam):
 *   - a value the local schema cannot hold parks `unsupported` while the
 *     entity's other fields still apply;
 *   - a field this client does not model is kept in the base verbatim, so the
 *     convergence hash still covers it and it is never pushed (an older client
 *     can never erase a newer client's field);
 *   - a 426 pauses the project as `upgrade_required`.
 * Part of the per-PR gate (no network).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../../../database/database';
import { TaskChangeRouter } from '../../../orchestrator/taskChangeRouter';
import { dbAdapter } from '../../../orchestrator/__test_fixtures__/dbAdapter';
import type { FeedItem, FeedPage, PushRequest } from '../../../../../shared/types/remoteSyncWire';
import { RemoteSyncEngine } from '../engine';
import { SyncHttpClient, type FetchLike } from '../syncHttpClient';
import { SyncStore } from '../syncStore';

const HLC = (n: number): string => `${String(1_790_000_000_000 + n).padStart(13, '0')}:00000:other-device`;
const clock = (v: number, seq: number) => ({ v, hlc: HLC(seq), seq });

let dir: string;
let svc: DatabaseService;
let db: Database.Database;
let store: SyncStore;
let projectId: number;
let feed: FeedItem[];
let pushes: PushRequest[];
let status426 = false;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cyboflow-Epoch': '1' } });

const fakeFetch: FetchLike = (async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
  if (status426) return json({ error: 'upgrade_required' }, 426);
  const maxSeq = feed.reduce((m, i) => Math.max(m, i.seq), 0);
  if (url.pathname === '/v1/head') return json({ now: Date.now(), projects: { rp: maxSeq }, claims: [] });
  if (url.pathname === '/v1/projects/rp/changes') {
    const since = Number(url.searchParams.get('since'));
    const items = feed.filter((i) => i.seq > since);
    const page: FeedPage = { now: Date.now(), maxSeq, nextSince: maxSeq, hasMore: false, items, conflicts: [] };
    return json(page);
  }
  if (url.pathname === '/v1/projects/rp/push') {
    const req = JSON.parse(String(init?.body)) as PushRequest;
    pushes.push(req);
    return json({
      now: Date.now(),
      maxSeq,
      results: req.ops.map((op) => ({ entityId: op.entityId, status: 'noop', fields: {}, conflictIds: [], entity: null, entityOmitted: true })),
      conflicts: [],
    });
  }
  return json({ error: 'not_found' }, 404);
}) as FetchLike;

function engine(): RemoteSyncEngine {
  const adapter = dbAdapter(db);
  return new RemoteSyncEngine({
    db: adapter,
    router: new TaskChangeRouter(adapter),
    store,
    client: new SyncHttpClient({ origin: 'https://sync.test', fetch: fakeFetch, getToken: () => 't', appVersion: 'test' }),
    deviceId: 'this-device',
  });
}

function remoteTask(fields: Record<string, unknown>, seq = 1): FeedItem {
  const clocks = Object.fromEntries(Object.keys(fields).map((f) => [f, clock(1, seq)]));
  return { entityId: 'tsk_remote', entityType: 'task', ref: 'TASK-OTH-001', deleted: false, seq, version: 1, clocks, fields };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cyboflow-skew-'));
  svc = new DatabaseService(join(dir, 'test.db'));
  svc.initialize();
  db = svc.getDb();
  store = new SyncStore(dbAdapter(db));
  projectId = svc.createProject('P', join(dir, 'proj')).id;
  store.optIn(projectId, 'rp', null);
  feed = [];
  pushes = [];
  status426 = false;
});

afterEach(() => {
  svc.close();
  rmSync(dir, { recursive: true, force: true });
});

const baseFields = {
  title: 'From a newer client',
  summary: null,
  body: null,
  priority: 'P2',
  category: 'feature',
  repo: null,
  stage: '6',
  archived_at: null,
  sort_order: null,
  approved_at: '2026-01-01T00:00:00.000Z',
  parent_epic_id: null,
  originating_idea_id: null,
  executor: 'agent',
  created_at: '2026-01-01T00:00:00.000Z',
  depends_on: [],
};

describe('version skew', () => {
  it('parks an unknown enum value as unsupported and applies the rest', async () => {
    feed.push(remoteTask({ ...baseFields, priority: 'P9' }));
    expect(await engine().syncProject(projectId)).toMatchObject({ status: 'ok' });
    const row = db.prepare(`SELECT title, priority FROM tasks WHERE id = 'tsk_remote'`).get();
    expect(row).toEqual({ title: 'From a newer client', priority: 'P2' });
    const st = store.getEntity('task', 'tsk_remote');
    expect(st?.inbox.priority).toMatchObject({ value: 'P9', reason: 'unsupported' });
    // Parked at the local default with a v:0 base, so it is not pushed as an edit.
    expect(st?.base.priority).toMatchObject({ value: 'P2', v: 0 });
    expect(pushes.flatMap((p) => p.ops).filter((o) => o.fields?.priority)).toEqual([]);
  });

  it('keeps a field it does not model in the base and never pushes it', async () => {
    feed.push(remoteTask({ ...baseFields, color: 'teal' }));
    const e = engine();
    expect(await e.syncProject(projectId)).toMatchObject({ status: 'ok' });
    expect(store.getEntity('task', 'tsk_remote')?.base.color).toMatchObject({ value: 'teal', v: 1 });
    expect(e.syncedState(projectId)[0].fields.color).toBe('teal');
    // A later local edit pushes the edited field only.
    await new TaskChangeRouter(dbAdapter(db)).applyChange(projectId, {
      actor: 'user',
      taskId: 'tsk_remote',
      fields: { title: 'Edited here' },
    });
    await e.syncProject(projectId);
    const sent = pushes.flatMap((p) => p.ops).map((o) => Object.keys(o.fields ?? {}));
    expect(sent).toEqual([['title']]);
  });

  it('pauses as upgrade_required on a 426', async () => {
    status426 = true;
    expect(await engine().syncProject(projectId)).toEqual({ status: 'paused', reason: 'upgrade_required' });
    expect(store.getProject(projectId)?.status).toBe('upgrade_required');
    status426 = false;
    expect(await engine().syncProject(projectId)).toMatchObject({ status: 'skipped' });
  });
});
