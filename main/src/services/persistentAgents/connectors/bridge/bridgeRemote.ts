/**
 * The non-secret per-connection record the Bridge keeps in remote_json, its cursor format, and the
 * sanitisers applied to relay-reported (vendor-declared) pairing facts before they are stored.
 * Never stored here: pairing codes, relay-http tokens, instruction briefs, the device token.
 */
import type { PairedClient, RelayTransport } from '../../../../../../shared/types/relayProtocol';
import type { CloudDevice } from '../../../cloud/cloudAccountHandle';
import { BRIDGE_LABEL_MAX, RELAY_CONNECTION_ID_RE } from './constants';

export interface BridgeRemoteV1 {
  v: 1;
  /** Cloud origin at connect time. */
  origin: string;
  /** Cloud accountId at connect time. */
  accountId: string;
  relayConnectionId: string;
  transport: RelayTransport;
  /** What was sent to the relay as the connection label. */
  label: string | null;
  /** From the relay response, never built client-side. */
  mcpUrl: string;
  httpBase: string;
  /** ISO, local clock: when the current pairing code / token was issued. */
  pairingIssuedAt: string | null;
  /** From GET /connections; name already sanitised. */
  pairedClient: PairedClient | null;
  /** First relay pair note (createdAt). */
  pairCalledAt: string | null;
  /** First agent-authored inbound (createdAt). */
  firstInboundAt: string | null;
  /** First picked_up receipt (`at`). */
  firstPickupAt: string | null;
  relayState: 'active' | 'revoked';
}

function isTransport(v: unknown): v is RelayTransport {
  return v === 'relay-mcp' || v === 'relay-http';
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** A stored pairedClient (already sanitised when written); anything malformed reads as null. */
function readPairedClient(v: unknown): PairedClient | null {
  if (v === null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.redirectHost !== 'string' || typeof o.pairedAt !== 'number') return null;
  if (o.name !== null && typeof o.name !== 'string') return null;
  return { name: o.name, redirectHost: o.redirectHost, pairedAt: o.pairedAt };
}

/** remote_json → BridgeRemoteV1, or null when it is not a valid v1 Bridge record. */
export function parseBridgeRemote(raw: unknown): BridgeRemoteV1 | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (typeof o.origin !== 'string' || o.origin === '') return null;
  if (typeof o.accountId !== 'string' || o.accountId === '') return null;
  if (typeof o.relayConnectionId !== 'string' || !RELAY_CONNECTION_ID_RE.test(o.relayConnectionId)) return null;
  if (!isTransport(o.transport)) return null;
  if (typeof o.mcpUrl !== 'string' || typeof o.httpBase !== 'string') return null;
  return {
    v: 1,
    origin: o.origin,
    accountId: o.accountId,
    relayConnectionId: o.relayConnectionId,
    transport: o.transport,
    label: strOrNull(o.label),
    mcpUrl: o.mcpUrl,
    httpBase: o.httpBase,
    pairingIssuedAt: strOrNull(o.pairingIssuedAt),
    pairedClient: readPairedClient(o.pairedClient),
    pairCalledAt: strOrNull(o.pairCalledAt),
    firstInboundAt: strOrNull(o.firstInboundAt),
    firstPickupAt: strOrNull(o.firstPickupAt),
    relayState: o.relayState === 'revoked' ? 'revoked' : 'active',
  };
}

/** The connection belongs to the currently signed-in account on the same origin. */
export function bridgeRemoteMatchesAccount(r: BridgeRemoteV1, dev: CloudDevice | null): boolean {
  return dev !== null && r.origin === dev.origin && r.accountId === dev.accountId;
}

// ---- Cursor ------------------------------------------------------------------------------------------

export const BRIDGE_CURSOR_PREFIX = 'bridge:v1:';
export interface BridgeCursor { epoch: number; seq: number }

export function encodeBridgeCursor(c: BridgeCursor): string {
  return `${BRIDGE_CURSOR_PREFIX}${c.epoch}:${c.seq}`;
}

/** null → 0:0; malformed → 0:0 + malformed:true. */
export function parseBridgeCursor(raw: string | null): { cursor: BridgeCursor; malformed: boolean } {
  if (raw === null) return { cursor: { epoch: 0, seq: 0 }, malformed: false };
  const m = /^bridge:v1:(\d{1,15}):(\d{1,15})$/.exec(raw);
  if (!m) return { cursor: { epoch: 0, seq: 0 }, malformed: true };
  const epoch = Number(m[1]);
  const seq = Number(m[2]);
  if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(seq)) return { cursor: { epoch: 0, seq: 0 }, malformed: true };
  return { cursor: { epoch, seq }, malformed: false };
}

// ---- Ack token ---------------------------------------------------------------------------------------

export const BRIDGE_ACK_PREFIX = 'bridge-ack:v1:';
export interface BridgeAckToken { epoch: number; upTo: number }

export function encodeAckToken(t: BridgeAckToken): string {
  return `${BRIDGE_ACK_PREFIX}${t.epoch}:${t.upTo}`;
}

export function parseAckToken(raw: unknown): BridgeAckToken | null {
  if (typeof raw !== 'string') return null;
  const m = /^bridge-ack:v1:(\d{1,15}):(\d{1,15})$/.exec(raw);
  if (!m) return null;
  const epoch = Number(m[1]);
  const upTo = Number(m[2]);
  if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(upTo) || upTo <= 0) return null;
  return { epoch, upTo };
}

// ---- Sanitisers --------------------------------------------------------------------------------------

/** C0/C1 controls, zero-width characters, bidi embeddings/overrides/isolates, BOM. */
// eslint-disable-next-line no-control-regex
const CLIENT_NAME_STRIP_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** Vendor-declared client name → safe display text (≤ 100 chars) or null. */
export function sanitizeClientName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(CLIENT_NAME_STRIP_RE, '').trim().slice(0, 100);
  return cleaned === '' ? null : cleaned;
}

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function isValidRedirectHost(h: unknown): h is string {
  if (typeof h !== 'string' || h.length > 253) return false;
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return true;
  return HOST_RE.test(h);
}

/**
 * Relay-reported pairedClient → a storable value. `{ok:true, value:null}` when absent;
 * `{ok:false}` when the redirect host is invalid (the patch must be dropped).
 */
export function sanitizePairedClient(raw: unknown): { ok: true; value: PairedClient | null } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'object') return { ok: false };
  const o = raw as Record<string, unknown>;
  if (!isValidRedirectHost(o.redirectHost)) return { ok: false };
  const pairedAt = typeof o.pairedAt === 'number' && Number.isFinite(o.pairedAt) ? o.pairedAt : 0;
  return { ok: true, value: { name: sanitizeClientName(o.name), redirectHost: o.redirectHost, pairedAt } };
}

export function samePairedClient(a: PairedClient | null, b: PairedClient | null): boolean {
  if (a === null || b === null) return a === b;
  return a.name === b.name && a.redirectHost === b.redirectHost && a.pairedAt === b.pairedAt;
}

// eslint-disable-next-line no-control-regex
const LABEL_STRIP_RE = /[\u0000-\u001f\u007f]/g;

/** Relay connection label: control characters stripped, trimmed, ≤ 100 chars; '' → null (omitted). */
export function sanitizeLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(LABEL_STRIP_RE, '').trim().slice(0, BRIDGE_LABEL_MAX).trim();
  return cleaned === '' ? null : cleaned;
}
