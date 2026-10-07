import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { doorbellUrl } from '../doorbell';
import type { DoorbellSocketFactory } from '../doorbellSocket';
import { FakeCloud, fakeDevice } from './fakeCloud';
import { connectAgent, setupBridge, type BridgeHarness, type HarnessOptions } from './fakeCore';
import { FakeRelay } from './fakeRelay';
import { FakeWebSocket } from './fakeWebSocket';

let h: BridgeHarness;

function harness(o: HarnessOptions = {}): BridgeHarness {
  FakeWebSocket.reset();
  const relay = o.relay ?? new FakeRelay();
  const factory: DoorbellSocketFactory = (url, headers) => {
    const s = new FakeWebSocket(url, headers);
    relay.attachSocket(s);
    return s;
  };
  h = setupBridge({ createWebSocket: factory, ...o, relay });
  return h;
}

/** Connect an agent, let the start delay elapse, and open the socket. */
async function openWithConnections(n = 1): Promise<{ relayIds: string[]; ids: string[] }> {
  const relayIds: string[] = [];
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const r = await connectAgent(h, 'relay-mcp', { connectionId: `conn_${i}` });
    relayIds.push(r.relayId);
    ids.push(r.row.connectionId);
  }
  await vi.advanceTimersByTimeAsync(15_000);
  FakeWebSocket.last().serverOpen();
  return { relayIds, ids };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  h?.bridge.dispose();
  vi.useRealTimers();
});

describe('Doorbell', () => {
  it('does not open without an active Bridge connection; opens when one appears', async () => {
    harness();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(h.bridge.doorbell.state()).toBe('off');
    await connectAgent(h);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(h.bridge.doorbell.state()).toBe('connecting');
    FakeWebSocket.last().serverOpen();
    expect(h.bridge.doorbell.state()).toBe('open');
    expect(h.bridge.runtime.status()).toEqual({ state: 'ready', doorbell: 'open' });
  });

  it('url and headers', async () => {
    harness();
    await openWithConnections();
    const s = FakeWebSocket.last();
    expect(s.url).toBe('wss://cloud.test/bridge/v1/doorbell');
    expect(s.headers).toEqual({
      Authorization: `Bearer ${h.cloud.token}`, 'Cyboflow-Relay-Protocol': '1', 'Cyboflow-App-Version': '9.9.9-test',
    });
    expect(doorbellUrl('http://localhost:8787')).toBe('ws://localhost:8787/bridge/v1/doorbell');
    expect(doorbellUrl('http://example.com')).toBeNull();
  });

  it('frame kicks the mapped local connection; unknown ids and malformed frames ignored', async () => {
    harness();
    const { relayIds, ids } = await openWithConnections();
    await vi.advanceTimersByTimeAsync(1000);
    h.core.kicks.length = 0;
    h.relay.vendorSend(relayIds[0], { body: 'ring' });
    expect(h.core.kicks).toEqual([ids[0]]);
    const s = FakeWebSocket.last();
    s.serverMessage(JSON.stringify({ connectionId: 'c_unknown', head: 1 }));
    s.serverMessage('{not json');
    s.serverMessage(JSON.stringify({ connectionId: relayIds[0], head: -1 }));
    s.serverMessage(JSON.stringify({ connectionId: 5, head: 1 }));
    s.onmessage?.({ data: new Uint8Array([1]) });
    s.serverMessage('pong');
    expect(h.core.kicks).toEqual([ids[0]]);
  });

  it('open sweeps every connection with 250 ms stagger', async () => {
    harness();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push((await connectAgent(h, 'relay-mcp', { connectionId: `c${i}` })).row.connectionId);
    await vi.advanceTimersByTimeAsync(15_000);
    h.core.kicks.length = 0;
    FakeWebSocket.last().serverOpen();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.core.kicks).toEqual([ids[0]]);
    await vi.advanceTimersByTimeAsync(250);
    expect(h.core.kicks).toEqual([ids[0], ids[1]]);
    await vi.advanceTimersByTimeAsync(250);
    expect(h.core.kicks).toEqual(ids);
  });

  it('ping every 30 s; no message for 65 s closes with 4000 and reconnects', async () => {
    harness();
    await openWithConnections();
    const s = FakeWebSocket.last();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.sent).toEqual(['ping']);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.sent).toEqual(['ping', 'ping']);
    s.serverMessage('pong');
    await vi.advanceTimersByTimeAsync(64_999);
    expect(s.closedWith).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.closedWith?.code).toBe(4000);
    expect(h.bridge.doorbell.state()).toBe('backoff');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('abnormal close reconnects with jittered backoff capped at 60 s (random 0 and 1 bounds)', async () => {
    harness({ random: () => 1 });
    await openWithConnections();
    const expected = [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
    for (const delay of expected) {
      const n = FakeWebSocket.instances.length;
      FakeWebSocket.last().serverClose(1006);
      expect(h.bridge.doorbell.state()).toBe('backoff');
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(FakeWebSocket.instances).toHaveLength(n);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeWebSocket.instances).toHaveLength(n + 1);
      FakeWebSocket.last().serverOpen();
    }
    h.bridge.dispose();

    harness({ random: () => 0 });
    await openWithConnections();
    FakeWebSocket.last().serverClose(1006);
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('backoff counter resets after 30 s of stable open', async () => {
    harness({ random: () => 1 });
    await openWithConnections();
    FakeWebSocket.last().serverClose(1006);
    await vi.advanceTimersByTimeAsync(2_000);
    FakeWebSocket.last().serverOpen();
    await vi.advanceTimersByTimeAsync(30_000);
    FakeWebSocket.last().serverClose(1006);
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('4401 marks the device revoked and does not reconnect until signedIn', async () => {
    harness();
    await openWithConnections();
    FakeWebSocket.last().serverClose(4401);
    expect(h.cloud.markRevokedCalls).toEqual(['device_revoked']);
    expect(h.bridge.doorbell.state()).toBe('off');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    h.cloud.signIn();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('4401 for a socket opened by a previous device does not revoke the new one', async () => {
    harness();
    await openWithConnections();
    h.cloud.device = fakeDevice({ deviceId: 'dev_new' });
    FakeWebSocket.last().serverClose(4401);
    expect(h.cloud.markRevokedCalls).toEqual([]);
  });

  it('4410 marks account deleted and reports every Bridge connection gone', async () => {
    harness();
    const { ids } = await openWithConnections(2);
    FakeWebSocket.last().serverClose(4410);
    expect(h.cloud.markRevokedCalls).toEqual(['account_deleted']);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.core.gone).toEqual(ids.map((connectionId) => ({ connectionId, reason: 'account_deleted' })));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('failed upgrade + probe 401 → markRevoked, stops', async () => {
    harness();
    await connectAgent(h);
    await vi.advanceTimersByTimeAsync(15_000);
    h.relay.revokedDevice = true;
    FakeWebSocket.last().failUpgrade();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.cloud.markRevokedCalls).toEqual(['device_revoked']);
    expect(h.bridge.doorbell.state()).toBe('off');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('failed upgrade + probe 426 → needs_update, stops', async () => {
    harness();
    await connectAgent(h);
    await vi.advanceTimersByTimeAsync(15_000);
    h.relay.protocolRange = { min: 2, max: 2 };
    FakeWebSocket.last().failUpgrade();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.bridge.runtime.status().state).toBe('needs_update');
    expect(h.bridge.doorbell.state()).toBe('off');
  });

  it('failed upgrade with a healthy probe x3 → unavailable for 30 min; pulls unaffected', async () => {
    harness({ random: () => 1 });
    const { row, relayId } = await connectAgent(h);
    await vi.advanceTimersByTimeAsync(15_000);
    FakeWebSocket.last().failUpgrade();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.last().failUpgrade();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(FakeWebSocket.instances).toHaveLength(3);
    FakeWebSocket.last().failUpgrade();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.bridge.doorbell.state()).toBe('unavailable');
    expect(h.core.logger.entries.some((e) => e.level === 'warn' && e.message.includes('pull-only'))).toBe(true);
    h.relay.vendorSend(relayId, { body: 'still flows' });
    await h.core.drain(h.connector, row.connectionId);
    expect(h.core.messagesFor(row.connectionId).map((m) => m.body)).toContain('still flows');
    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(FakeWebSocket.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it('stop() during the pull-only window, then start(), connects again after the start delay', async () => {
    harness({ random: () => 1 });
    await connectAgent(h);
    await vi.advanceTimersByTimeAsync(15_000);
    FakeWebSocket.last().failUpgrade();
    await vi.advanceTimersByTimeAsync(2_000);
    FakeWebSocket.last().failUpgrade();
    await vi.advanceTimersByTimeAsync(4_000);
    FakeWebSocket.last().failUpgrade();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.bridge.doorbell.state()).toBe('unavailable');
    expect(FakeWebSocket.instances).toHaveLength(3);
    h.bridge.stop();
    h.bridge.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(FakeWebSocket.instances).toHaveLength(4);
    FakeWebSocket.last().serverOpen();
    expect(h.bridge.doorbell.state()).toBe('open');
  });

  it('stop() closes with 1000 and leaves no timers', async () => {
    harness();
    await openWithConnections();
    const s = FakeWebSocket.last();
    h.bridge.dispose();
    expect(s.closedWith?.code).toBe(1000);
    expect(s.onmessage).toBeNull();
    expect(h.bridge.doorbell.state()).toBe('stopped');
    expect(vi.getTimerCount()).toBe(0);
    expect(() => h.bridge.dispose()).not.toThrow();
    h.bridge.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('status leaving ready closes the socket; returning reconnects', async () => {
    harness();
    await openWithConnections();
    const s = FakeWebSocket.last();
    h.cloud.setState('locked');
    expect(s.closedWith?.code).toBe(1000);
    expect(h.bridge.doorbell.state()).toBe('off');
    h.cloud.setState('ok');
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('null factory → state unavailable, never throws', async () => {
    FakeWebSocket.reset();
    h = setupBridge({ createWebSocket: null });
    await connectAgent(h);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.bridge.doorbell.state()).toBe('unavailable');
    expect(h.bridge.doorbell.healthy()).toBe(false);
  });

  it('kill switch → never opens', async () => {
    const relay = new FakeRelay();
    const cloud = new FakeCloud({ fetch: relay.fetch });
    const env: NodeJS.ProcessEnv = {};
    harness({ relay, cloud, env });
    await connectAgent(h);
    env.CYBOFLOW_DISABLE_BRIDGE = '1';
    const tokenCalls = cloud.tokenCalls;
    const requests = relay.requests.length;
    h.cloud.setState('ok');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(cloud.tokenCalls).toBe(tokenCalls);
    expect(relay.requests.length).toBe(requests);
  });
});
