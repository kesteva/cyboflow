import { describe, it, expect, vi } from 'vitest';
import { SyncHttpClient, SyncHttpError, type FetchLike } from '../syncHttpClient';

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

function setup(respond: () => Response | Promise<Response>, extra: { token?: string | null; maxResponseBytes?: number } = {}) {
  const fetchFn = vi.fn(async (_url: unknown, _init?: unknown) => respond());
  const client = new SyncHttpClient({
    origin: 'https://sync.example.com/',
    fetch: fetchFn as unknown as FetchLike,
    getToken: () => (extra.token === undefined ? 'tok' : extra.token),
    appVersion: '1.2.3',
    maxResponseBytes: extra.maxResponseBytes,
  });
  return { client, fetchFn };
}

async function failure(p: Promise<unknown>): Promise<SyncHttpError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(SyncHttpError);
    return e as SyncHttpError;
  }
  throw new Error('expected rejection');
}

describe('SyncHttpClient requests', () => {
  it('sends protocol, accept, bearer, redirect and cache settings', async () => {
    const { client, fetchFn } = setup(() => json({ now: 1, projects: {}, claims: [] }, { headers: { 'Cyboflow-Epoch': '7' } }));
    const r = await client.head();
    expect(r.epoch).toBe(7);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://sync.example.com/v1/head');
    const h = init.headers as Record<string, string>;
    expect(h['Cyboflow-Sync-Protocol']).toBe('1');
    expect(h['Cyboflow-App-Version']).toBe('1.2.3');
    expect(h.Accept).toBe('application/json');
    expect(h.Authorization).toBe('Bearer tok');
    expect(h['Content-Type']).toBeUndefined();
    expect(init.redirect).toBe('error');
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('omits Authorization without a token and sets Content-Type with a body', async () => {
    const { client, fetchFn } = setup(() => json({ project: { id: 'p' } }), { token: null });
    await client.createProject({ name: 'n', fingerprint: 'f' });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBeUndefined();
    expect(h['Content-Type']).toBe('application/json');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"name":"n","fingerprint":"f"}');
  });

  it('builds pull URLs with query and encoded segments', async () => {
    const { client, fetchFn } = setup(() => json({ items: [] }));
    await client.pull('a/b c', { since: 5, limit: 100, reset: true });
    expect(fetchFn.mock.calls[0][0]).toBe('https://sync.example.com/v1/projects/a%2Fb%20c/changes?since=5&limit=100&reset=1');
    await client.pull('p', { since: 0 });
    expect(fetchFn.mock.calls[1][0]).toBe('https://sync.example.com/v1/projects/p/changes?since=0');
  });

  it('hits the expected paths and methods for the other calls', async () => {
    const { client, fetchFn } = setup(() => json({}));
    await client.account();
    await client.listDevices();
    await client.signOutSelf();
    await client.push('p', { batchId: 'b', ops: [] });
    await client.resolveConflict('p', 'c/1', 'keep');
    await client.trackerClaim({ key: 'k', label: 'l', action: 'claim' });
    await client.checksum('p', { atSeq: 1, hash: 'h' });
    const calls = fetchFn.mock.calls.map((c) => `${(c[1] as RequestInit).method} ${c[0] as string}`);
    expect(calls).toEqual([
      'GET https://sync.example.com/v1/account',
      'GET https://sync.example.com/v1/devices',
      'DELETE https://sync.example.com/v1/devices/self',
      'POST https://sync.example.com/v1/projects/p/push',
      'POST https://sync.example.com/v1/projects/p/conflicts/c%2F1/resolve',
      'POST https://sync.example.com/v1/tracker-claims',
      'POST https://sync.example.com/v1/projects/p/checksum',
    ]);
  });

  it('returns a null epoch when the header is absent or invalid', async () => {
    expect((await setup(() => json({})).client.head()).epoch).toBeNull();
    expect((await setup(() => json({}, { headers: { 'Cyboflow-Epoch': 'x' } })).client.head()).epoch).toBeNull();
  });
});

describe('envelope unwrapping', () => {
  it('accepts wrapped and bare objects', async () => {
    const proj = { id: 'p1', name: 'n' };
    expect((await setup(() => json({ project: proj })).client.createProject({ name: 'n', fingerprint: 'f' })).body.project).toEqual(proj);
    expect((await setup(() => json(proj)).client.createProject({ name: 'n', fingerprint: 'f' })).body.project).toEqual(proj);
    expect((await setup(() => json({ projects: [proj] })).client.listProjects()).body.projects).toEqual([proj]);
    expect((await setup(() => json([proj])).client.listProjects()).body.projects).toEqual([proj]);
    const conflict = { id: 'c1' };
    expect((await setup(() => json({ conflict })).client.resolveConflict('p', 'c1', 'x')).body.conflict).toEqual(conflict);
    expect(
      (await setup(() => json(conflict)).client.fileConflict('p', { id: 'c1', kind: 'field', entityId: 'e', payload: { current: { value: 1, device: null, hlc: null }, other: { value: 2, device: null, hlc: null } } })).body.conflict,
    ).toEqual(conflict);
  });
});

describe('error mapping', () => {
  const err = (status: number, error: string, headers: Record<string, string> = {}, details?: unknown) =>
    failure(setup(() => json({ error, details }, { status, headers })).client.head());

  it('maps statuses to kinds', async () => {
    expect((await err(401, 'device_revoked')).kind).toBe('revoked');
    expect((await err(401, 'unauthorized')).kind).toBe('auth');
    expect((await err(403, 'not_entitled')).kind).toBe('not_entitled');
    expect((await err(426, 'upgrade_required')).kind).toBe('upgrade_required');
    expect((await err(409, 'rewound')).kind).toBe('rewound');
    expect((await err(503, 'unavailable')).kind).toBe('retryable');
    expect((await err(500, 'oops')).kind).toBe('retryable');
    expect((await err(400, 'bad')).kind).toBe('terminal');
    expect((await err(403, 'other')).kind).toBe('terminal');
  });

  it('parses Retry-After seconds', async () => {
    const e = await err(429, 'rate_limited', { 'Retry-After': '5' });
    expect(e.kind).toBe('retryable');
    expect(e.retryAfterMs).toBe(5000);
  });

  it('keeps error details (e.g. project_exists)', async () => {
    const e = await failure(setup(() => json({ error: 'project_exists', details: { id: 'p9' } }, { status: 409 })).client.createProject({ name: 'n', fingerprint: 'f' }));
    expect(e.code).toBe('project_exists');
    expect(e.details).toEqual({ id: 'p9' });
    expect(e.kind).toBe('terminal');
  });

  it('maps a thrown fetch to network', async () => {
    const e = await failure(setup(() => Promise.reject(new Error('socket hang up'))).client.head());
    expect(e.kind).toBe('network');
    expect(e.status).toBe(0);
    expect(e.message).toBe('socket hang up');
  });

  it('rejects oversize bodies', async () => {
    const e = await failure(setup(() => new Response('x'.repeat(100)), { maxResponseBytes: 10 }).client.head());
    expect(e.kind).toBe('network');
    expect(e.code).toBe('response_too_large');
  });

  it('rejects oversize bodies by Content-Length before reading', async () => {
    const e = await failure(setup(() => new Response('{}', { headers: { 'Content-Length': '999999' } }), { maxResponseBytes: 10 }).client.head());
    expect(e.code).toBe('response_too_large');
  });

  it('handles a non-JSON error body', async () => {
    const e = await failure(setup(() => new Response('<html>bad gateway</html>', { status: 502 })).client.head());
    expect(e.code).toBe('http_502');
    expect(e.kind).toBe('retryable');
  });

  it('maps a 2xx non-JSON body to bad_response', async () => {
    const e = await failure(setup(() => new Response('nope')).client.head());
    expect(e.code).toBe('bad_response');
    expect(e.kind).toBe('network');
  });
});
