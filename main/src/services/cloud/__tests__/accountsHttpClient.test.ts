import { describe, it, expect, vi } from 'vitest';
import { AccountsHttpClient, CloudHttpError, validateRegistration } from '../accountsHttpClient';
import type { FetchLike } from '../fetchLike';

const TOKEN = `cbd_${'A'.repeat(43)}`;
const REG = { token: TOKEN, deviceId: 'dev_1', deviceCode: 'ABC', deviceName: 'Test Mac', accountId: 'acc_1', scopes: ['bridge'] };
const REG_BODY = { code: 'c'.repeat(43), verifier: 'v'.repeat(43), name: 'Test Mac', platform: 'darwin', appVersion: '1.2.3', protocol: 1 };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function makeClient(handler: (url: string, init: RequestInit) => Response | Promise<Response>, over: { maxResponseBytes?: number; timeoutMs?: number } = {}) {
  const spy = vi.fn(async (url: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => handler(String(url), init ?? {}));
  const client = new AccountsHttpClient({
    origin: 'https://cloud.example.com/',
    fetch: spy as unknown as FetchLike,
    appVersion: '1.2.3',
    ...over,
  });
  return { client, spy };
}

function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

describe('AccountsHttpClient requests', () => {
  it('sends protocol, app-version and accept headers on every call', async () => {
    const { client, spy } = makeClient((url) => {
      if (url.endsWith('/register')) return json(201, REG);
      if (url.endsWith('/account')) return json(200, { accountId: 'acc_1', displayLogin: 'x', entitlements: [] });
      if (url.endsWith('/devices')) return json(200, { devices: [] });
      return json(200, { revoked: true });
    });
    await client.register(REG_BODY);
    await client.getAccount(TOKEN);
    await client.listDevices(TOKEN);
    await client.revokeSelf(TOKEN);
    expect(spy).toHaveBeenCalledTimes(4);
    for (const call of spy.mock.calls) {
      const h = headersOf(call[1] as RequestInit);
      expect(h['Cyboflow-Sync-Protocol']).toBe('1');
      expect(h['Cyboflow-App-Version']).toBe('1.2.3');
      expect(h.Accept).toBe('application/json');
    }
  });

  it('builds URLs from the origin without a doubled slash', async () => {
    const { client, spy } = makeClient(() => json(200, { devices: [] }));
    await client.listDevices(TOKEN);
    expect(spy.mock.calls[0]?.[0]).toBe('https://cloud.example.com/v1/devices');
  });

  it('sends Authorization only with a token and Content-Type only with a body', async () => {
    const { client, spy } = makeClient((url) =>
      url.endsWith('/register') ? json(201, REG) : json(200, { accountId: 'acc_1', displayLogin: null, entitlements: [] }),
    );
    await client.register(REG_BODY);
    await client.getAccount(TOKEN);
    const reg = headersOf(spy.mock.calls[0]?.[1] as RequestInit);
    const acct = headersOf(spy.mock.calls[1]?.[1] as RequestInit);
    expect(reg.Authorization).toBeUndefined();
    expect(reg['Content-Type']).toBe('application/json');
    expect(acct.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(acct['Content-Type']).toBeUndefined();
  });

  it("uses redirect:'error' and cache:'no-store'", async () => {
    const { client, spy } = makeClient(() => json(200, { devices: [] }));
    await client.listDevices(TOKEN);
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    expect(init.redirect).toBe('error');
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('register body is exactly {code, verifier, name, platform, appVersion, protocol:1}', async () => {
    const { client, spy } = makeClient(() => json(201, REG));
    await client.register(REG_BODY);
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(Object.keys(JSON.parse(String(init.body))).sort()).toEqual(
      ['appVersion', 'code', 'name', 'platform', 'protocol', 'verifier'],
    );
    expect(JSON.parse(String(init.body)).protocol).toBe(1);
  });
});

describe('AccountsHttpClient error mapping', () => {
  const cases: Array<[number, string, string]> = [
    [401, 'device_revoked', 'revoked'],
    [401, 'unauthorized', 'auth'],
    [403, 'not_entitled', 'not_entitled'],
    [403, 'forbidden', 'terminal'],
    [426, 'unsupported_protocol', 'upgrade_required'],
    [429, 'rate_limited', 'retryable'],
    [500, 'internal_error', 'retryable'],
    [503, 'accounts_unavailable', 'retryable'],
    [400, 'invalid_code', 'terminal'],
    [404, 'not_found', 'terminal'],
    [409, 'ref_code_taken', 'terminal'],
  ];
  it.each(cases)('status %i %s -> %s', async (status, code, kind) => {
    const { client } = makeClient(() => json(status, { error: code }));
    const err = await client.getAccount(TOKEN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudHttpError);
    expect((err as CloudHttpError).status).toBe(status);
    expect((err as CloudHttpError).code).toBe(code);
    expect((err as CloudHttpError).kind).toBe(kind);
  });

  it('a non-JSON error body becomes http_<status>', async () => {
    const { client } = makeClient(() => new Response('<html>oops</html>', { status: 502 }));
    const err = (await client.getAccount(TOKEN).catch((e: unknown) => e)) as CloudHttpError;
    expect(err.code).toBe('http_502');
    expect(err.kind).toBe('retryable');
  });

  it('keeps details only from an error body', async () => {
    const { client } = makeClient(() => json(400, { error: 'invalid_request', details: { field: 'name' } }));
    const err = (await client.register(REG_BODY).catch((e: unknown) => e)) as CloudHttpError;
    expect(err.details).toEqual({ field: 'name' });
  });

  it('parses Retry-After seconds and HTTP-date', async () => {
    const a = makeClient(() => json(429, { error: 'rate_limited' }, { 'retry-after': '12' }));
    expect(((await a.client.getAccount(TOKEN).catch((e: unknown) => e)) as CloudHttpError).retryAfterMs).toBe(12_000);
    const future = new Date(Date.now() + 60_000).toUTCString();
    const b = makeClient(() => json(503, { error: 'x' }, { 'retry-after': future }));
    const ms = ((await b.client.getAccount(TOKEN).catch((e: unknown) => e)) as CloudHttpError).retryAfterMs ?? 0;
    expect(ms).toBeGreaterThan(50_000);
    expect(ms).toBeLessThanOrEqual(60_000);
  });

  it('a 429 without Retry-After leaves retryAfterMs undefined', async () => {
    const { client } = makeClient(() => json(429, { error: 'rate_limited' }));
    expect(((await client.getAccount(TOKEN).catch((e: unknown) => e)) as CloudHttpError).retryAfterMs).toBeUndefined();
  });

  it('a 200 with a non-JSON body is bad_response (terminal)', async () => {
    const { client } = makeClient(() => new Response('not json', { status: 200 }));
    const err = (await client.getAccount(TOKEN).catch((e: unknown) => e)) as CloudHttpError;
    expect(err).toMatchObject({ status: 0, code: 'bad_response' });
    expect(err.kind).toBe('terminal');
  });

  it('register requires status 201 exactly', async () => {
    const { client } = makeClient(() => json(200, REG));
    const err = (await client.register(REG_BODY).catch((e: unknown) => e)) as CloudHttpError;
    expect(err).toMatchObject({ status: 0, code: 'bad_response' });
  });

  it('a response larger than maxResponseBytes is response_too_large', async () => {
    const { client } = makeClient(() => json(200, { devices: [], pad: 'x'.repeat(500) }), { maxResponseBytes: 100 });
    const err = (await client.listDevices(TOKEN).catch((e: unknown) => e)) as CloudHttpError;
    expect(err).toMatchObject({ status: 0, code: 'response_too_large' });
    expect(err.kind).toBe('network');
  });

  it('a declared content-length over the cap is rejected', async () => {
    const { client } = makeClient(() => json(200, { devices: [] }, { 'content-length': '5000' }), { maxResponseBytes: 100 });
    const err = (await client.listDevices(TOKEN).catch((e: unknown) => e)) as CloudHttpError;
    expect(err.code).toBe('response_too_large');
  });

  it('a transport throw is status 0 network and does not carry the transport message', async () => {
    const { client } = makeClient(() => {
      throw new Error('net::ERR_FAILED https://cloud.example.com/v1/account?secret=1');
    });
    const err = (await client.getAccount(TOKEN).catch((e: unknown) => e)) as CloudHttpError;
    expect(err).toMatchObject({ status: 0, code: 'network' });
    expect(err.message).not.toContain('secret');
    expect(err.kind).toBe('network');
  });

  it('an external abort has code aborted', async () => {
    const controller = new AbortController();
    const { client } = makeClient((_url, init) => new Promise<Response>((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const pending = client.getAccount(TOKEN, controller.signal).catch((e: unknown) => e);
    controller.abort();
    expect(((await pending) as CloudHttpError).code).toBe('aborted');
  });

  it('an internal timeout has code timeout', async () => {
    const { client } = makeClient((_url, init) => new Promise<Response>((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')));
    }), { timeoutMs: 20 });
    const err = (await client.getAccount(TOKEN).catch((e: unknown) => e)) as CloudHttpError;
    expect(err.code).toBe('timeout');
  });

  it('never puts a body, token or parse message in an error message', async () => {
    const { client } = makeClient(() => new Response(`{"token":"${TOKEN}" oops`, { status: 201 }));
    const err = (await client.register(REG_BODY).catch((e: unknown) => e)) as CloudHttpError;
    expect(err.code).toBe('bad_response');
    expect(String(err)).not.toContain('cbd_');
    expect(JSON.stringify(err)).not.toContain('cbd_');
    expect((err as { cause?: unknown }).cause).toBeUndefined();
  });
});

describe('AccountsHttpClient unusable registrations', () => {
  it('revokes a device whose 201 body failed validation, using the returned token', async () => {
    const { client, spy } = makeClient((url) =>
      url.endsWith('/register') ? json(201, { ...REG, deviceId: undefined }) : json(200, { revoked: true }),
    );
    const err = (await client.register(REG_BODY).catch((e: unknown) => e)) as CloudHttpError;
    expect(err.code).toBe('bad_response');
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    const [url, init] = spy.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://cloud.example.com/v1/devices/self');
    expect(init.method).toBe('DELETE');
    expect(headersOf(init).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('revokes the device when a non-201 success carries a valid-looking token', async () => {
    const { client, spy } = makeClient((url) =>
      url.endsWith('/register') ? json(200, REG) : json(200, { revoked: true }),
    );
    const err = (await client.register(REG_BODY).catch((e: unknown) => e)) as CloudHttpError;
    expect(err.code).toBe('bad_response');
    expect(JSON.stringify(err)).not.toContain(TOKEN);
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    const [url, init] = spy.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://cloud.example.com/v1/devices/self');
    expect(init.method).toBe('DELETE');
  });

  it('does not call the server again when the body holds no valid-looking token', async () => {
    const { client, spy } = makeClient(() => json(201, { ...REG, token: 'nope' }));
    await client.register(REG_BODY).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('AccountsHttpClient response shapes', () => {
  it('getAccount ignores unknown extra fields', async () => {
    const { client } = makeClient(() => json(200, { accountId: 'acc_1', displayLogin: 'octo', entitlements: ['bridge', 7], extra: true }));
    expect(await client.getAccount(TOKEN)).toEqual({ accountId: 'acc_1', displayLogin: 'octo', entitlements: ['bridge'] });
  });

  it('getAccount rejects a malformed account id', async () => {
    const { client } = makeClient(() => json(200, { accountId: 'a/b', displayLogin: null, entitlements: [] }));
    expect(((await client.getAccount(TOKEN).catch((e: unknown) => e)) as CloudHttpError).code).toBe('bad_response');
  });

  it('listDevices drops malformed entries', async () => {
    const good = { id: 'd1', code: 'ABC', name: 'Mac', platform: 'darwin', appVersion: '1', createdAt: 1000, lastSeenAt: null, revokedAt: null, current: true };
    const { client } = makeClient(() =>
      json(200, { devices: [good, { id: 5, code: 'X', name: 'y', createdAt: 1 }, { id: 'd2', code: 'DEF', name: 'n', createdAt: 'soon' }, 'str'] }),
    );
    const devices = await client.listDevices(TOKEN);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ id: 'd1', current: true, lastSeenAt: null });
  });

  it('revokeSelf accepts an empty body', async () => {
    const { client } = makeClient(() => new Response(null, { status: 204 }));
    await expect(client.revokeSelf(TOKEN)).resolves.toEqual({ revoked: true });
  });
});

describe('validateRegistration', () => {
  it('accepts a valid registration', () => {
    expect(validateRegistration(REG)).toEqual(REG);
  });
  it.each([
    ['a token with the wrong prefix', { ...REG, token: `cbf_${'A'.repeat(43)}` }],
    ['a bad device code', { ...REG, deviceCode: 'ab1' }],
    ['a device id with a slash', { ...REG, deviceId: 'a/b' }],
    ['an empty device name', { ...REG, deviceName: '' }],
    ['scopes that are not an array', { ...REG, scopes: 'bridge' }],
    ['a missing account id', { ...REG, accountId: undefined }],
    ['a non-object', 'nope'],
  ])('rejects %s', (_label, body) => {
    expect(() => validateRegistration(body)).toThrow(CloudHttpError);
    try {
      validateRegistration(body);
    } catch (err) {
      expect((err as CloudHttpError).code).toBe('bad_response');
      expect(String(err)).not.toContain('cbd_');
    }
  });
});
