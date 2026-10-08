import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseLike, LoggerLike } from '../../../orchestrator/types';
import { CloudAccountStore } from '../cloudAccountStore';
import { CloudAccountService } from '../cloudAccountService';
import type { CloudAccountServiceDeps } from '../cloudAccountService';
import { AccountsHttpClient } from '../accountsHttpClient';
import type { FetchLike } from '../fetchLike';
import type { CloudDevice } from '../cloudAccountHandle';

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

function callback(port: number, query: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/cb?${query}`, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
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

function loginParams(h: Harness): { port: number; state: string; challenge: string; name: string } {
  const url = new URL(h.opened[0] as string);
  return {
    port: Number(url.searchParams.get('port')),
    state: url.searchParams.get('state') as string,
    challenge: url.searchParams.get('challenge') as string,
    name: url.searchParams.get('name') as string,
  };
}

describe('CloudAccountService sign-in', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    h.service.stop();
    h.db.close();
    vi.useRealTimers();
  });

  it('happy path: login URL, callback, register, persisted row, events, account fill', async () => {
    const events: string[] = [];
    let signedIn: { device: CloudDevice; isNewDevice: boolean } | null = null;
    h.service.on('signedIn', (ev) => { events.push('signedIn'); signedIn = ev; });
    h.service.on('stateChanged', () => events.push('stateChanged'));

    const start = await h.service.startSignIn({ deviceName: 'My Laptop' });
    expect(Date.parse(start.expiresAt)).toBeGreaterThan(Date.now());
    const url = new URL(h.opened[0] as string);
    expect(`${url.origin}${url.pathname}`).toBe(`${STAGING}/desktop/login`);
    expect([...url.searchParams.keys()].sort()).toEqual(['challenge', 'name', 'port', 'state']);
    const { port, state, challenge, name } = loginParams(h);
    expect(name).toBe('My Laptop');
    expect(await callback(port, `code=${CODE}&state=${state}`)).toBe(200);

    await until(() => h.service.getState() === 'ok', 'signed in');
    const register = h.calls.find((c) => c.path === '/v1/devices/register');
    expect(h.calls.filter((c) => c.path === '/v1/devices/register')).toHaveLength(1);
    const body = register?.body as { verifier: string; code: string; protocol: number };
    expect(createHash('sha256').update(body.verifier).digest('base64url')).toBe(challenge);
    expect(body.code).toBe(CODE);
    expect(body.protocol).toBe(1);
    expect(register?.headers.Authorization).toBeUndefined();

    const row = h.store.read();
    expect(row?.state).toBe('ok');
    expect(row?.tokenCiphertext.equals(Buffer.from(TOKEN))).toBe(false);
    expect(h.secrets.encrypt).toHaveBeenCalledWith(TOKEN);
    expect(h.service.getToken()).toBe(TOKEN);
    expect(h.service.getDevice()).toEqual({
      origin: STAGING, accountId: 'acc_1', deviceId: 'dev_1', deviceCode: 'ABC', deviceName: 'Registered Name',
    });
    expect(events.indexOf('signedIn')).toBeLessThan(events.indexOf('stateChanged', events.indexOf('signedIn')));
    expect(signedIn).toMatchObject({ isNewDevice: true });

    await until(() => h.service.getStatus().available && (h.service.getStatus() as { account: { displayLogin: string | null } | null }).account?.displayLogin === 'octocat', 'account fill');
    expect(h.store.read()).toMatchObject({ displayLogin: 'octocat', entitlements: ['bridge'] });
    expect(h.store.read()?.lastOkAt).not.toBeNull();
  });

  it('the register call happens without any timer advancing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await h.service.startSignIn();
    const { port, state } = loginParams(h);
    await callback(port, `code=${CODE}&state=${state}`);
    await until(() => h.calls.some((c) => c.path === '/v1/devices/register'), 'register');
    expect(h.calls.filter((c) => c.path === '/v1/devices/register')).toHaveLength(1);
  });

  it('sign-in persists last_ok_at NULL; the follow-up refresh sets it', async () => {
    let release: () => void = () => undefined;
    h.routes.set('GET /v1/account', async () => {
      await new Promise<void>((r) => { release = r; });
      return json(200, { accountId: 'acc_1', displayLogin: 'octocat', entitlements: [] });
    });
    await h.service.startSignIn();
    const { port, state } = loginParams(h);
    await callback(port, `code=${CODE}&state=${state}`);
    await until(() => h.service.getState() === 'ok');
    await until(() => h.calls.some((c) => c.path === '/v1/account'));
    expect(h.store.read()?.lastOkAt).toBeNull();
    release();
    await until(() => h.store.read()?.lastOkAt !== null);
  });

  it('status, every stateChanged-derived status and the startSignIn result contain no state= and no challenge=', async () => {
    const seen: string[] = [];
    h.service.on('stateChanged', () => seen.push(JSON.stringify(h.service.getStatus())));
    const start = await h.service.startSignIn();
    seen.push(JSON.stringify(start), JSON.stringify(h.service.getStatus()));
    const { port, state, challenge } = loginParams(h);
    await callback(port, `code=${CODE}&state=${state}`);
    await until(() => h.service.getState() === 'ok');
    seen.push(JSON.stringify(h.service.getStatus()));
    expect(seen.length).toBeGreaterThan(3);
    for (const text of seen) {
      expect(text).not.toContain('state=');
      expect(text).not.toContain('challenge=');
      expect(text).not.toContain('desktop/login');
      expect(text).not.toContain(state);
      expect(text).not.toContain(challenge);
    }
  });

  it('reopenSignInPage while waiting calls openExternal again with the same URL; idle returns {opened:false}', async () => {
    expect(await h.service.reopenSignInPage()).toEqual({ opened: false });
    await h.service.startSignIn();
    const first = h.opened[0];
    expect(await h.service.reopenSignInPage()).toEqual({ opened: true });
    expect(h.opened).toEqual([first, first]);
    h.openExternal.mockRejectedValueOnce(new Error('no browser'));
    expect(await h.service.reopenSignInPage()).toEqual({ opened: false });
    expect(h.service.getStatus()).toMatchObject({ signIn: { phase: 'waiting_for_browser' } });
  });

  it('reopenSignInPage throws when the agents gate is closed', async () => {
    h.enabled.value = false;
    await expect(h.service.reopenSignInPage()).rejects.toMatchObject({ name: 'CloudNotAvailableError' });
  });

  it('openExternal rejection throws CloudSignInStartError(browser_open_failed) and closes the loopback', async () => {
    h.openExternal.mockRejectedValueOnce(new Error('no browser'));
    const err = await h.service.startSignIn().catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'CloudSignInStartError', code: 'browser_open_failed' });
    expect(h.service.getStatus()).toMatchObject({ signIn: { phase: 'idle' }, lastSignInFailure: { code: 'browser_open_failed' } });
  });

  it('a loopback bind failure throws CloudSignInStartError(loopback_failed) and is captured', async () => {
    const failing = makeHarness({ startLoopback: async () => { throw new Error('EADDRINUSE'); } });
    const err = await failing.service.startSignIn().catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'CloudSignInStartError', code: 'loopback_failed' });
    expect(failing.captureError).toHaveBeenCalledWith('cloud-signin', expect.anything(), { code: 'loopback_failed' });
    expect(failing.service.getStatus()).toMatchObject({ signIn: { phase: 'idle' } });
    failing.db.close();
  });

  it('browser phase timeout records timed_out, closes the loopback and makes no fetch', async () => {
    const quick = makeHarness({ timeouts: { browserPhaseMs: 30 } });
    await quick.service.startSignIn();
    const { port } = loginParams(quick);
    await until(() => (quick.service.getStatus() as { lastSignInFailure: unknown }).lastSignInFailure !== null);
    expect(quick.service.getStatus()).toMatchObject({ lastSignInFailure: { code: 'timed_out' }, signIn: { phase: 'idle' } });
    expect(quick.fetchSpy).not.toHaveBeenCalled();
    await expect(callback(port, 'state=x')).rejects.toBeDefined();
    quick.db.close();
  });

  it('cancelSignIn while waiting records cancelled with no fetch', async () => {
    await h.service.startSignIn();
    expect(h.service.cancelSignIn()).toEqual({ cancelled: true });
    await until(() => h.service.getStatus().available && (h.service.getStatus() as { signIn: { phase: string } }).signIn.phase === 'idle');
    expect(h.service.getStatus()).toMatchObject({ lastSignInFailure: { code: 'cancelled' } });
    expect(h.fetchSpy).not.toHaveBeenCalled();
  });

  it('the browser reporting error=cancelled records cancelled', async () => {
    await h.service.startSignIn();
    const { port, state } = loginParams(h);
    await callback(port, `error=cancelled&state=${state}`);
    await until(() => (h.service.getStatus() as { lastSignInFailure: unknown }).lastSignInFailure !== null);
    expect(h.service.getStatus()).toMatchObject({ lastSignInFailure: { code: 'cancelled' } });
  });

  it('error=access_denied records browser_error; a short code records invalid_callback', async () => {
    await h.service.startSignIn();
    let p = loginParams(h);
    await callback(p.port, `error=access_denied&state=${p.state}`);
    await until(() => (h.service.getStatus() as { lastSignInFailure: unknown }).lastSignInFailure !== null);
    expect(h.service.getStatus()).toMatchObject({ lastSignInFailure: { code: 'browser_error' } });

    h.opened.length = 0;
    await h.service.startSignIn();
    p = loginParams(h);
    await callback(p.port, `code=abc&state=${p.state}`);
    await until(() => (h.service.getStatus() as { lastSignInFailure: { code: string } | null }).lastSignInFailure?.code === 'invalid_callback');
  });

  it('a mismatched-state callback never ends the sign-in', async () => {
    await h.service.startSignIn();
    const { port, state } = loginParams(h);
    for (let i = 0; i < 6; i += 1) expect(await callback(port, `code=${CODE}&state=nope${i}`)).toBe(400);
    expect(h.service.getStatus()).toMatchObject({ signIn: { phase: 'waiting_for_browser' }, lastSignInFailure: null });
    expect(h.fetchSpy).not.toHaveBeenCalled();
    await callback(port, `code=${CODE}&state=${state}`);
    await until(() => h.service.getState() === 'ok');
  });

  it('cancelSignIn while registering returns {cancelled:false}', async () => {
    let release: () => void = () => undefined;
    h.routes.set('POST /v1/devices/register', async () => {
      await new Promise<void>((r) => { release = r; });
      return json(201, REG);
    });
    await h.service.startSignIn();
    const { port, state } = loginParams(h);
    await callback(port, `code=${CODE}&state=${state}`);
    await until(() => h.calls.some((c) => c.path === '/v1/devices/register'));
    expect(h.service.getStatus()).toMatchObject({ signIn: { phase: 'registering' }, display: 'signing_in' });
    expect(h.service.cancelSignIn()).toEqual({ cancelled: false });
    release();
    await until(() => h.service.getState() === 'ok');
  });

  describe('register failures', () => {
    const rows: Array<[string, number, string, string, boolean]> = [
      ['invalid_code', 400, 'invalid_code', 'invalid_code', false],
      ['invalid_request', 400, 'invalid_request', 'bad_request', true],
      ['ref_code_taken', 409, 'ref_code_taken', 'ref_code_taken', false],
      ['unsupported_protocol', 426, 'unsupported_protocol', 'upgrade_required', false],
      ['rate_limited', 429, 'rate_limited', 'rate_limited', false],
      ['accounts_unavailable', 503, 'accounts_unavailable', 'service_unavailable', false],
      ['internal_error', 500, 'internal_error', 'service_unavailable', false],
      ['an unmapped 418', 418, 'teapot', 'unexpected', true],
    ];
    it.each(rows)('%s -> %s failure code, nothing persisted', async (_label, status, serverCode, failure, captured) => {
      h.routes.set('POST /v1/devices/register', () => json(status, { error: serverCode }));
      await h.service.startSignIn();
      const { port, state } = loginParams(h);
      await callback(port, `code=${CODE}&state=${state}`);
      await until(() => (h.service.getStatus() as { lastSignInFailure: unknown }).lastSignInFailure !== null);
      expect(h.service.getStatus()).toMatchObject({ lastSignInFailure: { code: failure }, signIn: { phase: 'idle' } });
      expect(h.store.read()).toBeNull();
      expect(h.captureError.mock.calls.length > 0).toBe(captured);
    });

    it('a transport failure records network', async () => {
      h.routes.set('POST /v1/devices/register', () => { throw new Error('net::ERR_FAILED'); });
      await h.service.startSignIn();
      const { port, state } = loginParams(h);
      await callback(port, `code=${CODE}&state=${state}`);
      await until(() => (h.service.getStatus() as { lastSignInFailure: unknown }).lastSignInFailure !== null);
      expect(h.service.getStatus()).toMatchObject({ lastSignInFailure: { code: 'network' } });
      expect(h.captureError).not.toHaveBeenCalled();
    });

    it('a bad registration body records bad_response and revokes the device with the returned token', async () => {
      h.routes.set('POST /v1/devices/register', () => json(201, { ...REG, deviceId: undefined }));
      await h.service.startSignIn();
      const { port, state } = loginParams(h);
      await callback(port, `code=${CODE}&state=${state}`);
      await until(() => (h.service.getStatus() as { lastSignInFailure: unknown }).lastSignInFailure !== null);
      expect(h.service.getStatus()).toMatchObject({ lastSignInFailure: { code: 'bad_response' } });
      expect(h.captureError).toHaveBeenCalled();
      await until(() => h.calls.some((c) => c.method === 'DELETE' && c.path === '/v1/devices/self'));
      const del = h.calls.find((c) => c.method === 'DELETE');
      expect(del?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(h.store.read()).toBeNull();
    });
  });

  it('encrypt throwing SecretsUnavailableError records secrets_unavailable and revokes the device', async () => {
    h.secrets.encrypt.mockImplementation(() => { throw new SecretsUnavailable(); });
    await h.service.startSignIn();
    const { port, state } = loginParams(h);
    await callback(port, `code=${CODE}&state=${state}`);
    await until(() => (h.service.getStatus() as { lastSignInFailure: unknown }).lastSignInFailure !== null);
    expect(h.service.getStatus()).toMatchObject({ lastSignInFailure: { code: 'secrets_unavailable' } });
    await until(() => h.calls.some((c) => c.method === 'DELETE' && c.path === '/v1/devices/self'));
    expect(h.store.read()).toBeNull();
  });

  it('startSignIn while in progress rejects with CloudSignInInProgressError', async () => {
    await h.service.startSignIn();
    await expect(h.service.startSignIn()).rejects.toMatchObject({ name: 'CloudSignInInProgressError' });
  });

  it('startSignIn while signed in rejects with CloudAlreadySignedInError', async () => {
    await h.service.startSignIn();
    const { port, state } = loginParams(h);
    await callback(port, `code=${CODE}&state=${state}`);
    await until(() => h.service.getState() === 'ok');
    await expect(h.service.startSignIn()).rejects.toMatchObject({ name: 'CloudAlreadySignedInError' });
  });

  it('startSignIn with the agents gate closed rejects with CloudNotAvailableError', async () => {
    h.enabled.value = false;
    await expect(h.service.startSignIn()).rejects.toMatchObject({ name: 'CloudNotAvailableError' });
    expect(h.opened).toHaveLength(0);
  });

  it.each(['revoked', 'undecryptable'] as const)('signing in from a %s row replaces it and reports a new device', async (state) => {
    h.store.upsert({
      origin: STAGING, accountId: 'acc_old', deviceId: 'dev_old', deviceName: 'Old', deviceCode: 'OLD', displayLogin: null,
      entitlements: [], scopes: [], tokenCiphertext: Buffer.from('enc:old'), state, createdAt: '2026-10-01T00:00:00.000Z', lastOkAt: null,
    });
    const fresh = new CloudAccountService({ ...serviceDepsOf(h), store: h.store });
    const events: boolean[] = [];
    fresh.on('signedIn', (ev) => events.push(ev.isNewDevice));
    await fresh.startSignIn();
    const { port, state: st } = loginParams(h);
    await callback(port, `code=${CODE}&state=${st}`);
    await until(() => fresh.getState() === 'ok');
    expect(h.store.read()).toMatchObject({ deviceId: 'dev_1', state: 'ok' });
    expect(events).toEqual([true]);
    fresh.stop();
  });

  it('stop() while waiting closes the loopback and persists nothing', async () => {
    await h.service.startSignIn();
    const { port } = loginParams(h);
    h.service.stop();
    expect(h.service.getStatus()).toMatchObject({ signIn: { phase: 'idle' } });
    await expect(callback(port, 'state=x')).rejects.toBeDefined();
    expect(h.store.read()).toBeNull();
    expect(h.fetchSpy).not.toHaveBeenCalled();
  });

  it('stop() while the loopback is binding opens no browser and rejects the start', async () => {
    let finishBind: () => void = () => undefined;
    const close = vi.fn();
    const slow = makeHarness({
      startLoopback: () =>
        new Promise((resolve) => {
          finishBind = () =>
            resolve({ port: 1, outcome: new Promise(() => undefined), close } as unknown as Awaited<
              ReturnType<NonNullable<CloudAccountServiceDeps['startLoopback']>>
            >);
        }),
    });
    const started = slow.service.startSignIn().catch((e: unknown) => e);
    slow.service.stop();
    finishBind();
    expect(await started).toMatchObject({ name: 'CloudSignInStartError' });
    expect(slow.openExternal).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    slow.db.close();
  });

  it('a forced refresh after sign-out and a new sign-in is not coalesced onto the stale in-flight one', async () => {
    let accountCalls = 0;
    h.routes.set('GET /v1/account', async () => {
      accountCalls += 1;
      if (accountCalls === 1) await new Promise<void>((r) => setTimeout(r, 300));
      return json(200, { accountId: 'acc_1', displayLogin: 'octocat', entitlements: ['bridge'] });
    });
    await h.service.startSignIn();
    let p = loginParams(h);
    await callback(p.port, `code=${CODE}&state=${p.state}`);
    await until(() => accountCalls === 1, 'first account fetch');
    await h.service.signOut();
    h.opened.length = 0;
    await h.service.startSignIn();
    p = loginParams(h);
    await callback(p.port, `code=${CODE}&state=${p.state}`);
    await until(() => accountCalls === 2, 'second account fetch');
  });

  it('signOut() during registering aborts the sign-in and persists nothing', async () => {
    let release: () => void = () => undefined;
    h.routes.set('POST /v1/devices/register', async () => {
      await new Promise<void>((r) => { release = r; });
      return json(201, REG);
    });
    await h.service.startSignIn();
    const { port, state } = loginParams(h);
    await callback(port, `code=${CODE}&state=${state}`);
    await until(() => h.calls.some((c) => c.path === '/v1/devices/register'));
    await h.service.signOut();
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(h.store.read()).toBeNull();
    expect(h.service.getState()).toBe('signed_out');
  });

  it('a /v1/account failure after register keeps the sign-in with a null display login', async () => {
    h.routes.set('GET /v1/account', () => json(503, { error: 'accounts_unavailable' }));
    await h.service.startSignIn();
    const { port, state } = loginParams(h);
    await callback(port, `code=${CODE}&state=${state}`);
    await until(() => h.service.getState() === 'ok');
    await until(() => (h.service.getStatus() as { lastError: unknown }).lastError !== null);
    expect(h.service.getState()).toBe('ok');
    expect(h.store.read()).toMatchObject({ displayLogin: null, state: 'ok' });
  });

  it('a sign-in whose request raced a stop() is discarded and the device is revoked', async () => {
    let release: () => void = () => undefined;
    h.routes.set('POST /v1/devices/register', async () => {
      await new Promise<void>((r) => { release = r; });
      return json(201, REG);
    });
    await h.service.startSignIn();
    const { port, state } = loginParams(h);
    await callback(port, `code=${CODE}&state=${state}`);
    await until(() => h.calls.some((c) => c.path === '/v1/devices/register'));
    h.service.stop();
    release();
    await until(() => h.calls.some((c) => c.method === 'DELETE' && c.path === '/v1/devices/self'));
    await new Promise((r) => setTimeout(r, 30));
    expect(h.store.read()).toBeNull();
  });
});

function serviceDepsOf(h: Harness): CloudAccountServiceDeps {
  return {
    store: h.store,
    createHttpClient: (origin) => new AccountsHttpClient({ origin, fetch: h.fetchSpy as unknown as FetchLike, appVersion: '9.9.9' }),
    fetch: h.fetchSpy as unknown as FetchLike,
    secrets: h.secrets,
    openExternal: h.openExternal,
    isEnabled: () => true,
    isDevBuild: () => true,
    getConfiguredOrigin: () => STAGING,
    appVersion: '9.9.9',
    platform: 'darwin',
    defaultDeviceName: () => 'Default Mac',
    logger: h.logger,
    captureError: h.captureError,
  };
}
