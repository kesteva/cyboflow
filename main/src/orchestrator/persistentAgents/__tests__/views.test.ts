/**
 * Pure view builders: ConnectionView endpoints / pairedClient / availability / verifyFacts / remoteRevoke,
 * AgentView retired connections and ordering, thread message views, usage coverage.
 */
import { describe, it, expect } from 'vitest';
import {
  buildAgentView,
  buildConnectionView,
  buildThreadMessageView,
  buildUsageView,
  sortAgentViews,
  type ConnectorLookup,
  type ViewConnector,
} from '../views';
import type { AgentRow, ConnectionRow, MessageRow, UsageRow } from '../rows';
import { BRIDGE_FIXTURE_DEFINITION } from '../../../../../shared/types/__tests__/persistentAgentsFixtures';
import type { AgentView, ConnectorAvailability } from '../../../../../shared/types/persistentAgents';

const NOW = '2026-10-07T12:00:00.000Z';

const agent: AgentRow = {
  id: 'a1', handle: 'dot', display_name: 'Dot', vendor: 'openai-dots', github_login: null, archived_at: null,
  created_at: NOW, updated_at: NOW,
};

function connRow(over: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: 'c1', agent_id: 'a1', kind: 'bridge', connector_id: 'bridge', connector_version: 1, transport: 'relay-mcp',
    state: 'pending', credential_id: null, remote_id: 'r1',
    remote_json: JSON.stringify({ mcpUrl: 'https://relay.test/mcp/r1', httpBase: 'https://relay.test/h/r1', pairedClient: { name: 'ChatGPT', redirectHost: 'chatgpt.com', pairedAt: Date.parse(NOW) } }),
    inbound_cursor: null, relay_epoch: 1,
    capabilities_json: JSON.stringify({ descriptor: BRIDGE_FIXTURE_DEFINITION.capabilities, descriptorVersion: 1, observed: {} }),
    verify_json: JSON.stringify([{ key: 'pairing-issued', label: 'Pairing code issued', at: NOW, status: 'done' }]),
    is_current: 1, generation: 1, connect_state: null, swap_state: null, swap_from_connection_id: null, swap_started_at: null,
    swap_error: null, remote_revoke_state: null, remote_revoke_attempts: 0, remote_revoke_next_at: null, remote_revoke_error: null,
    remote_status_json: null, rate_limited_until: null, auth_retry_at: null, error_kind: null, last_error: null,
    last_seen_at: null, verified_at: null, replaced_at: null, created_at: NOW, updated_at: NOW,
    ...over,
  };
}

const OK: ConnectorAvailability = { state: 'ok', message: null, retryAt: null };
function lookupWith(c: Partial<ViewConnector> = {}): ConnectorLookup {
  const connector: ViewConnector = { definition: BRIDGE_FIXTURE_DEFINITION, availability: () => OK, ...c };
  return (id) => (id === 'bridge' ? connector : undefined);
}
const none: ConnectorLookup = () => undefined;
const ctx = (lookup: ConnectorLookup) => ({ lookup, agent, credentials: new Map() });

describe('buildConnectionView', () => {
  it('reads endpoints and pairedClient (epoch ms → ISO) from remote_json', () => {
    const v = buildConnectionView(connRow(), ctx(lookupWith()));
    expect(v.endpoints).toEqual({ mcpUrl: 'https://relay.test/mcp/r1', httpBase: 'https://relay.test/h/r1' });
    expect(v.pairedClient).toEqual({ name: 'ChatGPT', redirectHost: 'chatgpt.com', pairedAt: NOW });
    expect(v.connectorDisplayName).toBe('cyboflow Bridge');
    expect(v.availability).toEqual(OK);
  });

  it('endpoints and pairedClient are null when remote_json lacks them', () => {
    const v = buildConnectionView(connRow({ remote_json: JSON.stringify({ pairedClient: null }) }), ctx(lookupWith()));
    expect(v.endpoints).toBeNull();
    expect(v.pairedClient).toBeNull();
  });

  it("unregistered connector → 'Connector disabled' + availability disabled", () => {
    const v = buildConnectionView(connRow(), ctx(none));
    expect(v.connectorDisplayName).toBe('Connector disabled');
    expect(v.availability).toEqual({ state: 'disabled', message: 'Connector disabled', retryAt: null });
  });

  it('availability is per handle', () => {
    const seen: string[] = [];
    const v = buildConnectionView(connRow(), ctx(lookupWith({
      availability: (h) => { seen.push(h?.connectionId ?? 'none'); return { state: 'other_account', message: 'x', retryAt: null }; },
    })));
    expect(seen).toEqual(['c1']);
    expect(v.availability.state).toBe('other_account');
  });

  it('verifyFacts come from describeFacts when implemented, else verify_json', () => {
    const live = buildConnectionView(connRow(), ctx(lookupWith({
      describeFacts: () => [{ key: 'paired', label: 'Paired with', at: NOW, status: 'done' }],
    })));
    expect(live.verifyFacts.map((f) => f.key)).toEqual(['paired']);
    const stored = buildConnectionView(connRow(), ctx(lookupWith()));
    expect(stored.verifyFacts.map((f) => f.key)).toEqual(['pairing-issued']);
    const broken = buildConnectionView(connRow({ verify_json: '{not json' }), ctx(lookupWith()));
    expect(broken.verifyFacts).toEqual([]);
  });

  it('remoteRevoke.surfaced at 3 attempts', () => {
    expect(buildConnectionView(connRow(), ctx(none)).remoteRevoke).toBeNull();
    const two = buildConnectionView(connRow({ remote_revoke_state: 'pending', remote_revoke_attempts: 2 }), ctx(none));
    expect(two.remoteRevoke?.surfaced).toBe(false);
    const three = buildConnectionView(connRow({ remote_revoke_state: 'pending', remote_revoke_attempts: 3, remote_revoke_error: 'Revoke pending' }), ctx(none));
    expect(three.remoteRevoke).toEqual({ state: 'pending', attempts: 3, lastError: 'Revoke pending', surfaced: true });
  });

  it('unknown enum values map to safe defaults', () => {
    const v = buildConnectionView(connRow({ state: 'weird', capabilities_json: 'nope' }), ctx(none));
    expect(v.state).toBe('revoked');
    expect(v.capabilities.descriptorVersion).toBe(0);
  });
});

describe('buildAgentView', () => {
  it('fills retiredConnections and pendingSwitch', () => {
    const swap = connRow({ id: 'c2', is_current: 0, swap_state: 'awaiting_verify', swap_started_at: NOW });
    const retired = connRow({ id: 'c0', is_current: 0, state: 'revoked', remote_revoke_state: 'gave_up', remote_revoke_attempts: 20, remote_revoke_error: 'x' });
    const v = buildAgentView({
      agent, connections: { current: connRow(), swap, retired: [retired], lastSwitchError: null },
      unreadCount: 2, lastMessageAt: null, credentials: new Map(),
    }, lookupWith());
    expect(v.pendingSwitch?.connectionId).toBe('c2');
    expect(v.pendingSwitch?.swapState).toBe('awaiting_verify');
    expect(v.retiredConnections).toEqual([{ connectionId: 'c0', connectorDisplayName: 'cyboflow Bridge', remoteRevoke: { state: 'gave_up', attempts: 20, lastError: 'x' } }]);
    expect(v.unreadCount).toBe(2);
  });

  it('sortAgentViews orders by COALESCE(lastMessageAt, createdAt) DESC', () => {
    const mk = (id: string, createdAt: string, lastMessageAt: string | null): AgentView => ({
      id, handle: id, displayName: id, vendor: 'other', githubLogin: null, archivedAt: null, createdAt, unreadCount: 0,
      lastMessageAt, connection: null, pendingSwitch: null, lastSwitchError: null, retiredConnections: [],
    });
    const out = sortAgentViews([
      mk('old', '2026-10-01T00:00:00.000Z', null),
      mk('chatty', '2026-09-01T00:00:00.000Z', '2026-10-06T00:00:00.000Z'),
      mk('new', '2026-10-05T00:00:00.000Z', null),
    ]);
    expect(out.map((a) => a.id)).toEqual(['chatty', 'new', 'old']);
  });
});

describe('buildThreadMessageView', () => {
  const base: MessageRow = {
    _rowid: 1, id: 'm1', agent_id: 'a1', connection_id: 'c1', direction: 'in', author: 'agent', kind: 'delivery_report',
    body: 'done', links_json: JSON.stringify(['https://github.com/o/r/pull/1', 'nonsense']),
    delivery_json: JSON.stringify({ prUrl: 'https://github.com/o/r/pull/1', summary: 's' }), attachments_json: null,
    brief_entity_type: null, brief_entity_id: null, remote_ref: null, relay_seq: 1, relay_epoch: 1, remote_out_seq: null,
    remote_event_id: 'e1', remote_created_at: null, is_probe: 0, send_state: null, send_attempts: 0, reconcile_attempts: 0,
    next_attempt_at: null, last_error: null, content_hash: null, claim_generation: null, sent_at: null, picked_up_at: null,
    remote_ack: null, remote_ack_at: null, read_at: null, client_correlation_id: null, intent_id: null,
    assignment_generation: null, created_at: NOW, updated_at: NOW,
  };

  it('inbound: link domains and delivery domain, no outbound fields', () => {
    const v = buildThreadMessageView(base);
    expect(v.links).toEqual([{ url: 'https://github.com/o/r/pull/1', domain: 'github.com' }]);
    expect(v.delivery).toEqual({ prUrl: 'https://github.com/o/r/pull/1', prDomain: 'github.com', summary: 's', briefId: null });
    expect(v.sendState).toBeNull();
  });

  it('outbound: send fields and remote ack', () => {
    const v = buildThreadMessageView({ ...base, direction: 'out', author: 'user', kind: 'text', send_state: 'on_bridge', send_attempts: 2, remote_ack: 'acked', delivery_json: null });
    expect(v.sendState).toBe('on_bridge');
    expect(v.sendAttempts).toBe(2);
    expect(v.remoteAck).toBe('acked');
    expect(v.readAt).toBeNull();
  });
});

describe('buildUsageView', () => {
  it('totals and weakest coverage', () => {
    const row = (scope: string, coverage: string, input: number): UsageRow => ({
      connection_id: 'c1', remote_scope: scope, agent_id: 'a1', input_tokens: input, output_tokens: 1, cache_read_tokens: null,
      cache_creation_tokens: null, cost_usd: 0.5, active_seconds: null, coverage, computed_at: NOW,
    });
    expect(buildUsageView('a1', []).coverage).toBe('none');
    const v = buildUsageView('a1', [row('s1', 'complete', 10), row('s2', 'vendor-cumulative', 5)]);
    expect(v.totals.inputTokens).toBe(15);
    expect(v.totals.costUsd).toBe(1);
    expect(v.coverage).toBe('vendor-cumulative');
  });
});
