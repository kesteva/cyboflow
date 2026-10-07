/**
 * In-process behavioural model of the relay's PUBLIC desktop API (`/bridge/v1/*`, as described by the
 * vendored relayProtocol.ts and its observable HTTP behaviour), plus vendor-side controls. Exposes a
 * `fetch` that routes by method + path; every request is recorded.
 */
import type {
  PairedClient,
  RelayEnvelope,
  RelayReceiptEvent,
  RelayTransport,
} from '../../../../../../../shared/types/relayProtocol';
import type { FetchLike } from '../../../../cloud/fetchLike';
import type { FakeWebSocket } from './fakeWebSocket';

export interface FakeRelayOptions {
  origin?: string;
  vendorOrigin?: string;
  token?: string;
  deviceId?: string;
  accountId?: string;
  now?: () => number;
}

export type FakeFault =
  | { kind: 'http'; status: number; error: string; details?: unknown; retryAfterSec?: number; headers?: Record<string, string> }
  /** Throw TypeError before the request is applied. */
  | { kind: 'network' }
  /** Apply the request, then throw TypeError (lost response). */
  | { kind: 'drop_response' }
  | { kind: 'non_json' }
  /** A raw response body with the given status. */
  | { kind: 'raw'; status: number; body: string; headers?: Record<string, string> }
  /** Never answers; rejects only when the request's signal aborts. */
  | { kind: 'hang' }
  /** Throws a DOMException named TimeoutError. */
  | { kind: 'timeout' };

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  status: number | 'fault';
}

interface FaultEntry { method?: string; path?: RegExp; fault: FakeFault; times: number }

interface Conn {
  id: string;
  accountId: string;
  transport: RelayTransport;
  label: string | null;
  state: 'active' | 'revoked';
  createdAt: number;
  pairingCode: string;
  pairedClient: PairedClient | null;
  authEpoch: number;
  pairCalled: Set<number>;
  cursorEpoch: number;
  nextInSeq: number;
  nextOutSeq: number;
  inbound: RelayEnvelope[];
  outbound: RelayEnvelope[];
  seenIn: Map<string, number>;
  seenOut: Map<string, number>;
  served: number;
  gap: { from: number; to: number } | null;
  revokePending: number;
  receiptsEmitted: Set<string>;
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const WORDS_A = ['AMBER', 'BRAVE', 'CEDAR', 'DELTA', 'EMBER', 'FROST', 'GLADE', 'HAVEN'];
const WORDS_B = ['RIVER', 'STONE', 'TIGER', 'OCEAN', 'MAPLE', 'COMET', 'PRISM', 'LUNAR'];
const TOKEN_RE = /^cbd_[A-Za-z0-9_-]{43}$/;
const ENVELOPE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const LINK_RE = /^https?:\/\/\S+$/;

class HttpReply {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly headers: Record<string, string> = {},
  ) {}
}

function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

export class FakeRelay {
  readonly origin: string;
  readonly vendorOrigin: string;
  token: string;
  deviceId: string;
  accountId: string;
  entitled = true;
  revokedDevice = false;
  protocolRange = { min: 1, max: 1 };
  disabled = false;
  accountsDown = false;
  readonly requests: RecordedRequest[] = [];
  readonly fetch: FetchLike;
  private readonly now: () => number;
  private readonly conns = new Map<string, Conn>();
  private readonly faults: FaultEntry[] = [];
  private readonly sockets: FakeWebSocket[] = [];
  private counter = 0;

  constructor(opts: FakeRelayOptions = {}) {
    this.origin = opts.origin ?? 'https://cloud.test';
    this.vendorOrigin = opts.vendorOrigin ?? 'https://bridge.test';
    this.token = opts.token ?? `cbd_${'a'.repeat(43)}`;
    this.deviceId = opts.deviceId ?? 'dev_1';
    this.accountId = opts.accountId ?? 'acct_1';
    this.now = opts.now ?? Date.now;
    this.fetch = ((input: string | URL | Request, init?: RequestInit) => this.handle(input, init)) as FetchLike;
  }

  injectOnce(match: { method?: string; path?: RegExp }, fault: FakeFault): void {
    this.faults.push({ ...match, fault, times: 1 });
  }

  injectAlways(match: { method?: string; path?: RegExp }, fault: FakeFault): void {
    this.faults.push({ ...match, fault, times: Number.POSITIVE_INFINITY });
  }

  clearFaults(): void {
    this.faults.length = 0;
  }

  // ---- vendor-side controls ----------------------------------------------------------------------

  vendorSend(relayId: string, m: { id?: string; body: string; links?: string[] }): { id: string; relaySeq: number; duplicate: boolean } {
    const c = this.conn(relayId);
    const id = m.id ?? `in_${c.nextInSeq}_${this.counter++}`;
    const prior = c.seenIn.get(id);
    if (prior !== undefined) return { id, relaySeq: prior, duplicate: true };
    const seq = this.appendInbound(c, { id, kind: 'text', body: m.body, links: m.links ?? [] });
    this.ring(c);
    return { id, relaySeq: seq, duplicate: false };
  }

  vendorReportDelivery(relayId: string, d: { prUrl: string; summary?: string; briefId?: string }): { id: string; relaySeq: number } {
    const c = this.conn(relayId);
    const id = `dr_${c.nextInSeq}_${this.counter++}`;
    const seq = this.appendInbound(c, { id, kind: 'delivery_report', body: d.summary ?? '', links: [], delivery: { ...d } });
    this.ring(c);
    return { id, relaySeq: seq };
  }

  /** Marks every outbound picked up and appends one rcpt:picked_up:<id> per message (once each). */
  vendorReadOutbox(relayId: string): RelayEnvelope[] {
    const c = this.conn(relayId);
    let any = false;
    for (const env of c.outbound) {
      if (env.pickedUpAt === null) env.pickedUpAt = new Date(this.now()).toISOString();
      if (this.addReceipt(c, env.id, 'picked_up')) any = true;
    }
    if (any) this.ring(c);
    return c.outbound.map((e) => ({ ...e }));
  }

  vendorAckBrief(relayId: string, briefId: string, accepted: boolean): void {
    const c = this.conn(relayId);
    if (this.addReceipt(c, briefId, accepted ? 'acked' : 'declined')) this.ring(c);
  }

  completePairing(relayId: string, client: { name: string | null; redirectHost: string }): void {
    const c = this.conn(relayId);
    c.authEpoch += 1;
    c.pairedClient = { name: client.name, redirectHost: client.redirectHost, pairedAt: this.now() };
    this.appendSystem(c, `sys:paired:${c.authEpoch}`, 'Paired.');
    this.ring(c);
  }

  vendorPair(relayId: string): void {
    const c = this.conn(relayId);
    if (c.pairCalled.has(c.authEpoch)) return;
    c.pairCalled.add(c.authEpoch);
    this.appendSystem(c, `sys:pair:${c.authEpoch}`, 'Pair called.');
    this.ring(c);
  }

  /** Deletes unacked inbound ≤ upToSeq and widens the gap. */
  expireInbound(relayId: string, upToSeq: number): void {
    const c = this.conn(relayId);
    const dead = c.inbound.filter((e) => e.relaySeq <= upToSeq);
    if (dead.length === 0) return;
    c.inbound = c.inbound.filter((e) => e.relaySeq > upToSeq);
    const from = Math.min(...dead.map((e) => e.relaySeq));
    const to = Math.max(...dead.map((e) => e.relaySeq));
    c.gap = c.gap ? { from: Math.min(c.gap.from, from), to: Math.max(c.gap.to, to) } : { from, to };
  }

  /** Epoch bump (re-drain from 0); the served watermark resets. */
  fence(relayId: string): void {
    const c = this.conn(relayId);
    c.cursorEpoch = Math.max(c.cursorEpoch + 1, this.now());
    c.served = 0;
  }

  revokePendingTimes(relayId: string, n: number): void {
    this.conn(relayId).revokePending = n;
  }

  revokeServerSide(relayId: string): void {
    this.conn(relayId).state = 'revoked';
  }

  inboundRows(relayId: string): RelayEnvelope[] {
    return this.conn(relayId).inbound.map((e) => ({ ...e }));
  }

  outboundRows(relayId: string): RelayEnvelope[] {
    return this.conn(relayId).outbound.map((e) => ({ ...e }));
  }

  epochOf(relayId: string): number {
    return this.conn(relayId).cursorEpoch;
  }

  servedOf(relayId: string): number {
    return this.conn(relayId).served;
  }

  connectionCount(): number {
    return [...this.conns.values()].filter((c) => c.state === 'active').length;
  }

  connectionIds(): string[] {
    return [...this.conns.keys()];
  }

  pairingCodeOf(relayId: string): string {
    return this.conn(relayId).pairingCode;
  }

  attachSocket(socket: FakeWebSocket): void {
    this.sockets.push(socket);
  }

  /** Requests to a path matching `re` (method optional). */
  count(re: RegExp, method?: string): number {
    return this.requests.filter((r) => re.test(r.path) && (method === undefined || r.method === method)).length;
  }

  // ---- internals ---------------------------------------------------------------------------------

  private conn(relayId: string): Conn {
    const c = this.conns.get(relayId);
    if (!c) throw new Error(`fake relay: unknown connection ${relayId}`);
    return c;
  }

  private ring(c: Conn): void {
    const frame = JSON.stringify({ connectionId: c.id, head: c.nextInSeq - 1 });
    for (const s of this.sockets) if (s.readyState === 1) s.serverMessage(frame);
  }

  private appendInbound(
    c: Conn,
    e: Pick<RelayEnvelope, 'id' | 'kind' | 'body' | 'links'> & Partial<Pick<RelayEnvelope, 'receipt' | 'delivery'>>,
  ): number {
    const seq = c.nextInSeq;
    c.nextInSeq += 1;
    c.seenIn.set(e.id, seq);
    c.inbound.push({
      connectionId: c.id,
      direction: 'in',
      relaySeq: seq,
      createdAt: new Date(this.now()).toISOString(),
      pickedUpAt: null,
      ...e,
    });
    return seq;
  }

  private appendSystem(c: Conn, id: string, body: string): void {
    if (c.seenIn.has(id)) return;
    this.appendInbound(c, { id, kind: 'system', body, links: [] });
  }

  private addReceipt(c: Conn, refId: string, event: RelayReceiptEvent): boolean {
    const id = `rcpt:${event}:${refId}`;
    if (c.receiptsEmitted.has(id)) return false;
    c.receiptsEmitted.add(id);
    this.appendInbound(c, {
      id, kind: 'receipt', body: '', links: [], receipt: { refId, event, at: new Date(this.now()).toISOString() },
    });
    return true;
  }

  private newId(): string {
    const n = this.counter++;
    let s = '';
    let x = n;
    for (let i = 0; i < 26; i += 1) {
      s += ID_ALPHABET[(x % 32 + i * 7) % 32];
      x = Math.floor(x / 32);
    }
    return `c_${s}`;
  }

  private newPairingCode(): string {
    const n = this.counter++;
    return `${WORDS_A[n % WORDS_A.length]}-${WORDS_B[(n >> 3) % WORDS_B.length]}-${String(1000 + (n % 9000))}`;
  }

  private newHttpToken(): string {
    const n = this.counter++;
    return `cbh_${String(n).padStart(6, '0')}${'h'.repeat(37)}`;
  }

  private async handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders) && !(rawHeaders instanceof Headers)) {
      for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) headers[k.toLowerCase()] = v;
    }
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as unknown;
      } catch {
        body = init.body;
      }
    }
    const path = url.pathname.startsWith('/bridge/v1') ? url.pathname.slice('/bridge/v1'.length) : url.pathname;
    const rec: RecordedRequest = { method, url: url.toString(), path: `${path}${url.search}`, headers, body, status: 'fault' };
    this.requests.push(rec);
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw abortError();

    const faultIdx = this.faults.findIndex((f) =>
      (f.method === undefined || f.method === method) && (f.path === undefined || f.path.test(path)));
    if (faultIdx !== -1) {
      const entry = this.faults[faultIdx];
      entry.times -= 1;
      if (entry.times <= 0) this.faults.splice(faultIdx, 1);
      const f = entry.fault;
      switch (f.kind) {
        case 'network':
          throw new TypeError('fetch failed');
        case 'timeout': {
          const e = new Error('The operation timed out');
          e.name = 'TimeoutError';
          throw e;
        }
        case 'hang':
          return new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(abortError()), { once: true });
          });
        case 'non_json':
          rec.status = 200;
          return new Response('<html>not json</html>', { status: 200, headers: this.rangeHeaders() });
        case 'raw':
          rec.status = f.status;
          return new Response(f.body, { status: f.status, headers: { ...this.rangeHeaders(), ...(f.headers ?? {}) } });
        case 'http': {
          rec.status = f.status;
          const h: Record<string, string> = { ...this.rangeHeaders(), ...(f.headers ?? {}) };
          if (f.retryAfterSec !== undefined) h['Retry-After'] = String(f.retryAfterSec);
          return new Response(JSON.stringify({ error: f.error, message: f.error, ...(f.details !== undefined ? { details: f.details } : {}) }), {
            status: f.status, headers: { ...h, 'content-type': 'application/json' },
          });
        }
        case 'drop_response': {
          this.route(method, path, url.searchParams, body, url, headers);
          throw new TypeError('fetch failed');
        }
        default:
          break;
      }
    }

    const reply = this.route(method, path, url.searchParams, body, url, headers);
    rec.status = reply.status;
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { ...this.rangeHeaders(), 'content-type': 'application/json', ...reply.headers },
    });
  }

  private rangeHeaders(): Record<string, string> {
    return {
      'Cyboflow-Relay-Protocol-Min': String(this.protocolRange.min),
      'Cyboflow-Relay-Protocol-Max': String(this.protocolRange.max),
    };
  }

  private err(status: number, error: string, details?: unknown, headers?: Record<string, string>): HttpReply {
    return new HttpReply(status, { error, message: error, ...(details !== undefined ? { details } : {}) }, headers);
  }

  private route(
    method: string,
    path: string,
    q: URLSearchParams,
    body: unknown,
    url: URL,
    headers: Record<string, string>,
  ): HttpReply {
    if (this.disabled) return this.err(503, 'relay_disabled');
    if (url.host !== new URL(this.origin).host) return this.err(404, 'not_found');
    const proto = Number(headers['cyboflow-relay-protocol']);
    if (!Number.isInteger(proto) || proto < this.protocolRange.min || proto > this.protocolRange.max) {
      return this.err(426, 'unsupported_protocol', { min: this.protocolRange.min, max: this.protocolRange.max });
    }
    const auth = headers.authorization ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!TOKEN_RE.test(bearer) || bearer !== this.token) return this.err(401, 'unauthorized');
    if (this.revokedDevice) return this.err(401, 'device_revoked');
    if (this.accountsDown) return this.err(503, 'accounts_unavailable', undefined, { 'Retry-After': '5' });
    if (!this.entitled) return this.err(403, 'not_entitled', { required: 'bridge' });

    if (path === '/connections' && method === 'POST') return this.create(body);
    if (path === '/connections' && method === 'GET') {
      return new HttpReply(200, {
        connections: [...this.conns.values()].filter((c) => c.accountId === this.accountId).map((c) => ({
          id: c.id, transport: c.transport, state: c.state, label: c.label, createdAt: c.createdAt,
          ...(c.pairedClient ? { pairedClient: { ...c.pairedClient } } : {}),
        })),
      });
    }
    if (path === '/doorbell') return this.err(400, 'websocket_required');
    const m = /^\/connections\/([^/]+)\/(inbound|ack|outbound|revoke|repair)(?:\/([^/]+))?$/.exec(path);
    if (!m) return this.err(404, 'not_found');
    const c = this.conns.get(decodeURIComponent(m[1]));
    if (!c || c.accountId !== this.accountId) return this.err(404, 'not_found');
    const action = m[2];
    if (action === 'revoke' && method === 'POST') {
      c.state = 'revoked';
      if (c.revokePending > 0) {
        c.revokePending -= 1;
        return this.err(503, 'revoke_pending', undefined, { 'Retry-After': '5' });
      }
      return new HttpReply(200, { revoked: true });
    }
    if (c.state === 'revoked') return this.err(409, 'connection_revoked');
    if (action === 'inbound' && method === 'GET') return this.pull(c, q);
    if (action === 'ack' && method === 'POST') return this.ack(c, body);
    if (action === 'outbound' && method === 'POST' && m[3] === undefined) return this.outbound(c, body);
    if (action === 'outbound' && method === 'DELETE' && m[3] !== undefined) {
      const envId = decodeURIComponent(m[3]);
      const before = c.outbound.length;
      c.outbound = c.outbound.filter((e) => e.id !== envId);
      return new HttpReply(200, { withdrawn: c.outbound.length !== before });
    }
    if (action === 'repair' && method === 'POST') {
      c.cursorEpoch = Math.max(c.cursorEpoch + 1, this.now());
      c.served = 0;
      c.pairingCode = this.newPairingCode();
      c.pairedClient = null;
      c.authEpoch += 1;
      const token = c.transport === 'relay-http' ? this.newHttpToken() : undefined;
      return new HttpReply(200, {
        connectionId: c.id, pairingCode: c.pairingCode, epoch: c.cursorEpoch, ...(token ? { token } : {}),
      });
    }
    return this.err(404, 'not_found');
  }

  private create(body: unknown): HttpReply {
    const b = (body ?? {}) as { transport?: unknown; label?: unknown };
    if (b.transport !== 'relay-mcp' && b.transport !== 'relay-http') {
      return this.err(400, 'invalid_request', { field: 'transport' });
    }
    if (b.label !== undefined) {
      // eslint-disable-next-line no-control-regex
      if (typeof b.label !== 'string' || b.label.length > 100 || /[\u0000-\u001f\u007f]/.test(b.label)) {
        return this.err(400, 'invalid_request', { field: 'label' });
      }
    }
    const active = [...this.conns.values()].filter((c) => c.accountId === this.accountId && c.state === 'active');
    if (active.length >= 20) return this.err(409, 'connection_limit', { max: 20 });
    const id = this.newId();
    const c: Conn = {
      id, accountId: this.accountId, transport: b.transport, label: typeof b.label === 'string' ? b.label : null,
      state: 'active', createdAt: this.now(), pairingCode: this.newPairingCode(), pairedClient: null, authEpoch: 0,
      pairCalled: new Set(), cursorEpoch: 1, nextInSeq: 1, nextOutSeq: 1, inbound: [], outbound: [],
      seenIn: new Map(), seenOut: new Map(), served: 0, gap: null, revokePending: 0, receiptsEmitted: new Set(),
    };
    this.conns.set(id, c);
    const token = c.transport === 'relay-http' ? this.newHttpToken() : undefined;
    return new HttpReply(201, {
      connectionId: id,
      pairingCode: c.pairingCode,
      mcpUrl: `${this.vendorOrigin}/mcp/${id}`,
      httpBase: `${this.vendorOrigin}/c/${id}`,
      ...(token ? { token } : {}),
    }, { 'Cache-Control': 'no-store' });
  }

  private pull(c: Conn, q: URLSearchParams): HttpReply {
    const ints: number[] = [];
    for (const k of ['epoch', 'after', 'limit']) {
      const raw = q.get(k) ?? (k === 'limit' ? '100' : '0');
      if (!/^\d{1,15}$/.test(raw)) return this.err(400, 'invalid_request', { field: k });
      ints.push(Number(raw));
    }
    const [epoch, afterRaw, limitRaw] = ints;
    const after = epoch === c.cursorEpoch && afterRaw >= 0 ? afterRaw : 0;
    const limit = Math.min(100, Math.max(1, limitRaw));
    const items = c.inbound.filter((e) => e.relaySeq > after).slice(0, limit);
    const page: { epoch: number; items: RelayEnvelope[]; head: number; gap?: { from: number; to: number } } = {
      epoch: c.cursorEpoch, items: items.map((e) => ({ ...e })), head: c.nextInSeq - 1,
    };
    if (c.gap && c.gap.to > after) page.gap = { from: Math.max(c.gap.from, after + 1), to: c.gap.to };
    const lastItem = items.length > 0 ? items[items.length - 1].relaySeq : 0;
    c.served = Math.max(c.served, lastItem, page.gap?.to ?? 0);
    return new HttpReply(200, page);
  }

  private ack(c: Conn, body: unknown): HttpReply {
    const b = (body ?? {}) as { epoch?: unknown; upTo?: unknown };
    if (typeof b.epoch !== 'number' || typeof b.upTo !== 'number') return this.err(400, 'invalid_request', { field: 'epoch' });
    if (b.epoch !== c.cursorEpoch) return this.err(409, 'stale_epoch', { epoch: c.cursorEpoch });
    if (b.upTo > c.served) return this.err(409, 'ack_beyond_served', { maxServed: c.served });
    const upTo = b.upTo;
    const before = c.inbound.length;
    c.inbound = c.inbound.filter((e) => e.relaySeq > upTo);
    if (c.gap && upTo >= c.gap.to) c.gap = null;
    return new HttpReply(200, { acked: before - c.inbound.length });
  }

  private outbound(c: Conn, body: unknown): HttpReply {
    const env = ((body ?? {}) as { envelope?: unknown }).envelope as
      | { id?: unknown; kind?: unknown; body?: unknown; links?: unknown }
      | undefined;
    if (!env || typeof env.id !== 'string' || !ENVELOPE_ID_RE.test(env.id)) return this.err(400, 'invalid_request', { field: 'id' });
    if (env.kind !== 'text' && env.kind !== 'brief') return this.err(400, 'invalid_request', { field: 'kind' });
    if (typeof env.body !== 'string') return this.err(400, 'invalid_request', { field: 'body' });
    const links = env.links === undefined ? [] : env.links;
    if (!Array.isArray(links) || links.length > 20
      || !links.every((l) => typeof l === 'string' && l.length <= 2048 && LINK_RE.test(l))) {
      return this.err(400, 'invalid_request', { field: 'links' });
    }
    const bytes = Buffer.byteLength(env.body, 'utf8') + (links as string[]).reduce((n, l) => n + Buffer.byteLength(l, 'utf8'), 0);
    if (bytes > 65536) return this.err(413, 'message_too_large', { max: 65536 });
    const prior = c.seenOut.get(env.id);
    if (prior !== undefined) return new HttpReply(200, { relaySeq: prior, duplicate: true });
    const seq = c.nextOutSeq;
    c.nextOutSeq += 1;
    c.seenOut.set(env.id, seq);
    c.outbound.push({
      id: env.id, connectionId: c.id, direction: 'out', kind: env.kind, body: env.body, links: links as string[],
      relaySeq: seq, createdAt: new Date(this.now()).toISOString(), pickedUpAt: null,
    });
    return new HttpReply(201, { relaySeq: seq, duplicate: false });
  }
}
