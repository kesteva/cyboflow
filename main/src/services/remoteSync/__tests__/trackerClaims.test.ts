/**
 * Tracker claims: one device runs each tracker connection of a synced project.
 * A scripted claim service sits behind the FetchLike seam; tracker sync is a
 * fake TrackerClaimConnections.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../../../database/database';
import { dbAdapter } from '../../../orchestrator/__test_fixtures__/dbAdapter';
import type { TrackerClaimConnection, TrackerClaimConnections, TrackerClaimDecision } from '../../trackerSync/claimGate';
import type { TrackerClaim } from '../../../../../shared/types/remoteSyncWire';
import { SyncHttpClient, type FetchLike } from '../syncHttpClient';
import { SyncStore } from '../syncStore';
import { TrackerClaims, UNCONFIRMED_REASON, claimKey } from '../trackerClaims';

const ME = 'dev-1';

let dir: string;
let svc: DatabaseService;
let store: SyncStore;
let projectId: number;
let server: Map<string, TrackerClaim>;
let calls: Array<{ key: string; action: string; label: string }>;
let offline: boolean;
let syncOn: boolean;
let conns: FakeConnections;
let claims: TrackerClaims;
let logs: string[];

class FakeConnections implements TrackerClaimConnections {
  rows: TrackerClaimConnection[] = [];
  resumed: string[] = [];
  listLive(pid: number): TrackerClaimConnection[] {
    return this.rows.filter((r) => r.projectId === pid);
  }
  pause(id: string): void {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.status = 'paused';
  }
  async resume(id: string): Promise<TrackerClaimDecision> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return { allowed: false, reason: 'gone' };
    const decision = await claims.acquire(row);
    if (decision.allowed) {
      row.status = 'active';
      this.resumed.push(id);
    }
    return decision;
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const fetchFake: FetchLike = (async (_input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
  if (offline) throw new TypeError('fetch failed');
  const req = JSON.parse(String(init?.body)) as { key: string; label: string; action: 'check' | 'claim' | 'release' };
  calls.push(req);
  const held = server.get(req.key) ?? null;
  if (req.action === 'claim' && (!held || held.deviceId === ME)) {
    server.set(req.key, { key: req.key, deviceId: ME, label: req.label, claimedAt: held?.claimedAt ?? 1 });
  }
  if (req.action === 'release' && held?.deviceId === ME) server.delete(req.key);
  const now = server.get(req.key) ?? null;
  return json({ key: req.key, state: !now ? 'free' : now.deviceId === ME ? 'held_by_you' : 'held_by_other', holder: now });
}) as FetchLike;

const client = new SyncHttpClient({ origin: 'https://sync.test', fetch: fetchFake, getToken: () => 'tok', appVersion: 't' });

const conn = (id: string, over: Partial<TrackerClaimConnection> = {}): TrackerClaimConnection => ({
  id,
  projectId,
  provider: 'linear',
  workspaceId: 'ws-acme',
  workspaceName: 'acme',
  baseUrl: null,
  status: 'active',
  ...over,
});
const KEY = () => claimKey('rp', { provider: 'linear', workspaceId: 'ws-acme', baseUrl: null });
const otherHolds = (key: string) => server.set(key, { key, deviceId: 'dev-2', label: 'Linear (acme) runs on Laptop', claimedAt: 1 });
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cyboflow-claims-'));
  svc = new DatabaseService(join(dir, 'test.db'));
  svc.initialize();
  store = new SyncStore(dbAdapter(svc.getDb()));
  projectId = svc.createProject('P', join(dir, 'proj')).id;
  store.optIn(projectId, 'rp', 'fp');
  server = new Map();
  calls = [];
  offline = false;
  syncOn = true;
  logs = [];
  conns = new FakeConnections();
  claims = new TrackerClaims({
    store,
    getClient: () => client,
    getDevice: () => ({ deviceId: ME, deviceName: 'Studio' }),
    isSyncOn: () => syncOn,
    log: (_p, line) => logs.push(line),
  });
  claims.setConnections(conns);
});

afterEach(() => {
  svc.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('acquire', () => {
  it('allows a project that does not sync, or any project while sync is off, without asking', async () => {
    store.optOut(projectId);
    expect(await claims.acquire(conn('c1'))).toEqual({ allowed: true });
    store.optIn(projectId, 'rp', 'fp');
    syncOn = false;
    expect(await claims.acquire(conn('c1'))).toEqual({ allowed: true });
    expect(calls).toEqual([]);
  });

  it('claims a free connection under a readable label', async () => {
    expect(await claims.acquire(conn('c1'))).toEqual({ allowed: true });
    expect(calls).toEqual([{ key: 'rp|linear|ws-acme|', action: 'claim', label: 'Linear (acme) runs on Studio' }]);
    expect(store.getClaim(KEY())).toMatchObject({ state: 'held_by_you', holderDevice: ME });
  });

  it('refuses one another device runs, and says which', async () => {
    otherHolds(KEY());
    expect(await claims.acquire(conn('c1'))).toEqual({ allowed: false, reason: 'Paused: Linear (acme) runs on Laptop' });
    expect(claims.holdReason(conn('c1'))).toBe('Paused: Linear (acme) runs on Laptop');
  });

  it('fails closed when the service is unreachable, unless this device last held it', async () => {
    offline = true;
    expect(await claims.acquire(conn('c1'))).toEqual({ allowed: false, reason: UNCONFIRMED_REASON });
    expect(claims.holdReason(conn('c1'))).toBe(UNCONFIRMED_REASON);
    offline = false;
    await claims.acquire(conn('c1'));
    offline = true;
    expect(await claims.acquire(conn('c1'))).toEqual({ allowed: true });
  });

  it('keys on the instance too: a self-hosted Plane differs from another', async () => {
    expect(claimKey('rp', { provider: 'plane', workspaceId: 'w', baseUrl: 'https://a.example' })).not.toBe(
      claimKey('rp', { provider: 'plane', workspaceId: 'w', baseUrl: 'https://b.example' }),
    );
  });
});

describe('refresh from /head', () => {
  it('pauses a running connection another device holds, and never resumes it', async () => {
    conns.rows = [conn('c1')];
    otherHolds(KEY());
    await claims.refresh(projectId, [...server.values()]);
    expect(conns.rows[0].status).toBe('paused');
    expect(logs).toEqual(['tracker Linear (acme) paused: Linear (acme) runs on Laptop']);
    server.clear();
    await claims.refresh(projectId, []);
    expect(conns.rows[0].status).toBe('paused');
    expect(store.getClaim(KEY())?.state).toBe('free');
  });

  it('claims a free running connection once for mappings that share a workspace', async () => {
    conns.rows = [conn('c1'), conn('c2')];
    await claims.refresh(projectId, []);
    expect(calls.map((c) => c.action)).toEqual(['claim']);
    expect(conns.rows.map((r) => r.status)).toEqual(['active', 'active']);
    expect(server.get(KEY())?.deviceId).toBe(ME);
  });

  it('releases a claim this device holds for a connection it no longer has', async () => {
    const orphan = claimKey('rp', { provider: 'plane', workspaceId: 'old', baseUrl: null });
    server.set(orphan, { key: orphan, deviceId: ME, label: 'x', claimedAt: 1 });
    await claims.refresh(projectId, [...server.values()]);
    await flush();
    expect(calls).toEqual([{ key: orphan, label: '', action: 'release' }]);
    expect(server.has(orphan)).toBe(false);
  });

  it('ignores claims of other remote projects', async () => {
    const elsewhere = claimKey('rp-other', { provider: 'linear', workspaceId: 'ws-acme', baseUrl: null });
    server.set(elsewhere, { key: elsewhere, deviceId: 'dev-2', label: 'x', claimedAt: 1 });
    conns.rows = [conn('c1')];
    await claims.refresh(projectId, [...server.values()]);
    expect(conns.rows[0].status).toBe('active');
  });
});

describe('join + release', () => {
  it('holds running connections while a join bootstraps, then resumes those the claim allows', async () => {
    const plane = claimKey('rp', { provider: 'plane', workspaceId: 'p', baseUrl: null });
    conns.rows = [conn('c1'), conn('c2', { provider: 'plane', workspaceId: 'p', workspaceName: 'pl' }), conn('c3', { status: 'paused' })];
    claims.holdForJoin(projectId);
    expect(conns.rows.map((r) => r.status)).toEqual(['paused', 'paused', 'paused']);
    otherHolds(plane);
    await claims.resumeAfterJoin(projectId);
    expect(conns.resumed).toEqual(['c1']);
    expect(conns.rows.map((r) => r.status)).toEqual(['active', 'paused', 'paused']);
    await claims.resumeAfterJoin(projectId);
    expect(conns.resumed).toEqual(['c1']);
  });

  it('releases on disconnect only when no other live mapping shares the claim', async () => {
    conns.rows = [conn('c1'), conn('c2')];
    await claims.acquire(conn('c1'));
    calls = [];
    conns.rows = [conn('c2')];
    claims.release(conn('c1'));
    expect(calls).toEqual([]);
    conns.rows = [];
    claims.release(conn('c2'));
    await flush();
    expect(calls.map((c) => c.action)).toEqual(['release']);
    expect(store.getClaim(KEY())).toBeNull();
  });

  it('releaseAll gives back what this device holds before the project stops syncing', async () => {
    await claims.acquire(conn('c1'));
    claims.releaseAll(projectId);
    await flush();
    expect(server.size).toBe(0);
  });
});
