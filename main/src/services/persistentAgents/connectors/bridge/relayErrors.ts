/**
 * Relay error model: RelayHttpError (one per failed relay request, with a classified `kind`),
 * classifyRelayResponse (HTTP status + relay error code → kind + retry delay), and toConnectorError
 * (kind → the core's ConnectorError).
 *
 * MESSAGE HYGIENE: every message here is fixed text plus the HTTP status and the relay's error code.
 * Response bodies, parse errors, URLs and headers never reach a message, a cause or `details`.
 */
import { computeBackoffMs, parseRetryAfter } from '../../../cloud/backoff';
import { ConnectorError } from '../../connectorErrors';
import { BRIDGE_COPY, isBridgeCopyKey } from './copy';
import {
  BACKOFF_RATE_LIMITED,
  BACKOFF_RELAY_DISABLED,
  BACKOFF_TRANSIENT,
  BACKOFF_UNAVAILABLE,
  clampRetryAfterMs,
  REVOKE_DEFAULT_RETRY_MS,
  type BackoffPolicy,
} from './constants';
import type { BridgeOp } from './types';

export type RelayErrorKind =
  | 'signed_out' | 'paused'
  | 'network' | 'server_error' | 'bad_response'
  | 'update_required' | 'unauthorized' | 'device_revoked' | 'not_entitled'
  | 'not_found' | 'connection_revoked' | 'connection_limit' | 'connection_init_failed'
  | 'stale_epoch' | 'ack_beyond_served'
  | 'rate_limited' | 'unavailable' | 'revoke_pending'
  | 'invalid_request' | 'too_large' | 'unexpected';

/** Only the numeric/enum facts of a relay error body the desktop needs; never the raw body. */
export interface RelayErrorDetails {
  epoch?: number;
  maxServed?: number;
  max?: number;
  min?: number;
  field?: string;
}

/** Which default back-off class a failure counts against. */
export type BackoffClass = 'rate_limited' | 'unavailable' | 'relay_disabled' | 'transient';

const BACKOFF_POLICIES: Record<BackoffClass, BackoffPolicy> = {
  rate_limited: BACKOFF_RATE_LIMITED,
  unavailable: BACKOFF_UNAVAILABLE,
  relay_disabled: BACKOFF_RELAY_DISABLED,
  transient: BACKOFF_TRANSIENT,
};

const RETRYABLE_KINDS: ReadonlySet<RelayErrorKind> = new Set<RelayErrorKind>([
  'network', 'server_error', 'bad_response', 'rate_limited', 'unavailable', 'revoke_pending',
  'connection_init_failed',
]);

export interface RelayHttpErrorInit {
  /** 0 = no HTTP response. */
  status: number;
  /** Relay `error` code (sanitised) or a local code. */
  code: string;
  kind: RelayErrorKind;
  details?: RelayErrorDetails;
  retryAfterMs?: number | null;
  protocolRange?: { min: number; max: number } | null;
  /** false when no request was written to the network (gate, budget, validation). */
  sent?: boolean;
}

export class RelayHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly kind: RelayErrorKind;
  readonly details: RelayErrorDetails;
  readonly retryAfterMs: number | null;
  readonly protocolRange: { min: number; max: number } | null;
  readonly sent: boolean;

  constructor(init: RelayHttpErrorInit) {
    super(init.status > 0
      ? `Bridge relay request failed (${init.status} ${init.code})`
      : `Bridge relay request not completed (${init.code})`);
    this.name = 'RelayHttpError';
    this.status = init.status;
    this.code = init.code;
    this.kind = init.kind;
    this.details = init.details ?? {};
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.protocolRange = init.protocolRange ?? null;
    this.sent = init.sent ?? init.status > 0;
  }

  get retryable(): boolean {
    return RETRYABLE_KINDS.has(this.kind);
  }
}

export function isRelayHttpError(e: unknown): e is RelayHttpError {
  return e instanceof RelayHttpError;
}

/** Relay error codes are short lowercase snake_case words. */
const CODE_RE = /^[a-z][a-z_]{0,47}$/;
/** Never let anything shaped like a cyboflow token through as a "code". */
const TOKEN_PREFIX_RE = /^cb[a-z]_/;

function isSafeCode(v: unknown): v is string {
  return typeof v === 'string' && CODE_RE.test(v) && !TOKEN_PREFIX_RE.test(v);
}

/** body.error when it is a safe short identifier, else http_<status>. */
export function relayErrorCode(status: number, body: unknown): string {
  if (body !== null && typeof body === 'object') {
    const err = (body as { error?: unknown }).error;
    if (isSafeCode(err)) return err;
  }
  return `http_${status}`;
}

function safeInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

export function parseRelayErrorDetails(body: unknown): RelayErrorDetails {
  if (body === null || typeof body !== 'object') return {};
  const raw = (body as { details?: unknown }).details;
  if (raw === null || typeof raw !== 'object') return {};
  const d = raw as Record<string, unknown>;
  const out: RelayErrorDetails = {};
  const epoch = safeInt(d.epoch);
  if (epoch !== undefined) out.epoch = epoch;
  const maxServed = safeInt(d.maxServed);
  if (maxServed !== undefined) out.maxServed = maxServed;
  const max = safeInt(d.max);
  if (max !== undefined) out.max = max;
  const min = safeInt(d.min);
  if (min !== undefined) out.min = min;
  if (isSafeCode(d.field)) out.field = d.field;
  return out;
}

export interface ClassifyInput {
  status: number;
  body: unknown;
  headers: Headers;
  nowMs: number;
  random: () => number;
  /** Consecutive failures already counted for a back-off class (0-based attempt for the next delay). */
  attemptFor: (c: BackoffClass) => number;
}

export interface ClassifiedFailure {
  error: RelayHttpError;
  /** The back-off class whose counter this failure advances (null = none). */
  backoffClass: BackoffClass | null;
}

function defaultDelay(input: ClassifyInput, c: BackoffClass): number {
  const p = BACKOFF_POLICIES[c];
  return Math.round(computeBackoffMs({ attempt: input.attemptFor(c), baseMs: p.baseMs, capMs: p.capMs, random: input.random }));
}

function headerRetryAfter(input: ClassifyInput): number | null {
  const ms = parseRetryAfter(input.headers.get('Retry-After'), input.nowMs);
  return ms === undefined ? null : clampRetryAfterMs(ms);
}

function protocolRangeOf(input: ClassifyInput, details: RelayErrorDetails): { min: number; max: number } {
  if (details.min !== undefined && details.max !== undefined) return { min: details.min, max: details.max };
  const hMin = Number(input.headers.get('Cyboflow-Relay-Protocol-Min'));
  const hMax = Number(input.headers.get('Cyboflow-Relay-Protocol-Max'));
  if (Number.isSafeInteger(hMin) && Number.isSafeInteger(hMax) && hMin > 0 && hMax > 0) return { min: hMin, max: hMax };
  return { min: 1, max: 1 };
}

/** A non-2xx relay response → RelayHttpError (+ which default back-off counter it advances). */
export function classifyRelayResponse(input: ClassifyInput): ClassifiedFailure {
  const { status, body } = input;
  const code = relayErrorCode(status, body);
  const details = parseRelayErrorDetails(body);
  const mk = (kind: RelayErrorKind, extra: Partial<RelayHttpErrorInit> = {}): RelayHttpError =>
    new RelayHttpError({ status, code, kind, details, ...extra });

  if (status === 400) {
    return { error: mk(code === 'invalid_request' ? 'invalid_request' : 'unexpected'), backoffClass: null };
  }
  if (status === 401) {
    return { error: mk(code === 'device_revoked' ? 'device_revoked' : 'unauthorized'), backoffClass: null };
  }
  if (status === 403) {
    return { error: mk(code === 'not_entitled' ? 'not_entitled' : 'unexpected'), backoffClass: null };
  }
  if (status === 404) return { error: mk('not_found'), backoffClass: null };
  if (status === 409) {
    switch (code) {
      case 'connection_revoked': return { error: mk('connection_revoked'), backoffClass: null };
      case 'connection_limit': return { error: mk('connection_limit'), backoffClass: null };
      case 'stale_epoch': return { error: mk('stale_epoch'), backoffClass: null };
      case 'ack_beyond_served': return { error: mk('ack_beyond_served'), backoffClass: null };
      default: return { error: mk('unexpected'), backoffClass: null };
    }
  }
  if (status === 413) return { error: mk('too_large'), backoffClass: null };
  if (status === 426) {
    return { error: mk('update_required', { protocolRange: protocolRangeOf(input, details) }), backoffClass: null };
  }
  if (status === 429) {
    const header = headerRetryAfter(input);
    if (header !== null) return { error: mk('rate_limited', { retryAfterMs: header }), backoffClass: 'rate_limited' };
    return { error: mk('rate_limited', { retryAfterMs: defaultDelay(input, 'rate_limited') }), backoffClass: 'rate_limited' };
  }
  if (status === 503) {
    const header = headerRetryAfter(input);
    switch (code) {
      case 'revoke_pending':
        return { error: mk('revoke_pending', { retryAfterMs: header ?? REVOKE_DEFAULT_RETRY_MS }), backoffClass: null };
      case 'connection_init_failed':
        return { error: mk('connection_init_failed', { retryAfterMs: 0 }), backoffClass: null };
      case 'relay_disabled':
        return {
          error: mk('unavailable', { retryAfterMs: header ?? defaultDelay(input, 'relay_disabled') }),
          backoffClass: 'relay_disabled',
        };
      case 'misconfigured':
        return {
          error: mk('unavailable', { retryAfterMs: defaultDelay(input, 'relay_disabled') }),
          backoffClass: 'relay_disabled',
        };
      default:
        return {
          error: mk('unavailable', { retryAfterMs: header ?? defaultDelay(input, 'unavailable') }),
          backoffClass: 'unavailable',
        };
    }
  }
  if (status >= 500) {
    return { error: mk('server_error', { retryAfterMs: defaultDelay(input, 'transient') }), backoffClass: 'transient' };
  }
  return { error: mk('unexpected'), backoffClass: null };
}

function sanitizeCodePart(s: string): string {
  const cleaned = s.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40);
  return cleaned === '' ? 'unknown' : cleaned;
}

function isSendLike(op: BridgeOp): boolean {
  return op === 'send' || op === 'reconcile';
}

/** RelayHttpError (or anything) → the core's ConnectorError. Never copies a foreign error's message. */
export function toConnectorError(e: unknown, op: BridgeOp): ConnectorError {
  if (e instanceof ConnectorError) return e;
  if (!(e instanceof RelayHttpError)) {
    return new ConnectorError('retryable', `Unexpected Bridge ${op} failure`, {
      code: 'unexpected', maybeDelivered: isSendLike(op),
    });
  }
  const httpStatus = e.status > 0 ? e.status : null;
  const base = `Bridge ${op} failed`;
  const msg = httpStatus !== null ? `${base} (${httpStatus} ${e.code})` : `${base} (${e.code})`;
  switch (e.kind) {
    case 'signed_out':
      return new ConnectorError('paused', BRIDGE_COPY.signed_out, { code: 'signed_out' });
    case 'paused': {
      // A gate refusal carries the same code and copy as the availability refusal it raced with; a
      // stopped runtime reads as turned off, exactly like availability() reports it.
      const code = e.code === 'stopped' ? 'disabled' : e.code;
      return new ConnectorError('paused', isBridgeCopyKey(code) ? BRIDGE_COPY[code] : msg, { code });
    }
    case 'device_revoked':
    case 'unauthorized':
      return new ConnectorError('device_auth', msg, { httpStatus, code: 'needs_sign_in' });
    case 'not_entitled':
      return new ConnectorError('not_entitled', msg, { httpStatus, code: 'not_entitled' });
    case 'update_required':
      return new ConnectorError('upgrade_required', msg, { httpStatus, code: 'needs_update' });
    case 'rate_limited':
      return new ConnectorError('rate_limited', msg, { httpStatus, code: 'rate_limited', retryAfterMs: e.retryAfterMs });
    case 'network':
      return new ConnectorError('retryable', msg, {
        httpStatus, code: e.code, retryAfterMs: e.retryAfterMs, maybeDelivered: isSendLike(op) && e.sent,
      });
    case 'server_error':
    case 'bad_response':
      return new ConnectorError('retryable', msg, {
        httpStatus, code: e.kind, retryAfterMs: e.retryAfterMs, maybeDelivered: isSendLike(op) && e.sent,
      });
    case 'unavailable':
    case 'revoke_pending':
    case 'connection_init_failed':
      return new ConnectorError('retryable', msg, { httpStatus, code: e.kind, retryAfterMs: e.retryAfterMs });
    case 'not_found':
      return new ConnectorError('not_found', msg, { httpStatus, code: 'relay_not_found' });
    case 'connection_revoked':
      return new ConnectorError('revoked', msg, { httpStatus, code: 'relay_revoked' });
    case 'connection_limit':
      return new ConnectorError('conflict', BRIDGE_COPY.connection_limit, { httpStatus, code: 'connection_limit' });
    case 'too_large':
      return new ConnectorError('invalid', msg, { httpStatus, code: 'message_too_large' });
    case 'invalid_request':
      return new ConnectorError('invalid', msg, { httpStatus, code: 'invalid_request' });
    case 'stale_epoch':
    case 'ack_beyond_served':
    case 'unexpected':
    default:
      return new ConnectorError('permanent', msg, {
        httpStatus, code: `relay_${e.status}_${sanitizeCodePart(e.code)}`,
      });
  }
}
