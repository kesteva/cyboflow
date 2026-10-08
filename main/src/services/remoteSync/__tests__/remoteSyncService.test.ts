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
import type { PushRequest } from '../../../../../shared/types/remoteSyncWire';
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

const fakeFetch: FetchLike = (async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
  requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
  if (failNext) {
    const r = failNext;
    failNext = null;
    return r;
  }
  if (url.pathname === '/v1/head') return json({ now: Date.now(), projects: { rp: 0 }, claims: [] });
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
