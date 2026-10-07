/**
 * Wire and view shapes for persistent agents (Agents & Environments), plus the pure derivations main and
 * the renderer both use (capability chips, health, send labels).
 *
 * Crosses the tRPC boundary, so it lives in shared/ (docs/CODE-PATTERNS.md "IPC / type-parity rules").
 * No secret appears in a main → renderer type except the deliberate one-time pair on BridgePairingPayload
 * (`oneTimeToken`, `instructionBrief`), returned only by connect / switchConnection / repairPairing.
 * Renderer → main secrets: CredentialChoice.secret, AddCredentialInput.secret, RotateCredentialInput.secret.
 * Inbound text is untrusted: render it as escaped plain text only, never as markdown/HTML.
 *
 * Imports nothing but shared/utils/timestamp (no Node, no Electron): the renderer bundles it.
 */
import { parseTimestamp } from '../utils/timestamp';

// ==== Config gate ===========================================================================

/** Stored shape of the sparse `agents` config block (absent member floors to false on read). */
export interface AgentsConfig {
  enabled?: boolean;
}
export const AGENTS_CONFIG_KEYS = ['enabled'] as const satisfies readonly (keyof AgentsConfig)[];

/** cyboflow.persistentAgents.status — never throws; all false when the facade is unset. */
export interface PersistentAgentsStatus {
  /** ConfigManager.isAgentsAvailable() = isDevBuild(): the Settings toggle exists at all. */
  devBuild: boolean;
  /** Raw config.agents?.enabled === true (may be true in a release build; inert there). */
  configEnabled: boolean;
  /** ConfigManager.isAgentsEnabled() = devBuild && configEnabled. Cloud card visible. */
  enabled: boolean;
  /** CYBOFLOW_DISABLE_PERSISTENT_AGENTS=1. */
  killed: boolean;
  /** enabled && !killed: nav item, rail section, pane, credentials list, pump/outbox. */
  running: boolean;
  /** CYBOFLOW_DISABLE_BRIDGE=1. */
  bridgeDisabled: boolean;
}
export const DISABLED_PERSISTENT_AGENTS_STATUS: PersistentAgentsStatus = {
  devBuild: false, configEnabled: false, enabled: false, killed: false, running: false, bridgeDisabled: false,
};

// ==== Code-validated enums (no CHECK in SQL) ================================================

export const PERSISTENT_AGENT_VENDORS = ['anthropic-cma', 'openai-dots', 'meta-muse', 'other'] as const;
export type PersistentAgentVendor = (typeof PERSISTENT_AGENT_VENDORS)[number];

export const CONNECTOR_KINDS = ['native', 'bridge'] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

/** relay-mcp / relay-http mirror relayProtocol.ts RelayTransport (asserted by a shared test). */
export const PERSISTENT_AGENT_TRANSPORTS = ['relay-mcp', 'relay-http', 'poll', 'stream'] as const;
export type PersistentAgentTransport = (typeof PERSISTENT_AGENT_TRANSPORTS)[number];
export type BridgeTransport = Extract<PersistentAgentTransport, 'relay-mcp' | 'relay-http'>;

export const CONNECTION_STATES = ['pending', 'verified', 'stale', 'auth_failed', 'revoked'] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export const SEND_STATES = [
  'queued', 'creating', 'in_flight', 'sent', 'on_bridge', 'ambiguous', 'failed', 'withdrawn',
] as const;
export type SendState = (typeof SEND_STATES)[number];

export const MESSAGE_KINDS = ['text', 'brief', 'delivery_report', 'system'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** 'local' = a note cyboflow wrote itself (swap note, gap note); it never went over any wire. */
export const MESSAGE_DIRECTIONS = ['in', 'out', 'local'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

/** user = typed in cyboflow; agent = the vendor agent; relay = the Bridge's own system notes; local = cyboflow. */
export const MESSAGE_AUTHORS = ['user', 'agent', 'relay', 'local'] as const;
export type MessageAuthor = (typeof MESSAGE_AUTHORS)[number];

/** interrupt = stop the current turn; end = close the remote session. */
export const CONTROL_VERBS = ['interrupt', 'pause', 'resume', 'end'] as const;
export type ControlVerb = (typeof CONTROL_VERBS)[number];

export const VERIFIED_FLAGS = ['round-trip', 'activity', 'usage', 'control', 'delivery', 'attachments'] as const;
export type VerifiedFlag = (typeof VERIFIED_FLAGS)[number];

export const REMOTE_STATUSES = ['working', 'idle', 'errored', 'budget_paused'] as const;
export type RemoteStatus = (typeof REMOTE_STATUSES)[number];

export const VENDOR_CREDENTIAL_VENDORS = ['anthropic', 'github-pat'] as const;
export type VendorCredentialVendor = (typeof VENDOR_CREDENTIAL_VENDORS)[number];

export const VENDOR_CREDENTIAL_STATES = ['ok', 'auth_failed', 'revoked', 'undecryptable'] as const;
export type VendorCredentialState = (typeof VENDOR_CREDENTIAL_STATES)[number];

/** Persisted on the NEW connection while a swap is in progress; NULL otherwise. */
export const SWAP_STATES = [
  'connecting', 'awaiting_verify', 'fencing', 'reconciling', 'revoking_remote', 'activating',
] as const;
export type SwapState = (typeof SWAP_STATES)[number];

export const REMOTE_REVOKE_STATES = ['pending', 'done', 'gave_up'] as const;
export type RemoteRevokeState = (typeof REMOTE_REVOKE_STATES)[number];

export const ACTIVITY_TYPES = [
  'tool_call', 'tool_result', 'status', 'error', 'model_request', 'unknown',
  'delivery_hint', 'late_receipt', // core-internal rows
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const USAGE_COVERAGES = ['complete', 'vendor-cumulative', 'partial'] as const;
export type UsageCoverage = (typeof USAGE_COVERAGES)[number];

/** A connector-level (or, with a handle, connection-level) gate consulted before every connector call. */
export const CONNECTOR_AVAILABILITY_STATES = [
  'ok', 'signed_out', 'locked', 'device_revoked', 'needs_update', 'not_entitled', 'other_account',
  'disabled', 'unavailable',
] as const;
export type ConnectorAvailabilityState = (typeof CONNECTOR_AVAILABILITY_STATES)[number];

/** Kinds of main-side ConnectorError (connectorErrors.ts). Shared so the router maps them structurally. */
export const CONNECTOR_ERROR_KINDS = [
  'auth',             // the connection's own credential was rejected → connection auth_failed (native only)
  'device_auth',      // the shared cloud device token was rejected → availability flips; connections untouched
  'paused',           // the connector refused WITHOUT network (gate closed: signed out, locked, kill switch, other account)
  'not_entitled',     // 403 not_entitled
  'upgrade_required', // 426
  'rate_limited',     // 429 / local budget exhausted (retryAfterMs)
  'retryable',        // 5xx / network / timeout / 503 (accounts_unavailable, revoke_pending, relay_disabled)
  'not_found',        // the remote object is gone or not ours (404)
  'revoked',          // the remote connection is revoked (409 connection_revoked)
  'invalid',          // refused as malformed / too large (400/413)
  'conflict',         // a limit or state conflict (409 connection_limit, …)
  'permanent',        // anything else retrying cannot fix
] as const;
export type ConnectorErrorKind = (typeof CONNECTOR_ERROR_KINDS)[number];

/** Codes a persistentAgents mutation failure carries (see toPersistentAgentsFailure in the router). */
export const PERSISTENT_AGENTS_ERROR_CODES = [
  'feature_disabled', 'not_found', 'invalid_input', 'too_large', 'handle_taken',
  'swap_in_progress', 'no_swap_in_progress', 'no_connection', 'connection_revoked', 'agent_archived',
  'control_not_supported', 'pairing_not_supported', 'connector_unavailable', 'connector_disabled',
  'not_signed_in', 'cloud_locked', 'device_revoked', 'other_account', 'not_entitled', 'upgrade_required',
  'rate_limited', 'service_unavailable', 'connection_limit', 'connection_gone', 'conflict',
  'auth_rejected', 'secrets_unavailable', 'credential_undecryptable', 'in_use', 'unknown',
] as const;
export type PersistentAgentsErrorCode = (typeof PERSISTENT_AGENTS_ERROR_CODES)[number];

/** Error class names the router matches by `err.name` (it may not import services/*). */
export const PERSISTENT_AGENTS_ERROR_NAMES = {
  notInitialized: 'PersistentAgentsNotInitializedError',
  disabled: 'PersistentAgentsDisabledError',
  agentNotFound: 'AgentNotFoundError',
  connectionNotFound: 'ConnectionNotFoundError',
  credentialNotFound: 'CredentialNotFoundError',
  connectorNotRegistered: 'ConnectorNotRegisteredError',
  connectorUnavailable: 'ConnectorUnavailableError',
  controlNotSupported: 'ControlNotSupportedError',
  agentNotSendable: 'AgentNotSendableError',
  swapInProgress: 'SwapInProgressError',
  noSwapInProgress: 'NoSwapInProgressError',
  invalidInput: 'InvalidAgentInputError',
  handleTaken: 'HandleTakenError',
  pairingNotSupported: 'PairingNotSupportedError',
  credentialUndecryptable: 'CredentialUndecryptableError',
  secretsUnavailable: 'SecretsUnavailableError',
  connector: 'ConnectorError',
} as const;

/** Narrow an unknown DB/wire value to a code-validated enum. */
export function isOneOf<T extends string>(values: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (values as readonly string[]).includes(v);
}

// ==== Limits & thresholds ===================================================================

/** Equal to relayProtocol.ts MAX_MESSAGE_BYTES (asserted by a shared test); a connector may be stricter. */
export const PERSISTENT_AGENT_MAX_MESSAGE_BYTES = 65_536;
export const PERSISTENT_AGENT_MAX_LINKS = 20;
export const PERSISTENT_AGENT_MAX_LINK_LENGTH = 2_048;
/** Same as the relay's link rule. */
export const PERSISTENT_AGENT_LINK_RE = /^https?:\/\/\S+$/;
/** cf/<handle>/ branch prefix. */
export const PERSISTENT_AGENT_HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const PERSISTENT_AGENT_MAX_DISPLAY_NAME = 80;
export const HEALTH_GREEN_MAX_AGE_MS = 15 * 60_000;      // < 15 min → green
export const HEALTH_AMBER_MAX_AGE_MS = 24 * 3_600_000;   // ≤ 24 h → amber
export const BRIDGE_STALE_AFTER_MS = 24 * 3_600_000;     // > 24 h with no inbound evidence → 'stale'
/** Equal to relayProtocol.ts PAIRING_TTL_MS (asserted by a shared test). */
export const PERSISTENT_AGENT_PAIRING_TTL_MS = 10 * 60_000;
/** Shown expiry = issue time + PAIRING_TTL − this, so the UI never shows a code the server already expired. */
export const PAIRING_DISPLAY_SAFETY_MS = 5_000;

// ==== Connector descriptor & availability ==================================================

export interface ConnectorCapabilities {
  messaging: 'two-way' | 'inbound-only';
  inbound: ReadonlyArray<'push' | 'poll' | 'agent-initiated'>;
  activityStream: boolean;
  usage: boolean;
  control: ReadonlyArray<ControlVerb>;
  taskBriefs: 'structured' | 'message';
  deliveries: 'api' | 'agent-reported' | 'github-only';
  attachments: boolean;
}

export interface ConnectorDefinition {
  id: 'claude-managed-agents' | 'bridge' | (string & {});
  kind: ConnectorKind;
  /** Bumps on any descriptor or wire change; new capabilities start unconfirmed. */
  version: number;
  vendors: readonly PersistentAgentVendor[];
  displayName: string;
  connectsVia: 'api' | 'bridge';
  capabilities: ConnectorCapabilities;
  /** vendor_credentials.vendor this connector needs; null = no vendor key (the Bridge). */
  credentialVendor: VendorCredentialVendor | null;
  transports: readonly PersistentAgentTransport[];
  limits: { maxMessageBytes: number; maxLinks: number };
}

export interface ConnectorAvailability {
  state: ConnectorAvailabilityState;
  /** User-facing, connector-owned copy for any state but 'ok'. */
  message: string | null;
  /** ISO. For 'unavailable': set = blocked until then (not callable); null = degraded but keep trying. */
  retryAt: string | null;
}

/** Whether pump/outbox/connect/verify may call the connector now. */
export function isConnectorCallable(a: ConnectorAvailability): boolean {
  return a.state === 'ok' || (a.state === 'unavailable' && a.retryAt === null);
}

export interface ConnectionCapabilitiesSnapshot {
  descriptor: ConnectorCapabilities;
  descriptorVersion: number;
  /** flag → first-seen ISO time. Missing key = not observed. */
  observed: Partial<Record<VerifiedFlag, string>>;
}

// ==== Connect inputs / results ==============================================================

export interface NewAgentInput {
  displayName: string;                 // 1-80 chars, trimmed, no control chars
  vendor: PersistentAgentVendor;
  /** cf/<handle>/ branch prefix. Omitted → derived from displayName (slugified). */
  handle?: string;
  githubLogin?: string;
}

export type CredentialChoice =
  | { mode: 'existing'; credentialId: string }
  | { mode: 'new'; label: string; secret: string };

/** Native selection is refined when a native connector ships; v1 registers none. */
export interface NativeRemoteSelection {
  remoteAgentId?: string;
  templateId?: string;
  remoteEnvironmentId?: string;
}

export type ConnectionInput =
  | { kind: 'bridge'; connectorId: 'bridge'; transport: BridgeTransport; label?: string }
  | { kind: 'native'; connectorId: string; credential: CredentialChoice; remote: NativeRemoteSelection };

export interface ConnectInput { agent: NewAgentInput; connection: ConnectionInput }
export interface SwitchConnectionInput { agentId: string; connection: ConnectionInput }

/** Everything the Connect dialog shows for a Bridge connection. */
export interface BridgePairingPayload {
  kind: 'bridge';
  /** LOCAL persistent_agent_connections.id. */
  connectionId: string;
  transport: BridgeTransport;
  /** From the relay response, never built client-side. */
  mcpUrl: string;
  httpBase: string;
  /** relay-mcp only (WORD-WORD-NNNN); null for relay-http. */
  pairingCode: string | null;
  /** relay-mcp only; ISO = issue time + PAIRING_TTL_MS − PAIRING_DISPLAY_SAFETY_MS. */
  pairingExpiresAt: string | null;
  /** relay-http only (cbh_…); ONLY in connect/switchConnection/repairPairing responses, else null. */
  oneTimeToken: string | null;
  /** relay-http only; the paste-able instructions (contain the token); same one-time rule. */
  instructionBrief: string | null;
}
export type PairingPayload = BridgePairingPayload;

export interface ConnectResultData { agentId: string; connectionId: string; pairing: PairingPayload | null }

// ==== Verify ================================================================================

export interface VerifyFact {
  /** Connector-stable id. Bridge: pairing-issued | token-issued | paired | pair-called | first-call | picked-up | round-trip. */
  key: string;
  /** Connector-owned fixed text; NEVER contains untrusted text (the client name goes in `subject`). */
  label: string;
  at: string | null;
  status: 'done' | 'waiting' | 'failed';
  /** key 'paired' (done) only. `name` is self-declared by the vendor client, already sanitised by the
   *  connector (no control / bidi / zero-width characters, ≤ 100 chars); render it in its own `<bdi>`
   *  element, never concatenated into `label`. `host` is the relay-verified redirect host. */
  subject?: { name: string | null; host: string };
}
export interface VerifyView {
  connectionId: string;
  state: ConnectionState;
  facts: VerifyFact[];
  /** A probe message is (now) queued on this connection. */
  probeQueued: boolean;
}

// ==== Views (main → renderer) ===============================================================

export interface PairedClientView {
  /** Self-declared by the vendor client; label it as such. Untrusted text. */
  name: string | null;
  redirectHost: string;
  pairedAt: string;
}

export interface ConnectionView {
  id: string;
  kind: ConnectorKind;
  connectorId: string;
  connectorVersion: number;
  /** 'Connector disabled' when not registered. */
  connectorDisplayName: string;
  transport: PersistentAgentTransport | null;
  state: ConnectionState;
  isCurrent: boolean;
  lastSeenAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
  remoteStatus: RemoteStatus | null;
  rateLimitedUntil: string | null;
  capabilities: ConnectionCapabilitiesSnapshot;
  availability: ConnectorAvailability;
  credential: { id: string; label: string; fingerprint: string; state: VendorCredentialState } | null;
  /** Non-secret Bridge endpoints for display/copy (never the token). */
  endpoints: { mcpUrl: string | null; httpBase: string | null } | null;
  pairedClient: PairedClientView | null;
  /** Live: `connector.describeFacts(handle)` when the connector implements it (the Bridge does), else the
   *  facts stored by the last connect/verify (`verify_json`), else []. Ordered; render top to bottom. */
  verifyFacts: VerifyFact[];
  remoteRevoke: { state: RemoteRevokeState; attempts: number; lastError: string | null; surfaced: boolean } | null;
  lastError: string | null;
}

/** A non-current connection whose remote revoke is still failing. */
export interface RetiredConnectionView {
  connectionId: string;
  connectorDisplayName: string;
  /** 'pending' with attempts >= REVOKE_SURFACE_AFTER, or 'gave_up'. */
  remoteRevoke: { state: Extract<RemoteRevokeState, 'pending' | 'gave_up'>; attempts: number; lastError: string | null };
}
/** A failing remote revoke is surfaced to the user after this many attempts. */
export const REVOKE_SURFACE_AFTER = 3;

export interface PendingSwitchView {
  connectionId: string;
  swapState: SwapState;
  startedAt: string;
  connection: ConnectionView;
}

export interface AgentView {
  id: string;
  handle: string;
  displayName: string;
  vendor: PersistentAgentVendor;
  githubLogin: string | null;
  archivedAt: string | null;
  createdAt: string;
  unreadCount: number;
  lastMessageAt: string | null;
  /** The current connection. After Disconnect it is still present with state 'revoked'; null only in the
   *  defensive abortConnectionCreate branch. */
  connection: ConnectionView | null;
  pendingSwitch: PendingSwitchView | null;
  lastSwitchError: string | null;
  /** Non-current connections with remote_revoke_state 'gave_up', or 'pending' with
   *  remote_revoke_attempts >= REVOKE_SURFACE_AFTER; oldest first. [] normally. */
  retiredConnections: RetiredConnectionView[];
}

export interface LinkView { url: string; domain: string }

export interface ThreadMessageView {
  id: string;
  connectionId: string | null;
  direction: MessageDirection;
  author: MessageAuthor;
  kind: MessageKind;
  /** Untrusted when author is 'agent'/'relay': render as escaped plain text. */
  body: string;
  links: LinkView[];
  delivery: { prUrl: string; prDomain: string; summary: string | null; briefId: string | null } | null;
  /** Local insert time (thread order key). */
  createdAt: string;
  remoteCreatedAt: string | null;
  isProbe: boolean;
  // outbound only (null / 0 for in/local):
  sendState: SendState | null;
  sendAttempts: number;
  nextAttemptAt: string | null;
  /** Redacted, ≤ 500 chars; never a body, token or URL. */
  lastError: string | null;
  sentAt: string | null;
  pickedUpAt: string | null;
  remoteAck: 'acked' | 'declined' | null;
  // inbound only:
  readAt: string | null;
}

/** Messages oldest → newest; `before` (a message id) pages backwards. */
export interface ThreadPage { agentId: string; messages: ThreadMessageView[]; hasMore: boolean }

export interface ActivityView {
  id: string; connectionId: string; remoteScope: string | null; type: ActivityType;
  summary: string | null; payloadJson: string | null; occurredAt: string;
}

export interface UsageRowView {
  connectionId: string; remoteScope: string;
  inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null;
  cacheCreationTokens: number | null; costUsd: number | null; activeSeconds: number | null;
  coverage: UsageCoverage; computedAt: string;
}
export interface UsageView {
  agentId: string;
  rows: UsageRowView[];
  totals: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number; activeSeconds: number };
  /** 'none' = no rows; else the weakest coverage among rows (partial < vendor-cumulative < complete). */
  coverage: UsageCoverage | 'none';
}

export interface CredentialReference { agentId: string; displayName: string; connectionId: string }

export interface CredentialView {
  id: string; vendor: VendorCredentialVendor; label: string; fingerprint: string;
  state: VendorCredentialState; version: number; lastVerifiedAt: string | null; createdAt: string;
  referencedBy: CredentialReference[];
}

export interface ConnectorView { definition: ConnectorDefinition; availability: ConnectorAvailability }

// ==== Router inputs that are also facade inputs ============================================

export interface GetThreadInput { agentId: string; before?: string; limit: number }
export interface SendInput { agentId: string; text: string; links?: string[] }
export interface AddCredentialInput { vendor: VendorCredentialVendor; label: string; secret: string }
export interface RotateCredentialInput { id: string; secret: string }

// ==== Mutation results ======================================================================

export interface PersistentAgentsFailure {
  ok: false;
  error: PersistentAgentsErrorCode;
  /** Safe, user-presentable text built from fixed strings and server error codes. */
  message: string;
  field?: 'displayName' | 'handle' | 'label' | 'secret' | 'text';
  /** error 'in_use' only. */
  referencedBy?: CredentialReference[];
  /** rate_limited / service_unavailable when known (ISO). */
  retryAt?: string | null;
}
export type PersistentAgentsResult<T extends object = Record<never, never>> = ({ ok: true } & T) | PersistentAgentsFailure;

export type SendResult = PersistentAgentsResult<{ messageId: string }>;
export type ConnectMutationResult = PersistentAgentsResult<ConnectResultData>;
export type VerifyResult = PersistentAgentsResult<VerifyView>;
export type RepairPairingResult = PersistentAgentsResult<{ pairing: PairingPayload }>;
export type DisconnectResult = PersistentAgentsResult<{
  connectionId: string;
  /** 'pending' = remote revoke not confirmed yet; the core keeps retrying. */
  remoteRevoke: 'done' | 'pending';
  /** Set only when this was the credential's last live reference ("Also forget this key"). */
  offerForgetCredentialId: string | null;
}>;
export type OkResult = PersistentAgentsResult;
export type CredentialMutationResult = PersistentAgentsResult<{ credential: CredentialView }>;
/** Without `detach`, a referenced key fails with error 'in_use' + referencedBy. */
export type ForgetCredentialResult = PersistentAgentsResult;

// ==== Events (signals; the renderer re-queries) ============================================

export interface PersistentAgentsChangedEvent {
  kind: 'agents' | 'connection' | 'unread' | 'credentials' | 'status';
  agentId: string | null;
}
export interface PersistentAgentThreadEvent {
  agentId: string;
  kind: 'messages' | 'receipts' | 'read' | 'activity' | 'usage' | 'connection';
  messageIds: string[];
}

// ==== Pure derivations ======================================================================

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function validDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = parseTimestamp(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function monthDay(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** <60 s 'just now'; <60 min 'Nm ago'; <24 h 'Nh ago'; else 'Mon D' (local calendar). Negative ages clamp to 0. '' for invalid input. */
export function formatLastSeen(iso: string, now: Date): string {
  const d = validDate(iso);
  if (!d) return '';
  const age = Math.max(0, now.getTime() - d.getTime());
  if (age < 60_000) return 'just now';
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`;
  return monthDay(d);
}

// ---- Capability chips (labels include the not-confirmed suffix) ----------------------------

export type ChipTone = 'success' | 'neutral' | 'error';
export type CapabilityChipKey =
  | 'messages' | 'links' | 'deliveries' | 'activity' | 'usage'
  | 'control-interrupt' | 'control-end' | 'control-pause' | 'control-resume' | 'control-none'
  | 'attachments' | 'briefs';
export interface CapabilityChip { key: CapabilityChipKey; label: string; tone: ChipTone; unconfirmed: boolean }
export const NOT_CONFIRMED_SUFFIX = ' (not confirmed)';

const CONTROL_ORDER = ['interrupt', 'end', 'pause', 'resume'] as const;
const CONTROL_LABEL: Record<ControlVerb, string> = { interrupt: 'Stop', end: 'End session', pause: 'Pause', resume: 'Resume' };
const DELIVERY_LABEL: Record<ConnectorCapabilities['deliveries'], string> = {
  api: 'PRs via API', 'agent-reported': 'Reports PRs', 'github-only': 'Opens PRs via GitHub',
};

/** Optional per-connection context (labels differ by transport / vendor app). */
export interface ChipContext { transport?: PersistentAgentTransport | null; vendor?: PersistentAgentVendor }

/** Fixed order, never truncated; chip count = 7 + max(1, control.length). Never emits tone 'error'. */
export function deriveChips(s: ConnectionCapabilitiesSnapshot, ctx: ChipContext = {}): CapabilityChip[] {
  const d = s.descriptor;
  const declared = (key: CapabilityChipKey, label: string, flag: VerifiedFlag): CapabilityChip =>
    s.observed[flag] !== undefined
      ? { key, label, tone: 'success', unconfirmed: false }
      : { key, label: label + NOT_CONFIRMED_SUFFIX, tone: 'neutral', unconfirmed: true };
  const limitation = (key: CapabilityChipKey, label: string): CapabilityChip =>
    ({ key, label, tone: 'neutral', unconfirmed: false });

  const chips: CapabilityChip[] = [];
  if (d.messaging === 'two-way') {
    const polled = d.inbound.includes('push') || d.inbound.includes('poll');
    const msgLabel = polled ? 'Two-way messages'
      : ctx.transport === 'relay-http' ? 'Messages, best effort'          // relay-http clients (e.g. Muse)
      : 'Messages when the agent checks in';                              // relay-mcp clients (e.g. ChatGPT)
    chips.push(declared('messages', msgLabel, 'round-trip'));
    chips.push(declared('links', 'Links', 'round-trip'));
  } else {
    chips.push(limitation('messages', 'Agent → cyboflow only'));
    chips.push(limitation('links', 'Links from the agent only'));
  }
  chips.push(declared('deliveries', DELIVERY_LABEL[d.deliveries], 'delivery'));
  chips.push(d.activityStream ? declared('activity', 'Live activity', 'activity') : limitation('activity', 'No live activity'));
  chips.push(d.usage ? declared('usage', 'Cost & tokens', 'usage') : limitation('usage', 'No cost data'));
  const verbs = CONTROL_ORDER.filter((v) => d.control.includes(v));
  if (verbs.length === 0) {
    chips.push(limitation('control-none', ctx.vendor ? `No remote stop · use ${vendorAppName(ctx.vendor)}` : 'No remote stop'));
  }
  for (const v of verbs) chips.push(declared(`control-${v}`, CONTROL_LABEL[v], 'control'));
  chips.push(d.attachments ? declared('attachments', 'Attachments', 'attachments') : limitation('attachments', 'No attachments'));
  chips.push(limitation('briefs', d.taskBriefs === 'structured' ? 'Structured briefs' : 'Briefs as messages'));
  return chips;
}

// ---- Health (first match wins) ---------------------------------------------------------------

export type HealthDot = 'green' | 'amber' | 'neutral' | 'hollow' | 'red';
export interface HealthInput {
  kind: ConnectorKind;
  vendor: PersistentAgentVendor;
  state: ConnectionState;
  lastSeenAt: string | null;
  verifiedAt: string | null;
  remoteStatus?: RemoteStatus | null;
  availability?: ConnectorAvailability | null;
  credentialState?: VendorCredentialState | null;
  rateLimitedUntil?: string | null;
}
export interface HealthView { dot: HealthDot; copy: string; banner: { kind: 'stale'; copy: string } | null }

export function vendorAppName(v: PersistentAgentVendor): string {
  switch (v) {
    case 'openai-dots': return 'ChatGPT';
    case 'meta-muse': return 'Muse';
    case 'anthropic-cma': return 'the Claude Console';
    default: return "the agent's app";
  }
}
function orgName(kind: ConnectorKind, vendor: PersistentAgentVendor): string {
  if (kind === 'bridge') return 'the Bridge';
  return vendor === 'anthropic-cma' ? 'Anthropic' : 'the vendor';
}
const NEUTRAL_AVAILABILITY_COPY: Partial<Record<ConnectorAvailabilityState, string>> = {
  signed_out: 'Sign in to cyboflow cloud',
  locked: 'Waiting for the cyboflow cloud sign-in',
  not_entitled: "Bridge isn't enabled for your account",
  other_account: 'Created under a different cyboflow cloud account',
  disabled: 'Disabled on this computer',
};
const AMBER_AVAILABILITY_COPY: Partial<Record<ConnectorAvailabilityState, string>> = {
  needs_update: 'Update cyboflow to keep agent messages flowing',
  unavailable: "Can't reach the service · retrying",
};

export function deriveHealth(c: HealthInput, now: Date): HealthView {
  const view = (dot: HealthDot, copy: string, banner: HealthView['banner'] = null): HealthView => ({ dot, copy, banner });
  const a = c.availability ?? null;
  // 1–4: red is produced only for revoked / REJECTED credentials. An unreadable stored key
  // was not rejected by anyone, so it is amber.
  if (c.state === 'revoked') return view('red', c.kind === 'bridge' ? 'Token revoked' : 'Connection revoked · reconnect');
  if (c.credentialState === 'undecryptable') return view('amber', "Stored API key can't be read on this computer · re-enter it");
  if (c.state === 'auth_failed') return view('red', c.kind === 'native' ? 'API key rejected · reconnect' : 'Rejected by the Bridge · repair');
  if (a?.state === 'device_revoked') return view('red', a.message ?? 'Signed out of cyboflow cloud · sign in again');
  // 5–6: connector gates
  const neutralCopy = a ? NEUTRAL_AVAILABILITY_COPY[a.state] : undefined;
  if (a && neutralCopy !== undefined) return view('neutral', a.message ?? neutralCopy);
  const amberCopy = a ? AMBER_AVAILABILITY_COPY[a.state] : undefined;
  if (a && amberCopy !== undefined) return view('amber', a.message ?? amberCopy);
  // 7: rate limit
  const rl = validDate(c.rateLimitedUntil);
  if (rl && rl.getTime() > now.getTime()) return view('amber', `Rate-limited by ${orgName(c.kind, c.vendor)} · retrying`);
  // 8: pending
  if (c.state === 'pending') return view('hollow', 'Not yet verified · waiting for its first reply');
  // 9: stale
  const lastSeen = validDate(c.lastSeenAt);
  const staleCopy = lastSeen ? `Quiet since ${monthDay(lastSeen)} · messages wait on the bridge` : 'Quiet · messages wait on the bridge';
  const staleBanner = { kind: 'stale' as const, copy: `Open ${vendorAppName(c.vendor)} and ask it to check its cyboflow messages` };
  if (c.state === 'stale') return view('neutral', staleCopy, staleBanner);
  // 10: verified native with presence
  if (c.kind === 'native' && c.remoteStatus) {
    switch (c.remoteStatus) {
      case 'working': return view('green', 'Connected via API · working');
      case 'idle': return view('green', 'Connected via API · idle · awaiting input');
      case 'errored': return view('amber', 'Connected via API · errored');
      case 'budget_paused': return view('amber', 'Paused at budget');
    }
  }
  // 11–15: verified by age
  const seen = lastSeen ?? validDate(c.verifiedAt);
  if (!seen) return view('amber', 'Connected · last seen unknown');
  const age = Math.max(0, now.getTime() - seen.getTime());
  const rel = formatLastSeen(seen.toISOString(), now);
  const connected = c.kind === 'native' ? `Connected via API · last seen ${rel}` : `Connected via cyboflow Bridge · last seen ${rel}`;
  if (age < HEALTH_GREEN_MAX_AGE_MS) return view('green', connected);
  if (age <= HEALTH_AMBER_MAX_AGE_MS) return view('amber', connected);
  if (c.kind === 'bridge') return view('neutral', staleCopy, staleBanner);
  return view('amber', connected);
}

// ---- Send labels (never a "read"/"seen"/"delivered" state) ---------------------------------

export interface SendLabel { label: string; at: string | null; tone: 'neutral' | 'success' | 'warning' | 'error' }

export function deriveSendLabel(
  m: Pick<ThreadMessageView, 'sendState' | 'sendAttempts' | 'nextAttemptAt' | 'pickedUpAt' | 'remoteAck'>,
  connectionState: ConnectionState | null,
  now: Date,
): SendLabel {
  const s = m.sendState;
  if (s === null) return { label: '', at: null, tone: 'neutral' };
  if (m.remoteAck === 'declined') return { label: 'Declined', at: null, tone: 'warning' };
  if (m.remoteAck === 'acked') return { label: 'Accepted', at: null, tone: 'success' };
  if (m.pickedUpAt) return { label: 'Picked up', at: m.pickedUpAt, tone: 'success' };
  switch (s) {
    case 'withdrawn': return { label: 'Withdrawn', at: null, tone: 'neutral' };
    case 'failed': return { label: 'Not sent', at: null, tone: 'error' };
    case 'on_bridge': return { label: 'On the bridge', at: null, tone: 'success' };
    case 'sent': return { label: 'Sent', at: null, tone: 'success' };
    case 'ambiguous': return { label: 'Checking delivery…', at: null, tone: 'warning' };
    case 'queued': {
      if (connectionState === 'revoked') return { label: 'Waiting · agent disconnected', at: null, tone: 'warning' };
      if (connectionState === 'auth_failed') return { label: 'Waiting · reconnect to send', at: null, tone: 'warning' };
      const next = validDate(m.nextAttemptAt);
      if (m.sendAttempts > 0 && next && next.getTime() > now.getTime()) {
        return { label: 'Retrying…', at: m.nextAttemptAt, tone: 'warning' };
      }
      return { label: 'Queued', at: null, tone: 'neutral' };
    }
    default: return { label: 'Sending…', at: null, tone: 'neutral' }; // creating / in_flight
  }
}
