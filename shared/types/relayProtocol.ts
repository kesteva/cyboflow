// cyboflow Bridge relay wire protocol.
//
// Shared by the cyboflow desktop (`shared/types/relayProtocol.ts`) and the relay; the two copies must stay
// byte-identical (each repo has a checksum test). Change both in lockstep and re-pin both checksums.
// Within one protocol version only additive changes are allowed. This file must stay dependency-free
// (no imports).

export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_PROTOCOL_MIN = 1;
export const RELAY_PROTOCOL_MAX = 1;
/** Same convention as the sync protocol header; the relay answers 426 outside [MIN, MAX]. */
export const RELAY_PROTOCOL_HEADER = 'Cyboflow-Relay-Protocol';

// ---- Limits -------------------------------------------------------------------------------------

/** At most 64 KB per message body (no attachments in v1). */
export const MAX_MESSAGE_BYTES = 64 * 1024;
/** At most this many unacked non-receipt inbound messages per connection, then 429 with retry-after. */
export const MAX_UNACKED_INBOUND = 1000;
export const MAX_CONNECTIONS_PER_ACCOUNT = 20;
/** Live retention: inbound until desktop ack, else 7 days after creation. */
export const LIVE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Envelope ids stay in the dedupe ledger longer than live retention plus any retry. */
export const SEEN_ID_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const PAIRING_MAX_FAILURES = 5;
/** Largest page GET /bridge/v1/connections/:id/inbound returns. */
export const MAX_INBOUND_PAGE = 100;
/** WebSocket close code the doorbell uses when the device is revoked. */
export const DOORBELL_CLOSE_DEVICE_REVOKED = 4401;

// ---- Envelope -----------------------------------------------------------------------------------

export type RelayDirection = 'in' | 'out';
export type RelayEnvelopeKind = 'text' | 'brief' | 'delivery_report' | 'system' | 'receipt';
export type RelayReceiptEvent = 'picked_up' | 'acked' | 'declined';

export interface RelayReceipt {
  /** The outbound envelope id this receipt is about. */
  refId: string;
  event: RelayReceiptEvent;
  /** ISO-8601 timestamp. */
  at: string;
}

/** A vendor's report_delivery hint (kind 'delivery_report'). cyboflow re-reads the PR from GitHub. */
export interface RelayDelivery {
  prUrl: string;
  summary?: string;
  briefId?: string;
}

export interface RelayEnvelope {
  id: string;
  connectionId: string;
  direction: RelayDirection;
  kind: RelayEnvelopeKind;
  body: string;
  links: string[];
  relaySeq: number;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp, or null while the vendor agent has not picked the message up. */
  pickedUpAt: string | null;
  /** Present only on kind 'receipt'. */
  receipt?: RelayReceipt;
  /** Present only on kind 'delivery_report'. */
  delivery?: RelayDelivery;
}

// ---- Desktop API (desktop origin, /bridge/v1/*; accounts device token `cbd_...`) -------------------
// Served on the one desktop-facing origin next to accounts and sync. The device token is issued and
// verified by the accounts service; the relay answers 401 `unauthorized` / `device_revoked`, 403
// `not_entitled` (no `bridge` entitlement) and 503 `accounts_unavailable` (back off, never sign out).
// The account card is accounts' GET /v1/account.

export type RelayTransport = 'relay-mcp' | 'relay-http';

/** POST /bridge/v1/connections */
export interface CreateConnectionRequest {
  transport: RelayTransport;
  /** Shown on the pairing consent page; at most 100 characters. */
  label?: string;
}
export interface CreateConnectionResponse {
  connectionId: string;
  pairingCode: string;
  mcpUrl: string;
  httpBase: string;
  /** Only for relay-http; shown once, never stored server-side in plain. */
  token?: string;
}

export type RelayConnectionState = 'active' | 'revoked';

/** The OAuth client that last completed pairing on a relay-mcp connection (cleared by repair). */
export interface PairedClient {
  /** Self-declared by the client when it registered; the relay has not verified it. */
  name: string | null;
  /** Host of the exact redirect URI the client paired with. */
  redirectHost: string;
  /** Epoch milliseconds. */
  pairedAt: number;
}

/** GET /bridge/v1/connections: this account's connections (never another account's). */
export interface ConnectionSummary {
  id: string;
  transport: RelayTransport;
  state: RelayConnectionState;
  label: string | null;
  createdAt: number;
  /** Present once a vendor client has paired over OAuth (relay-mcp only). */
  pairedClient?: PairedClient;
}
export interface ListConnectionsResponse {
  connections: ConnectionSummary[];
}

/**
 * GET /bridge/v1/connections/:id/inbound?epoch=<e>&after=<seq>&limit=100 */
export interface InboundPage {
  /**
   * Opaque: compare for equality only. A changed epoch is at least the wall-clock time (epoch ms) of the
   * change, so it never repeats on a connection, even after a server-side restore.
   */
  epoch: number;
  items: RelayEnvelope[];
  /** The highest relaySeq currently assigned on this connection. */
  head: number;
  /** Sequence numbers that expired unseen; the desktop inserts a "messages expired on the relay" note. */
  gap?: { from: number; to: number };
}

/**
 * POST /bridge/v1/connections/:id/ack. `upTo` must not exceed the last seq served to THIS device in the
 * current epoch (a reported gap counts as served), else 409 ack_beyond_served. A stale epoch is 409
 * stale_epoch. Idempotent.
 */
export interface AckRequest {
  epoch: number;
  upTo: number;
}
export interface AckResponse {
  /** Rows deleted by this call (0 on a repeat). */
  acked: number;
}

/**
 * POST /bridge/v1/connections/:id/outbound. Idempotent on envelope.id. The relay assigns relaySeq and
 * createdAt; only id, kind ('text' | 'brief'), body and links are read. A brief's id is its brief_id.
 */
export interface OutboundRequest {
  envelope: Pick<RelayEnvelope, 'id' | 'kind' | 'body'> & Partial<Pick<RelayEnvelope, 'links' | 'connectionId' | 'direction'>>;
}
export interface OutboundResponse {
  relaySeq: number;
  /** true when the envelope id was already accepted (the original relaySeq is returned). */
  duplicate: boolean;
}

/** DELETE /bridge/v1/connections/:id/outbound/:envelopeId */
export interface WithdrawResponse {
  withdrawn: boolean;
}

/**
 * POST /bridge/v1/connections/:id/revoke. 200 means the connection is revoked AND its mailbox closed: every
 * vendor credential is dead. Idempotent.
 */
export interface RevokeResponse {
  revoked: true;
}
/**
 * The `error` of a 503 from POST /bridge/v1/connections/:id/revoke (with Retry-After): the revocation is
 * recorded and permanent, but the relay could not yet confirm the mailbox closed, so a vendor credential
 * may still work for a short while. The desktop retries revoke until it gets 200.
 */
export const RELAY_REVOKE_PENDING = 'revoke_pending';

/**
 * POST /bridge/v1/connections/:id/repair: bumps the epoch (re-drain from 0), invalidates every vendor
 * credential and mints a new pairing code (and, for relay-http, a new token). Relay-side connection
 * state is re-initialized. The connection must re-pair.
 */
export interface RepairResponse {
  connectionId: string;
  pairingCode: string;
  epoch: number;
  /** Only for relay-http; shown once. */
  token?: string;
}

/** GET /bridge/v1/doorbell (WebSocket upgrade): the only frame; pull is the source of truth. */
export interface RelayDoorbellFrame {
  connectionId: string;
  head: number;
}

// ---- Vendor MCP tools (design 5.4.3) --------------------------------------------------------------

export const RELAY_TOOL_NAMES = [
  'pair',
  'send_message',
  'read_messages',
  'get_brief',
  'ack_brief',
  'report_delivery',
] as const;
export type RelayToolName = (typeof RELAY_TOOL_NAMES)[number];

export interface PairInput {
  /** Accepted and ignored: OAuth already bound the connection when the user entered the code. */
  code?: string;
}
export interface SendMessageInput {
  text: string;
  links?: string[];
}
export interface ReadMessagesInput {
  since_cursor?: string;
}
export interface GetBriefInput {
  brief_id: string;
}
export interface AckBriefInput {
  brief_id: string;
  accepted: boolean;
  note?: string;
}
export interface ReportDeliveryInput {
  pr_url: string;
  summary?: string;
  brief_id?: string;
}

export interface RelayToolInputs {
  pair: PairInput;
  send_message: SendMessageInput;
  read_messages: ReadMessagesInput;
  get_brief: GetBriefInput;
  ack_brief: AckBriefInput;
  report_delivery: ReportDeliveryInput;
}

export interface RelayToolSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

export interface RelayToolDefinition {
  name: RelayToolName;
  description: string;
  inputSchema: RelayToolSchema;
}

/** The only tools a connection can call. Additive changes only within a protocol version. */
export const RELAY_TOOLS: readonly RelayToolDefinition[] = [
  {
    name: 'pair',
    description:
      'Confirm this connection to cyboflow. Call it once after connecting. No code is needed: you entered the pairing code when you authorized this connector.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Optional and ignored (kept for older clients).' } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'send_message',
    description: 'Put a message into the cyboflow thread for this agent. Text and links only.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: MAX_MESSAGE_BYTES },
        links: { type: 'array', items: { type: 'string' } },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_messages',
    description: 'Read messages and briefs sent to this connection. Advances the "Picked up" receipt.',
    inputSchema: {
      type: 'object',
      properties: { since_cursor: { type: 'string', description: 'Cursor returned by the previous call.' } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'get_brief',
    description: 'Fetch one brief by id.',
    inputSchema: {
      type: 'object',
      properties: { brief_id: { type: 'string' } },
      required: ['brief_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'ack_brief',
    description: 'Accept or decline a brief, with an optional note.',
    inputSchema: {
      type: 'object',
      properties: {
        brief_id: { type: 'string' },
        accepted: { type: 'boolean' },
        note: { type: 'string' },
      },
      required: ['brief_id', 'accepted'],
      additionalProperties: false,
    },
  },
  {
    name: 'report_delivery',
    description: 'Report an opened pull request. A hint only: cyboflow re-reads the PR from GitHub.',
    inputSchema: {
      type: 'object',
      properties: {
        pr_url: { type: 'string' },
        summary: { type: 'string' },
        brief_id: { type: 'string' },
      },
      required: ['pr_url'],
      additionalProperties: false,
    },
  },
];

// ---- Vendor HTTP mailbox (instruction-brief vendors, `/c/<connectionId>/*`, bearer `cbh_...`) ----------

/** POST /c/:connectionId/inbox. `id` makes a retry idempotent. A delivery_report needs pr_url. */
export interface MailboxInboxRequest {
  id?: string;
  kind?: 'text' | 'delivery_report';
  text?: string;
  links?: string[];
  pr_url?: string;
  summary?: string;
  brief_id?: string;
}
export interface MailboxInboxResponse {
  id: string;
  relaySeq: number;
  /** true when this id was already accepted (the original relaySeq is returned). */
  duplicate: boolean;
}

/** GET /c/:connectionId/outbox?since_cursor=<cursor>: marks the items picked up. */
export interface MailboxOutboxResponse {
  items: RelayEnvelope[];
  /** Pass back as since_cursor. */
  cursor: string;
}

/** POST /c/:connectionId/outbox/:briefId/ack */
export interface MailboxAckRequest {
  accepted: boolean;
  note?: string;
}
export interface MailboxAckResponse {
  briefId: string;
  event: 'acked' | 'declined';
  duplicate: boolean;
}
