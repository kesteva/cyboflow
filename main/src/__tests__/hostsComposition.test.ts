/**
 * hostsComposition: the facade is injected, start()/stop() are idempotent, config changes relay a status
 * event, and stop() (the quit drain) destroys open host terminals. node-pty is mocked and the scheduler is
 * kill-switched, so nothing here spawns ssh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ptyKills = vi.hoisted(() => ({
  kill: [] as string[],
  spawned: [] as string[],
  exits: [] as Array<(e: { exitCode: number }) => void>,
}));

vi.mock('@homebridge/node-pty-prebuilt-multiarch', () => ({
  spawn: (file: string) => {
    ptyKills.spawned.push(file);
    return {
      pid: 4242,
      onData: () => undefined,
      onExit: (cb: (e: { exitCode: number }) => void) => { ptyKills.exits.push(cb); },
      write: () => undefined,
      resize: () => undefined,
      kill: (sig?: string) => { ptyKills.kill.push(sig ?? 'SIGHUP'); },
    };
  },
}));

import { composeHosts, defaultOrchSocketPath, type HostsComposition } from '../hostsComposition';
import { dbAdapter } from '../orchestrator/__test_fixtures__/dbAdapter';
import {
  _resetHostsFacadeForTesting,
  HOSTS_CHANNEL,
  hostEvents,
  hostTerminalChannel,
  peekHostsFacade,
} from '../orchestrator/hostsBridge';
import { HOST_PREFLIGHT_SCHEDULE_KILL_SWITCH_ENV } from '../services/hosts/flags';
import type { HostsServiceDeps } from '../services/hosts/hostsService';
import { getRemoteRuntime, setRemoteRuntime } from '../services/hosts/remoteRuntimeBridge';
import { getRemoteCheckout, setRemoteCheckout } from '../services/hosts/remoteCheckoutBridge';
import { getMergeBackService, setMergeBackService } from '../services/hosts/mergeBack/mergeBackBridge';
import { sprintLaneChannel, sprintLaneEvents } from '../orchestrator/sprintLaneStore';
import { runStatusEvents } from '../orchestrator/trpc/routers/events';
import type { HostsChangedEvent } from '../../../shared/types/hosts';
import type { LoggerLike } from '../orchestrator/types';

const SQL = readFileSync(join(__dirname, '..', 'database', 'migrations', '152_hosts.sql'), 'utf-8');

class FakeConfig extends EventEmitter {
  available = true;
  enabled = true;
  isEnvironmentsAvailable(): boolean { return this.available; }
  isEnvironmentsEnabled(): boolean { return this.available && this.enabled; }
}

const logger: LoggerLike = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

let raw: Database.Database;
let config: FakeConfig;
let sent: Array<{ channel: string; chunk: string }>;
let comp: HostsComposition;
let events: HostsChangedEvent[];
const onEvent = (e: HostsChangedEvent): void => { events.push(e); };

/** A main-window webContents stand-in: an EventEmitter with an id and send(). */
class FakeWebContents extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }
  send(channel: string, chunk: string): void {
    sent.push({ channel, chunk });
  }
}
let webContents: FakeWebContents;

function compose(): HostsComposition {
  return composeHosts({
    db: dbAdapter(raw),
    // on/off return `this` (a full ConfigManager); the composition only uses the picked methods.
    configManager: config as unknown as Parameters<typeof composeHosts>[0]['configManager'],
    logger,
    appVersion: '0.0.0-test',
    getMainWindow: () => ({ webContents }) as unknown as ReturnType<Parameters<typeof composeHosts>[0]['getMainWindow']>,
  });
}

function insertHost(): void {
  raw.prepare(
    `INSERT INTO hosts (id, label, kind, config_json, created_at, updated_at)
     VALUES ('h1', 'Studio', 'ssh', ?, '2026-10-09T10:00:00.000Z', '2026-10-09T10:00:00.000Z')`,
  ).run(JSON.stringify({ sshTarget: 'me@studio.local', remoteRoot: '~/cf-remote/h1' }));
}

beforeEach(() => {
  vi.stubEnv(HOST_PREFLIGHT_SCHEDULE_KILL_SWITCH_ENV, '1');
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  raw.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
            CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT);
            CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, status TEXT);`);
  raw.exec(SQL);
  config = new FakeConfig();
  sent = [];
  events = [];
  ptyKills.kill = [];
  ptyKills.spawned = [];
  ptyKills.exits = [];
  webContents = new FakeWebContents(1);
  hostEvents.on(HOSTS_CHANNEL, onEvent);
  comp = compose();
});

afterEach(() => {
  comp.stop();
  hostEvents.off(HOSTS_CHANNEL, onEvent);
  _resetHostsFacadeForTesting();
  setRemoteRuntime(null);
  setRemoteCheckout(null);
  setMergeBackService(null);
  raw.close();
  vi.unstubAllEnvs();
});

describe('composeHosts', () => {
  it('injects the service as the facade at construction (no start needed)', () => {
    expect(peekHostsFacade()).toBe(comp.service);
    expect(comp.service.list({ includeArchived: false }).map((h) => h.id)).toEqual(['local']);
  });

  it('reads the gates live from the config manager', () => {
    expect(comp.service.status()).toMatchObject({ available: true, enabled: true, running: true });
    config.enabled = false;
    expect(comp.service.status()).toMatchObject({ enabled: false, running: false });
  });

  it('start() is idempotent and relays config changes as a status event', () => {
    comp.start();
    comp.start();
    expect(config.listenerCount('config-updated')).toBe(1);
    config.emit('config-updated', {});
    expect(events).toEqual([{ kind: 'status' }]);
  });

  it('stop() is idempotent and removes the config listener', () => {
    comp.start();
    comp.stop();
    comp.stop();
    expect(config.listenerCount('config-updated')).toBe(0);
    config.emit('config-updated', {});
    expect(events).toEqual([]);
  });

  it('stop() without start() does not throw', () => {
    expect(() => comp.stop()).not.toThrow();
  });

  it('can restart after stop()', () => {
    comp.start();
    comp.stop();
    comp.start();
    expect(config.listenerCount('config-updated')).toBe(1);
  });

  it('opens a terminal, streams bytes to cyboflow:shell:<id>, exposes it as an owned shell, and stop() destroys it', async () => {
    insertHost();

    const { terminalId } = await comp.service.terminalOpen('h1');
    expect(terminalId).toBe('host::h1::t1');
    expect(ptyKills.spawned).toEqual(['ssh']);
    expect(comp.terminalShells()).toEqual([{ pid: 4242, terminalId, hostId: 'h1' }]);

    comp.stop();
    expect(ptyKills.kill.length).toBeGreaterThan(0);
    expect(comp.terminalShells()).toEqual([]);
  });

  it('a config change that turns the feature off destroys open terminals; one that keeps it on does not', async () => {
    insertHost();
    comp.start();
    await comp.service.terminalOpen('h1');
    config.emit('config-updated', {});
    expect(comp.terminalShells()).toHaveLength(1);
    config.enabled = false;
    config.emit('config-updated', {});
    expect(ptyKills.kill.length).toBeGreaterThan(0);
    expect(comp.terminalShells()).toEqual([]);
    expect(events.at(-1)).toEqual({ kind: 'status' });
  });

  it('a main-frame renderer navigation or a renderer crash destroys every host terminal', async () => {
    insertHost();
    await comp.service.terminalOpen('h1');
    await comp.service.terminalOpen('h1');
    // Listeners attach once per webContents id, however many terminals open.
    expect(webContents.listenerCount('did-start-navigation')).toBe(1);
    expect(webContents.listenerCount('render-process-gone')).toBe(1);
    webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    expect(comp.terminalShells()).toHaveLength(2);
    webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(comp.terminalShells()).toEqual([]);
    expect(ptyKills.kill).toHaveLength(2);

    await comp.service.terminalOpen('h1');
    expect(webContents.listenerCount('render-process-gone')).toBe(1);
    webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(comp.terminalShells()).toEqual([]);

    // A recreated main window (new webContents id) gets its own pair.
    webContents = new FakeWebContents(2);
    await comp.service.terminalOpen('h1');
    expect(webContents.listenerCount('did-start-navigation')).toBe(1);
  });

  it('pushes a terminal exit on its per-terminal channel', async () => {
    insertHost();
    const { terminalId } = await comp.service.terminalOpen('h1');
    const exits: unknown[] = [];
    const onExit = (e: unknown): void => { exits.push(e); };
    hostEvents.on(hostTerminalChannel(terminalId), onExit);
    try {
      ptyKills.exits[0]({ exitCode: 255 });
      expect(exits).toEqual([{ terminalId, exitCode: 255 }]);
      expect(comp.service.terminalBacklog(terminalId)).toMatchObject({ exited: true, exitCode: 255 });
    } finally {
      hostEvents.off(hostTerminalChannel(terminalId), onExit);
    }
  });
});

describe('composeHosts remote runtime bridge', () => {
  it('publishes the remote runtime at start() and clears it at stop()', () => {
    expect(getRemoteRuntime()).toBeNull();
    comp.start();
    expect(getRemoteRuntime()).toBe(comp.remoteRuntime);
    comp.stop();
    expect(getRemoteRuntime()).toBeNull();
    comp.start();
    expect(getRemoteRuntime()).toBe(comp.remoteRuntime);
  });

  it('stop() leaves a runtime it did not publish in place', () => {
    comp.start();
    const other = { resolveHostId: () => null, prepare: () => Promise.reject(new Error('x')), removeRunToken: async () => undefined };
    setRemoteRuntime(other);
    comp.stop();
    expect(getRemoteRuntime()).toBe(other);
  });

  it('the composed runtime resolves hosts from the db and gates prepare on the live service', async () => {
    expect(comp.remoteRuntime.resolveHostId({ hostId: 'local' })).toBeNull();
    expect(comp.remoteRuntime.resolveHostId({ hostId: 'h1' })).toBe('h1');
    config.enabled = false;
    await expect(comp.remoteRuntime.prepare('h1', { runId: 'r1', spawnKey: 'r1' })).rejects.toThrow(/turned off/);
  });
});

describe('composeHosts remote process cleanup (Phase F)', () => {
  it('the service\'s run-folder pass goes through the composed runtime', async () => {
    const gc = vi.spyOn(comp.remoteRuntime, 'gcRunDir').mockResolvedValue(null);
    const deps = (comp.service as unknown as { deps: Pick<HostsServiceDeps, 'runDirGc'> }).deps;
    expect(deps.runDirGc).toBeTypeOf('function');
    await deps.runDirGc?.('h1', '/Users/me/cf-remote');
    expect(gc).toHaveBeenCalledWith('h1', '/Users/me/cf-remote');
  });

  it('drain() kills the remote processes through the service', async () => {
    const drain = vi.spyOn(comp.service, 'drainRemoteProcesses').mockResolvedValue(undefined);
    await comp.drain();
    expect(drain).toHaveBeenCalledTimes(1);
  });
});

describe('composeHosts remote checkout bridge', () => {
  it('publishes the remote checkout at start() and clears it at stop(), leaving a foreign one in place', () => {
    expect(getRemoteCheckout()).toBeNull();
    comp.start();
    expect(getRemoteCheckout()).toBe(comp.remoteCheckout);
    comp.stop();
    expect(getRemoteCheckout()).toBeNull();
    comp.start();
    const other = { ...comp.remoteCheckout } as typeof comp.remoteCheckout;
    setRemoteCheckout(other);
    comp.stop();
    expect(getRemoteCheckout()).toBe(other);
  });

  it('the composed checkout gates on the live service and reads hosts from the store', async () => {
    insertHost();
    config.enabled = false;
    await expect(comp.remoteCheckout.worktreeExists('h1', 'k')).rejects.toThrow(/turned off/);
    config.enabled = true;
    // h1 has no completed check, so there is no remote root to name a path under.
    expect(() => comp.remoteCheckout.plannedWorktreePath('h1', 'k')).toThrow(/no completed check/);
    expect(() => comp.remoteCheckout.plannedWorktreePath('nope', 'k')).toThrow();
  });
});

describe('composeHosts merge-back', () => {
  const lane = (runId: string, status: string) => ({ runId, batchId: 'b', taskId: 't', status, currentStepId: null, attempts: 1, visualVerification: null, timestamp: 'now' });

  it('publishes the merge-back service at start() and clears it at stop(), leaving a foreign one in place', () => {
    expect(getMergeBackService()).toBeNull();
    comp.start();
    expect(getMergeBackService()).toBe(comp.mergeBack);
    comp.stop();
    expect(getMergeBackService()).toBeNull();
    comp.start();
    const other = { ...comp.mergeBack } as typeof comp.mergeBack;
    setMergeBackService(other);
    comp.stop();
    expect(getMergeBackService()).toBe(other);
  });

  it('checkpoints: watches live remote runs (seeded + followed), asks on integrated only, unwatches on terminal / stop', () => {
    // 152 added workflow_runs.host_id (FK to hosts); session_id comes from the real schema.
    insertHost();
    raw.exec(`ALTER TABLE workflow_runs ADD COLUMN session_id TEXT;
              INSERT INTO workflow_runs (id, status, host_id, session_id) VALUES
                ('r1', 'running', 'h1', 's1'), ('r0', 'running', NULL, 's0'), ('rL', 'running', 'local', 'sL'),
                ('rT', 'completed', 'h1', 'sT');`);
    const asked: string[] = [];
    vi.spyOn(comp.mergeBack, 'requestCheckpoint').mockImplementation(async (sessionId: string) => { asked.push(sessionId); });
    comp.start();
    for (const runId of ['r1', 'r0', 'rL', 'rT']) sprintLaneEvents.emit(sprintLaneChannel(runId), lane(runId, 'integrated'));
    sprintLaneEvents.emit(sprintLaneChannel('r1'), lane('r1', 'running'));
    expect(asked).toEqual(['s1']);

    runStatusEvents.emit('changed', { runId: 'r1', status: 'completed' });
    sprintLaneEvents.emit(sprintLaneChannel('r1'), lane('r1', 'integrated'));
    expect(asked).toEqual(['s1']);

    raw.exec(`INSERT INTO workflow_runs (id, status, host_id, session_id) VALUES ('r2', 'starting', 'h1', 's2')`);
    runStatusEvents.emit('changed', { runId: 'r2', status: 'running' });
    runStatusEvents.emit('changed', { runId: 'r2', status: 'running' });
    expect(sprintLaneEvents.listenerCount(sprintLaneChannel('r2'))).toBe(1);
    sprintLaneEvents.emit(sprintLaneChannel('r2'), lane('r2', 'integrated'));
    expect(asked).toEqual(['s1', 's2']);

    comp.stop();
    expect(sprintLaneEvents.listenerCount(sprintLaneChannel('r2'))).toBe(0);
    runStatusEvents.emit('changed', { runId: 'r2', status: 'running' });
    expect(sprintLaneEvents.listenerCount(sprintLaneChannel('r2'))).toBe(0);
  });

  it('an archived session (abandoned → cleaned) gets its local half cleaned', async () => {
    raw.exec(readFileSync(join(__dirname, '..', 'database', 'migrations', '153_session_merge_backs.sql'), 'utf-8'));
    raw.exec(`INSERT INTO projects (id, name) VALUES (1, 'p'); INSERT INTO sessions (id) VALUES ('s1');`);
    insertHost();
    const local = vi.spyOn(comp.mergeBack, 'cleanupLocal').mockResolvedValue(true);
    await comp.mergeBackStore.create({ sessionId: 's1', hostId: 'h1', projectId: 1, mergeKey: 'k', branch: 'k', state: 'remote_ready' });
    await comp.mergeBackStore.transition('s1', { from: ['remote_ready'], to: 'abandoned' });
    expect(local).not.toHaveBeenCalled();
    await comp.mergeBackStore.transition('s1', { from: ['abandoned'], to: 'cleaned' });
    expect(local).toHaveBeenCalledWith('s1');
  });
});

describe('defaultOrchSocketPath', () => {
  it('is the orch socket orchSocketComposition binds on POSIX, and null for a Windows named pipe', () => {
    expect(defaultOrchSocketPath('darwin')).toMatch(/[/\\]sockets[/\\]orch\.sock$/);
    expect(defaultOrchSocketPath('win32')).toBeNull();
  });

  it('composes a service that can hand out orchestrator links', () => {
    expect(typeof comp.service.linkFor).toBe('function');
    expect(() => comp.service.linkFor('local')).toThrow(/needs no orchestrator link/);
  });
});
