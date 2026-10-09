import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const electronMock = vi.hoisted(() => ({
  app: { on: vi.fn(), getVersion: vi.fn(() => '9.9.9') },
  session: { fromPartition: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined) },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => 'keychain'),
    encryptString: vi.fn((plain: string) => Buffer.from(`enc:${plain}`)),
    decryptString: vi.fn((cipher: Buffer) => cipher.toString().slice(4)),
  },
}));
vi.mock('electron', () => electronMock);
vi.mock('../services/telemetry', () => ({ captureSeamError: vi.fn() }));

import { composeCloudAccount, CLOUD_BOOT_UNLOCK_DELAY_MS } from '../cloudAccountComposition';
import {
  CLOUD_CHANGED_CHANNEL,
  cloudAccountEvents,
  getCloudAccountFacade,
  _resetCloudAccountFacadeForTesting,
} from '../orchestrator/cloudAccountBridge';
import { CloudAccountStore } from '../services/cloud/cloudAccountStore';
import type { ConfigManager } from '../services/configManager';
import type { DatabaseLike, LoggerLike } from '../orchestrator/types';
import type { CloudChangedEvent } from '../../../shared/types/cloudAccountWire';

const SQL = readFileSync(join(__dirname, '..', 'database', 'migrations', '150_cloud_account.sql'), 'utf-8');
const TOKEN = `cbd_${'T'.repeat(43)}`;
const KILL_ENV = 'CYBOFLOW_DISABLE_PERSISTENT_AGENTS';

class FakeConfig extends EventEmitter {
  available = true;
  enabled = true;
  isAgentsAvailable(): boolean { return this.available; }
  isAgentsEnabled(): boolean { return this.available && this.enabled; }
  syncEnabled = false;
  isRemoteSyncEnabled(): boolean { return this.available && this.syncEnabled; }
  getCloudOrigin(): string { return 'https://cloud-staging.cyboflow.com'; }
  update(enabled: boolean): void {
    this.enabled = enabled;
    this.emit('config-updated', {});
  }
}

function seed(db: Database.Database): void {
  new CloudAccountStore(db as unknown as DatabaseLike).upsert({
    origin: 'https://cloud-staging.cyboflow.com', accountId: 'acc_1', deviceId: 'dev_1', deviceName: 'Mac', deviceCode: 'ABC',
    displayLogin: null, entitlements: [], scopes: ['bridge'], tokenCiphertext: Buffer.from(`enc:${TOKEN}`), state: 'ok',
    createdAt: '2026-10-01T00:00:00.000Z', lastOkAt: null,
  });
}

describe('composeCloudAccount', () => {
  let db: Database.Database;
  let config: FakeConfig;
  let logger: LoggerLike;
  const savedKill = process.env[KILL_ENV];

  const compose = () => composeCloudAccount({ db: db as unknown as DatabaseLike, configManager: config as unknown as ConfigManager, logger });

  beforeEach(() => {
    vi.clearAllMocks();
    db = new Database(':memory:');
    db.exec(SQL);
    config = new FakeConfig();
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    delete process.env[KILL_ENV];
    _resetCloudAccountFacadeForTesting();
    cloudAccountEvents.removeAllListeners();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
    if (savedKill === undefined) delete process.env[KILL_ENV];
    else process.env[KILL_ENV] = savedKill;
    _resetCloudAccountFacadeForTesting();
    cloudAccountEvents.removeAllListeners();
  });

  it('a release build returns null and sets no facade', () => {
    config.available = false;
    expect(compose()).toBeNull();
    expect(getCloudAccountFacade()).toBeNull();
    expect(electronMock.app.on).not.toHaveBeenCalled();
  });

  it('a dev build sets the facade and registers a before-quit handler that stops the service', () => {
    const composition = compose();
    expect(composition).not.toBeNull();
    expect(getCloudAccountFacade()).not.toBeNull();
    expect(composition?.handle).toBe(composition?.service);
    const quit = electronMock.app.on.mock.calls.find((c) => c[0] === 'before-quit');
    expect(quit).toBeDefined();
    const stop = vi.spyOn(composition!.service, 'stop');
    (quit?.[1] as () => void)();
    expect(stop).toHaveBeenCalledTimes(1);
    (quit?.[1] as () => void)();
    expect(() => composition?.service.stop()).not.toThrow();
  });

  it('composing with a stored row never decrypts, probes the keychain, opens a session or binds a socket', () => {
    seed(db);
    const composition = compose();
    expect(composition?.service.getState()).toBe('locked');
    expect(electronMock.safeStorage.decryptString).not.toHaveBeenCalled();
    expect(electronMock.safeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(electronMock.session.fromPartition).not.toHaveBeenCalled();
    expect(composition?.service.getStatus()).toMatchObject({ signIn: { phase: 'idle' } });
  });

  it('boot unlock is scheduled at +10 s only when agents are enabled, the kill switch is unset and a row exists', () => {
    vi.useFakeTimers();
    seed(db);
    const before = vi.getTimerCount();
    const composition = compose();
    expect(vi.getTimerCount()).toBe(before + 1);
    expect(electronMock.safeStorage.decryptString).not.toHaveBeenCalled();
    vi.advanceTimersByTime(CLOUD_BOOT_UNLOCK_DELAY_MS - 1);
    expect(electronMock.safeStorage.decryptString).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(electronMock.safeStorage.decryptString).toHaveBeenCalledTimes(1);
    expect(composition?.service.getToken()).toBe(TOKEN);
  });

  it('no boot unlock timer without a row, with agents off, or with the kill switch set', () => {
    vi.useFakeTimers();
    const base = vi.getTimerCount();
    compose();
    expect(vi.getTimerCount()).toBe(base);

    seed(db);
    config.enabled = false;
    compose();
    expect(vi.getTimerCount()).toBe(base);

    config.enabled = true;
    process.env[KILL_ENV] = '1';
    compose();
    expect(vi.getTimerCount()).toBe(base);
    vi.advanceTimersByTime(CLOUD_BOOT_UNLOCK_DELAY_MS * 2);
    expect(electronMock.safeStorage.decryptString).not.toHaveBeenCalled();
  });

  it('sync alone is a consumer: it opens the gate and schedules the boot unlock, even with the agents kill switch set', () => {
    vi.useFakeTimers();
    seed(db);
    config.enabled = false;
    config.syncEnabled = true;
    process.env[KILL_ENV] = '1';
    const base = vi.getTimerCount();
    const composition = compose();
    expect(vi.getTimerCount()).toBe(base + 1);
    expect(composition?.service.getStatus()).toMatchObject({ available: true });
  });

  it('turning sync on is a user action that unlocks', () => {
    seed(db);
    config.enabled = false;
    const composition = compose();
    config.syncEnabled = true;
    config.emit('config-updated', {});
    expect(electronMock.safeStorage.decryptString).toHaveBeenCalledTimes(1);
    expect(composition?.service.getState()).toBe('ok');
  });

  it('before-quit clears a pending boot unlock timer', () => {
    vi.useFakeTimers();
    seed(db);
    const base = vi.getTimerCount();
    compose();
    expect(vi.getTimerCount()).toBe(base + 1);
    const quit = electronMock.app.on.mock.calls.find((c) => c[0] === 'before-quit');
    (quit?.[1] as () => void)();
    expect(vi.getTimerCount()).toBe(base);
  });

  it('flipping agents on calls unlock(user) and emits cloud-changed', async () => {
    seed(db);
    config.enabled = false;
    const composition = compose();
    const events: CloudChangedEvent[] = [];
    cloudAccountEvents.on(CLOUD_CHANGED_CHANNEL, (ev: CloudChangedEvent) => events.push(ev));
    config.update(true);
    expect(electronMock.safeStorage.decryptString).toHaveBeenCalledTimes(1);
    expect(composition?.service.getState()).toBe('ok');
    await Promise.resolve();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.kind === 'stateChanged')).toBe(true);
    expect(events.at(-1)?.status).toMatchObject({ available: true, display: 'signed_in' });
  });

  it('flipping agents on with the kill switch set still announces the change but does not decrypt', () => {
    seed(db);
    config.enabled = false;
    process.env[KILL_ENV] = '1';
    compose();
    const events: CloudChangedEvent[] = [];
    cloudAccountEvents.on(CLOUD_CHANGED_CHANNEL, (ev: CloudChangedEvent) => events.push(ev));
    config.update(true);
    expect(electronMock.safeStorage.decryptString).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
  });

  it('a config update that does not change the gate emits nothing', () => {
    compose();
    const events: CloudChangedEvent[] = [];
    cloudAccountEvents.on(CLOUD_CHANGED_CHANNEL, (ev: CloudChangedEvent) => events.push(ev));
    config.emit('config-updated', {});
    expect(events).toHaveLength(0);
  });

  it('markRevoked reaches the renderer channel as a revoked event', () => {
    seed(db);
    const composition = compose();
    composition?.service.unlock('user');
    const events: CloudChangedEvent[] = [];
    cloudAccountEvents.on(CLOUD_CHANGED_CHANNEL, (ev: CloudChangedEvent) => events.push(ev));
    composition?.handle.markRevoked('device_revoked');
    expect(events.map((e) => e.kind)).toEqual(['revoked', 'stateChanged']);
    expect(events[0]?.status).toMatchObject({ available: true, display: 'revoked' });
  });

  it('the facade delegates: unlock returns the status and respects the gate', () => {
    seed(db);
    compose();
    const facade = getCloudAccountFacade();
    expect(facade?.getStatus()).toMatchObject({ display: 'locked' });
    expect(facade?.unlock({ explicitRetry: false })).toMatchObject({ display: 'signed_in' });
    config.enabled = false;
    expect(facade?.getStatus()).toEqual({ available: false });
    expect(() => facade?.unlock({ explicitRetry: true })).toThrow(expect.objectContaining({ name: 'CloudNotAvailableError' }));
  });

  it('the facade reopenSignInPage is {opened:false} while idle', async () => {
    compose();
    await expect(getCloudAccountFacade()?.reopenSignInPage()).resolves.toEqual({ opened: false });
  });

  it('the accounts table has exactly one production writer: CloudAccountStore', () => {
    const root = join(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name === '__tests__' || name === '__test_fixtures__' || name === 'node_modules' || name === 'migrations') continue;
          walk(full);
        } else if (/\.ts$/.test(name) && !/\.(test|itest)\.ts$/.test(name)) {
          files.push(full);
        }
      }
    };
    walk(root);
    const writes = /(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+cloud_account\b/i;
    const writers = files.filter((f) => writes.test(readFileSync(f, 'utf-8'))).map((f) => relative(root, f));
    expect(writers).toEqual(['services/cloud/cloudAccountStore.ts']);
  });
});
