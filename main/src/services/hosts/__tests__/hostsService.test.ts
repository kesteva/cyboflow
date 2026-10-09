import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dbAdapter } from '../../../orchestrator/__test_fixtures__/dbAdapter';
import { HostStore } from '../../../orchestrator/hosts/hostStore';
import { HOSTS_CHANNEL, hostEvents, hostPreflightChannel } from '../../../orchestrator/hostsBridge';
import {
  HOSTS_ERROR_NAMES,
  PREFLIGHT_CHECK_IDS,
  type HostsChangedEvent,
  type PreflightCheckResult,
  type PreflightProgressEvent,
  type PreflightResult,
} from '../../../../../shared/types/hosts';
import type { ExecutionHost } from '../../../orchestrator/trpc/contracts/executionHost';
import { HostsService, summarizePreflight, type HostTerminalsLike } from '../hostsService';
import { REMOTE_HOSTS_KILL_SWITCH_ENV, HOST_PREFLIGHT_SCHEDULE_KILL_SWITCH_ENV } from '../flags';
import type { LoggerLike } from '../../../orchestrator/types';

const SQL = readFileSync(join(__dirname, '..', '..', '..', 'database', 'migrations', '152_hosts.sql'), 'utf-8');

function check(id: PreflightCheckResult['id'], status: PreflightCheckResult['status']): PreflightCheckResult {
  return { id, label: id, status, detail: `${id} ${status}`, tierImpact: 'none', durationMs: 1 };
}

function result(hostId: string, over: Partial<PreflightResult> = {}): PreflightResult {
  return {
    hostId, mode: 'full', startedAt: '2026-10-09T12:00:00.000Z', finishedAt: '2026-10-09T12:00:05.000Z',
    results: PREFLIGHT_CHECK_IDS.map((id) => check(id, id === 'sdk-binary-hash' ? 'skipped' : 'pass')),
    reachable: true, probeComplete: true, detectedTier: 'cli',
    runtimes: { claudeSdk: false, codexSdk: false, claudeCli: true, codexCli: false },
    arch: 'arm64', osVersion: 'macOS 15.1', toolchainHash: null, appVersion: '1.0.0', ...over,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** A controllable ExecutionHost: each preflight() call waits on a deferred and records its signal. */
function fakeHost(id: string) {
  const runs: Array<{ d: Deferred<PreflightResult>; onCheck?: (r: PreflightCheckResult) => void; signal?: AbortSignal }> = [];
  const host = {
    info: { id, kind: id === 'local' ? 'local' : 'ssh', label: id },
    preflight: vi.fn((_mode: PreflightResult['mode'], onCheck?: (r: PreflightCheckResult) => void, signal?: AbortSignal) => {
      const d = deferred<PreflightResult>();
      runs.push({ d, onCheck, signal });
      return d.promise;
    }),
  } as unknown as ExecutionHost & { preflight: ReturnType<typeof vi.fn> };
  return { host, runs };
}

function fakeTerminals(): HostTerminalsLike & Record<keyof HostTerminalsLike, ReturnType<typeof vi.fn>> {
  return {
    open: vi.fn((hostId: string) => `host::${hostId}::t1`),
    write: vi.fn(),
    resize: vi.fn(),
    getBacklog: vi.fn(() => ({ backlog: 'b', exited: false, exitCode: null })),
    closeOne: vi.fn(),
    closeForHost: vi.fn(),
    destroyAll: vi.fn(),
    listOwnedShells: vi.fn(() => []),
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

let raw: Database.Database;
let store: HostStore;
let hosts: Map<string, ReturnType<typeof fakeHost>>;
let registry: { get: ReturnType<typeof vi.fn>; invalidate: ReturnType<typeof vi.fn>; closeAllMasters: ReturnType<typeof vi.fn> };
let terminals: ReturnType<typeof fakeTerminals>;
let env: NodeJS.ProcessEnv;
let enabled: boolean;
let available: boolean;
let changes: HostsChangedEvent[];
let logger: LoggerLike;
let captureError: ReturnType<typeof vi.fn>;
let service: HostsService;
let ids = 0;
const onChange = (e: HostsChangedEvent): void => { changes.push(e); };

function hostFor(id: string): ReturnType<typeof fakeHost> {
  let h = hosts.get(id);
  if (!h) {
    h = fakeHost(id);
    hosts.set(id, h);
  }
  return h;
}

beforeEach(() => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  raw.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
            CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT);
            CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, status TEXT);`);
  raw.exec(SQL);
  store = new HostStore(dbAdapter(raw), { newId: () => `h${++ids}` });
  hosts = new Map();
  registry = { get: vi.fn((id: string) => hostFor(id).host), invalidate: vi.fn(), closeAllMasters: vi.fn() };
  terminals = fakeTerminals();
  env = {};
  enabled = true;
  available = true;
  changes = [];
  logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  captureError = vi.fn();
  hostEvents.on(HOSTS_CHANNEL, onChange);
  service = new HostsService({
    store, registry, terminals, appVersion: '1.0.0',
    isAvailable: () => available, isEnabled: () => available && enabled, env, logger, captureError,
  });
});

afterEach(() => {
  hostEvents.off(HOSTS_CHANNEL, onChange);
  raw.close();
});

/** addSsh, then settle the kicked background preflight with a reachable cli result. */
async function addSettled(label = 'Box', sshTarget = 'box'): Promise<string> {
  const { id } = await service.addSsh({ label, sshTarget });
  await flush();
  hostFor(id).runs[0].d.resolve(result(id));
  await flush();
  await store._queue().onIdle();
  return id;
}

describe('status', () => {
  it('reflects availability, enablement and both kill switches', () => {
    expect(service.status()).toEqual({ available: true, enabled: true, killed: false, scheduleKilled: false, running: true });
    env[REMOTE_HOSTS_KILL_SWITCH_ENV] = '1';
    env[HOST_PREFLIGHT_SCHEDULE_KILL_SWITCH_ENV] = '1';
    expect(service.status()).toMatchObject({ killed: true, scheduleKilled: true, running: true });
    enabled = false;
    expect(service.status()).toMatchObject({ enabled: false, running: false });
    available = false;
    expect(service.status()).toMatchObject({ available: false, enabled: false, running: false });
    env[REMOTE_HOSTS_KILL_SWITCH_ENV] = 'true';
    expect(service.status().killed).toBe(false);
  });
});

describe('feature gate', () => {
  it('refuses every mutation, preflight and terminal input by NAME when not running; reads still answer', async () => {
    const id = await addSettled();
    enabled = false;
    const disabled = { name: HOSTS_ERROR_NAMES.disabled };
    await expect(service.addSsh({ label: 'X', sshTarget: 'x' })).rejects.toMatchObject(disabled);
    await expect(service.update(id, { label: 'Y' })).rejects.toMatchObject(disabled);
    await expect(service.setUserCap(id, 'cli')).rejects.toMatchObject(disabled);
    await expect(service.archive(id)).rejects.toMatchObject(disabled);
    await expect(service.setProjectDefault(1, null)).rejects.toMatchObject(disabled);
    await expect(service.runPreflight('local')).rejects.toMatchObject(disabled);
    await expect(service.terminalOpen(id)).rejects.toMatchObject(disabled);
    expect(() => service.terminalInput('host::x::t1', 'ls')).toThrow(expect.objectContaining(disabled));
    expect(service.list({ includeArchived: false }).map((h) => h.id)).toEqual(['local', id]);
    expect(service.get(id).label).toBe('Box');
    expect(service.terminalBacklog('t').backlog).toBe('b');
    service.terminalClose('t');
    expect(terminals.closeOne).toHaveBeenCalledWith('t');
  });
});

describe('remote kill switch', () => {
  it('refuses SSH mutations, SSH preflights and terminals; local stays usable and rows stay readable', async () => {
    const id = await addSettled();
    env[REMOTE_HOSTS_KILL_SWITCH_ENV] = '1';
    const killed = { name: HOSTS_ERROR_NAMES.killed };
    await expect(service.addSsh({ label: 'X', sshTarget: 'x' })).rejects.toMatchObject(killed);
    await expect(service.update(id, { label: 'Y' })).rejects.toMatchObject(killed);
    await expect(service.setUserCap(id, 'cli')).rejects.toMatchObject(killed);
    await expect(service.archive(id)).rejects.toMatchObject(killed);
    await expect(service.runPreflight(id)).rejects.toMatchObject(killed);
    await expect(service.terminalOpen(id)).rejects.toMatchObject(killed);
    expect(() => service.terminalResize('t', 80, 24)).toThrow(expect.objectContaining(killed));
    await expect(service.setProjectDefault(1, id)).rejects.toMatchObject(killed);
    expect(service.list({ includeArchived: false }).map((h) => h.id)).toEqual(['local', id]);
    const p = service.runPreflight('local');
    hostFor('local').runs[0].d.resolve(result('local', { detectedTier: 'full' }));
    await expect(p).resolves.toMatchObject({ hostId: 'local' });
    expect(terminals.open).not.toHaveBeenCalled();
  });
});

describe('runPreflight', () => {
  it('coalesces concurrent calls onto one run and tracks preflightRunning', async () => {
    const id = await addSettled();
    const a = service.runPreflight(id);
    const b = service.runPreflight(id);
    await flush();
    expect(hostFor(id).host.preflight).toHaveBeenCalledTimes(2); // 1 from add + 1 coalesced
    expect(service.get(id).preflightRunning).toBe(true);
    const r = result(id);
    hostFor(id).runs[1].d.resolve(r);
    await expect(a).resolves.toBe(r);
    await expect(b).resolves.toBe(r);
    expect(service.get(id).preflightRunning).toBe(false);
  });

  it('emits progress per check, a done event, and hosts-changed at start and end', async () => {
    const id = await addSettled();
    const progress: PreflightProgressEvent[] = [];
    const onProgress = (e: PreflightProgressEvent): void => { progress.push(e); };
    hostEvents.on(hostPreflightChannel(id), onProgress);
    try {
      changes = [];
      const p = service.runPreflight(id);
      expect(changes).toContainEqual({ kind: 'hosts', hostId: id });
      await flush();
      const run = hostFor(id).runs[1];
      run.onCheck?.(check('ssh-reachable', 'pass'));
      run.onCheck?.(check('arch', 'pass'));
      run.d.resolve(result(id));
      await p;
      expect(progress.map((e) => [e.check?.id ?? null, e.done])).toEqual([
        ['ssh-reachable', false], ['arch', false], [null, true],
      ]);
      expect(changes.length).toBeGreaterThanOrEqual(3); // start + store write + end
    } finally {
      hostEvents.off(hostPreflightChannel(id), onProgress);
    }
  });

  it('records a reachable result and sets lastAttempt', async () => {
    const id = await addSettled();
    const v = service.get(id);
    expect(v).toMatchObject({
      detectedTier: 'cli', effectiveTier: 'cli', tierSource: 'detected', lifecycleState: 'online',
      preflightAt: '2026-10-09T12:00:05.000Z', arch: 'arm64',
    });
    expect(v.lastAttempt).toEqual({ at: '2026-10-09T12:00:05.000Z', reachable: true, summary: '11 passed · 1 skipped' });
    expect(v.preflight?.hostId).toBe(id);
  });

  it('an unreachable run keeps the last reachable result and reports it in lastAttempt', async () => {
    const id = await addSettled();
    const p = service.runPreflight(id);
    await flush();
    hostFor(id).runs[1].d.resolve(result(id, {
      reachable: false, detectedTier: null, finishedAt: '2026-10-10T00:00:00.000Z',
      results: [{ ...check('ssh-reachable', 'fail'), detail: 'Connection refused' }],
    }));
    await p;
    await store._queue().onIdle();
    const v = service.get(id);
    expect(v.lifecycleState).toBe('unreachable');
    expect(v.detectedTier).toBe('cli');
    expect(v.preflightAt).toBe('2026-10-09T12:00:05.000Z');
    expect(v.lastAttempt).toEqual({ at: '2026-10-10T00:00:00.000Z', reachable: false, summary: 'Not reachable: Connection refused' });
  });

  it('a reachable-but-incomplete run keeps the last good result and says the check did not finish', async () => {
    const id = await addSettled();
    const p = service.runPreflight(id);
    await flush();
    hostFor(id).runs[1].d.resolve(result(id, {
      probeComplete: false, detectedTier: null, arch: null, finishedAt: '2026-10-10T00:00:00.000Z',
      results: [check('ssh-reachable', 'pass'), ...PREFLIGHT_CHECK_IDS.slice(1).map((c) => check(c, 'skipped'))],
    }));
    await p;
    await store._queue().onIdle();
    const v = service.get(id);
    expect(v).toMatchObject({ lifecycleState: 'online', detectedTier: 'cli', arch: 'arm64', preflightAt: '2026-10-09T12:00:05.000Z' });
    expect(v.preflight?.results.filter((c) => c.status === 'pass')).toHaveLength(11);
    expect(v.lastAttempt?.summary).toMatch(/did not finish/);
  });

  it('unknown and archived hosts are not found', async () => {
    await expect(service.runPreflight('nope')).rejects.toMatchObject({ name: HOSTS_ERROR_NAMES.notFound });
    const id = await addSettled();
    await service.archive(id);
    await expect(service.runPreflight(id)).rejects.toMatchObject({ name: HOSTS_ERROR_NAMES.notFound });
  });

  it('addSsh resolves before its kicked preflight finishes', async () => {
    const { id } = await service.addSsh({ label: 'Box', sshTarget: 'box' });
    await flush();
    expect(hostFor(id).host.preflight).toHaveBeenCalledWith('full', expect.any(Function), expect.any(AbortSignal));
    expect(service.get(id).preflightRunning).toBe(true);
    hostFor(id).runs[0].d.resolve(result(id));
  });
});

describe('HostView', () => {
  it('This Mac is fixed full and always online', () => {
    const v = service.get('local');
    expect(v).toMatchObject({
      kind: 'local', tierSource: 'fixed', detectedTier: 'full', effectiveTier: 'full', userCapTier: null,
      lifecycleState: 'online', sshTarget: null, preflightRunning: false, lastAttempt: null,
    });
  });

  it('a user cap lowers the effective tier; active work is counted', async () => {
    const id = await addSettled();
    raw.prepare("UPDATE hosts SET detected_tier = 'full' WHERE id = ?").run(id);
    expect(service.get(id).effectiveTier).toBe('full');
    await service.setUserCap(id, 'cli');
    expect(service.get(id)).toMatchObject({ detectedTier: 'full', userCapTier: 'cli', effectiveTier: 'cli' });
    raw.exec(`INSERT INTO sessions (id,status,host_id) VALUES ('s1','running','${id}'),('s2','running',NULL);
              INSERT INTO workflow_runs (id,status,host_id) VALUES ('r1','running','${id}')`);
    expect(service.get(id)).toMatchObject({ runningSessions: 1, runningRuns: 1 });
    expect(service.get('local')).toMatchObject({ runningSessions: 1, runningRuns: 0 });
    await expect(service.archive(id)).rejects.toMatchObject({ name: HOSTS_ERROR_NAMES.hasActiveWork });
  });

  it('never-probed hosts have a null tier', async () => {
    const { id } = await service.addSsh({ label: 'New', sshTarget: 'new' });
    expect(service.get(id)).toMatchObject({ detectedTier: null, effectiveTier: null, lifecycleState: null, preflight: null });
    hostFor(id).runs[0]?.d.resolve(result(id));
  });

  it('get() of an unknown id throws HostNotFoundError', () => {
    expect(() => service.get('nope')).toThrow(expect.objectContaining({ name: HOSTS_ERROR_NAMES.notFound }));
  });
});

describe('update / archive / terminals / shutdown', () => {
  it('a target change invalidates the registry, clears lastAttempt and re-checks', async () => {
    const id = await addSettled();
    await service.update(id, { sshTarget: 'box2' });
    expect(registry.invalidate).toHaveBeenCalledWith(id);
    expect(service.get(id).lastAttempt).toBeNull();
    await flush();
    expect(hostFor(id).host.preflight).toHaveBeenCalledTimes(2);
    hostFor(id).runs[1].d.resolve(result(id));
    await service.update(id, { label: 'Renamed' });
    await flush();
    expect(hostFor(id).host.preflight).toHaveBeenCalledTimes(2);
  });

  it('a label-only edit neither invalidates the connection nor cancels a running preflight', async () => {
    const id = await addSettled();
    const p = service.runPreflight(id);
    await flush();
    await service.update(id, { label: 'Renamed' });
    expect(registry.invalidate).not.toHaveBeenCalled();
    expect(hostFor(id).runs[1].signal?.aborted).toBe(false);
    hostFor(id).runs[1].d.resolve(result(id, { finishedAt: '2026-10-11T00:00:00.000Z' }));
    await p;
    await store._queue().onIdle();
    expect(service.get(id)).toMatchObject({ label: 'Renamed', preflightAt: '2026-10-11T00:00:00.000Z' });
  });

  it('a target change mid-preflight cancels the old run and records only the new machine', async () => {
    const id = await addSettled();
    const old = service.runPreflight(id);
    await flush();
    const progress: PreflightProgressEvent[] = [];
    const onProgress = (e: PreflightProgressEvent): void => { progress.push(e); };
    hostEvents.on(hostPreflightChannel(id), onProgress);
    try {
      await service.update(id, { sshTarget: 'box2' });
      await flush();
      expect(hostFor(id).runs[1].signal?.aborted).toBe(true);
      // A fresh run, not a coalesce onto the old one.
      expect(hostFor(id).host.preflight).toHaveBeenCalledTimes(3);
      const again = service.runPreflight(id);
      expect(hostFor(id).host.preflight).toHaveBeenCalledTimes(3);
      // The old machine answers late (with cancelled rows): nothing is recorded or broadcast for it.
      hostFor(id).runs[1].onCheck?.(check('arch', 'skipped'));
      hostFor(id).runs[1].d.resolve(result(id, { arch: 'x86_64', finishedAt: '2030-01-01T00:00:00.000Z' }));
      await old;
      await store._queue().onIdle();
      expect(service.get(id)).toMatchObject({ preflightRunning: true, preflight: null, arch: null, lastAttempt: null });
      expect(progress).toEqual([]);
      hostFor(id).runs[2].d.resolve(result(id, { arch: 'arm64', finishedAt: '2026-10-12T00:00:00.000Z' }));
      await again;
      await store._queue().onIdle();
      expect(service.get(id)).toMatchObject({ preflightRunning: false, arch: 'arm64', preflightAt: '2026-10-12T00:00:00.000Z' });
      expect(progress.filter((e) => e.done)).toHaveLength(1);
    } finally {
      hostEvents.off(hostPreflightChannel(id), onProgress);
    }
  });

  it('defensively skips recording when the row no longer names the target the run started with', async () => {
    const id = await addSettled();
    const p = service.runPreflight(id);
    await flush();
    await store.update(id, { sshTarget: 'elsewhere' }); // bypasses the service: no abort
    hostFor(id).runs[1].d.resolve(result(id, { arch: 'x86_64', finishedAt: '2030-01-01T00:00:00.000Z' }));
    await p;
    await store._queue().onIdle();
    expect(service.get(id)).toMatchObject({ preflight: null, arch: null });
    expect(service.get(id).lastAttempt?.at).toBe('2026-10-09T12:00:05.000Z');
  });

  it('archive closes the host terminals and invalidates its connection', async () => {
    const id = await addSettled();
    await service.archive(id);
    expect(terminals.closeForHost).toHaveBeenCalledWith(id);
    expect(registry.invalidate).toHaveBeenCalledWith(id);
  });

  it('terminalOpen opens an ssh terminal for SSH hosts only', async () => {
    const id = await addSettled();
    await expect(service.terminalOpen(id)).resolves.toEqual({ terminalId: `host::${id}::t1` });
    expect(terminals.open).toHaveBeenCalledWith(id, 'box');
    await expect(service.terminalOpen('local')).rejects.toMatchObject({ name: HOSTS_ERROR_NAMES.terminalUnavailable });
    service.terminalInput('host::x::t1', 'ls\n');
    service.terminalResize('host::x::t1', 100, 30);
    expect(terminals.write).toHaveBeenCalledWith('host::x::t1', 'ls\n');
    expect(terminals.resize).toHaveBeenCalledWith('host::x::t1', 100, 30);
  });

  it('shutdown aborts in-flight preflights (not recorded), destroys terminals and closes masters', async () => {
    const id = await addSettled();
    const p = service.runPreflight(id);
    await flush();
    service.shutdown();
    const run = hostFor(id).runs[1];
    expect(run.signal?.aborted).toBe(true);
    run.d.resolve(result(id, { reachable: false, detectedTier: null, finishedAt: '2030-01-01T00:00:00.000Z' }));
    await p;
    expect(service.get(id).lifecycleState).toBe('online');
    expect(service.get(id).lastAttempt?.at).toBe('2026-10-09T12:00:05.000Z');
    expect(terminals.destroyAll).toHaveBeenCalled();
    expect(registry.closeAllMasters).toHaveBeenCalled();
  });

  it('a failing record is logged, and reported unless the host was archived', async () => {
    const id = await addSettled();
    const spy = vi.spyOn(store, 'recordPreflight').mockRejectedValueOnce(new Error('disk'));
    const p = service.runPreflight(id);
    await flush();
    hostFor(id).runs[1].d.resolve(result(id));
    await p;
    expect(captureError).toHaveBeenCalledWith('host-preflight', expect.any(Error), { hostKind: 'ssh' });
    spy.mockRestore();
  });
});

describe('summarizePreflight', () => {
  it('counts statuses, singularises one warning', () => {
    const r = result('h', { results: [check('arch', 'pass'), check('git', 'warn'), check('node22', 'fail')] });
    expect(summarizePreflight(r)).toBe('1 passed · 1 warning · 1 failed');
  });

  it('a reachable run whose probe did not finish says so instead of counting skipped rows', () => {
    const r = result('h', { probeComplete: false, results: [check('ssh-reachable', 'pass'), check('arch', 'skipped')] });
    expect(summarizePreflight(r)).toBe('Reachable, but the check did not finish (connection dropped or timed out)');
  });
});
