/**
 * The cyboflow Bridge connector: an AgentConnector over the relay's desktop API.
 *
 * - Every public method checks availability first and refuses WITHOUT network when the Bridge is not
 *   callable (kill switch, signed out, locked, revoked, relay gate, other account, unreadable record).
 * - pull() returns one page and never acks; acknowledge() runs only after the core committed the batch,
 *   with the page's own epoch, and never throws.
 * - send()/reconcile() reuse the local message id as the envelope id, so every retry is idempotent.
 * - Every call honours `o.signal`: budget wait, fetch, lock wait and revoke retry sleep.
 */
import {
  MAX_INBOUND_PAGE,
  MAX_MESSAGE_BYTES,
  PAIRING_TTL_MS,
  type PairedClient,
} from '../../../../../../shared/types/relayProtocol';
import {
  isConnectorCallable,
  PAIRING_DISPLAY_SAFETY_MS,
  vendorAppName,
  type BridgePairingPayload,
  type ConnectorAvailability,
  type VerifyFact,
} from '../../../../../../shared/types/persistentAgents';
import type { LoggerLike } from '../../../../orchestrator/types';
import type { CloudAccountHandle } from '../../../cloud/cloudAccountHandle';
import type {
  AgentConnector,
  ConnectionHandle,
  ConnectorCallOptions,
  ConnectOutcome,
  ConnectRequest,
  InboundBatch,
  OutboundMessage,
  ReconcileItem,
  ReconcileResult,
  RepairOutcome,
  SendReceipt,
  VerifyOutcome,
} from '../../connectorContract';
import { ConnectorError } from '../../connectorErrors';
import {
  bridgeRemoteMatchesAccount,
  encodeBridgeCursor,
  parseAckToken,
  parseBridgeCursor,
  parseBridgeRemote,
  samePairedClient,
  sanitizeClientName,
  sanitizeLabel,
  sanitizePairedClient,
  type BridgeRemoteV1,
} from './bridgeRemote';
import type { BridgeAvailabilityDetail, BridgeRuntime } from './bridgeRuntime';
import { BRIDGE_COPY } from './copy';
import {
  BRIDGE_BUDGET_KEY,
  BRIDGE_ENVELOPE_ID_RE,
  BRIDGE_LINK_RE,
  BRIDGE_MAX_LINK_CHARS,
  BRIDGE_MAX_LINKS,
  BRIDGE_PROBE_TEXT,
  CAPTURE_THROTTLE_MS,
  CONNECT_INIT_FAILED_RETRIES,
  RELAY_BUDGET_CAPACITY,
  RELAY_BUDGET_REFILL_PER_MIN,
  REVOKE_DEFAULT_RETRY_MS,
  REVOKE_INLINE_ATTEMPTS,
} from './constants';
import { BRIDGE_DEFINITION } from './descriptor';
import { mapInboundPage } from './inboundMapper';
import { buildHttpInstructionBrief } from './instructionBrief';
import { isRelayHttpError, RelayHttpError, toConnectorError } from './relayErrors';
import type { RelayClient } from './relayClient';
import type { BridgeGoneReason, CaptureSeamErrorFn } from './types';

export interface BridgeConnectorDeps {
  relay: RelayClient;
  runtime: Pick<BridgeRuntime, 'availabilityDetail' | 'status' | 'signal'>;
  cloud: Pick<CloudAccountHandle, 'getDevice'>;
  reportRemotePatch(connectionId: string, patch: Record<string, unknown>): Promise<void>;
  reportConnectionGone(connectionId: string, reason: BridgeGoneReason): Promise<void>;
  captureSeamError: CaptureSeamErrorFn;
  logger: LoggerLike;
  now?: () => number;
  /** Terminal teardown of the owning Bridge (quit only). */
  onDispose?: () => void;
}

class SleepAborted extends Error {
  constructor() {
    super('sleep aborted');
    this.name = 'AbortError';
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new SleepAborted());
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new SleepAborted());
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    (t as { unref?: () => void }).unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function timeoutError(): ConnectorError {
  return new ConnectorError('retryable', 'Bridge call timed out', { code: 'timeout', maybeDelivered: false });
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function isoOrNull(ms: number): string | null {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

export class BridgeConnector implements AgentConnector {
  readonly definition = BRIDGE_DEFINITION;
  private readonly now: () => number;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly lastAcked = new Map<string, { epoch: number; upTo: number }>();
  private readonly afterOverride = new Map<string, { epoch: number; after: number }>();
  private readonly malformedCursorWarned = new Set<string>();
  private readonly invalidRemoteCaptured = new Set<string>();
  private lastBeyondServedCapture = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: BridgeConnectorDeps) {
    this.now = deps.now ?? Date.now;
  }

  // ---- availability -------------------------------------------------------------------------------

  private availabilityFor(h?: ConnectionHandle): BridgeAvailabilityDetail {
    const account = this.deps.runtime.availabilityDetail();
    if (!h || !isConnectorCallable(account.availability)) return account;
    const remote = parseBridgeRemote(h.remote);
    if (remote === null) {
      if (!this.invalidRemoteCaptured.has(h.connectionId)) {
        this.invalidRemoteCaptured.add(h.connectionId);
        this.deps.captureSeamError('relay-drain', new Error('Bridge connection record is unreadable'), {
          connectorId: 'bridge', relayCode: 'invalid_remote',
        });
      }
      return {
        availability: { state: 'disabled', message: BRIDGE_COPY.invalid_remote, retryAt: null },
        code: 'invalid_remote',
      };
    }
    if (!bridgeRemoteMatchesAccount(remote, this.deps.cloud.getDevice())) {
      return {
        availability: { state: 'other_account', message: BRIDGE_COPY.other_account, retryAt: null },
        code: 'other_account',
      };
    }
    return account;
  }

  availability(h?: ConnectionHandle): ConnectorAvailability {
    return this.availabilityFor(h).availability;
  }

  /** Throws (no network) unless callable. Returns the parsed remote when a handle was given. */
  private ensureCallable(h: ConnectionHandle): BridgeRemoteV1;
  private ensureCallable(h?: undefined): null;
  private ensureCallable(h?: ConnectionHandle): BridgeRemoteV1 | null {
    const d = this.availabilityFor(h);
    if (!isConnectorCallable(d.availability)) {
      // Every non-callable availability is a paused refusal (no network, attempt not counted). A relay
      // block (429/503 Retry-After) also carries its wait; the block's end flips availability back to
      // callable and notifies the core, which wakes the paused work.
      if (d.code === 'blocked' && d.availability.retryAt !== null) {
        return this.throwBlocked(d.availability.retryAt, d.availability.message);
      }
      throw new ConnectorError('paused', d.availability.message ?? 'The Bridge is paused.', { code: d.code });
    }
    if (!h) return null;
    const remote = parseBridgeRemote(h.remote);
    if (remote === null) {
      throw new ConnectorError('paused', BRIDGE_COPY.invalid_remote, { code: 'invalid_remote' });
    }
    return remote;
  }

  private throwBlocked(retryAt: string, message: string | null): never {
    throw new ConnectorError('paused', message ?? BRIDGE_COPY.rate_limited, {
      code: 'rate_limited', retryAfterMs: Math.max(0, Date.parse(retryAt) - this.now()),
    });
  }

  budget(_h: ConnectionHandle): { key: string; ratePerMinute: number; capacity: number } {
    return { key: BRIDGE_BUDGET_KEY, ratePerMinute: RELAY_BUDGET_REFILL_PER_MIN, capacity: RELAY_BUDGET_CAPACITY };
  }

  // ---- per-connection serialisation --------------------------------------------------------------

  private async withLock<T>(key: string, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const mine = new Promise<void>((r) => { release = r; });
    const chain = prev.then(() => mine);
    this.locks.set(key, chain);
    try {
      if (signal.aborted) throw timeoutError();
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => reject(timeoutError());
        signal.addEventListener('abort', onAbort, { once: true });
        prev.then(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        });
      });
      return await fn();
    } finally {
      release();
      // Drop the entry only once the whole chain has settled: a waiter that gave up (abort) must not
      // leave the next caller an empty slot while an earlier holder is still running.
      void chain.then(() => {
        if (this.locks.get(key) === chain) this.locks.delete(key);
      });
    }
  }

  // ---- facts ------------------------------------------------------------------------------------

  describeFacts(h: ConnectionHandle): VerifyFact[] {
    const remote = parseBridgeRemote(h.remote);
    if (remote === null) return [];
    const done = (key: string, label: string, at: string | null, subject?: VerifyFact['subject']): VerifyFact =>
      ({ key, label, at, status: 'done', ...(subject ? { subject } : {}) });
    const waiting = (key: string, label: string): VerifyFact => ({ key, label, at: null, status: 'waiting' });
    const facts: VerifyFact[] = [];
    if (remote.transport === 'relay-mcp') {
      facts.push(done('pairing-issued', 'Pairing code issued', remote.pairingIssuedAt));
      const pc = remote.pairedClient;
      facts.push(pc
        ? done('paired', 'Paired with', isoOrNull(pc.pairedAt), { name: sanitizeClientName(pc.name), host: pc.redirectHost })
        : waiting('paired', `Waiting for ${vendorAppName(h.vendor)} to sign in with the code…`));
      facts.push(remote.pairCalledAt !== null
        ? done('pair-called', 'Connector confirmed the pairing', remote.pairCalledAt)
        : waiting('pair-called', 'Waiting for the connector to confirm the pairing…'));
    } else {
      facts.push(done('token-issued', 'Token issued', remote.pairingIssuedAt ?? null));
      facts.push(remote.firstInboundAt !== null
        ? done('first-call', 'First call received', remote.firstInboundAt)
        : waiting('first-call', 'Waiting for its first call to the mailbox…'));
    }
    facts.push(remote.firstPickupAt !== null
      ? done('picked-up', 'Picked up a message', remote.firstPickupAt)
      : waiting('picked-up', 'Waiting for it to pick up a message…'));
    facts.push(h.state === 'verified'
      ? done('round-trip', 'Round trip verified', null)
      : waiting('round-trip', 'Waiting for its first reply…'));
    return facts;
  }

  // ---- connect ---------------------------------------------------------------------------------

  async connect(req: ConnectRequest, o: ConnectorCallOptions): Promise<ConnectOutcome> {
    this.ensureCallable();
    if (req.input.kind !== 'bridge') {
      throw new ConnectorError('invalid', 'The Bridge only creates Bridge connections', { code: 'unsupported_kind' });
    }
    const transport = req.input.transport;
    const label = sanitizeLabel(req.input.label ?? req.agent.displayName);
    const before = this.deps.relay.identity();
    let res: Awaited<ReturnType<RelayClient['createConnection']>> | null = null;
    for (let attempt = 0; attempt <= CONNECT_INIT_FAILED_RETRIES; attempt += 1) {
      try {
        res = await this.deps.relay.createConnection(
          { transport, ...(label !== null ? { label } : {}) },
          { signal: o.signal },
        );
        break;
      } catch (e) {
        if (isRelayHttpError(e) && e.kind === 'connection_init_failed' && attempt < CONNECT_INIT_FAILED_RETRIES) continue;
        throw toConnectorError(e, 'connect');
      }
    }
    if (res === null) throw new ConnectorError('retryable', 'Bridge connect failed', { code: 'connection_init_failed' });

    const after = this.deps.relay.identity();
    if (before === null || after === null || before.deviceId !== after.deviceId
      || before.origin !== after.origin || before.accountId !== after.accountId) {
      await this.bestEffortRevoke(res.connectionId, o.signal);
      throw new ConnectorError('paused', BRIDGE_COPY.other_account, { code: 'other_account' });
    }
    if (transport === 'relay-http' && (typeof res.token !== 'string' || res.token === '')) {
      this.deps.captureSeamError('connector-verify', new Error('Bridge relay-http connection created without a token'), {
        connectorId: 'bridge', relayCode: 'missing_token',
      });
      await this.bestEffortRevoke(res.connectionId, o.signal);
      throw new ConnectorError('permanent', 'Bridge connect failed (missing_token)', { code: 'missing_token' });
    }

    const issuedAt = this.now();
    const issuedIso = new Date(issuedAt).toISOString();
    const remote: BridgeRemoteV1 = {
      v: 1,
      origin: before.origin,
      accountId: before.accountId,
      relayConnectionId: res.connectionId,
      transport,
      label,
      mcpUrl: res.mcpUrl,
      httpBase: res.httpBase,
      pairingIssuedAt: issuedIso,
      pairedClient: null,
      pairCalledAt: null,
      firstInboundAt: null,
      firstPickupAt: null,
      relayState: 'active',
    };
    const pairing = this.pairingPayload(req.connectionId, remote, issuedAt, res.pairingCode, res.token ?? null, req.agent.handle);
    const mcp = transport === 'relay-mcp';
    return {
      remoteId: res.connectionId,
      remote: { ...remote },
      transport,
      inboundCursor: null,
      relayEpoch: null,
      pairing,
      facts: [{
        key: mcp ? 'pairing-issued' : 'token-issued',
        label: mcp ? 'Pairing code issued' : 'Token issued',
        at: issuedIso,
        status: 'done',
      }],
    };
  }

  private pairingPayload(
    connectionId: string,
    remote: BridgeRemoteV1,
    issuedAt: number,
    pairingCode: string,
    token: string | null,
    handle: string,
  ): BridgePairingPayload {
    if (remote.transport === 'relay-mcp') {
      return {
        kind: 'bridge',
        connectionId,
        transport: 'relay-mcp',
        mcpUrl: remote.mcpUrl,
        httpBase: remote.httpBase,
        pairingCode,
        pairingExpiresAt: new Date(issuedAt + PAIRING_TTL_MS - PAIRING_DISPLAY_SAFETY_MS).toISOString(),
        oneTimeToken: null,
        instructionBrief: null,
      };
    }
    return {
      kind: 'bridge',
      connectionId,
      transport: 'relay-http',
      mcpUrl: remote.mcpUrl,
      httpBase: remote.httpBase,
      pairingCode: null,
      pairingExpiresAt: null,
      oneTimeToken: token,
      instructionBrief: token !== null ? buildHttpInstructionBrief({ httpBase: remote.httpBase, token, handle }) : null,
    };
  }

  private async bestEffortRevoke(relayId: string, signal: AbortSignal): Promise<void> {
    try {
      await this.deps.relay.revoke(relayId, { signal });
    } catch (e) {
      this.deps.logger.info('[bridge] rollback revoke failed', {
        relay: relayId.slice(0, 10), kind: isRelayHttpError(e) ? e.kind : 'unknown',
      });
    }
  }

  async rollbackConnect(_req: ConnectRequest, outcome: ConnectOutcome, o: ConnectorCallOptions): Promise<void> {
    try {
      const remote = parseBridgeRemote(outcome.remote);
      const relayId = remote?.relayConnectionId ?? outcome.remoteId;
      if (typeof relayId !== 'string' || relayId === '') return;
      await this.bestEffortRevoke(relayId, o.signal);
      this.forget(relayId);
    } catch {
      // never throws
    }
  }

  // ---- verify ----------------------------------------------------------------------------------

  async verify(h: ConnectionHandle, o: ConnectorCallOptions): Promise<VerifyOutcome> {
    const remote = this.ensureCallable(h);
    let list: Awaited<ReturnType<RelayClient['listConnections']>>;
    try {
      list = await this.deps.relay.listConnections({ signal: o.signal });
    } catch (e) {
      throw toConnectorError(e, 'verify');
    }
    const summary = list.connections.find((c) => c.id === remote.relayConnectionId);
    if (!summary) {
      await this.reportGone(h.connectionId, 'relay_not_found');
      throw new ConnectorError('not_found', 'Bridge connection not found on the relay', { code: 'relay_not_found' });
    }
    if (summary.state === 'revoked') {
      await this.reportGone(h.connectionId, 'relay_revoked');
      throw new ConnectorError('revoked', 'Bridge connection revoked on the relay', { code: 'relay_revoked' });
    }
    let pairedClient: PairedClient | null = remote.pairedClient;
    let remotePatch: Record<string, unknown> | undefined;
    const pc = sanitizePairedClient(summary.pairedClient);
    if (pc.ok) {
      if (!samePairedClient(pc.value, remote.pairedClient)) {
        pairedClient = pc.value;
        remotePatch = { pairedClient: pc.value };
      }
    } else {
      this.deps.logger.debug('[bridge] pairedClient dropped (invalid redirect host)', { relay: remote.relayConnectionId.slice(0, 10) });
    }
    const merged: ConnectionHandle = { ...h, remote: { ...h.remote, pairedClient } };
    const facts = this.describeFacts(merged);
    const needsProbe = h.state !== 'verified'
      && (remote.transport === 'relay-http' || pairedClient !== null);
    return {
      facts,
      ...(remotePatch ? { remotePatch } : {}),
      ...(needsProbe ? { probe: { body: BRIDGE_PROBE_TEXT } } : {}),
    };
  }

  private async reportGone(connectionId: string, reason: BridgeGoneReason): Promise<void> {
    try {
      await this.deps.reportConnectionGone(connectionId, reason);
    } catch (e) {
      this.deps.logger.warn('[bridge] reportConnectionGone failed', { connectionId, reason, error: errName(e) });
    }
  }

  // ---- pull / acknowledge -----------------------------------------------------------------------

  async pull(h: ConnectionHandle, cursor: string | null, o: ConnectorCallOptions): Promise<InboundBatch> {
    const remote = this.ensureCallable(h);
    const relayId = remote.relayConnectionId;
    return this.withLock(relayId, o.signal, async () => {
      const parsed = parseBridgeCursor(cursor);
      if (parsed.malformed && !this.malformedCursorWarned.has(h.connectionId)) {
        this.malformedCursorWarned.add(h.connectionId);
        this.deps.logger.warn('[bridge] malformed cursor; re-draining from the start', { connectionId: h.connectionId });
      }
      const stored = parsed.cursor;
      const override = this.afterOverride.get(relayId);
      this.afterOverride.delete(relayId);
      const after = override && override.epoch === stored.epoch ? Math.min(override.after, stored.seq) : stored.seq;
      let page;
      try {
        page = await this.deps.relay.pullInbound(
          relayId,
          { epoch: stored.epoch, after, limit: MAX_INBOUND_PAGE },
          { signal: o.signal },
        );
      } catch (e) {
        if (override) this.afterOverride.set(relayId, override);
        throw toConnectorError(e, 'pull');
      }
      const out = mapInboundPage({ page, requested: { epoch: stored.epoch, seq: after }, remote, nowMs: this.now() });
      if (out.skipped > 0) this.deps.logger.debug('[bridge] skipped inbound items', { connectionId: h.connectionId, count: out.skipped });
      if (page.epoch !== stored.epoch && stored.epoch !== 0) {
        this.deps.logger.info('[bridge] epoch changed', { connectionId: h.connectionId });
      }
      if (out.refreshPairedClient) {
        try {
          const list = await this.deps.relay.listConnections({ signal: o.signal });
          const summary = list.connections.find((c) => c.id === relayId);
          const pc = sanitizePairedClient(summary?.pairedClient);
          if (summary && pc.ok && !samePairedClient(pc.value, remote.pairedClient)) {
            out.batch.remotePatch = { ...(out.batch.remotePatch ?? {}), pairedClient: pc.value };
          } else if (summary && !pc.ok) {
            this.deps.logger.debug('[bridge] pairedClient dropped (invalid redirect host)', { connectionId: h.connectionId });
          }
        } catch (e) {
          this.deps.logger.debug('[bridge] pairedClient refresh failed', {
            connectionId: h.connectionId, kind: isRelayHttpError(e) ? e.kind : 'unknown',
          });
        }
      }
      return out.batch;
    });
  }

  async acknowledge(h: ConnectionHandle, ackToken: string, o: ConnectorCallOptions): Promise<void> {
    let relayId: string | null = null;
    let t: { epoch: number; upTo: number } | null = null;
    try {
      t = parseAckToken(ackToken);
      if (t === null) return;
      if (!isConnectorCallable(this.availability(h))) return;
      const remote = parseBridgeRemote(h.remote);
      if (remote === null) return;
      relayId = remote.relayConnectionId;
      const last = this.lastAcked.get(relayId);
      if (last && last.epoch === t.epoch && last.upTo >= t.upTo) return;
      await this.deps.relay.ack(relayId, { epoch: t.epoch, upTo: t.upTo }, { signal: o.signal });
      this.lastAcked.set(relayId, { epoch: t.epoch, upTo: t.upTo });
    } catch (e) {
      if (relayId === null || t === null) return;
      if (isRelayHttpError(e) && e.kind === 'stale_epoch') {
        this.lastAcked.delete(relayId);
        this.deps.logger.info('[bridge] ack stale_epoch; next pull re-drains', { connectionId: h.connectionId });
        return;
      }
      if (isRelayHttpError(e) && e.kind === 'ack_beyond_served') {
        this.afterOverride.set(relayId, { epoch: t.epoch, after: e.details.maxServed ?? 0 });
        this.lastAcked.delete(relayId);
        this.deps.logger.warn('[bridge] ack beyond served; re-reading from the served mark', { connectionId: h.connectionId });
        const nowMs = this.now();
        if (nowMs - this.lastBeyondServedCapture >= CAPTURE_THROTTLE_MS) {
          this.lastBeyondServedCapture = nowMs;
          try {
            this.deps.captureSeamError('relay-drain', e, {
              connectorId: 'bridge', relayKind: e.kind, relayCode: e.code.slice(0, 64), httpStatus: String(e.status),
            });
          } catch {
            // never throws
          }
        }
        return;
      }
      this.deps.logger.debug('[bridge] ack failed; next pull re-acks', {
        connectionId: h.connectionId, kind: isRelayHttpError(e) ? e.kind : 'unknown',
      });
    }
  }

  // ---- send / reconcile -------------------------------------------------------------------------

  private validateOutbound(msg: Pick<OutboundMessage, 'id' | 'kind' | 'body' | 'links'>): void {
    if (typeof msg.id !== 'string' || !BRIDGE_ENVELOPE_ID_RE.test(msg.id) || msg.id.startsWith('rcpt:') || msg.id.startsWith('sys:')) {
      throw new ConnectorError('invalid', 'Bridge message id is not allowed', { code: 'invalid_message_id' });
    }
    if (msg.kind !== 'text' && msg.kind !== 'brief') {
      throw new ConnectorError('invalid', 'Bridge message kind is not supported', { code: 'unsupported_kind' });
    }
    const links = Array.isArray(msg.links) ? msg.links : [];
    if (links.length > BRIDGE_MAX_LINKS
      || !links.every((l) => typeof l === 'string' && l.length <= BRIDGE_MAX_LINK_CHARS && BRIDGE_LINK_RE.test(l))) {
      throw new ConnectorError('invalid', 'Bridge message links are not allowed', { code: 'invalid_links' });
    }
    const bytes = utf8Bytes(typeof msg.body === 'string' ? msg.body : '') + links.reduce((n, l) => n + utf8Bytes(l), 0);
    if (bytes > MAX_MESSAGE_BYTES) {
      throw new ConnectorError('invalid', 'Bridge message is too large', { code: 'message_too_large' });
    }
  }

  private async post(
    remote: BridgeRemoteV1,
    msg: Pick<OutboundMessage, 'id' | 'kind' | 'body' | 'links'>,
    op: 'send' | 'reconcile',
    signal: AbortSignal,
  ): Promise<SendReceipt> {
    this.validateOutbound(msg);
    try {
      const res = await this.deps.relay.postOutbound(
        remote.relayConnectionId,
        { envelope: { id: msg.id, kind: msg.kind, body: msg.body, links: msg.links } },
        { signal },
      );
      return {
        state: 'on_bridge',
        acceptedAt: new Date(this.now()).toISOString(),
        remoteEventId: msg.id,
        remoteOutSeq: res.relaySeq,
        duplicate: res.duplicate,
      };
    } catch (e) {
      throw toConnectorError(e, op);
    }
  }

  async send(h: ConnectionHandle, msg: OutboundMessage, o: ConnectorCallOptions): Promise<SendReceipt> {
    const remote = this.ensureCallable(h);
    return this.post(remote, msg, 'send', o.signal);
  }

  async reconcile(
    h: ConnectionHandle,
    items: ReconcileItem[],
    _sinceIso: string,
    o: ConnectorCallOptions,
  ): Promise<ReconcileResult[]> {
    const remote = this.ensureCallable(h);
    const results: ReconcileResult[] = [];
    for (const item of items) {
      try {
        const receipt = await this.post(
          remote,
          { id: item.messageId, kind: item.kind, body: item.body, links: item.links },
          'reconcile',
          o.signal,
        );
        results.push({ messageId: item.messageId, outcome: 'found', receipt });
      } catch (e) {
        if (e instanceof ConnectorError && e.kind === 'invalid') {
          results.push({ messageId: item.messageId, outcome: 'not_found' });
          continue;
        }
        throw e;
      }
    }
    return results;
  }

  // ---- disconnect / repair ----------------------------------------------------------------------

  async disconnect(h: ConnectionHandle, o: ConnectorCallOptions): Promise<void> {
    const remote = this.ensureCallable(h);
    const relayId = remote.relayConnectionId;
    const revokePending = (retryAfterMs: number): ConnectorError =>
      new ConnectorError('retryable', 'Revoke pending', { code: 'revoke_pending', retryAfterMs });
    return this.withLock(relayId, o.signal, async () => {
      let lastPendingMs: number | null = null;
      for (let attempt = 1; attempt <= REVOKE_INLINE_ATTEMPTS; attempt += 1) {
        if (o.signal.aborted) throw lastPendingMs !== null ? revokePending(lastPendingMs) : timeoutError();
        try {
          await this.deps.relay.revoke(relayId, { signal: o.signal });
          this.forget(relayId);
          return;
        } catch (e) {
          if (isRelayHttpError(e) && e.kind === 'not_found') {
            this.deps.logger.info('[bridge] revoke: connection already gone', { connectionId: h.connectionId });
            this.forget(relayId);
            return;
          }
          if (isRelayHttpError(e) && e.kind === 'revoke_pending') {
            const ms = e.retryAfterMs ?? REVOKE_DEFAULT_RETRY_MS;
            lastPendingMs = ms;
            if (attempt >= REVOKE_INLINE_ATTEMPTS || o.signal.aborted) throw revokePending(ms);
            try {
              await sleep(ms, AbortSignal.any([o.signal, this.deps.runtime.signal]));
            } catch {
              throw revokePending(ms);
            }
            continue;
          }
          if (lastPendingMs !== null && o.signal.aborted) throw revokePending(lastPendingMs);
          throw toConnectorError(e, 'revoke');
        }
      }
      throw revokePending(lastPendingMs ?? REVOKE_DEFAULT_RETRY_MS);
    });
  }

  async repairPairing(h: ConnectionHandle, o: ConnectorCallOptions): Promise<RepairOutcome> {
    const remote = this.ensureCallable(h);
    const relayId = remote.relayConnectionId;
    return this.withLock(relayId, o.signal, async () => {
      let res;
      try {
        res = await this.deps.relay.repair(relayId, { signal: o.signal });
      } catch (e) {
        throw toConnectorError(e, 'repair');
      }
      if (remote.transport === 'relay-http' && (typeof res.token !== 'string' || res.token === '')) {
        this.deps.captureSeamError('connector-verify', new Error('Bridge relay-http repair returned no token'), {
          connectorId: 'bridge', relayCode: 'missing_token',
        });
        throw new ConnectorError('permanent', 'Bridge repair failed (missing_token)', { code: 'missing_token' });
      }
      this.lastAcked.delete(relayId);
      this.afterOverride.delete(relayId);
      const issuedAt = this.now();
      const pairing = this.pairingPayload(h.connectionId, remote, issuedAt, res.pairingCode, res.token ?? null, h.agentHandle);
      return {
        pairing,
        remotePatch: {
          pairedClient: null,
          pairCalledAt: null,
          firstPickupAt: null,
          pairingIssuedAt: new Date(issuedAt).toISOString(),
        },
        relayEpoch: res.epoch,
        inboundCursor: encodeBridgeCursor({ epoch: res.epoch, seq: 0 }),
      };
    });
  }

  // ---- periodic refresh --------------------------------------------------------------------------

  /** Relay-side revokes and pairedClient changes for this account's connections. Never throws. */
  async refreshConnections(handles: ConnectionHandle[], signal?: AbortSignal): Promise<void> {
    try {
      const state = this.deps.runtime.status().state;
      if (state !== 'ready') return;
      const dev = this.deps.cloud.getDevice();
      const mine = handles
        .map((h) => ({ h, remote: parseBridgeRemote(h.remote) }))
        .filter((x): x is { h: ConnectionHandle; remote: BridgeRemoteV1 } =>
          x.remote !== null && bridgeRemoteMatchesAccount(x.remote, dev));
      if (mine.length === 0) return;
      const list = await this.deps.relay.listConnections(signal ? { signal } : undefined);
      for (const { h, remote } of mine) {
        const summary = list.connections.find((c) => c.id === remote.relayConnectionId);
        if (!summary) {
          await this.reportGone(h.connectionId, 'relay_not_found');
          continue;
        }
        if (summary.state === 'revoked') {
          await this.reportGone(h.connectionId, 'relay_revoked');
          continue;
        }
        const pc = sanitizePairedClient(summary.pairedClient);
        if (pc.ok && !samePairedClient(pc.value, remote.pairedClient)) {
          try {
            await this.deps.reportRemotePatch(h.connectionId, { pairedClient: pc.value });
          } catch (e) {
            this.deps.logger.warn('[bridge] reportRemotePatch failed', { connectionId: h.connectionId, error: errName(e) });
          }
        }
      }
    } catch (e) {
      this.deps.logger.debug('[bridge] connections refresh failed', {
        kind: e instanceof RelayHttpError ? e.kind : 'unknown',
      });
    }
  }

  // ---- lifecycle ----------------------------------------------------------------------------------

  private forget(relayId: string): void {
    this.lastAcked.delete(relayId);
    this.afterOverride.delete(relayId);
  }

  /** In-memory per-connection state (none of it is needed for correctness after a restart). */
  clearMemory(): void {
    this.lastAcked.clear();
    this.afterOverride.clear();
    this.malformedCursorWarned.clear();
    this.invalidRemoteCaptured.clear();
  }

  dispose(): void {
    this.deps.onDispose?.();
  }
}

function errName(e: unknown): string {
  return e instanceof Error ? e.name : 'unknown';
}
