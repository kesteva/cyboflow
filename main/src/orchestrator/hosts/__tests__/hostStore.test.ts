import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { HostStore } from '../hostStore';
import { HOSTS_CHANNEL, hostEvents } from '../../hostsBridge';
import {
  HostHasActiveWorkError, HostLabelTakenError, HostNotFoundError, InvalidHostLabelError, InvalidSshTargetError,
  LocalHostImmutableError, TierCapAboveDetectedError,
} from '../errors';
import type { HostsChangedEvent, PreflightResult } from '../../../../../shared/types/hosts';

const SQL = readFileSync(join(__dirname, '..', '..', '..', 'database', 'migrations', '152_hosts.sql'), 'utf-8');
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let raw: Database.Database;
let store: HostStore;
let events: HostsChangedEvent[];
let ids: number;
let tick: number;
const onEvent = (e: HostsChangedEvent): void => { events.push(e); };

function preflight(over: Partial<PreflightResult> = {}): PreflightResult {
  return {
    hostId: 'x', mode: 'full', startedAt: '2026-10-09T10:00:00.000Z', finishedAt: '2026-10-09T10:00:01.000Z',
    results: [], reachable: true, probeComplete: true, detectedTier: 'cli',
    runtimes: { claudeSdk: false, codexSdk: false, claudeCli: true, codexCli: false },
    arch: 'arm64', osVersion: '15.0', toolchainHash: 'abc', appVersion: '1.2.3', ...over,
  };
}

beforeEach(() => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  raw.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
            CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT);
            CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, status TEXT);`);
  raw.exec(SQL);
  ids = 0;
  tick = 0;
  events = [];
  hostEvents.on(HOSTS_CHANNEL, onEvent);
  store = new HostStore(dbAdapter(raw), {
    now: () => new Date(Date.UTC(2026, 9, 9, 12, 0, tick++)),
    newId: () => `h${++ids}`,
  });
});

afterEach(() => {
  hostEvents.off(HOSTS_CHANNEL, onEvent);
  const rows = raw.prepare('SELECT * FROM hosts').all() as Array<Record<string, unknown>>;
  for (const r of rows) {
    for (const col of ['created_at', 'updated_at', 'archived_at', 'last_seen_at']) {
      const v = r[col];
      if (typeof v === 'string') expect(v, `${r.id}.${col}`).toMatch(ISO_RE);
    }
  }
  raw.close();
});

describe('HostStore reads', () => {
  it('lists This Mac first and hides archived by default', async () => {
    const id = await store.addSsh({ label: 'Box', sshTarget: 'box' });
    expect(store.list().map((h) => h.id)).toEqual(['local', id]);
    await store.archive(id);
    expect(store.list().map((h) => h.id)).toEqual(['local']);
    expect(store.list({ includeArchived: true }).map((h) => h.id)).toEqual(['local', id]);
  });

  it('counts active work; local includes NULL host_id', async () => {
    const id = await store.addSsh({ label: 'Box', sshTarget: 'box' });
    raw.exec(`INSERT INTO sessions (id,status,host_id) VALUES ('s1','running',NULL),('s2','pending','${id}'),('s3','stopped','${id}');
              INSERT INTO workflow_runs (id,status,host_id) VALUES ('r1','running',NULL),('r2','completed',NULL),('r3','running','${id}')`);
    expect(store.activeWork('local')).toEqual({ sessions: 1, runs: 1 });
    expect(store.activeWork(id)).toEqual({ sessions: 1, runs: 1 });
  });
});

describe('HostStore writes', () => {
  it('addSsh stores config and remote root, emits after commit', async () => {
    const id = await store.addSsh({ label: '  Box  ', sshTarget: 'me@box' });
    const row = store.get(id);
    expect(row).toMatchObject({ label: 'Box', kind: 'ssh', sshTarget: 'me@box', remoteRoot: `~/cf-remote/${id}`, detectedTier: null });
    expect(events).toEqual([{ kind: 'hosts', hostId: id }]);
  });

  it('rejects bad labels, targets and duplicates without emitting', async () => {
    await store.addSsh({ label: 'Box', sshTarget: 'box' });
    events.length = 0;
    await expect(store.addSsh({ label: 'Box', sshTarget: 'other' })).rejects.toBeInstanceOf(HostLabelTakenError);
    await expect(store.addSsh({ label: '', sshTarget: 'x' })).rejects.toBeInstanceOf(InvalidHostLabelError);
    await expect(store.addSsh({ label: 'a\nb', sshTarget: 'x' })).rejects.toBeInstanceOf(InvalidHostLabelError);
    await expect(store.addSsh({ label: 'x'.repeat(49), sshTarget: 'x' })).rejects.toBeInstanceOf(InvalidHostLabelError);
    await expect(store.addSsh({ label: 'Y', sshTarget: '-oProxyCommand=x' })).rejects.toBeInstanceOf(InvalidSshTargetError);
    expect(events).toEqual([]);
    expect(store.list()).toHaveLength(2);
  });

  it('an archived label can be reused', async () => {
    const id = await store.addSsh({ label: 'Box', sshTarget: 'box' });
    await store.archive(id);
    await expect(store.addSsh({ label: 'Box', sshTarget: 'box2' })).resolves.toBeTruthy();
  });

  it('update refuses This Mac and unknown ids; target change clears probe data', async () => {
    await expect(store.update('local', { label: 'x' })).rejects.toBeInstanceOf(LocalHostImmutableError);
    await expect(store.update('nope', { label: 'x' })).rejects.toBeInstanceOf(HostNotFoundError);
    const id = await store.addSsh({ label: 'Box', sshTarget: 'box' });
    await store.recordPreflight(id, preflight());
    expect(store.get(id)?.detectedTier).toBe('cli');
    await store.update(id, { label: 'Renamed' });
    expect(store.get(id)).toMatchObject({ label: 'Renamed', detectedTier: 'cli' });
    await store.update(id, { sshTarget: 'box2' });
    expect(store.get(id)).toMatchObject({
      sshTarget: 'box2', detectedTier: null, preflight: null, arch: null, osVersion: null, lifecycleState: null,
    });
  });

  it('update rejects a label taken by another live host', async () => {
    await store.addSsh({ label: 'A', sshTarget: 'a' });
    const b = await store.addSsh({ label: 'B', sshTarget: 'b' });
    await expect(store.update(b, { label: 'A' })).rejects.toBeInstanceOf(HostLabelTakenError);
  });

  it('setUserCap accepts cli/null and refuses full', async () => {
    const id = await store.addSsh({ label: 'Box', sshTarget: 'box' });
    await store.setUserCap(id, 'cli');
    expect(store.get(id)?.userCapTier).toBe('cli');
    await store.setUserCap(id, null);
    expect(store.get(id)?.userCapTier).toBeNull();
    await expect(store.setUserCap(id, 'full')).rejects.toBeInstanceOf(TierCapAboveDetectedError);
  });

  it('recordPreflight: reachable writes everything; unreachable keeps the last result and tier', async () => {
    const id = await store.addSsh({ label: 'Box', sshTarget: 'box' });
    await store.recordPreflight(id, preflight({ hostId: id }));
    let row = store.get(id);
    expect(row).toMatchObject({
      detectedTier: 'cli', arch: 'arm64', osVersion: '15.0', lifecycleState: 'online',
      preflightAt: '2026-10-09T10:00:01.000Z', preflightAppVersion: '1.2.3',
    });
    expect(row?.preflight?.toolchainHash).toBe('abc');
    expect(row?.lastSeenAt).toMatch(ISO_RE);
    await store.recordPreflight(id, preflight({ hostId: id, reachable: false, detectedTier: null, arch: null }));
    row = store.get(id);
    expect(row).toMatchObject({ lifecycleState: 'unreachable', detectedTier: 'cli', arch: 'arm64' });
    expect(row?.preflight).not.toBeNull();
  });

  it('recordPreflight: reachable but incomplete marks online and keeps the last complete result', async () => {
    const id = await store.addSsh({ label: 'Box', sshTarget: 'box' });
    await store.recordPreflight(id, preflight({ hostId: id }));
    await store.recordPreflight(id, preflight({ hostId: id, reachable: false, detectedTier: null }));
    expect(store.get(id)?.lifecycleState).toBe('unreachable');
    const lastSeen = store.get(id)?.lastSeenAt;
    await store.recordPreflight(id, preflight({
      hostId: id, probeComplete: false, detectedTier: null, arch: null, osVersion: null,
      finishedAt: '2026-10-09T11:00:00.000Z', toolchainHash: null, appVersion: '9.9.9',
    }));
    const row = store.get(id);
    expect(row).toMatchObject({
      lifecycleState: 'online', detectedTier: 'cli', arch: 'arm64', osVersion: '15.0',
      preflightAt: '2026-10-09T10:00:01.000Z', preflightAppVersion: '1.2.3',
    });
    expect(row?.preflight).toMatchObject({ probeComplete: true, toolchainHash: 'abc' });
    expect(row?.lastSeenAt).not.toBe(lastSeen);
  });

  it('a persisted preflight written before probeComplete existed reads as complete', async () => {
    const id = await store.addSsh({ label: 'Box', sshTarget: 'box' });
    const legacy: Record<string, unknown> = { ...preflight({ hostId: id }) };
    delete legacy.probeComplete;
    raw.prepare('UPDATE hosts SET preflight_json = ? WHERE id = ?').run(JSON.stringify(legacy), id);
    expect(store.get(id)?.preflight?.probeComplete).toBe(true);
  });

  it('archive refuses local, active work, and clears project defaults', async () => {
    await expect(store.archive('local')).rejects.toBeInstanceOf(LocalHostImmutableError);
    const id = await store.addSsh({ label: 'Box', sshTarget: 'box' });
    raw.exec(`INSERT INTO projects (id,name) VALUES (1,'p'); INSERT INTO workflow_runs (id,status,host_id) VALUES ('r1','running','${id}')`);
    await expect(store.archive(id)).rejects.toBeInstanceOf(HostHasActiveWorkError);
    expect(store.get(id)?.archivedAt).toBeNull();
    raw.exec(`UPDATE workflow_runs SET status='completed'`);
    await store.setProjectDefault(1, id);
    expect(store.projectDefault(1)).toBe(id);
    await store.archive(id);
    expect(store.get(id)?.archivedAt).toMatch(ISO_RE);
    expect(store.projectDefault(1)).toBeNull();
  });

  it('setProjectDefault needs a live host; null clears', async () => {
    raw.exec(`INSERT INTO projects (id,name) VALUES (1,'p')`);
    await expect(store.setProjectDefault(1, 'nope')).rejects.toBeInstanceOf(HostNotFoundError);
    const id = await store.addSsh({ label: 'Box', sshTarget: 'box' });
    await store.archive(id);
    await expect(store.setProjectDefault(1, id)).rejects.toBeInstanceOf(HostNotFoundError);
    await store.setProjectDefault(1, 'local');
    expect(store.projectDefault(1)).toBe('local');
    await store.setProjectDefault(1, null);
    expect(store.projectDefault(1)).toBeNull();
  });

  it('a throwing listener cannot break the write', async () => {
    const boom = (): void => { throw new Error('x'); };
    hostEvents.on(HOSTS_CHANNEL, boom);
    try {
      const id = await store.addSsh({ label: 'Box', sshTarget: 'box' });
      expect(store.get(id)).not.toBeNull();
    } finally {
      hostEvents.off(HOSTS_CHANNEL, boom);
    }
  });
});
