/**
 * ConnectionService — connect / verify / switch (the resumable swap) / cancel / disconnect / archive /
 * control / repair, remote-revoke retries and boot recovery for persistent-agent connections.
 *
 * The swap lives on the NEW connection `n` (swap_state) and never loses or strands a message:
 *   connecting → awaiting_verify → (n verified) fencing → reconciling → revoking_remote → activating → done.
 * Every step is a compare-and-set in the store; when one returns false the swap was cancelled,
 * disconnected or failed underneath this chain, and nothing further is written. A Bridge connection being
 * retired is drained one last time before its remote revoke (the relay deletes the mailbox on revoke), and
 * a revoke that keeps failing never blocks activation: it is retried durably (runRevokeRetries).
 *
 * Pairing payloads are cached in memory only, always without the one-time token / brief.
 */
import type { LoggerLike } from '../../orchestrator/types';
import type { PersistentAgentStore } from '../../orchestrator/persistentAgents/persistentAgentStore';
import { parseCapabilities, parseLinks, parseVerifyFacts, type ConnectionRow, type NewConnectionRow } from '../../orchestrator/persistentAgents/rows';
import {
  PERSISTENT_AGENT_MAX_DISPLAY_NAME,
  PERSISTENT_AGENT_PAIRING_TTL_MS,
  REVOKE_SURFACE_AFTER,
  isConnectorCallable,
  type ConnectInput,
  type ConnectResultData,
  type ConnectionInput,
  type ControlVerb,
  type NewAgentInput,
  type PairingPayload,
  type SwitchConnectionInput,
  type VerifyView,
} from '../../../../shared/types/persistentAgents';
import type { DisconnectOutcome } from '../../orchestrator/persistentAgentsBridge';
import type { AgentConnector, ConnectRequest, ConnectRequestInput, ConnectionHandle, ReconcileItem } from './connectorContract';
import { ConnectorError, asConnectorError } from './connectorErrors';
import type { ConnectorRegistry } from './connectorRegistry';
import type { CredentialService } from './credentialService';
import {
  AgentNotFoundError,
  AgentNotSendableError,
  ConnectionNotFoundError,
  ConnectorNotRegisteredError,
  ConnectorUnavailableError,
  ControlNotSupportedError,
  CredentialNotFoundError,
  InvalidAgentInputError,
  NoSwapInProgressError,
  PairingNotSupportedError,
  SwapInProgressError,
} from './errors';
import type { InboundPump } from './inboundPump';
import type { OutboxWorker } from './outbox';
import { outboxBackoffMs } from './outbox';
import { budgetKeyFor, type TokenBuckets } from './tokenBucket';

export const SWAP_INFLIGHT_WAIT_MS = 60_000;
export const SWAP_RECONCILE_ROUNDS = 3;
export const SWAP_RECONCILE_GAP_MS = 5_000;
export const REVOKE_BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000] as const;
export const REVOKE_MAX_ATTEMPTS = 20;
export { REVOKE_SURFACE_AFTER };
export const DRAIN_BUDGET_MS = 20_000;
export const CONNECT_TIMEOUT_MS = 15_000;
export const CALL_TIMEOUT_MS = 15_000;
export const SWAP_REVOKE_TIMEOUT_MS = 10_000;
export const REVOKE_TIMEOUT_MS = 15_000;
/** A revoke refused without network (gate closed, account mismatch): retried later, attempt not counted. */
export const REVOKE_PAUSED_RETRY_MS = 10 * 60_000;
export const REVOKE_MISSING_CONNECTOR_RETRY_MS = 6 * 3_600_000;
const NOT_COUNTED_KINDS = new Set(['paused', 'device_auth', 'not_entitled', 'upgrade_required']);

export interface ConnectionServiceDeps {
  store: PersistentAgentStore;
  registry: ConnectorRegistry;
  credentials: Pick<CredentialService, 'add' | 'version'>;
  buildHandle(connectionId: string): ConnectionHandle | null;
  budget: TokenBuckets;
  pump: Pick<InboundPump, 'kick' | 'noteActive' | 'drainNow'>;
  outbox: Pick<OutboxWorker, 'kick'>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  logger: LoggerLike;
  captureSeamError: (seam: string, err: unknown, tags?: Record<string, string>) => void;
}

/** Unfinished work found at boot (see captureBootState). */
export interface BootSnapshot { creating: string[]; swaps: Array<{ id: string; swapState: string | null }> }

type RevokeAttempt = { ok: true } | { ok: false; error: ConnectorError; missingConnector?: boolean };

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export class ConnectionService {
  private readonly pairings = new Map<string, { payload: PairingPayload; expiresAtMs: number }>();
  private readonly chains = new Map<string, Promise<void>>();
  private revokeRetriesRunning = false;

  constructor(private readonly deps: ConnectionServiceDeps) {}

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private nowMs(): number {
    return this.deps.now().getTime();
  }

  private isoIn(ms: number): string {
    return new Date(this.nowMs() + ms).toISOString();
  }

  private connectorFor(connectorId: string): AgentConnector {
    if (!this.deps.registry.getDefinition(connectorId)) throw new ConnectorNotRegisteredError(connectorId);
    const c = this.deps.registry.get(connectorId);
    if (!c) throw new ConnectorNotRegisteredError(connectorId);
    return c;
  }

  private requireHandle(connectionId: string): ConnectionHandle {
    const h = this.deps.buildHandle(connectionId);
    if (!h) throw new ConnectionNotFoundError(connectionId);
    return h;
  }

  private async takeToken(connector: AgentConnector, h: ConnectionHandle): Promise<void> {
    const key = budgetKeyFor(this.deps.budget, connector, h);
    if (!(await this.deps.budget.take(key, 5_000))) {
      throw new ConnectorError('rate_limited', 'Too many requests right now. Try again shortly.', { retryAfterMs: 5_000 });
    }
  }

  private rememberPairing(connectionId: string, payload: PairingPayload | null): void {
    if (!payload) return;
    const parsed = payload.pairingExpiresAt ? Date.parse(payload.pairingExpiresAt) : NaN;
    const expiresAtMs = Number.isNaN(parsed) ? this.nowMs() + PERSISTENT_AGENT_PAIRING_TTL_MS : parsed;
    this.pairings.set(connectionId, { payload: { ...payload, oneTimeToken: null, instructionBrief: null }, expiresAtMs });
  }

  private forgetPairing(connectionId: string | null | undefined): void {
    if (connectionId) this.pairings.delete(connectionId);
  }

  private displayNameOf(connectorId: string): string {
    return this.deps.registry.getDefinition(connectorId)?.displayName ?? connectorId;
  }

  /** Validation shared by connect and switchConnection; resolves (or creates) the credential. */
  private async prepareConnection(
    agent: { displayName: string; vendor: NewAgentInput['vendor'] },
    input: ConnectionInput,
  ): Promise<{ connector: AgentConnector; row: NewConnectionRow; requestInput: ConnectRequestInput; credential: { id: string; version: number } | null }> {
    const def = this.deps.registry.getDefinition(input.connectorId);
    if (!def) throw new ConnectorNotRegisteredError(input.connectorId);
    const connector = this.connectorFor(input.connectorId);
    const a = connector.availability();
    if (!isConnectorCallable(a)) throw new ConnectorUnavailableError(a);
    if (!def.vendors.includes(agent.vendor)) throw new InvalidAgentInputError("This connector doesn't support that kind of agent.");
    if (input.kind !== def.kind) throw new InvalidAgentInputError("This connector doesn't support that kind of connection.");
    if (input.kind === 'bridge') {
      if (!def.transports.includes(input.transport)) throw new InvalidAgentInputError("This connector doesn't support that transport.");
      const label = (input.label ?? agent.displayName).trim().slice(0, 100);
      if (label === '' || CONTROL_RE.test(label)) throw new InvalidAgentInputError('Give the connection a name.', { field: 'label' });
      return {
        connector,
        row: { kind: 'bridge', connectorId: def.id, connectorVersion: def.version, transport: input.transport, credentialId: null, descriptor: def.capabilities },
        requestInput: { kind: 'bridge', connectorId: 'bridge', transport: input.transport, label },
        credential: null,
      };
    }
    let credentialId: string;
    if (input.credential.mode === 'existing') {
      const row = this.deps.store.getCredentialRow(input.credential.credentialId);
      if (!row) throw new CredentialNotFoundError(input.credential.credentialId);
      if (row.vendor !== def.credentialVendor) throw new InvalidAgentInputError("That key doesn't work with this connector.");
      if (row.state === 'undecryptable') throw new InvalidAgentInputError("That key can't be read on this computer. Re-enter it first.");
      credentialId = row.id;
    } else {
      if (def.credentialVendor === null) throw new InvalidAgentInputError("This connector doesn't take a key.");
      const view = await this.deps.credentials.add({ vendor: def.credentialVendor, label: input.credential.label, secret: input.credential.secret });
      credentialId = view.id;
    }
    const version = this.deps.credentials.version(credentialId) ?? 1;
    return {
      connector,
      row: { kind: 'native', connectorId: def.id, connectorVersion: def.version, transport: def.transports[0] ?? null, credentialId, descriptor: def.capabilities },
      requestInput: { kind: 'native', connectorId: def.id, remote: input.remote },
      credential: { id: credentialId, version },
    };
  }

  /** Remote connect + txn B, with rollback of the remote object and txn C when either fails. */
  private async connectRemote(connector: AgentConnector, req: ConnectRequest): Promise<PairingPayload | null> {
    let outcome;
    try {
      outcome = await connector.connect(req, { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
    } catch (err) {
      await this.deps.store.abortConnectionCreate(req.connectionId, 'Could not create the connection').catch(() => undefined);
      throw asConnectorError(err);
    }
    try {
      await this.deps.store.completeConnectionCreate(req.connectionId, outcome);
    } catch (err) {
      try {
        await connector.rollbackConnect?.(req, outcome, { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
      } catch {
        // best-effort; the remote object expires unpaired
      }
      await this.deps.store.abortConnectionCreate(req.connectionId, 'Could not save the connection').catch(() => undefined);
      throw err;
    }
    this.rememberPairing(req.connectionId, outcome.pairing);
    this.deps.pump.noteActive(req.connectionId);
    this.deps.pump.kick(req.connectionId);
    return outcome.pairing;
  }

  // -------------------------------------------------------------------------
  // Connect / verify
  // -------------------------------------------------------------------------

  async connect(input: ConnectInput): Promise<ConnectResultData> {
    const displayName = input.agent.displayName.trim();
    if (displayName.length < 1 || displayName.length > PERSISTENT_AGENT_MAX_DISPLAY_NAME || CONTROL_RE.test(displayName)) {
      throw new InvalidAgentInputError('Keep the name under 80 characters.', { field: 'displayName' });
    }
    const prep = await this.prepareConnection({ displayName, vendor: input.agent.vendor }, input.connection);
    const created = await this.deps.store.createAgent({ agent: { ...input.agent, displayName }, connection: prep.row });
    const req: ConnectRequest = {
      connectionId: created.connectionId,
      agent: { id: created.agentId, handle: created.handle, displayName, vendor: input.agent.vendor },
      input: prep.requestInput,
      credential: prep.credential,
    };
    const pairing = await this.connectRemote(prep.connector, req);
    this.deps.logger.info('[persistent-agents] connected', { agentId: created.agentId, connectionId: created.connectionId });
    return { agentId: created.agentId, connectionId: created.connectionId, pairing };
  }

  async verify(connectionId: string): Promise<VerifyView> {
    const row = this.deps.store.getConnectionRow(connectionId);
    if (!row) throw new ConnectionNotFoundError(connectionId);
    if (row.state === 'revoked') throw new AgentNotSendableError('revoked');
    const connector = this.connectorFor(row.connector_id);
    const h = this.requireHandle(connectionId);
    const a = connector.availability(h);
    if (!isConnectorCallable(a)) throw new ConnectorUnavailableError(a);
    await this.takeToken(connector, h);
    let outcome;
    try {
      outcome = await connector.verify(h, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    } catch (err) {
      const e = asConnectorError(err);
      if (e.kind === 'auth') await this.onAuthFailure(connectionId, e);
      if (!(err instanceof ConnectorError) || e.kind === 'permanent') {
        this.deps.captureSeamError('connector-verify', err instanceof ConnectorError ? e : err, {
          connectorId: h.connectorId, connectorVersion: String(h.connectorVersion), errorKind: e.kind,
        });
      }
      throw e;
    }
    const { probeQueued } = await this.deps.store.applyVerifyOutcome(connectionId, outcome);
    this.deps.pump.kick(connectionId);
    if (probeQueued) this.deps.outbox.kick(row.agent_id);
    const after = this.deps.store.getConnectionRow(connectionId) ?? row;
    const h2 = this.deps.buildHandle(connectionId);
    let facts = parseVerifyFacts(after.verify_json);
    if (connector.describeFacts && h2) {
      try {
        facts = connector.describeFacts(h2);
      } catch {
        // keep the stored facts
      }
    }
    return {
      connectionId,
      state: h2?.state ?? 'pending',
      facts,
      probeQueued: probeQueued || this.deps.store.hasQueuedProbe(connectionId),
    };
  }

  // -------------------------------------------------------------------------
  // Swap
  // -------------------------------------------------------------------------

  async switchConnection(input: SwitchConnectionInput): Promise<ConnectResultData> {
    const agent = this.deps.store.getAgentRow(input.agentId);
    if (!agent) throw new AgentNotFoundError(input.agentId);
    if (agent.archived_at !== null) throw new AgentNotSendableError('archived');
    if (!this.deps.store.getCurrentConnection(input.agentId)) throw new AgentNotSendableError('no_connection');
    if (this.deps.store.getSwapTarget(input.agentId)) throw new SwapInProgressError(input.agentId);
    const vendor = agent.vendor as NewAgentInput['vendor'];
    const prep = await this.prepareConnection({ displayName: agent.display_name, vendor }, input.connection);
    const { connectionId } = await this.deps.store.createPendingConnection(input.agentId, prep.row);
    const req: ConnectRequest = {
      connectionId,
      agent: { id: agent.id, handle: agent.handle, displayName: agent.display_name, vendor },
      input: prep.requestInput,
      credential: prep.credential,
    };
    const pairing = await this.connectRemote(prep.connector, req);
    this.deps.logger.info('[persistent-agents] switch started', { agentId: agent.id, connectionId });
    return { agentId: agent.id, connectionId, pairing };
  }

  async cancelSwitch(agentId: string): Promise<void> {
    const n = this.deps.store.getSwapTarget(agentId);
    if (!n) throw new NoSwapInProgressError(agentId);
    const ok = await this.deps.store.failSwap(n.id, 'Switch cancelled', {
      revokeNew: true, fromStates: ['connecting', 'awaiting_verify'],
    });
    if (!ok) throw new NoSwapInProgressError(agentId, 'The switch is already finishing.');
    this.forgetPairing(n.id);
  }

  /** Advances an awaiting_verify swap once its new connection verified (pump → becameVerified). */
  async onConnectionVerified(connectionId: string): Promise<void> {
    const n = this.deps.store.getConnectionRow(connectionId);
    if (!n || n.swap_state !== 'awaiting_verify') return;
    if (!(await this.deps.store.markSwapState(connectionId, 'awaiting_verify', 'fencing'))) return;
    await this.continueSwap(connectionId);
  }

  /** Run the rest of a swap from its persisted state. One chain per swap target at a time. */
  private continueSwap(n: string): Promise<void> {
    const existing = this.chains.get(n);
    if (existing) return existing;
    const chain = this.runSwapChain(n)
      .catch((err: unknown) => {
        this.deps.logger.warn('[persistent-agents] swap step failed; it resumes at the next boot', {
          connectionId: n, error: err instanceof Error ? err.name : 'unknown',
        });
      })
      .finally(() => this.chains.delete(n));
    this.chains.set(n, chain);
    return chain;
  }

  private async runSwapChain(n: string): Promise<void> {
    const { store } = this.deps;
    const row = store.getConnectionRow(n);
    if (!row || row.swap_state === null) return;
    const o = row.swap_from_connection_id;
    let state = row.swap_state;

    if (state === 'fencing') {
      if (!(await store.fenceSwap(n))) return;
      state = 'reconciling';
    }
    if (state === 'reconciling') {
      if (o !== null) await this.reconcileOld(o);
      if (!(await store.markSwapState(n, 'reconciling', 'revoking_remote'))) return;
      state = 'revoking_remote';
    }
    if (state === 'revoking_remote') {
      const orow = o !== null ? store.getConnectionRow(o) : null;
      if (orow && orow.remote_revoke_state === null) {
        await store.beginRemoteRevoke(orow.id, new Date(this.nowMs()).toISOString());
        const r = await this.revokeRemoteOnce(orow.id, SWAP_REVOKE_TIMEOUT_MS);
        await this.recordRevoke(orow.id, r);
      }
      if (!(await store.markSwapState(n, 'revoking_remote', 'activating'))) return;
      state = 'activating';
    }
    if (state === 'activating') {
      const current = store.getConnectionRow(n);
      const from = o !== null ? store.getConnectionRow(o) : null;
      const names = {
        to: this.displayNameOf(current?.connector_id ?? ''),
        from: from ? this.displayNameOf(from.connector_id) : 'the previous connection',
      };
      if (!(await store.activateSwap(n, names))) return;
      this.forgetPairing(o);
      this.deps.pump.kick(n);
      if (current) this.deps.outbox.kick(current.agent_id);
      this.deps.logger.info('[persistent-agents] switch completed', { agentId: current?.agent_id, connectionId: n });
    }
  }

  /** Swap step 4: let in-flight sends on o settle, demote the rest to ambiguous, reconcile them. */
  private async reconcileOld(o: string): Promise<void> {
    const { store } = this.deps;
    // Bounded by iterations (not the clock) so a stalled clock can never spin this forever.
    for (let i = 0; i < SWAP_INFLIGHT_WAIT_MS / 1_000 && store.countInFlight(o) > 0; i++) await this.deps.sleep(1_000);
    await store.demoteInFlightToAmbiguous(o);
    for (let round = 0; round < SWAP_RECONCILE_ROUNDS; round++) {
      const rows = store.listAmbiguous(o, null, 20);
      if (rows.length === 0) return;
      const h = this.deps.buildHandle(o);
      const connector = h ? this.deps.registry.get(h.connectorId) : undefined;
      if (!h || !connector || !isConnectorCallable(connector.availability(h))) return;
      const items: ReconcileItem[] = rows.map((r) => ({
        messageId: r.id, contentHash: r.content_hash ?? '', createdAt: r.created_at, body: r.body,
        links: parseLinks(r.links_json),
        kind: r.kind === 'brief' ? 'brief' : 'text',
      }));
      try {
        const results = await connector.reconcile(h, items, items[0].createdAt, { signal: AbortSignal.timeout(30_000) });
        await store.applyReconcile(o, results, (n) => this.isoIn(outboxBackoffMs(n)));
      } catch (err) {
        this.deps.logger.warn('[persistent-agents] swap reconcile round failed', {
          connectionId: o, error: err instanceof ConnectorError ? err.kind : 'unexpected',
        });
      }
      if (round < SWAP_RECONCILE_ROUNDS - 1 && store.listAmbiguous(o, null, 1).length > 0) {
        await this.deps.sleep(SWAP_RECONCILE_GAP_MS);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Remote revoke
  // -------------------------------------------------------------------------

  /**
   * One remote revoke attempt. A Bridge connection is drained first (bounded): replies, delivery
   * reports and pickup receipts that reached its mailbox after the last poll are stored before the relay
   * deletes the mailbox. The drain result never blocks the revoke.
   */
  private async revokeRemoteOnce(connectionId: string, timeoutMs: number): Promise<RevokeAttempt> {
    const h = this.deps.buildHandle(connectionId);
    const connector = h ? this.deps.registry.get(h.connectorId) : undefined;
    if (!h || !connector) {
      return { ok: false, error: new ConnectorError('paused', 'Connector disabled', { code: 'disabled' }), missingConnector: true };
    }
    if (h.kind === 'bridge') {
      const deadline = AbortSignal.timeout(timeoutMs + DRAIN_BUDGET_MS);
      const drain = await this.deps.pump.drainNow(connectionId, { maxPages: 50, signal: deadline });
      if (!drain.complete) this.deps.logger.info('[persistent-agents] final drain incomplete before revoke', { connectionId, pages: drain.pages });
    }
    const fresh = this.deps.buildHandle(connectionId) ?? h;
    const a = connector.availability(fresh);
    if (!isConnectorCallable(a)) {
      return { ok: false, error: new ConnectorError('paused', a.message ?? 'Paused', { code: a.state }) };
    }
    const key = budgetKeyFor(this.deps.budget, connector, fresh);
    if (!(await this.deps.budget.take(key, 5_000))) {
      return { ok: false, error: new ConnectorError('rate_limited', 'Too many requests', { retryAfterMs: 60_000 }) };
    }
    try {
      await connector.disconnect(fresh, { signal: AbortSignal.timeout(timeoutMs) });
      return { ok: true };
    } catch (err) {
      const e = asConnectorError(err);
      if (e.kind === 'not_found') return { ok: true };
      return { ok: false, error: e };
    }
  }

  private async recordRevoke(connectionId: string, r: RevokeAttempt): Promise<void> {
    const { store } = this.deps;
    if (r.ok) {
      await store.recordRemoteRevoke(connectionId, { ok: true });
      return;
    }
    if (r.missingConnector) {
      await store.recordRemoteRevoke(connectionId, {
        ok: false, error: 'Connector disabled', nextAt: this.isoIn(REVOKE_MISSING_CONNECTOR_RETRY_MS), countAttempt: false,
      });
      return;
    }
    if (NOT_COUNTED_KINDS.has(r.error.kind)) {
      await store.recordRemoteRevoke(connectionId, {
        ok: false, error: r.error.message, nextAt: this.isoIn(REVOKE_PAUSED_RETRY_MS), countAttempt: false,
      });
      return;
    }
    const attempts = store.getConnectionRow(connectionId)?.remote_revoke_attempts ?? 0;
    const nextAt = attempts + 1 >= REVOKE_MAX_ATTEMPTS
      ? null
      : this.isoIn(Math.max(REVOKE_BACKOFF_MS[Math.min(attempts, REVOKE_BACKOFF_MS.length - 1)], r.error.retryAfterMs ?? 0));
    await store.recordRemoteRevoke(connectionId, { ok: false, error: r.error.message, nextAt });
  }

  /** Durable remote-revoke retries (the pump calls this every 30 s). */
  async runRevokeRetries(): Promise<void> {
    if (this.revokeRetriesRunning) return;
    this.revokeRetriesRunning = true;
    try {
      for (const row of this.deps.store.listRevokeDue(new Date(this.nowMs()).toISOString())) {
        try {
          const r = await this.revokeRemoteOnce(row.id, REVOKE_TIMEOUT_MS);
          await this.recordRevoke(row.id, r);
        } catch (err) {
          this.deps.logger.warn('[persistent-agents] revoke retry failed', { connectionId: row.id, error: err instanceof Error ? err.name : 'unknown' });
        }
      }
    } finally {
      this.revokeRetriesRunning = false;
    }
  }

  // -------------------------------------------------------------------------
  // Disconnect / archive / control / repair
  // -------------------------------------------------------------------------

  async disconnect(agentId: string): Promise<DisconnectOutcome> {
    const res = await this.deps.store.disconnectAgent(agentId);
    const row = this.deps.store.getConnectionRow(res.connectionId);
    if (row?.remote_revoke_state === 'pending') {
      const r = await this.revokeRemoteOnce(res.connectionId, REVOKE_TIMEOUT_MS);
      await this.recordRevoke(res.connectionId, r);
    }
    this.forgetPairing(res.connectionId);
    const after = this.deps.store.getConnectionRow(res.connectionId);
    this.deps.logger.info('[persistent-agents] disconnected', { agentId, connectionId: res.connectionId });
    return {
      connectionId: res.connectionId,
      remoteRevoke: after?.remote_revoke_state === 'done' ? 'done' : 'pending',
      offerForgetCredentialId: res.lastReference ? res.credentialId : null,
    };
  }

  async archive(agentId: string): Promise<void> {
    if (!this.deps.store.getAgentRow(agentId)) throw new AgentNotFoundError(agentId);
    const cur = this.deps.store.getCurrentConnection(agentId);
    if (cur && cur.state !== 'revoked') await this.disconnect(agentId);
    await this.deps.store.archiveAgent(agentId);
  }

  /** Allowed iff the current connection's DESCRIPTOR declares the verb (not gated on observation). */
  async control(agentId: string, verb: ControlVerb): Promise<void> {
    if (!this.deps.store.getAgentRow(agentId)) throw new AgentNotFoundError(agentId);
    const cur = this.deps.store.getCurrentConnection(agentId);
    if (!cur) throw new AgentNotSendableError('no_connection');
    if (cur.state === 'revoked') throw new AgentNotSendableError('revoked');
    const connector = this.connectorFor(cur.connector_id);
    const declared = parseCapabilities(cur.capabilities_json, connector.definition.capabilities).descriptor.control;
    if (!declared.includes(verb) || !connector.control) throw new ControlNotSupportedError(verb);
    const h = this.requireHandle(cur.id);
    const a = connector.availability(h);
    if (!isConnectorCallable(a)) throw new ConnectorUnavailableError(a);
    await this.takeToken(connector, h);
    try {
      await connector.control(h, verb, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    } catch (err) {
      const e = asConnectorError(err);
      if (e.kind === 'auth') await this.onAuthFailure(cur.id, e);
      throw e;
    }
  }

  async repairPairing(connectionId: string): Promise<PairingPayload> {
    const row = this.deps.store.getConnectionRow(connectionId);
    if (!row) throw new ConnectionNotFoundError(connectionId);
    if (row.state === 'revoked') throw new AgentNotSendableError('revoked');
    const connector = this.connectorFor(row.connector_id);
    if (!connector.repairPairing) throw new PairingNotSupportedError(row.connector_id);
    const h = this.requireHandle(connectionId);
    const a = connector.availability(h);
    if (!isConnectorCallable(a)) throw new ConnectorUnavailableError(a);
    await this.takeToken(connector, h);
    let r;
    try {
      r = await connector.repairPairing(h, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    } catch (err) {
      const e = asConnectorError(err);
      if (e.kind === 'auth') await this.onAuthFailure(connectionId, e);
      throw e;
    }
    await this.deps.store.applyRepair(connectionId, r);
    this.rememberPairing(connectionId, r.pairing);
    this.deps.pump.noteActive(connectionId);
    this.deps.pump.kick(connectionId);
    return r.pairing;
  }

  /** The remembered payload (token and brief always null) while unexpired. */
  getPairing(connectionId: string): PairingPayload | null {
    const e = this.pairings.get(connectionId);
    if (!e) return null;
    if (this.nowMs() >= e.expiresAtMs) {
      this.pairings.delete(connectionId);
      return null;
    }
    return { ...e.payload, oneTimeToken: null, instructionBrief: null };
  }

  // -------------------------------------------------------------------------
  // Failure hooks
  // -------------------------------------------------------------------------

  /** A native connection's own credential was rejected. (Bridge connections never get 'auth'.) */
  async onAuthFailure(connectionId: string, err: ConnectorError): Promise<void> {
    const row = this.deps.store.getConnectionRow(connectionId);
    if (!row || row.credential_id === null) return;
    await this.deps.store.setConnectionState(connectionId, {
      state: 'auth_failed', errorKind: 'auth', lastError: err.message, authRetryAt: null, credentialStateIfAuth: 'auth_failed',
    });
  }

  /** The remote connection is gone or revoked (send/pull 404/409, doorbell 4410, directory refresh). */
  async onConnectionGone(connectionId: string, reason: ConnectorError | string): Promise<void> {
    const row = this.deps.store.getConnectionRow(connectionId);
    if (!row) return;
    const errorKind = typeof reason === 'string' ? reason : reason.kind;
    const lastError = typeof reason === 'string' ? 'The remote connection is gone.' : reason.message;
    await this.deps.store.setConnectionState(connectionId, { state: 'revoked', errorKind, lastError });
    this.forgetPairing(connectionId);
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  /**
   * Synchronous snapshot of what a previous process left unfinished. Taken at boot BEFORE this process can
   * start a connect or a switch of its own, so the (asynchronous) recovery never aborts work in progress.
   */
  captureBootState(): BootSnapshot {
    const { store } = this.deps;
    return {
      creating: store.listCreatingRemote().map((r) => r.id),
      swaps: store.listResumableSwaps().filter((r) => r.connect_state === null).map((r) => ({ id: r.id, swapState: r.swap_state })),
    };
  }

  /**
   * MUST run after store.requeueInFlightAsAmbiguous(). Aborts creates a crash interrupted and resumes
   * swaps, acting only on rows of the snapshot that are still in the snapshotted state.
   */
  async recoverOnBoot(snapshot: BootSnapshot = this.captureBootState()): Promise<void> {
    const { store } = this.deps;
    for (const id of snapshot.creating) {
      if (store.getConnectionRow(id)?.connect_state !== 'creating_remote') continue;
      await store.abortConnectionCreate(id, 'Interrupted while connecting').catch(() => undefined);
    }
    const chains: Promise<void>[] = [];
    for (const s of snapshot.swaps) {
      const n = store.getConnectionRow(s.id);
      if (!n || n.swap_state !== s.swapState) continue;
      chains.push(this.resumeSwap(n));
    }
    await Promise.all(chains);
  }

  private async resumeSwap(n: ConnectionRow): Promise<void> {
    switch (n.swap_state) {
      case 'connecting':
        // A 'connecting' row whose create finished cannot make progress (never written normally): fail it.
        await this.deps.store.failSwap(n.id, 'Interrupted while connecting', { revokeNew: true, fromStates: ['connecting'] });
        return;
      case 'awaiting_verify':
        if (n.state === 'verified') await this.onConnectionVerified(n.id);
        return;
      case 'fencing':
      case 'reconciling':
      case 'revoking_remote':
      case 'activating':
        await this.continueSwap(n.id);
        return;
      default:
        return;
    }
  }
}
