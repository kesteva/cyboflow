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



function instantLoopback(): NonNullable<CloudAccountServiceDeps['startLoopback']> {
  return async () => ({
    port: 54321,
    outcome: Promise.resolve({ kind: 'code' as const, code: CODE }),
    close: () => undefined,
  });
}

function serialize(value: unknown): string {
  if (value instanceof Error) {
    return [String(value), value.message, value.stack ?? '', JSON.stringify(value), JSON.stringify(value, Object.getOwnPropertyNames(value))].join('\n');
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Everything a logger or Sentry capture received, flattened to text. */
function observed(h: Harness): string {
  const parts: string[] = [];
  for (const fn of [h.logger.info, h.logger.warn, h.logger.error, h.logger.debug]) {
    for (const call of (fn as ReturnType<typeof vi.fn>).mock.calls) parts.push(serialize(call));
  }
  for (const call of h.captureError.mock.calls) {
    for (const arg of call) parts.push(serialize(arg));
  }
  return parts.join('\n');
}

describe('CloudAccountService secret hygiene', () => {
  let h: Harness;
  const services: CloudAccountService[] = [];
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => {
    for (const s of services.splice(0)) s.stop();
    h.db.close();
  });

  const bad: Array<[string, () => Response]> = [
    ['a body missing deviceId', () => json(201, { ...REG, deviceId: undefined })],
    ['trailing garbage after the JSON', () => new Response(`${JSON.stringify(REG)} trailing`, { status: 201 })],
    ['truncated JSON', () => new Response(`{"token":"${TOKEN}","deviceId":"dev_`, { status: 201 })],
    ['a content-length over the cap', () => new Response(JSON.stringify(REG), { status: 201, headers: { 'content-length': '99999999' } })],
    ['a 200 instead of 201', () => json(200, REG)],
    ['a 400 whose body echoes the token', () => json(400, { error: 'invalid_request', message: TOKEN, details: { echoed: 'nope' } })],
  ];

  it.each(bad)('register with %s leaks no secret into errors, logs or captures', async (_label, response) => {
    h.routes.set('POST /v1/devices/register', response);
    const service = relaunch(h, { startLoopback: instantLoopback() });
    services.push(service);
    const result = await service.signIn();
    expect(result.ok).toBe(false);
    const text = [observed(h), serialize(result), JSON.stringify(service.getStatus())].join('\n');
    expect(text).not.toContain('cbd_');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(CODE);
    expect(text).not.toContain('desktop/login');
    expect(h.store.read()).toBeNull();
  });

  it('the errors the sink would see carry no cause and no token (direct client check)', async () => {
    h.routes.set('POST /v1/devices/register', () => new Response(`{"token":"${TOKEN}" garbage`, { status: 201 }));
    const client = new AccountsHttpClient({ origin: STAGING, fetch: h.fetchSpy as unknown as FetchLike, appVersion: '1' });
    const err = await client
      .register({ code: CODE, verifier: 'v'.repeat(43), name: 'n', platform: 'darwin', appVersion: '1', protocol: 1 })
      .catch((e: unknown) => e);
    expect(serialize(err)).not.toContain('cbd_');
    expect((err as { cause?: unknown }).cause).toBeUndefined();
  });

  it('a full successful sign-in logs and captures no token, code, verifier, state or login URL', async () => {
    const service = relaunch(h, { startLoopback: instantLoopback() });
    services.push(service);
    expect(await service.signIn()).toEqual({ ok: true });
    await until(() => h.store.read()?.lastOkAt !== null && h.store.read()?.lastOkAt !== undefined);
    const body = h.calls.find((c) => c.path === '/v1/devices/register')?.body as { verifier: string };
    const loginUrl = h.opened[0] as string;
    const state = new URL(loginUrl).searchParams.get('state') as string;
    const text = observed(h);
    for (const secret of [TOKEN, CODE, body.verifier, state, loginUrl, new URL(loginUrl).searchParams.get('challenge') as string]) {
      expect(text).not.toContain(secret);
    }
  });

  it('a failed decrypt, a revocation and a sign-out log no token', async () => {
    seedRow(h);
    h.secrets.decrypt.mockImplementationOnce(() => { throw new Error(`cannot decrypt ${TOKEN}`); });
    const service = relaunch(h);
    services.push(service);
    service.unlock('user');
    seedRow(h);
    const second = relaunch(h);
    services.push(second);
    second.unlock('user');
    second.markRevoked('device_revoked');
    await second.signOut();
    // The decrypt error text above is the dependency's own message; the service must not forward it.
    expect(observed(h)).not.toContain(TOKEN);
  });

  it('malformed account and device bodies leak nothing', async () => {
    seedRow(h);
    h.routes.set('GET /v1/account', () => new Response(`{"accountId":"${TOKEN}" oops`, { status: 200 }));
    h.routes.set('GET /v1/devices', () => new Response(`[${TOKEN}`, { status: 200 }));
    const service = relaunch(h);
    services.push(service);
    service.unlock('user');
    await service.refreshAccount({ force: true });
    const devices = await service.listDevices();
    const text = [observed(h), JSON.stringify(service.getStatus()), JSON.stringify(devices)].join('\n');
    expect(text).not.toContain('cbd_');
  });

  it('no account id, device id or token appears in the status', async () => {
    seedRow(h);
    const service = relaunch(h);
    services.push(service);
    service.unlock('user');
    await service.refreshAccount({ force: true });
    const text = JSON.stringify(service.getStatus());
    for (const secret of [TOKEN, 'acc_1', 'dev_1', 'enc:']) expect(text).not.toContain(secret);
  });
});
