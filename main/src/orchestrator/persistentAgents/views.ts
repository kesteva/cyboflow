/**
 * Pure row → view builders for persistent agents (main → renderer shapes from shared/types/persistentAgents).
 *
 * The connector lookup is passed in as a function typed with `import type` only, so this orchestrator file
 * never imports services/* at runtime. No secret column is ever read here (CredentialRow has no ciphertext).
 */
import {
  REVOKE_SURFACE_AFTER,
  type ActivityView,
  type AgentView,
  type ConnectorAvailability,
  type ConnectionView,
  type CredentialReference,
  type CredentialView,
  type LinkView,
  type PairedClientView,
  type PendingSwitchView,
  type RetiredConnectionView,
  type ThreadMessageView,
  type UsageCoverage,
  type UsageView,
  type VerifyFact,
} from '../../../../shared/types/persistentAgents';
import type { AgentConnector, ConnectionHandle } from '../../services/persistentAgents/connectorContract';
import type { AgentConnectionsData } from './persistentAgentStore';
import {
  parseCapabilities,
  parseLinks,
  parseRemote,
  parseRemoteStatus,
  parseVerifyFacts,
  toActivityType,
  toConnectionHandle,
  toConnectionState,
  toConnectorKind,
  toCredentialState,
  toCredentialVendor,
  toMessageAuthor,
  toMessageDirection,
  toMessageKind,
  toRemoteRevokeState,
  toSendState,
  toSwapState,
  toTransport,
  toUsageCoverage,
  toVendor,
  type AgentRow,
  type ConnectionRow,
  type CredentialRow,
  type EventRow,
  type MessageRow,
  type UsageRow,
} from './rows';

/** The slice of a registered connector the views need. */
export type ViewConnector = Pick<AgentConnector, 'definition' | 'availability'> & Partial<Pick<AgentConnector, 'describeFacts'>>;
/** Registered connector by id, or undefined when not registered in this build. */
export type ConnectorLookup = (connectorId: string) => ViewConnector | undefined;

export const CONNECTOR_DISABLED_COPY = 'Connector disabled';
export const DISABLED_AVAILABILITY: ConnectorAvailability = {
  state: 'disabled', message: CONNECTOR_DISABLED_COPY, retryAt: null,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function toLinkViews(urls: readonly string[]): LinkView[] {
  const out: LinkView[] = [];
  for (const url of urls) {
    const domain = hostOf(url);
    if (domain !== null) out.push({ url, domain });
  }
  return out;
}

/** remote_json.pairedClient → view (pairedAt epoch ms or ISO → ISO); anything malformed → null. */
export function toPairedClientView(remote: Record<string, unknown>): PairedClientView | null {
  const p = remote.pairedClient;
  if (!isRecord(p) || typeof p.redirectHost !== 'string') return null;
  let pairedAt: string | null = null;
  if (typeof p.pairedAt === 'number' && Number.isFinite(p.pairedAt)) pairedAt = new Date(p.pairedAt).toISOString();
  else if (typeof p.pairedAt === 'string' && !Number.isNaN(Date.parse(p.pairedAt))) pairedAt = new Date(p.pairedAt).toISOString();
  if (pairedAt === null) return null;
  return { name: typeof p.name === 'string' ? p.name : null, redirectHost: p.redirectHost, pairedAt };
}

export interface ConnectionViewContext {
  lookup: ConnectorLookup;
  agent: AgentRow;
  credentials: ReadonlyMap<string, CredentialRow>;
}

/** The handle for availability(h)/describeFacts(h). */
export function handleForView(conn: ConnectionRow, ctx: ConnectionViewContext): ConnectionHandle {
  const cred = conn.credential_id !== null ? ctx.credentials.get(conn.credential_id) ?? null : null;
  return toConnectionHandle(conn, ctx.agent, cred ? cred.version : null);
}

/** Live facts when the connector implements describeFacts, else the stored verify_json ([] on failure). */
export function factsFor(conn: ConnectionRow, ctx: ConnectionViewContext): VerifyFact[] {
  const connector = ctx.lookup(conn.connector_id);
  if (connector?.describeFacts) {
    try {
      return connector.describeFacts(handleForView(conn, ctx));
    } catch {
      return parseVerifyFacts(conn.verify_json);
    }
  }
  return parseVerifyFacts(conn.verify_json);
}

export function buildConnectionView(conn: ConnectionRow, ctx: ConnectionViewContext): ConnectionView {
  const connector = ctx.lookup(conn.connector_id);
  const remote = parseRemote(conn.remote_json);
  const cred = conn.credential_id !== null ? ctx.credentials.get(conn.credential_id) ?? null : null;
  let availability: ConnectorAvailability = DISABLED_AVAILABILITY;
  if (connector) {
    try {
      availability = connector.availability(handleForView(conn, ctx));
    } catch {
      availability = DISABLED_AVAILABILITY;
    }
  }
  const mcpUrl = typeof remote.mcpUrl === 'string' ? remote.mcpUrl : null;
  const httpBase = typeof remote.httpBase === 'string' ? remote.httpBase : null;
  const revokeState = toRemoteRevokeState(conn.remote_revoke_state);
  return {
    id: conn.id,
    kind: toConnectorKind(conn.kind),
    connectorId: conn.connector_id,
    connectorVersion: conn.connector_version,
    connectorDisplayName: connector ? connector.definition.displayName : CONNECTOR_DISABLED_COPY,
    transport: toTransport(conn.transport),
    state: toConnectionState(conn.state),
    isCurrent: conn.is_current === 1,
    lastSeenAt: conn.last_seen_at,
    verifiedAt: conn.verified_at,
    createdAt: conn.created_at,
    remoteStatus: parseRemoteStatus(conn.remote_status_json),
    rateLimitedUntil: conn.rate_limited_until,
    capabilities: parseCapabilities(conn.capabilities_json, connector?.definition.capabilities),
    availability,
    credential: cred
      ? { id: cred.id, label: cred.label, fingerprint: cred.fingerprint, state: toCredentialState(cred.state) }
      : null,
    endpoints: mcpUrl !== null || httpBase !== null ? { mcpUrl, httpBase } : null,
    pairedClient: toPairedClientView(remote),
    verifyFacts: factsFor(conn, ctx),
    remoteRevoke: revokeState === null
      ? null
      : {
        state: revokeState,
        attempts: conn.remote_revoke_attempts,
        lastError: conn.remote_revoke_error,
        surfaced: conn.remote_revoke_attempts >= REVOKE_SURFACE_AFTER,
      },
    lastError: conn.last_error,
  };
}

export interface AgentViewInput {
  agent: AgentRow;
  connections: AgentConnectionsData;
  unreadCount: number;
  lastMessageAt: string | null;
  credentials: ReadonlyMap<string, CredentialRow>;
}

export function buildAgentView(input: AgentViewInput, lookup: ConnectorLookup): AgentView {
  const ctx: ConnectionViewContext = { lookup, agent: input.agent, credentials: input.credentials };
  const { current, swap, retired } = input.connections;
  let pendingSwitch: PendingSwitchView | null = null;
  if (swap) {
    const swapState = toSwapState(swap.swap_state);
    if (swapState !== null) {
      pendingSwitch = {
        connectionId: swap.id,
        swapState,
        startedAt: swap.swap_started_at ?? swap.created_at,
        connection: buildConnectionView(swap, ctx),
      };
    }
  }
  const retiredConnections: RetiredConnectionView[] = [];
  for (const r of retired) {
    const state = r.remote_revoke_state;
    if (state !== 'pending' && state !== 'gave_up') continue;
    const connector = lookup(r.connector_id);
    retiredConnections.push({
      connectionId: r.id,
      connectorDisplayName: connector ? connector.definition.displayName : CONNECTOR_DISABLED_COPY,
      remoteRevoke: { state, attempts: r.remote_revoke_attempts, lastError: r.remote_revoke_error },
    });
  }
  return {
    id: input.agent.id,
    handle: input.agent.handle,
    displayName: input.agent.display_name,
    vendor: toVendor(input.agent.vendor),
    githubLogin: input.agent.github_login,
    archivedAt: input.agent.archived_at,
    createdAt: input.agent.created_at,
    unreadCount: input.unreadCount,
    lastMessageAt: input.lastMessageAt,
    connection: current ? buildConnectionView(current, ctx) : null,
    pendingSwitch,
    lastSwitchError: input.connections.lastSwitchError,
    retiredConnections,
  };
}

/** COALESCE(lastMessageAt, createdAt) DESC (ISO strings sort lexically). */
export function sortAgentViews(views: AgentView[]): AgentView[] {
  return [...views].sort((a, b) => {
    const ka = a.lastMessageAt ?? a.createdAt;
    const kb = b.lastMessageAt ?? b.createdAt;
    return ka < kb ? 1 : ka > kb ? -1 : 0;
  });
}

function parseDelivery(json: string | null): ThreadMessageView['delivery'] {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    if (!isRecord(v) || typeof v.prUrl !== 'string') return null;
    const prDomain = hostOf(v.prUrl);
    if (prDomain === null) return null;
    return {
      prUrl: v.prUrl,
      prDomain,
      summary: typeof v.summary === 'string' ? v.summary : null,
      briefId: typeof v.briefId === 'string' ? v.briefId : null,
    };
  } catch {
    return null;
  }
}

export function buildThreadMessageView(row: MessageRow): ThreadMessageView {
  const direction = toMessageDirection(row.direction);
  const outbound = direction === 'out';
  return {
    id: row.id,
    connectionId: row.connection_id,
    direction,
    author: toMessageAuthor(row.author),
    kind: toMessageKind(row.kind),
    body: row.body,
    links: toLinkViews(parseLinks(row.links_json)),
    delivery: parseDelivery(row.delivery_json),
    createdAt: row.created_at,
    remoteCreatedAt: row.remote_created_at,
    isProbe: row.is_probe === 1,
    sendState: outbound && row.send_state !== null ? toSendState(row.send_state) : null,
    sendAttempts: outbound ? row.send_attempts : 0,
    nextAttemptAt: outbound ? row.next_attempt_at : null,
    lastError: outbound ? row.last_error : null,
    sentAt: outbound ? row.sent_at : null,
    pickedUpAt: outbound ? row.picked_up_at : null,
    remoteAck: outbound && (row.remote_ack === 'acked' || row.remote_ack === 'declined') ? row.remote_ack : null,
    readAt: direction === 'in' ? row.read_at : null,
  };
}

export function buildCredentialView(row: CredentialRow, refs: readonly CredentialReference[]): CredentialView {
  return {
    id: row.id,
    vendor: toCredentialVendor(row.vendor),
    label: row.label,
    fingerprint: row.fingerprint,
    state: toCredentialState(row.state),
    version: row.version,
    lastVerifiedAt: row.last_verified_at,
    createdAt: row.created_at,
    referencedBy: [...refs],
  };
}

export function buildActivityView(row: EventRow): ActivityView {
  return {
    id: row.id,
    connectionId: row.connection_id,
    remoteScope: row.remote_scope,
    type: toActivityType(row.type),
    summary: row.summary,
    payloadJson: row.payload_json,
    occurredAt: row.occurred_at,
  };
}

const COVERAGE_RANK: Record<UsageCoverage, number> = { partial: 0, 'vendor-cumulative': 1, complete: 2 };

export function buildUsageView(agentId: string, rows: readonly UsageRow[]): UsageView {
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, activeSeconds: 0 };
  let coverage: UsageCoverage | 'none' = 'none';
  const out = rows.map((r) => {
    const c = toUsageCoverage(r.coverage);
    if (coverage === 'none' || COVERAGE_RANK[c] < COVERAGE_RANK[coverage]) coverage = c;
    totals.inputTokens += r.input_tokens ?? 0;
    totals.outputTokens += r.output_tokens ?? 0;
    totals.cacheReadTokens += r.cache_read_tokens ?? 0;
    totals.cacheCreationTokens += r.cache_creation_tokens ?? 0;
    totals.costUsd += r.cost_usd ?? 0;
    totals.activeSeconds += r.active_seconds ?? 0;
    return {
      connectionId: r.connection_id,
      remoteScope: r.remote_scope,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheCreationTokens: r.cache_creation_tokens,
      costUsd: r.cost_usd,
      activeSeconds: r.active_seconds,
      coverage: c,
      computedAt: r.computed_at,
    };
  });
  return { agentId, rows: out, totals, coverage };
}
