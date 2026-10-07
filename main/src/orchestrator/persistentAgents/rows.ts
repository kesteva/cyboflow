/**
 * Row shapes of the persistent-agents tables (migration 151) and the pure row → domain helpers the store,
 * the views and the services share. Snake_case fields mirror the DDL exactly.
 *
 * Enums are code-validated (the migration has no CHECK constraints): every mapper narrows with `isOneOf`
 * and falls back to a SAFE default for an unknown value (connection state → 'revoked', send state →
 * 'failed', message kind → 'system'), warning once through the optional logger.
 *
 * Imports: shared types, and `import type` only from services/persistentAgents/connectorContract (erased
 * by tsc, so orchestrator/** keeps its no-runtime-services rule).
 */
import {
  ACTIVITY_TYPES,
  CONNECTION_STATES,
  CONNECTOR_KINDS,
  MESSAGE_AUTHORS,
  MESSAGE_DIRECTIONS,
  MESSAGE_KINDS,
  PERSISTENT_AGENT_TRANSPORTS,
  PERSISTENT_AGENT_VENDORS,
  REMOTE_REVOKE_STATES,
  REMOTE_STATUSES,
  SEND_STATES,
  SWAP_STATES,
  USAGE_COVERAGES,
  VENDOR_CREDENTIAL_STATES,
  VENDOR_CREDENTIAL_VENDORS,
  VERIFIED_FLAGS,
  isOneOf,
  type ActivityType,
  type ConnectionCapabilitiesSnapshot,
  type ConnectionState,
  type ConnectorCapabilities,
  type ConnectorErrorKind,
  type ConnectorKind,
  type MessageAuthor,
  type MessageDirection,
  type MessageKind,
  type PersistentAgentTransport,
  type PersistentAgentVendor,
  type RemoteRevokeState,
  type RemoteStatus,
  type SendState,
  type SwapState,
  type UsageCoverage,
  type VendorCredentialState,
  type VendorCredentialVendor,
  type VerifiedFlag,
  type VerifyFact,
} from '../../../../shared/types/persistentAgents';
import type { ConnectionHandle, SendReceipt } from '../../services/persistentAgents/connectorContract';
import type { LoggerLike } from '../types';

// ---------------------------------------------------------------------------
// Rows (exactly the DDL columns)
// ---------------------------------------------------------------------------

export interface AgentRow {
  id: string;
  handle: string;
  display_name: string;
  vendor: string;
  github_login: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConnectionRow {
  id: string;
  agent_id: string;
  kind: string;
  connector_id: string;
  connector_version: number;
  transport: string | null;
  state: string;
  credential_id: string | null;
  remote_id: string | null;
  remote_json: string | null;
  inbound_cursor: string | null;
  relay_epoch: number | null;
  capabilities_json: string;
  verify_json: string | null;
  is_current: number;
  generation: number;
  connect_state: string | null;
  swap_state: string | null;
  swap_from_connection_id: string | null;
  swap_started_at: string | null;
  swap_error: string | null;
  remote_revoke_state: string | null;
  remote_revoke_attempts: number;
  remote_revoke_next_at: string | null;
  remote_revoke_error: string | null;
  remote_status_json: string | null;
  rate_limited_until: string | null;
  auth_retry_at: string | null;
  error_kind: string | null;
  last_error: string | null;
  last_seen_at: string | null;
  verified_at: string | null;
  replaced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  _rowid: number;
  id: string;
  agent_id: string;
  connection_id: string | null;
  direction: string;
  author: string;
  kind: string;
  body: string;
  links_json: string | null;
  delivery_json: string | null;
  attachments_json: string | null;
  brief_entity_type: string | null;
  brief_entity_id: string | null;
  remote_ref: string | null;
  relay_seq: number | null;
  relay_epoch: number | null;
  remote_out_seq: number | null;
  remote_event_id: string | null;
  remote_created_at: string | null;
  is_probe: number;
  send_state: string | null;
  send_attempts: number;
  reconcile_attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  content_hash: string | null;
  claim_generation: number | null;
  sent_at: string | null;
  picked_up_at: string | null;
  remote_ack: string | null;
  remote_ack_at: string | null;
  read_at: string | null;
  client_correlation_id: string | null;
  intent_id: string | null;
  assignment_generation: number | null;
  created_at: string;
  updated_at: string;
}

/** A vendor_credentials row WITHOUT its ciphertext (only getCredentialCiphertext returns that). */
export interface CredentialRow {
  id: string;
  vendor: string;
  label: string;
  fingerprint: string;
  state: string;
  version: number;
  last_error: string | null;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  id: string;
  agent_id: string;
  connection_id: string;
  remote_event_id: string;
  remote_scope: string | null;
  type: string;
  summary: string | null;
  payload_json: string | null;
  occurred_at: string;
  created_at: string;
}

export interface UsageRow {
  connection_id: string;
  remote_scope: string;
  agent_id: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_usd: number | null;
  active_seconds: number | null;
  coverage: string;
  computed_at: string;
}

// ---------------------------------------------------------------------------
// Store operation shapes
// ---------------------------------------------------------------------------

/** What createAgent / createPendingConnection insert for the new connection row. */
export interface NewConnectionRow {
  kind: ConnectorKind;
  connectorId: string;
  connectorVersion: number;
  transport: PersistentAgentTransport | null;
  credentialId: string | null;
  descriptor: ConnectorCapabilities;
}

/** A claimed outbound row: claim_generation is always set by the claim. */
export type ClaimedMessage = MessageRow & { claim_generation: number };

export type SettleOutcome =
  | { ok: true; receipt: SendReceipt }
  | { ok: false; kind: ConnectorErrorKind; maybeDelivered: boolean; error: string; nextAttemptAt: string | null };
export type SettleResult = 'applied' | 'applied_fenced' | 'late_receipt' | 'ignored';

export interface ConnectionPatch {
  state?: ConnectionState;
  errorKind?: string | null;
  lastError?: string | null;
  rateLimitedUntil?: string | null;
  authRetryAt?: string | null;
  remoteStatus?: RemoteStatus | null;
  /** With state 'auth_failed': also marks the connection's credential row. */
  credentialStateIfAuth?: 'auth_failed' | 'undecryptable';
}

export interface ApplyInboundResult {
  insertedMessageIds: string[];
  receiptsApplied: number;
  activityInserted: number;
  usageReplaced: number;
  /** Anything agent-originated arrived (agent/relay messages, receipts, activity). */
  evidence: boolean;
  /** pending → verified in this transaction. */
  becameVerified: boolean;
  observedAdded: VerifiedFlag[];
  /** A repair committed while this pull was in flight: content stored, connection row untouched. */
  fenced: boolean;
}

/** One pump target (listPumpTargets). */
export interface PumpTargetRow {
  id: string;
  agent_id: string;
  connector_id: string;
  kind: string;
  state: string;
  is_current: number;
  swap_state: string | null;
  remote_revoke_state: string | null;
  created_at: string;
  last_seen_at: string | null;
  remote_status_json: string | null;
  rate_limited_until: string | null;
  auth_retry_at: string | null;
}

// ---------------------------------------------------------------------------
// Enum narrowing (safe defaults)
// ---------------------------------------------------------------------------

function narrow<T extends string>(
  values: readonly T[],
  v: unknown,
  fallback: T,
  what: string,
  logger?: LoggerLike,
): T {
  if (isOneOf(values, v)) return v;
  logger?.warn('[persistent-agents] unknown enum value in a row; using a safe default', { what, fallback });
  return fallback;
}

export const toConnectionState = (v: unknown, logger?: LoggerLike): ConnectionState =>
  narrow(CONNECTION_STATES, v, 'revoked', 'connection.state', logger);
export const toSendState = (v: unknown, logger?: LoggerLike): SendState =>
  narrow(SEND_STATES, v, 'failed', 'message.send_state', logger);
export const toMessageKind = (v: unknown, logger?: LoggerLike): MessageKind =>
  narrow(MESSAGE_KINDS, v, 'system', 'message.kind', logger);
export const toMessageDirection = (v: unknown, logger?: LoggerLike): MessageDirection =>
  narrow(MESSAGE_DIRECTIONS, v, 'local', 'message.direction', logger);
export const toMessageAuthor = (v: unknown, logger?: LoggerLike): MessageAuthor =>
  narrow(MESSAGE_AUTHORS, v, 'local', 'message.author', logger);
export const toConnectorKind = (v: unknown, logger?: LoggerLike): ConnectorKind =>
  narrow(CONNECTOR_KINDS, v, 'native', 'connection.kind', logger);
export const toVendor = (v: unknown, logger?: LoggerLike): PersistentAgentVendor =>
  narrow(PERSISTENT_AGENT_VENDORS, v, 'other', 'agent.vendor', logger);
export const toCredentialVendor = (v: unknown, logger?: LoggerLike): VendorCredentialVendor =>
  narrow(VENDOR_CREDENTIAL_VENDORS, v, 'anthropic', 'credential.vendor', logger);
export const toCredentialState = (v: unknown, logger?: LoggerLike): VendorCredentialState =>
  narrow(VENDOR_CREDENTIAL_STATES, v, 'undecryptable', 'credential.state', logger);
export const toActivityType = (v: unknown): ActivityType => (isOneOf(ACTIVITY_TYPES, v) ? v : 'unknown');
export const toUsageCoverage = (v: unknown): UsageCoverage => (isOneOf(USAGE_COVERAGES, v) ? v : 'partial');

export function toTransport(v: unknown): PersistentAgentTransport | null {
  return isOneOf(PERSISTENT_AGENT_TRANSPORTS, v) ? v : null;
}
export function toSwapState(v: unknown): SwapState | null {
  return isOneOf(SWAP_STATES, v) ? v : null;
}
export function toRemoteRevokeState(v: unknown): RemoteRevokeState | null {
  return isOneOf(REMOTE_REVOKE_STATES, v) ? v : null;
}

// ---------------------------------------------------------------------------
// JSON column helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** remote_json → object ({} when null or unparsable). */
export function parseRemote(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const v: unknown = JSON.parse(json);
    return isRecord(v) ? v : {};
  } catch {
    return {};
  }
}

/** remote_status_json {status, at} → RemoteStatus | null. */
export function parseRemoteStatus(json: string | null): RemoteStatus | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return isRecord(v) && isOneOf(REMOTE_STATUSES, v.status) ? v.status : null;
  } catch {
    return null;
  }
}

export const ALL_FALSE_DESCRIPTOR: ConnectorCapabilities = {
  messaging: 'inbound-only',
  inbound: [],
  activityStream: false,
  usage: false,
  control: [],
  taskBriefs: 'message',
  deliveries: 'github-only',
  attachments: false,
};

function isDescriptor(v: unknown): v is ConnectorCapabilities {
  return isRecord(v)
    && (v.messaging === 'two-way' || v.messaging === 'inbound-only')
    && Array.isArray(v.inbound)
    && typeof v.activityStream === 'boolean'
    && typeof v.usage === 'boolean'
    && Array.isArray(v.control)
    && (v.taskBriefs === 'structured' || v.taskBriefs === 'message')
    && (v.deliveries === 'api' || v.deliveries === 'agent-reported' || v.deliveries === 'github-only')
    && typeof v.attachments === 'boolean';
}

/** capabilities_json → snapshot; unparsable → {descriptor: fallback, descriptorVersion: 0, observed: {}}. */
export function parseCapabilities(
  json: string | null,
  fallback: ConnectorCapabilities = ALL_FALSE_DESCRIPTOR,
): ConnectionCapabilitiesSnapshot {
  const bad: ConnectionCapabilitiesSnapshot = { descriptor: fallback, descriptorVersion: 0, observed: {} };
  if (!json) return bad;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return bad;
  }
  if (!isRecord(v) || !isDescriptor(v.descriptor)) return bad;
  const observed: Partial<Record<VerifiedFlag, string>> = {};
  if (isRecord(v.observed)) {
    for (const [k, at] of Object.entries(v.observed)) {
      if (isOneOf(VERIFIED_FLAGS, k) && typeof at === 'string') observed[k] = at;
    }
  }
  return {
    descriptor: v.descriptor,
    descriptorVersion: typeof v.descriptorVersion === 'number' ? v.descriptorVersion : 0,
    observed,
  };
}

/** verify_json → VerifyFact[] ([] on any parse problem). */
export function parseVerifyFacts(json: string | null): VerifyFact[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.filter((f): f is VerifyFact => isRecord(f)
      && typeof f.key === 'string'
      && typeof f.label === 'string'
      && (f.at === null || typeof f.at === 'string')
      && (f.status === 'done' || f.status === 'waiting' || f.status === 'failed'));
  } catch {
    return [];
  }
}

/** links_json → string[] ([] on any problem). */
export function parseLinks(json: string | null): string[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((l): l is string => typeof l === 'string') : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------

/** Build the connector-facing handle from the rows. Never holds a secret. */
export function toConnectionHandle(
  conn: ConnectionRow,
  agent: AgentRow,
  credentialVersion: number | null,
): ConnectionHandle {
  return {
    connectionId: conn.id,
    agentId: agent.id,
    agentHandle: agent.handle,
    agentDisplayName: agent.display_name,
    vendor: toVendor(agent.vendor),
    connectorId: conn.connector_id,
    connectorVersion: conn.connector_version,
    kind: toConnectorKind(conn.kind),
    transport: toTransport(conn.transport),
    state: toConnectionState(conn.state),
    generation: conn.generation,
    remoteId: conn.remote_id,
    remote: parseRemote(conn.remote_json),
    credential: conn.credential_id !== null && credentialVersion !== null
      ? { id: conn.credential_id, version: credentialVersion }
      : null,
    inboundCursor: conn.inbound_cursor,
    relayEpoch: conn.relay_epoch,
  };
}
