/**
 * InboundPump — schedules connector pulls for every live connection and applies each batch through the
 * store, acknowledging only AFTER the batch committed.
 *
 * One unref'd 1 s interval drives everything: target refresh (every 30 s or after any persistent-agents
 * change event), the 60 s stale sweep, the 5 s outbox sweep, the 30 s remote-revoke retries, and the due
 * pulls (at most 4 in flight). Active connections (recent outbound, remote 'working', a pending pairing or
 * a repair in the last 30 min) poll every 5 s; idle ones back off 60 → 120 → 240 → 300 s and reset when
 * content arrives. Launch catch-up is staggered so a fleet of connections does not stampede the relay.
 *
 * Never reads the DB while not running; stop() is synchronous (in-flight pulls finish but are not awaited).
 */
import type { LoggerLike } from '../../orchestrator/types';
import type { PersistentAgentStore } from '../../orchestrator/persistentAgents/persistentAgentStore';
import {
  persistentAgentEvents,
  PERSISTENT_AGENTS_CHANNEL,
} from '../../orchestrator/persistentAgentsBridge';
import { parseRemoteStatus, toConnectionState, toConnectorKind } from '../../orchestrator/persistentAgents/rows';
import {
  isConnectorCallable,
  type ConnectionState,
  type ConnectorKind,
  type RemoteStatus,
} from '../../../../shared/types/persistentAgents';
import type { AgentConnector, ConnectionHandle, InboundBatch } from './connectorContract';
import { ConnectorError, asConnectorError } from './connectorErrors';
import type { ConnectorRegistry } from './connectorRegistry';
import type { OutboxWorker } from './outbox';
import { budgetKeyFor, type TokenBuckets } from './tokenBucket';

export const PUMP_TICK_MS = 1_000;
export const ACTIVE_POLL_MS = 5_000;
export const IDLE_POLL_MIN_MS = 60_000;
export const IDLE_POLL_MAX_MS = 300_000;
export const ACTIVE_WINDOW_MS = 10 * 60_000;
export const PENDING_ACTIVE_WINDOW_MS = 30 * 60_000;
export const CATCH_UP_DELAY_MS = 5_000;
export const CATCH_UP_SPREAD_MAX_MS = 55_000;
export const TARGET_REFRESH_MS = 30_000;
export const STALE_SWEEP_MS = 60_000;
export const OUTBOX_SWEEP_MS = 5_000;
export const REVOKE_SWEEP_MS = 30_000;
export const MAX_CONCURRENT_PULLS = 4;
export const PULL_TIMEOUT_MS = 30_000;
export const DEFAULT_RATE_LIMIT_MS = 60_000;

export interface PumpTarget { connectionId: string; connectorId: string; agentId: string }

export interface PumpEntry {
  connectionId: string;
  agentId: string;
  connectorId: string;
  kind: ConnectorKind;
  state: ConnectionState;
  createdAtMs: number;
  remoteStatus: RemoteStatus | null;
  nextDueAt: number;
  idleIntervalMs: number;
  /** The in-flight pull (or drain) of this connection; null when idle. */
  inFlight: Promise<void> | null;
  rerun: boolean;
  rateLimitedUntilMs: number;
  authRetryAtMs: number | null;
  /** Poll actively until this time (a fresh pairing or a repair). */
  activeUntilMs: number;
}

export interface PumpConnections {
  onConnectionVerified(connectionId: string): Promise<void>;
  runRevokeRetries(): Promise<void>;
  onAuthFailure(connectionId: string, err: ConnectorError): Promise<void>;
  onConnectionGone(connectionId: string, err: ConnectorError): Promise<void>;
}

export interface InboundPumpDeps {
  store: PersistentAgentStore;
  registry: ConnectorRegistry;
  buildHandle(connectionId: string): ConnectionHandle | null;
  budget: TokenBuckets;
  outbox: Pick<OutboxWorker, 'sweep'>;
  connections: PumpConnections;
  isRunning(): boolean;
  now: () => Date;
  /** Fake-timer seams. */
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (t: ReturnType<typeof setInterval>) => void;
  logger: LoggerLike;
  captureSeamError: (seam: string, err: unknown, tags?: Record<string, string>) => void;
  /** Resolves once boot recovery ran; the interval is armed after it. */
  bootRecovered?: () => Promise<unknown>;
}

const NEVER_ABORTS = new AbortController().signal;

function parseMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

export class InboundPump {
  private started = false;
  private interval: ReturnType<typeof setInterval> | null = null;
  private entries = new Map<string, PumpEntry>();
  private dirty = true;
  private lastRefresh = 0;
  private lastStale = 0;
  private lastOutbox = 0;
  private lastRevoke = 0;
  private lastOutbound = new Map<string, number>();
  private readonly pendingActive = new Map<string, number>();
  /** Connections a final drain holds (keyed by connectionId, independent of the entry map). */
  private readonly draining = new Map<string, Promise<void>>();
  private unsubscribe: (() => void) | null = null;
  private lastTargetRows: ReturnType<PersistentAgentStore['listPumpTargets']> = [];
  /** Bumped on every start/stop so a stale arm callback never re-arms a stopped pump. */
  private epoch = 0;

  constructor(private readonly deps: InboundPumpDeps) {}

  private nowMs(): number {
    return this.deps.now().getTime();
  }

  /** Idempotent. Seeds targets with the catch-up stagger and arms one unref'd interval (after boot recovery). */
  start(): void {
    if (this.started) return;
    this.started = true;
    const epoch = ++this.epoch;
    const onChange = (): void => { this.dirty = true; };
    persistentAgentEvents.on(PERSISTENT_AGENTS_CHANNEL, onChange);
    this.unsubscribe = () => persistentAgentEvents.off(PERSISTENT_AGENTS_CHANNEL, onChange);
    const arm = (): void => {
      if (!this.started || epoch !== this.epoch) return;
      if (this.deps.isRunning()) this.seedCatchUp();
      const t = this.deps.setInterval(() => this.tick(), PUMP_TICK_MS);
      (t as { unref?: () => void }).unref?.();
      this.interval = t;
    };
    if (this.deps.bootRecovered) {
      void this.deps.bootRecovered().then(arm, arm);
    } else {
      arm();
    }
  }

  /** Sync, idempotent. Clears the interval; in-flight pulls finish but are not awaited. */
  stop(): void {
    this.epoch += 1;
    this.started = false;
    if (this.interval !== null) {
      this.deps.clearInterval(this.interval);
      this.interval = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.entries = new Map();
    this.dirty = true;
  }

  /** Doorbell / UI hook: pull as soon as the budget allows; coalesces with an in-flight pull. */
  kick(connectionId: string): void {
    if (!this.started || !this.deps.isRunning()) return;
    let entry = this.entries.get(connectionId);
    if (!entry) {
      this.refreshTargets();
      entry = this.entries.get(connectionId);
      if (!entry) return;
    }
    if (entry.inFlight) {
      entry.rerun = true;
      return;
    }
    entry.nextDueAt = this.nowMs();
    // While a final drain holds the connection, runDue skips it; the drain re-runs runDue when it ends.
    if (!this.draining.has(connectionId)) queueMicrotask(() => this.runDue());
  }

  kickAll(filter?: (t: PumpTarget) => boolean): void {
    if (!this.started || !this.deps.isRunning()) return;
    if (this.dirty) this.refreshTargets();
    for (const e of [...this.entries.values()]) {
      if (!filter || filter({ connectionId: e.connectionId, connectorId: e.connectorId, agentId: e.agentId })) {
        this.kick(e.connectionId);
      }
    }
  }

  /** A user send: the agent's connections poll actively for the next ACTIVE_WINDOW_MS. */
  noteOutbound(agentId: string, atMs: number): void {
    this.lastOutbound.set(agentId, Math.max(this.lastOutbound.get(agentId) ?? 0, atMs));
    const soon = this.nowMs() + ACTIVE_POLL_MS;
    for (const e of this.entries.values()) {
      if (e.agentId === agentId && !e.inFlight && e.nextDueAt > soon) e.nextDueAt = soon;
    }
  }

  /** A fresh pairing or a repair: poll this connection actively for PENDING_ACTIVE_WINDOW_MS. */
  noteActive(connectionId: string): void {
    const now = this.nowMs();
    const until = now + PENDING_ACTIVE_WINDOW_MS;
    this.pendingActive.set(connectionId, until);
    const e = this.entries.get(connectionId);
    if (e) {
      e.activeUntilMs = Math.max(e.activeUntilMs, until);
      if (!e.inFlight && e.nextDueAt > now + ACTIVE_POLL_MS) e.nextDueAt = now + ACTIVE_POLL_MS;
    } else {
      this.dirty = true;
    }
  }

  /**
   * Final drain of one connection (never throws): waits for its in-flight pull, then holds the
   * connection and loops pull → apply → acknowledge while the relay reports more, up to maxPages.
   * Works for a connection that is not (or no longer) a pump entry.
   */
  async drainNow(
    connectionId: string,
    opts: { maxPages?: number; signal?: AbortSignal } = {},
  ): Promise<{ pages: number; complete: boolean }> {
    const maxPages = opts.maxPages ?? 50;
    let entry = this.entries.get(connectionId);
    for (;;) {
      const other = this.draining.get(connectionId);
      if (other) {
        await other;
      } else if (entry?.inFlight) {
        await entry.inFlight.catch(() => undefined);
      } else {
        break;
      }
      entry = this.entries.get(connectionId);
    }
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    // Held by id for the whole drain: an entry created mid-drain (target refresh, kick) is never pulled
    // concurrently by runDue, so the cursor and acknowledge order cannot regress.
    this.draining.set(connectionId, hold);
    if (entry) entry.inFlight = hold;
    let pages = 0;
    let complete = false;
    try {
      for (;;) {
        if (opts.signal?.aborted) break;
        const h = this.deps.buildHandle(connectionId);
        if (!h) break;
        const connector = this.deps.registry.get(h.connectorId);
        if (!connector || !isConnectorCallable(connector.availability(h))) break;
        const key = budgetKeyFor(this.deps.budget, connector, h);
        if (!(await this.deps.budget.take(key, 5_000))) break;
        const signal = AbortSignal.any([AbortSignal.timeout(PULL_TIMEOUT_MS), opts.signal ?? NEVER_ABORTS]);
        const batch = await connector.pull(h, h.inboundCursor, { signal });
        const res = await this.deps.store.applyInboundBatch(connectionId, batch, { expectedRelayEpoch: h.relayEpoch });
        pages += 1;
        if (!res.fenced) await this.acknowledge(connector, h, batch);
        if (res.becameVerified) void this.deps.connections.onConnectionVerified(connectionId).catch(() => undefined);
        if (!res.fenced && !batch.hasMore) {
          complete = true;
          break;
        }
        if (pages >= maxPages) break;
      }
    } catch (err) {
      this.deps.logger.warn('[persistent-agents] final drain stopped', {
        connectionId, error: err instanceof ConnectorError ? err.kind : 'unexpected',
      });
    } finally {
      this.draining.delete(connectionId);
      if (entry && entry.inFlight === hold) {
        entry.inFlight = null;
        if (entry.rerun) {
          entry.rerun = false;
          entry.nextDueAt = this.nowMs();
        }
      }
      const now = this.entries.get(connectionId);
      if (now && !now.inFlight && now.nextDueAt <= this.nowMs()) queueMicrotask(() => this.runDue());
      release();
    }
    return { pages, complete };
  }

  /** Test seam. */
  _entries(): ReadonlyMap<string, PumpEntry> {
    return this.entries;
  }

  // -------------------------------------------------------------------------

  private tick(): void {
    if (!this.started || !this.deps.isRunning()) return;
    const now = this.nowMs();
    if (this.dirty || now - this.lastRefresh >= TARGET_REFRESH_MS) this.refreshTargets();
    if (now - this.lastStale >= STALE_SWEEP_MS) {
      this.lastStale = now;
      void this.deps.store.markStale(this.deps.now()).catch((err: unknown) => {
        this.deps.logger.warn('[persistent-agents] stale sweep failed', { error: err instanceof Error ? err.name : 'unknown' });
      });
    }
    if (now - this.lastOutbox >= OUTBOX_SWEEP_MS) {
      this.lastOutbox = now;
      this.deps.outbox.sweep();
    }
    if (now - this.lastRevoke >= REVOKE_SWEEP_MS) {
      this.lastRevoke = now;
      void this.deps.connections.runRevokeRetries().catch(() => undefined);
    }
    this.runDue();
  }

  private seedCatchUp(): void {
    const now = this.nowMs();
    this.lastStale = now;
    this.lastOutbox = now;
    this.lastRevoke = now;
    this.entries = new Map();
    this.refreshTargets();
    const ordered = [...this.entries.values()];
    const seen = new Map<string, string | null>();
    for (const r of this.lastTargetRows) seen.set(r.id, r.last_seen_at);
    ordered.sort((a, b) => {
      const sa = seen.get(a.connectionId) ?? '';
      const sb = seen.get(b.connectionId) ?? '';
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
    const step = Math.min(2_000, CATCH_UP_SPREAD_MAX_MS / Math.max(ordered.length, 1));
    ordered.forEach((e, i) => { e.nextDueAt = now + CATCH_UP_DELAY_MS + Math.floor(i * step); });
  }

  private refreshTargets(): void {
    const now = this.nowMs();
    this.dirty = false;
    this.lastRefresh = now;
    let rows: ReturnType<PersistentAgentStore['listPumpTargets']>;
    try {
      rows = this.deps.store.listPumpTargets();
      for (const [agentId, at] of this.deps.store.lastOutboundAtByAgent()) {
        const ms = parseMs(at);
        if (ms !== null) this.lastOutbound.set(agentId, Math.max(this.lastOutbound.get(agentId) ?? 0, ms));
      }
    } catch (err) {
      this.deps.logger.warn('[persistent-agents] pump target refresh failed', { error: err instanceof Error ? err.name : 'unknown' });
      return;
    }
    this.lastTargetRows = rows;
    const next = new Map<string, PumpEntry>();
    for (const r of rows) {
      const prev = this.entries.get(r.id);
      const activeUntil = Math.max(prev?.activeUntilMs ?? 0, this.pendingActive.get(r.id) ?? 0);
      this.pendingActive.delete(r.id);
      const rateLimitedUntilMs = Math.max(prev?.rateLimitedUntilMs ?? 0, parseMs(r.rate_limited_until) ?? 0);
      if (prev) {
        prev.state = toConnectionState(r.state);
        prev.remoteStatus = parseRemoteStatus(r.remote_status_json) ?? prev.remoteStatus;
        prev.authRetryAtMs = parseMs(r.auth_retry_at);
        prev.activeUntilMs = activeUntil;
        prev.rateLimitedUntilMs = rateLimitedUntilMs;
        next.set(r.id, prev);
      } else {
        next.set(r.id, {
          connectionId: r.id,
          agentId: r.agent_id,
          connectorId: r.connector_id,
          kind: toConnectorKind(r.kind),
          state: toConnectionState(r.state),
          createdAtMs: parseMs(r.created_at) ?? now,
          remoteStatus: parseRemoteStatus(r.remote_status_json),
          nextDueAt: now,
          idleIntervalMs: IDLE_POLL_MIN_MS / 2,
          inFlight: null,
          rerun: false,
          rateLimitedUntilMs,
          authRetryAtMs: parseMs(r.auth_retry_at),
          activeUntilMs: activeUntil,
        });
      }
    }
    this.entries = next;
  }

  private runDue(): void {
    if (!this.started || !this.deps.isRunning()) return;
    const now = this.nowMs();
    let inFlight = 0;
    for (const e of this.entries.values()) if (e.inFlight) inFlight += 1;
    const due = [...this.entries.values()]
      .filter((e) => !e.inFlight && !this.draining.has(e.connectionId) && e.nextDueAt <= now && e.rateLimitedUntilMs <= now)
      .sort((a, b) => a.nextDueAt - b.nextDueAt);
    for (const e of due) {
      if (inFlight >= MAX_CONCURRENT_PULLS) break;
      const connector = this.deps.registry.get(e.connectorId);
      if (!connector) {
        e.nextDueAt = now + IDLE_POLL_MIN_MS;
        continue;
      }
      if (e.state === 'auth_failed' && !(e.authRetryAtMs !== null && e.authRetryAtMs <= now)) {
        e.nextDueAt = now + IDLE_POLL_MIN_MS;
        continue;
      }
      const h = this.deps.buildHandle(e.connectionId);
      if (!h) {
        this.dirty = true;
        continue;
      }
      const a = connector.availability(h);
      if (!isConnectorCallable(a)) {
        e.nextDueAt = this.retryAtOrIdle(a.retryAt, now);
        continue;
      }
      const key = budgetKeyFor(this.deps.budget, connector, h);
      if (!this.deps.budget.tryTake(key)) {
        e.nextDueAt = this.deps.budget.nextAvailableAt(key);
        continue;
      }
      inFlight += 1;
      const p = this.pullOnce(e, connector, h);
      e.inFlight = p;
    }
  }

  private retryAtOrIdle(retryAt: string | null, now: number): number {
    const t = parseMs(retryAt);
    return t !== null ? Math.max(now + 1_000, t) : now + IDLE_POLL_MIN_MS;
  }

  private isActive(e: PumpEntry, batch: InboundBatch | null, now: number): boolean {
    const lastOut = this.lastOutbound.get(e.agentId) ?? 0;
    if (lastOut >= now - ACTIVE_WINDOW_MS) return true;
    if ((batch?.remoteStatus ?? e.remoteStatus) === 'working') return true;
    if (e.state === 'pending' && e.createdAtMs >= now - PENDING_ACTIVE_WINDOW_MS) return true;
    return now < e.activeUntilMs;
  }

  private async acknowledge(connector: AgentConnector, h: ConnectionHandle, batch: InboundBatch): Promise<void> {
    if (!batch.ackToken || !connector.acknowledge) return;
    try {
      await connector.acknowledge(h, batch.ackToken, { signal: AbortSignal.timeout(PULL_TIMEOUT_MS) });
    } catch (err) {
      // The next pull re-serves the page and the store dedupes it.
      this.deps.logger.warn('[persistent-agents] acknowledge failed', {
        connectionId: h.connectionId, error: err instanceof ConnectorError ? err.kind : 'unexpected',
      });
    }
  }

  private async pullOnce(e: PumpEntry, connector: AgentConnector, h: ConnectionHandle): Promise<void> {
    const id = e.connectionId;
    try {
      let batch: InboundBatch;
      try {
        batch = await connector.pull(h, h.inboundCursor, { signal: AbortSignal.timeout(PULL_TIMEOUT_MS) });
      } catch (err) {
        await this.onPullError(e, connector, h, err);
        return;
      }
      let res: Awaited<ReturnType<PersistentAgentStore['applyInboundBatch']>>;
      try {
        res = await this.deps.store.applyInboundBatch(id, batch, { expectedRelayEpoch: h.relayEpoch });
      } catch (err) {
        this.deps.captureSeamError('connector-inbound', err, {
          connectorId: h.connectorId, connectorVersion: String(h.connectorVersion), errorKind: 'apply',
        });
        e.nextDueAt = this.nowMs() + IDLE_POLL_MIN_MS;
        return;
      }
      if (res.fenced) {
        // A repair committed while this pull was in flight: the ack token belongs to the old epoch.
        e.nextDueAt = this.nowMs();
        return;
      }
      await this.acknowledge(connector, h, batch);
      if (res.becameVerified) void this.deps.connections.onConnectionVerified(id).catch(() => undefined);
      if (batch.remoteStatus) e.remoteStatus = batch.remoteStatus;
      const now = this.nowMs();
      e.rateLimitedUntilMs = 0;
      if (batch.hasMore) {
        e.nextDueAt = now;
        return;
      }
      const hadContent = batch.messages.length > 0 || batch.receipts.length > 0 || batch.activity.length > 0;
      e.idleIntervalMs = hadContent ? IDLE_POLL_MIN_MS : Math.min(e.idleIntervalMs * 2, IDLE_POLL_MAX_MS);
      e.nextDueAt = now + (this.isActive(e, batch, now) ? ACTIVE_POLL_MS : e.idleIntervalMs);
    } finally {
      e.inFlight = null;
      if (e.rerun) {
        e.rerun = false;
        e.nextDueAt = this.nowMs();
        queueMicrotask(() => this.runDue());
      }
    }
  }

  private async onPullError(e: PumpEntry, connector: AgentConnector, h: ConnectionHandle, err: unknown): Promise<void> {
    const ce = asConnectorError(err);
    const now = this.nowMs();
    const tags = { connectorId: h.connectorId, connectorVersion: String(h.connectorVersion), errorKind: ce.kind };
    if (!(err instanceof ConnectorError)) {
      this.deps.captureSeamError('connector-inbound', err, tags);
      e.nextDueAt = now + IDLE_POLL_MAX_MS;
      return;
    }
    switch (ce.kind) {
      case 'auth':
        e.nextDueAt = now + IDLE_POLL_MIN_MS;
        await this.deps.connections.onAuthFailure(e.connectionId, ce).catch(() => undefined);
        return;
      case 'rate_limited': {
        e.rateLimitedUntilMs = now + (ce.retryAfterMs ?? DEFAULT_RATE_LIMIT_MS);
        e.nextDueAt = e.rateLimitedUntilMs;
        await this.deps.store
          .setConnectionState(e.connectionId, { rateLimitedUntil: new Date(e.rateLimitedUntilMs).toISOString() })
          .catch(() => undefined);
        return;
      }
      case 'retryable':
      case 'conflict':
        e.nextDueAt = now + Math.min(e.idleIntervalMs * 2, IDLE_POLL_MAX_MS);
        return;
      case 'not_found':
      case 'revoked':
        e.nextDueAt = now + IDLE_POLL_MAX_MS;
        this.dirty = true;
        await this.deps.connections.onConnectionGone(e.connectionId, ce).catch(() => undefined);
        return;
      case 'paused':
        e.nextDueAt = this.retryAtOrIdle(connector.availability(h).retryAt, now);
        return;
      case 'device_auth':
      case 'not_entitled':
      case 'upgrade_required':
        e.nextDueAt = now + IDLE_POLL_MIN_MS;
        return;
      case 'invalid':
      case 'permanent':
        this.deps.captureSeamError('connector-inbound', ce, tags);
        e.nextDueAt = now + IDLE_POLL_MAX_MS;
        return;
    }
  }
}
