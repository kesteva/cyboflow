import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectorError } from '../connectorErrors';
import type { InboundBatch } from '../connectorContract';
import {
  CATCH_UP_DELAY_MS,
  CATCH_UP_SPREAD_MAX_MS,
} from '../inboundPump';
import { BRIDGE_DESCRIPTOR } from '../../../../../shared/types/__tests__/persistentAgentsFixtures';
import { T0, createFakeConnector, emptyBatch, makeHarness, type FakeConnector, type Harness } from './fakeConnector';

let h: Harness;
let fake: FakeConnector;
let seq = 0;

const realClock = {
  now: () => new Date(),
  set: (d: Date | number) => { vi.setSystemTime(d); },
  advance: (ms: number) => { vi.setSystemTime(Date.now() + ms); },
};

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  seq = 0;
  fake = createFakeConnector({ now: () => new Date() });
  h = makeHarness({ connectors: [fake], clock: realClock });
});

afterEach(() => {
  h.pump.stop();
  h.raw.close();
  vi.useRealTimers();
});

/** A completed connection row (no noteActive), with optional state / age overrides. */
async function seedConn(opts: { state?: string; ageMs?: number; lastSeenAgoMs?: number | null; kind?: 'bridge' } = {}): Promise<{ agentId: string; connectionId: string }> {
  seq += 1;
  const { agentId, connectionId } = await h.store.createAgent({
    agent: { displayName: `Agent ${seq}`, vendor: 'openai-dots' },
    connection: { kind: 'bridge', connectorId: 'bridge', connectorVersion: 1, transport: 'relay-mcp', credentialId: null, descriptor: BRIDGE_DESCRIPTOR },
  });
  await h.store.completeConnectionCreate(connectionId, {
    remoteId: `r${seq}`, remote: {}, transport: 'relay-mcp', inboundCursor: null, relayEpoch: 1, pairing: null, facts: [],
  });
  const created = new Date(Date.now() - (opts.ageMs ?? 2 * 3_600_000)).toISOString();
  const lastSeen = opts.lastSeenAgoMs === undefined || opts.lastSeenAgoMs === null ? null : new Date(Date.now() - opts.lastSeenAgoMs).toISOString();
  h.raw.prepare('UPDATE persistent_agent_connections SET state = ?, created_at = ?, last_seen_at = ?, verified_at = ? WHERE id = ?')
    .run(opts.state ?? 'verified', created, lastSeen, created, connectionId);
  return { agentId, connectionId };
}

/** Record pull times by wrapping the fake's pull. */
function recordPulls(): Array<{ id: string; at: number }> {
  const log: Array<{ id: string; at: number }> = [];
  const orig = fake.connector.pull.bind(fake.connector);
  fake.connector.pull = async (hh, cursor, o) => {
    log.push({ id: hh.connectionId, at: Date.now() - T0.getTime() });
    return orig(hh, cursor, o);
  };
  return log;
}

const tick = (ms: number): Promise<void> => vi.advanceTimersByTimeAsync(ms).then(() => undefined);
const agentText = (rid: string): InboundBatch['messages'][number] => ({ remoteEventId: rid, author: 'agent', kind: 'text', body: rid, links: [], remoteCreatedAt: null });

describe('InboundPump', () => {
  it('launch catch-up is staggered', async () => {
    const a = await seedConn({ lastSeenAgoMs: 1_000 });
    const b = await seedConn({ lastSeenAgoMs: null });
    const c = await seedConn({ lastSeenAgoMs: 60_000 });
    const log = recordPulls();
    h.pump.start();
    await tick(CATCH_UP_DELAY_MS - 1);
    expect(log).toHaveLength(0);
    await tick(10_000);
    const first = new Map<string, number>();
    for (const p of log) if (!first.has(p.id)) first.set(p.id, p.at);
    // null last_seen first, then oldest
    expect(first.get(b.connectionId)).toBe(5_000);
    expect(first.get(c.connectionId)).toBe(7_000);
    expect(first.get(a.connectionId)).toBe(9_000);
  });

  it('launch catch-up of 60 connections spreads over at most 55 s', async () => {
    for (let i = 0; i < 60; i++) await seedConn({ lastSeenAgoMs: i * 1000 });
    const log = recordPulls();
    h.pump.start();
    await tick(CATCH_UP_DELAY_MS + CATCH_UP_SPREAD_MAX_MS + 2_000);
    const first = new Map<string, number>();
    for (const p of log) if (!first.has(p.id)) first.set(p.id, p.at);
    expect(first.size).toBe(60);
    const times = [...first.values()];
    expect(Math.min(...times)).toBe(5_000);
    expect(Math.max(...times) - Math.min(...times)).toBeLessThanOrEqual(CATCH_UP_SPREAD_MAX_MS);
  });

  it('active connection polls every 5 s', async () => {
    const { agentId, connectionId } = await seedConn();
    const log = recordPulls();
    h.pump.start();
    h.pump.noteOutbound(agentId, Date.now());
    await tick(30_000);
    const times = log.filter((p) => p.id === connectionId).map((p) => p.at);
    expect(times.slice(0, 4)).toEqual([5_000, 10_000, 15_000, 20_000]);
  });

  it('idle backs off 60→120→240→300 s and resets on inbound', async () => {
    const { connectionId } = await seedConn();
    const log = recordPulls();
    h.pump.start();
    await tick(5_000 + 60_000 + 120_000 + 240_000 + 300_000 + 1_000);
    const t = log.filter((p) => p.id === connectionId).map((p) => p.at);
    const gaps = t.slice(1).map((x, i) => x - t[i]);
    expect(gaps.slice(0, 4)).toEqual([60_000, 120_000, 240_000, 300_000]);
    fake.script.pushPull(emptyBatch({ messages: [agentText('hi')] }));
    await tick(300_000);
    const t2 = log.filter((p) => p.id === connectionId).map((p) => p.at);
    await tick(70_000);
    const t3 = log.filter((p) => p.id === connectionId).map((p) => p.at);
    expect(t3.length).toBe(t2.length + 1);
    expect(t3[t3.length - 1] - t2[t2.length - 1]).toBe(60_000);
  });

  it('pending <30 min polls actively', async () => {
    const { connectionId } = await seedConn({ state: 'pending', ageMs: 60_000 });
    const log = recordPulls();
    h.pump.start();
    await tick(21_000);
    expect(log.filter((p) => p.id === connectionId).map((p) => p.at)).toEqual([5_000, 10_000, 15_000, 20_000]);
  });

  it('noteActive keeps a repaired pending connection on the 5 s cadence', async () => {
    const { connectionId } = await seedConn({ state: 'pending', ageMs: 2 * 3_600_000 });
    const log = recordPulls();
    h.pump.start();
    await tick(6_000);
    h.pump.noteActive(connectionId);
    await tick(15_000);
    const t = log.filter((p) => p.id === connectionId).map((p) => p.at);
    // the note (at 6 s) moves the next pull to +5 s, then the 5 s cadence holds
    expect(t).toEqual([5_000, 11_000, 16_000, 21_000]);
  });

  it('hasMore re-pulls on the next tick', async () => {
    const { connectionId } = await seedConn();
    const log = recordPulls();
    fake.script.pushPull(emptyBatch({ messages: [agentText('a')], hasMore: true, nextCursor: '1' }));
    fake.script.pushPull(emptyBatch({ messages: [agentText('b')], hasMore: false, nextCursor: '2' }));
    h.pump.start();
    await tick(7_000);
    expect(log.filter((p) => p.id === connectionId).map((p) => p.at)).toEqual([5_000, 6_000]);
  });

  it('ack only after commit', async () => {
    await seedConn();
    const apply = vi.spyOn(h.store, 'applyInboundBatch').mockRejectedValueOnce(new Error('disk full'));
    fake.script.pushPull(emptyBatch({ messages: [agentText('a')], ackToken: 'tok-1', hasMore: true }));
    fake.script.pushPull(emptyBatch({ messages: [agentText('a')], ackToken: 'tok-2' }));
    h.pump.start();
    await tick(5_000);
    expect(fake.calls.filter((c) => c.method === 'acknowledge')).toHaveLength(0);
    expect(h.capture).toHaveBeenCalledWith('connector-inbound', expect.any(Error), expect.objectContaining({ errorKind: 'apply' }));
    apply.mockRestore();
    await tick(61_000);
    const acks = fake.calls.filter((c) => c.method === 'acknowledge');
    expect(acks).toHaveLength(1);
    expect(acks[0].args[0]).toBe('tok-2');
  });

  it('retry-after sets rate_limited_until and defers', async () => {
    const { connectionId } = await seedConn();
    const log = recordPulls();
    fake.script.pushPull(new ConnectorError('rate_limited', 'busy', { retryAfterMs: 90_000 }));
    h.pump.start();
    await tick(5_000);
    const until = (h.raw.prepare('SELECT rate_limited_until AS u FROM persistent_agent_connections WHERE id = ?').get(connectionId) as { u: string }).u;
    expect(Date.parse(until)).toBe(T0.getTime() + 5_000 + 90_000);
    await tick(89_000);
    expect(log).toHaveLength(1);
    await tick(2_000);
    expect(log).toHaveLength(2);
  });

  it('token bucket caps at 120/min', async () => {
    const { connectionId } = await seedConn();
    const log = recordPulls();
    h.pump.start();
    await tick(6_000);
    const base = log.length;
    for (let i = 0; i < 500; i++) {
      h.pump.kick(connectionId);
      await tick(0);
    }
    const burst = log.length - base;
    expect(burst).toBeLessThanOrEqual(120);
    const afterBurst = log.length;
    for (let i = 0; i < 500; i++) {
      h.pump.kick(connectionId);
      await tick(120);
    }
    expect(log.length - afterBurst).toBeLessThanOrEqual(121);
  });

  it('bridge connection goes stale after 24 h and persists', async () => {
    const { connectionId } = await seedConn({ lastSeenAgoMs: 25 * 3_600_000 });
    h.pump.start();
    await tick(61_000);
    const s = (h.raw.prepare('SELECT state FROM persistent_agent_connections WHERE id = ?').get(connectionId) as { state: string }).state;
    expect(s).toBe('stale');
  });

  it('kick coalesces with an in-flight pull', async () => {
    const { connectionId } = await seedConn();
    const log = recordPulls();
    let release: () => void = () => undefined;
    fake.script.pushPull(() => new Promise<InboundBatch>((r) => { release = () => r(emptyBatch()); }));
    h.pump.start();
    await tick(5_000);
    expect(log).toHaveLength(1);
    h.pump.kick(connectionId);
    h.pump.kick(connectionId);
    h.pump.kick(connectionId);
    await tick(0);
    expect(log).toHaveLength(1);
    release();
    await tick(0);
    await tick(0);
    expect(log).toHaveLength(2);
    await tick(1_000);
    expect(log).toHaveLength(2);
  });

  it('auth_failed pulled once when auth_retry_at is due', async () => {
    const native = createFakeConnector({ kind: 'native', now: () => new Date() });
    h.raw.close();
    h = makeHarness({ connectors: [native], clock: realClock });
    fake = native;
    const r = await h.connections.connect({
      agent: { displayName: 'Cma', vendor: 'anthropic-cma' },
      connection: { kind: 'native', connectorId: 'claude-managed-agents', credential: { mode: 'new', label: 'k', secret: 'sk-ant-TEST-123456' }, remote: {} },
    });
    h.raw.prepare(`UPDATE persistent_agent_connections SET state = 'auth_failed', auth_retry_at = ?, created_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), new Date(Date.now() - 7_200_000).toISOString(), r.connectionId);
    native.calls.length = 0;
    native.script.pushPull(new ConnectorError('auth', 'API key rejected', { httpStatus: 401 }));
    h.pump.start();
    await tick(10 * 60_000);
    expect(native.calls.filter((c) => c.method === 'pull')).toHaveLength(1);
    const row = h.raw.prepare('SELECT state, auth_retry_at FROM persistent_agent_connections WHERE id = ?').get(r.connectionId) as { state: string; auth_retry_at: string | null };
    expect(row).toEqual({ state: 'auth_failed', auth_retry_at: null });
  });

  it('not running → no DB reads, no pulls', async () => {
    await seedConn();
    h.running.value = false;
    const targets = vi.spyOn(h.store, 'listPumpTargets');
    const stale = vi.spyOn(h.store, 'markStale');
    h.pump.start();
    await tick(120_000);
    expect(targets).not.toHaveBeenCalled();
    expect(stale).not.toHaveBeenCalled();
    expect(fake.calls.filter((c) => c.method === 'pull')).toHaveLength(0);
  });

  it('stop() clears the interval and is idempotent', async () => {
    const before = vi.getTimerCount();
    h.pump.start();
    h.pump.start();
    expect(vi.getTimerCount()).toBe(before + 1);
    h.pump.stop();
    h.pump.stop();
    expect(vi.getTimerCount()).toBe(before);
  });

  it('becameVerified calls onConnectionVerified', async () => {
    const { connectionId } = await seedConn({ state: 'pending' });
    const spy = vi.spyOn(h.connections, 'onConnectionVerified');
    fake.script.pushPull(emptyBatch({ observed: ['round-trip'], messages: [agentText('r')] }));
    h.pump.start();
    await tick(5_000);
    expect(spy).toHaveBeenCalledWith(connectionId);
  });

  it('unavailable+retryAt defers until retryAt; unavailable without retryAt still pulls', async () => {
    await seedConn();
    const log = recordPulls();
    fake.script.setAvailability({ state: 'unavailable', message: 'busy', retryAt: new Date(T0.getTime() + 120_000).toISOString() });
    h.pump.start();
    await tick(60_000);
    // the gate lifts early, but the pull stays scheduled for retryAt
    fake.script.setAvailability({ state: 'ok', message: null, retryAt: null });
    await tick(59_000);
    expect(log).toHaveLength(0);
    await tick(2_000);
    expect(log.map((p) => p.at)).toEqual([120_000]);
    fake.script.setAvailability({ state: 'unavailable', message: 'offline', retryAt: null });
    await tick(61_000);
    expect(log.length).toBeGreaterThanOrEqual(2);
  });

  it('paused pull is not captured and retries within 60 s', async () => {
    await seedConn();
    const log = recordPulls();
    fake.script.pushPull(new ConnectorError('paused', 'Signed out', { code: 'signed_out' }));
    h.pump.start();
    await tick(5_000);
    expect(log).toHaveLength(1);
    expect(h.capture).not.toHaveBeenCalled();
    await tick(60_000);
    expect(log).toHaveLength(2);
  });

  it('fenced apply skips the ack and re-pulls next tick', async () => {
    const { connectionId } = await seedConn();
    const log = recordPulls();
    let repaired = false;
    fake.script.pushPull(async () => {
      // a repair commits while this pull is in flight
      await h.store.applyRepair(connectionId, {
        pairing: { kind: 'bridge', connectionId, transport: 'relay-mcp', mcpUrl: 'm', httpBase: 'h', pairingCode: 'A-B-1', pairingExpiresAt: null, oneTimeToken: null, instructionBrief: null },
        relayEpoch: 2, inboundCursor: 'bridge:v1:2:0',
      });
      repaired = true;
      return emptyBatch({ messages: [agentText('old')], ackToken: 'old-epoch', nextCursor: 'bridge:v1:1:9' });
    });
    h.pump.start();
    await tick(5_000);
    expect(repaired).toBe(true);
    expect(fake.calls.filter((c) => c.method === 'acknowledge')).toHaveLength(0);
    await tick(1_000);
    expect(log.map((p) => p.at)).toEqual([5_000, 6_000]);
    expect((log.length)).toBe(2);
    const second = fake.calls.filter((c) => c.method === 'pull')[1];
    expect(second.args[0]).toBe('bridge:v1:2:0');
  });

  it('drainNow pulls until hasMore is false (≤ maxPages) and acks each page after commit', async () => {
    const { connectionId } = await seedConn();
    const order: string[] = [];
    const apply = h.store.applyInboundBatch.bind(h.store);
    vi.spyOn(h.store, 'applyInboundBatch').mockImplementation(async (id, b, o) => {
      const r = await apply(id, b, o);
      order.push(`apply:${b.ackToken}`);
      return r;
    });
    const ack = fake.connector.acknowledge?.bind(fake.connector);
    fake.connector.acknowledge = async (hh, token, o) => { order.push(`ack:${token}`); await ack?.(hh, token, o); };
    for (let i = 1; i <= 3; i++) {
      fake.script.pushPull(emptyBatch({ messages: [agentText(`m${i}`)], ackToken: `t${i}`, hasMore: i < 3, nextCursor: String(i) }));
    }
    const res = await h.pump.drainNow(connectionId, { maxPages: 50 });
    expect(res).toEqual({ pages: 3, complete: true });
    expect(order).toEqual(['apply:t1', 'ack:t1', 'apply:t2', 'ack:t2', 'apply:t3', 'ack:t3']);
    for (let i = 1; i <= 5; i++) fake.script.pushPull(emptyBatch({ hasMore: true }));
    expect(await h.pump.drainNow(connectionId, { maxPages: 2 })).toEqual({ pages: 2, complete: false });
  });

  it('drainNow waits for an in-flight pull of the same connection', async () => {
    const { connectionId } = await seedConn();
    const log = recordPulls();
    let release: () => void = () => undefined;
    fake.script.pushPull(() => new Promise<InboundBatch>((r) => { release = () => r(emptyBatch()); }));
    h.pump.start();
    await tick(5_000);
    expect(log).toHaveLength(1);
    let drained = false;
    const p = h.pump.drainNow(connectionId).then((r) => { drained = true; return r; });
    await tick(0);
    expect(log).toHaveLength(1);
    expect(drained).toBe(false);
    release();
    const r = await p;
    expect(r.complete).toBe(true);
    expect(log).toHaveLength(2);
  });

  it('drainNow of a connection with no pump entry holds it: a mid-drain kick never pulls concurrently', async () => {
    h.pump.start();
    await tick(0);
    const { connectionId } = await seedConn();
    expect(h.pump._entries().has(connectionId)).toBe(false);
    const log = recordPulls();
    let inFlight = 0;
    let maxInFlight = 0;
    const pull = fake.connector.pull.bind(fake.connector);
    fake.connector.pull = async (hh, cursor, o) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try { return await pull(hh, cursor, o); } finally { inFlight -= 1; }
    };
    let release: () => void = () => undefined;
    fake.script.pushPull(() => new Promise<InboundBatch>((r) => { release = () => r(emptyBatch()); }));
    const p = h.pump.drainNow(connectionId);
    await tick(0);
    expect(log).toHaveLength(1);
    // A kick refreshes targets and creates the entry while the drain is still pulling.
    h.pump.kick(connectionId);
    expect(h.pump._entries().has(connectionId)).toBe(true);
    await tick(0);
    expect(log).toHaveLength(1);
    release();
    expect(await p).toEqual({ pages: 1, complete: true });
    await tick(0);
    // The kick is honoured once the drain let go.
    expect(log).toHaveLength(2);
    expect(maxInFlight).toBe(1);
  });

});
