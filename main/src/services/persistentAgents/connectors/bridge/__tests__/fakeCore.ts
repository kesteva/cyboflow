/**
 * Minimal in-memory model of the persistent-agents core seams the Bridge depends on: the wiring context
 * (register, directory, kicks, out-of-band patches) plus a store/pump model with core semantics:
 * dedupe by (connection, direction, remoteEventId), receipts by local message id, shallow remotePatch
 * merge, lastSeenAt max, pending → verified only via observed 'round-trip', cursor + epoch, and the
 * repair fence (a batch pulled before a repair stores content but changes nothing on the connection).
 */
import {
  isConnectorCallable,
  type ConnectionState,
  type PersistentAgentVendor,
  type VerifiedFlag,
} from '../../../../../../../shared/types/persistentAgents';
import type { LoggerLike } from '../../../../../orchestrator/types';
import type { CloudAccountHandle } from '../../../../cloud/cloudAccountHandle';
import type {
  AgentConnector,
  ConnectRequest,
  ConnectionHandle,
  ConnectorDeps,
  ConnectorRegistration,
  ConnectorWiringContext,
  ConnectOutcome,
  InboundBatch,
  InboundMessage,
  RepairOutcome,
} from '../../../connectorContract';
import type { BridgeConnector } from '../bridgeConnector';
import { BRIDGE_DEFINITION } from '../descriptor';
import type { DoorbellSocketFactory } from '../doorbellSocket';
import { createBridge, type BridgeInstance } from '../index';
import { FakeCloud } from './fakeCloud';
import { FakeRelay } from './fakeRelay';

export interface LogEntry { level: 'info' | 'warn' | 'error' | 'debug'; message: string; context?: Record<string, unknown> }

export class SpyLogger implements LoggerLike {
  readonly entries: LogEntry[] = [];
  info(message: string, context?: Record<string, unknown>): void { this.entries.push({ level: 'info', message, context }); }
  warn(message: string, context?: Record<string, unknown>): void { this.entries.push({ level: 'warn', message, context }); }
  error(message: string, context?: Record<string, unknown>): void { this.entries.push({ level: 'error', message, context }); }
  debug(message: string, context?: Record<string, unknown>): void { this.entries.push({ level: 'debug', message, context }); }
}

export interface FakeRow {
  connectionId: string;
  agentId: string;
  agentHandle: string;
  agentDisplayName: string;
  vendor: PersistentAgentVendor;
  connectorId: string;
  connectorVersion: number;
  transport: 'relay-mcp' | 'relay-http' | null;
  state: ConnectionState;
  generation: number;
  remoteId: string | null;
  remote: Record<string, unknown>;
  inboundCursor: string | null;
  relayEpoch: number | null;
  observed: Partial<Record<VerifiedFlag, string>>;
  lastSeenAt: string | null;
}

export interface StoredMessage extends InboundMessage {
  connectionId: string;
  direction: 'in' | 'local';
}

export interface StoredOutbound { id: string; agentId: string; connectionId: string; pickedUpAt: string | null }

export interface ApplyResult { inserted: number; fenced: boolean }

export class FakeCore implements ConnectorWiringContext {
  readonly rows = new Map<string, FakeRow>();
  readonly messages: StoredMessage[] = [];
  readonly outbound = new Map<string, StoredOutbound>();
  readonly registrations: ConnectorRegistration[] = [];
  readonly kicks: string[] = [];
  kickAllCount = 0;
  readonly gone: Array<{ connectionId: string; reason: string }> = [];
  readonly patches: Array<{ connectionId: string; patch: Record<string, unknown> }> = [];
  readonly availabilityNotices: string[] = [];
  readonly captures: Array<{ seam: string; err: unknown; tags?: Record<string, string> }> = [];
  /** Ordered trace: 'apply:<page>' and 'ack' markers written by drain(). */
  readonly trace: string[] = [];
  failNextApply = false;
  readonly logger = new SpyLogger();
  private readonly listeners = new Set<() => void>();
  private seq = 0;

  constructor(readonly cloud: CloudAccountHandle | null) {}

  // ---- ConnectorWiringContext ----------------------------------------------------------------------

  register(reg: ConnectorRegistration): void {
    this.registrations.push(reg);
  }

  listHandles(connectorId: string): ConnectionHandle[] {
    return [...this.rows.values()]
      .filter((r) => r.connectorId === connectorId && r.state !== 'revoked')
      .map((r) => this.handle(r.connectionId));
  }

  onConnectionsChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  findConnectionIdByRemoteId(connectorId: string, remoteId: string): string | null {
    for (const r of this.rows.values()) {
      if (r.connectorId === connectorId && r.remoteId === remoteId) return r.connectionId;
    }
    return null;
  }

  kick(connectionId: string): void {
    this.kicks.push(connectionId);
  }

  kickAll(filter?: (t: { connectionId: string; connectorId: string }) => boolean): void {
    this.kickAllCount += 1;
    for (const r of this.rows.values()) {
      if (!filter || filter({ connectionId: r.connectionId, connectorId: r.connectorId })) this.kicks.push(r.connectionId);
    }
  }

  async reportRemotePatch(connectionId: string, patch: Record<string, unknown>): Promise<void> {
    this.patches.push({ connectionId, patch });
    const r = this.rows.get(connectionId);
    if (r) r.remote = { ...r.remote, ...patch };
  }

  async reportConnectionGone(connectionId: string, reason: string): Promise<void> {
    this.gone.push({ connectionId, reason });
    const r = this.rows.get(connectionId);
    if (r) r.state = 'revoked';
  }

  notifyAvailabilityChanged(connectorId: string): void {
    this.availabilityNotices.push(connectorId);
  }

  isRunning(): boolean {
    return true;
  }

  captureSeamError(seam: string, err: unknown, tags?: Record<string, string>): void {
    this.captures.push({ seam, err, tags });
  }

  // ---- model ----------------------------------------------------------------------------------------

  /** The registered connector (factory invoked with stub deps). */
  connector(): AgentConnector {
    const reg = this.registrations[0];
    if (!reg) throw new Error('no connector registered');
    const deps: ConnectorDeps = {
      fetch: (() => Promise.reject(new Error('unused'))) as typeof fetch,
      now: () => new Date(),
      log: this.logger,
      secret: () => Promise.reject(new Error('no secrets for the Bridge')),
    };
    return reg.factory(deps);
  }

  notifyConnectionsChanged(): void {
    for (const l of [...this.listeners]) l();
  }

  addFromOutcome(
    outcome: ConnectOutcome,
    opts: { connectionId?: string; agentId?: string; handle?: string; vendor?: PersistentAgentVendor } = {},
  ): FakeRow {
    const connectionId = opts.connectionId ?? `conn_${++this.seq}`;
    const row: FakeRow = {
      connectionId,
      agentId: opts.agentId ?? `agent_${connectionId}`,
      agentHandle: opts.handle ?? 'scout',
      agentDisplayName: 'Scout',
      vendor: opts.vendor ?? 'openai-dots',
      connectorId: 'bridge',
      connectorVersion: 1,
      transport: outcome.transport === 'relay-mcp' || outcome.transport === 'relay-http' ? outcome.transport : null,
      state: 'pending',
      generation: 1,
      remoteId: outcome.remoteId,
      remote: { ...outcome.remote, remoteId: outcome.remoteId, transport: outcome.transport },
      inboundCursor: outcome.inboundCursor,
      relayEpoch: outcome.relayEpoch,
      observed: {},
      lastSeenAt: null,
    };
    this.rows.set(connectionId, row);
    this.notifyConnectionsChanged();
    return row;
  }

  row(connectionId: string): FakeRow {
    const r = this.rows.get(connectionId);
    if (!r) throw new Error(`no row ${connectionId}`);
    return r;
  }

  handle(connectionId: string): ConnectionHandle {
    const r = this.row(connectionId);
    return {
      connectionId: r.connectionId,
      agentId: r.agentId,
      agentHandle: r.agentHandle,
      agentDisplayName: r.agentDisplayName,
      vendor: r.vendor,
      connectorId: r.connectorId,
      connectorVersion: r.connectorVersion,
      kind: 'bridge',
      transport: r.transport,
      state: r.state,
      generation: r.generation,
      remoteId: r.remoteId,
      remote: { ...r.remote },
      credential: null,
      inboundCursor: r.inboundCursor,
      relayEpoch: r.relayEpoch,
    };
  }

  addOutbound(id: string, connectionId: string): void {
    const r = this.row(connectionId);
    this.outbound.set(id, { id, agentId: r.agentId, connectionId, pickedUpAt: null });
  }

  messagesFor(connectionId: string): StoredMessage[] {
    return this.messages.filter((m) => m.connectionId === connectionId);
  }

  applyInboundBatch(connectionId: string, batch: InboundBatch, opts: { expectedRelayEpoch?: number | null } = {}): ApplyResult {
    if (this.failNextApply) {
      this.failNextApply = false;
      throw new Error('simulated apply failure (rolled back)');
    }
    const r = this.row(connectionId);
    const fenced = opts.expectedRelayEpoch !== undefined && (opts.expectedRelayEpoch ?? null) !== (r.relayEpoch ?? null);
    let inserted = 0;
    for (const m of batch.messages) {
      const direction = m.author === 'local' ? 'local' : 'in';
      const dup = this.messages.some((x) =>
        x.connectionId === connectionId && x.direction === direction && x.remoteEventId === m.remoteEventId);
      if (dup) continue;
      this.messages.push({ ...m, connectionId, direction });
      inserted += 1;
    }
    for (const rc of batch.receipts) {
      if (!rc.localMessageId) continue;
      const o = this.outbound.get(rc.localMessageId);
      if (o && o.agentId === r.agentId && o.pickedUpAt === null) o.pickedUpAt = rc.at;
    }
    if (!fenced) {
      if (batch.remotePatch) r.remote = { ...r.remote, ...batch.remotePatch };
      const t = new Date().toISOString();
      for (const f of batch.observed) if (r.observed[f] === undefined) r.observed[f] = t;
      if (batch.observed.includes('round-trip') && r.state === 'pending') r.state = 'verified';
      if (batch.lastSeenAt && (r.lastSeenAt === null || Date.parse(batch.lastSeenAt) > Date.parse(r.lastSeenAt))) {
        r.lastSeenAt = batch.lastSeenAt;
      }
      r.inboundCursor = batch.nextCursor;
      if (batch.cursorEpoch !== undefined) r.relayEpoch = batch.cursorEpoch;
    }
    this.trace.push(`apply:${inserted}${fenced ? ':fenced' : ''}`);
    return { inserted, fenced };
  }

  applyRepair(connectionId: string, outcome: RepairOutcome): void {
    const r = this.row(connectionId);
    if (outcome.inboundCursor !== undefined) r.inboundCursor = outcome.inboundCursor;
    if (outcome.relayEpoch !== undefined) r.relayEpoch = outcome.relayEpoch;
    if (outcome.remotePatch) r.remote = { ...r.remote, ...outcome.remotePatch };
    r.state = 'pending';
    delete r.observed['round-trip'];
  }

  /** The pump loop: pull → apply (one transaction) → acknowledge AFTER commit; loop while hasMore (≤ maxPages). */
  async drain(
    connector: AgentConnector,
    connectionId: string,
    opts: { maxPages?: number; signal?: AbortSignal } = {},
  ): Promise<{ pages: number; inserted: number }> {
    const maxPages = opts.maxPages ?? 50;
    let pages = 0;
    let inserted = 0;
    while (pages < maxPages) {
      const row = this.row(connectionId);
      if (row.state === 'revoked') break;
      const h = this.handle(connectionId);
      if (!isConnectorCallable(connector.availability(h))) break;
      const signal = opts.signal ?? AbortSignal.timeout(30_000);
      const batch = await connector.pull(h, h.inboundCursor, { signal });
      const res = this.applyInboundBatch(connectionId, batch, { expectedRelayEpoch: h.relayEpoch });
      inserted += res.inserted;
      pages += 1;
      if (!res.fenced && batch.ackToken && connector.acknowledge) {
        this.trace.push('ack');
        await connector.acknowledge(this.handle(connectionId), batch.ackToken, { signal });
      }
      if (!batch.hasMore && !res.fenced) break;
    }
    return { pages, inserted };
  }
}

// ---- Harness ------------------------------------------------------------------------------------------

export interface BridgeHarness {
  relay: FakeRelay;
  cloud: FakeCloud;
  core: FakeCore;
  bridge: BridgeInstance;
  connector: BridgeConnector;
}

export interface HarnessOptions {
  relay?: FakeRelay;
  cloud?: FakeCloud;
  core?: FakeCore;
  env?: NodeJS.ProcessEnv;
  createWebSocket?: DoorbellSocketFactory | null;
  random?: () => number;
  /** Overrides the relay's fetch (e.g. a wrapper that mutates state mid-request). */
  fetch?: typeof fetch;
  /** Default true. */
  start?: boolean;
}

/** A fresh call option (the core always passes a deadline). */
export function opts(signal?: AbortSignal): { signal: AbortSignal } {
  return { signal: signal ?? new AbortController().signal };
}

export function setupBridge(o: HarnessOptions = {}): BridgeHarness {
  const relay = o.relay ?? new FakeRelay();
  const cloud = o.cloud ?? new FakeCloud({ fetch: relay.fetch });
  const core = o.core ?? new FakeCore(cloud);
  const bridge = createBridge({
    ctx: core,
    cloud,
    fetch: o.fetch ?? relay.fetch,
    appVersion: cloud.appVersion,
    createWebSocket: o.createWebSocket ?? null,
    env: o.env ?? {},
    random: o.random ?? (() => 1),
  });
  core.register({ definition: BRIDGE_DEFINITION, factory: () => bridge.connector });
  if (o.start !== false) bridge.start();
  return { relay, cloud, core, bridge, connector: bridge.connector };
}

export function connectRequest(
  transport: 'relay-mcp' | 'relay-http',
  over: { connectionId?: string; displayName?: string; handle?: string; label?: string } = {},
): ConnectRequest {
  return {
    connectionId: over.connectionId ?? `conn_req_${transport}`,
    agent: { id: 'agent_1', handle: over.handle ?? 'scout', displayName: over.displayName ?? 'Scout', vendor: 'openai-dots' },
    input: { kind: 'bridge', connectorId: 'bridge', transport, ...(over.label !== undefined ? { label: over.label } : {}) },
    credential: null,
  };
}

/** connect() through the connector and persist the outcome in the fake core. */
export async function connectAgent(
  h: BridgeHarness,
  transport: 'relay-mcp' | 'relay-http' = 'relay-mcp',
  over: { connectionId?: string; displayName?: string; handle?: string } = {},
): Promise<{ row: FakeRow; outcome: ConnectOutcome; relayId: string }> {
  const outcome = await h.connector.connect(connectRequest(transport, over), opts());
  const row = h.core.addFromOutcome(outcome, { connectionId: over.connectionId, handle: over.handle });
  return { row, outcome, relayId: outcome.remoteId };
}
