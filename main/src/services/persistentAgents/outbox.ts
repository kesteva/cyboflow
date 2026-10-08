/**
 * OutboxWorker — claim → send → settle for persistent-agent outbound messages, with ambiguous-send
 * reconcile and backoff.
 *
 * At most one run per agent at a time (outbound order = thread order); a kick during a run sets `rerun`.
 * Every claim is the store's single-statement claim, re-checked against isRunning()/stopped first. A send
 * whose outcome is unknown (timeout after the request went out) becomes 'ambiguous' and is reconciled
 * through the connector's idempotent reconcile BEFORE any new claim, so a crash between claim and settle
 * neither loses nor double-sends a message.
 */
import type { LoggerLike } from '../../orchestrator/types';
import type { PersistentAgentStore } from '../../orchestrator/persistentAgents/persistentAgentStore';
import type { ClaimedMessage } from '../../orchestrator/persistentAgents/rows';
import { isConnectorCallable } from '../../../../shared/types/persistentAgents';
import type { ConnectionHandle, OutboundMessage, ReconcileItem, ReconcileResult } from './connectorContract';
import { ConnectorError, asConnectorError } from './connectorErrors';
import type { ConnectorRegistry } from './connectorRegistry';
import { budgetKeyFor, type TokenBuckets } from './tokenBucket';
import { parseLinks } from '../../orchestrator/persistentAgents/rows';

export const SEND_TIMEOUT_MS = 30_000;
export const BUDGET_WAIT_MS = 5_000;
export const RECONCILE_BATCH = 20;
export const DISABLED_CONNECTOR_RETRY_MS = 5 * 60_000;
export const DEFAULT_RATE_LIMIT_MS = 60_000;

/** min(5 s × 2^(attempt−1), 300 s): 5, 10, 20, 40, 80, 160, 300, 300 … */
export function outboxBackoffMs(attempt: number): number {
  return Math.min(5_000 * 2 ** (Math.max(1, attempt) - 1), 300_000);
}

export interface OutboxDeps {
  store: PersistentAgentStore;
  registry: ConnectorRegistry;
  buildHandle(connectionId: string): ConnectionHandle | null;
  budget: TokenBuckets;
  isRunning(): boolean;
  onAuthFailure(connectionId: string, err: ConnectorError): Promise<void>;
  onRateLimited(connectionId: string, untilIso: string): Promise<void>;
  /** not_found / revoked on a send: the remote connection is gone (connection → revoked). */
  onConnectionGone(connectionId: string, err: ConnectorError): Promise<void>;
  now: () => Date;
  /** Default 0.8–1.2; tests pass () => 1. */
  jitter?: () => number;
  logger: LoggerLike;
  captureSeamError: (seam: string, err: unknown, tags?: Record<string, string>) => void;
  /** Resolves once boot recovery (in-flight → ambiguous) ran; claims wait for it. */
  bootRecovered?: () => Promise<unknown>;
}

function toOutbound(row: ClaimedMessage): OutboundMessage {
  return {
    id: row.id,
    kind: row.kind === 'brief' ? 'brief' : 'text',
    body: row.body,
    links: parseLinks(row.links_json),
    contentHash: row.content_hash ?? '',
    isProbe: row.is_probe === 1,
    createdAt: row.created_at,
  };
}

export class OutboxWorker {
  private stopped = false;
  private readonly active = new Map<string, Promise<void>>();
  private readonly rerun = new Set<string>();
  private readonly jitter: () => number;

  constructor(private readonly deps: OutboxDeps) {
    this.jitter = deps.jitter ?? (() => 0.8 + Math.random() * 0.4);
  }

  /** Coalescing: at most one run per agent; a kick during a run schedules exactly one more. */
  kick(agentId: string): void {
    void this.kickAndWait(agentId);
  }

  /** Called by the pump every 5 s: kicks every agent with due queued/ambiguous rows. */
  sweep(): void {
    if (this.stopped || !this.deps.isRunning()) return;
    let due: string[];
    try {
      due = this.deps.store.listAgentsWithDueOutbound(this.deps.now().toISOString());
    } catch (err) {
      this.deps.logger.warn('[persistent-agents] outbox sweep failed', { error: err instanceof Error ? err.name : 'unknown' });
      return;
    }
    for (const agentId of due) this.kick(agentId);
  }

  /** Sync: no new claims; in-flight sends settle (or become ambiguous at the next boot). */
  stop(): void {
    this.stopped = true;
  }

  /** Sync, idempotent: claims may run again (the pump's sweep re-kicks). */
  start(): void {
    this.stopped = false;
  }

  /** Test seam: kick and wait until that agent's run chain finished. */
  _runForTest(agentId: string): Promise<void> {
    return this.kickAndWait(agentId);
  }

  private kickAndWait(agentId: string): Promise<void> {
    const existing = this.active.get(agentId);
    if (existing) {
      this.rerun.add(agentId);
      return existing;
    }
    const chain = (async () => {
      try {
        do {
          this.rerun.delete(agentId);
          try {
            await this.run(agentId);
          } catch (err) {
            this.deps.logger.warn('[persistent-agents] outbox run failed', { agentId, error: err instanceof Error ? err.name : 'unknown' });
          }
        } while (this.rerun.has(agentId) && !this.stopped);
      } finally {
        this.rerun.delete(agentId);
        this.active.delete(agentId);
      }
    })();
    this.active.set(agentId, chain);
    return chain;
  }

  private nowIso(): string {
    return this.deps.now().toISOString();
  }

  private isoIn(ms: number): string {
    return new Date(this.deps.now().getTime() + ms).toISOString();
  }

  private async run(agentId: string): Promise<void> {
    const { store, registry, budget } = this.deps;
    if (this.stopped || !this.deps.isRunning()) return;

    // 2. Reconcile ambiguous rows first (current connection + a swap target awaiting verification).
    const targets = [store.getCurrentConnection(agentId), store.getSwapTarget(agentId)]
      .filter((c) => c !== null && (c.is_current === 1 || c.swap_state === 'awaiting_verify'));
    for (const conn of targets) {
      if (conn === null) continue;
      await this.reconcileConnection(conn.id);
    }

    if (this.deps.bootRecovered) await this.deps.bootRecovered();

    // 3. Claim loop.
    for (;;) {
      if (this.stopped || !this.deps.isRunning()) return;
      // Gate on, and budget against, the connection the next claim will send through: usually the current
      // one, but a probe on a swap target goes through that target.
      const targetId = store.peekClaimableConnection(agentId, this.nowIso());
      if (targetId === null) return;
      const targetHandle = this.deps.buildHandle(targetId);
      const targetConnector = targetHandle ? registry.get(targetHandle.connectorId) : undefined;
      if (targetHandle && targetConnector && !isConnectorCallable(targetConnector.availability(targetHandle))) return;

      const key = targetHandle && targetConnector ? budgetKeyFor(budget, targetConnector, targetHandle) : `agent:${agentId}`;
      if (!(await budget.take(key, BUDGET_WAIT_MS))) return;
      if (this.stopped || !this.deps.isRunning()) {
        budget.refund(key);
        return;
      }
      const row = await store.claimOutbound(agentId, this.deps.now());
      if (!row) {
        budget.refund(key);
        return;
      }
      const claim = { connectionId: row.connection_id ?? '', generation: row.claim_generation };
      const handle = row.connection_id ? this.deps.buildHandle(row.connection_id) : null;
      const connector = handle ? registry.get(handle.connectorId) : undefined;
      if (!handle || !connector) {
        await store.settleOutbound(row.id, claim, {
          ok: false, kind: 'retryable', maybeDelivered: false, error: 'Connector disabled',
          nextAttemptAt: this.isoIn(DISABLED_CONNECTOR_RETRY_MS),
        });
        return;
      }
      const a = connector.availability(handle);
      if (!isConnectorCallable(a)) {
        await store.settleOutbound(row.id, claim, {
          ok: false, kind: 'paused', maybeDelivered: false, error: a.message ?? 'Paused', nextAttemptAt: null,
        });
        return;
      }

      try {
        const receipt = await connector.send(handle, toOutbound(row), { signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
        await store.settleOutbound(row.id, claim, { ok: true, receipt });
        continue;
      } catch (err) {
        const e = asConnectorError(err);
        const nextAttemptAt = e.kind === 'rate_limited'
          ? this.isoIn(e.retryAfterMs ?? DEFAULT_RATE_LIMIT_MS)
          : this.isoIn(outboxBackoffMs(row.send_attempts) * this.jitter());
        await store.settleOutbound(row.id, claim, {
          ok: false, kind: e.kind, maybeDelivered: e.maybeDelivered, error: e.message, nextAttemptAt,
        });
        const unexpected = !(err instanceof ConnectorError);
        if (unexpected || e.kind === 'permanent') {
          this.deps.captureSeamError('connector-send', unexpected ? err : e, {
            connectorId: handle.connectorId, connectorVersion: String(handle.connectorVersion), errorKind: e.kind,
          });
        }
        switch (e.kind) {
          case 'auth':
            await this.deps.onAuthFailure(handle.connectionId, e);
            return;
          case 'rate_limited':
            await this.deps.onRateLimited(handle.connectionId, nextAttemptAt);
            return;
          case 'not_found':
          case 'revoked':
            await this.deps.onConnectionGone(handle.connectionId, e);
            return;
          case 'invalid':
          case 'permanent':
            continue;
          default:
            // paused / device_auth / not_entitled / upgrade_required: availability reflects it;
            // retryable / conflict: backoff. The pump's sweep re-kicks.
            return;
        }
      }
    }
  }

  /** One reconcile round for a connection's due ambiguous rows; one budget token per item. */
  private async reconcileConnection(connectionId: string): Promise<void> {
    const { store, registry, budget } = this.deps;
    const handle = this.deps.buildHandle(connectionId);
    if (!handle) return;
    const connector = registry.get(handle.connectorId);
    if (!connector || !isConnectorCallable(connector.availability(handle))) return;
    const due = store.listAmbiguous(connectionId, this.nowIso(), RECONCILE_BATCH);
    if (due.length === 0) return;
    const key = budgetKeyFor(budget, connector, handle);
    let taken = 0;
    for (let i = 0; i < due.length; i++) {
      if (!(await budget.take(key, BUDGET_WAIT_MS))) break;
      taken += 1;
    }
    if (taken === 0) return;
    const rows = due.slice(0, taken);
    const items: ReconcileItem[] = rows.map((r) => ({
      messageId: r.id,
      contentHash: r.content_hash ?? '',
      createdAt: r.created_at,
      body: r.body,
      links: parseLinks(r.links_json),
      kind: r.kind === 'brief' ? 'brief' : 'text',
    }));
    const nextAt = (attempts: number): string => this.isoIn(outboxBackoffMs(attempts));
    let results: ReconcileResult[];
    try {
      results = await connector.reconcile(handle, items, items[0].createdAt, { signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    } catch (err) {
      const e = asConnectorError(err);
      if (!(err instanceof ConnectorError) || e.kind === 'permanent') {
        this.deps.captureSeamError('connector-send', err instanceof ConnectorError ? e : err, {
          connectorId: handle.connectorId, connectorVersion: String(handle.connectorVersion), errorKind: e.kind,
        });
      }
      results = items.map((i) => ({ messageId: i.messageId, outcome: 'unknown' as const }));
    }
    await store.applyReconcile(connectionId, results, nextAt);
  }
}
