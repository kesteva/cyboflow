/**
 * Typed HTTP client for the relay's desktop API (`<cloud origin>/bridge/v1/*`).
 *
 * Every request: gate (no network when paused) → device + token (never cached here) → safe origin →
 * request budget → fetch with one AbortSignal (caller deadline + per-request timeout + runtime stop) →
 * size cap → JSON → classify. The device token is only ever sent to the signed-in device's origin, with
 * `redirect: 'error'` so a redirect cannot carry it elsewhere.
 */
import {
  MAX_INBOUND_PAGE,
  RELAY_PROTOCOL_HEADER,
  RELAY_PROTOCOL_VERSION,
  type AckRequest,
  type AckResponse,
  type CreateConnectionRequest,
  type CreateConnectionResponse,
  type InboundPage,
  type ListConnectionsResponse,
  type OutboundRequest,
  type OutboundResponse,
  type RepairResponse,
  type RevokeResponse,
  type WithdrawResponse,
} from '../../../../../../shared/types/relayProtocol';
import type { LoggerLike } from '../../../../orchestrator/types';
import { computeBackoffMs } from '../../../cloud/backoff';
import type { CloudAccountHandle } from '../../../cloud/cloudAccountHandle';
import type { FetchLike } from '../../../cloud/fetchLike';
import {
  BACKOFF_TRANSIENT,
  CAPTURE_THROTTLE_MS,
  RELAY_BASE_PATH,
  RELAY_BUDGET_MAX_WAIT_MS,
  RELAY_CONNECTION_ID_RE,
  RELAY_MAX_RESPONSE_BYTES,
  RELAY_REQUEST_TIMEOUT_MS,
} from './constants';
import {
  classifyRelayResponse,
  RelayHttpError,
  type BackoffClass,
  type RelayErrorKind,
} from './relayErrors';
import { BudgetAbortError, BudgetWaitTimeoutError, type BudgetPriority, type RequestBudget } from './requestBudget';
import type { BridgeSeam, CaptureSeamErrorFn } from './types';

export interface RelayClientHooks {
  /** Before every request: may refuse (paused) without network. `probe` requests bypass a relay-level pause. */
  gate(kind: 'normal' | 'probe'): { ok: true } | { ok: false; error: RelayHttpError };
  onSuccess(): void;
  onUpdateRequired(min: number, max: number): void;
  onUnauthorized(code: 'device_revoked' | 'unauthorized', requestDeviceId: string): void;
  onNotEntitled(): void;
  onTransientFailure(kind: RelayErrorKind, retryAfterMs: number): void;
}

export interface RelayClientOptions {
  cloud: Pick<CloudAccountHandle, 'getDevice' | 'getToken'>;
  fetch: FetchLike;
  appVersion: string;
  hooks: RelayClientHooks;
  logger: LoggerLike;
  /** Read per request so a restarted runtime's fresh budget is used. */
  budget: () => RequestBudget;
  /** Read per request; aborted by the runtime's stop(). */
  abortSignal: () => AbortSignal;
  captureSeamError?: CaptureSeamErrorFn;
  now?: () => number;
  random?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface RelayCallOptions {
  signal?: AbortSignal;
  probe?: boolean;
}

// ---- Response guards (required fields only; unknown fields ignored) -------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

export function isInboundPage(v: unknown): v is InboundPage {
  if (!isObj(v) || !isNonNegInt(v.epoch) || !isNonNegInt(v.head) || !Array.isArray(v.items)) return false;
  if (v.gap !== undefined && v.gap !== null && !isObj(v.gap)) return false;
  return true;
}
export function isAckResponse(v: unknown): v is AckResponse {
  return isObj(v) && isNonNegInt(v.acked);
}
export function isOutboundResponse(v: unknown): v is OutboundResponse {
  return isObj(v) && isNonNegInt(v.relaySeq) && typeof v.duplicate === 'boolean';
}
export function isCreateConnectionResponse(v: unknown): v is CreateConnectionResponse {
  return isObj(v)
    && typeof v.connectionId === 'string' && RELAY_CONNECTION_ID_RE.test(v.connectionId)
    && typeof v.pairingCode === 'string'
    && typeof v.mcpUrl === 'string' && typeof v.httpBase === 'string'
    && (v.token === undefined || typeof v.token === 'string');
}
export function isListConnectionsResponse(v: unknown): v is ListConnectionsResponse {
  if (!isObj(v) || !Array.isArray(v.connections)) return false;
  return v.connections.every((c) => isObj(c) && typeof c.id === 'string' && (c.state === 'active' || c.state === 'revoked'));
}
export function isRepairResponse(v: unknown): v is RepairResponse {
  return isObj(v) && typeof v.connectionId === 'string' && typeof v.pairingCode === 'string'
    && isNonNegInt(v.epoch) && (v.token === undefined || typeof v.token === 'string');
}
export function isRevokeResponse(v: unknown): v is RevokeResponse {
  return isObj(v) && v.revoked === true;
}
export function isWithdrawResponse(v: unknown): v is WithdrawResponse {
  return isObj(v) && typeof v.withdrawn === 'boolean';
}

// ---- Helpers ----------------------------------------------------------------------------------------

const NEVER_ABORTS: AbortSignal = new AbortController().signal;
const QUERY_INT_MAX = 999_999_999_999_999;

function errorName(err: unknown): string {
  return err !== null && typeof err === 'object' && typeof (err as { name?: unknown }).name === 'string'
    ? (err as { name: string }).name
    : '';
}

class AbortRace extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

/** Resolve/reject with `p`, or reject as soon as `signal` aborts (even if `p` ignores the signal). */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(new AbortRace());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new AbortRace());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/** https:, or http: on a loopback host (local relay dev). */
export function isSafeRelayOrigin(origin: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.username !== '' || u.password !== '') return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]');
}

function seamForRoute(route: string): BridgeSeam {
  if (route.includes('/inbound') || route.endsWith('/ack')) return 'relay-drain';
  if (route.includes('/outbound')) return 'connector-send';
  return 'connector-verify';
}

interface RequestSpec<T> {
  method: 'GET' | 'POST' | 'DELETE';
  /** Template, e.g. /connections/:id/inbound — the only route form that is ever logged. */
  route: string;
  path: string;
  relayId?: string;
  body?: unknown;
  priority: BudgetPriority;
  validate: (v: unknown) => v is T;
  opts?: RelayCallOptions;
}

export class RelayClient {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly failureCounts = new Map<BackoffClass, number>();
  private readonly captureLast = new Map<string, number>();

  constructor(private readonly opts: RelayClientOptions) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.timeoutMs = opts.timeoutMs ?? RELAY_REQUEST_TIMEOUT_MS;
    this.maxResponseBytes = opts.maxResponseBytes ?? RELAY_MAX_RESPONSE_BYTES;
  }

  /** Device identity the NEXT request would use; null when signed out. Never reads the token. */
  identity(): { origin: string; deviceId: string; accountId: string } | null {
    const d = this.opts.cloud.getDevice();
    return d ? { origin: d.origin, deviceId: d.deviceId, accountId: d.accountId } : null;
  }

  async createConnection(req: CreateConnectionRequest, opts?: RelayCallOptions): Promise<CreateConnectionResponse> {
    const r = await this.request({
      method: 'POST', route: '/connections', path: '/connections', body: req, priority: 'high',
      validate: isCreateConnectionResponse, opts,
    });
    return r.data;
  }

  async listConnections(opts?: RelayCallOptions): Promise<ListConnectionsResponse> {
    const r = await this.request({
      method: 'GET', route: '/connections', path: '/connections', priority: 'normal',
      validate: isListConnectionsResponse, opts,
    });
    return r.data;
  }

  async pullInbound(
    relayId: string,
    q: { epoch: number; after: number; limit?: number },
    opts?: RelayCallOptions,
  ): Promise<InboundPage> {
    const id = this.idSegment(relayId);
    const limit = q.limit ?? MAX_INBOUND_PAGE;
    for (const n of [q.epoch, q.after, limit]) {
      if (!Number.isSafeInteger(n) || n < 0 || n > QUERY_INT_MAX) {
        throw new RelayHttpError({ status: 0, code: 'invalid_query', kind: 'invalid_request', sent: false });
      }
    }
    const r = await this.request({
      method: 'GET', route: '/connections/:id/inbound', relayId,
      path: `/connections/${id}/inbound?epoch=${q.epoch}&after=${q.after}&limit=${limit}`,
      priority: 'normal', validate: isInboundPage, opts,
    });
    return r.data;
  }

  async ack(relayId: string, req: AckRequest, opts?: RelayCallOptions): Promise<AckResponse> {
    const id = this.idSegment(relayId);
    const r = await this.request({
      method: 'POST', route: '/connections/:id/ack', relayId, path: `/connections/${id}/ack`,
      body: { epoch: req.epoch, upTo: req.upTo }, priority: 'high', validate: isAckResponse, opts,
    });
    return r.data;
  }

  async postOutbound(
    relayId: string,
    req: OutboundRequest,
    opts?: RelayCallOptions,
  ): Promise<OutboundResponse & { status: 200 | 201 }> {
    const id = this.idSegment(relayId);
    const r = await this.request({
      method: 'POST', route: '/connections/:id/outbound', relayId, path: `/connections/${id}/outbound`,
      body: req, priority: 'high', validate: isOutboundResponse, opts,
    });
    return { relaySeq: r.data.relaySeq, duplicate: r.data.duplicate, status: r.status === 201 ? 201 : 200 };
  }

  async withdrawOutbound(relayId: string, envelopeId: string, opts?: RelayCallOptions): Promise<WithdrawResponse> {
    const id = this.idSegment(relayId);
    const r = await this.request({
      method: 'DELETE', route: '/connections/:id/outbound/:envelopeId', relayId,
      path: `/connections/${id}/outbound/${encodeURIComponent(envelopeId)}`, priority: 'high',
      validate: isWithdrawResponse, opts,
    });
    return r.data;
  }

  async revoke(relayId: string, opts?: RelayCallOptions): Promise<RevokeResponse> {
    const id = this.idSegment(relayId);
    const r = await this.request({
      method: 'POST', route: '/connections/:id/revoke', relayId, path: `/connections/${id}/revoke`,
      priority: 'high', validate: isRevokeResponse, opts,
    });
    return r.data;
  }

  async repair(relayId: string, opts?: RelayCallOptions): Promise<RepairResponse> {
    const id = this.idSegment(relayId);
    const r = await this.request({
      method: 'POST', route: '/connections/:id/repair', relayId, path: `/connections/${id}/repair`,
      priority: 'high', validate: isRepairResponse, opts,
    });
    return r.data;
  }

  // ---- internals -------------------------------------------------------------------------------

  private idSegment(relayId: string): string {
    if (typeof relayId !== 'string' || !RELAY_CONNECTION_ID_RE.test(relayId)) {
      throw new RelayHttpError({ status: 0, code: 'invalid_connection_id', kind: 'invalid_request', sent: false });
    }
    return encodeURIComponent(relayId);
  }

  private capture(e: RelayHttpError, route: string): void {
    const report = this.opts.captureSeamError;
    if (!report) return;
    const seam = seamForRoute(route);
    const key = `${seam}:${e.code}`;
    const t = this.now();
    const last = this.captureLast.get(key);
    if (last !== undefined && t - last < CAPTURE_THROTTLE_MS) return;
    this.captureLast.set(key, t);
    report(seam, e, {
      connectorId: 'bridge', relayKind: e.kind, relayCode: e.code.slice(0, 64), httpStatus: String(e.status),
    });
  }

  private nextAttempt(c: BackoffClass): number {
    return this.failureCounts.get(c) ?? 0;
  }

  private bumpAttempt(c: BackoffClass | null): void {
    if (c === null) return;
    this.failureCounts.set(c, (this.failureCounts.get(c) ?? 0) + 1);
  }

  private transientDelay(): number {
    const attempt = this.nextAttempt('transient');
    return Math.round(computeBackoffMs({
      attempt, baseMs: BACKOFF_TRANSIENT.baseMs, capMs: BACKOFF_TRANSIENT.capMs, random: this.random,
    }));
  }

  private log(spec: RequestSpec<unknown>, startedAt: number, status: number | 'none', kind?: RelayErrorKind): void {
    this.opts.logger.debug('[bridge] http', {
      method: spec.method,
      route: spec.route,
      relay: spec.relayId?.slice(0, 10),
      status,
      ms: this.now() - startedAt,
      ...(kind ? { kind } : {}),
    });
  }

  private async request<T>(spec: RequestSpec<T>): Promise<{ status: number; data: T }> {
    const { hooks, cloud } = this.opts;
    const callerSignal = spec.opts?.signal;

    // 1. gate (no network)
    const g = hooks.gate(spec.opts?.probe ? 'probe' : 'normal');
    if (!g.ok) throw g.error;

    // 2. device + token (read per request; never cached)
    const dev = cloud.getDevice();
    const tok = dev ? cloud.getToken() : null;
    if (!dev || !tok) throw new RelayHttpError({ status: 0, code: 'signed_out', kind: 'signed_out', sent: false });
    const requestDeviceId = dev.deviceId;

    // 3. origin
    if (!isSafeRelayOrigin(dev.origin)) {
      const e = new RelayHttpError({ status: 0, code: 'unsafe_origin', kind: 'invalid_request', sent: false });
      this.capture(e, spec.route);
      throw e;
    }
    const url = `${dev.origin.replace(/\/+$/, '')}${RELAY_BASE_PATH}${spec.path}`;

    // 4. one signal for the budget wait AND the fetch
    const runtimeSignal = this.opts.abortSignal();
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([callerSignal ?? NEVER_ABORTS, timeoutSignal, runtimeSignal]);
    const startedAt = this.now();
    const abortCode = (): 'aborted' | 'timeout' => (runtimeSignal.aborted ? 'aborted' : 'timeout');

    try {
      await this.opts.budget().acquire(spec.priority, RELAY_BUDGET_MAX_WAIT_MS, signal);
    } catch (err) {
      if (err instanceof BudgetWaitTimeoutError) {
        throw new RelayHttpError({
          status: 0, code: 'local_budget', kind: 'rate_limited', sent: false,
          retryAfterMs: Math.max(1, this.opts.budget().msUntilToken()),
        });
      }
      if (err instanceof BudgetAbortError && err.cause_ === 'disposed') {
        throw new RelayHttpError({ status: 0, code: 'aborted', kind: 'network', sent: false });
      }
      throw new RelayHttpError({ status: 0, code: abortCode(), kind: 'network', sent: false });
    }
    if (signal.aborted) throw new RelayHttpError({ status: 0, code: abortCode(), kind: 'network', sent: false });

    // 5. headers
    const headers: Record<string, string> = {
      Authorization: `Bearer ${tok}`,
      [RELAY_PROTOCOL_HEADER]: String(RELAY_PROTOCOL_VERSION),
      'Cyboflow-App-Version': this.opts.appVersion,
      Accept: 'application/json',
    };
    if (spec.body !== undefined) headers['Content-Type'] = 'application/json';

    // 6. fetch
    let res: Response;
    let text: string;
    try {
      res = await raceAbort(this.opts.fetch(url, {
        method: spec.method,
        headers,
        ...(spec.body !== undefined ? { body: JSON.stringify(spec.body) } : {}),
        redirect: 'error',
        cache: 'no-store',
        signal,
      }), signal);
      // 7. size cap
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > this.maxResponseBytes) {
        res.body?.cancel().catch(() => undefined);
        throw this.badResponse(spec, startedAt, res.status, 'response_too_large');
      }
      text = await raceAbort(res.text(), signal);
    } catch (err) {
      if (err instanceof RelayHttpError) throw err;
      let code: 'network' | 'timeout' | 'aborted';
      if (runtimeSignal.aborted) code = 'aborted';
      else if (callerSignal?.aborted) code = 'timeout';
      else if (timeoutSignal.aborted || errorName(err) === 'TimeoutError') code = 'timeout';
      else code = 'network';
      const ownFailure = !runtimeSignal.aborted && !callerSignal?.aborted;
      const retryAfterMs = this.transientDelay();
      if (ownFailure) {
        this.bumpAttempt('transient');
        hooks.onTransientFailure('network', retryAfterMs);
      }
      this.log(spec, startedAt, 'none', 'network');
      throw new RelayHttpError({ status: 0, code, kind: 'network', sent: true, retryAfterMs });
    }
    if (Buffer.byteLength(text, 'utf8') > this.maxResponseBytes) {
      throw this.badResponse(spec, startedAt, res.status, 'response_too_large');
    }

    // 8. parse
    let parsed: unknown;
    let parseFailed = false;
    if (text.trim() !== '') {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parseFailed = true;
      }
    }

    // 9. failure
    if (!res.ok) {
      const { error, backoffClass } = classifyRelayResponse({
        status: res.status, body: parseFailed ? undefined : parsed, headers: res.headers, nowMs: this.now(),
        random: this.random, attemptFor: (c) => this.nextAttempt(c),
      });
      this.bumpAttempt(backoffClass);
      this.applySideEffects(error, requestDeviceId);
      if (error.kind === 'unexpected' || error.kind === 'invalid_request' || error.code === 'misconfigured'
        || (error.kind === 'not_found' && spec.route === '/connections')) {
        this.capture(error, spec.route);
      }
      this.log(spec, startedAt, res.status, error.kind);
      throw error;
    }

    // 10. success
    if (parseFailed) throw this.badResponse(spec, startedAt, res.status, 'invalid_json');
    if (!spec.validate(parsed)) throw this.badResponse(spec, startedAt, res.status, 'invalid_shape');
    this.failureCounts.clear();
    hooks.onSuccess();
    this.log(spec, startedAt, res.status);
    return { status: res.status, data: parsed };
  }

  private badResponse(spec: RequestSpec<unknown>, startedAt: number, status: number, code: string): RelayHttpError {
    const retryAfterMs = this.transientDelay();
    this.bumpAttempt('transient');
    const e = new RelayHttpError({ status, code, kind: 'bad_response', sent: true, retryAfterMs });
    this.opts.hooks.onTransientFailure('bad_response', retryAfterMs);
    this.capture(e, spec.route);
    this.log(spec, startedAt, status, 'bad_response');
    return e;
  }

  private applySideEffects(e: RelayHttpError, requestDeviceId: string): void {
    const { hooks } = this.opts;
    switch (e.kind) {
      case 'device_revoked':
        hooks.onUnauthorized('device_revoked', requestDeviceId);
        return;
      case 'unauthorized':
        hooks.onUnauthorized('unauthorized', requestDeviceId);
        return;
      case 'not_entitled':
        hooks.onNotEntitled();
        return;
      case 'update_required': {
        const r = e.protocolRange ?? { min: 1, max: 1 };
        hooks.onUpdateRequired(r.min, r.max);
        return;
      }
      case 'rate_limited':
      case 'unavailable':
      case 'server_error':
        hooks.onTransientFailure(e.kind, e.retryAfterMs ?? 0);
        return;
      default:
        return;
    }
  }
}
