/**
 * HTTP client for the cyboflow cloud accounts API (register, account, devices, sign-out).
 *
 * Secret hygiene: an error's message is fixed text plus the HTTP status and the server's `error` code
 * only. Parse and shape failures are wrapped WITHOUT `cause`, `details` or any body excerpt: a JSON.parse
 * message quotes the start of its input, which for `register` is the device token.
 */
import type { FetchLike } from './fetchLike';
import { parseRetryAfter } from './backoff';
import {
  CLOUD_APP_VERSION_HEADER,
  CLOUD_ID_RE,
  CLOUD_SYNC_PROTOCOL_HEADER,
  CLOUD_SYNC_PROTOCOL_VERSION,
  DEVICE_CODE_RE,
  DEVICE_TOKEN_RE,
} from '../../../../shared/types/cloudAccountWire';
import type {
  AccountResponse,
  CloudErrorKind,
  DeviceInfo,
  DeviceRegisterRequest,
  DeviceRegistration,
} from '../../../../shared/types/cloudAccountWire';

export interface AccountsHttpClientOptions {
  /** Trailing '/' is stripped. */
  origin: string;
  fetch: FetchLike;
  appVersion: string;
  /** Default 15_000. */
  timeoutMs?: number;
  /** Default 1_048_576. */
  maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DISCARD_TIMEOUT_MS = 5_000;
const SERVER_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export class CloudHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly retryAfterMs?: number;

  /**
   * @param status 0 = transport / local failure
   * @param code the server `error`, or 'network' | 'aborted' | 'timeout' | 'response_too_large' |
   *   'bad_response' | `http_${status}`
   */
  constructor(status: number, code: string, message: string, details?: unknown, retryAfterMs?: number) {
    super(message);
    this.name = 'CloudHttpError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }

  get kind(): CloudErrorKind {
    if (this.status === 0) {
      return this.code === 'bad_response' ? 'terminal' : 'network';
    }
    if (this.status === 401) return this.code === 'device_revoked' ? 'revoked' : 'auth';
    if (this.status === 403 && this.code === 'not_entitled') return 'not_entitled';
    if (this.status === 426) return 'upgrade_required';
    if (this.status === 429) return 'retryable';
    if (this.status >= 500) return 'retryable';
    return 'terminal';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function badResponse(message: string): CloudHttpError {
  return new CloudHttpError(0, 'bad_response', message);
}

/** Shape-checks a 201 body; throws CloudHttpError(0, 'bad_response') on any violation. */
export function validateRegistration(body: unknown): DeviceRegistration {
  const fail = (): never => {
    throw badResponse('response did not match the expected shape');
  };
  if (!isRecord(body)) return fail();
  const { token, deviceId, deviceCode, deviceName, accountId, scopes } = body;
  if (typeof token !== 'string' || !DEVICE_TOKEN_RE.test(token)) return fail();
  if (typeof deviceId !== 'string' || !CLOUD_ID_RE.test(deviceId)) return fail();
  if (typeof accountId !== 'string' || !CLOUD_ID_RE.test(accountId)) return fail();
  if (typeof deviceCode !== 'string' || !DEVICE_CODE_RE.test(deviceCode)) return fail();
  if (typeof deviceName !== 'string' || deviceName.length < 1 || deviceName.length > 100) return fail();
  if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === 'string')) return fail();
  return { token, deviceId, deviceCode, deviceName, accountId, scopes: scopes as string[] };
}

function validateAccount(body: unknown): AccountResponse {
  if (!isRecord(body)) throw badResponse('response did not match the expected shape');
  const { accountId, displayLogin, entitlements } = body;
  if (typeof accountId !== 'string' || !CLOUD_ID_RE.test(accountId)) {
    throw badResponse('response did not match the expected shape');
  }
  if (displayLogin !== null && typeof displayLogin !== 'string') {
    throw badResponse('response did not match the expected shape');
  }
  if (!Array.isArray(entitlements)) throw badResponse('response did not match the expected shape');
  return {
    accountId,
    displayLogin,
    entitlements: entitlements.filter((e): e is string => typeof e === 'string'),
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function validateDevices(body: unknown): DeviceInfo[] {
  if (!isRecord(body) || !Array.isArray(body.devices)) {
    throw badResponse('response did not match the expected shape');
  }
  const out: DeviceInfo[] = [];
  for (const entry of body.devices as unknown[]) {
    if (!isRecord(entry)) continue;
    const { id, code, name, platform, appVersion, createdAt, lastSeenAt, revokedAt, current } = entry;
    if (typeof id !== 'string' || typeof code !== 'string' || typeof name !== 'string') continue;
    const created = numberOrNull(createdAt);
    if (created === null) continue;
    out.push({
      id,
      code,
      name,
      platform: typeof platform === 'string' ? platform : null,
      appVersion: typeof appVersion === 'string' ? appVersion : null,
      createdAt: created,
      lastSeenAt: numberOrNull(lastSeenAt),
      revokedAt: numberOrNull(revokedAt),
      current: current === true,
    });
  }
  return out;
}

export class AccountsHttpClient {
  private readonly origin: string;
  private readonly fetchImpl: FetchLike;
  private readonly appVersion: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(opts: AccountsHttpClientOptions) {
    this.origin = opts.origin.replace(/\/+$/, '');
    this.fetchImpl = opts.fetch;
    this.appVersion = opts.appVersion;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  /** POST /v1/devices/register (no Authorization). Returns the VALIDATED registration. */
  async register(body: DeviceRegisterRequest, signal?: AbortSignal): Promise<DeviceRegistration> {
    const { status, json } = await this.request('POST', '/v1/devices/register', { body, signal });
    if (status !== 201) {
      this.discardUnusableRegistration(json);
      throw badResponse('response did not match the expected shape');
    }
    try {
      return validateRegistration(json);
    } catch (err) {
      this.discardUnusableRegistration(json);
      throw err;
    }
  }

  /**
   * A 201 whose body failed validation may still have created a device. Ask the server to revoke it with
   * the returned token, best effort, so it does not linger on the account. The token stays inside this
   * method: it is never put in an error, a log line or a return value.
   */
  private discardUnusableRegistration(body: unknown): void {
    if (!isRecord(body) || typeof body.token !== 'string' || !DEVICE_TOKEN_RE.test(body.token)) return;
    void this.revokeSelf(body.token, AbortSignal.timeout(DISCARD_TIMEOUT_MS)).catch(() => undefined);
  }

  /** GET /v1/account */
  async getAccount(token: string, signal?: AbortSignal): Promise<AccountResponse> {
    const { json } = await this.request('GET', '/v1/account', { token, signal });
    return validateAccount(json);
  }

  /** GET /v1/devices */
  async listDevices(token: string, signal?: AbortSignal): Promise<DeviceInfo[]> {
    const { json } = await this.request('GET', '/v1/devices', { token, signal });
    return validateDevices(json);
  }

  /** DELETE /v1/devices/self */
  async revokeSelf(token: string, signal?: AbortSignal): Promise<{ revoked: boolean }> {
    await this.request('DELETE', '/v1/devices/self', { token, signal, allowEmpty: true });
    return { revoked: true };
  }

  private async request(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown; signal?: AbortSignal; allowEmpty?: boolean },
  ): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = {
      [CLOUD_SYNC_PROTOCOL_HEADER]: String(CLOUD_SYNC_PROTOCOL_VERSION),
      [CLOUD_APP_VERSION_HEADER]: this.appVersion,
      Accept: 'application/json',
    };
    if (opts.token !== undefined) headers.Authorization = `Bearer ${opts.token}`;
    let payload: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(opts.body);
    }

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.origin}${path}`, {
        method,
        headers,
        body: payload,
        redirect: 'error',
        cache: 'no-store',
        signal,
      });
    } catch {
      // Never forward the transport error's message: it can carry the request URL.
      const code = opts.signal?.aborted ? 'aborted' : timeoutSignal.aborted ? 'timeout' : 'network';
      throw new CloudHttpError(0, code, `request failed (${code})`);
    }

    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxResponseBytes) {
      throw new CloudHttpError(0, 'response_too_large', 'response was too large');
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      const code = opts.signal?.aborted ? 'aborted' : timeoutSignal.aborted ? 'timeout' : 'network';
      throw new CloudHttpError(0, code, `request failed (${code})`);
    }
    if (Buffer.byteLength(text, 'utf8') > this.maxResponseBytes) {
      throw new CloudHttpError(0, 'response_too_large', 'response was too large');
    }

    if (!res.ok) {
      let code = `http_${res.status}`;
      let details: unknown;
      try {
        const parsed: unknown = JSON.parse(text);
        if (isRecord(parsed)) {
          if (typeof parsed.error === 'string' && SERVER_CODE_RE.test(parsed.error)) code = parsed.error;
          if (parsed.details !== undefined) details = parsed.details;
        }
      } catch {
        // Non-JSON error body: keep the http_<status> code.
      }
      throw new CloudHttpError(
        res.status,
        code,
        `request failed with status ${res.status} (${code})`,
        details,
        parseRetryAfter(res.headers.get('retry-after'), Date.now()),
      );
    }

    if (text.trim() === '') {
      if (opts.allowEmpty) return { status: res.status, json: null };
      throw badResponse('response was not valid JSON');
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      if (opts.allowEmpty) return { status: res.status, json: null };
      throw badResponse('response was not valid JSON');
    }
    return { status: res.status, json };
  }
}
