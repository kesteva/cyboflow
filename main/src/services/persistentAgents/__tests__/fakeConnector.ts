/**
 * Test fixtures for the persistent-agents core: a scriptable fake connector, an in-memory database with
 * migration 151 applied, and a small harness that wires the real store / registry / outbox / pump /
 * connection service together (no electron, no network).
 */
import { vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dbAdapter } from '../../../orchestrator/__test_fixtures__/dbAdapter';
import type { DatabaseLike, LoggerLike } from '../../../orchestrator/types';
import { PersistentAgentStore } from '../../../orchestrator/persistentAgents/persistentAgentStore';
import { toConnectionHandle } from '../../../orchestrator/persistentAgents/rows';
import type {
  ConnectorAvailability,
  ConnectorCapabilities,
  ConnectorDefinition,
  VerifyFact,
} from '../../../../../shared/types/persistentAgents';
import {
  BRIDGE_FIXTURE_DEFINITION,
  CMA_DEFINITION,
} from '../../../../../shared/types/__tests__/persistentAgentsFixtures';
import type {
  AgentConnector,
  ConnectOutcome,
  ConnectRequest,
  ConnectionHandle,
  ConnectorCallOptions,
  ConnectorRegistration,
  InboundBatch,
  OutboundMessage,
  ReconcileItem,
  ReconcileResult,
  RepairOutcome,
  SendReceipt,
  VerifyOutcome,
} from '../connectorContract';
import { ConnectorRegistry } from '../connectorRegistry';
import { TokenBuckets } from '../tokenBucket';
import { OutboxWorker } from '../outbox';
import { InboundPump } from '../inboundPump';
import { ConnectionService } from '../connectionService';
import { CredentialService } from '../credentialService';

export const T0 = new Date('2026-10-07T12:00:00.000Z');
export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const MIGRATION = readFileSync(
  join(__dirname, '..', '..', '..', 'database', 'migrations', '151_persistent_agents.sql'),
  'utf-8',
);

export function makeTestDb(): { raw: Database.Database; db: DatabaseLike } {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  raw.exec(MIGRATION);
  return { raw, db: dbAdapter(raw) };
}

export function makeLogger(): LoggerLike & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const rec = (level: string) => (msg: string, ctx?: Record<string, unknown>) => { calls.push([level, msg, ctx]); };
  return { calls, info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') };
}

/** A controllable clock. */
export function makeClock(start: Date = T0): { now: () => Date; set(d: Date | number): void; advance(ms: number): void } {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    set(d) { t = typeof d === 'number' ? d : d.getTime(); },
    advance(ms) { t += ms; },
  };
}

export function emptyBatch(over: Partial<InboundBatch> = {}): InboundBatch {
  return {
    messages: [], activity: [], usage: [], deliveryHints: [], receipts: [],
    nextCursor: null, observed: [], hasMore: false, ...over,
  };
}

type Scripted<T> = T | Error | (() => Promise<T>);

export interface FakeCall { method: string; handle?: ConnectionHandle; args: unknown[] }

export interface FakeConnectorOptions {
  id?: string;
  kind?: 'bridge' | 'native';
  definition?: Partial<ConnectorDefinition>;
  descriptor?: ConnectorCapabilities;
  budget?: { key: string; ratePerMinute: number; capacity?: number };
  withControl?: boolean;
  withRepair?: boolean;
  describeFacts?: (h: ConnectionHandle) => VerifyFact[];
  now?: () => Date;
}

export interface FakeConnector {
  registration: ConnectorRegistration;
  connector: AgentConnector;
  calls: FakeCall[];
  script: {
    pushPull(r: Scripted<InboundBatch>): void;
    pushSend(r: Scripted<SendReceipt>): void;
    pushReconcile(r: Scripted<ReconcileResult[]>): void;
    pushDisconnect(r: Scripted<void>): void;
    pushConnect(r: Scripted<ConnectOutcome>): void;
    pushVerify(r: Scripted<VerifyOutcome>): void;
    pushRepair(r: Scripted<RepairOutcome>): void;
    setAvailability(a: ConnectorAvailability): void;
    /** Default reconcile outcome when no script is queued. */
    setDefaultReconcile(outcome: 'found' | 'not_found' | 'unknown'): void;
  };
  disposed: number;
}

let remoteSeq = 0;

export function createFakeConnector(opts: FakeConnectorOptions = {}): FakeConnector {
  const kind = opts.kind ?? 'bridge';
  const base = kind === 'bridge' ? BRIDGE_FIXTURE_DEFINITION : CMA_DEFINITION;
  const definition: ConnectorDefinition = {
    ...base,
    ...opts.definition,
    id: opts.id ?? opts.definition?.id ?? (kind === 'bridge' ? 'bridge' : 'claude-managed-agents'),
    capabilities: opts.descriptor ?? opts.definition?.capabilities ?? base.capabilities,
  };
  const now = opts.now ?? (() => new Date());
  const calls: FakeCall[] = [];
  const queues = {
    pull: [] as Scripted<InboundBatch>[],
    send: [] as Scripted<SendReceipt>[],
    reconcile: [] as Scripted<ReconcileResult[]>[],
    disconnect: [] as Scripted<void>[],
    connect: [] as Scripted<ConnectOutcome>[],
    verify: [] as Scripted<VerifyOutcome>[],
    repair: [] as Scripted<RepairOutcome>[],
  };
  let availability: ConnectorAvailability = { state: 'ok', message: null, retryAt: null };
  let defaultReconcile: 'found' | 'not_found' | 'unknown' = 'not_found';

  async function play<T>(q: Scripted<T>[], fallback: () => T): Promise<T> {
    const next = q.shift();
    if (next === undefined) return fallback();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return (next as () => Promise<T>)();
    return next;
  }

  const fake: FakeConnector = {
    registration: { definition, factory: () => connector },
    connector: undefined as unknown as AgentConnector,
    calls,
    disposed: 0,
    script: {
      pushPull: (r) => queues.pull.push(r),
      pushSend: (r) => queues.send.push(r),
      pushReconcile: (r) => queues.reconcile.push(r),
      pushDisconnect: (r) => queues.disconnect.push(r),
      pushConnect: (r) => queues.connect.push(r),
      pushVerify: (r) => queues.verify.push(r),
      pushRepair: (r) => queues.repair.push(r),
      setAvailability: (a) => { availability = a; },
      setDefaultReconcile: (o) => { defaultReconcile = o; },
    },
  };

  const connector: AgentConnector = {
    definition,
    availability: () => availability,
    ...(opts.budget ? { budget: () => opts.budget as { key: string; ratePerMinute: number; capacity?: number } } : {}),
    ...(opts.describeFacts ? { describeFacts: opts.describeFacts } : {}),
    async connect(req: ConnectRequest, o: ConnectorCallOptions): Promise<ConnectOutcome> {
      calls.push({ method: 'connect', args: [req, o] });
      return play(queues.connect, () => {
        remoteSeq += 1;
        const remoteId = `remote-${remoteSeq}`;
        const pairing = kind === 'bridge'
          ? {
            kind: 'bridge' as const,
            connectionId: req.connectionId,
            transport: req.input.kind === 'bridge' ? req.input.transport : 'relay-mcp' as const,
            mcpUrl: `https://relay.example.test/mcp/${remoteId}`,
            httpBase: `https://relay.example.test/http/${remoteId}`,
            pairingCode: 'AMBER-OTTER-1234',
            pairingExpiresAt: new Date(now().getTime() + 10 * 60_000 - 5_000).toISOString(),
            oneTimeToken: req.input.kind === 'bridge' && req.input.transport === 'relay-http' ? 'cbh_onetime_secret' : null,
            instructionBrief: null,
          }
          : null;
        return {
          remoteId,
          remote: kind === 'bridge' ? { mcpUrl: pairing?.mcpUrl, httpBase: pairing?.httpBase, label: 'x' } : { agent: 'a' },
          transport: req.input.kind === 'bridge' ? req.input.transport : 'stream',
          inboundCursor: null,
          relayEpoch: kind === 'bridge' ? 1 : null,
          pairing,
          facts: [{ key: 'pairing-issued', label: 'Pairing code issued', at: now().toISOString(), status: 'done' as const }],
        };
      });
    },
    async rollbackConnect(req, outcome, o) {
      calls.push({ method: 'rollbackConnect', args: [req, outcome, o] });
    },
    async verify(h: ConnectionHandle, o: ConnectorCallOptions): Promise<VerifyOutcome> {
      calls.push({ method: 'verify', handle: h, args: [o] });
      return play(queues.verify, () => ({ facts: [] }));
    },
    async send(h: ConnectionHandle, msg: OutboundMessage, o: ConnectorCallOptions): Promise<SendReceipt> {
      calls.push({ method: 'send', handle: h, args: [msg, o] });
      return play(queues.send, () => ({
        state: kind === 'bridge' ? 'on_bridge' as const : 'sent' as const,
        acceptedAt: now().toISOString(),
        remoteEventId: msg.id,
      }));
    },
    async pull(h: ConnectionHandle, cursor: string | null, o: ConnectorCallOptions): Promise<InboundBatch> {
      calls.push({ method: 'pull', handle: h, args: [cursor, o] });
      return play(queues.pull, () => emptyBatch({ nextCursor: cursor }));
    },
    async acknowledge(h: ConnectionHandle, token: string, o: ConnectorCallOptions): Promise<void> {
      calls.push({ method: 'acknowledge', handle: h, args: [token, o] });
    },
    async reconcile(h: ConnectionHandle, items: ReconcileItem[], since: string, o: ConnectorCallOptions): Promise<ReconcileResult[]> {
      calls.push({ method: 'reconcile', handle: h, args: [items, since, o] });
      return play(queues.reconcile, () => items.map((i): ReconcileResult => (defaultReconcile === 'found'
        ? { messageId: i.messageId, outcome: 'found', receipt: { state: kind === 'bridge' ? 'on_bridge' : 'sent', acceptedAt: now().toISOString() } }
        : { messageId: i.messageId, outcome: defaultReconcile }) as ReconcileResult));
    },
    async disconnect(h: ConnectionHandle, o: ConnectorCallOptions): Promise<void> {
      calls.push({ method: 'disconnect', handle: h, args: [o] });
      return play(queues.disconnect, () => undefined);
    },
    ...(opts.withControl ? {
      async control(h: ConnectionHandle, verb: string, o: ConnectorCallOptions): Promise<void> {
        calls.push({ method: 'control', handle: h, args: [verb, o] });
      },
    } : {}),
    ...(opts.withRepair !== false ? {
      async repairPairing(h: ConnectionHandle, o: ConnectorCallOptions): Promise<RepairOutcome> {
        calls.push({ method: 'repairPairing', handle: h, args: [o] });
        return play(queues.repair, () => ({
          pairing: {
            kind: 'bridge' as const, connectionId: h.connectionId, transport: 'relay-mcp' as const,
            mcpUrl: 'https://relay.example.test/mcp/x', httpBase: 'https://relay.example.test/http/x',
            pairingCode: 'NEW-CODE-9999', pairingExpiresAt: new Date(now().getTime() + 595_000).toISOString(),
            oneTimeToken: null, instructionBrief: null,
          },
          remotePatch: { pairedClient: null },
          relayEpoch: (h.relayEpoch ?? 0) + 1,
          inboundCursor: `bridge:v1:${(h.relayEpoch ?? 0) + 1}:0`,
        }));
      },
    } : {}),
    dispose() { fake.disposed += 1; },
  };
  fake.connector = connector;
  return fake;
}

// ---------------------------------------------------------------------------
// Harness: real store + registry + outbox + pump + connection service
// ---------------------------------------------------------------------------

export interface Harness {
  raw: Database.Database;
  db: DatabaseLike;
  clock: ReturnType<typeof makeClock>;
  logger: ReturnType<typeof makeLogger>;
  store: PersistentAgentStore;
  registry: ConnectorRegistry;
  budget: TokenBuckets;
  credentials: CredentialService;
  outbox: OutboxWorker;
  pump: InboundPump;
  connections: ConnectionService;
  capture: ReturnType<typeof vi.fn>;
  running: { value: boolean };
  buildHandle(id: string): ConnectionHandle | null;
}

export function makeHarness(opts: {
  connectors?: FakeConnector[];
  encrypt?: (p: string) => Buffer;
  decrypt?: (c: Buffer) => string;
  clock?: ReturnType<typeof makeClock>;
} = {}): Harness {
  const { raw, db } = makeTestDb();
  const clock = opts.clock ?? makeClock();
  const logger = makeLogger();
  let n = 0;
  const store = new PersistentAgentStore(db, { now: clock.now, newId: () => `id-${String(++n).padStart(4, '0')}`, logger });
  const registry = new ConnectorRegistry();
  const budget = new TokenBuckets({ now: () => clock.now().getTime() });
  const running = { value: true };
  const capture = vi.fn();
  const buildHandle = (id: string): ConnectionHandle | null => {
    const c = store.getConnectionRow(id);
    if (!c) return null;
    const a = store.getAgentRow(c.agent_id);
    if (!a) return null;
    const v = c.credential_id ? store.getCredentialRow(c.credential_id)?.version ?? null : null;
    return toConnectionHandle(c, a, v);
  };
  // eslint-disable-next-line prefer-const
  let connections: ConnectionService;
  let pump: InboundPump | null = null;
  const credentials = new CredentialService({
    store,
    encrypt: opts.encrypt ?? ((p) => Buffer.from(`enc:${p}`, 'utf8')),
    decrypt: opts.decrypt ?? ((c) => c.toString('utf8').replace(/^enc:/, '')),
    onCredentialReopened: (ids) => { for (const id of ids) pump?.kick(id); },
    logger,
  });
  registry.configure({ fetch: globalThis.fetch, now: clock.now, log: logger, secret: (id) => credentials.secret(id) });
  for (const c of opts.connectors ?? []) registry.register(c.registration);
  const outbox = new OutboxWorker({
    store, registry, buildHandle, budget, isRunning: () => running.value, now: clock.now, jitter: () => 1, logger,
    captureSeamError: capture,
    onAuthFailure: (id, e) => connections.onAuthFailure(id, e),
    onRateLimited: (id, until) => store.setConnectionState(id, { rateLimitedUntil: until }),
    onConnectionGone: (id, e) => connections.onConnectionGone(id, e),
  });
  pump = new InboundPump({
    store, registry, buildHandle, budget, outbox, isRunning: () => running.value, now: clock.now, logger,
    captureSeamError: capture,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (t) => clearInterval(t),
    connections: {
      onConnectionVerified: (id) => connections.onConnectionVerified(id),
      runRevokeRetries: () => connections.runRevokeRetries(),
      onAuthFailure: (id, e) => connections.onAuthFailure(id, e),
      onConnectionGone: (id, e) => connections.onConnectionGone(id, e),
    },
  });
  connections = new ConnectionService({
    store, registry, credentials, buildHandle, budget, pump, outbox, now: clock.now,
    sleep: async () => undefined, logger, captureSeamError: capture,
  });
  return { raw, db, clock, logger, store, registry, budget, credentials, outbox, pump, connections, capture, running, buildHandle };
}

/** Every timestamp column value written in the test DB (for the ISO-shape assertion). */
export function allTimestampValues(raw: Database.Database): Array<{ table: string; column: string; value: string }> {
  const out: Array<{ table: string; column: string; value: string }> = [];
  const tables = ['vendor_credentials', 'persistent_agents', 'persistent_agent_connections', 'persistent_agent_messages',
    'persistent_agent_events', 'persistent_agent_usage'];
  for (const table of tables) {
    const cols = (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((c) => c.name)
      .filter((c) => c.endsWith('_at') || c === 'rate_limited_until');
    for (const row of raw.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>) {
      for (const column of cols) {
        const v = row[column];
        if (typeof v === 'string') out.push({ table, column, value: v });
      }
    }
  }
  return out;
}
