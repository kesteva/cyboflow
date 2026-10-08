/**
 * Thin typed HTTP client for the cyboflow-sync service (protocol 1).
 *
 * No retries here: the sync engine owns backoff and needs to see every failure.
 * This layer only maps responses — a non-2xx or transport failure becomes a
 * {@link SyncHttpError} whose `kind` tells the engine how to react (back off,
 * stop and sign out, prompt an upgrade, resync after a rewind, ...).
 */

import {
  SYNC_EPOCH_HEADER,
  SYNC_PROTOCOL_HEADER,
  type ChecksumResponse,
  type ConflictRecord,
  type FeedPage,
  type FileConflictRequest,
  type HeadResponse,
  type PushRequest,
  type PushResponse,
  type RemoteProject,
  type SyncErrorBody,
  type TrackerClaimResponse,
} from '../../../../shared/types/remoteSyncWire';

/** Injected so tests never touch the network. */
export type FetchLike = typeof fetch;

export interface SyncHttpClientOptions {
  origin: string;
  fetch: FetchLike;
  getToken: () => string | null;
  appVersion: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export type SyncErrorKind =
  | 'network'
  | 'auth'
  | 'revoked'
  | 'not_entitled'
  | 'upgrade_required'
  | 'retryable'
  | 'rewound'
  | 'terminal';

export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'SyncHttpError';
  }

  get kind(): SyncErrorKind {
    const { status, code } = this;
    if (status === 0) return 'network';
    if (status === 401) return code === 'device_revoked' ? 'revoked' : 'auth';
    if (status === 403 && code === 'not_entitled') return 'not_entitled';
    if (status === 426) return 'upgrade_required';
    if (status === 409 && code === 'rewound') return 'rewound';
    if (status === 429 || status === 503 || status >= 500) return 'retryable';
    return 'terminal';
  }
}

export type SyncResult<T> = { body: T; epoch: number | null };

function unwrap<T>(body: unknown, key: string): T {
  if (body !== null && typeof body === 'object' && key in (body as Record<string, unknown>)) {
    return (body as Record<string, unknown>)[key] as T;
  }
  return body as T;
}

const seg = encodeURIComponent;

export class SyncHttpClient {
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly opts: SyncHttpClientOptions) {
    this.origin = opts.origin.replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxResponseBytes = opts.maxResponseBytes ?? 8 * 1024 * 1024;
  }

  head(): Promise<SyncResult<HeadResponse>> {
    return this.request<HeadResponse>('GET', '/v1/head');
  }

  async listProjects(): Promise<SyncResult<{ projects: RemoteProject[] }>> {
    const r = await this.request<unknown>('GET', '/v1/projects');
    return { body: { projects: unwrap<RemoteProject[]>(r.body, 'projects') }, epoch: r.epoch };
  }

  async createProject(req: { name: string; fingerprint: string }): Promise<SyncResult<{ project: RemoteProject }>> {
    const r = await this.request<unknown>('POST', '/v1/projects', req);
    return { body: { project: unwrap<RemoteProject>(r.body, 'project') }, epoch: r.epoch };
  }

  push(projectId: string, req: PushRequest): Promise<SyncResult<PushResponse>> {
    return this.request('POST', `/v1/projects/${seg(projectId)}/push`, req);
  }

  pull(
    projectId: string,
    q: { since: number; limit?: number; reset?: boolean },
  ): Promise<SyncResult<FeedPage>> {
    let qs = `since=${encodeURIComponent(String(q.since))}`;
    if (q.limit !== undefined) qs += `&limit=${encodeURIComponent(String(q.limit))}`;
    if (q.reset) qs += '&reset=1';
    return this.request('GET', `/v1/projects/${seg(projectId)}/changes?${qs}`);
  }

  async fileConflict(
    projectId: string,
    req: FileConflictRequest,
  ): Promise<SyncResult<{ conflict: ConflictRecord }>> {
    const r = await this.request<unknown>('POST', `/v1/projects/${seg(projectId)}/conflicts`, req);
    return { body: { conflict: unwrap<ConflictRecord>(r.body, 'conflict') }, epoch: r.epoch };
  }

  async resolveConflict(
    projectId: string,
    conflictId: string,
    resolution: string,
  ): Promise<SyncResult<{ conflict: ConflictRecord }>> {
    const r = await this.request<unknown>(
      'POST',
      `/v1/projects/${seg(projectId)}/conflicts/${seg(conflictId)}/resolve`,
      { resolution },
    );
    return { body: { conflict: unwrap<ConflictRecord>(r.body, 'conflict') }, epoch: r.epoch };
  }

  trackerClaim(req: {
    key: string;
    label: string;
    action: 'check' | 'claim' | 'release';
  }): Promise<SyncResult<TrackerClaimResponse>> {
    return this.request('POST', '/v1/tracker-claims', req);
  }

  checksum(projectId: string, req: { atSeq: number; hash: string }): Promise<SyncResult<ChecksumResponse>> {
    return this.request('POST', `/v1/projects/${seg(projectId)}/checksum`, req);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<SyncResult<T>> {
    const headers: Record<string, string> = {
      [SYNC_PROTOCOL_HEADER]: '1',
      // The service records it per device cursor (version-skew diagnostics).
      'Cyboflow-App-Version': this.opts.appVersion,
      Accept: 'application/json',
    };
    const token = this.opts.getToken();
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    const hasBody = body !== undefined;
    if (hasBody) headers['Content-Type'] = 'application/json';

    let res: Response;
    let text: string;
    try {
      res = await this.opts.fetch(`${this.origin}${path}`, {
        method,
        headers,
        body: hasBody ? JSON.stringify(body) : undefined,
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > this.maxResponseBytes) {
        throw new SyncHttpError(0, 'response_too_large', `response of ${declared} bytes exceeds limit`);
      }
      text = await res.text();
    } catch (err) {
      if (err instanceof SyncHttpError) throw err;
      throw new SyncHttpError(0, 'network', err instanceof Error ? err.message : String(err));
    }
    if (Buffer.byteLength(text, 'utf8') > this.maxResponseBytes) {
      throw new SyncHttpError(0, 'response_too_large', 'response exceeds size limit');
    }

    let parsed: unknown;
    let parseFailed = false;
    try {
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch {
      parseFailed = true;
    }

    if (!res.ok) {
      const eb = !parseFailed && parsed !== null && typeof parsed === 'object' ? (parsed as Partial<SyncErrorBody>) : null;
      const code = eb && typeof eb.error === 'string' ? eb.error : `http_${res.status}`;
      const message = eb && typeof eb.message === 'string' ? eb.message : `${method} ${path} failed: ${res.status} ${code}`;
      const ra = res.headers.get('retry-after');
      const retryAfterMs = ra !== null && /^\d+$/.test(ra.trim()) ? Number(ra.trim()) * 1000 : undefined;
      throw new SyncHttpError(res.status, code, message, eb?.details, retryAfterMs);
    }
    if (parseFailed || parsed === undefined) {
      throw new SyncHttpError(0, 'bad_response', 'response body is not valid JSON');
    }

    const epochRaw = res.headers.get(SYNC_EPOCH_HEADER);
    const epochNum = epochRaw !== null && /^-?\d+$/.test(epochRaw.trim()) ? Number(epochRaw.trim()) : null;
    return { body: parsed as T, epoch: epochNum };
  }
}
