import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isConnectorCallable } from '../../../../../../../shared/types/persistentAgents';
import type { BridgeRemoteV1 } from '../bridgeRemote';
import { BRIDGE_COPY } from '../copy';
import { RelayHttpError } from '../relayErrors';
import { FakeCloud } from './fakeCloud';
import { opts, setupBridge, type BridgeHarness, type FakeRow } from './fakeCore';
import { FakeRelay } from './fakeRelay';

let h: BridgeHarness;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  h?.bridge.dispose();
  vi.useRealTimers();
});

function seedRow(harness: BridgeHarness, over: Partial<BridgeRemoteV1> = {}, raw?: Record<string, unknown>): FakeRow {
  const remote: BridgeRemoteV1 = {
    v: 1, origin: 'https://cloud.test', accountId: 'acct_1', relayConnectionId: 'c_seed', transport: 'relay-mcp',
    label: null, mcpUrl: 'https://bridge.test/mcp/c_seed', httpBase: 'https://bridge.test/c/c_seed',
    pairingIssuedAt: null, pairedClient: null, pairCalledAt: null, firstInboundAt: null, firstPickupAt: null,
    relayState: 'active', ...over,
  };
  return harness.core.addFromOutcome({
    remoteId: remote.relayConnectionId,
    remote: raw ?? { ...remote },
    transport: 'relay-mcp',
    inboundCursor: null,
    relayEpoch: null,
    pairing: null,
    facts: [],
  });
}

async function swallow(p: Promise<unknown>): Promise<unknown> {
  try {
    return await p;
  } catch (e) {
    return e;
  }
}

describe('BridgeRuntime', () => {
  it('start() does not call getToken or fetch before the start delay', async () => {
    h = setupBridge({ start: false });
    seedRow(h);
    h.bridge.start();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(h.cloud.tokenCalls).toBe(0);
    expect(h.relay.requests).toHaveLength(0);
    expect(h.core.kickAllCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.core.kickAllCount).toBe(1);
    expect(h.core.kicks).toContain([...h.core.rows.keys()][0]);
  });

  it('status derivation', () => {
    h = setupBridge();
    const rt = h.bridge.runtime;
    expect(rt.status()).toEqual({ state: 'ready', doorbell: 'unavailable' });
    h.cloud.state = 'signed_out';
    expect(rt.status()).toEqual({ state: 'signed_out' });
    h.cloud.state = 'revoked';
    expect(rt.status()).toEqual({ state: 'needs_sign_in', reason: 'device_revoked' });
    h.cloud.state = 'undecryptable';
    expect(rt.status()).toEqual({ state: 'locked', reason: 'undecryptable' });
    h.cloud.state = 'locked';
    expect(rt.status()).toEqual({ state: 'locked', reason: 'locked' });
    h.cloud.state = 'secrets_unavailable';
    expect(rt.status()).toEqual({ state: 'locked', reason: 'secrets_unavailable' });
    h.cloud.state = 'needs_update';
    expect(rt.status().state).toBe('ready');
  });

  it('kill switch → disabled, no fetch, read per call', async () => {
    const env: NodeJS.ProcessEnv = { CYBOFLOW_DISABLE_BRIDGE: '1' };
    h = setupBridge({ env });
    expect(h.bridge.runtime.status()).toEqual({ state: 'disabled', reason: 'kill_switch' });
    const e = await swallow(h.bridge.relay.listConnections());
    expect(e).toBeInstanceOf(RelayHttpError);
    expect(h.relay.requests).toHaveLength(0);
    delete env.CYBOFLOW_DISABLE_BRIDGE;
    await h.bridge.relay.listConnections();
    expect(h.relay.requests).toHaveLength(1);
  });

  it('needs_update re-probes after 6 h and returns to ready on 200', async () => {
    h = setupBridge();
    h.relay.protocolRange = { min: 2, max: 2 };
    await swallow(h.bridge.relay.listConnections());
    expect(h.bridge.runtime.status().state).toBe('needs_update');
    expect((await swallow(h.bridge.relay.listConnections())) as RelayHttpError).toMatchObject({ kind: 'paused' });
    expect(h.relay.requests).toHaveLength(1);
    h.relay.protocolRange = { min: 1, max: 1 };
    await vi.advanceTimersByTimeAsync(6 * 3_600_000 - 1);
    expect(h.relay.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.relay.requests).toHaveLength(2);
    expect(h.bridge.runtime.status().state).toBe('ready');
  });

  it('not_entitled re-probes after 15 min and on a cloud state change', async () => {
    h = setupBridge();
    h.relay.entitled = false;
    await swallow(h.bridge.relay.listConnections());
    expect(h.bridge.runtime.status().state).toBe('not_entitled');
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(h.relay.count(/^\/connections$/, 'GET')).toBe(2);
    h.relay.entitled = true;
    h.cloud.setState('needs_update');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.relay.count(/^\/connections$/, 'GET')).toBe(3);
    expect(h.bridge.runtime.status().state).toBe('ready');
  });

  it('not_entitled: at most one probe per 15 min while account refreshes keep succeeding every 60 s', async () => {
    h = setupBridge();
    h.cloud.entitlements = [];
    h.relay.entitled = false;
    await swallow(h.bridge.relay.listConnections());
    expect(h.cloud.refreshCalls).toBe(1);
    await swallow(h.bridge.relay.listConnections());
    expect(h.cloud.refreshCalls).toBe(1);
    const before = h.relay.count(/^\/connections$/, 'GET');
    for (let i = 0; i < 15; i += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      h.cloud.setState('ok');
    }
    expect(h.relay.count(/^\/connections$/, 'GET') - before).toBe(1);
    expect(h.cloud.refreshCalls).toBe(2);
    h.cloud.entitlements = ['bridge'];
    h.relay.entitled = true;
    h.cloud.setState('ok');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.relay.count(/^\/connections$/, 'GET') - before).toBe(2);
    expect(h.bridge.runtime.status().state).toBe('ready');
  });

  it('signedIn after needs_sign_in → ready + sweep requested', async () => {
    h = setupBridge();
    seedRow(h);
    await vi.advanceTimersByTimeAsync(15_000);
    const sweeps = h.core.kickAllCount;
    h.cloud.markRevoked('device_revoked');
    expect(h.bridge.runtime.status()).toEqual({ state: 'needs_sign_in', reason: 'device_revoked' });
    h.cloud.signIn();
    expect(h.bridge.runtime.status().state).toBe('ready');
    expect(h.core.kickAllCount).toBe(sweeps + 1);
  });

  it('offline grace: 119 s of failures → ready; at 120 s → degraded/offline emitted once; success → ready', async () => {
    h = setupBridge();
    h.relay.injectAlways({}, { kind: 'network' });
    await swallow(h.bridge.relay.listConnections());
    const notices = h.core.availabilityNotices.length;
    await vi.advanceTimersByTimeAsync(119_000);
    await swallow(h.bridge.relay.listConnections());
    expect(h.bridge.runtime.status().state).toBe('ready');
    expect(h.core.availabilityNotices.length).toBe(notices);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.bridge.runtime.status()).toMatchObject({ state: 'degraded', reason: 'offline', retryAt: null });
    expect(h.core.availabilityNotices.length).toBe(notices + 1);
    const a = h.bridge.runtime.availability();
    expect(a).toEqual({ state: 'unavailable', message: BRIDGE_COPY.offline, retryAt: null });
    expect(isConnectorCallable(a)).toBe(true);
    h.relay.clearFaults();
    await h.bridge.relay.listConnections();
    expect(h.bridge.runtime.status().state).toBe('ready');
    expect(h.core.availabilityNotices.length).toBe(notices + 2);
  });

  it('rate_limited and relay_unavailable degraded reasons', async () => {
    h = setupBridge();
    h.relay.injectOnce({}, { kind: 'http', status: 429, error: 'rate_limited', retryAfterSec: 300 });
    await swallow(h.bridge.relay.listConnections());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.bridge.runtime.status()).toMatchObject({ state: 'degraded', reason: 'rate_limited' });
    const blocked = h.bridge.runtime.availability();
    expect(blocked.state).toBe('unavailable');
    expect(blocked.message).toBe(BRIDGE_COPY.rate_limited);
    expect(blocked.retryAt).not.toBeNull();
    expect(isConnectorCallable(blocked)).toBe(false);
    h.bridge.dispose();

    h = setupBridge();
    h.relay.disabled = true;
    await swallow(h.bridge.relay.listConnections());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.bridge.runtime.status()).toMatchObject({ state: 'degraded', reason: 'relay_unavailable' });
  });

  it('onStatus deduped', async () => {
    h = setupBridge();
    const n = h.core.availabilityNotices.length;
    await h.bridge.relay.listConnections();
    await h.bridge.relay.listConnections();
    h.cloud.setState('ok');
    expect(h.core.availabilityNotices.length).toBe(n);
    h.cloud.setState('locked');
    h.cloud.setState('locked');
    expect(h.core.availabilityNotices.length).toBe(n + 1);
  });

  it('stop() clears every timer and aborts in-flight fetches', async () => {
    h = setupBridge();
    h.relay.entitled = false;
    await swallow(h.bridge.relay.listConnections());
    h.relay.entitled = true;
    h.relay.injectOnce({}, { kind: 'hang' });
    const pending = swallow(h.bridge.relay.listConnections({ probe: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    h.bridge.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(await pending).toMatchObject({ kind: 'network', code: 'aborted' });
    expect(h.cloud.listenerCount()).toBe(0);
    expect((await swallow(h.bridge.relay.listConnections())) as RelayHttpError).toMatchObject({ kind: 'paused', code: 'stopped' });
  });

  it('availability maps every runtime state', async () => {
    const env: NodeJS.ProcessEnv = {};
    h = setupBridge({ env });
    const own = seedRow(h);
    const other = seedRow(h, { accountId: 'acct_other', relayConnectionId: 'c_other' });
    const broken = seedRow(h, {}, { v: 9 });
    const c = h.connector;
    const ownH = h.core.handle(own.connectionId);
    expect(c.availability()).toEqual({ state: 'ok', message: null, retryAt: null });
    expect(c.availability(ownH)).toEqual({ state: 'ok', message: null, retryAt: null });
    expect(c.availability(h.core.handle(other.connectionId)))
      .toEqual({ state: 'other_account', message: BRIDGE_COPY.other_account, retryAt: null });
    expect(c.availability(h.core.handle(broken.connectionId)))
      .toEqual({ state: 'disabled', message: BRIDGE_COPY.invalid_remote, retryAt: null });
    expect(h.core.captures.filter((x) => x.tags?.relayCode === 'invalid_remote')).toHaveLength(1);
    c.availability(h.core.handle(broken.connectionId));
    expect(h.core.captures.filter((x) => x.tags?.relayCode === 'invalid_remote')).toHaveLength(1);

    env.CYBOFLOW_DISABLE_BRIDGE = '1';
    expect(c.availability(h.core.handle(other.connectionId)))
      .toEqual({ state: 'disabled', message: BRIDGE_COPY.disabled, retryAt: null });
    delete env.CYBOFLOW_DISABLE_BRIDGE;

    const cases: Array<[FakeCloud['state'], string, string]> = [
      ['signed_out', 'signed_out', BRIDGE_COPY.signed_out],
      ['locked', 'locked', BRIDGE_COPY.locked],
      ['secrets_unavailable', 'locked', BRIDGE_COPY.secrets_unavailable],
      ['undecryptable', 'locked', BRIDGE_COPY.undecryptable],
      ['revoked', 'device_revoked', BRIDGE_COPY.needs_sign_in],
    ];
    for (const [cloudState, state, message] of cases) {
      h.cloud.state = cloudState;
      expect(c.availability(h.core.handle(other.connectionId))).toEqual({ state, message, retryAt: null });
    }
    h.cloud.state = 'ok';

    h.relay.protocolRange = { min: 2, max: 2 };
    await swallow(h.bridge.relay.listConnections());
    expect(c.availability(ownH)).toEqual({ state: 'needs_update', message: BRIDGE_COPY.needs_update, retryAt: null });
    h.relay.protocolRange = { min: 1, max: 1 };
    await h.bridge.relay.listConnections({ probe: true });

    h.relay.entitled = false;
    await swallow(h.bridge.relay.listConnections());
    expect(c.availability(ownH)).toEqual({ state: 'not_entitled', message: BRIDGE_COPY.not_entitled, retryAt: null });
    h.relay.entitled = true;
    await h.bridge.relay.listConnections({ probe: true });

    h.relay.injectOnce({}, { kind: 'http', status: 503, error: 'accounts_unavailable', retryAfterSec: 30 });
    await swallow(h.bridge.relay.listConnections());
    expect(c.availability(ownH)).toEqual({
      state: 'unavailable', message: BRIDGE_COPY.relay_unavailable, retryAt: new Date(Date.now() + 30_000).toISOString(),
    });
    // A relay block is a paused refusal (attempt not counted) that still carries its wait.
    await expect(c.pull(ownH, null, opts())).rejects.toMatchObject({
      kind: 'paused', code: 'rate_limited', retryAfterMs: 30_000, message: BRIDGE_COPY.relay_unavailable,
    });
  });

  it('locked cloud: zero requests; recovers and sweeps on stateChanged', async () => {
    const relay = new FakeRelay();
    const cloud = new FakeCloud({ fetch: relay.fetch, state: 'locked' });
    h = setupBridge({ relay, cloud });
    const row = seedRow(h);
    await vi.advanceTimersByTimeAsync(20_000);
    const handle = h.core.handle(row.connectionId);
    await expect(h.connector.pull(handle, null, opts())).rejects.toMatchObject({ kind: 'paused', code: 'locked' });
    await expect(h.connector.send(handle, {
      id: 'm1', kind: 'text', body: 'x', links: [], contentHash: 'h', isProbe: false, createdAt: new Date().toISOString(),
    }, opts())).rejects.toMatchObject({ kind: 'paused', code: 'locked' });
    await h.core.drain(h.connector, row.connectionId);
    expect(relay.requests).toHaveLength(0);
    expect(cloud.tokenCalls).toBe(0);
    expect(h.core.kickAllCount).toBe(0);
    cloud.setState('ok');
    expect(h.core.kickAllCount).toBe(1);
    // The seeded connection does not exist on the relay: the point is that a pull now goes out.
    await swallow(h.core.drain(h.connector, row.connectionId));
    expect(relay.count(/inbound/)).toBe(1);
  });

  it('cloud undecryptable → availability locked with the undecryptable copy, zero requests', async () => {
    const relay = new FakeRelay();
    const cloud = new FakeCloud({ fetch: relay.fetch, state: 'undecryptable' });
    h = setupBridge({ relay, cloud });
    const row = seedRow(h);
    const handle = h.core.handle(row.connectionId);
    expect(h.connector.availability(handle)).toEqual({ state: 'locked', message: BRIDGE_COPY.undecryptable, retryAt: null });
    await expect(h.connector.verify(handle, opts())).rejects.toMatchObject({ kind: 'paused', code: 'locked' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(relay.requests).toHaveLength(0);
  });
});
