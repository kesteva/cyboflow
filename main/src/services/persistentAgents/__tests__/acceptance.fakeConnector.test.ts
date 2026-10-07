/**
 * End-to-end acceptance of the persistent-agents core with fake connectors: real store, service, pump,
 * outbox and connection service over an in-memory database.
 *
 * connect → verify (probe queued) → send → reply (verified, "Two-way messages" confirmed) →
 * switchConnection to a second connector → verify the new one → swap done: thread intact, handle
 * unchanged, the message still queued on the old connection is delivered through the new one only.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PersistentAgentsService } from '../persistentAgentsService';
import { ConnectorError } from '../connectorErrors';
import type { InboundBatch } from '../connectorContract';
import { deriveChips } from '../../../../../shared/types/persistentAgents';
import { createFakeConnector, emptyBatch, makeHarness, type FakeConnector, type Harness } from './fakeConnector';

let h: Harness;
afterEach(() => { h?.raw.close(); });

const reply = (rid: string, body: string): InboundBatch => emptyBatch({
  messages: [{ remoteEventId: rid, author: 'agent', kind: 'text', body, links: [], remoteCreatedAt: null }],
});
const sendsOf = (f: FakeConnector, messageId: string) =>
  f.calls.filter((c) => c.method === 'send' && (c.args[0] as { id: string }).id === messageId);

describe('persistent agents acceptance (fake connectors)', () => {
  it('connect → verify → send → receive → switch → verify new → swap done', async () => {
    const first = createFakeConnector({ kind: 'native' });
    const second = createFakeConnector({ kind: 'native', id: 'native-two', definition: { displayName: 'Second connector' } });
    h = makeHarness({ connectors: [first, second] });
    const svc = new PersistentAgentsService({
      store: h.store, registry: h.registry, connections: h.connections, credentials: h.credentials, pump: h.pump,
      outbox: h.outbox, now: h.clock.now, logger: h.logger,
      isAvailable: () => true, isConfigEnabled: () => true, isEnabled: () => true, isKilled: () => false, isBridgeKilled: () => false,
    });

    // connect
    const { agentId, connectionId: o } = await svc.connect({
      agent: { displayName: 'Claude Worker', vendor: 'anthropic-cma' },
      connection: { kind: 'native', connectorId: 'claude-managed-agents', remote: {}, credential: { mode: 'new', label: 'Key', secret: 'sk-ant-TEST-ACCEPT-1234' } },
    });
    const handle = svc.listAgents({ includeArchived: false })[0].handle;
    expect(handle).toBe('claude-worker');

    // verify → a probe is queued and sent
    first.script.pushVerify({ facts: [{ key: 'reachable', label: 'Reachable', at: null, status: 'done' }], probe: { body: 'Please reply with "lantern".' } });
    const v = await svc.verify({ connectionId: o });
    expect(v.probeQueued).toBe(true);
    await h.outbox._runForTest(agentId);

    // send
    const { messageId: hello } = await svc.send({ agentId, text: 'hello agent' });
    await h.outbox._runForTest(agentId);
    expect(h.store.getMessageRow(hello)?.send_state).toBe('sent');

    // receive the reply → verified by the round trip
    first.script.pushPull(reply('r1', 'lantern'));
    await h.pump.drainNow(o);
    let view = svc.listAgents({ includeArchived: false })[0];
    expect(view.connection?.state).toBe('verified');
    const messagesChip = deriveChips(view.connection!.capabilities).find((c) => c.key === 'messages');
    expect(messagesChip).toMatchObject({ label: 'Two-way messages', tone: 'success', unconfirmed: false });

    // switch to the second connector
    const credentialId = view.connection?.credential?.id ?? '';
    const sw = await svc.switchConnection({
      agentId,
      connection: { kind: 'native', connectorId: 'native-two', remote: {}, credential: { mode: 'existing', credentialId } },
    });
    const n = sw.connectionId;
    expect(svc.listAgents({ includeArchived: false })[0].pendingSwitch?.swapState).toBe('awaiting_verify');

    // a message sent meanwhile cannot get through the old connection (it backs off, still queued on o)
    first.script.pushSend(new ConnectorError('retryable', 'Unavailable', { maybeDelivered: false }));
    const { messageId: pending } = await svc.send({ agentId, text: 'are you there?' });
    await h.outbox._runForTest(agentId);
    expect(h.store.getMessageRow(pending)).toMatchObject({ send_state: 'queued', connection_id: o });

    // verify the new connection: its probe goes out through n and the agent replies there
    second.script.pushVerify({ facts: [], probe: { body: 'Please reply with "lantern".' } });
    await svc.verify({ connectionId: n });
    await h.outbox._runForTest(agentId);
    second.script.pushPull(reply('r2', 'lantern again'));
    await h.pump.drainNow(n);

    await vi.waitFor(() => expect(h.store.getConnectionRow(n)?.is_current).toBe(1));
    await vi.waitFor(() => expect(h.store.getMessageRow(pending)?.send_state).toBe('sent'));

    view = svc.listAgents({ includeArchived: false })[0];
    expect(view.handle).toBe(handle);
    expect(view.connection?.id).toBe(n);
    expect(view.pendingSwitch).toBeNull();
    expect(h.store.getConnectionRow(o)).toMatchObject({ is_current: 0, state: 'revoked' });

    // the waiting message was delivered through the new connection only
    expect(sendsOf(second, pending)).toHaveLength(1);
    expect(sendsOf(first, pending).every((c) => c.handle?.connectionId === o)).toBe(true);
    expect(h.store.getMessageRow(pending)?.connection_id).toBe(n);

    // the thread is intact: probe, hello, reply, pending, probe on n, reply on n, swap note
    const thread = svc.getThread({ agentId, limit: 50 }).messages;
    expect(thread.map((m) => m.body)).toEqual(expect.arrayContaining(['hello agent', 'lantern', 'are you there?', 'lantern again']));
    expect(thread.some((m) => m.direction === 'local' && m.body.startsWith('Switched to Second connector'))).toBe(true);
  });
});
