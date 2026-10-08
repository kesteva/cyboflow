import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConnectorError } from '../connectorErrors';
import { REVOKE_BACKOFF_MS, REVOKE_MAX_ATTEMPTS } from '../connectionService';
import {
  ConnectorUnavailableError,
  ControlNotSupportedError,
  CredentialUndecryptableError,
  NoSwapInProgressError,
} from '../errors';
import type { ConnectRequest, InboundBatch, ReconcileResult, SendReceipt } from '../connectorContract';
import { buildConnectionView } from '../../../orchestrator/persistentAgents/views';
import type { SwapState } from '../../../../../shared/types/persistentAgents';
import { createFakeConnector, emptyBatch, makeHarness, type Harness } from './fakeConnector';

let h: Harness;
afterEach(() => { h?.raw.close(); });

const bridgeInput = (transport: 'relay-mcp' | 'relay-http' = 'relay-mcp') =>
  ({ kind: 'bridge' as const, connectorId: 'bridge' as const, transport });

async function connectBridge(name = 'Dot', transport: 'relay-mcp' | 'relay-http' = 'relay-mcp') {
  return h.connections.connect({ agent: { displayName: name, vendor: 'openai-dots' }, connection: bridgeInput(transport) });
}
async function connectNative(name = 'Cma', credentialId?: string) {
  return h.connections.connect({
    agent: { displayName: name, vendor: 'anthropic-cma' },
    connection: {
      kind: 'native', connectorId: 'claude-managed-agents', remote: {},
      credential: credentialId ? { mode: 'existing', credentialId } : { mode: 'new', label: 'k', secret: 'sk-ant-TEST-123456' },
    },
  });
}
const conn = (id: string): Record<string, unknown> | undefined =>
  h.raw.prepare('SELECT * FROM persistent_agent_connections WHERE id = ?').get(id) as Record<string, unknown> | undefined;
const msg = (id: string): Record<string, unknown> =>
  h.raw.prepare('SELECT * FROM persistent_agent_messages WHERE id = ?').get(id) as Record<string, unknown>;
const setConn = (id: string, cols: Record<string, unknown>): void => {
  const keys = Object.keys(cols);
  h.raw.prepare(`UPDATE persistent_agent_connections SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => cols[k]), id);
};
const credOf = (connectionId: string): string => String(conn(connectionId)?.credential_id);

/** Switch the agent to a new connection of the same connector and mark it verified (not yet advanced). */
async function startSwitch(agentId: string, kind: 'bridge' | 'native' = 'bridge', credentialId?: string): Promise<string> {
  const r = await h.connections.switchConnection({
    agentId,
    connection: kind === 'bridge'
      ? bridgeInput()
      : { kind: 'native', connectorId: 'claude-managed-agents', remote: {}, credential: { mode: 'existing', credentialId: credentialId ?? '' } },
  });
  return r.connectionId;
}

describe('connect', () => {
  it('connect happy path returns the pairing payload with token once; getPairing returns it without token until expiry', async () => {
    const fake = createFakeConnector({ now: () => h.clock.now() });
    h = makeHarness({ connectors: [fake] });
    const r = await connectBridge('Muse', 'relay-http');
    expect(r.pairing?.oneTimeToken).toBe('cbh_onetime_secret');
    expect(conn(r.connectionId)?.remote_json).not.toContain('cbh_');
    const cached = h.connections.getPairing(r.connectionId);
    expect(cached?.oneTimeToken).toBeNull();
    expect(cached?.instructionBrief).toBeNull();
    expect(cached?.mcpUrl).toBe(r.pairing?.mcpUrl);
    h.clock.advance(10 * 60_000);
    expect(h.connections.getPairing(r.connectionId)).toBeNull();
  });

  it('connect remote failure deletes the agent', async () => {
    const fake = createFakeConnector();
    h = makeHarness({ connectors: [fake] });
    fake.script.pushConnect(new ConnectorError('conflict', 'limit', { code: 'connection_limit' }));
    await expect(connectBridge()).rejects.toMatchObject({ kind: 'conflict' });
    expect((h.raw.prepare('SELECT COUNT(*) AS n FROM persistent_agents').get() as { n: number }).n).toBe(0);
  });

  it('rollbackConnect called when txn B throws', async () => {
    const fake = createFakeConnector();
    h = makeHarness({ connectors: [fake] });
    vi.spyOn(h.store, 'completeConnectionCreate').mockRejectedValueOnce(new Error('disk full'));
    await expect(connectBridge()).rejects.toThrow('disk full');
    expect(fake.calls.map((c) => c.method)).toEqual(['connect', 'rollbackConnect']);
    expect((h.raw.prepare('SELECT COUNT(*) AS n FROM persistent_agents').get() as { n: number }).n).toBe(0);
  });

  it('crash after createAgent → recoverOnBoot deletes it', async () => {
    const fake = createFakeConnector();
    h = makeHarness({ connectors: [fake] });
    await h.store.createAgent({
      agent: { displayName: 'Half', vendor: 'other' },
      connection: { kind: 'bridge', connectorId: 'bridge', connectorVersion: 1, transport: 'relay-mcp', credentialId: null, descriptor: fake.registration.definition.capabilities },
    });
    await h.connections.recoverOnBoot();
    expect((h.raw.prepare('SELECT COUNT(*) AS n FROM persistent_agents').get() as { n: number }).n).toBe(0);
  });

  it('disconnect while the first remote create is outstanding revokes the late remote object and hands out no pairing', async () => {
    const fake = createFakeConnector({ now: () => h.clock.now() });
    h = makeHarness({ connectors: [fake] });
    fake.script.pushConnect(async () => {
      const req = fake.calls.find((c) => c.method === 'connect')?.args[0] as ConnectRequest;
      const res = await h.connections.disconnect(req.agent.id);
      expect(res.remoteRevoke).toBe('pending');
      return {
        remoteId: 'remote-late', remote: { label: 'x' }, transport: 'relay-mcp', inboundCursor: null, relayEpoch: 1, facts: [],
        pairing: {
          kind: 'bridge', connectionId: req.connectionId, transport: 'relay-mcp', mcpUrl: 'https://relay.example.test/mcp/late',
          httpBase: 'https://relay.example.test/http/late', pairingCode: 'LATE-CODE-0001',
          pairingExpiresAt: new Date(h.clock.now().getTime() + 600_000).toISOString(), oneTimeToken: null, instructionBrief: null,
        },
      };
    });
    const r = await connectBridge();
    expect(r.pairing).toBeNull();
    expect(h.connections.getPairing(r.connectionId)).toBeNull();
    expect(conn(r.connectionId)).toMatchObject({ state: 'revoked', remote_id: 'remote-late', remote_revoke_state: 'pending', connect_state: null });
    await h.connections.runRevokeRetries();
    expect(fake.calls.some((c) => c.method === 'disconnect' && c.handle?.connectionId === r.connectionId)).toBe(true);
    expect(conn(r.connectionId)?.remote_revoke_state).toBe('done');
  });

  it('an unexpected connect failure is wrapped as a retryable ConnectorError and reported', async () => {
    const fake = createFakeConnector();
    h = makeHarness({ connectors: [fake] });
    const boom = new TypeError('boom');
    fake.script.pushConnect(boom);
    await expect(connectBridge()).rejects.toMatchObject({ name: 'ConnectorError', kind: 'retryable' });
    expect(h.capture).toHaveBeenCalledWith('connector-connect', boom, expect.objectContaining({ connectorId: 'bridge', errorKind: 'retryable' }));
  });

  it('connect refused when connector unavailable (signed out)', async () => {
    const fake = createFakeConnector();
    h = makeHarness({ connectors: [fake] });
    fake.script.setAvailability({ state: 'signed_out', message: 'Sign in to cyboflow cloud to use the Bridge.', retryAt: null });
    await expect(connectBridge()).rejects.toBeInstanceOf(ConnectorUnavailableError);
    expect(fake.calls).toHaveLength(0);
    expect((h.raw.prepare('SELECT COUNT(*) AS n FROM persistent_agents').get() as { n: number }).n).toBe(0);
  });
});

describe('swap', () => {
  const RESUMABLE: SwapState[] = ['awaiting_verify', 'fencing', 'reconciling', 'revoking_remote', 'activating'];
  for (const state of RESUMABLE) {
    it(`crash at swap_state ${state} resumes`, async () => {
      const fake = createFakeConnector();
      h = makeHarness({ connectors: [fake] });
      const { agentId, connectionId: o } = await connectBridge();
      const n = await startSwitch(agentId);
      setConn(n, { swap_state: state, state: 'verified' });
      await h.connections.recoverOnBoot();
      expect(conn(o)).toMatchObject({ is_current: 0, state: 'revoked' });
      expect(conn(n)).toMatchObject({ is_current: 1, swap_state: null });
    });
  }

  it('crash at swap_state connecting resumes by aborting the new connection', async () => {
    const fake = createFakeConnector();
    h = makeHarness({ connectors: [fake] });
    const { agentId, connectionId: o } = await connectBridge();
    const { connectionId: n } = await h.store.createPendingConnection(agentId, {
      kind: 'bridge', connectorId: 'bridge', connectorVersion: 1, transport: 'relay-mcp', credentialId: null, descriptor: fake.registration.definition.capabilities,
    });
    await h.connections.recoverOnBoot();
    expect(conn(n)).toBeUndefined();
    expect(conn(o)).toMatchObject({ is_current: 1, swap_error: 'Interrupted while connecting' });
  });

  it('a send in flight during swap settles late and is never re-sent through the new connection', async () => {
    const fake = createFakeConnector({ kind: 'native' });
    h = makeHarness({ connectors: [fake] });
    const { agentId, connectionId: o } = await connectNative();
    const { messageId } = await h.store.enqueueOutbound(agentId, { kind: 'text', body: 'held', links: [] });
    let release: () => void = () => undefined;
    fake.script.pushSend(() => new Promise<SendReceipt>((r) => { release = () => r({ state: 'sent', acceptedAt: h.clock.now().toISOString() }); }));
    fake.script.setDefaultReconcile('unknown');
    const sendRun = h.outbox._runForTest(agentId);
    await vi.waitFor(() => expect(msg(messageId).send_state).toBe('in_flight'));
    const n = await startSwitch(agentId, 'native', credOf(o));
    setConn(n, { state: 'verified' });
    await h.connections.onConnectionVerified(n);
    expect(conn(n)?.is_current).toBe(1);
    release();
    await sendRun;
    await h.outbox._runForTest(agentId);
    const sendsOnN = fake.calls.filter((c) => c.method === 'send' && c.handle?.connectionId === n
      && (c.args[0] as { id: string }).id === messageId);
    expect(sendsOnN).toHaveLength(0);
    expect(msg(messageId).connection_id).toBe(o);
  });

  it('in-flight older than 60 s becomes ambiguous and is reconciled on the old connector', async () => {
    const fake = createFakeConnector({ kind: 'native' });
    h = makeHarness({ connectors: [fake] });
    const { agentId, connectionId: o } = await connectNative();
    const { messageId } = await h.store.enqueueOutbound(agentId, { kind: 'text', body: 'stuck', links: [] });
    await h.store.claimOutbound(agentId, h.clock.now()); // never settles
    fake.script.setDefaultReconcile('found');
    const n = await startSwitch(agentId, 'native', credOf(o));
    setConn(n, { state: 'verified' });
    await h.connections.onConnectionVerified(n);
    const rec = fake.calls.find((c) => c.method === 'reconcile');
    expect(rec?.handle?.connectionId).toBe(o);
    expect(msg(messageId)).toMatchObject({ send_state: 'sent', connection_id: o });
  });

  it('a remote revoke that keeps failing does not block activation and is retried', async () => {
    const fake = createFakeConnector({ kind: 'native' });
    h = makeHarness({ connectors: [fake] });
    const { agentId, connectionId: o } = await connectNative();
    for (let i = 0; i < REVOKE_MAX_ATTEMPTS + 5; i++) fake.script.pushDisconnect(new ConnectorError('retryable', 'Revoke pending', { code: 'revoke_pending' }));
    const n = await startSwitch(agentId, 'native', credOf(o));
    setConn(n, { state: 'verified' });
    await h.connections.onConnectionVerified(n);
    expect(conn(n)?.is_current).toBe(1);
    expect(conn(o)).toMatchObject({ remote_revoke_state: 'pending', remote_revoke_attempts: 1 });
    const gaps: number[] = [];
    let surfacedAt = -1;
    for (let attempt = 1; attempt < REVOKE_MAX_ATTEMPTS; attempt++) {
      const nextAt = Date.parse(String(conn(o)?.remote_revoke_next_at));
      gaps.push(nextAt - h.clock.now().getTime());
      h.clock.set(nextAt - 1);
      await h.connections.runRevokeRetries();
      expect(conn(o)?.remote_revoke_attempts).toBe(attempt); // not due yet
      h.clock.set(nextAt);
      await h.connections.runRevokeRetries();
      const row = h.store.getConnectionRow(o);
      if (row && surfacedAt < 0 && buildConnectionView(row, { lookup: () => undefined, agent: h.store.getAgentRow(agentId)!, credentials: new Map() }).remoteRevoke?.surfaced) {
        surfacedAt = row.remote_revoke_attempts;
      }
    }
    expect(gaps.slice(0, 6)).toEqual([...REVOKE_BACKOFF_MS, REVOKE_BACKOFF_MS[4]]);
    expect(surfacedAt).toBe(3);
    expect(conn(o)).toMatchObject({ remote_revoke_state: 'gave_up', remote_revoke_attempts: REVOKE_MAX_ATTEMPTS });
  });

  it('paused revoke failure does not count an attempt', async () => {
    const fake = createFakeConnector();
    h = makeHarness({ connectors: [fake] });
    const { agentId, connectionId } = await connectBridge();
    fake.script.pushDisconnect(new ConnectorError('paused', 'Signed out', { code: 'signed_out' }));
    const res = await h.connections.disconnect(agentId);
    expect(res.remoteRevoke).toBe('pending');
    expect(conn(connectionId)).toMatchObject({ remote_revoke_state: 'pending', remote_revoke_attempts: 0 });
    expect(Date.parse(String(conn(connectionId)?.remote_revoke_next_at)) - h.clock.now().getTime()).toBe(10 * 60_000);
  });

  it('swap fails if new connection is revoked before verify; old stays current', async () => {
    const fake = createFakeConnector();
    h = makeHarness({ connectors: [fake] });
    const { agentId, connectionId: o } = await connectBridge();
    const n = await startSwitch(agentId);
    await h.connections.onConnectionGone(n, new ConnectorError('not_found', 'gone', { httpStatus: 404 }));
    expect(conn(o)?.is_current).toBe(1);
    expect(conn(n)).toMatchObject({ is_current: 0, swap_state: null, state: 'revoked' });
  });

  it('cancelSwitch only before fencing', async () => {
    const fake = createFakeConnector();
    h = makeHarness({ connectors: [fake] });
    const { agentId } = await connectBridge();
    const n1 = await startSwitch(agentId);
    await h.connections.cancelSwitch(agentId);
    expect(conn(n1)).toMatchObject({ swap_state: null, swap_error: 'Switch cancelled', state: 'revoked', remote_revoke_state: 'pending' });
    const n2 = await startSwitch(agentId);
    setConn(n2, { swap_state: 'fencing' });
    await expect(h.connections.cancelSwitch(agentId)).rejects.toBeInstanceOf(NoSwapInProgressError);
    expect(conn(n2)?.swap_state).toBe('fencing');
  });

  it('cancelSwitch racing onConnectionVerified is rejected', async () => {
    const fake = createFakeConnector();
    h = makeHarness({ connectors: [fake] });
    const { agentId } = await connectBridge();
    const n = await startSwitch(agentId);
    setConn(n, { state: 'verified' });
    const verified = h.connections.onConnectionVerified(n);
    await expect(h.connections.cancelSwitch(agentId)).rejects.toThrow('The switch is already finishing.');
    await verified;
    expect(conn(n)).toMatchObject({ is_current: 1, swap_state: null });
  });

  it('swap drains o before revoke (inbound posted after the last poll is stored)', async () => {
    const fake = createFakeConnector();
    h = makeHarness({ connectors: [fake] });
    const { agentId, connectionId: o } = await connectBridge();
    const n = await startSwitch(agentId);
    const late: InboundBatch = emptyBatch({
      messages: [{ remoteEventId: 'late-reply', author: 'agent', kind: 'text', body: 'last words', links: [], remoteCreatedAt: null }],
      hasMore: false, ackToken: 'a1',
    });
    fake.script.pushPull(async () => late);
    let storedAtDisconnect = -1;
    const disconnect = fake.connector.disconnect.bind(fake.connector);
    fake.connector.disconnect = async (hh, opts) => {
      storedAtDisconnect = (h.raw.prepare(`SELECT COUNT(*) AS n FROM persistent_agent_messages WHERE remote_event_id = 'late-reply'`).get() as { n: number }).n;
      return disconnect(hh, opts);
    };
    setConn(n, { state: 'verified' });
    await h.connections.onConnectionVerified(n);
    const order = fake.calls.map((c) => `${c.method}:${c.handle?.connectionId === o ? 'o' : 'n'}`);
    expect(order.indexOf('pull:o')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('pull:o')).toBeLessThan(order.indexOf('disconnect:o'));
    expect(storedAtDisconnect).toBe(1);
    expect(conn(o)?.remote_revoke_state).toBe('done');
  });

  it('failed revoke keeps pulling o until revoke done', async () => {
    const fake = createFakeConnector();
    h = makeHarness({ connectors: [fake] });
    const { agentId, connectionId: o } = await connectBridge();
    const n = await startSwitch(agentId);
    fake.script.pushDisconnect(new ConnectorError('retryable', 'Revoke pending', { code: 'revoke_pending', retryAfterMs: 5_000 }));
    setConn(n, { state: 'verified' });
    await h.connections.onConnectionVerified(n);
    expect(conn(o)).toMatchObject({ state: 'revoked', remote_revoke_state: 'pending' });
    expect(h.store.listPumpTargets().map((t) => t.id)).toContain(o);
    await h.store.recordRemoteRevoke(o, { ok: true });
    expect(h.store.listPumpTargets().map((t) => t.id)).not.toContain(o);
  });

  it('swap chain stops when a CAS fails', async () => {
    const fake = createFakeConnector();
    h = makeHarness({ connectors: [fake] });
    const { agentId, connectionId: o } = await connectBridge();
    const { messageId } = await h.store.enqueueOutbound(agentId, { kind: 'text', body: 'amb', links: [] });
    h.raw.prepare(`UPDATE persistent_agent_messages SET send_state = 'ambiguous' WHERE id = ?`).run(messageId);
    const n = await startSwitch(agentId);
    let release: () => void = () => undefined;
    fake.script.pushReconcile(() => new Promise<ReconcileResult[]>((r) => { release = () => r([{ messageId, outcome: 'unknown' }]); }));
    setConn(n, { state: 'verified' });
    const chain = h.connections.onConnectionVerified(n);
    await vi.waitFor(() => expect(fake.calls.some((c) => c.method === 'reconcile')).toBe(true));
    // the swap is failed underneath the chain (e.g. a disconnect)
    expect(await h.store.failSwap(n, 'Disconnected', { revokeNew: true, fromStates: ['reconciling'] })).toBe(true);
    release();
    await chain;
    expect(conn(n)).toMatchObject({ is_current: 0, swap_state: null });
    expect(conn(o)).toMatchObject({ is_current: 1, remote_revoke_state: null });
    expect(fake.calls.some((c) => c.method === 'disconnect' && c.handle?.connectionId === o)).toBe(false);
  });
});

describe('disconnect / control / repair', () => {
  it('disconnect offers forget only for the last reference', async () => {
    const fake = createFakeConnector({ kind: 'native' });
    h = makeHarness({ connectors: [fake] });
    const a = await connectNative('A');
    const credentialId = credOf(a.connectionId);
    const b = await connectNative('B', credentialId);
    const first = await h.connections.disconnect(a.agentId);
    expect(first.offerForgetCredentialId).toBeNull();
    expect(first.remoteRevoke).toBe('done');
    const second = await h.connections.disconnect(b.agentId);
    expect(second.offerForgetCredentialId).toBe(credentialId);
  });

  it('a named core error from a connector call passes through unchanged and is not reported', async () => {
    const fake = createFakeConnector({ kind: 'native', withControl: true });
    h = makeHarness({ connectors: [fake] });
    const { agentId, connectionId } = await connectNative();
    fake.script.pushVerify(new CredentialUndecryptableError(credOf(connectionId)));
    await expect(h.connections.verify(connectionId)).rejects.toBeInstanceOf(CredentialUndecryptableError);
    fake.connector.control = async () => { throw new CredentialUndecryptableError(credOf(connectionId)); };
    await expect(h.connections.control(agentId, 'interrupt')).rejects.toMatchObject({ name: 'CredentialUndecryptableError' });
    expect(h.capture).not.toHaveBeenCalled();
    expect(conn(connectionId)?.state).not.toBe('auth_failed');
  });

  it('control allowed when declared even if unobserved; refused when undeclared', async () => {
    const fake = createFakeConnector({ kind: 'native', withControl: true });
    h = makeHarness({ connectors: [fake] });
    const { agentId } = await connectNative();
    await h.connections.control(agentId, 'interrupt');
    expect(fake.calls.filter((c) => c.method === 'control').map((c) => c.args[0])).toEqual(['interrupt']);
    await expect(h.connections.control(agentId, 'end')).rejects.toBeInstanceOf(ControlNotSupportedError);
  });

  it('repairPairing sets pending and returns a new code', async () => {
    const fake = createFakeConnector({ now: () => h.clock.now() });
    h = makeHarness({ connectors: [fake] });
    const { connectionId } = await connectBridge();
    setConn(connectionId, { state: 'verified', verified_at: h.clock.now().toISOString(), remote_json: JSON.stringify({ pairedClient: { name: 'x', redirectHost: 'x.test', pairedAt: 1 } }) });
    const kick = vi.spyOn(h.pump, 'noteActive');
    const pairing = await h.connections.repairPairing(connectionId);
    expect(pairing.pairingCode).toBe('NEW-CODE-9999');
    expect(conn(connectionId)).toMatchObject({ state: 'pending', relay_epoch: 2, inbound_cursor: 'bridge:v1:2:0' });
    expect(JSON.parse(String(conn(connectionId)?.remote_json)).pairedClient).toBeNull();
    expect(h.connections.getPairing(connectionId)?.pairingCode).toBe('NEW-CODE-9999');
    expect(kick).toHaveBeenCalledWith(connectionId);
  });
});
