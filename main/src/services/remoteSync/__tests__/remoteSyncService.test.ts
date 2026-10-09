/**
 * RemoteSyncService runtime, offline: identity from the shared cloud sign-in,
 * the change listener + debounce, per-project serialization, backoff, and the
 * 401 hand-back. A scripted fake service sits behind the FetchLike seam.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { DatabaseService } from '../../../database/database';
import { TaskChangeRouter } from '../../../orchestrator/taskChangeRouter';
import { dbAdapter } from '../../../orchestrator/__test_fixtures__/dbAdapter';
import type { CloudAccountEventMap, CloudAccountHandle, CloudBeforeSignOutHook, CloudDevice, CloudHandleState } from '../../cloud/cloudAccountHandle';
import type { CloudRevokeReason } from '../../../../../shared/types/cloudAccountWire';
import type { PushRequest, RemoteProject } from '../../../../../shared/types/remoteSyncWire';
import type { GitRunner } from '../fingerprint';
import { RemoteSyncService, SYNC_DEBOUNCE_MS } from '../remoteSyncService';
import { SyncHttpClient, type FetchLike } from '../syncHttpClient';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cyboflow-Epoch': '1', ...headers } });

class FakeCloud extends EventEmitter implements CloudAccountHandle {
  device: CloudDevice | null = { origin: 'https://sync.test', accountId: 'acc-1', deviceId: 'dev-1', deviceCode: 'WRK', deviceName: 'Studio' };
  token: string | null = 'tok';
  state: CloudHandleState = 'ok';
  revoked: CloudRevokeReason[] = [];
  hooks: CloudBeforeSignOutHook[] = [];
  readonly fetch = (() => Promise.reject(new Error('unused'))) as unknown as FetchLike;
  readonly appVersion = 'test';
  getDevice(): CloudDevice | null {
    return this.device;
  }
  getToken(): string | null {
    return this.token;
  }
  getState(): CloudHandleState {
    return this.state;
  }
  getEntitlements(): readonly string[] {
    return [];
  }
  markRevoked(reason: CloudRevokeReason): void {
    this.revoked.push(reason);
  }
  requestAccountRefresh(): void {}
  onBeforeSignOut(hook: CloudBeforeSignOutHook): () => void {
    this.hooks.push(hook);
    return () => {
      this.hooks = this.hooks.filter((h) => h !== hook);
    };
  }
  override on<K extends keyof CloudAccountEventMap>(event: K, listener: (...args: CloudAccountEventMap[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override off<K extends keyof CloudAccountEventMap>(event: K, listener: (...args: CloudAccountEventMap[K]) => void): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
}

class FakeConfig extends EventEmitter {
  enabled = true;
  isRemoteSyncAvailable(): boolean {
    return true;
  }
  isRemoteSyncEnabled(): boolean {
    return this.enabled;
  }
  set(enabled: boolean): void {
    this.enabled = enabled;
    this.emit('config-updated');
  }
}

let dir: string;
let svc: DatabaseService;
let db: Database.Database;
let projectId: number;
let cloud: FakeCloud;
let config: FakeConfig;
let requests: string[];
let pushes: PushRequest[];
let failNext: Response | null;
let service: RemoteSyncService;
let findings: string[];
let remoteProjects: RemoteProject[];
let created: Array<{ name: string; fingerprint: string }>;
let originUrl: string | null;

const fakeGit: GitRunner = async (_cwd, args) => {
  if (args[0] === 'remote') {
    if (originUrl === null) throw new Error('error: No such remote');
    return `${originUrl}\n`;
  }
  return '\n';
};

const fakeFetch: FetchLike = (async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
  requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
  if (failNext) {
    const r = failNext;
    failNext = null;
    return r;
  }
  if (url.pathname === '/v1/head') return json({ now: Date.now(), projects: { rp: 0 }, claims: [] });
  if (url.pathname === '/v1/tracker-claims') {
    const req = JSON.parse(String(init?.body)) as { key: string; label: string };
    const holder = { key: req.key, deviceId: 'dev-1', label: req.label, claimedAt: 1 };
    return json({ key: req.key, state: 'held_by_you', holder });
  }
  if (url.pathname === '/v1/projects' && init?.method === 'GET') return json({ projects: remoteProjects });
  if (url.pathname === '/v1/projects' && init?.method === 'POST') {
    const req = JSON.parse(String(init.body)) as { name: string; fingerprint: string };
    const taken = remoteProjects.find((p) => p.fingerprint === req.fingerprint);
    if (taken) return json({ error: 'project_exists', details: { project: taken } }, 409);
    created.push(req);
    const project = { id: 'rp', name: req.name, fingerprint: req.fingerprint, createdByDevice: 'dev-1', createdAt: 1 };
    remoteProjects.push(project);
    return json({ project });
  }
  if (url.pathname === '/v1/projects/rp/push') {
    const req = JSON.parse(String(init?.body)) as PushRequest;
    pushes.push(req);
    return json({
      now: Date.now(),
      maxSeq: 0,
      results: req.ops.map((op) => ({ entityId: op.entityId, status: 'noop', fields: {}, conflictIds: [], entity: null, entityOmitted: true })),
      conflicts: [],
    });
  }
  return json({ error: 'not_found' }, 404);
}) as FetchLike;

function makeService(): RemoteSyncService {
  const adapter = dbAdapter(db);
  return new RemoteSyncService({
    db: adapter,
    router: TaskChangeRouter.initialize(adapter),
    configManager: config,
    cloud,
    fileFinding: (_p, title) => findings.push(title),
    git: fakeGit,
    createClient: (device, c) => new SyncHttpClient({ origin: device.origin, fetch: fakeFetch, getToken: () => c.getToken(), appVersion: 't' }),
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cyboflow-sync-svc-'));
  svc = new DatabaseService(join(dir, 'test.db'));
  svc.initialize();
  db = svc.getDb();
  projectId = svc.createProject('P', join(dir, 'proj')).id;
  cloud = new FakeCloud();
  config = new FakeConfig();
  requests = [];
  pushes = [];
  failNext = null;
  findings = [];
  remoteProjects = [];
  created = [];
  originUrl = 'https://me:ghp_secret@github.com/o/r.git';
  service = makeService();
});

afterEach(async () => {
  service.stop();
  await service.idle();
  vi.useRealTimers();
  svc.close();
  rmSync(dir, { recursive: true, force: true });
});

const deviceRow = () => db.prepare('SELECT * FROM remote_sync_device').get() as Record<string, unknown> | undefined;

describe('identity', () => {
  it('mirrors the signed-in device as active, so every project mints prefixed refs', async () => {
    service.start();
    expect(deviceRow()).toMatchObject({ account_id: 'acc-1', device_id: 'dev-1', device_code: 'WRK', active: 1 });
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const r = await router.applyChange(projectId, { actor: 'user', entityType: 'task', title: 'x' });
    expect((db.prepare('SELECT ref FROM tasks WHERE id = ?').get(r.taskId) as { ref: string }).ref).toBe('TASK-WRK-001');
  });

  it('turning sync off deactivates the device; signing out does too', () => {
    service.start();
    config.set(false);
    expect(deviceRow()).toMatchObject({ active: 0 });
    config.set(true);
    expect(deviceRow()).toMatchObject({ active: 1 });
    cloud.device = null;
    cloud.emit('signedOut');
    expect(deviceRow()).toMatchObject({ active: 0 });
  });

  it('does not sync while the token is locked, and syncs once it unlocks', async () => {
    service.store.optIn(projectId, 'rp', 'fp');
    cloud.token = null;
    cloud.state = 'locked';
    service.start();
    await service.syncAll('tick');
    expect(requests).toEqual([]);
    cloud.token = 'tok';
    cloud.state = 'ok';
    cloud.emit('stateChanged', 'ok');
    await vi.waitFor(() => expect(requests).toContain('GET /v1/head'));
  });

  it('a different account unlinks every project and files a finding', () => {
    service.start();
    service.store.optIn(projectId, 'rp', 'fp');
    cloud.device = { ...(cloud.device as CloudDevice), accountId: 'acc-2', deviceId: 'dev-9' };
    cloud.emit('signedIn', { device: cloud.device, isNewDevice: true });
    expect(service.store.getProject(projectId)).toBeNull();
    expect(findings).toEqual(['Sync turned off: signed in to a different account']);
  });

  it('a new device on the same account drops the frozen batch', () => {
    service.start();
    service.store.optIn(projectId, 'rp', 'fp');
    service.store.putBatch(projectId, 'b1', '{}');
    cloud.device = { ...(cloud.device as CloudDevice), deviceId: 'dev-2', deviceCode: 'HOM' };
    cloud.emit('signedIn', { device: cloud.device, isNewDevice: true });
    expect(service.store.getBatch(projectId)).toBeNull();
    expect(service.store.getProject(projectId)?.remoteProjectId).toBe('rp');
    expect(deviceRow()).toMatchObject({ device_id: 'dev-2', device_code: 'HOM' });
  });

  it('registers a before-sign-out flush', () => {
    service.start();
    expect(cloud.hooks).toHaveLength(1);
    service.stop();
    expect(cloud.hooks).toHaveLength(0);
  });
});

describe('cadence', () => {
  it('a local write arms the debounce and pushes the change', async () => {
    service.store.optIn(projectId, 'rp', 'fp');
    service.start();
    await service.syncAll('tick');
    vi.useFakeTimers();
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    await router.applyChange(projectId, { actor: 'user', entityType: 'task', title: 'new' });
    expect(pushes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 10);
    vi.useRealTimers();
    await vi.waitFor(() => expect(pushes.flatMap((p) => p.ops).map((o) => o.kind)).toEqual(['upsert']));
  });

  it('ignores writes to projects that do not sync', async () => {
    service.start();
    vi.useFakeTimers();
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    await router.applyChange(projectId, { actor: 'user', entityType: 'task', title: 'unsynced project' });
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 10);
    expect(requests).toEqual([]);
  });

  it('serializes passes per project: a trigger mid-pass re-runs once afterwards', async () => {
    service.store.optIn(projectId, 'rp', 'fp');
    service.start();
    const a = service.syncProject(projectId, 'tick');
    const b = service.syncProject(projectId, 'write');
    const c = service.syncProject(projectId, 'write');
    await Promise.all([a, b, c]);
    expect(requests.filter((r) => r === 'GET /v1/head')).toHaveLength(2);
  });
});

describe('failures', () => {
  beforeEach(() => {
    service.store.optIn(projectId, 'rp', 'fp');
    service.start();
  });

  it('backs off after a 503 (honouring Retry-After) and "Sync now" overrides it', async () => {
    failNext = json({ error: 'accounts_unavailable' }, 503, { 'Retry-After': '30' });
    await service.syncProject(projectId, 'tick');
    expect(service.getStatus()).toMatchObject({ projects: [{ backoffUntil: expect.any(String) }] });
    requests = [];
    await service.syncProject(projectId, 'tick');
    expect(requests).toEqual([]);
    await service.syncNow(projectId);
    expect(requests).toContain('GET /v1/head');
    expect(cloud.revoked).toEqual([]);
  });

  it('hands a 401 back to the cloud sign-in', async () => {
    failNext = json({ error: 'unauthorized' }, 401);
    await service.syncProject(projectId, 'tick');
    expect(cloud.revoked).toEqual(['unauthorized']);
  });

  it('a revoked device is reported as revoked', async () => {
    failNext = json({ error: 'device_revoked' }, 401);
    await service.syncProject(projectId, 'tick');
    expect(cloud.revoked).toEqual(['device_revoked']);
  });
});

describe('linking a project', () => {
  const remote = (id: string, fingerprint: string, name = id): RemoteProject => ({ id, name, fingerprint, createdByDevice: 'dev-0', createdAt: 5 });
  const addTask = (title: string, pid = projectId) =>
    TaskChangeRouter.initialize(dbAdapter(db)).applyChange(pid, { actor: 'user', entityType: 'task', title });

  beforeEach(() => service.start());

  it('offers fingerprint matches first, then every remote project not linked here', async () => {
    const other = svc.createProject('Q', join(dir, 'q')).id;
    service.store.optIn(other, 'taken', 'x');
    remoteProjects = [remote('m', 'github.com/o/r', 'Mine'), remote('o', 'gitlab.com/x/y'), remote('taken', 'z')];
    await addTask('existing');
    expect(await service.getProjectChoices(projectId)).toEqual({
      projectId,
      fingerprint: 'github.com/o/r',
      localItemCount: 1,
      matches: [{ id: 'm', name: 'Mine', createdAt: 5 }],
      others: [{ id: 'o', name: 'o', createdAt: 5 }],
    });
  });

  it('a project with no git remote matches nothing, not even a local fingerprint', async () => {
    originUrl = null;
    remoteProjects = [remote('l', 'local:1b4e28ba-2fa1-11d2-883f-0016d3cca427')];
    expect(await service.getProjectChoices(projectId)).toMatchObject({ fingerprint: null, matches: [], others: [{ id: 'l' }] });
  });

  it('the first machine creates the remote project (credentials stripped) and pushes its whole backlog', async () => {
    await addTask('one');
    await addTask('two');
    expect(await service.enableProject({ projectId, mode: 'create' })).toEqual({ ok: true, remoteProjectId: 'rp' });
    expect(created).toEqual([{ name: 'P', fingerprint: 'github.com/o/r' }]);
    expect(service.store.getProject(projectId)).toMatchObject({ remoteProjectId: 'rp', fingerprint: 'github.com/o/r' });
    await service.idle();
    expect(pushes.flatMap((p) => p.ops).map((o) => o.fields?.title?.value)).toEqual(['one', 'two']);
    expect(service.store.getProject(projectId)?.status).toBe('active');
  });

  it('a project with no remote is created under a fresh local fingerprint', async () => {
    originUrl = null;
    expect(await service.enableProject({ projectId, mode: 'create' })).toMatchObject({ ok: true });
    expect(created[0].fingerprint).toMatch(/^local:[0-9a-f-]{36}$/);
    expect(service.store.getProject(projectId)?.fingerprint).toBe(created[0].fingerprint);
  });

  it('creating a repo that already syncs offers the existing project instead', async () => {
    remoteProjects = [remote('m', 'github.com/o/r', 'Mine')];
    expect(await service.enableProject({ projectId, mode: 'create' })).toMatchObject({
      ok: false,
      reason: 'exists',
      project: { id: 'm', name: 'Mine', createdAt: 5 },
    });
    expect(service.store.getProject(projectId)).toBeNull();
  });

  it('joining needs an empty local backlog', async () => {
    remoteProjects = [remote('rp', 'github.com/o/r')];
    await addTask('local work');
    expect(await service.enableProject({ projectId, mode: 'join', remoteProjectId: 'rp' })).toMatchObject({ ok: false, reason: 'not_empty' });
    expect(service.store.getProject(projectId)).toBeNull();
    expect(requests).toEqual([]);
  });

  it('joins an empty project under the remote fingerprint and runs the first pass', async () => {
    remoteProjects = [remote('rp', 'github.com/o/r')];
    expect(await service.enableProject({ projectId, mode: 'join', remoteProjectId: 'rp' })).toEqual({ ok: true, remoteProjectId: 'rp' });
    expect(service.store.getProject(projectId)).toMatchObject({ remoteProjectId: 'rp', fingerprint: 'github.com/o/r' });
    await service.idle();
    expect(requests).toContain('GET /v1/head');
    expect(service.store.getProject(projectId)?.status).toBe('active');
  });

  it('refuses a remote project another local project already syncs, and a vanished one', async () => {
    const other = svc.createProject('Q', join(dir, 'q')).id;
    service.store.optIn(other, 'rp', 'x');
    remoteProjects = [remote('rp', 'github.com/o/r')];
    expect(await service.enableProject({ projectId, mode: 'join', remoteProjectId: 'rp' })).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await service.enableProject({ projectId, mode: 'join', remoteProjectId: 'gone' })).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('is idempotent for a linked project and refuses re-linking it elsewhere', async () => {
    service.store.optIn(projectId, 'rp', 'fp');
    expect(await service.enableProject({ projectId, mode: 'create' })).toEqual({ ok: true, remoteProjectId: 'rp' });
    expect(await service.enableProject({ projectId, mode: 'join', remoteProjectId: 'other' })).toMatchObject({ ok: false, reason: 'conflict' });
    expect(created).toEqual([]);
  });

  it('is not ready while sync is off', async () => {
    config.set(false);
    expect(await service.enableProject({ projectId, mode: 'create' })).toMatchObject({ ok: false, reason: 'not_ready' });
    await expect(service.getProjectChoices(projectId)).rejects.toThrow(/not ready/);
  });

  it('hands a 401 while listing back to the cloud sign-in', async () => {
    failNext = json({ error: 'unauthorized' }, 401);
    await expect(service.getProjectChoices(projectId)).rejects.toThrow();
    expect(cloud.revoked).toEqual(['unauthorized']);
  });

  it('turning sync off for a project unlinks it and keeps its backlog', async () => {
    await addTask('keep me');
    await service.enableProject({ projectId, mode: 'create' });
    await service.disableProject(projectId);
    expect(service.store.getProject(projectId)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?').get(projectId)).toEqual({ n: 1 });
    expect(service.getStatus()).toMatchObject({ projects: [{ projectId, remoteProjectId: null, status: null, trackerClaims: [] }] });
  });
});

describe('tracker connections on join', () => {
  it('pauses running trackers while the first pull applies, then resumes them through the claim', async () => {
    const rows = [{ id: 'c1', projectId, provider: 'linear' as const, workspaceId: 'w', workspaceName: 'acme', baseUrl: null, status: 'active' as 'active' | 'paused' }];
    const statusDuringPass: string[] = [];
    service.trackerClaims.setConnections({
      listLive: () => rows,
      pause: (id) => {
        const r = rows.find((x) => x.id === id);
        if (r) r.status = 'paused';
      },
      resume: async (id) => {
        const r = rows.find((x) => x.id === id);
        const decision = r ? await service.trackerClaims.acquire(r) : { allowed: false as const, reason: 'gone' };
        if (r && decision.allowed) r.status = 'active';
        return decision;
      },
    });
    service.start();
    remoteProjects = [{ id: 'rp', name: 'rp', fingerprint: 'github.com/o/r', createdByDevice: 'dev-0', createdAt: 5 }];
    expect(await service.enableProject({ projectId, mode: 'join', remoteProjectId: 'rp' })).toMatchObject({ ok: true });
    statusDuringPass.push(rows[0].status);
    await service.idle();
    expect(statusDuringPass).toEqual(['paused']);
    expect(rows[0].status).toBe('active');
    expect(requests).toContain('POST /v1/tracker-claims');
  });
});

describe('status for the Sync section', () => {
  it('lists every local project, with claims and a log for the synced ones', async () => {
    const other = svc.createProject('Q', join(dir, 'q')).id;
    service.start();
    await service.enableProject({ projectId, mode: 'create' });
    await service.idle();
    service.store.putClaim({ key: 'rp|linear|w|', projectId, state: 'held_by_other', holderDevice: 'dev-2', holderLabel: 'Linear (acme) runs on Laptop', checkedAt: 'x' });
    service.store.putClaim({ key: 'rp|plane|p|', projectId, state: 'free', holderDevice: null, holderLabel: null, checkedAt: 'x' });
    const status = service.getStatus();
    expect(status.available && status.projects).toEqual([
      expect.objectContaining({ projectId, name: 'P', remoteProjectId: 'rp', status: 'active', trackerClaims: [{ label: 'Linear (acme) runs on Laptop', mine: false }] }),
      expect.objectContaining({ projectId: other, name: 'Q', remoteProjectId: null, status: null, trackerClaims: [] }),
    ]);
    expect(service.getLog(projectId).some((l) => l.endsWith('created remote project rp'))).toBe(true);
    expect(service.getLog(other)).toEqual([]);
  });
});

describe('mass-delete hold', () => {
  /** N tasks this machine has already agreed with the server on. */
  async function syncedTasks(n: number): Promise<string[]> {
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const r = await router.applyChange(projectId, { actor: 'user', entityType: 'task', title: `t${i}` });
      ids.push(r.taskId);
      const ref = (db.prepare('SELECT ref FROM tasks WHERE id = ?').get(r.taskId) as { ref: string }).ref;
      service.store.putEntity({
        entityType: 'task', entityId: r.taskId, projectId, ref, version: 1,
        base: { title: { value: `t${i}`, v: 1, hlc: '1700000000000:00000:dev-0' } },
        dirty: {}, inbox: {}, pendingDelete: null,
      });
    }
    return ids;
  }
  const tombstonesPushed = () => pushes.flatMap((p) => p.ops).filter((o) => o.kind === 'tombstone').length;
  const held = () => {
    const s = service.getStatus();
    return s.available ? s.projects.find((p) => p.projectId === projectId)?.heldDeletes : undefined;
  };

  beforeEach(() => {
    service.store.optIn(projectId, 'rp', 'fp');
    service.start();
  });

  it('pushes up to 25 deletes an hour without asking', async () => {
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    for (const id of (await syncedTasks(30)).slice(0, 25)) await router.applyDelete(projectId, { actor: 'user', taskId: id });
    await service.syncNow(projectId);
    expect(tombstonesPushed()).toBe(25);
    expect(held()).toBe(0);
  });

  it('holds more than that until confirmed, counting the rolling hour', async () => {
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const ids = await syncedTasks(40);
    for (const id of ids.slice(0, 20)) await router.applyDelete(projectId, { actor: 'user', taskId: id });
    await service.syncNow(projectId);
    expect(tombstonesPushed()).toBe(20);
    for (const id of ids.slice(20, 30)) await router.applyDelete(projectId, { actor: 'user', taskId: id });
    await service.syncNow(projectId);
    expect(tombstonesPushed()).toBe(20);
    expect(held()).toBe(10);
    await service.confirmHeldDeletes(projectId);
    expect(tombstonesPushed()).toBe(30);
    expect(held()).toBe(0);
  });

  it('restores held deletes from the values last agreed with the server', async () => {
    const router = TaskChangeRouter.initialize(dbAdapter(db));
    const ids = await syncedTasks(30);
    for (const id of ids) await router.applyDelete(projectId, { actor: 'user', taskId: id });
    await service.syncNow(projectId);
    expect(held()).toBe(30);
    expect(await service.restoreHeldDeletes(projectId)).toBe(30);
    const titles = (db.prepare('SELECT title FROM tasks WHERE project_id = ? ORDER BY title').all(projectId) as Array<{ title: string }>).map((r) => r.title);
    expect(titles).toHaveLength(30);
    expect(titles).toContain('t7');
    expect(held()).toBe(0);
    expect(service.store.listTombstones(projectId)).toEqual([]);
    await service.syncNow(projectId);
    expect(tombstonesPushed()).toBe(0);
  });
});
