/**
 * The Bridge connector against the REAL persistent-agents core: a temp-file database built by the full
 * migration chain (DatabaseService.initialize()), the real PersistentAgentStore / InboundPump / outbox /
 * connection service composed by composePersistentAgents, and wireBridgeConnector. The relay is the
 * in-process FakeRelay (a behavioural model of the public desktop API) and the cloud account is a
 * scriptable handle. Pulls are driven through the real InboundPump.kick.
 *
 * Lives beside agentsWiring.test.ts (not under the Bridge __tests__ directory) so the Bridge directory
 * never imports core internals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { DatabaseService } from '../database/database';
import { makeDatabaseLike } from '../orchestrator/loggerAdapter';
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
import type { FetchLike } from '../services/cloud/fetchLike';
import type { LoggerLike } from '../orchestrator/types';

const MIG_DIR = join(__dirname, '..', 'database', 'migrations');
const PA_TABLES = [
  'vendor_credentials',
  'persistent_agents',
  'persistent_agent_connections',
  'persistent_agent_messages',
  'persistent_agent_events',
  'persistent_agent_usage',
];

class FakeConfig extends EventEmitter {
  enabled = true;
  isAgentsAvailable(): boolean { return true; }
  isAgentsEnabled(): boolean { return this.enabled; }
  getConfig(): ReturnType<ConfigManager['getConfig']> {
    return { agents: { enabled: this.enabled } } as ReturnType<ConfigManager['getConfig']>;
  }
}

function quietLogger(): LoggerLike {
  return { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
}

interface Booted {
  comp: PersistentAgentsComposition;
  ctx: ConnectorWiringContext;
  cloud: FakeCloud;
  capture: ReturnType<typeof vi.fn>;
}

let dir: string;
let dbService: DatabaseService | null;
let relay: FakeRelay;
let comps: PersistentAgentsComposition[];
/** Pull page sizes (items per non-empty /inbound response), in order. */
let pages: number[];
/** For every ack request: its body and how many inbound rows of that connection were committed at that moment. */
let acks: Array<{ epoch: number; upTo: number; committedIn: number }>;

function raw(): Database.Database {
  if (!dbService) throw new Error('database not open');
  return dbService.getDb();
}

function openDb(): void {
  dbService = new DatabaseService(join(dir, 'test.db'));
  dbService.setMigrationsDirForTesting(MIG_DIR);
  dbService.initialize();
}

function closeDb(): void {
  try { dbService?.close(); } catch { /* already closed */ }
  dbService = null;
}

function connRow(connectionId: string): { remote_id: string; inbound_cursor: string | null; relay_epoch: number | null; remote_json: string | null; state: string } {
  return raw().prepare('SELECT remote_id, inbound_cursor, relay_epoch, remote_json, state FROM persistent_agent_connections WHERE id = ?')
    .get(connectionId) as { remote_id: string; inbound_cursor: string | null; relay_epoch: number | null; remote_json: string | null; state: string };
}

function inboundCount(connectionId: string): number {
  return (raw().prepare(`SELECT COUNT(*) AS n FROM persistent_agent_messages WHERE connection_id = ? AND direction = 'in'`)
    .get(connectionId) as { n: number }).n;
}

function messages(connectionId: string): Array<{ id: string; direction: string; author: string; kind: string; body: string; remote_event_id: string | null; picked_up_at: string | null }> {
  return raw().prepare(
    `SELECT id, direction, author, kind, body, remote_event_id, picked_up_at
       FROM persistent_agent_messages WHERE connection_id = ? ORDER BY created_at, rowid`,
  ).all(connectionId) as Array<{ id: string; direction: string; author: string; kind: string; body: string; remote_event_id: string | null; picked_up_at: string | null }>;
}

function dumpTables(): string {
  return PA_TABLES.map((t) => JSON.stringify(raw().prepare(`SELECT * FROM ${t}`).all())).join('\n');
}

/** Wraps the relay's fetch: records page sizes and, at every ack, how much was already committed. */
function instrumentedFetch(): FetchLike {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url).pathname;
    if (path.endsWith('/ack') && typeof init?.body === 'string') {
      const body = JSON.parse(init.body) as { epoch: number; upTo: number };
      const relayId = path.split('/').at(-2) ?? '';
      const local = raw().prepare('SELECT id FROM persistent_agent_connections WHERE remote_id = ?').get(relayId) as { id: string } | undefined;
      acks.push({ epoch: body.epoch, upTo: body.upTo, committedIn: local ? inboundCount(local.id) : -1 });
    }
    const res = await relay.fetch(input, init);
    if (path.endsWith('/inbound') && res.ok) {
      const json = await res.clone().json() as { items?: unknown[] };
      const n = Array.isArray(json.items) ? json.items.length : 0;
      if (n > 0) pages.push(n);
    }
    return res;
  }) as FetchLike;
}

function boot(): Booted {
  if (!dbService) throw new Error('database not open');
  const cloud = new FakeCloud({ fetch: instrumentedFetch() });
  const capture = vi.fn();
  let ctx: ConnectorWiringContext | null = null;
  const deps: PersistentAgentsCompositionDeps = {
    db: makeDatabaseLike(dbService),
    configManager: new FakeConfig() as unknown as PersistentAgentsCompositionDeps['configManager'],
    logger: quietLogger(),
    cloud,
    captureSeamError: capture,
    encrypt: (plain) => Buffer.from(plain.split('').reverse().join('')),
    decrypt: (cipher) => cipher.toString().split('').reverse().join(''),
    wireConnectors: (c) => {
      ctx = c;
      return wireBridgeConnector(c, { createWebSocket: null, env: {}, random: () => 1 });
    },
  };
  const comp = composePersistentAgents(deps);
  comps.push(comp);
  comp.start();
  if (ctx === null) throw new Error('wiring context not captured');
  return { comp, ctx, cloud, capture };
}

/** Advances fake time in small steps until `cond` holds. */
async function until(cond: () => boolean, maxMs = 60_000): Promise<void> {
  for (let t = 0; t <= maxMs; t += 250) {
    if (cond()) return;
    await vi.advanceTimersByTimeAsync(250);
  }
  if (!cond()) throw new Error('condition not reached in fake time');
}

async function connect(b: Booted, transport: 'relay-mcp' | 'relay-http' = 'relay-mcp') {
  const res = await b.comp.service.connect({
    agent: { displayName: 'Scout', vendor: 'openai-dots' },
    connection: { kind: 'bridge', connectorId: 'bridge', transport },
  });
  const relayId = connRow(res.connectionId).remote_id;
  return { ...res, relayId };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cyboflow-bridge-store-'));
  openDb();
  relay = new FakeRelay();
  comps = [];
  pages = [];
  acks = [];
  vi.useFakeTimers({ now: new Date('2026-10-07T12:00:00.000Z') });
});

afterEach(() => {
  for (const c of comps.splice(0)) c.stop();
  _resetPersistentAgentsFacadeForTesting();
  vi.useRealTimers();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('Bridge connector on the real persistent-agent store', () => {
  it('connect relay-mcp returns the pairing display and persists no secret', async () => {
    const b = boot();
    const t0 = Date.now();
    const res = await connect(b, 'relay-mcp');
    const post = relay.requests.find((r) => r.method === 'POST' && r.path === '/connections');
    expect(post?.body).toEqual({ transport: 'relay-mcp', label: 'Scout' });
    const code = relay.pairingCodeOf(res.relayId);
    expect(res.pairing).toMatchObject({
      kind: 'bridge',
      connectionId: res.connectionId,
      transport: 'relay-mcp',
      mcpUrl: `https://bridge.test/mcp/${res.relayId}`,
      pairingCode: code,
      pairingExpiresAt: new Date(t0 + 600_000 - 5_000).toISOString(),
      oneTimeToken: null,
      instructionBrief: null,
    });
    const stored = dumpTables();
    expect(stored).not.toContain(code);
    expect(stored).not.toMatch(/cbh_|cbd_/);
    expect(b.comp.service.getPairing({ connectionId: res.connectionId })).toMatchObject({ pairingCode: code, oneTimeToken: null });
  });

  it('connect relay-http returns the one-time token once and the database never holds it', async () => {
    const b = boot();
    const res = await connect(b, 'relay-http');
    const token = res.pairing?.oneTimeToken ?? '';
    expect(token).toMatch(/^cbh_/);
    expect(res.pairing?.instructionBrief).toContain(token);
    const stored = dumpTables();
    expect(stored).not.toContain(token);
    expect(stored).not.toMatch(/cbh_|cbd_/);
    expect(b.comp.service.getPairing({ connectionId: res.connectionId })?.oneTimeToken ?? null).toBeNull();
    expect(b.comp.service.getPairing({ connectionId: res.connectionId })?.instructionBrief ?? null).toBeNull();
  });

  it('multi-page drain: 250 messages → pages 100/100/50, acks 100/200/250, each after commit', async () => {
    const b = boot();
    const { connectionId, relayId } = await connect(b);
    for (let i = 0; i < 250; i += 1) relay.vendorSend(relayId, { body: `m${i}` });
    b.ctx.kick(connectionId);
    await until(() => relay.inboundRows(relayId).length === 0);
    expect(inboundCount(connectionId)).toBe(250);
    expect(pages).toEqual([100, 100, 50]);
    expect(acks.map((a) => a.upTo)).toEqual([100, 200, 250]);
    for (const a of acks) expect(a.committedIn).toBe(a.upTo);
    expect(connRow(connectionId).inbound_cursor).toBe(`bridge:v1:${relay.epochOf(relayId)}:250`);
  });

  it('no ack when the store transaction fails; the next pull stores each message once', async () => {
    const b = boot();
    const { connectionId, relayId } = await connect(b);
    for (let i = 0; i < 5; i += 1) relay.vendorSend(relayId, { body: `m${i}` });
    // A real SQL failure in the middle of the batch: the whole apply must roll back.
    raw().exec(`CREATE TEMP TRIGGER fail_apply BEFORE INSERT ON persistent_agent_messages
                WHEN NEW.body = 'm3' BEGIN SELECT RAISE(ABORT, 'simulated apply failure'); END;`);
    b.ctx.kick(connectionId);
    await until(() => b.capture.mock.calls.some((c) => c[0] === 'connector-inbound'));
    expect(acks).toEqual([]);
    expect(inboundCount(connectionId)).toBe(0);
    expect(relay.inboundRows(relayId)).toHaveLength(5);
    raw().exec('DROP TRIGGER fail_apply');
    await until(() => relay.inboundRows(relayId).length === 0, 120_000);
    expect(messages(connectionId).filter((m) => m.direction === 'in').map((m) => m.body)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
  });

  it('epoch change (fence) re-drains from 0, dedupes, and acks with the new epoch', async () => {
    const b = boot();
    const { connectionId, relayId } = await connect(b);
    for (let i = 0; i < 50; i += 1) relay.vendorSend(relayId, { body: `m${i}` });
    relay.injectAlways({ path: /\/ack$/ }, { kind: 'network' });
    b.ctx.kick(connectionId);
    await until(() => inboundCount(connectionId) === 50);
    const e1 = relay.epochOf(relayId);
    await until(() => connRow(connectionId).inbound_cursor === `bridge:v1:${e1}:50`);
    relay.clearFaults();
    relay.fence(relayId);
    const e2 = relay.epochOf(relayId);
    expect(e2).not.toBe(e1);
    b.ctx.kick(connectionId);
    await until(() => relay.inboundRows(relayId).length === 0, 120_000);
    expect(inboundCount(connectionId)).toBe(50);
    expect(acks.filter((a) => a.epoch === e2).at(-1)).toMatchObject({ epoch: e2, upTo: 50 });
    expect(connRow(connectionId).relay_epoch).toBe(e2);
  });

  it('gap note is inserted once even when re-reported (first ack fails)', async () => {
    const b = boot();
    const { connectionId, relayId } = await connect(b);
    for (let i = 0; i < 10; i += 1) relay.vendorSend(relayId, { body: `m${i}` });
    relay.expireInbound(relayId, 5);
    relay.injectOnce({ path: /\/ack$/ }, { kind: 'network' });
    b.ctx.kick(connectionId);
    await until(() => inboundCount(connectionId) === 5);
    const gapNotes = () => messages(connectionId).filter((m) => (m.remote_event_id ?? '').startsWith('gap:'));
    expect(gapNotes()).toHaveLength(1);
    expect(gapNotes()[0]).toMatchObject({ author: 'local', kind: 'system', direction: 'local', remote_event_id: `gap:${relay.epochOf(relayId)}:5` });
    expect(relay.inboundRows(relayId)).toHaveLength(5);
    // A lost cursor: the relay re-reads the same epoch from 0 and reports the gap again.
    raw().prepare('UPDATE persistent_agent_connections SET inbound_cursor = NULL WHERE id = ?').run(connectionId);
    b.ctx.kick(connectionId);
    await until(() => relay.inboundRows(relayId).length === 0, 120_000);
    expect(gapNotes()).toHaveLength(1);
    expect(inboundCount(connectionId)).toBe(5);
  });

  it('"Picked up" survives a restart of the whole composition', async () => {
    const first = boot();
    const { agentId, connectionId, relayId } = await connect(first);
    const { messageId } = await first.comp.service.send({ agentId, text: 'hello agent' });
    await until(() => relay.outboundRows(relayId).length === 1);
    const sendState = () => (raw().prepare('SELECT send_state FROM persistent_agent_messages WHERE id = ?').get(messageId) as { send_state: string }).send_state;
    await until(() => sendState() === 'on_bridge');
    expect(relay.outboundRows(relayId)[0]).toMatchObject({ id: messageId });
    relay.vendorReadOutbox(relayId);

    // Quit and relaunch: a fresh process opens the same database file.
    first.comp.stop();
    _resetPersistentAgentsFacadeForTesting();
    closeDb();
    openDb();
    const second = boot();
    second.ctx.kick(connectionId);
    const pickedUp = () => (raw().prepare('SELECT picked_up_at FROM persistent_agent_messages WHERE id = ?').get(messageId) as { picked_up_at: string | null }).picked_up_at;
    await until(() => pickedUp() !== null);
    expect(pickedUp()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(sendState()).toBe('on_bridge');
    const remote = JSON.parse(connRow(connectionId).remote_json ?? '{}') as { firstPickupAt?: unknown };
    expect(remote.firstPickupAt).toEqual(expect.any(String));
  });
});
