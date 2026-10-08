/**
 * Agents & Environments wiring as index.ts composes it: composePersistentAgents with the real
 * wireBridgeConnector and a cloud account handle.
 *
 * - the Bridge is registered when a cloud handle exists, and nothing is registered without one;
 * - start() with zero connections makes no relay request (no network on boot);
 * - stop() leaves no timer behind (quit drain);
 * - the Settings toggle off → on restarts the Bridge without a restart of the app: a pull reaches the
 *   relay again and the vendor's message lands in the store.
 *
 * Each composition owns its own ConnectorRegistry, so two compositions in one file need no global reset.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { ConfigManager } from '../services/configManager';
import {
  composePersistentAgents,
  type PersistentAgentsComposition,
  type PersistentAgentsCompositionDeps,
} from '../persistentAgentsComposition';
import { _resetPersistentAgentsFacadeForTesting } from '../orchestrator/persistentAgentsBridge';
import type { ConnectorWiringContext } from '../services/persistentAgents/connectorContract';
import { wireBridgeConnector } from '../services/persistentAgents/connectors/bridge';
import { FakeCloud } from '../services/persistentAgents/connectors/bridge/__tests__/fakeCloud';
import { FakeRelay } from '../services/persistentAgents/connectors/bridge/__tests__/fakeRelay';
import { makeLogger, makeTestDb } from '../services/persistentAgents/__tests__/fakeConnector';
import type { FetchLike } from '../services/cloud/fetchLike';

class FakeConfig extends EventEmitter {
  enabled = true;
  isAgentsAvailable(): boolean { return true; }
  isAgentsEnabled(): boolean { return this.enabled; }
  getConfig(): ReturnType<ConfigManager['getConfig']> {
    return { agents: { enabled: this.enabled } } as ReturnType<ConfigManager['getConfig']>;
  }
  toggle(enabled: boolean): void {
    this.enabled = enabled;
    this.emit('config-updated', this.getConfig());
  }
}

/** A WebSocket that must never be constructed (no doorbell without a live Bridge connection). */
class ForbiddenWebSocket {
  constructor() {
    throw new Error('the doorbell must not open in this test');
  }
}

let raw: Database.Database;
let raws: Database.Database[];
let comps: PersistentAgentsComposition[];
let config: FakeConfig;

function compose(over: Partial<PersistentAgentsCompositionDeps>): PersistentAgentsComposition {
  const t = makeTestDb();
  raw = t.raw;
  raws.push(t.raw);
  const c = composePersistentAgents({
    db: t.db,
    configManager: config as unknown as PersistentAgentsCompositionDeps['configManager'],
    logger: makeLogger(),
    cloud: null,
    captureSeamError: vi.fn(),
    encrypt: (plain) => Buffer.from(plain),
    decrypt: (cipher) => cipher.toString(),
    ...over,
  });
  comps.push(c);
  return c;
}

async function until(cond: () => boolean, maxMs = 60_000): Promise<void> {
  for (let t = 0; t <= maxMs; t += 250) {
    if (cond()) return;
    await vi.advanceTimersByTimeAsync(250);
  }
  if (!cond()) throw new Error('condition not reached in fake time');
}

beforeEach(() => {
  comps = [];
  raws = [];
  config = new FakeConfig();
  vi.useFakeTimers({ now: new Date('2026-10-07T12:00:00.000Z') });
  vi.stubGlobal('WebSocket', ForbiddenWebSocket);
});

afterEach(() => {
  for (const c of comps.splice(0)) c.stop();
  _resetPersistentAgentsFacadeForTesting();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const r of raws) r.close();
});

describe('agents wiring (composePersistentAgents + wireBridgeConnector)', () => {
  it('registers the Bridge, makes no request on boot with zero connections, and stop() leaves no timers', async () => {
    const fetch = vi.fn<FetchLike>(() => Promise.reject(new Error('no request expected')));
    const cloud = new FakeCloud({ fetch });
    const c = compose({ cloud, wireConnectors: wireBridgeConnector });
    expect(c.service.listConnectors().map((v) => v.definition.id)).toContain('bridge');
    const tokenCallsBefore = cloud.tokenCalls;

    c.start();
    expect(c.service.status()).toMatchObject({ running: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).not.toHaveBeenCalled();
    expect(cloud.tokenCalls).toBe(tokenCallsBefore);

    c.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(config.listenerCount('config-updated')).toBe(0);
  });

  it('a composition without a cloud account registers no connector (each composition owns its registry)', () => {
    const withCloud = compose({ cloud: new FakeCloud(), wireConnectors: wireBridgeConnector });
    const without = compose({ cloud: null, wireConnectors: wireBridgeConnector });
    expect(withCloud.service.listConnectors().map((v) => v.definition.id)).toEqual(['bridge']);
    expect(without.service.listConnectors()).toEqual([]);
    expect(without.registry).not.toBe(withCloud.registry);
    without.start();
    without.stop();
    withCloud.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('config toggle off → on → a Bridge pull reaches the relay again', async () => {
    const relay = new FakeRelay();
    const cloud = new FakeCloud({ fetch: relay.fetch });
    let ctx: ConnectorWiringContext | null = null;
    const c = compose({
      cloud,
      wireConnectors: (wctx) => {
        ctx = wctx;
        return wireBridgeConnector(wctx, { createWebSocket: null, env: {}, random: () => 1 });
      },
    });
    c.start();
    const kick = (id: string): void => {
      if (ctx === null) throw new Error('no wiring context');
      ctx.kick(id);
    };
    const { agentId, connectionId } = await c.service.connect({
      agent: { displayName: 'Scout', vendor: 'openai-dots' },
      connection: { kind: 'bridge', connectorId: 'bridge', transport: 'relay-mcp' },
    });
    const relayId = (raw.prepare('SELECT remote_id FROM persistent_agent_connections WHERE id = ?').get(connectionId) as { remote_id: string }).remote_id;
    const bodies = (): string[] => c.service.getThread({ agentId, limit: 50 }).messages
      .filter((m) => m.direction === 'in').map((m) => m.body);

    relay.vendorSend(relayId, { body: 'before off' });
    kick(connectionId);
    await until(() => bodies().includes('before off'));

    config.toggle(false);
    expect(c.service.status().running).toBe(false);
    const pullsWhileOff = relay.count(/\/inbound(\?|$)/);
    expect(pullsWhileOff).toBeGreaterThan(0);
    relay.vendorSend(relayId, { body: 'after on' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(relay.count(/\/inbound(\?|$)/)).toBe(pullsWhileOff);
    expect(bodies()).not.toContain('after on');

    config.toggle(true);
    expect(c.service.status().running).toBe(true);
    kick(connectionId);
    await until(() => bodies().includes('after on'));
    expect(relay.count(/\/inbound(\?|$)/)).toBeGreaterThan(pullsWhileOff);
    expect(relay.inboundRows(relayId)).toEqual([]);
  });
});
