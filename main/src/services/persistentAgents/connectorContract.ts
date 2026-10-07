import type { LoggerLike } from '../../orchestrator/types';
import type { CloudAccountHandle } from '../cloud/cloudAccountHandle';
import type {
  ActivityType, ConnectionInput, ConnectionState, ConnectorAvailability, ConnectorDefinition, ConnectorKind,
  ControlVerb, MessageKind, NativeRemoteSelection, PairingPayload, PersistentAgentTransport, PersistentAgentVendor,
  RemoteStatus, UsageCoverage, VerifiedFlag, VerifyFact,
} from '../../../../shared/types/persistentAgents';

/** Shared deps handed to every connector factory. */
export interface ConnectorDeps {
  fetch: typeof fetch;
  now: () => Date;
  log: LoggerLike;
  /** Decrypts on demand; never cached in plaintext by the core. Throws CredentialUndecryptableError / SecretsUnavailableError. */
  secret(credentialId: string): Promise<string>;
}

export interface ConnectorCallOptions {
  /**
   * Always passed: AbortSignal.timeout(30_000) send/pull/reconcile; 15_000 verify/control/repair/connect/disconnect;
   * 10_000 disconnect during a swap. It bounds the WHOLE call. A connector MUST pass it to every network
   * request AND every internal wait (rate budget, retry sleep); when it aborts, the call rejects within ~0 ms
   * with ConnectorError('retryable', …, { code: 'timeout', maybeDelivered: <true iff a send/reconcile request
   * may already have reached the server> }).
   */
  signal: AbortSignal;
}

/** Everything a connector may know about one connection. Built from the row; never holds a secret. */
export interface ConnectionHandle {
  connectionId: string;
  agentId: string;
  agentHandle: string;
  agentDisplayName: string;
  vendor: PersistentAgentVendor;
  connectorId: string;
  connectorVersion: number;
  kind: ConnectorKind;
  transport: PersistentAgentTransport | null;
  state: ConnectionState;
  generation: number;
  remoteId: string | null;
  /** Parsed remote_json ({} when null). Connector validates its own shape. */
  remote: Record<string, unknown>;
  /** Client caches key on (id, version). */
  credential: { id: string; version: number } | null;
  inboundCursor: string | null;
  relayEpoch: number | null;
}

export type ConnectRequestInput =
  | Extract<ConnectionInput, { kind: 'bridge' }>
  | { kind: 'native'; connectorId: string; remote: NativeRemoteSelection };  // credential stripped

export interface ConnectRequest {
  /** The local row, already inserted (connect_state='creating_remote'). */
  connectionId: string;
  agent: { id: string; handle: string; displayName: string; vendor: PersistentAgentVendor };
  /** Never carries a secret. For the Bridge, `label` is filled by the core (default displayName.slice(0,100)). */
  input: ConnectRequestInput;
  credential: { id: string; version: number } | null;
}

export interface ConnectOutcome {
  remoteId: string;
  /** MUST be non-secret; persisted in remote_json (merged with {remoteId, transport}). */
  remote: Record<string, unknown>;
  transport: PersistentAgentTransport | null;
  inboundCursor: string | null;
  relayEpoch: number | null;
  /** With oneTimeToken/instructionBrief; the core returns it once and caches a copy with both nulled. */
  pairing: PairingPayload | null;
  facts: VerifyFact[];
}

export interface VerifyOutcome {
  facts: VerifyFact[];
  /** Shallow-merged into remote_json (null stores null). Non-secret. */
  remotePatch?: Record<string, unknown>;
  observed?: VerifiedFlag[];
  /** When set and no probe was queued on this connection in the last 10 min, the core enqueues it (is_probe=1, author 'local'). */
  probe?: { body: string };
}

export interface OutboundMessage {
  /** Local message id = the idempotency key the connector MUST reuse (Bridge: the envelope id). */
  id: string;
  kind: Extract<MessageKind, 'text' | 'brief'>;
  body: string;
  links: string[];
  contentHash: string;
  isProbe: boolean;
  createdAt: string;
}

export interface SendReceipt {
  state: 'sent' | 'on_bridge';
  acceptedAt: string;
  remoteEventId?: string;
  remoteOutSeq?: number;
  duplicate?: boolean;
}

export interface InboundMessage {
  /** Required dedupe key (unique per connection + direction). */
  remoteEventId: string;
  /** 'local' = connector-synthesised note (e.g. the gap note) → stored with direction 'local'. */
  author: 'agent' | 'relay' | 'local';
  kind: MessageKind;
  body: string;
  links: string[];
  remoteCreatedAt: string | null;
  relaySeq?: number;
  relayEpoch?: number;
  delivery?: { prUrl: string; summary?: string; briefId?: string };
}

export interface ActivityEvent {
  remoteEventId: string; remoteScope?: string; type: ActivityType;
  summary?: string; payload?: unknown; occurredAt: string;
}

export interface UsageSnapshot {
  remoteScope: string;
  inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number;
  costUsd?: number; activeSeconds?: number; coverage: UsageCoverage; computedAt: string;
}

export interface InboundReceipt {
  /** Bridge: receipt refId (= our envelope id = local message id). Ignored when absent. */
  localMessageId?: string;
  remoteEventId: string;
  event: 'picked_up' | 'acked' | 'declined';
  at: string;
}

/** Connectors never write rows; they return batches. */
export interface InboundBatch {
  messages: InboundMessage[];
  activity: ActivityEvent[];
  usage: UsageSnapshot[];
  deliveryHints: { prUrl: string; source: 'report' | 'activity'; remoteEventId: string }[];
  receipts: InboundReceipt[];
  remoteStatus?: RemoteStatus;
  /** The full cursor to store (connector-owned format). */
  nextCursor: string | null;
  /** When set, replaces relay_epoch. */
  cursorEpoch?: number;
  observed: VerifiedFlag[];
  /** true → the pump re-pulls this connection on the next tick (one page per pull). */
  hasMore: boolean;
  /** Opaque; passed to acknowledge() AFTER applyInboundBatch commits. Never persisted. */
  ackToken?: string;
  /** Shallow-merged into remote_json in the SAME transaction (null stores null; absent keys untouched). */
  remotePatch?: Record<string, unknown>;
  /** Max agent-evidence time in this batch (ISO). When set, last_seen_at = max(last_seen_at, this); else now on evidence. */
  lastSeenAt?: string;
}

export interface ReconcileItem { messageId: string; contentHash: string; createdAt: string; body: string; links: string[]; kind: 'text' | 'brief' }
export type ReconcileResult =
  | { messageId: string; outcome: 'found'; receipt: SendReceipt }
  | { messageId: string; outcome: 'not_found' }
  | { messageId: string; outcome: 'unknown' };

export interface RepairOutcome {
  /** With oneTimeToken/instructionBrief for relay-http. */
  pairing: PairingPayload;
  /** e.g. clears pairedClient. */
  remotePatch?: Record<string, unknown>;
  relayEpoch?: number;
  /** When set, replaces inbound_cursor (Bridge: bridge:v1:<newEpoch>:0). */
  inboundCursor?: string;
}

export type InboundSink = (batch: InboundBatch) => void;

export interface AgentConnector {
  readonly definition: ConnectorDefinition;
  /** Synchronous, cheap, no network; consulted before EVERY call. With a handle: may add connection-level gates (other_account). */
  availability(h?: ConnectionHandle): ConnectorAvailability;
  /** Token-bucket key + rate (+ burst capacity; default capacity = ratePerMinute). Default: cred:<credentialId>
   *  or conn:<connectionId>, 120/min. The core configures its bucket with exactly these numbers. */
  budget?(h: ConnectionHandle): { key: string; ratePerMinute: number; capacity?: number };
  /** Sync, pure, no network: the ordered verify checklist for this connection from its row (remote_json,
   *  state). When present, ConnectionView.verifyFacts and VerifyOutcome.facts both come from it. */
  describeFacts?(h: ConnectionHandle): VerifyFact[];
  connect(req: ConnectRequest, o: ConnectorCallOptions): Promise<ConnectOutcome>;
  /** Best-effort remote cleanup when the core could not persist a successful connect. Never throws. */
  rollbackConnect?(req: ConnectRequest, outcome: ConnectOutcome, o: ConnectorCallOptions): Promise<void>;
  verify(h: ConnectionHandle, o: ConnectorCallOptions): Promise<VerifyOutcome>;
  /** MUST be idempotent on msg.id. */
  send(h: ConnectionHandle, msg: OutboundMessage, o: ConnectorCallOptions): Promise<SendReceipt>;
  /** At most ONE page. */
  pull(h: ConnectionHandle, cursor: string | null, o: ConnectorCallOptions): Promise<InboundBatch>;
  /** Called only after the batch committed. Must never throw. */
  acknowledge?(h: ConnectionHandle, ackToken: string, o: ConnectorCallOptions): Promise<void>;
  reconcile(h: ConnectionHandle, items: ReconcileItem[], sinceIso: string, o: ConnectorCallOptions): Promise<ReconcileResult[]>;
  /** Remote revoke. Idempotent. Throw ConnectorError('retryable') to be retried; resolve when already gone. */
  disconnect(h: ConnectionHandle, o: ConnectorCallOptions): Promise<void>;
  control?(h: ConnectionHandle, verb: ControlVerb, o: ConnectorCallOptions): Promise<void>;
  repairPairing?(h: ConnectionHandle, o: ConnectorCallOptions): Promise<RepairOutcome>;
  /** Live stream while the app runs (native connectors). Not used by the Bridge. */
  subscribe?(h: ConnectionHandle, sink: InboundSink): () => void;
  /** Terminal synchronous teardown (sockets, timers). Quit drain only (registry.disposeAll). */
  dispose?(): void;
}

export interface ConnectorRegistration {
  definition: ConnectorDefinition;
  factory: (deps: ConnectorDeps) => AgentConnector;
}

/** What a connector wiring (e.g. the Bridge) gets from the persistent-agents composition. */
export interface ConnectorWiringContext {
  register(reg: ConnectorRegistration, opts?: { override?: boolean }): void;
  /** null in release builds: wire nothing. */
  cloud: CloudAccountHandle | null;
  /** Sync. connector_id = ?, connect_state IS NULL, agent not archived, state != 'revoked', (is_current=1 OR swap_state IS NOT NULL). */
  listHandles(connectorId: string): ConnectionHandle[];
  /** Fires after any 'agents'/'connection' event. Returns unsubscribe. */
  onConnectionsChanged(listener: () => void): () => void;
  findConnectionIdByRemoteId(connectorId: string, remoteId: string): string | null;
  kick(connectionId: string): void;
  kickAll(filter?: (t: { connectionId: string; connectorId: string }) => boolean): void;
  /** Out-of-band non-secret remote_json merge through the store chokepoint. */
  reportRemotePatch(connectionId: string, patch: Record<string, unknown>): Promise<void>;
  /** Remote object gone/revoked → connection state 'revoked', error_kind = reason; pairing cache cleared. */
  reportConnectionGone(connectionId: string, reason: string): Promise<void>;
  /** Account-level availability changed → emits {kind:'connection', agentId:null} (renderer refetch signal). */
  notifyAvailabilityChanged(connectorId: string): void;
  isRunning(): boolean;
  logger: LoggerLike;
  captureSeamError(seam: string, err: unknown, tags?: Record<string, string>): void;
}

/** start()/stop() idempotent AND restartable; stop() synchronous (quit drain). */
export interface ConnectorWiring { start(): void; stop(): void }
