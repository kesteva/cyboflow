/**
 * Live test against the staging relay. Skipped unless CYBOFLOW_BRIDGE_STAGING_DEVICE_FILE names a JSON file
 * `{ "accountId": string, "deviceId": string, "token": "cbd_..." }` (mode 0600, outside the repo) for a
 * Bridge-entitled staging device. Never runs in CI. The file's contents are never printed.
 *
 * Run: cd main && CYBOFLOW_BRIDGE_STAGING_DEVICE_FILE=/path/device.json \
 *        npx vitest run src/services/persistentAgents/connectors/bridge/__tests__/staging
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLOUD_STAGING_ORIGIN } from '../../../../../../../../shared/types/cloudOrigins';
import { Doorbell } from '../../doorbell';
import { createNodeWebSocketFactory } from '../../doorbellSocket';
import { createBridge, type BridgeInstance } from '../../index';
import { RelayHttpError } from '../../relayErrors';
import { FakeCloud, fakeDevice } from '../fakeCloud';
import { connectRequest, FakeCore, opts } from '../fakeCore';

const DEVICE_FILE = process.env.CYBOFLOW_BRIDGE_STAGING_DEVICE_FILE ?? '';
const ORIGIN = (process.env.CYBOFLOW_BRIDGE_STAGING_ORIGIN ?? CLOUD_STAGING_ORIGIN).replace(/\/$/, '');
const enabled = DEVICE_FILE.length > 0;
const LABEL_PREFIX = 'cyboflow-desktop-staging-test';
const RUN = `${Date.now().toString(36)}`;

interface DeviceFile { accountId: string; deviceId: string; token: string }

function readDevice(): DeviceFile {
  const raw = JSON.parse(readFileSync(DEVICE_FILE, 'utf8')) as Partial<DeviceFile>;
  if (typeof raw.accountId !== 'string' || typeof raw.deviceId !== 'string' || typeof raw.token !== 'string') {
    throw new Error('staging device file is missing accountId / deviceId / token');
  }
  return { accountId: raw.accountId, deviceId: raw.deviceId, token: raw.token };
}

/** Global fetch that refuses to send the device token to any host but the staging origin's. */
function guardedFetch(): typeof fetch {
  const allowedHost = new URL(ORIGIN).host;
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1] ?? '';
    if (auth.includes('cbd_') && url.host !== allowedHost) throw new Error('device token aimed at a foreign host');
    return fetch(input, init);
  }) as typeof fetch;
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
}

describe.skipIf(!enabled)('Bridge against staging', () => {
  let device: DeviceFile;
  let cloud: FakeCloud;
  let core: FakeCore;
  let bridge: BridgeInstance;
  const created: string[] = [];
  let connectionId = '';
  let relayId = '';
  let httpBase = '';
  let vendorToken = '';

  beforeAll(async () => {
    device = readDevice();
    const fetchImpl = guardedFetch();
    cloud = new FakeCloud({
      fetch: fetchImpl,
      device: fakeDevice({ origin: ORIGIN, accountId: device.accountId, deviceId: device.deviceId }),
      token: device.token,
    });
    core = new FakeCore(cloud);
    bridge = createBridge({ ctx: core, cloud, fetch: fetchImpl, appVersion: 'staging-test', createWebSocket: null, env: {} });
    core.register({ definition: bridge.connector.definition, factory: () => bridge.connector });
    bridge.start();
    const list = await bridge.relay.listConnections();
    for (const c of list.connections) {
      if (c.state === 'active' && (c.label ?? '').startsWith(LABEL_PREFIX)) {
        try {
          await bridge.relay.revoke(c.id);
        } catch {
          // leaked from an earlier run; best effort
        }
      }
    }
  }, 120_000);

  afterAll(async () => {
    for (const id of created) {
      for (let i = 0; i < 5; i += 1) {
        try {
          await bridge.relay.revoke(id);
          break;
        } catch (e) {
          if (!(e instanceof RelayHttpError) || e.kind !== 'revoke_pending') break;
          await new Promise((r) => setTimeout(r, 5_000));
        }
      }
    }
    bridge?.dispose();
  }, 120_000);

  it('426 for an unsupported protocol header', async () => {
    const res = await fetch(`${ORIGIN}/bridge/v1/connections`, {
      headers: { Authorization: `Bearer ${device.token}`, 'Cyboflow-Relay-Protocol': '99' },
    });
    expect(res.status).toBe(426);
    expect(((await res.json()) as { error?: string }).error).toBe('unsupported_protocol');
    expect(res.headers.get('Cyboflow-Relay-Protocol-Min')).not.toBeNull();
    expect(res.headers.get('Cyboflow-Relay-Protocol-Max')).not.toBeNull();
  });

  it('401 for a malformed token', async () => {
    const res = await fetch(`${ORIGIN}/bridge/v1/connections`, {
      headers: { Authorization: 'Bearer cbd_short', 'Cyboflow-Relay-Protocol': '1' },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error?: string }).error).toBe('unauthorized');
  });

  it('create relay-http connection', async () => {
    let outcome;
    try {
      outcome = await bridge.connector.connect(
        connectRequest('relay-http', { label: `${LABEL_PREFIX}-${RUN}`, handle: 'stagingbot' }),
        opts(AbortSignal.timeout(15_000)),
      );
    } catch (e) {
      if ((e as { kind?: string }).kind === 'not_entitled') throw new Error('staging device lacks the bridge entitlement');
      throw e;
    }
    created.push(outcome.remoteId);
    relayId = outcome.remoteId;
    connectionId = core.addFromOutcome(outcome, { handle: 'stagingbot' }).connectionId;
    httpBase = outcome.pairing?.httpBase ?? '';
    vendorToken = outcome.pairing?.oneTimeToken ?? '';
    expect(new URL(httpBase).host).not.toBe(new URL(ORIGIN).host);
    expect(new URL(outcome.pairing?.mcpUrl ?? '').host).not.toBe(new URL(ORIGIN).host);
    expect(vendorToken.startsWith('cbh_')).toBe(true);
  });

  it('vendor message drains and acks', async () => {
    const res = await fetch(`${httpBase}/inbox`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${vendorToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: `stg-in-${RUN}`, text: 'hello' }),
    });
    expect(res.ok).toBe(true);
    await core.drain(bridge.connector, connectionId);
    expect(core.messagesFor(connectionId).filter((m) => m.author === 'agent').map((m) => m.body)).toEqual(['hello']);
    const acks = core.trace.filter((t) => t === 'ack').length;
    expect(acks).toBeGreaterThan(0);
    const again = await core.drain(bridge.connector, connectionId);
    expect(again.inserted).toBe(0);
  });

  it('send is idempotent', async () => {
    const m = {
      id: `stg-out-${RUN}`, kind: 'text' as const, body: 'hi from staging', links: [], contentHash: 'h', isProbe: false,
      createdAt: new Date().toISOString(),
    };
    core.addOutbound(m.id, connectionId);
    const first = await bridge.connector.send(core.handle(connectionId), m, opts(AbortSignal.timeout(30_000)));
    const second = await bridge.connector.send(core.handle(connectionId), m, opts(AbortSignal.timeout(30_000)));
    expect(second.duplicate).toBe(true);
    expect(second.remoteOutSeq).toBe(first.remoteOutSeq);
  });

  it('pickup receipt, then round trip after a vendor reply', async () => {
    const out = await fetch(`${httpBase}/outbox`, { headers: { Authorization: `Bearer ${vendorToken}` } });
    expect(out.ok).toBe(true);
    await core.drain(bridge.connector, connectionId);
    expect(core.outbound.get(`stg-out-${RUN}`)?.pickedUpAt).not.toBeNull();
    await new Promise((r) => setTimeout(r, 1_100));
    await fetch(`${httpBase}/inbox`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${vendorToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: `stg-reply-${RUN}`, text: 'lantern' }),
    });
    await core.drain(bridge.connector, connectionId);
    expect(core.row(connectionId).state).toBe('verified');
  });

  it.skipIf(createNodeWebSocketFactory() === null)('doorbell rings', async () => {
    const kicks: string[] = [];
    const doorbell = new Doorbell({
      createSocket: createNodeWebSocketFactory(),
      cloud,
      runtime: bridge.runtime,
      relay: bridge.relay,
      listHandles: () => core.listHandles('bridge'),
      findLocalId: (id) => core.findConnectionIdByRemoteId('bridge', id),
      kick: (id) => kicks.push(id),
      reportConnectionGone: () => undefined,
      appVersion: 'staging-test',
      logger: core.logger,
    });
    doorbell.reconcile();
    expect(await waitFor(() => doorbell.state() === 'open', 10_000)).toBe(true);
    kicks.length = 0;
    await fetch(`${httpBase}/inbox`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${vendorToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: `stg-ring-${RUN}`, text: 'ring' }),
    });
    expect(await waitFor(() => kicks.includes(connectionId), 10_000)).toBe(true);
    doorbell.stop();
    expect(doorbell.state()).toBe('stopped');
  }, 60_000);

  it('repair bumps the epoch and re-drain dedupes', async () => {
    const before = core.messagesFor(connectionId).length;
    const repaired = await bridge.connector.repairPairing(core.handle(connectionId), opts(AbortSignal.timeout(15_000)));
    core.applyRepair(connectionId, repaired);
    await core.drain(bridge.connector, connectionId);
    const ids = core.messagesFor(connectionId).map((m) => m.remoteEventId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(core.messagesFor(connectionId).length).toBeGreaterThanOrEqual(before);
  });

  it('revoke', async () => {
    await bridge.connector.disconnect(core.handle(connectionId), opts(AbortSignal.timeout(30_000)));
    await expect(bridge.connector.pull(core.handle(connectionId), core.row(connectionId).inboundCursor, opts(AbortSignal.timeout(15_000))))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(revoked|not_found)$/) });
    expect(relayId).not.toBe('');
  });
});
