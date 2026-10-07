/**
 * PersistentAgentStore — the SOLE writer of the persistent-agents tables (migration 151:
 * vendor_credentials, persistent_agents, persistent_agent_connections, persistent_agent_messages,
 * persistent_agent_events, persistent_agent_usage). Enforced by persistentAgentsSoleWriter.test.ts.
 *
 * Shape (template: IdeaComponentRouter): a per-agent PQueue({concurrency: 1}) orders writes; each write is
 * ONE synchronous better-sqlite3 transaction; events go out on persistentAgentEvents only AFTER the
 * transaction returned (a throwing transaction emits nothing). Credential writes use the '__credentials__'
 * queue, boot/retention sweeps '__global__'. Reads are synchronous and unqueued.
 *
 * Timestamps: every column is written as Date#toISOString() — never datetime('now') — because the outbox
 * compares next_attempt_at / rate_limited_until as TEXT and the two shapes do not sort together.
 * Connector-supplied times are normalised to that shape and replaced by now when invalid.
 *
 * Inbound content is untrusted: it is sanitised (control and bidi-override characters stripped, size cut,
 * links validated) and stored as inert text. Nothing here interprets it.
 *
 * Ciphertext enters only through insertCredential / rotateCredential and leaves only through
 * getCredentialCiphertext (read by CredentialService.secret). Plaintext never reaches this file.
 */
import { createHash, randomUUID } from 'node:crypto';
import PQueue from 'p-queue';
import type { DatabaseLike, LoggerLike, PreparedStatement } from '../types';
import {
  emitPersistentAgentsChanged,
  emitPersistentAgentThreadEvent,
} from '../persistentAgentsBridge';
import {
  ACTIVITY_TYPES,
  MESSAGE_KINDS,
  PERSISTENT_AGENT_HANDLE_RE,
  PERSISTENT_AGENT_LINK_RE,
  PERSISTENT_AGENT_MAX_LINK_LENGTH,
  PERSISTENT_AGENT_MAX_LINKS,
  PERSISTENT_AGENT_MAX_MESSAGE_BYTES,
  REMOTE_STATUSES,
  USAGE_COVERAGES,
  VERIFIED_FLAGS,
  BRIDGE_STALE_AFTER_MS,
  isOneOf,
  type ConnectorCapabilities,
  type CredentialReference,
  type MessageKind,
  type NewAgentInput,
  type PersistentAgentsChangedEvent,
  type PersistentAgentThreadEvent,
  type SwapState,
  type VendorCredentialState,
  type VendorCredentialVendor,
  type VerifiedFlag,
} from '../../../../shared/types/persistentAgents';
import { parseTimestamp } from '../../../../shared/utils/timestamp';
import type {
  ConnectOutcome,
  InboundBatch,
  ReconcileResult,
  RepairOutcome,
  VerifyOutcome,
} from '../../services/persistentAgents/connectorContract';
import {
  AgentNotFoundError,
  AgentNotSendableError,
  ConnectionNotFoundError,
  CredentialNotFoundError,
  HandleTakenError,
  InvalidAgentInputError,
  SwapInProgressError,
} from './errors';
import {
  parseCapabilities,
  parseRemote,
  toConnectorKind,
  type AgentRow,
  type ApplyInboundResult,
  type ClaimedMessage,
  type ConnectionPatch,
  type ConnectionRow,
  type CredentialRow,
  type EventRow,
  type MessageRow,
  type NewConnectionRow,
  type PumpTargetRow,
  type SettleOutcome,
  type SettleResult,
  type UsageRow,
} from './rows';

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests and the service layer)
// ---------------------------------------------------------------------------

const GLOBAL_QUEUE = '__global__';
const CREDENTIALS_QUEUE = '__credentials__';
const PROBE_WINDOW_MS = 10 * 60_000;
const MAX_ERROR_CHARS = 500;
const MAX_SUMMARY_CHARS = 500;
const MAX_PAYLOAD_BYTES = 16_384;
const PAYLOAD_PREVIEW_CHARS = 16_000;
const RECONCILE_GIVE_UP_AFTER = 5;
const TRUNCATED_MARKER = '\n[truncated]';
export const UNDELIVERABLE_COPY = 'Delivery could not be confirmed';

/** C0 controls except \t \n \r, plus DEL. */
// eslint-disable-next-line no-control-regex
const BODY_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/** Bidi embedding/override/isolate controls (can visually reorder surrounding UI text). ZWJ/ZWNJ/LRM/RLM are kept. */
const BIDI_OVERRIDE_RE = /[‪-‮⁦-⁩]/g;

/** Cut a string to at most `maxBytes` UTF-8 bytes on a code-point boundary. */
function cutUtf8(s: string, maxBytes: number): string {
  let bytes = 0;
  let out = '';
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > maxBytes) break;
    bytes += n;
    out += ch;
  }
  return out;
}

/** Untrusted inbound body → inert text (control + bidi-override stripped, ≤ MAX_MESSAGE_BYTES with a marker). */
export function sanitizeInboundBody(raw: unknown): string {
  const s = (typeof raw === 'string' ? raw : '').replace(BODY_CONTROL_RE, '').replace(BIDI_OVERRIDE_RE, '');
  if (Buffer.byteLength(s, 'utf8') <= PERSISTENT_AGENT_MAX_MESSAGE_BYTES) return s;
  return cutUtf8(s, PERSISTENT_AGENT_MAX_MESSAGE_BYTES - Buffer.byteLength(TRUNCATED_MARKER, 'utf8')) + TRUNCATED_MARKER;
}

/** The relay's link rule: http(s), no whitespace, ≤ 2 048 chars, parseable. */
export function isValidLink(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > PERSISTENT_AGENT_MAX_LINK_LENGTH) return false;
  if (!PERSISTENT_AGENT_LINK_RE.test(url)) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Keep at most PERSISTENT_AGENT_MAX_LINKS valid links; drop the rest silently. */
export function sanitizeLinks(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidLink).slice(0, PERSISTENT_AGENT_MAX_LINKS);
}

export function contentHashOf(kind: string, body: string, links: readonly string[]): string {
  return createHash('sha256').update(`${kind}\n${body}\n${links.join('\n')}`).digest('hex');
}

/** Normalise a connector-supplied time to ISO; invalid / missing → fallback. */
export function normalizeIso(v: unknown, fallback: string): string {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
  }
  if (typeof v !== 'string' || v === '') return fallback;
  const d = parseTimestamp(v);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

/** displayName → handle base: lowercase, NFKD, non [a-z0-9] → '-', collapsed/trimmed, ≤ 32, '' → 'agent'. */
export function slugifyHandle(displayName: string): string {
  const slug = displayName
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return slug === '' ? 'agent' : slug;
}

function cut(s: string | null | undefined, max: number): string | null {
  if (s === null || s === undefined) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function intOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

/** Observed flags whose chip row is still declared by `d` (an undeclared row's confirmation is dropped). */
function isFlagDeclared(flag: VerifiedFlag, d: ConnectorCapabilities): boolean {
  switch (flag) {
    case 'round-trip': return d.messaging === 'two-way';
    case 'delivery': return true;
    case 'activity': return d.activityStream;
    case 'usage': return d.usage;
    case 'control': return d.control.length > 0;
    case 'attachments': return d.attachments;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistentAgentStoreOptions {
  now?: () => Date;
  newId?: () => string;
  logger?: LoggerLike;
}

type Emit =
  | { t: 'a'; ev: PersistentAgentsChangedEvent }
  | { t: 'thread'; ev: PersistentAgentThreadEvent };

interface Done<T> { result: T; emits: Emit[] }

export interface AgentConnectionsData {
  current: ConnectionRow | null;
  swap: ConnectionRow | null;
  retired: ConnectionRow[];
  lastSwitchError: string | null;
}

export interface AgentListData {
  agents: AgentRow[];
  connections: Map<string, AgentConnectionsData>;
  unread: Map<string, number>;
  lastMessageAt: Map<string, string>;
  credentials: Map<string, CredentialRow>;
}

export interface CredentialReferenceRow { credential_id: string; connection_id: string; agent_id: string; display_name: string }

export interface DisconnectAgentResult { connectionId: string; credentialId: string | null; lastReference: boolean }

export type RemoteRevokeRecord =
  | { ok: true }
  | { ok: false; error: string; nextAt: string | null; countAttempt?: boolean };

const UNREAD_PREDICATE = `direction = 'in' AND read_at IS NULL AND author = 'agent' AND kind IN ('text', 'delivery_report')`;

const CLAIM_INNER_SELECT = `
       SELECT m.id
         FROM persistent_agent_messages m
         JOIN persistent_agent_connections c ON c.id = m.connection_id
         JOIN persistent_agents a ON a.id = m.agent_id
        WHERE m.agent_id = ?
          AND m.direction = 'out'
          AND m.send_state = 'queued'
          AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= ?)
          AND a.archived_at IS NULL
          AND c.state NOT IN ('revoked', 'auth_failed')
          AND c.connect_state IS NULL
          AND (c.rate_limited_until IS NULL OR c.rate_limited_until <= ?)
          AND (c.is_current = 1 OR m.is_probe = 1)
          AND NOT EXISTS (SELECT 1 FROM persistent_agent_connections s
                           WHERE s.agent_id = m.agent_id
                             AND s.swap_state IN ('fencing', 'reconciling', 'revoking_remote', 'activating'))
        ORDER BY m.created_at ASC, m.rowid ASC
        LIMIT 1`;

const ALL_SWAP_STATES: readonly SwapState[] = [
  'connecting', 'awaiting_verify', 'fencing', 'reconciling', 'revoking_remote', 'activating',
];

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class PersistentAgentStore {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly logger: LoggerLike | undefined;
  private readonly queues = new Map<string, PQueue>();
  private readonly statements = new Map<string, PreparedStatement>();

  constructor(private readonly db: DatabaseLike, opts: PersistentAgentStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => randomUUID());
    this.logger = opts.logger;
  }

  /** Test seam: the per-key queue for `.onIdle()` waits. */
  _queueFor(key: string): PQueue {
    let q = this.queues.get(key);
    if (!q) {
      q = new PQueue({ concurrency: 1 });
      this.queues.set(key, q);
    }
    return q;
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private stmt(sql: string): PreparedStatement {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private write<T>(key: string, fn: () => Done<T>): Promise<T> {
    return this._queueFor(key).add(() => {
      const txn = this.db.transaction(fn);
      const done = (txn as () => Done<T>)();
      for (const e of done.emits) this.fire(e);
      return done.result;
    }) as Promise<T>;
  }

  private fire(e: Emit): void {
    try {
      if (e.t === 'a') emitPersistentAgentsChanged(e.ev);
      else emitPersistentAgentThreadEvent(e.ev);
    } catch (err) {
      this.logger?.warn('[persistent-agents] change listener threw', { error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  private keyForConnection(connectionId: string): string {
    return this.getConnectionRow(connectionId)?.agent_id ?? GLOBAL_QUEUE;
  }

  private static a(kind: PersistentAgentsChangedEvent['kind'], agentId: string | null): Emit {
    return { t: 'a', ev: { kind, agentId } };
  }

  private static th(agentId: string, kind: PersistentAgentThreadEvent['kind'], messageIds: string[]): Emit {
    return { t: 'thread', ev: { agentId, kind, messageIds } };
  }

  private requireConnection(connectionId: string): ConnectionRow {
    const row = this.getConnectionRow(connectionId);
    if (!row) throw new ConnectionNotFoundError(connectionId);
    return row;
  }

  private insertConnectionRow(
    id: string, agentId: string, conn: NewConnectionRow, now: string,
    opts: { isCurrent: 0 | 1; swapState: SwapState | null; swapFrom: string | null },
  ): void {
    this.stmt(
      `INSERT INTO persistent_agent_connections
         (id, agent_id, kind, connector_id, connector_version, transport, state, credential_id, capabilities_json,
          is_current, generation, connect_state, swap_state, swap_from_connection_id, swap_started_at,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 1, 'creating_remote', ?, ?, ?, ?, ?)`,
    ).run(
      id, agentId, conn.kind, conn.connectorId, conn.connectorVersion, conn.transport, conn.credentialId,
      JSON.stringify({ descriptor: conn.descriptor, descriptorVersion: conn.connectorVersion, observed: {} }),
      opts.isCurrent, opts.swapState, opts.swapFrom, opts.swapState ? now : null, now, now,
    );
  }

  private insertOutboundRow(
    agentId: string, connectionId: string, m: { kind: 'text' | 'brief'; body: string; links: string[]; isProbe: boolean; author: 'user' | 'local' },
    now: string,
  ): string {
    const id = this.newId();
    this.stmt(
      `INSERT INTO persistent_agent_messages (id, agent_id, connection_id, direction, author, kind, body, links_json,
         is_probe, send_state, send_attempts, content_hash, created_at, updated_at)
       VALUES (?, ?, ?, 'out', ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
    ).run(
      id, agentId, connectionId, m.author, m.kind, m.body, JSON.stringify(m.links), m.isProbe ? 1 : 0,
      contentHashOf(m.kind, m.body, m.links), now, now,
    );
    return id;
  }

  private mergeRemoteJson(current: string | null, patch: Record<string, unknown> | undefined): string | null {
    if (!patch || Object.keys(patch).length === 0) return current;
    const remote = parseRemote(current);
    for (const [k, v] of Object.entries(patch)) remote[k] = v === undefined ? null : v;
    return JSON.stringify(remote);
  }

  /**
   * failSwap's writes for a row already known to be in a swap. Runs INSIDE a caller's transaction.
   * Returns true when the CAS matched.
   */
  private failSwapInTxn(n: ConnectionRow, reason: string, revokeNew: boolean, now: string): boolean {
    if (n.swap_state === null) return false;
    const r = this.stmt(
      `UPDATE persistent_agent_connections
          SET swap_state = NULL, swap_error = ?, is_current = 0,
              state = CASE WHEN ? = 1 THEN 'revoked' ELSE state END,
              remote_revoke_state = CASE WHEN ? = 1 AND remote_id IS NOT NULL AND remote_revoke_state IS NULL
                                         THEN 'pending' ELSE remote_revoke_state END,
              remote_revoke_next_at = CASE WHEN ? = 1 AND remote_id IS NOT NULL AND remote_revoke_state IS NULL
                                           THEN ? ELSE remote_revoke_next_at END,
              updated_at = ?
        WHERE id = ? AND swap_state = ?`,
    ).run(cut(reason, MAX_ERROR_CHARS), revokeNew ? 1 : 0, revokeNew ? 1 : 0, revokeNew ? 1 : 0, now, now, n.id, n.swap_state);
    if (r.changes !== 1) return false;
    this.stmt(
      `UPDATE persistent_agent_messages
          SET send_state = 'failed', last_error = 'Switch cancelled', next_attempt_at = NULL, updated_at = ?
        WHERE connection_id = ? AND direction = 'out' AND is_probe = 1 AND send_state = 'queued'`,
    ).run(now, n.id);
    return true;
  }

  // -------------------------------------------------------------------------
  // Agents & connections
  // -------------------------------------------------------------------------

  async createAgent(input: { agent: NewAgentInput; connection: NewConnectionRow }): Promise<{ agentId: string; connectionId: string; handle: string }> {
    const explicit = input.agent.handle;
    if (explicit !== undefined && !PERSISTENT_AGENT_HANDLE_RE.test(explicit)) {
      throw new InvalidAgentInputError('Use lowercase letters, digits and dashes for the handle.', { field: 'handle' });
    }
    const agentId = this.newId();
    const connectionId = this.newId();
    return this.write(agentId, () => {
      const now = this.iso();
      const taken = (h: string): boolean =>
        this.stmt('SELECT 1 FROM persistent_agents WHERE handle = ?').get(h) !== undefined;
      let handle: string;
      if (explicit !== undefined) {
        if (taken(explicit)) throw new HandleTakenError(explicit);
        handle = explicit;
      } else {
        const base = slugifyHandle(input.agent.displayName);
        handle = base;
        for (let i = 2; taken(handle); i++) {
          const suffix = `-${i}`;
          handle = `${base.slice(0, 32 - suffix.length).replace(/-+$/g, '')}${suffix}`;
        }
      }
      this.stmt(
        `INSERT INTO persistent_agents (id, handle, display_name, vendor, github_login, archived_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(agentId, handle, input.agent.displayName.trim(), input.agent.vendor, input.agent.githubLogin ?? null, now, now);
      this.insertConnectionRow(connectionId, agentId, input.connection, now, { isCurrent: 1, swapState: null, swapFrom: null });
      return { result: { agentId, connectionId, handle }, emits: [PersistentAgentStore.a('agents', agentId)] };
    });
  }

  /** A swap target: inserted non-current with swap_state 'connecting'. */
  async createPendingConnection(agentId: string, conn: NewConnectionRow): Promise<{ connectionId: string }> {
    const connectionId = this.newId();
    return this.write(agentId, () => {
      const now = this.iso();
      const agent = this.getAgentRow(agentId);
      if (!agent) throw new AgentNotFoundError(agentId);
      if (agent.archived_at !== null) throw new AgentNotSendableError('archived');
      if (this.getSwapTarget(agentId)) throw new SwapInProgressError(agentId);
      const current = this.getCurrentConnection(agentId);
      if (!current) throw new AgentNotSendableError('no_connection');
      // A new switch supersedes the error of an earlier aborted one.
      this.stmt(
        `UPDATE persistent_agent_connections SET swap_error = NULL, updated_at = ?
          WHERE agent_id = ? AND swap_error IS NOT NULL`,
      ).run(now, agentId);
      this.insertConnectionRow(connectionId, agentId, conn, now, { isCurrent: 0, swapState: 'connecting', swapFrom: current.id });
      return { result: { connectionId }, emits: [PersistentAgentStore.a('connection', agentId)] };
    });
  }

  async completeConnectionCreate(connectionId: string, o: ConnectOutcome): Promise<void> {
    return this.write(this.keyForConnection(connectionId), () => {
      const now = this.iso();
      const row = this.requireConnection(connectionId);
      const remoteJson = JSON.stringify({ ...o.remote, remoteId: o.remoteId, transport: o.transport });
      // A row cancelled while its remote create was outstanding is already 'revoked': the remote object
      // that now exists is queued for revoke in the same statement, so it is never orphaned.
      const r = this.stmt(
        `UPDATE persistent_agent_connections
            SET connect_state = NULL, remote_id = ?, remote_json = ?, transport = ?, inbound_cursor = ?,
                relay_epoch = ?, verify_json = ?,
                swap_state = CASE WHEN swap_state = 'connecting' THEN 'awaiting_verify' ELSE swap_state END,
                remote_revoke_state = CASE WHEN state = 'revoked' AND remote_revoke_state IS NULL
                                           THEN 'pending' ELSE remote_revoke_state END,
                remote_revoke_next_at = CASE WHEN state = 'revoked' AND remote_revoke_state IS NULL
                                             THEN ? ELSE remote_revoke_next_at END,
                updated_at = ?
          WHERE id = ? AND connect_state = 'creating_remote'`,
      ).run(
        o.remoteId, remoteJson, o.transport, o.inboundCursor, o.relayEpoch, JSON.stringify(o.facts ?? []),
        now, now, connectionId,
      );
      if (r.changes !== 1) throw new ConnectionNotFoundError(connectionId);
      return { result: undefined, emits: [PersistentAgentStore.a('connection', row.agent_id)] };
    });
  }

  async abortConnectionCreate(connectionId: string, reason: string): Promise<{ agentDeleted: boolean }> {
    return this.write<{ agentDeleted: boolean }>(this.keyForConnection(connectionId), () => {
      const now = this.iso();
      const row = this.getConnectionRow(connectionId);
      if (!row) return { result: { agentDeleted: false }, emits: [] };
      const count = (sql: string, ...p: unknown[]): number => (this.stmt(sql).get(...p) as { n: number }).n;
      const connMessages = count('SELECT COUNT(*) AS n FROM persistent_agent_messages WHERE connection_id = ?', connectionId);
      const agentMessages = count('SELECT COUNT(*) AS n FROM persistent_agent_messages WHERE agent_id = ?', row.agent_id);
      const others = count('SELECT COUNT(*) AS n FROM persistent_agent_connections WHERE agent_id = ? AND id != ?', row.agent_id, connectionId);
      if (row.is_current === 1 && others === 0 && agentMessages === 0) {
        this.stmt('DELETE FROM persistent_agents WHERE id = ?').run(row.agent_id);
        return { result: { agentDeleted: true }, emits: [PersistentAgentStore.a('agents', row.agent_id)] };
      }
      if (connMessages === 0) {
        this.stmt('DELETE FROM persistent_agent_connections WHERE id = ?').run(connectionId);
        if (row.swap_from_connection_id !== null) {
          this.stmt('UPDATE persistent_agent_connections SET swap_error = ?, updated_at = ? WHERE id = ?')
            .run(cut(reason, MAX_ERROR_CHARS), now, row.swap_from_connection_id);
        }
      } else {
        this.stmt(
          `UPDATE persistent_agent_connections
              SET state = 'revoked', is_current = 0, swap_state = NULL, swap_error = ?, connect_state = NULL, updated_at = ?
            WHERE id = ?`,
        ).run(cut(reason, MAX_ERROR_CHARS), now, connectionId);
      }
      return { result: { agentDeleted: false }, emits: [PersistentAgentStore.a('connection', row.agent_id)] };
    });
  }

  /**
   * One pull's worth of inbound content, in ONE transaction (nothing is acked before it commits).
   * With `expectedRelayEpoch` set and different from the row's relay_epoch, a repair committed while
   * this pull was in flight: content is stored (dedupe-safe) but the connection row is left untouched.
   */
  async applyInboundBatch(
    connectionId: string,
    batch: InboundBatch,
    opts: { expectedRelayEpoch?: number | null } = {},
  ): Promise<ApplyInboundResult> {
    return this.write(this.keyForConnection(connectionId), () => {
      const now = this.iso();
      const conn = this.requireConnection(connectionId);
      const agentId = conn.agent_id;
      const kind = toConnectorKind(conn.kind, this.logger);
      const fenced = opts.expectedRelayEpoch !== undefined
        && (conn.relay_epoch ?? null) !== (opts.expectedRelayEpoch ?? null);

      // 2. messages
      const inserted: string[] = [];
      let unreadInserted = false;
      let agentEvidence = false;
      let roundTripCandidate = false;
      let deliveryReportInserted = false;
      for (const m of batch.messages ?? []) {
        if (typeof m.remoteEventId !== 'string' || m.remoteEventId === '') continue;
        const author: 'agent' | 'relay' | 'local' = m.author === 'relay' || m.author === 'local' ? m.author : 'agent';
        const mkind: MessageKind = isOneOf(MESSAGE_KINDS, m.kind) ? m.kind : 'system';
        const direction = author === 'local' ? 'local' : 'in';
        const body = sanitizeInboundBody(m.body);
        const links = sanitizeLinks(m.links);
        const delivery = m.delivery && isValidLink(m.delivery.prUrl)
          ? JSON.stringify({
            prUrl: m.delivery.prUrl,
            ...(typeof m.delivery.summary === 'string' ? { summary: sanitizeInboundBody(m.delivery.summary).slice(0, 2_000) } : {}),
            ...(typeof m.delivery.briefId === 'string' ? { briefId: m.delivery.briefId.slice(0, 200) } : {}),
          })
          : null;
        const id = this.newId();
        const r = this.stmt(
          `INSERT INTO persistent_agent_messages
             (id, agent_id, connection_id, direction, author, kind, body, links_json, delivery_json,
              relay_seq, relay_epoch, remote_event_id, remote_created_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        ).run(
          id, agentId, connectionId, direction, author, mkind, body, JSON.stringify(links), delivery,
          intOrNull(m.relaySeq), intOrNull(m.relayEpoch), m.remoteEventId,
          m.remoteCreatedAt ? normalizeIso(m.remoteCreatedAt, now) : null, now, now,
        );
        if (r.changes !== 1) continue;
        inserted.push(id);
        if (author !== 'local') agentEvidence = true;
        if (author === 'agent' && (mkind === 'text' || mkind === 'delivery_report')) {
          unreadInserted = true;
          roundTripCandidate = true;
        }
        if (mkind === 'delivery_report') deliveryReportInserted = true;
      }

      // 3. receipts (scoped to this connection's agent)
      const sentState = kind === 'bridge' ? 'on_bridge' : 'sent';
      const receiptIds: string[] = [];
      for (const rc of batch.receipts ?? []) {
        if (typeof rc.localMessageId !== 'string' || rc.localMessageId === '') continue;
        if (rc.event !== 'picked_up' && rc.event !== 'acked' && rc.event !== 'declined') continue;
        const at = normalizeIso(rc.at, now);
        const ack = rc.event === 'picked_up' ? null : rc.event;
        const r = this.stmt(
          `UPDATE persistent_agent_messages
              SET picked_up_at  = COALESCE(picked_up_at, ?),
                  remote_ack    = CASE WHEN ? IS NOT NULL THEN ? ELSE remote_ack END,
                  remote_ack_at = CASE WHEN ? IS NOT NULL THEN COALESCE(remote_ack_at, ?) ELSE remote_ack_at END,
                  send_state    = CASE WHEN send_state IN ('queued','ambiguous','in_flight','creating') THEN ? ELSE send_state END,
                  sent_at       = COALESCE(sent_at, ?),
                  connection_id = CASE WHEN send_state IN ('queued','ambiguous') THEN ? ELSE connection_id END,
                  updated_at    = ?
            WHERE id = ? AND agent_id = ? AND direction = 'out'`,
        ).run(at, ack, ack, ack, at, sentState, at, connectionId, now, rc.localMessageId, agentId);
        if (r.changes === 1) receiptIds.push(rc.localMessageId);
      }

      // 4. activity
      let activityInserted = 0;
      for (const ev of batch.activity ?? []) {
        if (typeof ev.remoteEventId !== 'string' || ev.remoteEventId === '') continue;
        let payload: string | null = null;
        if (ev.payload !== undefined) {
          try {
            payload = JSON.stringify(ev.payload) ?? null;
          } catch {
            payload = null;
          }
          if (payload !== null && Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
            payload = JSON.stringify({ truncated: true, preview: payload.slice(0, PAYLOAD_PREVIEW_CHARS) });
          }
        }
        const r = this.stmt(
          `INSERT INTO persistent_agent_events (id, agent_id, connection_id, remote_event_id, remote_scope,
             type, summary, payload_json, occurred_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(connection_id, remote_event_id) DO NOTHING`,
        ).run(
          this.newId(), agentId, connectionId, ev.remoteEventId, typeof ev.remoteScope === 'string' ? ev.remoteScope : null,
          isOneOf(ACTIVITY_TYPES, ev.type) ? ev.type : 'unknown',
          typeof ev.summary === 'string' ? cut(sanitizeInboundBody(ev.summary), MAX_SUMMARY_CHARS) : null,
          payload, normalizeIso(ev.occurredAt, now), now,
        );
        activityInserted += r.changes;
      }

      // 5. delivery hints
      let validHints = 0;
      for (const h of batch.deliveryHints ?? []) {
        if (!isValidLink(h.prUrl) || typeof h.remoteEventId !== 'string' || h.remoteEventId === '') continue;
        validHints += 1;
        this.stmt(
          `INSERT INTO persistent_agent_events (id, agent_id, connection_id, remote_event_id, remote_scope,
             type, summary, payload_json, occurred_at, created_at)
           VALUES (?, ?, ?, ?, NULL, 'delivery_hint', NULL, ?, ?, ?)
           ON CONFLICT(connection_id, remote_event_id) DO NOTHING`,
        ).run(
          this.newId(), agentId, connectionId, h.remoteEventId,
          JSON.stringify({ prUrl: h.prUrl, source: h.source === 'activity' ? 'activity' : 'report' }), now, now,
        );
      }

      // 6. usage (a cumulative snapshot replaces the row; an older one never overwrites a newer one)
      let usageReplaced = 0;
      for (const u of batch.usage ?? []) {
        if (typeof u.remoteScope !== 'string' || u.remoteScope === '') continue;
        const r = this.stmt(
          `INSERT INTO persistent_agent_usage (connection_id, remote_scope, agent_id, input_tokens, output_tokens,
             cache_read_tokens, cache_creation_tokens, cost_usd, active_seconds, coverage, computed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(connection_id, remote_scope) DO UPDATE SET
             input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
             cache_read_tokens = excluded.cache_read_tokens, cache_creation_tokens = excluded.cache_creation_tokens,
             cost_usd = excluded.cost_usd, active_seconds = excluded.active_seconds, coverage = excluded.coverage,
             computed_at = excluded.computed_at
           WHERE excluded.computed_at >= persistent_agent_usage.computed_at`,
        ).run(
          connectionId, u.remoteScope, agentId, finiteOrNull(u.inputTokens), finiteOrNull(u.outputTokens),
          finiteOrNull(u.cacheReadTokens), finiteOrNull(u.cacheCreationTokens), finiteOrNull(u.costUsd),
          finiteOrNull(u.activeSeconds), isOneOf(USAGE_COVERAGES, u.coverage) ? u.coverage : 'partial',
          normalizeIso(u.computedAt, now),
        );
        usageReplaced += r.changes;
      }

      const evidence = agentEvidence || receiptIds.length > 0 || activityInserted > 0;
      const emits: Emit[] = [];
      if (inserted.length > 0) emits.push(PersistentAgentStore.th(agentId, 'messages', inserted));
      if (receiptIds.length > 0) emits.push(PersistentAgentStore.th(agentId, 'receipts', receiptIds));
      if (activityInserted > 0) emits.push(PersistentAgentStore.th(agentId, 'activity', []));
      if (usageReplaced > 0) emits.push(PersistentAgentStore.th(agentId, 'usage', []));
      if (unreadInserted) emits.push(PersistentAgentStore.a('unread', agentId));

      const base: ApplyInboundResult = {
        insertedMessageIds: inserted, receiptsApplied: receiptIds.length, activityInserted, usageReplaced,
        evidence, becameVerified: false, observedAdded: [], fenced,
      };
      if (fenced) return { result: base, emits };

      // 7. observed flags (round-trip is derived only for native connections; a Bridge connection is
      //    verified only by what the connector observed)
      const observedNow = new Set<VerifiedFlag>((batch.observed ?? []).filter((f) => isOneOf(VERIFIED_FLAGS, f)));
      if (kind === 'native' && roundTripCandidate) {
        const sentBefore = this.stmt(
          `SELECT 1 FROM persistent_agent_messages WHERE connection_id = ? AND direction = 'out' AND sent_at IS NOT NULL LIMIT 1`,
        ).get(connectionId);
        if (sentBefore !== undefined) observedNow.add('round-trip');
      }
      if (deliveryReportInserted || validHints > 0) observedNow.add('delivery');
      if (activityInserted > 0) observedNow.add('activity');
      if (usageReplaced > 0) observedNow.add('usage');
      const caps = parseCapabilities(conn.capabilities_json);
      const observedAdded: VerifiedFlag[] = [];
      for (const f of observedNow) {
        if (caps.observed[f] === undefined) {
          caps.observed[f] = now;
          observedAdded.push(f);
        }
      }

      // 8. connection update
      let state = conn.state;
      let verifiedAt = conn.verified_at;
      let authRetryAt = conn.auth_retry_at;
      let errorKind = conn.error_kind;
      let lastError = conn.last_error;
      if (state === 'pending' && observedNow.has('round-trip')) {
        state = 'verified';
        verifiedAt = verifiedAt ?? now;
      } else if (state === 'stale' && evidence) {
        state = 'verified';
      } else if (state === 'auth_failed') {
        state = verifiedAt !== null ? 'verified' : 'pending';
        authRetryAt = null;
        errorKind = null;
        lastError = null;
      }
      const remoteJson = this.mergeRemoteJson(conn.remote_json, batch.remotePatch);
      let lastSeenAt = conn.last_seen_at;
      if (evidence) {
        if (batch.lastSeenAt !== undefined) {
          const batchSeen = normalizeIso(batch.lastSeenAt, now);
          lastSeenAt = (conn.last_seen_at ?? '') > batchSeen ? conn.last_seen_at : batchSeen;
        } else {
          lastSeenAt = now;
        }
      }
      const remoteStatusJson = batch.remoteStatus !== undefined && isOneOf(REMOTE_STATUSES, batch.remoteStatus)
        ? JSON.stringify({ status: batch.remoteStatus, at: now })
        : conn.remote_status_json;
      const relayEpoch = typeof batch.cursorEpoch === 'number' && Number.isInteger(batch.cursorEpoch)
        ? batch.cursorEpoch
        : conn.relay_epoch;
      this.stmt(
        `UPDATE persistent_agent_connections
            SET inbound_cursor = ?, relay_epoch = ?, capabilities_json = ?, rate_limited_until = NULL,
                remote_status_json = ?, remote_json = ?, last_seen_at = ?, state = ?, verified_at = ?,
                auth_retry_at = ?, error_kind = ?, last_error = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        batch.nextCursor ?? null, relayEpoch, JSON.stringify(caps), remoteStatusJson, remoteJson, lastSeenAt,
        state, verifiedAt, authRetryAt, errorKind, lastError, now, connectionId,
      );

      // 9. a pull succeeded, so the connection's credential works again
      let credentialFlipped = false;
      if (conn.credential_id !== null) {
        const c = this.stmt(
          `UPDATE vendor_credentials SET state = 'ok', last_error = NULL, last_verified_at = ?, updated_at = ?
            WHERE id = ? AND state = 'auth_failed'`,
        ).run(now, now, conn.credential_id);
        credentialFlipped = c.changes === 1;
      }

      const connectionChanged = state !== conn.state || observedAdded.length > 0 || lastSeenAt !== conn.last_seen_at
        || remoteJson !== conn.remote_json || conn.rate_limited_until !== null
        || remoteStatusJson !== conn.remote_status_json;
      if (connectionChanged) emits.push(PersistentAgentStore.a('connection', agentId));
      if (credentialFlipped) emits.push(PersistentAgentStore.a('credentials', null));
      return {
        result: { ...base, becameVerified: conn.state === 'pending' && state === 'verified', observedAdded },
        emits,
      };
    });
  }

  async enqueueOutbound(
    agentId: string,
    m: { kind: 'text' | 'brief'; body: string; links: string[]; isProbe?: boolean; connectionId?: string; author?: 'user' | 'local' },
  ): Promise<{ messageId: string }> {
    return this.write(agentId, () => {
      const now = this.iso();
      const agent = this.getAgentRow(agentId);
      if (!agent) throw new AgentNotFoundError(agentId);
      if (agent.archived_at !== null) throw new AgentNotSendableError('archived');
      let target: ConnectionRow | null;
      if (m.connectionId !== undefined) {
        target = this.getConnectionRow(m.connectionId);
        if (!target || target.agent_id !== agentId) throw new ConnectionNotFoundError(m.connectionId);
      } else {
        target = this.getCurrentConnection(agentId);
      }
      if (!target) throw new AgentNotSendableError('no_connection');
      if (target.state === 'revoked' && m.isProbe !== true) throw new AgentNotSendableError('revoked');
      const id = this.insertOutboundRow(agentId, target.id, {
        kind: m.kind, body: m.body, links: m.links, isProbe: m.isProbe === true, author: m.author ?? 'user',
      }, now);
      return { result: { messageId: id }, emits: [PersistentAgentStore.th(agentId, 'messages', [id])] };
    });
  }

  /** Single-statement claim of the oldest claimable queued row (plain `?` params). No emit. */
  async claimOutbound(agentId: string, nowDate: Date): Promise<ClaimedMessage | null> {
    return this.write(agentId, () => {
      const nowIso = nowDate.toISOString();
      const row = this.stmt(
        `UPDATE persistent_agent_messages
            SET send_state = 'in_flight',
                send_attempts = send_attempts + 1,
                claim_generation = (SELECT c.generation FROM persistent_agent_connections c
                                     WHERE c.id = persistent_agent_messages.connection_id),
                updated_at = ?
          WHERE id = (${CLAIM_INNER_SELECT})
            AND send_state = 'queued'
        RETURNING rowid AS _rowid, *`,
      ).get(nowIso, agentId, nowIso, nowIso) as ClaimedMessage | undefined;
      return { result: row ?? null, emits: [] };
    });
  }

  async settleOutbound(
    messageId: string,
    claim: { connectionId: string; generation: number },
    outcome: SettleOutcome,
  ): Promise<SettleResult> {
    const row0 = this.getMessageRow(messageId);
    return this.write(row0?.agent_id ?? GLOBAL_QUEUE, () => {
      const now = this.iso();
      const row = this.getMessageRow(messageId);
      if (!row) return { result: 'ignored', emits: [] };
      const claimConn = this.getConnectionRow(claim.connectionId);
      const matching = row.send_state === 'in_flight' && row.connection_id === claim.connectionId
        && row.claim_generation === claim.generation;
      const emit = [PersistentAgentStore.th(row.agent_id, 'messages', [messageId])];

      const applySuccess = (receipt: Extract<SettleOutcome, { ok: true }>['receipt'], connectionId: string): void => {
        this.stmt(
          `UPDATE persistent_agent_messages
              SET send_state = ?, sent_at = ?, remote_event_id = COALESCE(?, remote_event_id), remote_out_seq = ?,
                  connection_id = ?, last_error = NULL, next_attempt_at = NULL, updated_at = ?
            WHERE id = ?`,
        ).run(
          receipt.state === 'on_bridge' ? 'on_bridge' : 'sent', normalizeIso(receipt.acceptedAt, now),
          receipt.remoteEventId ?? null, intOrNull(receipt.remoteOutSeq), connectionId, now, messageId,
        );
      };

      if (matching) {
        const fenced = !claimConn || claimConn.generation !== claim.generation;
        if (outcome.ok) {
          applySuccess(outcome.receipt, claim.connectionId);
        } else {
          const err = cut(outcome.error, MAX_ERROR_CHARS);
          if (outcome.maybeDelivered) {
            this.stmt(
              `UPDATE persistent_agent_messages SET send_state = 'ambiguous', next_attempt_at = ?, last_error = ?, updated_at = ?
                WHERE id = ?`,
            ).run(fenced ? null : outcome.nextAttemptAt, err, now, messageId);
          } else {
            switch (outcome.kind) {
              case 'invalid':
              case 'permanent':
                this.stmt(
                  `UPDATE persistent_agent_messages SET send_state = 'failed', next_attempt_at = NULL, last_error = ?, updated_at = ?
                    WHERE id = ?`,
                ).run(err, now, messageId);
                break;
              case 'not_found':
              case 'revoked':
                this.stmt(
                  `UPDATE persistent_agent_messages SET send_state = 'queued', next_attempt_at = NULL, last_error = ?, updated_at = ?
                    WHERE id = ?`,
                ).run(err, now, messageId);
                break;
              case 'paused':
              case 'auth':
              case 'device_auth':
              case 'not_entitled':
              case 'upgrade_required':
                // Not an attempt the message could have succeeded at: refund it.
                this.stmt(
                  `UPDATE persistent_agent_messages
                      SET send_state = 'queued', next_attempt_at = NULL, send_attempts = MAX(send_attempts - 1, 0),
                          last_error = ?, updated_at = ?
                    WHERE id = ?`,
                ).run(err, now, messageId);
                break;
              case 'rate_limited':
              case 'retryable':
              case 'conflict':
                this.stmt(
                  `UPDATE persistent_agent_messages SET send_state = 'queued', next_attempt_at = ?, last_error = ?, updated_at = ?
                    WHERE id = ?`,
                ).run(fenced ? null : outcome.nextAttemptAt, err, now, messageId);
                break;
            }
          }
        }
        return { result: fenced ? 'applied_fenced' : 'applied', emits: emit };
      }

      if (!outcome.ok) return { result: 'ignored', emits: [] };
      const claimLive = claimConn !== null && claimConn.is_current === 1 && claimConn.state !== 'revoked';
      if ((row.send_state === 'queued' || row.send_state === 'ambiguous')
        && (outcome.receipt.state === 'sent' || claimLive)) {
        applySuccess(outcome.receipt, claim.connectionId);
        return { result: 'applied_fenced', emits: emit };
      }
      this.stmt(
        `INSERT INTO persistent_agent_events (id, agent_id, connection_id, remote_event_id, remote_scope, type,
           summary, payload_json, occurred_at, created_at)
         VALUES (?, ?, ?, ?, NULL, 'late_receipt', NULL, ?, ?, ?)
         ON CONFLICT(connection_id, remote_event_id) DO NOTHING`,
      ).run(
        this.newId(), row.agent_id, claim.connectionId, `late:${messageId}:${claim.generation}`,
        JSON.stringify({ messageId, state: outcome.receipt.state, acceptedAt: normalizeIso(outcome.receipt.acceptedAt, now) }),
        now, now,
      );
      return { result: 'late_receipt', emits: emit };
    });
  }

  /** Boot: every in-flight send may or may not have reached the server. */
  async requeueInFlightAsAmbiguous(): Promise<number> {
    return this.write(GLOBAL_QUEUE, () => {
      const r = this.stmt(
        `UPDATE persistent_agent_messages SET send_state = 'ambiguous', next_attempt_at = NULL, updated_at = ?
          WHERE direction = 'out' AND send_state IN ('in_flight', 'creating')`,
      ).run(this.iso());
      return { result: r.changes, emits: r.changes > 0 ? [PersistentAgentStore.a('agents', null)] : [] };
    });
  }

  async demoteInFlightToAmbiguous(connectionId: string): Promise<number> {
    return this.write(this.keyForConnection(connectionId), () => {
      const row = this.getConnectionRow(connectionId);
      const r = this.stmt(
        `UPDATE persistent_agent_messages SET send_state = 'ambiguous', next_attempt_at = NULL, updated_at = ?
          WHERE direction = 'out' AND send_state IN ('in_flight', 'creating') AND connection_id = ?`,
      ).run(this.iso(), connectionId);
      const emits = r.changes > 0 && row ? [PersistentAgentStore.th(row.agent_id, 'messages', [])] : [];
      return { result: r.changes, emits };
    });
  }

  async applyReconcile(
    connectionId: string,
    results: readonly ReconcileResult[],
    nextAttemptAt: (attempts: number) => string,
  ): Promise<void> {
    return this.write(this.keyForConnection(connectionId), () => {
      const now = this.iso();
      const conn = this.getConnectionRow(connectionId);
      if (!conn) return { result: undefined, emits: [] };
      const ids: string[] = [];
      for (const res of results) {
        const row = this.stmt(
          `SELECT reconcile_attempts FROM persistent_agent_messages
            WHERE id = ? AND connection_id = ? AND direction = 'out' AND send_state = 'ambiguous'`,
        ).get(res.messageId, connectionId) as { reconcile_attempts: number } | undefined;
        if (!row) continue;
        if (res.outcome === 'found') {
          this.stmt(
            `UPDATE persistent_agent_messages
                SET send_state = ?, sent_at = COALESCE(sent_at, ?), remote_event_id = COALESCE(?, remote_event_id),
                    remote_out_seq = COALESCE(?, remote_out_seq), reconcile_attempts = 0, next_attempt_at = NULL,
                    last_error = NULL, updated_at = ?
              WHERE id = ?`,
          ).run(
            res.receipt.state === 'on_bridge' ? 'on_bridge' : 'sent', normalizeIso(res.receipt.acceptedAt, now),
            res.receipt.remoteEventId ?? null, intOrNull(res.receipt.remoteOutSeq), now, res.messageId,
          );
        } else if (res.outcome === 'not_found') {
          this.stmt(
            `UPDATE persistent_agent_messages
                SET send_state = 'queued', next_attempt_at = NULL, reconcile_attempts = 0, updated_at = ?
              WHERE id = ?`,
          ).run(now, res.messageId);
        } else {
          const attempts = row.reconcile_attempts + 1;
          if (conn.is_current === 0 && attempts >= RECONCILE_GIVE_UP_AFTER) {
            this.stmt(
              `UPDATE persistent_agent_messages
                  SET send_state = 'failed', reconcile_attempts = ?, next_attempt_at = NULL, last_error = ?, updated_at = ?
                WHERE id = ?`,
            ).run(attempts, UNDELIVERABLE_COPY, now, res.messageId);
          } else {
            this.stmt(
              `UPDATE persistent_agent_messages SET reconcile_attempts = ?, next_attempt_at = ?, updated_at = ?
                WHERE id = ?`,
            ).run(attempts, nextAttemptAt(attempts), now, res.messageId);
          }
        }
        ids.push(res.messageId);
      }
      return { result: undefined, emits: ids.length > 0 ? [PersistentAgentStore.th(conn.agent_id, 'messages', ids)] : [] };
    });
  }

  /**
   * Dynamic SET from the present patch keys only (fixed column whitelist; values bound). A swap target
   * that turns revoked/auth_failed before it verified fails its swap in the same transaction.
   */
  async setConnectionState(connectionId: string, patch: ConnectionPatch): Promise<void> {
    return this.write(this.keyForConnection(connectionId), () => {
      const now = this.iso();
      const conn = this.requireConnection(connectionId);
      const sets: string[] = [];
      const values: unknown[] = [];
      const set = (col: string, v: unknown): void => { sets.push(`${col} = ?`); values.push(v); };
      if (patch.state !== undefined) set('state', patch.state);
      if (patch.errorKind !== undefined) set('error_kind', cut(patch.errorKind, 64));
      if (patch.lastError !== undefined) set('last_error', cut(patch.lastError, MAX_ERROR_CHARS));
      if (patch.rateLimitedUntil !== undefined) set('rate_limited_until', patch.rateLimitedUntil);
      if (patch.authRetryAt !== undefined) set('auth_retry_at', patch.authRetryAt);
      if (patch.remoteStatus !== undefined) {
        set('remote_status_json', patch.remoteStatus === null ? null : JSON.stringify({ status: patch.remoteStatus, at: now }));
      }
      const emits: Emit[] = [];
      if (sets.length > 0) {
        set('updated_at', now);
        this.stmt(`UPDATE persistent_agent_connections SET ${sets.join(', ')} WHERE id = ?`).run(...values, connectionId);
      }
      if (patch.state === 'auth_failed' && patch.credentialStateIfAuth !== undefined && conn.credential_id !== null) {
        this.stmt('UPDATE vendor_credentials SET state = ?, last_error = ?, updated_at = ? WHERE id = ?')
          .run(patch.credentialStateIfAuth, cut(patch.lastError ?? null, MAX_ERROR_CHARS), now, conn.credential_id);
        emits.push(PersistentAgentStore.a('credentials', null));
      }
      if ((patch.state === 'revoked' || patch.state === 'auth_failed')
        && (conn.swap_state === 'connecting' || conn.swap_state === 'awaiting_verify')) {
        const fresh = this.requireConnection(connectionId);
        this.failSwapInTxn(fresh, 'New connection failed before verifying', true, now);
      }
      emits.push(PersistentAgentStore.a('connection', conn.agent_id));
      return { result: undefined, emits };
    });
  }

  /** Bridge connections verified with no inbound evidence for > 24 h become 'stale' (persisted). */
  async markStale(nowDate: Date): Promise<string[]> {
    return this.write(GLOBAL_QUEUE, () => {
      const cutoff = new Date(nowDate.getTime() - BRIDGE_STALE_AFTER_MS).toISOString();
      const rows = this.stmt(
        `UPDATE persistent_agent_connections SET state = 'stale', updated_at = ?
          WHERE kind = 'bridge' AND state = 'verified'
            AND COALESCE(last_seen_at, verified_at, created_at) < ?
        RETURNING id, agent_id`,
      ).all(nowDate.toISOString(), cutoff) as Array<{ id: string; agent_id: string }>;
      return {
        result: rows.map((r) => r.id),
        emits: rows.map((r) => PersistentAgentStore.a('connection', r.agent_id)),
      };
    });
  }

  async applyVerifyOutcome(connectionId: string, v: VerifyOutcome): Promise<{ probeQueued: boolean }> {
    return this.write(this.keyForConnection(connectionId), () => {
      const now = this.iso();
      const conn = this.requireConnection(connectionId);
      const caps = parseCapabilities(conn.capabilities_json);
      for (const f of v.observed ?? []) {
        if (isOneOf(VERIFIED_FLAGS, f) && caps.observed[f] === undefined) caps.observed[f] = now;
      }
      this.stmt(
        `UPDATE persistent_agent_connections SET remote_json = ?, verify_json = ?, capabilities_json = ?, updated_at = ?
          WHERE id = ?`,
      ).run(this.mergeRemoteJson(conn.remote_json, v.remotePatch), JSON.stringify(v.facts ?? []), JSON.stringify(caps), now, connectionId);
      const emits: Emit[] = [PersistentAgentStore.a('connection', conn.agent_id)];
      let probeQueued = false;
      if (v.probe && typeof v.probe.body === 'string' && v.probe.body !== '') {
        const since = new Date(this.now().getTime() - PROBE_WINDOW_MS).toISOString();
        const recent = this.stmt(
          `SELECT 1 FROM persistent_agent_messages WHERE connection_id = ? AND is_probe = 1 AND created_at > ? LIMIT 1`,
        ).get(connectionId, since);
        if (recent === undefined) {
          const id = this.insertOutboundRow(conn.agent_id, connectionId, {
            kind: 'text', body: v.probe.body, links: [], isProbe: true, author: 'local',
          }, now);
          probeQueued = true;
          emits.push(PersistentAgentStore.th(conn.agent_id, 'messages', [id]));
        }
      }
      return { result: { probeQueued }, emits };
    });
  }

  /** New pairing: back to 'pending'; verified_at and observed flags are kept. */
  async applyRepair(connectionId: string, r: RepairOutcome): Promise<void> {
    return this.write(this.keyForConnection(connectionId), () => {
      const now = this.iso();
      const conn = this.requireConnection(connectionId);
      this.stmt(
        `UPDATE persistent_agent_connections
            SET state = 'pending', remote_json = ?, relay_epoch = COALESCE(?, relay_epoch),
                inbound_cursor = COALESCE(?, inbound_cursor), error_kind = NULL, last_error = NULL, updated_at = ?
          WHERE id = ?`,
      ).run(
        this.mergeRemoteJson(conn.remote_json, r.remotePatch), intOrNull(r.relayEpoch),
        typeof r.inboundCursor === 'string' ? r.inboundCursor : null, now, connectionId,
      );
      return { result: undefined, emits: [PersistentAgentStore.a('connection', conn.agent_id)] };
    });
  }

  /** A registered connector advanced its version: new descriptor; confirmations of undeclared rows dropped. */
  async refreshDescriptor(connectionId: string, descriptor: ConnectorCapabilities, version: number): Promise<void> {
    return this.write(this.keyForConnection(connectionId), () => {
      const conn = this.getConnectionRow(connectionId);
      if (!conn || version <= conn.connector_version) return { result: undefined, emits: [] };
      const caps = parseCapabilities(conn.capabilities_json, descriptor);
      const observed: Partial<Record<VerifiedFlag, string>> = {};
      for (const [f, at] of Object.entries(caps.observed) as Array<[VerifiedFlag, string]>) {
        if (isFlagDeclared(f, descriptor)) observed[f] = at;
      }
      this.stmt(
        `UPDATE persistent_agent_connections SET connector_version = ?, capabilities_json = ?, updated_at = ? WHERE id = ?`,
      ).run(version, JSON.stringify({ descriptor, descriptorVersion: version, observed }), this.iso(), connectionId);
      return { result: undefined, emits: [PersistentAgentStore.a('connection', conn.agent_id)] };
    });
  }

  /** Out-of-band non-secret remote_json merge (a null value stores null). */
  async patchRemote(connectionId: string, patch: Record<string, unknown>): Promise<void> {
    return this.write(this.keyForConnection(connectionId), () => {
      const conn = this.requireConnection(connectionId);
      const merged = this.mergeRemoteJson(conn.remote_json, patch);
      if (merged === conn.remote_json) return { result: undefined, emits: [] };
      this.stmt('UPDATE persistent_agent_connections SET remote_json = ?, updated_at = ? WHERE id = ?')
        .run(merged, this.iso(), connectionId);
      return { result: undefined, emits: [PersistentAgentStore.a('connection', conn.agent_id)] };
    });
  }

  // -------------------------------------------------------------------------
  // Swap transitions (all on the NEW row n; o = n.swap_from_connection_id). Each is a compare-and-set.
  // -------------------------------------------------------------------------

  async markSwapState(n: string, from: SwapState, to: SwapState): Promise<boolean> {
    return this.write(this.keyForConnection(n), () => {
      const row = this.getConnectionRow(n);
      if (!row) return { result: false, emits: [] };
      const r = this.stmt(
        'UPDATE persistent_agent_connections SET swap_state = ?, updated_at = ? WHERE id = ? AND swap_state = ?',
      ).run(to, this.iso(), n, from);
      return { result: r.changes === 1, emits: r.changes === 1 ? [PersistentAgentStore.a('connection', row.agent_id)] : [] };
    });
  }

  /** fencing → reconciling, bumping o's generation (settles of earlier claims become fenced). */
  async fenceSwap(n: string): Promise<boolean> {
    return this.write(this.keyForConnection(n), () => {
      const now = this.iso();
      const row = this.getConnectionRow(n);
      if (!row || row.swap_state !== 'fencing') return { result: false, emits: [] };
      if (row.swap_from_connection_id !== null) {
        this.stmt('UPDATE persistent_agent_connections SET generation = generation + 1, updated_at = ? WHERE id = ?')
          .run(now, row.swap_from_connection_id);
      }
      this.stmt(
        `UPDATE persistent_agent_connections SET swap_state = 'reconciling', updated_at = ? WHERE id = ? AND swap_state = 'fencing'`,
      ).run(now, n);
      return { result: true, emits: [PersistentAgentStore.a('connection', row.agent_id)] };
    });
  }

  async beginRemoteRevoke(connectionId: string, nextAt: string): Promise<void> {
    return this.write(this.keyForConnection(connectionId), () => {
      const row = this.getConnectionRow(connectionId);
      if (!row) return { result: undefined, emits: [] };
      const r = this.stmt(
        `UPDATE persistent_agent_connections SET remote_revoke_state = 'pending', remote_revoke_next_at = ?, updated_at = ?
          WHERE id = ? AND remote_revoke_state IS NULL`,
      ).run(nextAt, this.iso(), connectionId);
      return { result: undefined, emits: r.changes === 1 ? [PersistentAgentStore.a('connection', row.agent_id)] : [] };
    });
  }

  /** ok → done. Failure: attempts+1 (unless countAttempt === false); nextAt null → gave_up. Never regresses 'done'. */
  async recordRemoteRevoke(connectionId: string, r: RemoteRevokeRecord): Promise<void> {
    return this.write(this.keyForConnection(connectionId), () => {
      const now = this.iso();
      const row = this.getConnectionRow(connectionId);
      if (!row) return { result: undefined, emits: [] };
      if (r.ok) {
        this.stmt(
          `UPDATE persistent_agent_connections
              SET remote_revoke_state = 'done', remote_revoke_error = NULL, remote_revoke_next_at = NULL, updated_at = ?
            WHERE id = ?`,
        ).run(now, connectionId);
      } else {
        this.stmt(
          `UPDATE persistent_agent_connections
              SET remote_revoke_attempts = remote_revoke_attempts + ?, remote_revoke_error = ?,
                  remote_revoke_next_at = ?, remote_revoke_state = CASE WHEN ? IS NULL THEN 'gave_up' ELSE 'pending' END,
                  updated_at = ?
            WHERE id = ? AND (remote_revoke_state IS NULL OR remote_revoke_state != 'done')`,
        ).run(r.countAttempt === false ? 0 : 1, cut(r.error, MAX_ERROR_CHARS), r.nextAt, r.nextAt, now, connectionId);
      }
      return { result: undefined, emits: [PersistentAgentStore.a('connection', row.agent_id)] };
    });
  }

  /**
   * activating → done, in ONE transaction (statement order is load-bearing for idx_pac_current: o is
   * demoted before n is promoted). Afterwards no row on o is 'queued' or 'ambiguous': queued rows move to
   * n; for a Bridge o, ambiguous rows and on-bridge rows nobody picked up move to n as queued (o's relay
   * mailbox is being deleted, so re-sending is the only delivery path — a duplicate beats a loss); for a
   * native o, ambiguous rows are failed.
   */
  async activateSwap(n: string, names?: { from: string; to: string }): Promise<boolean> {
    return this.write(this.keyForConnection(n), () => {
      const now = this.iso();
      const nrow = this.getConnectionRow(n);
      if (!nrow || nrow.swap_state !== 'activating') return { result: false, emits: [] };
      const agent = this.getAgentRow(nrow.agent_id);
      const o = nrow.swap_from_connection_id;
      const orow = o !== null ? this.getConnectionRow(o) : null;
      if (orow) {
        this.stmt(
          `UPDATE persistent_agent_connections SET is_current = 0, replaced_at = ?, state = 'revoked', updated_at = ?
            WHERE id = ? AND is_current = 1`,
        ).run(now, now, orow.id);
      }
      this.stmt(
        `UPDATE persistent_agent_connections SET is_current = 1, swap_state = NULL, swap_error = NULL, updated_at = ?
          WHERE id = ? AND swap_state = 'activating'`,
      ).run(now, n);
      if (orow) {
        this.stmt(
          `UPDATE persistent_agent_messages
              SET connection_id = ?, claim_generation = NULL, next_attempt_at = NULL, updated_at = ?
            WHERE connection_id = ? AND direction = 'out' AND send_state = 'queued'`,
        ).run(n, now, orow.id);
        if (orow.kind === 'bridge') {
          this.stmt(
            `UPDATE persistent_agent_messages
                SET connection_id = ?, send_state = 'queued', sent_at = NULL, remote_out_seq = NULL, remote_event_id = NULL,
                    claim_generation = NULL, next_attempt_at = NULL, send_attempts = 0, reconcile_attempts = 0, updated_at = ?
              WHERE connection_id = ? AND direction = 'out'
                AND (send_state = 'ambiguous' OR (send_state = 'on_bridge' AND picked_up_at IS NULL))`,
          ).run(n, now, orow.id);
        } else {
          this.stmt(
            `UPDATE persistent_agent_messages
                SET send_state = 'failed', last_error = ?, next_attempt_at = NULL, updated_at = ?
              WHERE connection_id = ? AND direction = 'out' AND send_state = 'ambiguous'`,
          ).run(UNDELIVERABLE_COPY, now, orow.id);
        }
      }
      const toName = names?.to ?? nrow.connector_id;
      const fromName = names?.from ?? orow?.connector_id ?? 'the previous connection';
      const noteId = this.newId();
      this.stmt(
        `INSERT INTO persistent_agent_messages (id, agent_id, connection_id, direction, author, kind, body,
           remote_event_id, created_at, updated_at)
         VALUES (?, ?, ?, 'local', 'local', 'system', ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      ).run(
        noteId, nrow.agent_id, n,
        `Switched to ${toName} (from ${fromName}). Branch prefix cf/${agent?.handle ?? ''}/ is unchanged.`,
        `swap:${n}`, now, now,
      );
      return {
        result: true,
        emits: [PersistentAgentStore.a('connection', nrow.agent_id), PersistentAgentStore.th(nrow.agent_id, 'messages', [noteId])],
      };
    });
  }

  async failSwap(
    n: string,
    reason: string,
    opts: { revokeNew: boolean; fromStates: readonly SwapState[] },
  ): Promise<boolean> {
    return this.write(this.keyForConnection(n), () => {
      const nrow = this.getConnectionRow(n);
      if (!nrow || nrow.swap_state === null || !(opts.fromStates as readonly string[]).includes(nrow.swap_state)) {
        return { result: false, emits: [] };
      }
      const ok = this.failSwapInTxn(nrow, reason, opts.revokeNew, this.iso());
      return { result: ok, emits: ok ? [PersistentAgentStore.a('connection', nrow.agent_id)] : [] };
    });
  }

  /** Current connection → revoked (+ remote revoke pending); an in-progress swap fails. Queued outbound stays queued. */
  async disconnectAgent(agentId: string): Promise<DisconnectAgentResult> {
    return this.write(agentId, () => {
      const now = this.iso();
      if (!this.getAgentRow(agentId)) throw new AgentNotFoundError(agentId);
      const cur = this.getCurrentConnection(agentId);
      if (!cur) throw new AgentNotSendableError('no_connection');
      this.stmt(
        `UPDATE persistent_agent_connections
            SET state = 'revoked',
                remote_revoke_state = CASE WHEN remote_revoke_state IS NOT NULL THEN remote_revoke_state
                                           WHEN remote_id IS NULL THEN 'done' ELSE 'pending' END,
                remote_revoke_next_at = CASE WHEN remote_revoke_state IS NOT NULL THEN remote_revoke_next_at ELSE ? END,
                updated_at = ?
          WHERE id = ?`,
      ).run(now, now, cur.id);
      const swap = this.getSwapTarget(agentId);
      if (swap) this.failSwapInTxn(swap, 'Disconnected', true, now);
      let lastReference = false;
      if (cur.credential_id !== null) {
        const other = this.stmt(
          `SELECT 1 FROM persistent_agent_connections c JOIN persistent_agents a ON a.id = c.agent_id
            WHERE c.credential_id = ? AND c.id != ? AND a.archived_at IS NULL AND c.state != 'revoked' LIMIT 1`,
        ).get(cur.credential_id, cur.id);
        lastReference = other === undefined;
      }
      return {
        result: { connectionId: cur.id, credentialId: cur.credential_id, lastReference },
        emits: [PersistentAgentStore.a('connection', agentId)],
      };
    });
  }

  /** Requires the current connection to be revoked (or absent); fails a pending reconnect. */
  async archiveAgent(agentId: string): Promise<void> {
    await this.write(agentId, () => {
      const now = this.iso();
      const agent = this.getAgentRow(agentId);
      if (!agent) throw new AgentNotFoundError(agentId);
      const cur = this.getCurrentConnection(agentId);
      if (cur && cur.state !== 'revoked') throw new InvalidAgentInputError('Disconnect this agent before archiving it.');
      const swap = this.getSwapTarget(agentId);
      if (swap) this.failSwapInTxn(swap, 'Archived', true, now);
      this.stmt('UPDATE persistent_agents SET archived_at = COALESCE(archived_at, ?), updated_at = ? WHERE id = ?')
        .run(now, now, agentId);
      return { result: undefined, emits: [PersistentAgentStore.a('agents', agentId)] };
    });
    const q = this.queues.get(agentId);
    if (q && q.size === 0 && q.pending === 0) this.queues.delete(agentId);
  }

  async markThreadRead(agentId: string, upToMessageId?: string): Promise<{ unread: number }> {
    return this.write(agentId, () => {
      const now = this.iso();
      const upTo = upToMessageId ?? null;
      const r = this.stmt(
        `UPDATE persistent_agent_messages SET read_at = ?, updated_at = ?
          WHERE agent_id = ? AND direction = 'in' AND read_at IS NULL
            AND (? IS NULL OR (created_at, rowid) <= (SELECT created_at, rowid FROM persistent_agent_messages WHERE id = ?))`,
      ).run(now, now, agentId, upTo, upTo);
      const unread = this.unreadCount(agentId);
      const emits = r.changes > 0
        ? [PersistentAgentStore.th(agentId, 'read', []), PersistentAgentStore.a('unread', agentId)]
        : [];
      return { result: { unread }, emits };
    });
  }

  // -------------------------------------------------------------------------
  // Credentials (ciphertext only; plaintext never enters the store)
  // -------------------------------------------------------------------------

  async insertCredential(c: { vendor: VendorCredentialVendor; label: string; cipher: Buffer; fingerprint: string }): Promise<{ id: string }> {
    const id = this.newId();
    return this.write(CREDENTIALS_QUEUE, () => {
      const now = this.iso();
      this.stmt(
        `INSERT INTO vendor_credentials (id, vendor, label, secret_ciphertext, fingerprint, state, version,
           last_error, last_verified_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'ok', 1, NULL, NULL, ?, ?)`,
      ).run(id, c.vendor, c.label, c.cipher, c.fingerprint, now, now);
      return { result: { id }, emits: [PersistentAgentStore.a('credentials', null)] };
    });
  }

  async rotateCredential(id: string, cipher: Buffer, fingerprint: string): Promise<{ version: number; reopenedConnectionIds: string[] }> {
    return this.write(CREDENTIALS_QUEUE, () => {
      const now = this.iso();
      const r = this.stmt(
        `UPDATE vendor_credentials SET secret_ciphertext = ?, fingerprint = ?, version = version + 1, state = 'ok',
            last_error = NULL, updated_at = ?
          WHERE id = ?`,
      ).run(cipher, fingerprint, now, id);
      if (r.changes !== 1) throw new CredentialNotFoundError(id);
      const reopened = this.stmt(
        `UPDATE persistent_agent_connections SET auth_retry_at = ?, updated_at = ?
          WHERE credential_id = ? AND state = 'auth_failed'
        RETURNING id, agent_id`,
      ).all(now, now, id) as Array<{ id: string; agent_id: string }>;
      const version = (this.stmt('SELECT version FROM vendor_credentials WHERE id = ?').get(id) as { version: number }).version;
      return {
        result: { version, reopenedConnectionIds: reopened.map((x) => x.id) },
        emits: [
          PersistentAgentStore.a('credentials', null),
          ...reopened.map((x) => PersistentAgentStore.a('connection', x.agent_id)),
        ],
      };
    });
  }

  async setCredentialState(id: string, state: VendorCredentialState, lastError: string | null): Promise<void> {
    return this.write(CREDENTIALS_QUEUE, () => {
      const r = this.stmt('UPDATE vendor_credentials SET state = ?, last_error = ?, updated_at = ? WHERE id = ?')
        .run(state, cut(lastError, MAX_ERROR_CHARS), this.iso(), id);
      if (r.changes !== 1) throw new CredentialNotFoundError(id);
      return { result: undefined, emits: [PersistentAgentStore.a('credentials', null)] };
    });
  }

  async forgetCredential(
    id: string,
    detach: boolean,
  ): Promise<{ forgotten: true } | { forgotten: false; referencedBy: CredentialReference[] }> {
    return this.write<{ forgotten: true } | { forgotten: false; referencedBy: CredentialReference[] }>(CREDENTIALS_QUEUE, () => {
      const now = this.iso();
      if (this.getCredentialRow(id) === null) throw new CredentialNotFoundError(id);
      const refs = this.listCredentialReferenceRows(id).map((r) => ({
        agentId: r.agent_id, displayName: r.display_name, connectionId: r.connection_id,
      }));
      if (refs.length > 0 && !detach) return { result: { forgotten: false as const, referencedBy: refs }, emits: [] };
      const detached = this.stmt(
        `UPDATE persistent_agent_connections
            SET state = 'auth_failed', error_kind = 'credential_forgotten', last_error = 'API key was removed',
                credential_id = NULL, updated_at = ?
          WHERE credential_id = ? AND state != 'revoked'
        RETURNING agent_id`,
      ).all(now, id) as Array<{ agent_id: string }>;
      this.stmt('DELETE FROM vendor_credentials WHERE id = ?').run(id);
      const agents = new Set(detached.map((d) => d.agent_id));
      return {
        result: { forgotten: true as const },
        emits: [
          PersistentAgentStore.a('credentials', null),
          ...[...agents].map((a) => PersistentAgentStore.a('connection', a)),
        ],
      };
    });
  }

  async pruneEvents(olderThanIso: string): Promise<number> {
    return this.write(GLOBAL_QUEUE, () => {
      const r = this.stmt('DELETE FROM persistent_agent_events WHERE created_at < ?').run(olderThanIso);
      return { result: r.changes, emits: [] };
    });
  }

  // -------------------------------------------------------------------------
  // Reads (sync, unqueued)
  // -------------------------------------------------------------------------

  getAgentRow(id: string): AgentRow | null {
    return (this.stmt('SELECT * FROM persistent_agents WHERE id = ?').get(id) as AgentRow | undefined) ?? null;
  }

  getConnectionRow(id: string): ConnectionRow | null {
    return (this.stmt('SELECT * FROM persistent_agent_connections WHERE id = ?').get(id) as ConnectionRow | undefined) ?? null;
  }

  getCurrentConnection(agentId: string): ConnectionRow | null {
    return (this.stmt('SELECT * FROM persistent_agent_connections WHERE agent_id = ? AND is_current = 1')
      .get(agentId) as ConnectionRow | undefined) ?? null;
  }

  getSwapTarget(agentId: string): ConnectionRow | null {
    return (this.stmt('SELECT * FROM persistent_agent_connections WHERE agent_id = ? AND swap_state IS NOT NULL')
      .get(agentId) as ConnectionRow | undefined) ?? null;
  }

  getMessageRow(id: string): MessageRow | null {
    return (this.stmt('SELECT rowid AS _rowid, * FROM persistent_agent_messages WHERE id = ?')
      .get(id) as MessageRow | undefined) ?? null;
  }

  listConnectionsForConnector(connectorId: string): ConnectionRow[] {
    return this.stmt('SELECT * FROM persistent_agent_connections WHERE connector_id = ?').all(connectorId) as ConnectionRow[];
  }

  unreadCount(agentId: string): number {
    return (this.stmt(`SELECT COUNT(*) AS n FROM persistent_agent_messages WHERE agent_id = ? AND ${UNREAD_PREDICATE}`)
      .get(agentId) as { n: number }).n;
  }

  /** Everything listAgents needs, one query per table, joined in JS. */
  listAgentsWithConnections(includeArchived: boolean): AgentListData {
    const agents = this.stmt(
      `SELECT * FROM persistent_agents WHERE (? = 1 OR archived_at IS NULL) ORDER BY created_at ASC, rowid ASC`,
    ).all(includeArchived ? 1 : 0) as AgentRow[];
    const conns = this.stmt(
      `SELECT * FROM persistent_agent_connections
        WHERE is_current = 1 OR swap_state IS NOT NULL OR swap_error IS NOT NULL
           OR (is_current = 0 AND swap_state IS NULL
               AND (remote_revoke_state = 'gave_up' OR (remote_revoke_state = 'pending' AND remote_revoke_attempts >= 3)))
        ORDER BY created_at ASC, rowid ASC`,
    ).all() as ConnectionRow[];
    const connections = new Map<string, AgentConnectionsData>();
    const lastSwitchAt = new Map<string, string>();
    for (const a of agents) connections.set(a.id, { current: null, swap: null, retired: [], lastSwitchError: null });
    for (const c of conns) {
      const entry = connections.get(c.agent_id);
      if (!entry) continue;
      if (c.is_current === 1) entry.current = c;
      if (c.swap_state !== null) entry.swap = c;
      if (c.is_current === 0 && c.swap_state === null
        && (c.remote_revoke_state === 'gave_up' || (c.remote_revoke_state === 'pending' && c.remote_revoke_attempts >= 3))) {
        entry.retired.push(c);
      }
      if (c.swap_error !== null && (lastSwitchAt.get(c.agent_id) ?? '') <= c.updated_at) {
        lastSwitchAt.set(c.agent_id, c.updated_at);
        entry.lastSwitchError = c.swap_error;
      }
    }
    const unread = new Map<string, number>();
    for (const r of this.stmt(
      `SELECT agent_id, COUNT(*) AS n FROM persistent_agent_messages WHERE ${UNREAD_PREDICATE} GROUP BY agent_id`,
    ).all() as Array<{ agent_id: string; n: number }>) unread.set(r.agent_id, r.n);
    const lastMessageAt = new Map<string, string>();
    for (const r of this.stmt(
      'SELECT agent_id, MAX(created_at) AS at FROM persistent_agent_messages GROUP BY agent_id',
    ).all() as Array<{ agent_id: string; at: string }>) lastMessageAt.set(r.agent_id, r.at);
    const credentials = new Map<string, CredentialRow>();
    for (const c of this.listCredentialRows()) credentials.set(c.id, c);
    return { agents, connections, unread, lastMessageAt, credentials };
  }

  /** Newest `limit` messages before `before` (a message id), returned oldest → newest. */
  getThreadPage(agentId: string, before: string | null, limit: number): { rows: MessageRow[]; hasMore: boolean } {
    const rows = this.stmt(
      `SELECT rowid AS _rowid, * FROM persistent_agent_messages
        WHERE agent_id = ?
          AND (? IS NULL OR (created_at, rowid) < (SELECT created_at, rowid FROM persistent_agent_messages WHERE id = ?))
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`,
    ).all(agentId, before, before, limit + 1) as MessageRow[];
    const hasMore = rows.length > limit;
    return { rows: rows.slice(0, limit).reverse(), hasMore };
  }

  listActivity(agentId: string, scope: string | null, limit: number): EventRow[] {
    return this.stmt(
      `SELECT * FROM persistent_agent_events
        WHERE agent_id = ? AND type != 'late_receipt' AND (? IS NULL OR remote_scope = ?)
        ORDER BY occurred_at DESC, rowid DESC LIMIT ?`,
    ).all(agentId, scope, scope, limit) as EventRow[];
  }

  listUsage(agentId: string): UsageRow[] {
    return this.stmt('SELECT * FROM persistent_agent_usage WHERE agent_id = ? ORDER BY computed_at ASC')
      .all(agentId) as UsageRow[];
  }

  /**
   * Connections the pump pulls: live current/swap-target rows, plus every Bridge row whose remote revoke
   * is still pending (its relay mailbox is alive until the revoke lands, so it keeps being drained).
   */
  listPumpTargets(): PumpTargetRow[] {
    return this.stmt(
      `SELECT c.id, c.agent_id, c.connector_id, c.kind, c.state, c.is_current, c.swap_state, c.remote_revoke_state,
              c.created_at, c.last_seen_at, c.remote_status_json, c.rate_limited_until, c.auth_retry_at
         FROM persistent_agent_connections c
         JOIN persistent_agents a ON a.id = c.agent_id
        WHERE c.connect_state IS NULL
          AND a.archived_at IS NULL
          AND (
                ((c.is_current = 1 OR c.swap_state = 'awaiting_verify')
                  AND (c.state IN ('pending', 'verified', 'stale') OR (c.state = 'auth_failed' AND c.auth_retry_at IS NOT NULL)))
             OR (c.kind = 'bridge' AND c.remote_revoke_state = 'pending')
              )
        ORDER BY c.created_at ASC`,
    ).all() as PumpTargetRow[];
  }

  /** Agents with outbound rows a run can act on now (rows parked on a revoked/auth_failed connection excluded). */
  listAgentsWithDueOutbound(nowIso: string): string[] {
    return (this.stmt(
      `SELECT DISTINCT m.agent_id
         FROM persistent_agent_messages m
         JOIN persistent_agent_connections c ON c.id = m.connection_id
         JOIN persistent_agents a ON a.id = m.agent_id
        WHERE m.direction = 'out' AND m.send_state IN ('queued', 'ambiguous')
          AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= ?)
          AND a.archived_at IS NULL
          AND c.state NOT IN ('revoked', 'auth_failed')
          AND c.connect_state IS NULL
          AND (c.rate_limited_until IS NULL OR c.rate_limited_until <= ?)`,
    ).all(nowIso, nowIso) as Array<{ agent_id: string }>).map((r) => r.agent_id);
  }

  /** Exactly the claim's predicates: would claimOutbound(agentId, now) return a row? */
  hasClaimable(agentId: string, nowIso: string): boolean {
    return this.stmt(CLAIM_INNER_SELECT).get(agentId, nowIso, nowIso) !== undefined;
  }

  /** Ambiguous rows due for reconcile; `nowIso` null ignores their schedule (swap reconcile). */
  listAmbiguous(connectionId: string, nowIso: string | null, limit: number): MessageRow[] {
    return this.stmt(
      `SELECT rowid AS _rowid, * FROM persistent_agent_messages
        WHERE connection_id = ? AND direction = 'out' AND send_state = 'ambiguous'
          AND (? IS NULL OR next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY created_at ASC, rowid ASC LIMIT ?`,
    ).all(connectionId, nowIso, nowIso, limit) as MessageRow[];
  }

  countInFlight(connectionId: string): number {
    return (this.stmt(
      `SELECT COUNT(*) AS n FROM persistent_agent_messages
        WHERE connection_id = ? AND direction = 'out' AND send_state IN ('in_flight', 'creating')`,
    ).get(connectionId) as { n: number }).n;
  }

  hasQueuedProbe(connectionId: string): boolean {
    return this.stmt(
      `SELECT 1 FROM persistent_agent_messages
        WHERE connection_id = ? AND is_probe = 1 AND send_state IN ('queued', 'in_flight', 'creating') LIMIT 1`,
    ).get(connectionId) !== undefined;
  }

  listRevokeDue(nowIso: string): ConnectionRow[] {
    return this.stmt(
      `SELECT * FROM persistent_agent_connections
        WHERE remote_revoke_state = 'pending' AND (remote_revoke_next_at IS NULL OR remote_revoke_next_at <= ?)
        ORDER BY remote_revoke_next_at ASC`,
    ).all(nowIso) as ConnectionRow[];
  }

  listResumableSwaps(): ConnectionRow[] {
    return this.stmt('SELECT * FROM persistent_agent_connections WHERE swap_state IS NOT NULL').all() as ConnectionRow[];
  }

  listCreatingRemote(): ConnectionRow[] {
    return this.stmt(`SELECT * FROM persistent_agent_connections WHERE connect_state = 'creating_remote'`).all() as ConnectionRow[];
  }

  findConnectionIdByRemoteId(connectorId: string, remoteId: string): string | null {
    const r = this.stmt('SELECT id FROM persistent_agent_connections WHERE connector_id = ? AND remote_id = ?')
      .get(connectorId, remoteId) as { id: string } | undefined;
    return r?.id ?? null;
  }

  lastOutboundAtByAgent(): Map<string, string> {
    const m = new Map<string, string>();
    for (const r of this.stmt(
      `SELECT agent_id, MAX(created_at) AS at FROM persistent_agent_messages WHERE direction = 'out' AND author = 'user' GROUP BY agent_id`,
    ).all() as Array<{ agent_id: string; at: string }>) m.set(r.agent_id, r.at);
    return m;
  }

  /** The connector wiring's directory: live, non-revoked current or swap rows of one connector. */
  listHandleRows(connectorId: string): ConnectionRow[] {
    return this.stmt(
      `SELECT c.* FROM persistent_agent_connections c JOIN persistent_agents a ON a.id = c.agent_id
        WHERE c.connector_id = ? AND c.connect_state IS NULL AND a.archived_at IS NULL AND c.state != 'revoked'
          AND (c.is_current = 1 OR c.swap_state IS NOT NULL)
        ORDER BY c.created_at ASC`,
    ).all(connectorId) as ConnectionRow[];
  }

  /** The ONLY method that returns ciphertext (read solely by CredentialService.secret). */
  getCredentialCiphertext(id: string): { cipher: Buffer; version: number; state: string } | null {
    const r = this.stmt('SELECT secret_ciphertext, version, state FROM vendor_credentials WHERE id = ?')
      .get(id) as { secret_ciphertext: Buffer; version: number; state: string } | undefined;
    return r ? { cipher: r.secret_ciphertext, version: r.version, state: r.state } : null;
  }

  getCredentialRow(id: string): CredentialRow | null {
    return (this.stmt(
      `SELECT id, vendor, label, fingerprint, state, version, last_error, last_verified_at, created_at, updated_at
         FROM vendor_credentials WHERE id = ?`,
    ).get(id) as CredentialRow | undefined) ?? null;
  }

  listCredentialRows(): CredentialRow[] {
    return this.stmt(
      `SELECT id, vendor, label, fingerprint, state, version, last_error, last_verified_at, created_at, updated_at
         FROM vendor_credentials ORDER BY created_at ASC, rowid ASC`,
    ).all() as CredentialRow[];
  }

  /** Live references (agent not archived; connection not revoked unless it is a swap target). */
  listCredentialReferenceRows(credentialId?: string): CredentialReferenceRow[] {
    return this.stmt(
      `SELECT c.credential_id, c.id AS connection_id, a.id AS agent_id, a.display_name
         FROM persistent_agent_connections c JOIN persistent_agents a ON a.id = c.agent_id
        WHERE c.credential_id IS NOT NULL AND (? IS NULL OR c.credential_id = ?) AND a.archived_at IS NULL
          AND (c.state != 'revoked' OR c.swap_state IS NOT NULL)
        ORDER BY c.created_at ASC`,
    ).all(credentialId ?? null, credentialId ?? null) as CredentialReferenceRow[];
  }

  /** Non-revoked connections using a credential (undecryptable fan-out). */
  listConnectionIdsForCredential(credentialId: string): string[] {
    return (this.stmt(
      `SELECT id FROM persistent_agent_connections WHERE credential_id = ? AND state != 'revoked'`,
    ).all(credentialId) as Array<{ id: string }>).map((r) => r.id);
  }

  /** Swap states every disconnect may cancel. */
  static readonly ALL_SWAP_STATES = ALL_SWAP_STATES;
}
