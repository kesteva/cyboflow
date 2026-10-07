import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayClient } from '../relayClient';
import { RelayHttpError } from '../relayErrors';
import { fakeDevice, FakeCloud } from './fakeCloud';
import { setupBridge, type BridgeHarness } from './fakeCore';
import { FakeRelay } from './fakeRelay';

const SECRET_RE = /cbd_|cbh_|\b[A-Za-z]{3,8}-[A-Za-z]{3,8}-\d{4}\b/;

async function caught(p: Promise<unknown>): Promise<RelayHttpError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RelayHttpError) return e;
    throw e;
  }
  throw new Error('expected a RelayHttpError');
}

function dump(v: unknown): string {
  if (v instanceof Error) {
    const props: Record<string, unknown> = {};
    for (const k of Object.getOwnPropertyNames(v)) props[k] = (v as unknown as Record<string, unknown>)[k];
    return `${String(v)} ${JSON.stringify(props)} ${v.cause !== undefined ? dump(v.cause) : ''}`;
  }
  return JSON.stringify(v) ?? String(v);
}

let h: BridgeHarness;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  h?.bridge.dispose();
  vi.useRealTimers();
});

describe('RelayClient', () => {
  it('sends bearer and protocol headers on every endpoint', async () => {
    h = setupBridge();
    const { relay, bridge } = h;
    const created = await bridge.relay.createConnection({ transport: 'relay-mcp', label: 'Scout' });
    relay.vendorSend(created.connectionId, { body: 'hi' });
    await bridge.relay.listConnections();
    const page = await bridge.relay.pullInbound(created.connectionId, { epoch: 1, after: 0 });
    await bridge.relay.ack(created.connectionId, { epoch: page.epoch, upTo: 1 });
    await bridge.relay.postOutbound(created.connectionId, { envelope: { id: 'm1', kind: 'text', body: 'x', links: [] } });
    await bridge.relay.withdrawOutbound(created.connectionId, 'm1');
    await bridge.relay.repair(created.connectionId);
    await bridge.relay.revoke(created.connectionId);
    const methods = relay.requests.map((r) => `${r.method} ${r.path.replace(/\?.*$/, '').replace(/c_[a-z2-7]+/, ':id')}`);
    expect(methods).toEqual([
      'POST /connections', 'GET /connections', 'GET /connections/:id/inbound', 'POST /connections/:id/ack',
      'POST /connections/:id/outbound', 'DELETE /connections/:id/outbound/m1', 'POST /connections/:id/repair',
      'POST /connections/:id/revoke',
    ]);
    for (const r of relay.requests) {
      expect(r.headers.authorization).toBe(`Bearer ${relay.token}`);
      expect(r.headers['cyboflow-relay-protocol']).toBe('1');
      expect(r.headers['cyboflow-app-version']).toBe('9.9.9-test');
      expect(r.status).not.toBe('fault');
    }
    // revoke/repair send no body and no content type
    const revoke = relay.requests[relay.requests.length - 1];
    expect(revoke.body).toBeUndefined();
    expect(revoke.headers['content-type']).toBeUndefined();
  });

  it('targets device origin + /bridge/v1 and encodes ids; an unsafe id is rejected without a request', async () => {
    h = setupBridge();
    await h.bridge.relay.listConnections();
    expect(h.relay.requests[0].url.startsWith('https://cloud.test/bridge/v1/')).toBe(true);
    const e = await caught(h.bridge.relay.pullInbound('c/../x', { epoch: 0, after: 0 }));
    expect(e.kind).toBe('invalid_request');
    expect(h.relay.requests).toHaveLength(1);
  });

  it('signed out: no request', async () => {
    h = setupBridge();
    h.cloud.token = null;
    const e = await caught(h.bridge.relay.listConnections());
    expect(e.kind).toBe('signed_out');
    expect(h.relay.requests).toHaveLength(0);
  });

  it('426 maps to update_required with range from body', async () => {
    h = setupBridge();
    const spy = vi.spyOn(h.bridge.runtime, 'onUpdateRequired');
    h.relay.protocolRange = { min: 2, max: 3 };
    const e = await caught(h.bridge.relay.listConnections());
    expect(e.kind).toBe('update_required');
    expect(e.protocolRange).toEqual({ min: 2, max: 3 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(h.bridge.runtime.status()).toEqual({ state: 'needs_update', min: 2, max: 3 });
  });

  it('426 maps to update_required with range from headers when body lacks details', async () => {
    h = setupBridge();
    h.relay.injectOnce({ path: /^\/connections$/ }, {
      kind: 'http', status: 426, error: 'unsupported_protocol',
      headers: { 'Cyboflow-Relay-Protocol-Min': '4', 'Cyboflow-Relay-Protocol-Max': '5' },
    });
    const e = await caught(h.bridge.relay.listConnections());
    expect(e.protocolRange).toEqual({ min: 4, max: 5 });
  });

  it('401 device_revoked marks the device revoked (once)', async () => {
    h = setupBridge();
    h.relay.revokedDevice = true;
    const e = await caught(h.bridge.relay.listConnections());
    expect(e.kind).toBe('device_revoked');
    expect(h.cloud.markRevokedCalls).toEqual(['device_revoked']);
    const again = await caught(h.bridge.relay.listConnections());
    expect(again.kind).toBe('paused');
    expect(h.relay.requests).toHaveLength(1);
    expect(h.cloud.markRevokedCalls).toEqual(['device_revoked']);
    expect(h.bridge.runtime.status()).toEqual({ state: 'needs_sign_in', reason: 'device_revoked' });
  });

  it('401 unauthorized → markRevoked(unauthorized)', async () => {
    h = setupBridge();
    h.relay.token = `cbd_${'b'.repeat(43)}`;
    const e = await caught(h.bridge.relay.listConnections());
    expect(e.kind).toBe('unauthorized');
    expect(h.cloud.markRevokedCalls).toEqual(['unauthorized']);
    expect(h.bridge.runtime.status()).toEqual({ state: 'needs_sign_in', reason: 'unauthorized' });
  });

  it('401 for a request made by a previous device does not revoke the new one', async () => {
    const relay = new FakeRelay();
    const cloud = new FakeCloud({ fetch: relay.fetch });
    relay.revokedDevice = true;
    const swapping = ((input: string | URL | Request, init?: RequestInit) => {
      cloud.device = fakeDevice({ deviceId: 'dev_2' });
      return relay.fetch(input, init);
    }) as typeof fetch;
    h = setupBridge({ relay, cloud, fetch: swapping });
    const e = await caught(h.bridge.relay.listConnections());
    expect(e.kind).toBe('device_revoked');
    expect(cloud.markRevokedCalls).toEqual([]);
  });

  it('403 not_entitled pauses without sign-out', async () => {
    h = setupBridge();
    h.relay.entitled = false;
    const e = await caught(h.bridge.relay.listConnections());
    expect(e.kind).toBe('not_entitled');
    expect(h.cloud.markRevokedCalls).toEqual([]);
    expect(h.bridge.runtime.status()).toEqual({ state: 'not_entitled' });
  });

  it('409 details are parsed', async () => {
    h = setupBridge();
    const { connectionId } = await h.bridge.relay.createConnection({ transport: 'relay-mcp' });
    const stale = await caught(h.bridge.relay.ack(connectionId, { epoch: 999, upTo: 1 }));
    expect(stale.kind).toBe('stale_epoch');
    expect(stale.details.epoch).toBe(1);
    h.relay.vendorSend(connectionId, { body: 'x' });
    await h.bridge.relay.pullInbound(connectionId, { epoch: 1, after: 0 });
    const beyond = await caught(h.bridge.relay.ack(connectionId, { epoch: 1, upTo: 5 }));
    expect(beyond.kind).toBe('ack_beyond_served');
    expect(beyond.details.maxServed).toBe(1);
    h.relay.injectOnce({ method: 'POST', path: /^\/connections$/ }, { kind: 'http', status: 409, error: 'connection_limit', details: { max: 20 } });
    const limit = await caught(h.bridge.relay.createConnection({ transport: 'relay-mcp' }));
    expect(limit.kind).toBe('connection_limit');
    expect(limit.details.max).toBe(20);
  });

  it('429 with Retry-After blocks globally', async () => {
    h = setupBridge();
    h.relay.injectOnce({ path: /^\/connections$/ }, { kind: 'http', status: 429, error: 'rate_limited', retryAfterSec: 7 });
    const e = await caught(h.bridge.relay.listConnections());
    expect(e.kind).toBe('rate_limited');
    expect(e.retryAfterMs).toBe(7000);
    await vi.advanceTimersByTimeAsync(6000);
    const blocked = await caught(h.bridge.relay.listConnections());
    expect(blocked.kind).toBe('rate_limited');
    expect(h.relay.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    await h.bridge.relay.listConnections();
    expect(h.relay.requests).toHaveLength(2);
  });

  it('429 without Retry-After uses default backoff (30 s, 60 s; success resets)', async () => {
    h = setupBridge();
    const inject = () => h.relay.injectOnce({ path: /^\/connections$/ }, { kind: 'http', status: 429, error: 'rate_limited' });
    inject();
    expect((await caught(h.bridge.relay.listConnections())).retryAfterMs).toBe(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    inject();
    expect((await caught(h.bridge.relay.listConnections())).retryAfterMs).toBe(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await h.bridge.relay.listConnections();
    inject();
    expect((await caught(h.bridge.relay.listConnections())).retryAfterMs).toBe(30_000);
  });

  it('503 accounts_unavailable never signs out', async () => {
    h = setupBridge();
    h.relay.accountsDown = true;
    const e = await caught(h.bridge.relay.listConnections());
    expect(e.kind).toBe('unavailable');
    expect(e.retryAfterMs).toBe(5000);
    expect(h.cloud.markRevokedCalls).toEqual([]);
    expect(h.cloud.getState()).toBe('ok');
  });

  it('503 relay_disabled without header backs off 60 s', async () => {
    h = setupBridge();
    h.relay.disabled = true;
    const e = await caught(h.bridge.relay.listConnections());
    expect(e.kind).toBe('unavailable');
    expect(e.code).toBe('relay_disabled');
    expect(e.retryAfterMs).toBe(60_000);
    expect(h.bridge.runtime.budget.blockedUntil()).toBe(Date.now() + 60_000);
  });

  it('503 revoke_pending is not a global block', async () => {
    h = setupBridge();
    const { connectionId } = await h.bridge.relay.createConnection({ transport: 'relay-mcp' });
    h.relay.revokePendingTimes(connectionId, 1);
    const e = await caught(h.bridge.relay.revoke(connectionId));
    expect(e.kind).toBe('revoke_pending');
    expect(e.retryAfterMs).toBe(5000);
    await expect(h.bridge.relay.listConnections()).resolves.toBeDefined();
  });

  it('5xx is server_error and retryable', async () => {
    h = setupBridge();
    h.relay.injectOnce({ path: /^\/connections$/ }, { kind: 'http', status: 502, error: 'internal_error' });
    const e = await caught(h.bridge.relay.listConnections());
    expect(e.kind).toBe('server_error');
    expect(e.retryable).toBe(true);
    expect(e.retryAfterMs).toBe(5000);
  });

  it('network and timeout errors', async () => {
    h = setupBridge();
    h.relay.injectOnce({}, { kind: 'network' });
    const net = await caught(h.bridge.relay.listConnections());
    expect([net.kind, net.code]).toEqual(['network', 'network']);
    h.relay.injectOnce({}, { kind: 'timeout' });
    const to = await caught(h.bridge.relay.listConnections());
    expect([to.kind, to.code]).toEqual(['network', 'timeout']);
    h.relay.injectOnce({}, { kind: 'hang' });
    const pending = caught(h.bridge.relay.listConnections());
    await vi.advanceTimersByTimeAsync(0);
    h.bridge.stop();
    const aborted = await pending;
    expect([aborted.kind, aborted.code]).toEqual(['network', 'aborted']);
  });

  it('a caller signal aborting during the fetch rejects with code timeout', async () => {
    h = setupBridge();
    h.relay.injectOnce({}, { kind: 'hang' });
    const c = new AbortController();
    const pending = caught(h.bridge.relay.listConnections({ signal: c.signal }));
    await vi.advanceTimersByTimeAsync(0);
    c.abort();
    const e = await pending;
    expect([e.kind, e.code, e.sent]).toEqual(['network', 'timeout', true]);
  });

  it('non-JSON 2xx and shape violations are bad_response', async () => {
    h = setupBridge();
    h.relay.injectOnce({}, { kind: 'non_json' });
    expect((await caught(h.bridge.relay.listConnections())).kind).toBe('bad_response');
    const { connectionId } = await h.bridge.relay.createConnection({ transport: 'relay-mcp' });
    h.relay.injectOnce({ path: /inbound/ }, { kind: 'raw', status: 200, body: JSON.stringify({ items: [], head: 0 }) });
    const e = await caught(h.bridge.relay.pullInbound(connectionId, { epoch: 1, after: 0 }));
    expect([e.kind, e.code]).toEqual(['bad_response', 'invalid_shape']);
  });

  it('oversized response is rejected', async () => {
    const relay = new FakeRelay();
    const cloud = new FakeCloud({ fetch: relay.fetch });
    h = setupBridge({ relay, cloud });
    const client = new RelayClient({
      cloud, fetch: relay.fetch, appVersion: 'x', hooks: h.bridge.runtime, logger: h.core.logger,
      budget: () => h.bridge.runtime.budget, abortSignal: () => h.bridge.runtime.signal, maxResponseBytes: 64,
    });
    relay.injectOnce({}, { kind: 'raw', status: 200, body: '{}', headers: { 'content-length': '999999' } });
    const declared = await caught(client.listConnections());
    expect([declared.kind, declared.code]).toEqual(['bad_response', 'response_too_large']);
    relay.injectOnce({}, { kind: 'raw', status: 200, body: JSON.stringify({ connections: [], pad: 'x'.repeat(200) }) });
    const actual = await caught(client.listConnections());
    expect([actual.kind, actual.code]).toEqual(['bad_response', 'response_too_large']);
  });

  it('postOutbound reports 201 vs 200 duplicate', async () => {
    h = setupBridge();
    const { connectionId } = await h.bridge.relay.createConnection({ transport: 'relay-mcp' });
    const env = { envelope: { id: 'msg-1', kind: 'text' as const, body: 'hello', links: [] } };
    const first = await h.bridge.relay.postOutbound(connectionId, env);
    const second = await h.bridge.relay.postOutbound(connectionId, env);
    expect(first).toEqual({ relaySeq: 1, duplicate: false, status: 201 });
    expect(second).toEqual({ relaySeq: 1, duplicate: true, status: 200 });
  });

  it('budget: 21st immediate request waits for refill; high priority jumps the queue', async () => {
    h = setupBridge();
    const { connectionId } = await h.bridge.relay.createConnection({ transport: 'relay-mcp' });
    const burst = Array.from({ length: 19 }, () => h.bridge.relay.listConnections());
    await Promise.all(burst);
    expect(h.relay.requests).toHaveLength(20);
    const normal = h.bridge.relay.listConnections();
    const high = h.bridge.relay.postOutbound(connectionId, { envelope: { id: 'm-high', kind: 'text', body: 'x', links: [] } });
    await vi.advanceTimersByTimeAsync(599);
    expect(h.relay.requests).toHaveLength(20);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.relay.requests).toHaveLength(21);
    expect(h.relay.requests[20].method).toBe('POST');
    await vi.advanceTimersByTimeAsync(600);
    await Promise.all([normal, high]);
    expect(h.relay.requests[21].method).toBe('GET');
  });

  it('token, relay-http tokens and pairing codes never appear in errors, logs or captures', async () => {
    h = setupBridge();
    const errors: unknown[] = [];
    const attempt = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        errors.push(e);
      }
    };
    const leak = `cbh_${'z'.repeat(40)} AMBER-RIVER-1234 cbd_${'q'.repeat(43)}`;
    const { connectionId } = await h.bridge.relay.createConnection({ transport: 'relay-http' });
    const malformed = [
      JSON.stringify({ connectionId: 5, pairingCode: 'AMBER-RIVER-1234', token: `cbh_${'z'.repeat(40)}` }),
      `{"connectionId":"c_x","pairingCode":"AMBER-RIVER-1234","token":"cbh_${'z'.repeat(40)}"} trailing`,
      `{"connectionId":"c_x","pairingCode":"AMBER-RIVER-1234","token":"cbh_${'z'.repeat(10)}`,
    ];
    for (const body of malformed) {
      h.relay.injectOnce({ method: 'POST', path: /^\/connections$/ }, { kind: 'raw', status: 201, body });
      await attempt(h.bridge.relay.createConnection({ transport: 'relay-http' }));
      h.relay.injectOnce({ path: /repair/ }, { kind: 'raw', status: 200, body });
      await attempt(h.bridge.relay.repair(connectionId));
    }
    h.relay.injectOnce({}, { kind: 'raw', status: 400, body: JSON.stringify({ error: leak, details: { field: leak } }) });
    await attempt(h.bridge.relay.listConnections());
    h.relay.injectOnce({}, { kind: 'raw', status: 418, body: leak });
    await attempt(h.bridge.relay.listConnections());
    h.relay.injectOnce({}, { kind: 'network' });
    await attempt(h.bridge.relay.listConnections());
    h.relay.revokedDevice = true;
    await attempt(h.bridge.relay.listConnections());
    expect(errors.length).toBeGreaterThanOrEqual(9);
    for (const e of errors) expect(dump(e)).not.toMatch(SECRET_RE);
    for (const l of h.core.logger.entries) expect(dump(l)).not.toMatch(SECRET_RE);
    expect(h.core.captures.length).toBeGreaterThan(0);
    for (const c of h.core.captures) expect(`${dump(c.err)} ${dump(c.tags)} ${c.seam}`).not.toMatch(SECRET_RE);
  });

  it('unsafe origin refused; a loopback http origin is allowed', async () => {
    h = setupBridge();
    h.cloud.device = fakeDevice({ origin: 'http://example.com' });
    const e = await caught(h.bridge.relay.listConnections());
    expect([e.kind, e.code]).toEqual(['invalid_request', 'unsafe_origin']);
    expect(h.relay.requests).toHaveLength(0);
    expect(h.core.captures.some((c) => c.tags?.relayCode === 'unsafe_origin')).toBe(true);
    h.bridge.dispose();

    const relay = new FakeRelay({ origin: 'http://localhost:8787' });
    const cloud = new FakeCloud({ fetch: relay.fetch, device: fakeDevice({ origin: 'http://localhost:8787' }) });
    h = setupBridge({ relay, cloud });
    await h.bridge.relay.listConnections();
    expect(relay.requests[0].url.startsWith('http://localhost:8787/bridge/v1/connections')).toBe(true);
  });
});
