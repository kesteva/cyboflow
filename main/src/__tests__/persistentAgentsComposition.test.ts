/**
 * persistentAgentsComposition: boot gating, boot order (requeue before the first pull), the live config
 * toggle (off → on restarts pump, outbox and connector wiring), quit stop, and the wiring context.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import type { ConfigManager } from '../services/configManager';
import {
  composePersistentAgents,
  type PersistentAgentsComposition,
  type PersistentAgentsCompositionDeps,
} from '../persistentAgentsComposition';
import {
  _resetPersistentAgentsFacadeForTesting,
  peekPersistentAgentsFacade,
  persistentAgentEvents,
  PERSISTENT_AGENTS_CHANNEL,
} from '../orchestrator/persistentAgentsBridge';
import { PERSISTENT_AGENTS_KILL_SWITCH_ENV } from '../services/persistentAgents/flags';
import type { ConnectorWiringContext } from '../services/persistentAgents/connectorContract';
import type { PersistentAgentsChangedEvent } from '../../../shared/types/persistentAgents';
import { BRIDGE_DESCRIPTOR } from '../../../shared/types/__tests__/persistentAgentsFixtures';
import { createFakeConnector, makeLogger, makeTestDb, type FakeConnector } from '../services/persistentAgents/__tests__/fakeConnector';

const NOW = '2026-10-07T12:00:00.000Z';

class FakeConfig extends EventEmitter {
  enabled = true;
  available = true;
  isAgentsAvailable(): boolean { return this.available; }
  isAgentsEnabled(): boolean { return this.available && this.enabled; }
  getConfig(): ReturnType<ConfigManager['getConfig']> {
    return { agents: { enabled: this.enabled } } as ReturnType<ConfigManager['getConfig']>;
  }
  toggle(enabled: boolean): void {
    this.enabled = enabled;
    this.emit('config-updated', this.getConfig());
  }
}

let raw: Database.Database;
let deps: PersistentAgentsCompositionDeps;
let config: FakeConfig;
let fake: FakeConnector;
let wiringCalls: string[];
let ctxSeen: ConnectorWiringContext | null;
let decrypt: ReturnType<typeof vi.fn>;
let encrypt: ReturnType<typeof vi.fn>;
const comps: PersistentAgentsComposition[] = [];

function compose(over: Partial<PersistentAgentsCompositionDeps> = {}): PersistentAgentsComposition {
  const c = composePersistentAgents({ ...deps, ...over });
  comps.push(c);
  return c;
}

function seedRows(): void {
  const ins = (sql: string, ...p: unknown[]): void => { raw.prepare(sql).run(...p); };
  ins(`INSERT INTO persistent_agents (id, handle, display_name, vendor, created_at, updated_at) VALUES ('a1', 'dot', 'Dot', 'openai-dots', ?, ?)`, NOW, NOW);
  ins(`INSERT INTO persistent_agent_connections (id, agent_id, kind, connector_id, connector_version, transport, state, capabilities_json, is_current, remote_id, relay_epoch, created_at, updated_at, verified_at)
       VALUES ('c1', 'a1', 'bridge', 'bridge', 1, 'relay-mcp', 'verified', ?, 1, 'r1', 1, ?, ?, ?)`,
  JSON.stringify({ descriptor: BRIDGE_DESCRIPTOR, descriptorVersion: 1, observed: {} }), NOW, NOW, NOW);
  ins(`INSERT INTO persistent_agent_messages (id, agent_id, connection_id, direction, author, kind, body, links_json, send_state, send_attempts, claim_generation, created_at, updated_at)
       VALUES ('m1', 'a1', 'c1', 'out', 'user', 'text', 'hi', '[]', 'in_flight', 1, 1, ?, ?)`, NOW, NOW);
}
const sendState = (id: string): string => (raw.prepare('SELECT send_state AS s FROM persistent_agent_messages WHERE id = ?').get(id) as { s: string }).s;

beforeEach(() => {
  const t = makeTestDb();
  raw = t.raw;
  config = new FakeConfig();
  fake = createFakeConnector();
  wiringCalls = [];
  ctxSeen = null;
  decrypt = vi.fn(() => 'secret');
  encrypt = vi.fn(() => Buffer.from('c'));
  deps = {
    db: t.db,
    // on/off return `this` (a full ConfigManager); the composition only uses the picked methods.
    configManager: config as unknown as PersistentAgentsCompositionDeps['configManager'],
    logger: makeLogger(),
    cloud: null,
    captureSeamError: vi.fn(),
    encrypt,
    decrypt,
    wireConnectors: (ctx) => {
      ctxSeen = ctx;
      ctx.register(fake.registration);
      return { start: () => { wiringCalls.push('start'); }, stop: () => { wiringCalls.push('stop'); } };
    },
  };
});

afterEach(() => {
  for (const c of comps.splice(0)) c.stop();
  delete process.env[PERSISTENT_AGENTS_KILL_SWITCH_ENV];
  _resetPersistentAgentsFacadeForTesting();
  vi.useRealTimers();
  raw.close();
});

describe('composePersistentAgents', () => {
  it('construction injects the facade and touches no keychain', () => {
    const c = compose();
    expect(peekPersistentAgentsFacade()).toBe(c.service);
    expect(decrypt).not.toHaveBeenCalled();
    expect(encrypt).not.toHaveBeenCalled();
  });

  it('start() while not running arms no timer and boots nothing', () => {
    vi.useFakeTimers();
    config.enabled = false;
    seedRows();
    const c = compose();
    c.start();
    expect(vi.getTimerCount()).toBe(0);
    expect(wiringCalls).toEqual([]);
    expect(sendState('m1')).toBe('in_flight');
    expect(c.service.status()).toMatchObject({ devBuild: true, configEnabled: false, enabled: false, running: false });
  });

  it('running → in-flight sends are requeued before the first pull', async () => {
    vi.useFakeTimers({ now: new Date(NOW) });
    seedRows();
    const statesAtPull: string[] = [];
    const pull = fake.connector.pull.bind(fake.connector);
    fake.connector.pull = async (h, cursor, o) => { statesAtPull.push(sendState('m1')); return pull(h, cursor, o); };
    const c = compose();
    c.start();
    expect(wiringCalls).toEqual(['start']);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(statesAtPull.length).toBeGreaterThan(0);
    expect(statesAtPull[0]).not.toBe('in_flight');
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('kill switch → status().killed and no boot', () => {
    vi.useFakeTimers();
    process.env[PERSISTENT_AGENTS_KILL_SWITCH_ENV] = '1';
    seedRows();
    const c = compose();
    c.start();
    expect(c.service.status()).toMatchObject({ enabled: true, killed: true, running: false });
    expect(vi.getTimerCount()).toBe(0);
    expect(wiringCalls).toEqual([]);
    expect(sendState('m1')).toBe('in_flight');
  });

  it('config toggle stops then restarts the wiring and emits status', () => {
    vi.useFakeTimers();
    const events: PersistentAgentsChangedEvent[] = [];
    const l = (e: PersistentAgentsChangedEvent): void => { events.push(e); };
    persistentAgentEvents.on(PERSISTENT_AGENTS_CHANNEL, l);
    const c = compose();
    c.start();
    config.toggle(false);
    config.toggle(true);
    persistentAgentEvents.off(PERSISTENT_AGENTS_CHANNEL, l);
    expect(wiringCalls).toEqual(['start', 'stop', 'start']);
    expect(events.filter((e) => e.kind === 'status').length).toBeGreaterThanOrEqual(3);
    expect(c.service.status().running).toBe(true);
  });

  it('a toggle on after a cold start boots once', () => {
    vi.useFakeTimers();
    config.enabled = false;
    const c = compose();
    c.start();
    expect(wiringCalls).toEqual([]);
    config.toggle(true);
    config.toggle(true);
    expect(wiringCalls).toEqual(['start']);
  });

  it('stop() is synchronous and idempotent and leaves no timers', () => {
    vi.useFakeTimers();
    const c = compose();
    c.start();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const t0 = performance.now();
    c.stop();
    expect(performance.now() - t0).toBeLessThan(50);
    c.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(wiringCalls).toEqual(['start', 'stop', 'stop']);
    expect(config.listenerCount('config-updated')).toBe(0);
  });

  it('disable → enable → send is claimed and sent', async () => {
    const c = compose();
    c.start();
    const { agentId } = await c.service.connect({ agent: { displayName: 'Dot', vendor: 'openai-dots' }, connection: { kind: 'bridge', connectorId: 'bridge', transport: 'relay-mcp' } });
    config.toggle(false);
    await expect(c.service.send({ agentId, text: 'while off' })).rejects.toMatchObject({ name: 'PersistentAgentsDisabledError' });
    config.toggle(true);
    const { messageId } = await c.service.send({ agentId, text: 'after on' });
    await vi.waitFor(() => expect(sendState(messageId)).toBe('on_bridge'));
    expect(fake.calls.filter((x) => x.method === 'send')).toHaveLength(1);
  });

  it('boot recovery never aborts a connect this process started after boot', async () => {
    const c = compose();
    c.start();
    const r = await c.service.connect({ agent: { displayName: 'Fresh', vendor: 'openai-dots' }, connection: { kind: 'bridge', connectorId: 'bridge', transport: 'relay-mcp' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(raw.prepare('SELECT connect_state FROM persistent_agent_connections WHERE id = ?').get(r.connectionId)).toEqual({ connect_state: null });
  });

  it('two compositions in one process do not share a registry', () => {
    const a = compose();
    const other = createFakeConnector({ kind: 'native' });
    const b = compose({ wireConnectors: (ctx) => { ctx.register(other.registration); return { start() {}, stop() {} }; } });
    expect(a.registry).not.toBe(b.registry);
    expect(a.registry.list().map((d) => d.id)).toEqual(['bridge']);
    expect(b.registry.list().map((d) => d.id)).toEqual(['claude-managed-agents']);
  });

  it('ctx.listHandles returns live current/swap rows of one connector only', () => {
    compose();
    const ins = (sql: string, ...p: unknown[]): void => { raw.prepare(sql).run(...p); };
    const caps = JSON.stringify({ descriptor: BRIDGE_DESCRIPTOR, descriptorVersion: 1, observed: {} });
    ins(`INSERT INTO persistent_agents (id, handle, display_name, vendor, created_at, updated_at) VALUES ('a1', 'a1', 'A', 'other', ?, ?)`, NOW, NOW);
    ins(`INSERT INTO persistent_agents (id, handle, display_name, vendor, archived_at, created_at, updated_at) VALUES ('a2', 'a2', 'B', 'other', ?, ?, ?)`, NOW, NOW, NOW);
    ins(`INSERT INTO persistent_agents (id, handle, display_name, vendor, created_at, updated_at) VALUES ('a3', 'a3', 'C', 'other', ?, ?)`, NOW, NOW);
    const conn = (id: string, agent: string, extra: { state?: string; current?: number; swap?: string | null; connect?: string | null; connector?: string }): void => {
      ins(`INSERT INTO persistent_agent_connections (id, agent_id, kind, connector_id, connector_version, state, capabilities_json, is_current, swap_state, connect_state, created_at, updated_at)
           VALUES (?, ?, 'bridge', ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      id, agent, extra.connector ?? 'bridge', extra.state ?? 'verified', caps, extra.current ?? 0, extra.swap ?? null, extra.connect ?? null, NOW, NOW);
    };
    conn('live', 'a1', { current: 1 });
    conn('swap', 'a1', { swap: 'awaiting_verify' });
    conn('revoked', 'a1', {});
    conn('archived', 'a2', { current: 1 });
    conn('creating', 'a3', { current: 1, connect: 'creating_remote' });
    conn('otherConnector', 'a3', { swap: 'awaiting_verify', connector: 'other-one' });
    raw.prepare(`UPDATE persistent_agent_connections SET state = 'revoked' WHERE id = 'revoked'`).run();
    expect(ctxSeen?.listHandles('bridge').map((h) => h.connectionId).sort()).toEqual(['live', 'swap']);
  });

  it('ctx.notifyAvailabilityChanged emits a connection change for every agent', () => {
    compose();
    const events: PersistentAgentsChangedEvent[] = [];
    const l = (e: PersistentAgentsChangedEvent): void => { events.push(e); };
    persistentAgentEvents.on(PERSISTENT_AGENTS_CHANNEL, l);
    ctxSeen?.notifyAvailabilityChanged('bridge');
    persistentAgentEvents.off(PERSISTENT_AGENTS_CHANNEL, l);
    expect(events).toEqual([{ kind: 'connection', agentId: null }]);
  });

  it('ctx.onConnectionsChanged fires for agents/connection changes only and unsubscribes', () => {
    compose();
    const listener = vi.fn();
    const off = ctxSeen?.onConnectionsChanged(listener);
    persistentAgentEvents.emit(PERSISTENT_AGENTS_CHANNEL, { kind: 'connection', agentId: 'x' });
    persistentAgentEvents.emit(PERSISTENT_AGENTS_CHANNEL, { kind: 'unread', agentId: 'x' });
    persistentAgentEvents.emit(PERSISTENT_AGENTS_CHANNEL, { kind: 'agents', agentId: null });
    off?.();
    persistentAgentEvents.emit(PERSISTENT_AGENTS_CHANNEL, { kind: 'agents', agentId: null });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
