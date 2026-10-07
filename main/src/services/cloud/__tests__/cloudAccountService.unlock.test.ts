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
const CODE = 'C'.repeat(43);
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

async function until(pred: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 4000; i += 1) {
    if (pred()) return;
    await new Promise((r) => setImmediate(r));
  }
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



type Reason = 'boot' | 'user-implicit' | 'user-explicit';

function callUnlock(service: CloudAccountService, reason: Reason): void {
  if (reason === 'boot') service.unlock('boot');
  else service.unlock('user', { explicitRetry: reason === 'user-explicit' });
}

/** A loopback fake that hands the service a login code immediately. */
function instantLoopback(): NonNullable<CloudAccountServiceDeps['startLoopback']> {
  return async () => ({
    port: 54321,
    outcome: Promise.resolve({ kind: 'code' as const, code: CODE }),
    close: () => undefined,
  });
}

describe('CloudAccountService unlock', () => {
  let h: Harness;
  const services: CloudAccountService[] = [];
  const make = (over: Partial<CloudAccountServiceDeps> = {}): CloudAccountService => {
    const s = relaunch(h, over);
    services.push(s);
    return s;
  };
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    for (const s of services.splice(0)) s.stop();
    h.db.close();
    vi.useRealTimers();
  });

  const reasons: Reason[] = ['boot', 'user-implicit', 'user-explicit'];

  describe('table: no row, revoked, or already unlocked is a no-op', () => {
    it.each(reasons)('no row, %s', (reason) => {
      const s = make();
      callUnlock(s, reason);
      expect(h.secrets.decrypt).not.toHaveBeenCalled();
      expect(s.getState()).toBe('signed_out');
    });
    it.each(reasons)('revoked row, %s', (reason) => {
      seedRow(h, { state: 'revoked' });
      const s = make();
      callUnlock(s, reason);
      expect(h.secrets.decrypt).not.toHaveBeenCalled();
      expect(s.getState()).toBe('revoked');
    });
    it.each(reasons)('already unlocked, %s', (reason) => {
      seedRow(h);
      const s = make();
      s.unlock('user');
      h.secrets.decrypt.mockClear();
      callUnlock(s, reason);
      expect(h.secrets.decrypt).not.toHaveBeenCalled();
      expect(s.getState()).toBe('ok');
    });
  });

  describe('table: ok/needs_update row, not unlocked, no overlay', () => {
    it.each(reasons)('%s decrypts', (reason) => {
      seedRow(h);
      const s = make();
      callUnlock(s, reason);
      expect(h.secrets.decrypt).toHaveBeenCalledTimes(1);
      expect(s.getState()).toBe('ok');
      expect(s.getToken()).toBe(TOKEN);
    });
    it('a needs_update row unlocks to needs_update', () => {
      seedRow(h, { state: 'needs_update' });
      const s = make();
      s.unlock('user');
      expect(s.getState()).toBe('needs_update');
      expect(s.getToken()).toBe(TOKEN);
    });
  });

  describe('table: secrets_unavailable overlay', () => {
    const overlaid = (): CloudAccountService => {
      seedRow(h);
      h.secrets.decrypt.mockImplementationOnce(() => { throw new SecretsUnavailable(); });
      const s = make();
      s.unlock('user');
      expect(s.getState()).toBe('secrets_unavailable');
      h.secrets.decrypt.mockClear();
      return s;
    };
    it('boot is a no-op', () => {
      const s = overlaid();
      s.unlock('boot');
      expect(h.secrets.decrypt).not.toHaveBeenCalled();
      expect(s.getState()).toBe('secrets_unavailable');
    });
    it('an implicit user unlock is a no-op (no keychain call)', () => {
      const s = overlaid();
      s.unlock('user', { explicitRetry: false });
      s.unlock('user');
      expect(h.secrets.decrypt).not.toHaveBeenCalled();
      expect(s.getState()).toBe('secrets_unavailable');
    });
    it('an explicit retry decrypts and recovers', () => {
      const s = overlaid();
      s.unlock('user', { explicitRetry: true });
      expect(h.secrets.decrypt).toHaveBeenCalledTimes(1);
      expect(s.getState()).toBe('ok');
      expect(s.getDevice()).not.toBeNull();
    });
  });

  describe('table: undecryptable row', () => {
    it('boot is a no-op', () => {
      seedRow(h, { state: 'undecryptable' });
      const s = make();
      s.unlock('boot');
      expect(h.secrets.decrypt).not.toHaveBeenCalled();
      expect(s.getState()).toBe('undecryptable');
    });
    it('an implicit user unlock is a no-op', () => {
      seedRow(h, { state: 'undecryptable' });
      const s = make();
      s.unlock('user');
      expect(h.secrets.decrypt).not.toHaveBeenCalled();
    });
    it('an explicit retry recovers the row to ok (the Keychain Deny recovery path)', () => {
      seedRow(h, { state: 'undecryptable' });
      const s = make();
      s.unlock('user', { explicitRetry: true });
      expect(h.secrets.decrypt).toHaveBeenCalledTimes(1);
      expect(s.getState()).toBe('ok');
      expect(h.store.read()?.state).toBe('ok');
    });
    it('an explicit retry that fails again stays undecryptable', () => {
      seedRow(h, { state: 'undecryptable' });
      h.secrets.decrypt.mockImplementation(() => { throw new Error('still bad'); });
      const s = make();
      s.unlock('user', { explicitRetry: true });
      expect(s.getState()).toBe('undecryptable');
    });
  });

  it('boot attempts at most once per process, even after a failure', () => {
    seedRow(h);
    h.secrets.decrypt.mockImplementation(() => { throw new SecretsUnavailable(); });
    const s = make();
    s.unlock('boot');
    s.unlock('boot');
    expect(h.secrets.decrypt).toHaveBeenCalledTimes(1);
  });

  it('stateChanged is emitted asynchronously, once per change', async () => {
    seedRow(h);
    const s = make();
    const seen: string[] = [];
    s.on('stateChanged', (st) => seen.push(st));
    s.unlock('user');
    expect(seen).toEqual([]);
    await Promise.resolve();
    expect(seen).toEqual(['ok']);
    s.unlock('user');
    await Promise.resolve();
    expect(seen).toEqual(['ok']);
  });

  it('an implicit unlock twice after a SecretsUnavailableError calls decrypt once in total', () => {
    seedRow(h);
    h.secrets.decrypt.mockImplementation(() => { throw new SecretsUnavailable(); });
    const s = make();
    s.unlock('user');
    s.unlock('user');
    expect(h.secrets.decrypt).toHaveBeenCalledTimes(1);
  });

  it('N implicit unlocks after a failed decrypt never call decrypt again', () => {
    seedRow(h);
    h.secrets.decrypt.mockImplementation(() => { throw new Error('denied'); });
    const s = make();
    for (let i = 0; i < 5; i += 1) s.unlock('user');
    s.unlock('boot');
    expect(h.secrets.decrypt).toHaveBeenCalledTimes(1);
  });

  it('refreshAccount with the overlay set does not decrypt; an explicit retry then refresh does', async () => {
    seedRow(h);
    h.secrets.decrypt.mockImplementationOnce(() => { throw new SecretsUnavailable(); });
    const s = make();
    s.unlock('user');
    h.secrets.decrypt.mockClear();
    await s.refreshAccount({ force: true });
    expect(h.secrets.decrypt).not.toHaveBeenCalled();
    expect(h.fetchSpy).not.toHaveBeenCalled();
    const status = s.unlockStatus({ explicitRetry: true });
    expect(status).toMatchObject({ display: 'signed_in' });
    expect(h.secrets.decrypt).toHaveBeenCalledTimes(1);
    await s.refreshAccount({ force: true });
    expect(h.calls.map((c) => c.path)).toEqual(['/v1/account']);
  });

  it('refreshAccount on a locked service unlocks implicitly once', async () => {
    seedRow(h);
    const s = make();
    await s.refreshAccount({ force: true });
    expect(h.secrets.decrypt).toHaveBeenCalledTimes(1);
    expect(h.calls).toHaveLength(1);
  });

  it('requestAccountRefresh while locked makes no fetch and no decrypt', async () => {
    seedRow(h);
    const s = make();
    s.requestAccountRefresh();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.fetchSpy).not.toHaveBeenCalled();
    expect(h.secrets.decrypt).not.toHaveBeenCalled();
  });

  it('unlockStatus throws when the gate is closed and never decrypts', () => {
    seedRow(h);
    h.enabled.value = false;
    const s = make();
    expect(() => s.unlockStatus({ explicitRetry: true })).toThrow(expect.objectContaining({ name: 'CloudNotAvailableError' }));
    expect(h.secrets.decrypt).not.toHaveBeenCalled();
  });

  describe('signedIn.isNewDevice', () => {
    async function signInOnce(s: CloudAccountService): Promise<boolean> {
      const events: boolean[] = [];
      const listener = (ev: { isNewDevice: boolean }): void => { events.push(ev.isNewDevice); };
      s.on('signedIn', listener);
      const result = await s.signIn();
      s.off('signedIn', listener);
      expect(result).toEqual({ ok: true });
      expect(events).toHaveLength(1);
      return events[0] as boolean;
    }

    it('is true on a first sign-in', async () => {
      const s = make({ startLoopback: instantLoopback() });
      expect(await signInOnce(s)).toBe(true);
    });

    it('is true when the deviceId differs from the previous row', async () => {
      seedRow(h, { state: 'revoked', deviceId: 'dev_other' });
      const s = make({ startLoopback: instantLoopback() });
      expect(await signInOnce(s)).toBe(true);
    });

    it('is false on a same-device re-registration', async () => {
      seedRow(h, { state: 'revoked', deviceId: 'dev_1' });
      const s = make({ startLoopback: instantLoopback() });
      expect(await signInOnce(s)).toBe(false);
    });
  });

  describe('onBeforeSignOut', () => {
    it('runs hooks in parallel before the DELETE', async () => {
      seedRow(h);
      const s = make();
      const started: string[] = [];
      let releaseA: () => void = () => undefined;
      let releaseB: () => void = () => undefined;
      s.onBeforeSignOut(() => { started.push('a'); return new Promise<void>((r) => { releaseA = r; }); });
      s.onBeforeSignOut(() => { started.push('b'); return new Promise<void>((r) => { releaseB = r; }); });
      const pending = s.signOut();
      await until(() => started.length === 2, 'both hooks started');
      expect(h.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
      releaseA();
      releaseB();
      expect(await pending).toEqual({ remoteRevoked: 'yes' });
    });

    it('a hook that never resolves delays sign-out by at most 5 s', async () => {
      seedRow(h);
      const s = make();
      s.onBeforeSignOut(() => new Promise<void>(() => undefined));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let done = false;
      const pending = s.signOut().then((r) => { done = true; return r; });
      await vi.advanceTimersByTimeAsync(4_900);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      await until(() => done, 'sign-out after the hook budget');
      expect(await pending).toEqual({ remoteRevoked: 'yes' });
      expect(h.store.read()).toBeNull();
    });

    it('a throwing hook does not block sign-out', async () => {
      seedRow(h);
      const s = make();
      s.onBeforeSignOut(() => Promise.reject(new Error('hook bug')));
      expect(await s.signOut()).toEqual({ remoteRevoked: 'yes' });
      expect(h.store.read()).toBeNull();
    });

    it('an unregistered hook is not run', async () => {
      seedRow(h);
      const s = make();
      const hook = vi.fn(async () => undefined);
      const off = s.onBeforeSignOut(hook);
      off();
      await s.signOut();
      expect(hook).not.toHaveBeenCalled();
    });

    it('hooks do not run when there is no row', async () => {
      const s = make();
      const hook = vi.fn(async () => undefined);
      s.onBeforeSignOut(hook);
      await s.signOut();
      expect(hook).not.toHaveBeenCalled();
    });
  });
});
