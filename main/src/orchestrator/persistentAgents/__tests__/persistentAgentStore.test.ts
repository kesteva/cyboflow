/**
 * PersistentAgentStore — the sole writer of the persistent-agents tables. Real better-sqlite3 (in-memory)
 * with migration 151 applied; no mocks of SQL.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  persistentAgentEvents,
  persistentAgentThreadChannel,
  PERSISTENT_AGENTS_CHANNEL,
} from '../../persistentAgentsBridge';
import { PersistentAgentStore } from '../persistentAgentStore';
import { HandleTakenError, SwapInProgressError } from '../errors';
import type { NewConnectionRow, SettleOutcome } from '../rows';
import { BRIDGE_DESCRIPTOR, CMA_DESCRIPTOR } from '../../../../../shared/types/__tests__/persistentAgentsFixtures';
import type { PersistentAgentThreadEvent, PersistentAgentsChangedEvent } from '../../../../../shared/types/persistentAgents';
import type { InboundBatch } from '../../../services/persistentAgents/connectorContract';
import {
  ISO_RE,
  allTimestampValues,
  emptyBatch,
  makeClock,
  makeTestDb,
} from '../../../services/persistentAgents/__tests__/fakeConnector';

const BRIDGE_CONN: NewConnectionRow = {
  kind: 'bridge', connectorId: 'bridge', connectorVersion: 1, transport: 'relay-mcp', credentialId: null, descriptor: BRIDGE_DESCRIPTOR,
};
const nativeConn = (credentialId: string | null = null): NewConnectionRow => ({
  kind: 'native', connectorId: 'claude-managed-agents', connectorVersion: 1, transport: 'stream', credentialId, descriptor: CMA_DESCRIPTOR,
});

let raw: Database.Database;
let store: PersistentAgentStore;
let clock: ReturnType<typeof makeClock>;
let ids = 0;
let remote = 0;

beforeEach(() => {
  const t = makeTestDb();
  raw = t.raw;
  clock = makeClock();
  ids = 0;
  store = new PersistentAgentStore(t.db, { now: clock.now, newId: () => `id-${String(++ids).padStart(4, '0')}` });
});

afterEach(() => {
  // Every row written in every case uses the one ISO timestamp shape: asserted across the whole suite.
  for (const v of allTimestampValues(raw)) expect(v.value, `${v.table}.${v.column}`).toMatch(ISO_RE);
  raw.close();
});

async function seedAgent(
  conn: NewConnectionRow = BRIDGE_CONN,
  name = 'Dot Bot',
  opts: { relayEpoch?: number | null } = {},
): Promise<{ agentId: string; connectionId: string }> {
  const { agentId, connectionId } = await store.createAgent({ agent: { displayName: name, vendor: 'openai-dots' }, connection: conn });
  remote += 1;
  await store.completeConnectionCreate(connectionId, {
    remoteId: `r-${remote}`, remote: { mcpUrl: 'https://relay.test/mcp', httpBase: 'https://relay.test/h' },
    transport: conn.transport, inboundCursor: null,
    relayEpoch: opts.relayEpoch === undefined ? (conn.kind === 'bridge' ? 1 : null) : opts.relayEpoch,
    pairing: null, facts: [],
  });
  return { agentId, connectionId };
}

/** A swap target n for the agent, completed (awaiting_verify). */
async function seedSwap(agentId: string, conn: NewConnectionRow = BRIDGE_CONN): Promise<string> {
  const { connectionId } = await store.createPendingConnection(agentId, conn);
  remote += 1;
  await store.completeConnectionCreate(connectionId, {
    remoteId: `r-${remote}`, remote: {}, transport: conn.transport, inboundCursor: null, relayEpoch: 1, pairing: null, facts: [],
  });
  return connectionId;
}

async function toActivating(n: string): Promise<void> {
  expect(await store.markSwapState(n, 'awaiting_verify', 'fencing')).toBe(true);
  expect(await store.fenceSwap(n)).toBe(true);
  expect(await store.markSwapState(n, 'reconciling', 'revoking_remote')).toBe(true);
  expect(await store.markSwapState(n, 'revoking_remote', 'activating')).toBe(true);
}

function msg(id: string): Record<string, unknown> {
  return raw.prepare('SELECT * FROM persistent_agent_messages WHERE id = ?').get(id) as Record<string, unknown>;
}
function conn(id: string): Record<string, unknown> {
  return raw.prepare('SELECT * FROM persistent_agent_connections WHERE id = ?').get(id) as Record<string, unknown>;
}
function count(sql: string, ...p: unknown[]): number {
  return (raw.prepare(sql).get(...p) as { n: number }).n;
}
function setMsg(id: string, cols: Record<string, unknown>): void {
  const keys = Object.keys(cols);
  raw.prepare(`UPDATE persistent_agent_messages SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => cols[k]), id);
}
function setConn(id: string, cols: Record<string, unknown>): void {
  const keys = Object.keys(cols);
  raw.prepare(`UPDATE persistent_agent_connections SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => cols[k]), id);
}
const agentMsg = (rid: string, over: Partial<InboundBatch['messages'][number]> = {}): InboundBatch['messages'][number] => ({
  remoteEventId: rid, author: 'agent', kind: 'text', body: `hello ${rid}`, links: [], remoteCreatedAt: null, ...over,
});

describe('createAgent', () => {
  it('createAgent derives a unique handle', async () => {
    const a = await store.createAgent({ agent: { displayName: 'Dot Bot', vendor: 'openai-dots' }, connection: BRIDGE_CONN });
    const b = await store.createAgent({ agent: { displayName: 'Dot Bot', vendor: 'openai-dots' }, connection: BRIDGE_CONN });
    expect(a.handle).toBe('dot-bot');
    expect(b.handle).toBe('dot-bot-2');
    await expect(store.createAgent({ agent: { displayName: 'X', vendor: 'other', handle: 'dot-bot' }, connection: BRIDGE_CONN }))
      .rejects.toBeInstanceOf(HandleTakenError);
  });
});

describe('applyInboundBatch', () => {
  it('applyInboundBatch is idempotent', async () => {
    const { agentId, connectionId } = await seedAgent();
    const threadEvents: PersistentAgentThreadEvent[] = [];
    const l = (e: PersistentAgentThreadEvent): void => { threadEvents.push(e); };
    persistentAgentEvents.on(persistentAgentThreadChannel(agentId), l);
    const batch = emptyBatch({ messages: [agentMsg('e1', { relaySeq: 1, relayEpoch: 1 })], nextCursor: '1' });
    const r1 = await store.applyInboundBatch(connectionId, batch);
    const rows1 = count('SELECT COUNT(*) AS n FROM persistent_agent_messages');
    const r2 = await store.applyInboundBatch(connectionId, batch);
    persistentAgentEvents.off(persistentAgentThreadChannel(agentId), l);
    expect(r1.insertedMessageIds).toHaveLength(1);
    expect(r2.insertedMessageIds).toEqual([]);
    expect(count('SELECT COUNT(*) AS n FROM persistent_agent_messages')).toBe(rows1);
    expect(conn(connectionId).inbound_cursor).toBe('1');
    expect(threadEvents.filter((e) => e.kind === 'messages')).toHaveLength(1);
  });

  it('re-drain after epoch change dedupes by envelope id', async () => {
    const { connectionId } = await seedAgent();
    await store.applyInboundBatch(connectionId, emptyBatch({ messages: [agentMsg('e1', { relaySeq: 1, relayEpoch: 1 })], cursorEpoch: 1 }));
    const r = await store.applyInboundBatch(connectionId, emptyBatch({
      messages: [agentMsg('e1', { relaySeq: 7, relayEpoch: 2 })], cursorEpoch: 2, nextCursor: '7',
    }));
    expect(r.insertedMessageIds).toEqual([]);
    expect(conn(connectionId).relay_epoch).toBe(2);
  });

  it('receipts set picked_up_at once and never cross agents', async () => {
    const a = await seedAgent();
    const b = await seedAgent(BRIDGE_CONN, 'Other');
    const { messageId } = await store.enqueueOutbound(a.agentId, { kind: 'text', body: 'hi', links: [] });
    const { messageId: otherMsg } = await store.enqueueOutbound(b.agentId, { kind: 'text', body: 'hi', links: [] });
    await store.applyInboundBatch(a.connectionId, emptyBatch({
      receipts: [{ localMessageId: messageId, remoteEventId: 'rc1', event: 'picked_up', at: '2026-10-07T12:01:00.000Z' }],
    }));
    await store.applyInboundBatch(a.connectionId, emptyBatch({
      receipts: [
        { localMessageId: messageId, remoteEventId: 'rc2', event: 'picked_up', at: '2026-10-07T12:05:00.000Z' },
        { localMessageId: otherMsg, remoteEventId: 'rc3', event: 'picked_up', at: '2026-10-07T12:05:00.000Z' },
      ],
    }));
    expect(msg(messageId).picked_up_at).toBe('2026-10-07T12:01:00.000Z');
    expect(msg(otherMsg).picked_up_at).toBeNull();
    expect(msg(otherMsg).send_state).toBe('queued');
  });

  it('receipt on an ambiguous message marks it delivered', async () => {
    const br = await seedAgent();
    const na = await seedAgent(nativeConn(), 'Native');
    const m1 = (await store.enqueueOutbound(br.agentId, { kind: 'text', body: 'a', links: [] })).messageId;
    const m2 = (await store.enqueueOutbound(na.agentId, { kind: 'text', body: 'b', links: [] })).messageId;
    setMsg(m1, { send_state: 'ambiguous' });
    setMsg(m2, { send_state: 'ambiguous' });
    await store.applyInboundBatch(br.connectionId, emptyBatch({ receipts: [{ localMessageId: m1, remoteEventId: 'x', event: 'picked_up', at: clock.now().toISOString() }] }));
    await store.applyInboundBatch(na.connectionId, emptyBatch({ receipts: [{ localMessageId: m2, remoteEventId: 'y', event: 'acked', at: clock.now().toISOString() }] }));
    expect(msg(m1).send_state).toBe('on_bridge');
    expect(msg(m1).sent_at).not.toBeNull();
    expect(msg(m2).send_state).toBe('sent');
    expect(msg(m2).remote_ack).toBe('acked');
  });

  it('cumulative usage replaces, older snapshot ignored', async () => {
    const { connectionId } = await seedAgent(nativeConn());
    await store.applyInboundBatch(connectionId, emptyBatch({ usage: [{ remoteScope: 's', inputTokens: 10, coverage: 'complete', computedAt: '2026-10-07T12:00:00.000Z' }] }));
    await store.applyInboundBatch(connectionId, emptyBatch({ usage: [{ remoteScope: 's', inputTokens: 50, coverage: 'complete', computedAt: '2026-10-07T12:10:00.000Z' }] }));
    await store.applyInboundBatch(connectionId, emptyBatch({ usage: [{ remoteScope: 's', inputTokens: 20, coverage: 'complete', computedAt: '2026-10-07T12:05:00.000Z' }] }));
    const row = raw.prepare('SELECT input_tokens FROM persistent_agent_usage').get() as { input_tokens: number };
    expect(row.input_tokens).toBe(50);
  });

  it('pending → verified only on round-trip (native)', async () => {
    const { agentId, connectionId } = await seedAgent(nativeConn());
    await store.applyInboundBatch(connectionId, emptyBatch({ messages: [agentMsg('e1')] }));
    expect(conn(connectionId).state).toBe('pending');
    const { messageId } = await store.enqueueOutbound(agentId, { kind: 'text', body: 'q', links: [] });
    setMsg(messageId, { send_state: 'sent', sent_at: clock.now().toISOString() });
    const r = await store.applyInboundBatch(connectionId, emptyBatch({ messages: [agentMsg('e2')] }));
    expect(r.becameVerified).toBe(true);
    expect(conn(connectionId).state).toBe('verified');
    expect(conn(connectionId).verified_at).toBe(clock.now().toISOString());
    const firstSeen = JSON.parse(String(conn(connectionId).capabilities_json)).observed['round-trip'];
    clock.advance(60_000);
    await store.applyInboundBatch(connectionId, emptyBatch({ messages: [agentMsg('e3')] }));
    expect(JSON.parse(String(conn(connectionId).capabilities_json)).observed['round-trip']).toBe(firstSeen);
  });

  it('bridge connection is verified only by batch.observed', async () => {
    const { agentId, connectionId } = await seedAgent();
    const { messageId } = await store.enqueueOutbound(agentId, { kind: 'text', body: 'q', links: [] });
    setMsg(messageId, { send_state: 'on_bridge', sent_at: clock.now().toISOString() });
    await store.applyInboundBatch(connectionId, emptyBatch({ messages: [agentMsg('e1')] }));
    expect(conn(connectionId).state).toBe('pending');
    const r = await store.applyInboundBatch(connectionId, emptyBatch({ observed: ['round-trip'] }));
    expect(r.becameVerified).toBe(true);
    expect(conn(connectionId).state).toBe('verified');
  });

  it('stale → verified on evidence; empty batch is not evidence', async () => {
    const { connectionId } = await seedAgent();
    setConn(connectionId, { state: 'stale' });
    const r = await store.applyInboundBatch(connectionId, emptyBatch());
    expect(r.evidence).toBe(false);
    expect(conn(connectionId).state).toBe('stale');
    await store.applyInboundBatch(connectionId, emptyBatch({ messages: [agentMsg('e1')] }));
    expect(conn(connectionId).state).toBe('verified');
  });

  it('auth_failed → restored after a successful pull', async () => {
    const { id: credId } = await store.insertCredential({ vendor: 'anthropic', label: 'k', cipher: Buffer.from('c'), fingerprint: 'f' });
    const a = await seedAgent(nativeConn(credId), 'A');
    const b = await seedAgent(nativeConn(credId), 'B');
    setConn(a.connectionId, { state: 'auth_failed', verified_at: '2026-10-01T00:00:00.000Z', auth_retry_at: clock.now().toISOString(), error_kind: 'auth' });
    setConn(b.connectionId, { state: 'auth_failed' });
    await store.setCredentialState(credId, 'auth_failed', 'rejected');
    await store.applyInboundBatch(a.connectionId, emptyBatch());
    await store.applyInboundBatch(b.connectionId, emptyBatch());
    expect(conn(a.connectionId).state).toBe('verified');
    expect(conn(a.connectionId).auth_retry_at).toBeNull();
    expect(conn(a.connectionId).error_kind).toBeNull();
    expect(conn(b.connectionId).state).toBe('pending');
    expect(store.getCredentialRow(credId)?.state).toBe('ok');
  });

  it('inbound sanitisation', async () => {
    const { connectionId } = await seedAgent();
    const big = 'x'.repeat(70 * 1024);
    const links = Array.from({ length: 25 }, (_, i) => `https://example.test/${i}`);
    const r = await store.applyInboundBatch(connectionId, emptyBatch({
      messages: [
        agentMsg('ctl', { body: 'a\u0000b\u0007c\nd\te\u007f' }),
        agentMsg('big', { body: big }),
        agentMsg('links', { links: ['javascript:alert(1)', `https://e.test/${'a'.repeat(3000)}`, ...links] }),
      ],
    }));
    const [ctl, bigId, linksId] = r.insertedMessageIds;
    expect(msg(ctl).body).toBe('abc\nd\te');
    const bigBody = String(msg(bigId).body);
    expect(bigBody.endsWith('\n[truncated]')).toBe(true);
    expect(Buffer.byteLength(bigBody, 'utf8')).toBeLessThanOrEqual(65_536);
    const stored = JSON.parse(String(msg(linksId).links_json)) as string[];
    expect(stored).toHaveLength(20);
    expect(stored.every((l) => l.startsWith('https://example.test/'))).toBe(true);
  });

  it('inbound body loses U+202E but keeps U+200D', async () => {
    const { connectionId } = await seedAgent();
    const r = await store.applyInboundBatch(connectionId, emptyBatch({
      messages: [agentMsg('bidi', { body: 'safe‮txt.exe 👨‍👩 ⁦x⁩' })],
    }));
    const body = String(msg(r.insertedMessageIds[0]).body);
    expect(body).not.toMatch(/[‪-‮⁦-⁩]/);
    expect(body).toContain('‍');
  });

  it('remotePatch merges in the same transaction (null stores null)', async () => {
    const { connectionId } = await seedAgent();
    await store.applyInboundBatch(connectionId, emptyBatch({ remotePatch: { pairedClient: { name: 'C', redirectHost: 'c.test', pairedAt: 1 } } }));
    expect(JSON.parse(String(conn(connectionId).remote_json)).pairedClient.name).toBe('C');
    await store.applyInboundBatch(connectionId, emptyBatch({ remotePatch: { pairedClient: null } }));
    const remoteJson = JSON.parse(String(conn(connectionId).remote_json));
    expect(remoteJson).toHaveProperty('pairedClient', null);
    expect(remoteJson.mcpUrl).toBe('https://relay.test/mcp');
  });

  it('lastSeenAt uses max of stored and batch', async () => {
    const { connectionId } = await seedAgent();
    await store.applyInboundBatch(connectionId, emptyBatch({ messages: [agentMsg('a')], lastSeenAt: '2026-10-07T11:00:00.000Z' }));
    expect(conn(connectionId).last_seen_at).toBe('2026-10-07T11:00:00.000Z');
    await store.applyInboundBatch(connectionId, emptyBatch({ messages: [agentMsg('b')], lastSeenAt: '2026-10-07T10:00:00.000Z' }));
    expect(conn(connectionId).last_seen_at).toBe('2026-10-07T11:00:00.000Z');
    await store.applyInboundBatch(connectionId, emptyBatch({ messages: [agentMsg('c')] }));
    expect(conn(connectionId).last_seen_at).toBe(clock.now().toISOString());
  });

  it('stale pre-repair batch with round-trip does not verify the repaired connection nor restore pairedClient', async () => {
    const { connectionId } = await seedAgent(BRIDGE_CONN, 'R', { relayEpoch: 1 });
    setConn(connectionId, { inbound_cursor: 'bridge:v1:1:5' });
    await store.applyRepair(connectionId, {
      pairing: { kind: 'bridge', connectionId, transport: 'relay-mcp', mcpUrl: 'm', httpBase: 'h', pairingCode: 'A-B-1', pairingExpiresAt: null, oneTimeToken: null, instructionBrief: null },
      remotePatch: { pairedClient: null }, relayEpoch: 2, inboundCursor: 'bridge:v1:2:0',
    });
    const r = await store.applyInboundBatch(connectionId, emptyBatch({
      messages: [agentMsg('late')], observed: ['round-trip'], nextCursor: 'bridge:v1:1:9', cursorEpoch: 1,
      remotePatch: { pairedClient: { name: 'old', redirectHost: 'x.test', pairedAt: 1 } },
    }), { expectedRelayEpoch: 1 });
    expect(r.fenced).toBe(true);
    expect(r.becameVerified).toBe(false);
    expect(r.insertedMessageIds).toHaveLength(1);
    const c = conn(connectionId);
    expect(c.state).toBe('pending');
    expect(JSON.parse(String(c.remote_json)).pairedClient).toBeNull();
    expect(c.inbound_cursor).toBe('bridge:v1:2:0');
    expect(c.relay_epoch).toBe(2);
  });

  it('applyRepair resets the cursor', async () => {
    const { connectionId } = await seedAgent();
    setConn(connectionId, { inbound_cursor: 'bridge:v1:1:42', state: 'verified', verified_at: clock.now().toISOString() });
    await store.applyRepair(connectionId, {
      pairing: { kind: 'bridge', connectionId, transport: 'relay-mcp', mcpUrl: 'm', httpBase: 'h', pairingCode: 'A-B-1', pairingExpiresAt: null, oneTimeToken: null, instructionBrief: null },
      relayEpoch: 3, inboundCursor: 'bridge:v1:3:0',
    });
    const c = conn(connectionId);
    expect(c.inbound_cursor).toBe('bridge:v1:3:0');
    expect(c.relay_epoch).toBe(3);
    expect(c.state).toBe('pending');
    expect(c.verified_at).not.toBeNull();
  });
});

describe('claims', () => {
  it('claimOutbound runs against real better-sqlite3 with plain ? params', async () => {
    const { agentId, connectionId } = await seedAgent();
    const first = (await store.enqueueOutbound(agentId, { kind: 'text', body: '1', links: [] })).messageId;
    await store.enqueueOutbound(agentId, { kind: 'text', body: '2', links: [] });
    const row = await store.claimOutbound(agentId, clock.now());
    expect(row?.id).toBe(first);
    expect(typeof row?._rowid).toBe('number');
    expect(row?.claim_generation).toBe(conn(connectionId).generation);
    expect(row?.send_attempts).toBe(1);
    expect(row?.send_state).toBe('in_flight');
  });

  it('claim exclusivity', async () => {
    const { agentId } = await seedAgent();
    await store.enqueueOutbound(agentId, { kind: 'text', body: 'only', links: [] });
    const [a, b] = await Promise.all([store.claimOutbound(agentId, clock.now()), store.claimOutbound(agentId, clock.now())]);
    expect([a, b].filter((x) => x !== null)).toHaveLength(1);
  });

  it('claim filters', async () => {
    const { agentId, connectionId } = await seedAgent();
    const m = (await store.enqueueOutbound(agentId, { kind: 'text', body: 'x', links: [] })).messageId;
    const later = new Date(clock.now().getTime() + 60_000).toISOString();
    setMsg(m, { next_attempt_at: later });
    expect(await store.claimOutbound(agentId, clock.now())).toBeNull();
    setMsg(m, { next_attempt_at: null });
    for (const s of ['revoked', 'auth_failed']) {
      setConn(connectionId, { state: s });
      expect(await store.claimOutbound(agentId, clock.now())).toBeNull();
    }
    setConn(connectionId, { state: 'pending', rate_limited_until: later });
    expect(await store.claimOutbound(agentId, clock.now())).toBeNull();
    setConn(connectionId, { rate_limited_until: null, connect_state: 'creating_remote' });
    expect(await store.claimOutbound(agentId, clock.now())).toBeNull();
    setConn(connectionId, { connect_state: null });
    // a swap target in fencing..activating blocks claims for the agent
    const n = await seedSwap(agentId);
    for (const s of ['fencing', 'reconciling', 'revoking_remote', 'activating']) {
      setConn(n, { swap_state: s });
      expect(await store.claimOutbound(agentId, clock.now())).toBeNull();
    }
    setConn(n, { swap_state: 'awaiting_verify' });
    // non-probe on the non-current swap target is not claimable; a probe there is
    const nonProbe = (await store.enqueueOutbound(agentId, { kind: 'text', body: 'np', links: [], connectionId: n })).messageId;
    setMsg(m, { send_state: 'failed' });
    expect(await store.claimOutbound(agentId, clock.now())).toBeNull();
    setMsg(nonProbe, { is_probe: 1 });
    expect((await store.claimOutbound(agentId, clock.now()))?.id).toBe(nonProbe);
  });

  it('claim order', async () => {
    const { agentId } = await seedAgent();
    const a = (await store.enqueueOutbound(agentId, { kind: 'text', body: 'a', links: [] })).messageId;
    const b = (await store.enqueueOutbound(agentId, { kind: 'text', body: 'b', links: [] })).messageId;
    const c = (await store.enqueueOutbound(agentId, { kind: 'text', body: 'c', links: [] })).messageId;
    setMsg(c, { created_at: '2026-10-07T11:00:00.000Z' });
    expect((await store.claimOutbound(agentId, clock.now()))?.id).toBe(c);
    expect((await store.claimOutbound(agentId, clock.now()))?.id).toBe(a); // same created_at as b: rowid tiebreak
    expect((await store.claimOutbound(agentId, clock.now()))?.id).toBe(b);
  });

  it('hasClaimable mirrors claimOutbound', async () => {
    const { agentId, connectionId } = await seedAgent();
    const nowIso = clock.now().toISOString();
    expect(store.hasClaimable(agentId, nowIso)).toBe(false);
    await store.enqueueOutbound(agentId, { kind: 'text', body: 'a', links: [] });
    expect(store.hasClaimable(agentId, nowIso)).toBe(true);
    setConn(connectionId, { state: 'revoked' });
    expect(store.hasClaimable(agentId, nowIso)).toBe(false);
    expect(await store.claimOutbound(agentId, clock.now())).toBeNull();
    setConn(connectionId, { state: 'verified' });
    expect(store.hasClaimable(agentId, nowIso)).toBe(true);
    expect(await store.claimOutbound(agentId, clock.now())).not.toBeNull();
    expect(store.hasClaimable(agentId, nowIso)).toBe(false);
  });

  it('listAgentsWithDueOutbound skips rows on a revoked connection', async () => {
    const a = await seedAgent();
    const b = await seedAgent(BRIDGE_CONN, 'B');
    await store.enqueueOutbound(a.agentId, { kind: 'text', body: 'a', links: [] });
    await store.enqueueOutbound(b.agentId, { kind: 'text', body: 'b', links: [] });
    setConn(b.connectionId, { state: 'revoked' });
    expect(store.listAgentsWithDueOutbound(clock.now().toISOString())).toEqual([a.agentId]);
  });

  it('requeueInFlightAsAmbiguous', async () => {
    const { agentId } = await seedAgent();
    const a = (await store.enqueueOutbound(agentId, { kind: 'text', body: 'a', links: [] })).messageId;
    const b = (await store.enqueueOutbound(agentId, { kind: 'text', body: 'b', links: [] })).messageId;
    await store.enqueueOutbound(agentId, { kind: 'text', body: 'c', links: [] });
    setMsg(a, { send_state: 'in_flight' });
    setMsg(b, { send_state: 'creating' });
    expect(await store.requeueInFlightAsAmbiguous()).toBe(2);
    expect(msg(a).send_state).toBe('ambiguous');
    expect(msg(b).send_state).toBe('ambiguous');
  });
});

describe('settleOutbound', () => {
  type Row = { kind: Extract<SettleOutcome, { ok: false }>['kind']; maybe: boolean; state: string; next: 'set' | 'null'; refund: boolean };
  const NEXT = '2026-10-07T12:05:00.000Z';
  const table: Array<Row & { fenced: boolean }> = [];
  const add = (kind: Row['kind'], maybe: boolean, state: string, nextNot: 'set' | 'null', nextFenced: 'set' | 'null', refund = false): void => {
    table.push({ kind, maybe, state, next: nextNot, refund, fenced: false });
    table.push({ kind, maybe, state, next: nextFenced, refund, fenced: true });
  };
  for (const k of ['invalid', 'permanent'] as const) add(k, false, 'failed', 'null', 'null');
  for (const k of ['not_found', 'revoked'] as const) add(k, false, 'queued', 'null', 'null');
  for (const k of ['paused', 'auth', 'device_auth', 'not_entitled', 'upgrade_required'] as const) add(k, false, 'queued', 'null', 'null', true);
  for (const k of ['rate_limited', 'retryable', 'conflict'] as const) add(k, false, 'queued', 'set', 'null');
  add('retryable', true, 'ambiguous', 'set', 'null');

  for (const row of table) {
    it(`settle table: ${row.kind} maybeDelivered=${row.maybe} ${row.fenced ? 'fenced' : 'not fenced'}`, async () => {
      const { agentId, connectionId } = await seedAgent();
      await store.enqueueOutbound(agentId, { kind: 'text', body: 'x', links: [] });
      const claimed = await store.claimOutbound(agentId, clock.now());
      if (!claimed) throw new Error('no claim');
      if (row.fenced) setConn(connectionId, { generation: claimed.claim_generation + 1 });
      const res = await store.settleOutbound(claimed.id, { connectionId, generation: claimed.claim_generation }, {
        ok: false, kind: row.kind, maybeDelivered: row.maybe, error: 'boom', nextAttemptAt: NEXT,
      });
      expect(res).toBe(row.fenced ? 'applied_fenced' : 'applied');
      const m = msg(claimed.id);
      expect(m.send_state).toBe(row.state);
      expect(m.next_attempt_at).toBe(row.next === 'set' ? NEXT : null);
      expect(m.send_attempts).toBe(row.refund ? 0 : 1);
      expect(m.last_error).toBe('boom');
    });
  }

  it('settle ok on a matching claim applies the receipt', async () => {
    const { agentId, connectionId } = await seedAgent();
    await store.enqueueOutbound(agentId, { kind: 'text', body: 'x', links: [] });
    const c = await store.claimOutbound(agentId, clock.now());
    if (!c) throw new Error('no claim');
    expect(await store.settleOutbound(c.id, { connectionId, generation: c.claim_generation }, {
      ok: true, receipt: { state: 'on_bridge', acceptedAt: clock.now().toISOString(), remoteOutSeq: 4, remoteEventId: c.id },
    })).toBe('applied');
    expect(msg(c.id).send_state).toBe('on_bridge');
    expect(msg(c.id).remote_out_seq).toBe(4);
  });

  it('late sent settle (native) re-homes and applies', async () => {
    const { agentId, connectionId: o } = await seedAgent(nativeConn());
    await store.enqueueOutbound(agentId, { kind: 'text', body: 'x', links: [] });
    const c = await store.claimOutbound(agentId, clock.now());
    if (!c) throw new Error('no claim');
    const n = await seedSwap(agentId, nativeConn());
    // the row was demoted and moved to n as queued while the send was in flight
    setMsg(c.id, { send_state: 'queued', connection_id: n, claim_generation: null });
    setConn(o, { is_current: 0, state: 'revoked' });
    const res = await store.settleOutbound(c.id, { connectionId: o, generation: c.claim_generation }, {
      ok: true, receipt: { state: 'sent', acceptedAt: clock.now().toISOString() },
    });
    expect(res).toBe('applied_fenced');
    expect(msg(c.id).send_state).toBe('sent');
    expect(msg(c.id).connection_id).toBe(o);
  });

  it('late on_bridge settle after swap does not pull the row back to the revoked old connection', async () => {
    const { agentId, connectionId: o } = await seedAgent();
    await store.enqueueOutbound(agentId, { kind: 'text', body: 'x', links: [] });
    const c = await store.claimOutbound(agentId, clock.now());
    if (!c) throw new Error('no claim');
    const n = await seedSwap(agentId);
    await toActivating(n);
    await store.demoteInFlightToAmbiguous(o);
    expect(await store.activateSwap(n)).toBe(true);
    expect(msg(c.id).connection_id).toBe(n);
    expect(msg(c.id).send_state).toBe('queued');
    const res = await store.settleOutbound(c.id, { connectionId: o, generation: c.claim_generation }, {
      ok: true, receipt: { state: 'on_bridge', acceptedAt: clock.now().toISOString() },
    });
    expect(res).toBe('late_receipt');
    expect(msg(c.id).send_state).toBe('queued');
    expect(msg(c.id).connection_id).toBe(n);
    expect(count(`SELECT COUNT(*) AS n FROM persistent_agent_events WHERE type = 'late_receipt'`)).toBe(1);
  });

  it('late success on a re-claimed row records late_receipt', async () => {
    const { agentId, connectionId } = await seedAgent();
    await store.enqueueOutbound(agentId, { kind: 'text', body: 'x', links: [] });
    const c1 = await store.claimOutbound(agentId, clock.now());
    if (!c1) throw new Error('no claim');
    setMsg(c1.id, { send_state: 'queued' });
    const c2 = await store.claimOutbound(agentId, clock.now());
    if (!c2) throw new Error('no reclaim');
    setConn(connectionId, { generation: 5 });
    setMsg(c1.id, { claim_generation: 5 });
    const res = await store.settleOutbound(c1.id, { connectionId, generation: 1 }, {
      ok: true, receipt: { state: 'on_bridge', acceptedAt: clock.now().toISOString() },
    });
    expect(res).toBe('late_receipt');
    expect(msg(c1.id).send_state).toBe('in_flight');
    const ev = raw.prepare(`SELECT remote_event_id FROM persistent_agent_events WHERE type = 'late_receipt'`).get() as { remote_event_id: string };
    expect(ev.remote_event_id).toBe(`late:${c1.id}:1`);
  });
});

describe('swap', () => {
  async function swapFixture(oConn: NewConnectionRow): Promise<{ agentId: string; o: string; n: string; ids: Record<string, string> }> {
    const { agentId, connectionId: o } = await seedAgent(oConn);
    const mk = async (body: string): Promise<string> => (await store.enqueueOutbound(agentId, { kind: 'text', body, links: [] })).messageId;
    const ids = { queued: await mk('q'), ambiguous: await mk('a'), sent: await mk('s'), failed: await mk('f'), unpicked: await mk('u'), picked: await mk('p') };
    setMsg(ids.ambiguous, { send_state: 'ambiguous' });
    setMsg(ids.sent, { send_state: 'sent', sent_at: clock.now().toISOString() });
    setMsg(ids.failed, { send_state: 'failed' });
    setMsg(ids.unpicked, { send_state: 'on_bridge', sent_at: clock.now().toISOString() });
    setMsg(ids.picked, { send_state: 'on_bridge', sent_at: clock.now().toISOString(), picked_up_at: clock.now().toISOString() });
    const n = await seedSwap(agentId);
    await toActivating(n);
    return { agentId, o, n, ids };
  }

  it('activateSwap moves only queued (native o), terminalizes ambiguous, and writes the note once', async () => {
    const { o, n, ids } = await swapFixture(nativeConn());
    expect(await store.activateSwap(n)).toBe(true);
    expect(conn(o).is_current).toBe(0);
    expect(conn(o).state).toBe('revoked');
    expect(conn(n).is_current).toBe(1);
    expect(conn(n).swap_state).toBeNull();
    expect(msg(ids.queued).connection_id).toBe(n);
    for (const k of ['sent', 'failed', 'unpicked', 'picked'] as const) expect(msg(ids[k]).connection_id).toBe(o);
    expect(count(`SELECT COUNT(*) AS n FROM persistent_agent_messages WHERE remote_event_id = ?`, `swap:${n}`)).toBe(1);
    // re-run on a finished swap is a no-op
    expect(await store.activateSwap(n)).toBe(false);
    expect(count(`SELECT COUNT(*) AS n FROM persistent_agent_messages WHERE direction = 'local'`)).toBe(1);
  });

  it('native swap terminalizes leftover ambiguous rows', async () => {
    const { o, n, ids } = await swapFixture(nativeConn());
    await store.activateSwap(n);
    expect(msg(ids.ambiguous).send_state).toBe('failed');
    expect(msg(ids.ambiguous).last_error).toBe('Delivery could not be confirmed');
    expect(msg(ids.ambiguous).connection_id).toBe(o);
  });

  it('bridge swap moves ambiguous rows to n', async () => {
    const { n, ids } = await swapFixture(BRIDGE_CONN);
    await store.activateSwap(n);
    expect(msg(ids.ambiguous).connection_id).toBe(n);
    expect(msg(ids.ambiguous).send_state).toBe('queued');
  });

  it('activateSwap moves on_bridge-unpicked rows for bridge', async () => {
    const { o, n, ids } = await swapFixture(BRIDGE_CONN);
    await store.activateSwap(n);
    expect(msg(ids.unpicked).connection_id).toBe(n);
    expect(msg(ids.unpicked).send_state).toBe('queued');
    expect(msg(ids.unpicked).sent_at).toBeNull();
    expect(msg(ids.picked).connection_id).toBe(o);
    expect(msg(ids.picked).send_state).toBe('on_bridge');
  });

  it('no due rows remain on o after activation', async () => {
    for (const oConn of [BRIDGE_CONN, nativeConn()]) {
      const { o, n } = await swapFixture(oConn);
      await store.activateSwap(n);
      expect(count(`SELECT COUNT(*) AS n FROM persistent_agent_messages WHERE connection_id = ? AND send_state IN ('queued','ambiguous')`, o)).toBe(0);
      const due = raw.prepare(
        `SELECT COUNT(*) AS n FROM persistent_agent_messages WHERE connection_id = ? AND direction = 'out' AND send_state IN ('queued','ambiguous')`,
      ).get(o) as { n: number };
      expect(due.n).toBe(0);
    }
  });

  it('activateSwap on a non-activating swap returns false and writes nothing', async () => {
    const { agentId, connectionId: o } = await seedAgent();
    await store.enqueueOutbound(agentId, { kind: 'text', body: 'q', links: [] });
    const n = await seedSwap(agentId);
    const before = JSON.stringify(raw.prepare('SELECT * FROM persistent_agent_connections ORDER BY id').all())
      + JSON.stringify(raw.prepare('SELECT * FROM persistent_agent_messages ORDER BY id').all());
    expect(await store.activateSwap(n)).toBe(false);
    const after = JSON.stringify(raw.prepare('SELECT * FROM persistent_agent_connections ORDER BY id').all())
      + JSON.stringify(raw.prepare('SELECT * FROM persistent_agent_messages ORDER BY id').all());
    expect(after).toBe(before);
    expect(conn(o).is_current).toBe(1);
  });

  it('disconnect between the activating CAS and activateSwap leaves n non-current', async () => {
    const { agentId } = await seedAgent();
    const n = await seedSwap(agentId);
    await toActivating(n);
    await store.disconnectAgent(agentId);
    expect(await store.activateSwap(n)).toBe(false);
    expect(conn(n).is_current).toBe(0);
    expect(conn(n).state).toBe('revoked');
    expect(conn(n).swap_state).toBeNull();
  });

  it('swap target revoked by setConnectionState fails the swap and frees the agent for a new switch', async () => {
    const { agentId } = await seedAgent();
    const n = await seedSwap(agentId);
    await store.setConnectionState(n, { state: 'revoked', errorKind: 'not_found', lastError: 'gone' });
    expect(conn(n).swap_state).toBeNull();
    expect(conn(n).swap_error).toBe('New connection failed before verifying');
    await expect(store.createPendingConnection(agentId, BRIDGE_CONN)).resolves.toHaveProperty('connectionId');
  });

  it('createPendingConnection refuses a second swap', async () => {
    const { agentId } = await seedAgent();
    await seedSwap(agentId);
    await expect(store.createPendingConnection(agentId, BRIDGE_CONN)).rejects.toBeInstanceOf(SwapInProgressError);
  });

  it('failSwap and fenceSwap are compare-and-sets', async () => {
    const { agentId, connectionId: o } = await seedAgent();
    const n = await seedSwap(agentId);
    expect(await store.fenceSwap(n)).toBe(false);
    expect(conn(o).generation).toBe(1);
    expect(await store.markSwapState(n, 'awaiting_verify', 'fencing')).toBe(true);
    expect(await store.failSwap(n, 'x', { revokeNew: true, fromStates: ['connecting', 'awaiting_verify'] })).toBe(false);
    expect(conn(n).swap_state).toBe('fencing');
  });

  it('listPumpTargets includes a revoked bridge connection while its remote revoke is pending and drops it when done', async () => {
    const { agentId, connectionId } = await seedAgent();
    await store.disconnectAgent(agentId);
    expect(conn(connectionId).state).toBe('revoked');
    expect(store.listPumpTargets().map((t) => t.id)).toContain(connectionId);
    await store.recordRemoteRevoke(connectionId, { ok: true });
    expect(store.listPumpTargets().map((t) => t.id)).not.toContain(connectionId);
  });
});

describe('credentials', () => {
  it('forgetCredential refuses while referenced', async () => {
    const { id } = await store.insertCredential({ vendor: 'anthropic', label: 'k', cipher: Buffer.from('c'), fingerprint: 'f' });
    const { agentId, connectionId } = await seedAgent(nativeConn(id), 'N');
    const r = await store.forgetCredential(id, false);
    expect(r).toEqual({ forgotten: false, referencedBy: [{ agentId, displayName: 'N', connectionId }] });
    expect(store.getCredentialRow(id)).not.toBeNull();
    expect(await store.forgetCredential(id, true)).toEqual({ forgotten: true });
    expect(store.getCredentialRow(id)).toBeNull();
    expect(conn(connectionId).state).toBe('auth_failed');
    expect(conn(connectionId).credential_id).toBeNull();
  });

  it('rotateCredential bumps version and reopens auth_failed connections', async () => {
    const { id } = await store.insertCredential({ vendor: 'anthropic', label: 'k', cipher: Buffer.from('c'), fingerprint: 'f' });
    const { agentId, connectionId } = await seedAgent(nativeConn(id), 'N');
    setConn(connectionId, { state: 'auth_failed', inbound_cursor: 'cur-9' });
    await store.applyInboundBatch(connectionId, emptyBatch({ messages: [agentMsg('m1')], nextCursor: 'cur-9' }));
    setConn(connectionId, { state: 'auth_failed' });
    const r = await store.rotateCredential(id, Buffer.from('c2'), 'f2');
    expect(r.version).toBe(2);
    expect(r.reopenedConnectionIds).toEqual([connectionId]);
    expect(conn(connectionId).auth_retry_at).toBe(clock.now().toISOString());
    expect(conn(connectionId).inbound_cursor).toBe('cur-9');
    expect(store.getThreadPage(agentId, null, 10).rows).toHaveLength(1);
  });
});

describe('reads & misc', () => {
  it('markThreadRead upTo', async () => {
    const { agentId, connectionId } = await seedAgent();
    const r = await store.applyInboundBatch(connectionId, emptyBatch({
      messages: [agentMsg('a'), agentMsg('b'), agentMsg('rel', { author: 'relay', kind: 'system' }), agentMsg('c')],
    }));
    await store.applyInboundBatch(connectionId, emptyBatch({ messages: [{ ...agentMsg('gap'), author: 'local', kind: 'system' }] }));
    expect(store.unreadCount(agentId)).toBe(3);
    const res = await store.markThreadRead(agentId, r.insertedMessageIds[1]);
    expect(res.unread).toBe(1);
    expect(msg(r.insertedMessageIds[0]).read_at).not.toBeNull();
    expect(msg(r.insertedMessageIds[3]).read_at).toBeNull();
    expect((await store.markThreadRead(agentId)).unread).toBe(0);
  });

  it('emit after commit', async () => {
    const seen: Array<number> = [];
    const l = (ev: PersistentAgentsChangedEvent): void => {
      if (ev.kind === 'agents' && ev.agentId) {
        seen.push(count('SELECT COUNT(*) AS n FROM persistent_agents WHERE id = ?', ev.agentId));
      }
    };
    persistentAgentEvents.on(PERSISTENT_AGENTS_CHANNEL, l);
    try {
      await store.createAgent({ agent: { displayName: 'E', vendor: 'other' }, connection: BRIDGE_CONN });
      expect(seen).toEqual([1]);
      const before = seen.length;
      await expect(store.createAgent({ agent: { displayName: 'E2', vendor: 'other', handle: 'e' }, connection: BRIDGE_CONN })).rejects.toBeInstanceOf(HandleTakenError);
      expect(seen.length).toBe(before);
    } finally {
      persistentAgentEvents.off(PERSISTENT_AGENTS_CHANNEL, l);
    }
  });

  it('pruneEvents deletes only rows older than the cutoff', async () => {
    const { connectionId } = await seedAgent(nativeConn());
    await store.applyInboundBatch(connectionId, emptyBatch({ activity: [{ remoteEventId: 'old', type: 'status', occurredAt: clock.now().toISOString() }] }));
    clock.advance(31 * 86_400_000);
    await store.applyInboundBatch(connectionId, emptyBatch({ activity: [{ remoteEventId: 'new', type: 'status', occurredAt: clock.now().toISOString() }] }));
    const cutoff = new Date(clock.now().getTime() - 30 * 86_400_000).toISOString();
    expect(await store.pruneEvents(cutoff)).toBe(1);
    expect((raw.prepare('SELECT remote_event_id FROM persistent_agent_events').all() as Array<{ remote_event_id: string }>).map((r) => r.remote_event_id)).toEqual(['new']);
  });

  it('every timestamp is ISO', async () => {
    const { agentId, connectionId } = await seedAgent(nativeConn());
    await store.enqueueOutbound(agentId, { kind: 'text', body: 'x', links: [] });
    await store.applyInboundBatch(connectionId, emptyBatch({
      messages: [agentMsg('a', { remoteCreatedAt: '2026-10-07 11:00:00' })],
      activity: [{ remoteEventId: 'ev', type: 'status', occurredAt: 'not a date' }],
      usage: [{ remoteScope: 's', coverage: 'partial', computedAt: 'garbage' }],
      receipts: [], remoteStatus: 'working',
    }));
    await store.markStale(clock.now());
    const values = allTimestampValues(raw);
    expect(values.length).toBeGreaterThan(10);
    for (const v of values) expect(v.value, `${v.table}.${v.column}`).toMatch(ISO_RE);
  });
});
