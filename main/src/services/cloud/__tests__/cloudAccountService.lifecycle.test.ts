import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseLike, LoggerLike } from '../../../orchestrator/types';
import { CloudAccountStore } from '../cloudAccountStore';
import type { NewCloudAccountRow } from '../cloudAccountStore';
import { CloudAccountService } from '../cloudAccountService';
import type { CloudAccountServiceDeps } from '../cloudAccountService';
import { AccountsHttpClient } from '../accountsHttpClient';
import type { FetchLike } from '../fetchLike';

const SQL = readFileSync(join(__dirname, '..', '..', '..', 'database', 'migrations', '150_cloud_account.sql'), 'utf-8');
const STAGING = 'https://cloud-staging.cyboflow.com';
const TOKEN = `cbd_${'T'.repeat(43)}`;
const REG = { token: TOKEN, deviceId: 'dev_1', deviceCode: 'ABC', deviceName: 'Registered Name', accountId: 'acc_1', scopes: ['bridge'] };

interface Call { method: string; path: string; headers: Record<string, string>; body: unknown }

class SecretsUnavailable extends Error {
  constructor() {
    super('unavailable');
    this.name = 'SecretsUnavailableError';
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Wall-clock bounded, not tick-bounded: a fixed tick budget can drain before a real
// timer fires (Windows timer granularity is ~15.6 ms).
async function until(pred: () => boolean, label = 'condition'): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setImmediate(r));
  }
  if (pred()) return;
  throw new Error(`timed out waiting for ${label}`);
}

function makeHarness(over: Partial<CloudAccountServiceDeps> & { enabled?: boolean } = {}) {
  const db = new Database(':memory:');
  db.exec(SQL);
  const store = new CloudAccountStore(db as unknown as DatabaseLike);
  const calls: Call[] = [];
  const routes = new Map<string, (c: Call) => Response | Promise<Response>>();
  routes.set('POST /v1/devices/register', () => json(201, REG));
  routes.set('GET /v1/account', () => json(200, { accountId: 'acc_1', displayLogin: 'octocat', entitlements: ['bridge'] }));
  routes.set('DELETE /v1/devices/self', () => json(200, { revoked: true }));
  const fetchSpy = vi.fn(async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const handler = routes.get(`${call.method} ${call.path}`);
    if (!handler) return json(404, { error: 'not_found' });
    return handler(call);
  });
  const secrets = {
    encrypt: vi.fn((plain: string) => Buffer.from(`enc:${plain}`)),
    decrypt: vi.fn((cipher: Buffer) => cipher.toString().slice(4)),
    isAvailable: vi.fn(() => true),
  };
  const opened: string[] = [];
  const openExternal = vi.fn(async (url: string) => {
    opened.push(url);
  });
  const logger: LoggerLike = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const captureError = vi.fn();
  const enabled = { value: over.enabled ?? true };
  const service = new CloudAccountService({
    store,
    createHttpClient: (origin) => new AccountsHttpClient({ origin, fetch: fetchSpy as unknown as FetchLike, appVersion: '9.9.9' }),
    fetch: fetchSpy as unknown as FetchLike,
    secrets,
    openExternal,
    isEnabled: () => enabled.value,
    isDevBuild: () => true,
    getConfiguredOrigin: () => STAGING,
    appVersion: '9.9.9',
    platform: 'darwin',
    defaultDeviceName: () => 'Default Mac',
    logger,
    captureError,
    ...over,
  });
  return { db, store, service, calls, routes, fetchSpy, secrets, opened, openExternal, logger, captureError, enabled };
}

type Harness = ReturnType<typeof makeHarness>;


function seedRow(h: Harness, over: Partial<NewCloudAccountRow> = {}): void {
  h.store.upsert({
    origin: STAGING, accountId: 'acc_1', deviceId: 'dev_1', deviceName: 'Test Mac', deviceCode: 'ABC', displayLogin: null,
    entitlements: [], scopes: ['bridge'], tokenCiphertext: Buffer.from(`enc:${TOKEN}`), state: 'ok',
    createdAt: '2026-10-01T00:00:00.000Z', lastOkAt: null, ...over,
  });
}

/** A fresh service over the same store/deps: simulates an app relaunch with the seeded row. */
function relaunch(h: Harness, over: Partial<CloudAccountServiceDeps> = {}): CloudAccountService {
  return new CloudAccountService({
    store: h.store,
    createHttpClient: (origin) => new AccountsHttpClient({ origin, fetch: h.fetchSpy as unknown as FetchLike, appVersion: '9.9.9' }),
    fetch: h.fetchSpy as unknown as FetchLike,
    secrets: h.secrets,
    openExternal: h.openExternal,
    isEnabled: () => h.enabled.value,
    isDevBuild: () => true,
    getConfiguredOrigin: () => STAGING,
    appVersion: '9.9.9',
    platform: 'darwin',
    defaultDeviceName: () => 'Default Mac',
    logger: h.logger,
    captureError: h.captureError,
    ...over,
  });
}



describe('CloudAccountService lifecycle', () => {
  let h: Harness;
  let service: CloudAccountService;
  beforeEach(() => {
    h = makeHarness();
    seedRow(h);
    service = relaunch(h);
  });
  afterEach(() => {
    service.stop();
    h.db.close();
    vi.useRealTimers();
  });

  it('constructing with a stored row does not decrypt and does not fetch', () => {
    expect(h.secrets.decrypt).not.toHaveBeenCalled();
    expect(h.secrets.isAvailable).not.toHaveBeenCalled();
    expect(h.fetchSpy).not.toHaveBeenCalled();
    expect(service.getState()).toBe('locked');
  });

  it('getDevice() is synchronous from the row (even while locked)', () => {
    expect(service.getDevice()).toEqual({
      origin: STAGING, accountId: 'acc_1', deviceId: 'dev_1', deviceCode: 'ABC', deviceName: 'Test Mac',
    });
  });

  it('getToken() is null while locked and never calls decrypt', () => {
    expect(service.getToken()).toBeNull();
    expect(service.getToken()).toBeNull();
    expect(h.secrets.decrypt).not.toHaveBeenCalled();
  });

  it('after unlock, getToken() returns the token and decrypts once across repeated calls', () => {
    service.unlock('user');
    expect(service.getToken()).toBe(TOKEN);
    expect(service.getToken()).toBe(TOKEN);
    expect(h.secrets.decrypt).toHaveBeenCalledTimes(1);
  });

  it('a decrypt failure persists undecryptable, getToken is null and stateChanged is emitted asynchronously', async () => {
    h.secrets.decrypt.mockImplementation(() => { throw new Error('bad ciphertext'); });
    const seen: string[] = [];
    service.on('stateChanged', (s) => seen.push(s));
    service.unlock('user');
    expect(seen).toEqual([]);
    await Promise.resolve();
    expect(seen).toEqual(['undecryptable']);
    expect(service.getToken()).toBeNull();
    expect(h.store.read()?.state).toBe('undecryptable');
    expect(service.getStatus()).toMatchObject({ display: 'undecryptable' });
  });

  it('SecretsUnavailableError on decrypt shows secrets_unavailable, is not persisted and hides the device', () => {
    h.secrets.decrypt.mockImplementation(() => { throw new SecretsUnavailable(); });
    service.unlock('user');
    expect(service.getStatus()).toMatchObject({ display: 'secrets_unavailable' });
    expect(h.store.read()?.state).toBe('ok');
    expect(service.getDevice()).toBeNull();
    expect(service.getToken()).toBeNull();
  });

  it('a decrypted value that is not a device token reads as undecryptable', () => {
    h.secrets.decrypt.mockReturnValue('not-a-token');
    service.unlock('user');
    expect(service.getState()).toBe('undecryptable');
    expect(h.store.read()?.state).toBe('undecryptable');
  });

  it('markRevoked is idempotent, emits revoked once and keeps the row', () => {
    service.unlock('user');
    const revoked: string[] = [];
    service.on('revoked', (r) => revoked.push(r));
    service.markRevoked('device_revoked');
    service.markRevoked('unauthorized');
    expect(revoked).toEqual(['device_revoked']);
    expect(service.getState()).toBe('revoked');
    expect(service.getToken()).toBeNull();
    expect(service.getDevice()).toBeNull();
    expect(h.store.read()).toMatchObject({ state: 'revoked', deviceCode: 'ABC' });
  });

  it('markRevoked with no row is a no-op', () => {
    h.store.clear();
    const empty = relaunch(h);
    const revoked = vi.fn();
    empty.on('revoked', revoked);
    empty.markRevoked('device_revoked');
    expect(revoked).not.toHaveBeenCalled();
  });

  it('a throwing listener does not break markRevoked', () => {
    service.on('revoked', () => { throw new Error('listener bug'); });
    expect(() => service.markRevoked('device_revoked')).not.toThrow();
    expect(service.getState()).toBe('revoked');
  });

  describe('refreshAccount', () => {
    beforeEach(() => {
      service.unlock('user');
    });

    it('a 200 updates login, entitlements and last_ok_at, and returns needs_update to ok', async () => {
      h.store.setState('needs_update', '2026-10-02T00:00:00.000Z');
      const nu = relaunch(h);
      nu.unlock('user');
      expect(nu.getState()).toBe('needs_update');
      await nu.refreshAccount({ force: true });
      expect(nu.getState()).toBe('ok');
      expect(h.store.read()).toMatchObject({ displayLogin: 'octocat', entitlements: ['bridge'], state: 'ok' });
      expect(h.store.read()?.lastOkAt).not.toBeNull();
      expect(h.calls[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    });

    it('a 401 device_revoked marks the device revoked', async () => {
      h.routes.set('GET /v1/account', () => json(401, { error: 'device_revoked' }));
      const revoked = vi.fn();
      service.on('revoked', revoked);
      await service.refreshAccount({ force: true });
      expect(service.getState()).toBe('revoked');
      expect(revoked).toHaveBeenCalledWith('device_revoked');
    });

    it('a 401 unauthorized marks the device revoked with that reason', async () => {
      h.routes.set('GET /v1/account', () => json(401, { error: 'unauthorized' }));
      const revoked = vi.fn();
      service.on('revoked', revoked);
      await service.refreshAccount({ force: true });
      expect(service.getState()).toBe('revoked');
      expect(revoked).toHaveBeenCalledWith('unauthorized');
    });

    it('a 426 moves the row to needs_update', async () => {
      h.routes.set('GET /v1/account', () => json(426, { error: 'unsupported_protocol' }));
      await service.refreshAccount({ force: true });
      expect(service.getState()).toBe('needs_update');
      expect(h.store.read()?.state).toBe('needs_update');
      expect(service.getStatus()).toMatchObject({ display: 'needs_update' });
    });

    it.each([500, 503])('a %i keeps the state and records a retryable lastError with retryNotBefore', async (status) => {
      h.routes.set('GET /v1/account', () => json(status, { error: 'accounts_unavailable' }));
      await service.refreshAccount({ force: true });
      expect(service.getState()).toBe('ok');
      const status2 = service.getStatus() as { lastError: { kind: string; retryNotBefore: string | null; httpStatus: number } };
      expect(status2.lastError).toMatchObject({ kind: 'retryable', httpStatus: status });
      expect(Date.parse(status2.lastError.retryNotBefore as string)).toBeGreaterThan(Date.now());
    });

    it('a non-forced refresh before retryNotBefore does not fetch; a forced one does', async () => {
      h.routes.set('GET /v1/account', () => json(503, { error: 'accounts_unavailable' }));
      await service.refreshAccount({ force: true });
      expect(h.calls).toHaveLength(1);
      await service.refreshAccount({ force: false });
      expect(h.calls).toHaveLength(1);
      await service.refreshAccount({ force: true });
      expect(h.calls).toHaveLength(2);
    });

    it('a non-forced refresh within 60 s of a success does not fetch', async () => {
      await service.refreshAccount({ force: false });
      await service.refreshAccount({ force: false });
      expect(h.calls.filter((c) => c.path === '/v1/account')).toHaveLength(1);
    });

    it('concurrent refreshes share one fetch', async () => {
      let release: () => void = () => undefined;
      h.routes.set('GET /v1/account', async () => {
        await new Promise<void>((r) => { release = r; });
        return json(200, { accountId: 'acc_1', displayLogin: 'octocat', entitlements: [] });
      });
      const a = service.refreshAccount({ force: true });
      const b = service.refreshAccount({ force: true });
      await until(() => h.calls.length > 0);
      release();
      await Promise.all([a, b]);
      expect(h.calls).toHaveLength(1);
    });

    it('an account id mismatch records account_mismatch and writes nothing', async () => {
      h.routes.set('GET /v1/account', () => json(200, { accountId: 'someone_else', displayLogin: 'x', entitlements: ['bridge'] }));
      await service.refreshAccount({ force: true });
      expect(h.store.read()).toMatchObject({ displayLogin: null, entitlements: [] });
      expect(service.getStatus()).toMatchObject({ lastError: { code: 'account_mismatch' } });
    });

    it('a refresh in flight when signOut runs is discarded and the row stays cleared', async () => {
      let release: () => void = () => undefined;
      h.routes.set('GET /v1/account', async () => {
        await new Promise<void>((r) => { release = r; });
        return json(200, { accountId: 'acc_1', displayLogin: 'late', entitlements: [] });
      });
      const refresh = service.refreshAccount({ force: true });
      await until(() => h.calls.length > 0);
      await service.signOut();
      release();
      await refresh;
      expect(h.store.read()).toBeNull();
      expect(service.getState()).toBe('signed_out');
    });

    it('requestAccountRefresh with the gate closed does not throw and does not fetch', () => {
      service.unlock('user');
      h.enabled.value = false;
      expect(() => service.requestAccountRefresh()).not.toThrow();
      expect(h.fetchSpy).not.toHaveBeenCalled();
    });

    it('a Try again that hits secrets_unavailable on an undecryptable row still displays undecryptable', () => {
      service.stop();
      h.store.setState('undecryptable', '2026-10-02T00:00:00.000Z');
      const svc = relaunch(h);
      h.secrets.decrypt.mockImplementation(() => {
        throw new SecretsUnavailable();
      });
      svc.unlock('user', { explicitRetry: true });
      const status = svc.getStatus();
      expect(status.available && status.display).toBe('undecryptable');
      expect(status.available && status.account?.state).toBe('undecryptable');
      svc.stop();
    });

    it('requestAccountRefresh fetches when unlocked', async () => {
      service.requestAccountRefresh();
      await until(() => h.calls.length > 0);
      expect(h.calls[0]?.path).toBe('/v1/account');
    });
  });

  describe('signOut', () => {
    it('unlocks implicitly, sends DELETE /v1/devices/self with the Bearer token to the row origin, clears the row and emits signedOut', async () => {
      const order: string[] = [];
      service.on('signedOut', () => order.push('signedOut'));
      service.on('stateChanged', () => order.push('stateChanged'));
      const result = await service.signOut();
      expect(result).toEqual({ remoteRevoked: 'yes' });
      const del = h.calls.find((c) => c.method === 'DELETE');
      expect(del?.path).toBe('/v1/devices/self');
      expect(del?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(h.store.read()).toBeNull();
      expect(order.slice(-2)).toEqual(['signedOut', 'stateChanged']);
      expect(service.getState()).toBe('signed_out');
      expect(service.getToken()).toBeNull();
    });

    it('a DELETE network failure still clears the row and reports no', async () => {
      h.routes.set('DELETE /v1/devices/self', () => { throw new Error('net::ERR_FAILED'); });
      expect(await service.signOut()).toEqual({ remoteRevoked: 'no' });
      expect(h.store.read()).toBeNull();
    });

    it('a DELETE 503 reports no', async () => {
      h.routes.set('DELETE /v1/devices/self', () => json(503, { error: 'accounts_unavailable' }));
      expect(await service.signOut()).toEqual({ remoteRevoked: 'no' });
      expect(h.store.read()).toBeNull();
    });

    it('no row reports not_needed without network', async () => {
      h.store.clear();
      const empty = relaunch(h);
      expect(await empty.signOut()).toEqual({ remoteRevoked: 'not_needed' });
      expect(h.fetchSpy).not.toHaveBeenCalled();
    });

    it('before-sign-out hooks run for a revoked row too, still without network', async () => {
      const hook = vi.fn();
      service.onBeforeSignOut(hook);
      service.markRevoked('device_revoked');
      expect(await service.signOut()).toEqual({ remoteRevoked: 'not_needed' });
      expect(hook).toHaveBeenCalledTimes(1);
      expect(h.fetchSpy).not.toHaveBeenCalled();
    });

    it('stop() clears a scheduled boot unlock', () => {
      vi.useFakeTimers();
      service.scheduleBootUnlock(1000);
      service.stop();
      vi.advanceTimersByTime(5000);
      expect(h.secrets.decrypt).not.toHaveBeenCalled();
    });

    it('a boot unlock whose gate flipped off while pending does not decrypt', () => {
      vi.useFakeTimers();
      service.scheduleBootUnlock(1000);
      h.enabled.value = false;
      vi.advanceTimersByTime(5000);
      expect(h.secrets.decrypt).not.toHaveBeenCalled();
    });

    it('a newer row written while sign-out awaited its hooks is not cleared', async () => {
      service.onBeforeSignOut(async () => {
        seedRow(h, { deviceId: 'dev_2' });
        Object.assign(service, { row: h.store.read() });
      });
      await service.signOut();
      expect(h.store.read()?.deviceId).toBe('dev_2');
    });

    it('a same-device row rewrite while sign-out awaited its hooks still clears', async () => {
      const deviceId = h.store.read()?.deviceId;
      service.onBeforeSignOut(async () => {
        seedRow(h, { deviceId });
        Object.assign(service, { row: h.store.read() });
      });
      await service.signOut();
      expect(h.store.read()).toBeNull();
    });

    it('a revoked row reports not_needed without network and clears', async () => {
      service.markRevoked('device_revoked');
      expect(await service.signOut()).toEqual({ remoteRevoked: 'not_needed' });
      expect(h.fetchSpy).not.toHaveBeenCalled();
      expect(h.store.read()).toBeNull();
    });

    it('an undecryptable row reports skipped without network and clears', async () => {
      h.secrets.decrypt.mockImplementation(() => { throw new Error('bad'); });
      service.unlock('user');
      expect(await service.signOut()).toEqual({ remoteRevoked: 'skipped' });
      expect(h.fetchSpy).not.toHaveBeenCalled();
      expect(h.store.read()).toBeNull();
    });

    it('a secrets-unavailable overlay reports skipped and clears', async () => {
      h.secrets.decrypt.mockImplementation(() => { throw new SecretsUnavailable(); });
      expect(await service.signOut()).toEqual({ remoteRevoked: 'skipped' });
      expect(h.store.read()).toBeNull();
    });

    it('an implicit unlock that fails reports skipped', async () => {
      h.secrets.decrypt.mockImplementation(() => { throw new Error('bad'); });
      expect(await service.signOut()).toEqual({ remoteRevoked: 'skipped' });
      expect(h.fetchSpy).not.toHaveBeenCalled();
    });

    it('with the agents gate closed it throws CloudNotAvailableError and changes nothing', async () => {
      h.enabled.value = false;
      await expect(service.signOut()).rejects.toMatchObject({ name: 'CloudNotAvailableError' });
      expect(h.store.read()).not.toBeNull();
    });
  });

  it('the token is only sent to the row origin even after the configured origin changes', async () => {
    const other = relaunch(h, { getConfiguredOrigin: () => 'https://cloud.cyboflow.com' });
    other.unlock('user');
    await other.refreshAccount({ force: true });
    await other.listDevices();
    expect(h.fetchSpy.mock.calls.map((c) => new URL(String(c[0])).origin)).toEqual([STAGING, STAGING]);
    expect(other.getStatus()).toMatchObject({ originMismatch: true });
    other.stop();
  });

  describe('listDevices', () => {
    beforeEach(() => service.unlock('user'));

    it('maps ms to ISO, sorts current first then by last seen, revoked last, and has no id key', async () => {
      const dev = (code: string, over: Record<string, unknown>) => ({
        id: `id_${code}`, code, name: code, platform: 'darwin', appVersion: '1', createdAt: 1_000, lastSeenAt: null, revokedAt: null, current: false, ...over,
      });
      h.routes.set('GET /v1/devices', () => json(200, {
        devices: [
          dev('REV', { revokedAt: 5_000, lastSeenAt: 9_000 }),
          dev('OLD', { lastSeenAt: 2_000 }),
          dev('NEW', { lastSeenAt: 8_000 }),
          dev('CUR', { current: true, lastSeenAt: 1_000 }),
        ],
      }));
      const res = await service.listDevices();
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.devices.map((d) => d.code)).toEqual(['CUR', 'NEW', 'OLD', 'REV']);
      expect(res.devices[1]?.lastSeenAt).toBe(new Date(8_000).toISOString());
      expect(res.devices[3]?.revokedAt).toBe(new Date(5_000).toISOString());
      for (const d of res.devices) expect('id' in d).toBe(false);
    });

    it('a 401 device_revoked marks the device revoked and returns ok:false', async () => {
      h.routes.set('GET /v1/devices', () => json(401, { error: 'device_revoked' }));
      const res = await service.listDevices();
      expect(res).toMatchObject({ ok: false, error: { kind: 'revoked' } });
      expect(service.getState()).toBe('revoked');
    });

    it('without a usable token returns a not_signed_in error', async () => {
      h.store.clear();
      const empty = relaunch(h);
      expect(await empty.listDevices()).toMatchObject({ ok: false, error: { code: 'not_signed_in' } });
    });

    it('a locked service unlocks implicitly first', async () => {
      h.routes.set('GET /v1/devices', () => json(200, { devices: [] }));
      const locked = relaunch(h);
      const res = await locked.listDevices();
      expect(res.ok).toBe(true);
      expect(locked.getState()).toBe('ok');
    });
  });

  it('getEntitlements mirrors the row', async () => {
    expect(service.getEntitlements()).toEqual([]);
    service.unlock('user');
    await service.refreshAccount({ force: true });
    expect(service.getEntitlements()).toEqual(['bridge']);
    h.store.clear();
    expect(relaunch(h).getEntitlements()).toEqual([]);
  });

  it('getStatus is {available:false} when agents are disabled', () => {
    h.enabled.value = false;
    expect(service.getStatus()).toEqual({ available: false });
  });

  it('getStatus reports the account summary and bridge entitlement', async () => {
    service.unlock('user');
    await service.refreshAccount({ force: true });
    const status = service.getStatus();
    expect(status).toMatchObject({
      available: true,
      display: 'signed_in',
      configuredOrigin: STAGING,
      staging: true,
      originMismatch: false,
      account: { state: 'ok', deviceCode: 'ABC', bridgeEntitled: true, displayLogin: 'octocat' },
      defaultDeviceName: 'Default Mac',
    });
  });

  it('openDevicesPage opens the row origin devices page', async () => {
    await service.openDevicesPage();
    expect(h.opened).toEqual([`${STAGING}/devices`]);
  });

  it('stop() is idempotent and synchronous', () => {
    service.stop();
    expect(() => service.stop()).not.toThrow();
  });

  it('a stored row with an invalid device code reads as undecryptable at construction', () => {
    h.db.prepare("UPDATE cloud_account SET device_code = 'zz9'").run();
    const bad = relaunch(h);
    expect(bad.getState()).toBe('undecryptable');
  });
});
