import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorWiring } from '../../../connectorContract';
import { BRIDGE_DEFINITION } from '../descriptor';
import { createNodeWebSocketFactory, type DoorbellSocketFactory } from '../doorbellSocket';
import { wireBridgeConnector } from '../index';
import { FakeCloud } from './fakeCloud';
import { connectRequest, FakeCore, opts } from './fakeCore';
import { FakeRelay } from './fakeRelay';
import { FakeWebSocket } from './fakeWebSocket';

let wiring: ConnectorWiring | null = null;

function socketFactory(relay: FakeRelay): DoorbellSocketFactory {
  return (url, headers) => {
    const s = new FakeWebSocket(url, headers);
    relay.attachSocket(s);
    return s;
  };
}

function setup(env: NodeJS.ProcessEnv = {}) {
  FakeWebSocket.reset();
  const relay = new FakeRelay();
  const cloud = new FakeCloud({ fetch: relay.fetch });
  const core = new FakeCore(cloud);
  wiring = wireBridgeConnector(core, { createWebSocket: socketFactory(relay), env, random: () => 1 });
  return { relay, cloud, core, wiring };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  wiring?.stop();
  wiring = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('wireBridgeConnector', () => {
  it('with cloud null registers nothing and start/stop are no-ops', () => {
    const core = new FakeCore(null);
    const w = wireBridgeConnector(core, { createWebSocket: null });
    w.start();
    w.stop();
    w.start();
    expect(core.registrations).toEqual([]);
    expect(core.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('registers BRIDGE_DEFINITION once', () => {
    const { core } = setup();
    expect(core.registrations).toHaveLength(1);
    expect(core.registrations[0].definition).toBe(BRIDGE_DEFINITION);
    const a = core.connector();
    const b = core.connector();
    expect(a.definition.id).toBe('bridge');
    expect(a).toBe(b);
  });

  it('start() makes no request and no getToken() call for 15 s', async () => {
    const { relay, cloud, core, wiring: w } = setup();
    expect(core.connector().availability().state).toBe('disabled');
    core.addFromOutcome({
      remoteId: 'c_seed', transport: 'relay-mcp', inboundCursor: null, relayEpoch: null, pairing: null, facts: [],
      remote: {
        v: 1, origin: 'https://cloud.test', accountId: 'acct_1', relayConnectionId: 'c_seed', transport: 'relay-mcp',
        label: null, mcpUrl: 'https://bridge.test/mcp/c_seed', httpBase: 'https://bridge.test/c/c_seed',
        pairingIssuedAt: null, pairedClient: null, pairCalledAt: null, firstInboundAt: null, firstPickupAt: null,
        relayState: 'active',
      },
    });
    const tokenCalls = cloud.tokenCalls;
    const requests = relay.requests.length;
    w.start();
    w.start();
    expect(core.connector().availability().state).toBe('ok');
    await vi.advanceTimersByTimeAsync(14_999);
    expect(cloud.tokenCalls).toBe(tokenCalls);
    expect(relay.requests.length).toBe(requests);
    expect(core.kicks).toEqual([]);
    expect(FakeWebSocket.instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(core.kickAllCount).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('notifyAvailabilityChanged on every runtime status change', async () => {
    const { cloud, core, wiring: w } = setup();
    w.start();
    expect(core.availabilityNotices).toEqual(['bridge']);
    cloud.setState('locked');
    expect(core.availabilityNotices).toHaveLength(2);
    cloud.setState('locked');
    expect(core.availabilityNotices).toHaveLength(2);
    cloud.setState('ok');
    expect(core.availabilityNotices).toHaveLength(3);
    cloud.markRevoked('device_revoked');
    expect(core.availabilityNotices).toHaveLength(4);
    expect(new Set(core.availabilityNotices)).toEqual(new Set(['bridge']));
  });

  it('notifyAvailabilityChanged when a relay block starts and ends, and on stop()', async () => {
    const { relay, core, wiring: w } = setup();
    w.start();
    const connector = core.connector();
    const outcome = await connector.connect(connectRequest('relay-mcp'), opts());
    const row = core.addFromOutcome(outcome);
    await vi.advanceTimersByTimeAsync(15_000);
    const before = core.availabilityNotices.length;
    relay.injectOnce({ path: /inbound/ }, { kind: 'http', status: 429, error: 'rate_limited', retryAfterSec: 5 });
    await expect(connector.pull(core.handle(row.connectionId), null, opts())).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(connector.availability().state).toBe('unavailable');
    expect(core.availabilityNotices.length).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(connector.availability().state).toBe('ok');
    expect(core.availabilityNotices.length).toBe(before + 2);
    w.stop();
    expect(connector.availability().state).toBe('disabled');
    expect(core.availabilityNotices.length).toBe(before + 3);
  });

  it('doorbell frame for a known relay id → ctx.kick(localId)', async () => {
    const { relay, core, wiring: w } = setup();
    w.start();
    const outcome = await core.connector().connect(connectRequest('relay-mcp'), opts());
    const row = core.addFromOutcome(outcome);
    await vi.advanceTimersByTimeAsync(15_000);
    FakeWebSocket.last().serverOpen();
    await vi.advanceTimersByTimeAsync(1_000);
    core.kicks.length = 0;
    relay.vendorSend(outcome.remoteId, { body: 'ring' });
    expect(core.kicks).toEqual([row.connectionId]);
  });

  it('wiring stop() then start() works again (pulls reach the relay and the doorbell is open again)', async () => {
    const { relay, core, wiring: w } = setup();
    w.start();
    const connector = core.connector();
    const outcome = await connector.connect(connectRequest('relay-mcp'), opts());
    const row = core.addFromOutcome(outcome);
    await vi.advanceTimersByTimeAsync(15_000);
    const first = FakeWebSocket.last();
    first.serverOpen();

    w.stop();
    expect(first.closedWith?.code).toBe(1000);
    expect(vi.getTimerCount()).toBe(0);
    await expect(connector.pull(core.handle(row.connectionId), null, opts())).rejects.toMatchObject({ kind: 'paused' });
    const pullsWhileStopped = relay.count(/inbound/);
    expect(pullsWhileStopped).toBe(0);

    w.start();
    relay.vendorSend(outcome.remoteId, { body: 'after restart' });
    await core.drain(connector, row.connectionId);
    expect(relay.count(/inbound/)).toBe(1);
    expect(core.messagesFor(row.connectionId).map((m) => m.body)).toEqual(['after restart']);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = FakeWebSocket.last();
    second.serverOpen();
    expect(second.readyState).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    core.kicks.length = 0;
    relay.vendorSend(outcome.remoteId, { body: 'ring again' });
    expect(core.kicks).toEqual([row.connectionId]);
  });

  it('the connector is registered even under the Bridge kill switch, and makes no requests', async () => {
    const { relay, core, wiring: w } = setup({ CYBOFLOW_DISABLE_BRIDGE: '1' });
    w.start();
    expect(core.registrations).toHaveLength(1);
    const connector = core.connector();
    expect(connector.availability().state).toBe('disabled');
    await expect(connector.connect(connectRequest('relay-mcp'), opts())).rejects.toMatchObject({ kind: 'paused', code: 'disabled' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(relay.requests).toHaveLength(0);
  });

  it('connector.dispose() is terminal (quit): start() afterwards does nothing', async () => {
    const { relay, core, wiring: w } = setup();
    w.start();
    const connector = core.connector();
    const outcome = await connector.connect(connectRequest('relay-mcp'), opts());
    core.addFromOutcome(outcome);
    connector.dispose?.();
    expect(vi.getTimerCount()).toBe(0);
    w.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(relay.count(/inbound/)).toBe(0);
  });
});

describe('createNodeWebSocketFactory', () => {
  it('returns null without a global WebSocket and a factory passing headers when present', () => {
    vi.stubGlobal('WebSocket', undefined);
    expect(createNodeWebSocketFactory()).toBeNull();
    const seen: Array<{ url: string; init: unknown }> = [];
    class Stub {
      constructor(url: string, init: unknown) {
        seen.push({ url, init });
      }
    }
    vi.stubGlobal('WebSocket', Stub);
    const f = createNodeWebSocketFactory();
    expect(f).not.toBeNull();
    f?.('wss://x.test/bridge/v1/doorbell', { Authorization: 'Bearer t' });
    expect(seen).toEqual([{ url: 'wss://x.test/bridge/v1/doorbell', init: { headers: { Authorization: 'Bearer t' } } }]);
  });
});
