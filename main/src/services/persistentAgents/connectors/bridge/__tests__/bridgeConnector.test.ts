import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboundMessage, ConnectionHandle } from '../../../connectorContract';
import { ConnectorError } from '../../../connectorErrors';
import { parseBridgeRemote } from '../bridgeRemote';
import { BRIDGE_COPY } from '../copy';
import { BRIDGE_PROBE_TEXT } from '../constants';
import { fakeDevice, FakeCloud } from './fakeCloud';
import {
  connectAgent,
  connectRequest,
  FakeCore,
  opts,
  setupBridge,
  type BridgeHarness,
} from './fakeCore';
import { FakeRelay } from './fakeRelay';

const SECRET_RE = /cbd_|cbh_|\b[A-Za-z]{3,8}-[A-Za-z]{3,8}-\d{4}\b/;
const ch = (code: number): string => String.fromCharCode(code);

let harnesses: BridgeHarness[] = [];

function make(o: Parameters<typeof setupBridge>[0] = {}): BridgeHarness {
  const h = setupBridge(o);
  harnesses.push(h);
  return h;
}

function msg(id: string, over: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    id, kind: 'text', body: 'hello', links: [], contentHash: 'h', isProbe: false, createdAt: new Date().toISOString(), ...over,
  };
}

async function rejection(p: Promise<unknown>): Promise<ConnectorError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ConnectorError) return e;
    throw e;
  }
  throw new Error('expected a ConnectorError');
}

function dump(v: unknown): string {
  if (v instanceof Error) {
    const props: Record<string, unknown> = {};
    for (const k of Object.getOwnPropertyNames(v)) props[k] = (v as unknown as Record<string, unknown>)[k];
    return `${String(v)} ${JSON.stringify(props)} ${v.cause !== undefined ? dump(v.cause) : ''}`;
  }
  return JSON.stringify(v) ?? String(v);
}

function ackBodies(relay: FakeRelay): Array<{ epoch: number; upTo: number }> {
  return relay.requests.filter((r) => r.path.endsWith('/ack')).map((r) => r.body as { epoch: number; upTo: number });
}

beforeEach(() => {
  vi.useFakeTimers();
  harnesses = [];
});

afterEach(() => {
  for (const h of harnesses) h.bridge.dispose();
  vi.useRealTimers();
});

describe('BridgeConnector: connect', () => {
  it('connect relay-mcp returns the pairing payload once and outcome.remote holds no code/token/brief', async () => {
    const h = make();
    const t0 = Date.now();
    const outcome = await h.connector.connect(connectRequest('relay-mcp', { connectionId: 'conn_1' }), opts());
    const post = h.relay.requests[0];
    expect(post.body).toEqual({ transport: 'relay-mcp', label: 'Scout' });
    expect(outcome.pairing).toEqual({
      kind: 'bridge', connectionId: 'conn_1', transport: 'relay-mcp',
      mcpUrl: `https://bridge.test/mcp/${outcome.remoteId}`, httpBase: `https://bridge.test/c/${outcome.remoteId}`,
      pairingCode: h.relay.pairingCodeOf(outcome.remoteId),
      pairingExpiresAt: new Date(t0 + 600_000 - 5_000).toISOString(),
      oneTimeToken: null, instructionBrief: null,
    });
    expect(outcome.facts).toEqual([{ key: 'pairing-issued', label: 'Pairing code issued', at: new Date(t0).toISOString(), status: 'done' }]);
    expect(outcome.inboundCursor).toBeNull();
    expect(outcome.relayEpoch).toBeNull();
    const stored = JSON.stringify(outcome.remote);
    expect(stored).not.toContain(h.relay.pairingCodeOf(outcome.remoteId));
    expect(stored).not.toMatch(SECRET_RE);
    expect(parseBridgeRemote(outcome.remote)).toMatchObject({ relayConnectionId: outcome.remoteId, origin: 'https://cloud.test', accountId: 'acct_1' });
    expect('getPairingInfo' in h.connector).toBe(false);
  });

  it('connect relay-http returns a one-time token and instruction brief', async () => {
    const h = make();
    const outcome = await h.connector.connect(connectRequest('relay-http', { handle: 'scout' }), opts());
    const p = outcome.pairing;
    expect(p?.pairingCode).toBeNull();
    expect(p?.pairingExpiresAt).toBeNull();
    expect(p?.oneTimeToken).toMatch(/^cbh_/);
    expect(p?.instructionBrief).toContain(p?.httpBase);
    expect(p?.instructionBrief).toContain(p?.oneTimeToken ?? 'missing');
    expect(p?.instructionBrief).toContain('cf/scout/');
    expect(outcome.facts[0]).toMatchObject({ key: 'token-issued', label: 'Token issued', status: 'done' });
    expect(JSON.stringify(outcome.remote)).not.toMatch(/cbh_/);
  });

  it('label sanitized (control chars stripped, 100 chars)', async () => {
    const h = make();
    await h.connector.connect(connectRequest('relay-mcp', { displayName: `Sc${ch(7)}out${ch(10)}${'x'.repeat(150)}` }), opts());
    const label = (h.relay.requests[0].body as { label: string }).label;
    expect(label).toHaveLength(100);
    expect(label.startsWith('Scoutxx')).toBe(true);
  });

  it('connection_limit → conflict with copy', async () => {
    const h = make();
    const twenty = (async () => {
      for (let i = 0; i < 20; i += 1) await h.connector.connect(connectRequest('relay-mcp'), opts());
    })();
    await vi.advanceTimersByTimeAsync(5_000);
    await twenty;
    expect(h.relay.connectionCount()).toBe(20);
    const e = await rejection(h.connector.connect(connectRequest('relay-mcp'), opts()));
    expect([e.kind, e.code, e.message]).toEqual(['conflict', 'connection_limit', BRIDGE_COPY.connection_limit]);
  });

  it('connection_init_failed retried once', async () => {
    const h = make();
    h.relay.injectOnce({ method: 'POST', path: /^\/connections$/ }, { kind: 'http', status: 503, error: 'connection_init_failed' });
    await h.connector.connect(connectRequest('relay-mcp'), opts());
    expect(h.relay.count(/^\/connections$/, 'POST')).toBe(2);
    h.relay.injectAlways({ method: 'POST', path: /^\/connections$/ }, { kind: 'http', status: 503, error: 'connection_init_failed' });
    const e = await rejection(h.connector.connect(connectRequest('relay-mcp'), opts()));
    expect([e.kind, e.code]).toEqual(['retryable', 'connection_init_failed']);
    expect(h.relay.count(/^\/connections$/, 'POST')).toBe(4);
  });

  it('rollbackConnect revokes best-effort and never throws', async () => {
    const h = make();
    const req = connectRequest('relay-mcp');
    const outcome = await h.connector.connect(req, opts());
    await h.connector.rollbackConnect(req, outcome, opts());
    expect(h.relay.count(/revoke$/, 'POST')).toBe(1);
    const second = await h.connector.connect(req, opts());
    h.relay.injectOnce({ path: /revoke$/ }, { kind: 'network' });
    await expect(h.connector.rollbackConnect(req, second, opts())).resolves.toBeUndefined();
    await expect(h.connector.rollbackConnect(req, { ...second, remote: {}, remoteId: '' }, opts())).resolves.toBeUndefined();
  });
});

describe('BridgeConnector: drain and acknowledge', () => {
  it('multi-page drain: 250 messages → pulls 100/100/50, acks 100/200/250, all after commit', async () => {
    const h = make();
    const { row, relayId } = await connectAgent(h);
    for (let i = 0; i < 250; i += 1) h.relay.vendorSend(relayId, { body: `m${i}` });
    const res = await h.core.drain(h.connector, row.connectionId);
    expect(res.pages).toBe(3);
    expect(h.core.messagesFor(row.connectionId)).toHaveLength(250);
    expect(ackBodies(h.relay).map((b) => b.upTo)).toEqual([100, 200, 250]);
    expect(h.core.trace).toEqual(['apply:100', 'ack', 'apply:100', 'ack', 'apply:50', 'ack']);
    expect(h.relay.inboundRows(relayId)).toEqual([]);
    expect(h.core.row(row.connectionId).inboundCursor).toBe(`bridge:v1:${h.relay.epochOf(relayId)}:250`);
  });

  it('pull never acks by itself', async () => {
    const h = make();
    const { row, relayId } = await connectAgent(h);
    h.relay.vendorSend(relayId, { body: 'x' });
    await h.connector.pull(h.core.handle(row.connectionId), null, opts());
    expect(ackBodies(h.relay)).toEqual([]);
  });

  it('no ack when apply fails; the next drain re-serves and stores each message once', async () => {
    const h = make();
    const { row, relayId } = await connectAgent(h);
    for (let i = 0; i < 5; i += 1) h.relay.vendorSend(relayId, { body: `m${i}` });
    h.core.failNextApply = true;
    await expect(h.core.drain(h.connector, row.connectionId)).rejects.toThrow('simulated apply failure');
    expect(ackBodies(h.relay)).toEqual([]);
    await h.core.drain(h.connector, row.connectionId);
    expect(h.core.messagesFor(row.connectionId)).toHaveLength(5);
    expect(h.relay.inboundRows(relayId)).toEqual([]);
  });

  it('restart between commit and ack re-acks the cursor', async () => {
    const relay = new FakeRelay();
    const cloud = new FakeCloud({ fetch: relay.fetch });
    const core = new FakeCore(cloud);
    const h = make({ relay, cloud, core });
    const { row, relayId } = await connectAgent(h);
    for (let i = 0; i < 5; i += 1) relay.vendorSend(relayId, { body: `m${i}` });
    relay.injectOnce({ path: /\/ack$/ }, { kind: 'network' });
    await core.drain(h.connector, row.connectionId);
    expect(relay.inboundRows(relayId)).toHaveLength(5);
    h.bridge.dispose();
    const h2 = make({ relay, cloud, core });
    const acksBefore = ackBodies(relay).length;
    await core.drain(h2.connector, row.connectionId);
    const acks = ackBodies(relay).slice(acksBefore);
    expect(acks).toEqual([{ epoch: relay.epochOf(relayId), upTo: 5 }]);
    expect(relay.inboundRows(relayId)).toEqual([]);
    expect(core.messagesFor(row.connectionId)).toHaveLength(5);
  });

  it('a repeat drain with nothing new does not re-ack within one run', async () => {
    const h = make();
    const { row, relayId } = await connectAgent(h);
    h.relay.vendorSend(relayId, { body: 'x' });
    await h.core.drain(h.connector, row.connectionId);
    await h.core.drain(h.connector, row.connectionId);
    expect(ackBodies(h.relay)).toHaveLength(1);
  });

  it('epoch change (fence) re-drains from 0 and dedupes', async () => {
    const h = make();
    const { row, relayId } = await connectAgent(h);
    for (let i = 0; i < 50; i += 1) h.relay.vendorSend(relayId, { body: `m${i}` });
    h.relay.injectAlways({ path: /\/ack$/ }, { kind: 'network' });
    await h.core.drain(h.connector, row.connectionId);
    const e1 = h.relay.epochOf(relayId);
    expect(h.core.row(row.connectionId).inboundCursor).toBe(`bridge:v1:${e1}:50`);
    h.relay.clearFaults();
    h.relay.fence(relayId);
    const e2 = h.relay.epochOf(relayId);
    await h.core.drain(h.connector, row.connectionId);
    expect(h.core.messagesFor(row.connectionId)).toHaveLength(50);
    const lastAck = ackBodies(h.relay).at(-1);
    expect(lastAck).toEqual({ epoch: e2, upTo: 50 });
    expect(h.core.row(row.connectionId).relayEpoch).toBe(e2);
    expect(h.relay.inboundRows(relayId)).toEqual([]);
  });

  it('stale_epoch on ack is swallowed and healed by the next pull', async () => {
    const h = make();
    const { row, relayId } = await connectAgent(h);
    for (let i = 0; i < 3; i += 1) h.relay.vendorSend(relayId, { body: `m${i}` });
    const handle = h.core.handle(row.connectionId);
    const batch = await h.connector.pull(handle, handle.inboundCursor, opts());
    h.core.applyInboundBatch(row.connectionId, batch);
    h.relay.fence(relayId);
    await expect(h.connector.acknowledge(h.core.handle(row.connectionId), batch.ackToken ?? '', opts())).resolves.toBeUndefined();
    expect(h.relay.requests.at(-1)?.status).toBe(409);
    await h.core.drain(h.connector, row.connectionId);
    expect(h.core.messagesFor(row.connectionId)).toHaveLength(3);
    expect(h.relay.inboundRows(relayId)).toEqual([]);
  });

  it('ack_beyond_served sets an after-override and heals', async () => {
    const h = make();
    const { row, relayId } = await connectAgent(h);
    for (let i = 0; i < 50; i += 1) h.relay.vendorSend(relayId, { body: `m${i}` });
    h.relay.injectOnce({ path: /\/ack$/ }, { kind: 'http', status: 409, error: 'ack_beyond_served', details: { maxServed: 40 } });
    await h.core.drain(h.connector, row.connectionId);
    expect(h.core.captures.some((c) => c.seam === 'relay-drain' && c.tags?.relayCode === 'ack_beyond_served')).toBe(true);
    await h.core.drain(h.connector, row.connectionId);
    const pulls = h.relay.requests.filter((r) => r.path.includes('/inbound'));
    expect(pulls.at(-1)?.path).toContain('after=40');
    expect(h.core.messagesFor(row.connectionId)).toHaveLength(50);
    expect(ackBodies(h.relay).at(-1)?.upTo).toBe(50);
    expect(h.relay.inboundRows(relayId)).toEqual([]);
  });

  it('gap note inserted once even when re-reported (first ack network-fails)', async () => {
    const h = make();
    const { row, relayId } = await connectAgent(h);
    for (let i = 0; i < 10; i += 1) h.relay.vendorSend(relayId, { body: `m${i}` });
    h.relay.expireInbound(relayId, 5);
    h.relay.injectOnce({ path: /\/ack$/ }, { kind: 'network' });
    await h.core.drain(h.connector, row.connectionId);
    const gapNotes = () => h.core.messagesFor(row.connectionId).filter((m) => m.remoteEventId.startsWith('gap:'));
    expect(gapNotes()).toHaveLength(1);
    expect(gapNotes()[0]).toMatchObject({ author: 'local', kind: 'system', direction: 'local', remoteEventId: `gap:${h.relay.epochOf(relayId)}:5` });
    // The relay re-reports the gap to a re-read of the same epoch from 0 (a lost cursor).
    const again = await h.connector.pull(h.core.handle(row.connectionId), null, opts());
    expect(again.messages.some((m) => m.remoteEventId.startsWith('gap:'))).toBe(true);
    h.core.applyInboundBatch(row.connectionId, again);
    expect(gapNotes()).toHaveLength(1);
    expect(h.core.messagesFor(row.connectionId).filter((m) => m.direction === 'in')).toHaveLength(5);
    await h.core.drain(h.connector, row.connectionId);
    expect(h.relay.inboundRows(relayId)).toEqual([]);
  });

  it('Picked up survives restart', async () => {
    const relay = new FakeRelay();
    const cloud = new FakeCloud({ fetch: relay.fetch });
    const core = new FakeCore(cloud);
    const h = make({ relay, cloud, core });
    const { row, relayId } = await connectAgent(h);
    await h.connector.send(core.handle(row.connectionId), msg('m1'), opts());
    core.addOutbound('m1', row.connectionId);
    relay.vendorReadOutbox(relayId);
    h.bridge.dispose();
    const h2 = make({ relay, cloud, core });
    await core.drain(h2.connector, row.connectionId);
    expect(core.outbound.get('m1')?.pickedUpAt).not.toBeNull();
    expect(core.row(row.connectionId).remote.firstPickupAt).toEqual(expect.any(String));
  });

  it('drains after 2 days offline with nothing lost', async () => {
    const h = make();
    const { row, relayId } = await connectAgent(h);
    await vi.advanceTimersByTimeAsync(48 * 3_600_000);
    for (let i = 0; i < 500; i += 1) h.relay.vendorSend(relayId, { body: `m${i}` });
    await h.core.drain(h.connector, row.connectionId);
    expect(h.core.messagesFor(row.connectionId)).toHaveLength(500);
    expect(h.relay.inboundRows(relayId)).toEqual([]);
  });

  it('round trip verifies only after a pickup and a later agent reply', async () => {
    const h = make();
    const { row, relayId } = await connectAgent(h);
    h.relay.vendorSend(relayId, { body: 'hello first' });
    await h.core.drain(h.connector, row.connectionId);
    expect(h.core.row(row.connectionId).state).toBe('pending');
    await h.connector.send(h.core.handle(row.connectionId), msg('probe-1'), opts());
    h.relay.vendorReadOutbox(relayId);
    await vi.advanceTimersByTimeAsync(1000);
    h.relay.vendorSend(relayId, { body: 'reply' });
    await h.core.drain(h.connector, row.connectionId);
    expect(h.core.row(row.connectionId).state).toBe('verified');
  });
});

describe('BridgeConnector: send and reconcile', () => {
  it('send posts envelope id = message id and is idempotent', async () => {
    const h = make();
    const { row } = await connectAgent(h);
    const handle = h.core.handle(row.connectionId);
    const m = msg('2b7f6c1e-4a1d-4c9e-9f53-0d6c9a3c1a11', { links: ['https://x.test/1'] });
    const first = await h.connector.send(handle, m, opts());
    const post = h.relay.requests.at(-1);
    expect(post?.body).toEqual({ envelope: { id: m.id, kind: 'text', body: 'hello', links: ['https://x.test/1'] } });
    const second = await h.connector.send(handle, m, opts());
    expect(first).toMatchObject({ state: 'on_bridge', remoteEventId: m.id, remoteOutSeq: 1, duplicate: false });
    expect(second).toMatchObject({ state: 'on_bridge', remoteEventId: m.id, remoteOutSeq: 1, duplicate: true });
    expect(typeof first.acceptedAt).toBe('string');
  });

  it('send validation without network', async () => {
    const h = make();
    const { row } = await connectAgent(h);
    const handle = h.core.handle(row.connectionId);
    const n = h.relay.requests.length;
    const cases: Array<[OutboundMessage, string]> = [
      [msg('big', { body: 'x'.repeat(65_537) }), 'message_too_large'],
      [msg('rcpt:x'), 'invalid_message_id'],
      [msg('sys:x'), 'invalid_message_id'],
      [msg('bad id with spaces'), 'invalid_message_id'],
      [msg('links', { links: Array.from({ length: 21 }, (_, i) => `https://x.test/${i}`) }), 'invalid_links'],
      [msg('jslink', { links: ['javascript:alert(1)'] }), 'invalid_links'],
      [msg('kind', { kind: 'system' as unknown as 'text' }), 'unsupported_kind'],
    ];
    for (const [m, code] of cases) {
      const e = await rejection(h.connector.send(handle, m, opts()));
      expect([e.kind, e.code]).toEqual(['invalid', code]);
    }
    expect(h.relay.requests.length).toBe(n);
  });

  it('send error kinds', async () => {
    const run = async (setup: (h: BridgeHarness, relayId: string) => void) => {
      const h = make();
      const { row, relayId } = await connectAgent(h);
      setup(h, relayId);
      const e = await rejection(h.connector.send(h.core.handle(row.connectionId), msg(`m-${Math.random().toString(36).slice(2)}`), opts()));
      return { e, h };
    };
    const unavailable = await run((h) => h.relay.injectOnce({ path: /outbound/ }, { kind: 'http', status: 503, error: 'accounts_unavailable', retryAfterSec: 5 }));
    expect([unavailable.e.kind, unavailable.e.retryAfterMs, unavailable.e.maybeDelivered]).toEqual(['retryable', 5000, false]);
    const update = await run((h) => { h.relay.protocolRange = { min: 2, max: 2 }; });
    expect([update.e.kind, update.e.code]).toEqual(['upgrade_required', 'needs_update']);
    const revoked = await run((h) => { h.relay.revokedDevice = true; });
    expect([revoked.e.kind, revoked.e.code]).toEqual(['device_auth', 'needs_sign_in']);
    expect(revoked.h.cloud.markRevokedCalls).toEqual(['device_revoked']);
    const gone = await run((h, id) => h.relay.revokeServerSide(id));
    expect([gone.e.kind, gone.e.code]).toEqual(['revoked', 'relay_revoked']);
    const notFound = await run((h) => h.relay.injectOnce({ path: /outbound/ }, { kind: 'http', status: 404, error: 'not_found' }));
    expect([notFound.e.kind, notFound.e.code]).toEqual(['not_found', 'relay_not_found']);
    const tooLarge = await run((h) => h.relay.injectOnce({ path: /outbound/ }, { kind: 'http', status: 413, error: 'payload_too_large' }));
    expect([tooLarge.e.kind, tooLarge.e.code]).toEqual(['invalid', 'message_too_large']);
    const limited = await run((h) => h.relay.injectOnce({ path: /outbound/ }, { kind: 'http', status: 429, error: 'rate_limited', retryAfterSec: 9 }));
    expect([limited.e.kind, limited.e.retryAfterMs]).toEqual(['rate_limited', 9000]);
    const entitled = await run((h) => { h.relay.entitled = false; });
    expect([entitled.e.kind, entitled.e.code]).toEqual(['not_entitled', 'not_entitled']);
    const odd = await run((h) => h.relay.injectOnce({ path: /outbound/ }, { kind: 'http', status: 418, error: 'Teapot!' }));
    expect([odd.e.kind, odd.e.code]).toEqual(['permanent', 'relay_418_http_418']);
  });

  it('send network error → maybeDelivered true; 503 → false', async () => {
    const h = make();
    const { row } = await connectAgent(h);
    const handle = h.core.handle(row.connectionId);
    h.relay.injectOnce({ path: /outbound/ }, { kind: 'network' });
    const net = await rejection(h.connector.send(handle, msg('m-net'), opts()));
    expect([net.kind, net.maybeDelivered]).toEqual(['retryable', true]);
    h.relay.injectOnce({ path: /outbound/ }, { kind: 'drop_response' });
    const dropped = await rejection(h.connector.send(handle, msg('m-drop'), opts()));
    expect(dropped.maybeDelivered).toBe(true);
    expect(h.relay.outboundRows(row.remoteId ?? '').map((e) => e.id)).toContain('m-drop');
    h.relay.injectOnce({ path: /outbound/ }, { kind: 'http', status: 503, error: 'relay_disabled', retryAfterSec: 2 });
    const unavailable = await rejection(h.connector.send(handle, msg('m-503'), opts()));
    expect([unavailable.kind, unavailable.maybeDelivered]).toEqual(['retryable', false]);
  });

  it('reconcile re-POSTs and reports found (201 and 200 duplicate)', async () => {
    const h = make();
    const { row } = await connectAgent(h);
    const handle = h.core.handle(row.connectionId);
    await h.connector.send(handle, msg('a1'), opts());
    const items = ['a1', 'a2'].map((id) => ({ messageId: id, contentHash: 'h', createdAt: new Date().toISOString(), body: 'hello', links: [], kind: 'text' as const }));
    const res = await h.connector.reconcile(handle, [...items, { ...items[0], messageId: 'big', body: 'x'.repeat(70_000) }], new Date(0).toISOString(), opts());
    expect(res.map((r) => [r.messageId, r.outcome])).toEqual([['a1', 'found'], ['a2', 'found'], ['big', 'not_found']]);
    expect(res[0]).toMatchObject({ receipt: { duplicate: true, remoteOutSeq: 1 } });
    expect(res[1]).toMatchObject({ receipt: { duplicate: false, remoteOutSeq: 2 } });
    h.relay.injectOnce({ path: /outbound/ }, { kind: 'http', status: 500, error: 'internal_error' });
    await expect(h.connector.reconcile(handle, items, new Date(0).toISOString(), opts())).rejects.toMatchObject({ kind: 'retryable' });
  });

  it('reconcile throws an unexpected 4xx instead of reporting not_found', async () => {
    const h = make();
    const { row } = await connectAgent(h);
    const handle = h.core.handle(row.connectionId);
    const items = [{ messageId: 'u1', contentHash: 'h', createdAt: new Date().toISOString(), body: 'hello', links: [], kind: 'text' as const }];
    h.relay.injectOnce({ path: /outbound/ }, { kind: 'http', status: 409, error: 'something_else' });
    await expect(h.connector.reconcile(handle, items, new Date(0).toISOString(), opts())).rejects.toMatchObject({ kind: 'permanent' });
  });
});

describe('BridgeConnector: disconnect and repair', () => {
  it('disconnect: 200 resolves; revoke_pending x2 then 200 after waits; x3 → retryable 5000; 404 resolves; other account → paused, no request', async () => {
    const h = make();
    const a = await connectAgent(h, 'relay-mcp', { connectionId: 'a' });
    await h.connector.disconnect(h.core.handle('a'), opts());
    expect(h.relay.count(/revoke$/)).toBe(1);

    const b = await connectAgent(h, 'relay-mcp', { connectionId: 'b' });
    h.relay.revokePendingTimes(b.relayId, 2);
    let done = false;
    const p = h.connector.disconnect(h.core.handle('b'), opts()).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(h.relay.count(new RegExp(`${b.relayId}/revoke$`))).toBe(3);

    const c = await connectAgent(h, 'relay-mcp', { connectionId: 'c' });
    h.relay.revokePendingTimes(c.relayId, 3);
    const pending = rejection(h.connector.disconnect(h.core.handle('c'), opts()));
    await vi.advanceTimersByTimeAsync(10_000);
    const e = await pending;
    expect([e.kind, e.code, e.retryAfterMs]).toEqual(['retryable', 'revoke_pending', 5000]);

    const d = await connectAgent(h, 'relay-mcp', { connectionId: 'd' });
    h.relay.injectOnce({ path: new RegExp(`${d.relayId}/revoke$`) }, { kind: 'http', status: 404, error: 'not_found' });
    await expect(h.connector.disconnect(h.core.handle('d'), opts())).resolves.toBeUndefined();

    await connectAgent(h, 'relay-mcp', { connectionId: 'e' });
    h.cloud.device = fakeDevice({ accountId: 'acct_2' });
    const n = h.relay.requests.length;
    const other = await rejection(h.connector.disconnect(h.core.handle('e'), opts()));
    expect([other.kind, other.code]).toEqual(['paused', 'other_account']);
    expect(h.relay.requests.length).toBe(n);
    expect(a.relayId).not.toBe(b.relayId);
  });

  it('swap disconnect returns within 10 s on revoke_pending', async () => {
    const h = make();
    const { row, relayId } = await connectAgent(h);
    h.relay.revokePendingTimes(relayId, 1000);
    const c = new AbortController();
    setTimeout(() => c.abort(), 10_000);
    const before = h.relay.count(/revoke$/);
    let settledAt = -1;
    const t0 = Date.now();
    const p = rejection(h.connector.disconnect(h.core.handle(row.connectionId), { signal: c.signal }))
      .finally(() => { settledAt = Date.now() - t0; });
    await vi.advanceTimersByTimeAsync(10_000);
    const e = await p;
    expect([e.kind, e.code]).toEqual(['retryable', 'revoke_pending']);
    expect(settledAt).toBeLessThanOrEqual(10_000);
    expect(h.relay.count(/revoke$/) - before).toBeLessThanOrEqual(3);
  });

  it('repairPairing returns a new epoch cursor and code, clears pairing fields and in-memory ack state', async () => {
    const h = make();
    const { row, relayId, outcome } = await connectAgent(h);
    h.relay.vendorSend(relayId, { body: 'x' });
    await h.core.drain(h.connector, row.connectionId);
    const lastToken = `bridge-ack:v1:${h.relay.epochOf(relayId)}:1`;
    const acks = () => ackBodies(h.relay).length;
    const before = acks();
    await h.connector.acknowledge(h.core.handle(row.connectionId), lastToken, opts());
    expect(acks()).toBe(before);
    const oldCode = outcome.pairing?.pairingCode;
    const repaired = await h.connector.repairPairing(h.core.handle(row.connectionId), opts());
    const epoch = h.relay.epochOf(relayId);
    expect(repaired.relayEpoch).toBe(epoch);
    expect(repaired.inboundCursor).toBe(`bridge:v1:${epoch}:0`);
    expect(repaired.pairing.pairingCode).not.toBe(oldCode);
    expect(repaired.pairing.pairingCode).toBe(h.relay.pairingCodeOf(relayId));
    expect(repaired.pairing.mcpUrl).toBe(outcome.pairing?.mcpUrl);
    expect(repaired.remotePatch).toEqual({ pairedClient: null, pairCalledAt: null, firstPickupAt: null, pairingIssuedAt: new Date().toISOString() });
    await h.connector.acknowledge(h.core.handle(row.connectionId), lastToken, opts());
    expect(acks()).toBe(before + 1);
  });

  it('repair on a revoked connection → revoked (connection gone)', async () => {
    const h = make();
    const { row, relayId } = await connectAgent(h);
    h.relay.revokeServerSide(relayId);
    const e = await rejection(h.connector.repairPairing(h.core.handle(row.connectionId), opts()));
    expect([e.kind, e.code]).toEqual(['revoked', 'relay_revoked']);
  });

  it('repair racing a committed old-epoch batch self-heals', async () => {
    const h = make();
    const { row, relayId } = await connectAgent(h);
    await h.core.drain(h.connector, row.connectionId);
    for (let i = 0; i < 5; i += 1) h.relay.vendorSend(relayId, { body: `m${i}` });
    const stale = h.core.handle(row.connectionId);
    const oldBatch = await h.connector.pull(stale, stale.inboundCursor, opts());
    const repaired = await h.connector.repairPairing(h.core.handle(row.connectionId), opts());
    h.core.applyRepair(row.connectionId, repaired);
    const res = h.core.applyInboundBatch(row.connectionId, oldBatch, { expectedRelayEpoch: stale.relayEpoch });
    expect(res.fenced).toBe(true);
    expect(h.core.row(row.connectionId).inboundCursor).toBe(repaired.inboundCursor);
    await h.core.drain(h.connector, row.connectionId);
    expect(h.core.messagesFor(row.connectionId)).toHaveLength(5);
    expect(ackBodies(h.relay).at(-1)).toEqual({ epoch: h.relay.epochOf(relayId), upTo: 5 });
    expect(h.relay.inboundRows(relayId)).toEqual([]);
  });

  it('per-connection serialization: concurrent pull and repairPairing never overlap', async () => {
    const relay = new FakeRelay();
    let inflight = 0;
    let maxInflight = 0;
    const slow = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const tracked = /\/(inbound|repair)/.test(url);
      if (tracked) {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 50));
      }
      try {
        return await relay.fetch(input, init);
      } finally {
        if (tracked) inflight -= 1;
      }
    }) as typeof fetch;
    const h = make({ relay, fetch: slow });
    const { row } = await connectAgent(h);
    const handle = h.core.handle(row.connectionId);
    const all = Promise.all([
      h.connector.pull(handle, null, opts()),
      h.connector.repairPairing(handle, opts()),
      h.connector.pull(handle, null, opts()),
    ]);
    await vi.advanceTimersByTimeAsync(500);
    await all;
    expect(maxInflight).toBe(1);
  });

  it('per-connection serialization survives a waiter that aborts while queued', async () => {
    const relay = new FakeRelay();
    const log: string[] = [];
    const slow = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const kind = /\/repair/.test(url) ? 'repair' : /\/inbound/.test(url) ? 'pull' : null;
      if (kind) {
        log.push(`${kind}:start`);
        if (kind === 'repair') await new Promise((r) => setTimeout(r, 200));
      }
      try {
        return await relay.fetch(input, init);
      } finally {
        if (kind) log.push(`${kind}:end`);
      }
    }) as typeof fetch;
    const h = make({ relay, fetch: slow });
    const { row } = await connectAgent(h);
    const handle = h.core.handle(row.connectionId);
    const holder = h.connector.repairPairing(handle, opts());
    await vi.advanceTimersByTimeAsync(10);
    const waiterAbort = new AbortController();
    const waiter = rejection(h.connector.pull(handle, null, opts(waiterAbort.signal)));
    await vi.advanceTimersByTimeAsync(10);
    waiterAbort.abort();
    expect((await waiter).code).toBe('timeout');
    const next = h.connector.pull(handle, null, opts());
    await vi.advanceTimersByTimeAsync(50);
    expect(log).toEqual(['repair:start']);
    await vi.advanceTimersByTimeAsync(500);
    await holder;
    await next;
    expect(log).toEqual(['repair:start', 'repair:end', 'pull:start', 'pull:end']);
  });
});

describe('BridgeConnector: verify and facts', () => {
  it('verify facts per state, probe when appropriate, uses h.state for round trip', async () => {
    const h = make();
    const { row, relayId } = await connectAgent(h);
    const v1 = await h.connector.verify(h.core.handle(row.connectionId), opts());
    expect(v1.facts.map((f) => [f.key, f.status])).toEqual([
      ['pairing-issued', 'done'], ['paired', 'waiting'], ['pair-called', 'waiting'], ['picked-up', 'waiting'], ['round-trip', 'waiting'],
    ]);
    expect(v1.facts[1].label).toBe('Waiting for ChatGPT to sign in with the code…');
    expect(v1.probe).toBeUndefined();
    expect(v1.remotePatch).toBeUndefined();

    h.relay.completePairing(relayId, { name: 'ChatGPT', redirectHost: 'chatgpt.com' });
    const v2 = await h.connector.verify(h.core.handle(row.connectionId), opts());
    expect(v2.remotePatch).toEqual({ pairedClient: { name: 'ChatGPT', redirectHost: 'chatgpt.com', pairedAt: Date.now() } });
    expect(v2.facts[1]).toEqual({
      key: 'paired', label: 'Paired with', at: new Date().toISOString(), status: 'done', subject: { name: 'ChatGPT', host: 'chatgpt.com' },
    });
    expect(v2.probe).toEqual({ body: BRIDGE_PROBE_TEXT });
    expect(v2.observed).toBeUndefined();

    await h.core.reportRemotePatch(row.connectionId, v2.remotePatch ?? {});
    h.core.row(row.connectionId).state = 'verified';
    const v3 = await h.connector.verify(h.core.handle(row.connectionId), opts());
    expect(v3.probe).toBeUndefined();
    expect(v3.remotePatch).toBeUndefined();
    expect(v3.facts.at(-1)).toEqual({ key: 'round-trip', label: 'Round trip verified', at: null, status: 'done' });

    const http = await connectAgent(h, 'relay-http', { connectionId: 'http' });
    const v4 = await h.connector.verify(h.core.handle('http'), opts());
    expect(v4.facts.map((f) => [f.key, f.status])).toEqual([
      ['token-issued', 'done'], ['first-call', 'waiting'], ['picked-up', 'waiting'], ['round-trip', 'waiting'],
    ]);
    expect(v4.probe).toEqual({ body: BRIDGE_PROBE_TEXT });
    expect(http.relayId).not.toBe(relayId);
  });

  it('verify: missing from the list → not_found + reportConnectionGone; revoked → relay_revoked', async () => {
    const h = make();
    const { row, relayId } = await connectAgent(h);
    h.relay.revokeServerSide(relayId);
    const e = await rejection(h.connector.verify(h.core.handle(row.connectionId), opts()));
    expect([e.kind, e.code]).toEqual(['revoked', 'relay_revoked']);
    expect(h.core.gone).toEqual([{ connectionId: row.connectionId, reason: 'relay_revoked' }]);

    const other = await connectAgent(h, 'relay-mcp', { connectionId: 'x' });
    h.relay.accountId = 'acct_other_view';
    const missing = await rejection(h.connector.verify(h.core.handle('x'), opts()));
    expect([missing.kind, missing.code]).toEqual(['not_found', 'relay_not_found']);
    expect(h.core.gone.at(-1)).toEqual({ connectionId: 'x', reason: 'relay_not_found' });
    expect(other.relayId).toBeTruthy();
  });

  it('describeFacts per transport (each row waiting and done)', () => {
    const h = make();
    const base = {
      v: 1, origin: 'https://cloud.test', accountId: 'acct_1', relayConnectionId: 'c_x', label: null,
      mcpUrl: 'https://bridge.test/mcp/c_x', httpBase: 'https://bridge.test/c/c_x', relayState: 'active',
    };
    const handle = (remote: Record<string, unknown>, state: ConnectionHandle['state'] = 'pending'): ConnectionHandle => ({
      connectionId: 'f', agentId: 'a', agentHandle: 'scout', agentDisplayName: 'Scout', vendor: 'meta-muse', connectorId: 'bridge',
      connectorVersion: 1, kind: 'bridge', transport: null, state, generation: 1, remoteId: 'c_x', remote, credential: null,
      inboundCursor: null, relayEpoch: null,
    });
    const waitingMcp = h.connector.describeFacts(handle({
      ...base, transport: 'relay-mcp', pairingIssuedAt: 'T0', pairedClient: null, pairCalledAt: null, firstInboundAt: null, firstPickupAt: null,
    }));
    expect(waitingMcp).toEqual([
      { key: 'pairing-issued', label: 'Pairing code issued', at: 'T0', status: 'done' },
      { key: 'paired', label: 'Waiting for Muse to sign in with the code…', at: null, status: 'waiting' },
      { key: 'pair-called', label: 'Waiting for the connector to confirm the pairing…', at: null, status: 'waiting' },
      { key: 'picked-up', label: 'Waiting for it to pick up a message…', at: null, status: 'waiting' },
      { key: 'round-trip', label: 'Waiting for its first reply…', at: null, status: 'waiting' },
    ]);
    const doneMcp = h.connector.describeFacts(handle({
      ...base, transport: 'relay-mcp', pairingIssuedAt: 'T0', pairedClient: { name: `${ch(0x202e)}Muse`, redirectHost: 'muse.test', pairedAt: 1_000 },
      pairCalledAt: 'T2', firstInboundAt: 'T3', firstPickupAt: 'T4',
    }, 'verified'));
    expect(doneMcp).toEqual([
      { key: 'pairing-issued', label: 'Pairing code issued', at: 'T0', status: 'done' },
      { key: 'paired', label: 'Paired with', at: new Date(1_000).toISOString(), status: 'done', subject: { name: 'Muse', host: 'muse.test' } },
      { key: 'pair-called', label: 'Connector confirmed the pairing', at: 'T2', status: 'done' },
      { key: 'picked-up', label: 'Picked up a message', at: 'T4', status: 'done' },
      { key: 'round-trip', label: 'Round trip verified', at: null, status: 'done' },
    ]);
    const waitingHttp = h.connector.describeFacts(handle({
      ...base, transport: 'relay-http', pairingIssuedAt: null, pairedClient: null, pairCalledAt: null, firstInboundAt: null, firstPickupAt: null,
    }));
    expect(waitingHttp).toEqual([
      { key: 'token-issued', label: 'Token issued', at: null, status: 'done' },
      { key: 'first-call', label: 'Waiting for its first call to the mailbox…', at: null, status: 'waiting' },
      { key: 'picked-up', label: 'Waiting for it to pick up a message…', at: null, status: 'waiting' },
      { key: 'round-trip', label: 'Waiting for its first reply…', at: null, status: 'waiting' },
    ]);
    const doneHttp = h.connector.describeFacts(handle({
      ...base, transport: 'relay-http', pairingIssuedAt: 'T0', pairedClient: null, pairCalledAt: null, firstInboundAt: 'T3', firstPickupAt: 'T4',
    }, 'verified'));
    expect(doneHttp.map((f) => [f.key, f.label, f.at, f.status])).toEqual([
      ['token-issued', 'Token issued', 'T0', 'done'],
      ['first-call', 'First call received', 'T3', 'done'],
      ['picked-up', 'Picked up a message', 'T4', 'done'],
      ['round-trip', 'Round trip verified', null, 'done'],
    ]);
    expect(h.connector.describeFacts(handle({ v: 3 }))).toEqual([]);
  });

  it('sys:paired triggers a pairedClient refresh in the same batch', async () => {
    const h = make();
    const { row, relayId } = await connectAgent(h);
    h.relay.completePairing(relayId, { name: 'ChatGPT', redirectHost: 'chatgpt.com' });
    const lists = h.relay.count(/^\/connections$/, 'GET');
    await h.core.drain(h.connector, row.connectionId);
    expect(h.relay.count(/^\/connections$/, 'GET')).toBe(lists + 1);
    expect(h.core.row(row.connectionId).remote.pairedClient).toMatchObject({ name: 'ChatGPT', redirectHost: 'chatgpt.com' });
    h.relay.vendorPair(relayId);
    await h.core.drain(h.connector, row.connectionId);
    expect(h.core.row(row.connectionId).remote.pairCalledAt).toEqual(expect.any(String));
  });

  it('a pairedClient name with U+202E / U+200B / C1 controls is sanitised before remotePatch', async () => {
    const h = make();
    const { row, relayId } = await connectAgent(h);
    h.relay.completePairing(relayId, { name: `${ch(0x202e)}Chat${ch(0x200b)}GPT${ch(0x9b)}`, redirectHost: 'chatgpt.com' });
    const v = await h.connector.verify(h.core.handle(row.connectionId), opts());
    expect(v.remotePatch).toMatchObject({ pairedClient: { name: 'ChatGPT' } });
    await h.core.drain(h.connector, row.connectionId);
    expect(h.core.row(row.connectionId).remote.pairedClient).toMatchObject({ name: 'ChatGPT' });
  });

  it('an invalid redirectHost drops the pairedClient patch', async () => {
    const h = make();
    const { row, relayId } = await connectAgent(h);
    h.relay.completePairing(relayId, { name: 'Evil', redirectHost: 'evil.test/phish path' });
    const v = await h.connector.verify(h.core.handle(row.connectionId), opts());
    expect(v.remotePatch).toBeUndefined();
    await h.core.drain(h.connector, row.connectionId);
    expect(h.core.row(row.connectionId).remote.pairedClient).toBeNull();
  });
});

describe('BridgeConnector: gates and signals', () => {
  it('other-account handle is paused without network (pull, send, verify)', async () => {
    const h = make();
    const { row } = await connectAgent(h);
    h.cloud.signIn(fakeDevice({ accountId: 'acct_2', deviceId: 'dev_2' }));
    const handle = h.core.handle(row.connectionId);
    const n = h.relay.requests.length;
    for (const p of [
      h.connector.pull(handle, null, opts()),
      h.connector.send(handle, msg('m1'), opts()),
      h.connector.verify(handle, opts()),
    ]) {
      const e = await rejection(p);
      expect([e.kind, e.code]).toEqual(['paused', 'other_account']);
    }
    expect(h.relay.requests.length).toBe(n);
    expect(h.connector.availability(handle).state).toBe('other_account');
  });

  it('kill switch read per call', async () => {
    const env: NodeJS.ProcessEnv = {};
    const h = make({ env });
    const { row } = await connectAgent(h);
    const handle = h.core.handle(row.connectionId);
    env.CYBOFLOW_DISABLE_BRIDGE = '1';
    const n = h.relay.requests.length;
    const e = await rejection(h.connector.pull(handle, null, opts()));
    expect([e.kind, e.code, e.message]).toEqual(['paused', 'disabled', BRIDGE_COPY.disabled]);
    await rejection(h.connector.connect(connectRequest('relay-mcp'), opts()));
    expect(h.relay.requests.length).toBe(n);
    delete env.CYBOFLOW_DISABLE_BRIDGE;
    await h.connector.pull(handle, null, opts());
    expect(h.relay.requests.length).toBe(n + 1);
  });

  it('bridge send aborts when o.signal aborts during the budget wait', async () => {
    const h = make();
    const { row } = await connectAgent(h);
    for (let i = 0; i < 19; i += 1) await h.bridge.runtime.budget.acquire('normal', 1000);
    const n = h.relay.requests.length;
    const c = new AbortController();
    const t0 = Date.now();
    let settledAt = -1;
    const p = rejection(h.connector.send(h.core.handle(row.connectionId), msg('m-abort'), { signal: c.signal }))
      .finally(() => { settledAt = Date.now() - t0; });
    await vi.advanceTimersByTimeAsync(5);
    c.abort();
    await vi.advanceTimersByTimeAsync(5);
    const e = await p;
    expect([e.kind, e.code, e.maybeDelivered]).toEqual(['retryable', 'timeout', false]);
    expect(settledAt).toBeLessThanOrEqual(10);
    expect(h.relay.requests.length).toBe(n);
  });

  it('pull honours o.signal during fetch', async () => {
    const h = make();
    const { row } = await connectAgent(h);
    h.relay.injectOnce({ path: /inbound/ }, { kind: 'hang' });
    const c = new AbortController();
    const p = rejection(h.connector.pull(h.core.handle(row.connectionId), null, { signal: c.signal }));
    await vi.advanceTimersByTimeAsync(10);
    c.abort();
    const e = await p;
    expect([e.kind, e.code, e.maybeDelivered]).toEqual(['retryable', 'timeout', false]);
  });

  it('periodic refresh reports relay-side revokes, missing connections and pairedClient changes', async () => {
    const h = make();
    const a = await connectAgent(h, 'relay-mcp', { connectionId: 'a' });
    const b = await connectAgent(h, 'relay-mcp', { connectionId: 'b' });
    h.core.addFromOutcome({ ...a.outcome, remoteId: 'c_missing', remote: { ...a.outcome.remote, relayConnectionId: 'c_missing' } }, { connectionId: 'm' });
    h.relay.revokeServerSide(a.relayId);
    h.relay.completePairing(b.relayId, { name: 'ChatGPT', redirectHost: 'chatgpt.com' });
    await vi.advanceTimersByTimeAsync(15_000 + 30_000);
    expect(h.core.gone).toEqual(expect.arrayContaining([
      { connectionId: 'a', reason: 'relay_revoked' },
      { connectionId: 'm', reason: 'relay_not_found' },
    ]));
    expect(h.core.patches).toEqual([{ connectionId: 'b', patch: { pairedClient: expect.objectContaining({ name: 'ChatGPT' }) } }]);
  });

  it('acknowledge never throws', async () => {
    const h = make();
    const { row } = await connectAgent(h);
    const handle = h.core.handle(row.connectionId);
    h.relay.injectOnce({ path: /\/ack$/ }, { kind: 'network' });
    await expect(h.connector.acknowledge(handle, 'bridge-ack:v1:1:5', opts())).resolves.toBeUndefined();
    await expect(h.connector.acknowledge(handle, 'garbage', opts())).resolves.toBeUndefined();
    await expect(h.connector.acknowledge({ ...handle, remote: {} }, 'bridge-ack:v1:1:5', opts())).resolves.toBeUndefined();
    h.cloud.state = 'signed_out';
    await expect(h.connector.acknowledge(handle, 'bridge-ack:v1:1:6', opts())).resolves.toBeUndefined();
  });

  it('budget() matches the internal request budget', () => {
    const h = make();
    expect(h.connector.budget(h.core.listHandles('bridge')[0] ?? ({} as ConnectionHandle)))
      .toEqual({ key: 'bridge-device', ratePerMinute: 100, capacity: 20 });
  });
});

describe('BridgeConnector: secret hygiene', () => {
  it('no device token, relay-http token or pairing code in any thrown error, log line or capture', async () => {
    const h = make();
    const errors: unknown[] = [];
    const attempt = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        errors.push(e);
      }
    };
    const mcp = await connectAgent(h, 'relay-mcp', { connectionId: 'mcp' });
    const http = await connectAgent(h, 'relay-http', { connectionId: 'http' });
    h.relay.vendorSend(http.relayId, { body: 'hello' });
    await h.core.drain(h.connector, 'http');
    await h.connector.repairPairing(h.core.handle('http'), opts());
    const bad = [
      JSON.stringify({ connectionId: 7, pairingCode: 'AMBER-RIVER-1234', token: `cbh_${'z'.repeat(40)}` }),
      `{"connectionId":"c_x","pairingCode":"AMBER-RIVER-1234","token":"cbh_${'z'.repeat(40)}","mcpUrl":"u","httpBase":"b"} garbage`,
      `{"connectionId":"c_x","pairingCode":"AMBER-RIVER-1234","token":"cbh_${'z'.repeat(12)}`,
    ];
    for (const body of bad) {
      h.relay.injectOnce({ method: 'POST', path: /^\/connections$/ }, { kind: 'raw', status: 201, body });
      await attempt(h.connector.connect(connectRequest('relay-http'), opts()));
      h.relay.injectOnce({ path: /repair$/ }, { kind: 'raw', status: 200, body });
      await attempt(h.connector.repairPairing(h.core.handle('mcp'), opts()));
    }
    h.relay.injectOnce({ path: /outbound/ }, { kind: 'raw', status: 400, body: JSON.stringify({ error: `cbh_${'k'.repeat(30)}` }) });
    await attempt(h.connector.send(h.core.handle('mcp'), msg('m1', { body: `AMBER-RIVER-1234 cbh_${'z'.repeat(40)}` }), opts()));
    h.relay.injectOnce({ path: /outbound/ }, { kind: 'network' });
    await attempt(h.connector.send(h.core.handle('mcp'), msg('m2'), opts()));
    h.relay.revokedDevice = true;
    await attempt(h.connector.pull(h.core.handle('mcp'), null, opts()));
    await attempt(h.connector.verify(h.core.handle('mcp'), opts()));
    expect(errors.length).toBeGreaterThanOrEqual(8);
    for (const e of errors) expect(dump(e)).not.toMatch(SECRET_RE);
    for (const l of h.core.logger.entries) expect(dump(l)).not.toMatch(SECRET_RE);
    for (const c of h.core.captures) expect(`${c.seam} ${dump(c.err)} ${dump(c.tags)}`).not.toMatch(SECRET_RE);
    expect(mcp.relayId).not.toBe(http.relayId);
  });
});
