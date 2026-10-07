import { describe, it, expect, vi, afterEach } from 'vitest';
import { outboxBackoffMs } from '../outbox';
import { ConnectorError } from '../connectorErrors';
import type { SendReceipt } from '../connectorContract';
import { createFakeConnector, makeHarness, type FakeConnector, type Harness } from './fakeConnector';

let h: Harness;
afterEach(() => { h?.raw.close(); });

async function connectBridge(fake: FakeConnector, name = 'Dot'): Promise<{ agentId: string; connectionId: string }> {
  const r = await h.connections.connect({
    agent: { displayName: name, vendor: 'openai-dots' },
    connection: { kind: 'bridge', connectorId: 'bridge', transport: 'relay-mcp' },
  });
  fake.calls.length = 0;
  return r;
}

async function connectNative(): Promise<{ agentId: string; connectionId: string }> {
  return h.connections.connect({
    agent: { displayName: 'Cma', vendor: 'anthropic-cma' },
    connection: { kind: 'native', connectorId: 'claude-managed-agents', credential: { mode: 'new', label: 'k', secret: 'sk-ant-TEST-123456' }, remote: {} },
  });
}

const msgRow = (id: string): Record<string, unknown> =>
  h.raw.prepare('SELECT * FROM persistent_agent_messages WHERE id = ?').get(id) as Record<string, unknown>;
const connRow = (id: string): Record<string, unknown> =>
  h.raw.prepare('SELECT * FROM persistent_agent_connections WHERE id = ?').get(id) as Record<string, unknown>;
const sends = (f: FakeConnector): number => f.calls.filter((c) => c.method === 'send').length;

describe('OutboxWorker', () => {
  it('backoff schedule', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((a) => outboxBackoffMs(a) / 1000)).toEqual([5, 10, 20, 40, 80, 160, 300, 300]);
  });

  it('retryable sends back off by the schedule (jitter 1)', async () => {
    const fake = createFakeConnector({ now: () => h.clock.now() });
    h = makeHarness({ connectors: [fake] });
    const { agentId } = await connectBridge(fake);
    const { messageId } = await h.store.enqueueOutbound(agentId, { kind: 'text', body: 'x', links: [] });
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      fake.script.pushSend(new ConnectorError('retryable', 'Bridge offline', { maybeDelivered: false }));
      await h.outbox._runForTest(agentId);
      const next = Date.parse(String(msgRow(messageId).next_attempt_at));
      seen.push((next - h.clock.now().getTime()) / 1000);
      h.clock.set(next);
    }
    expect(seen).toEqual([5, 10, 20]);
    expect(msgRow(messageId).send_state).toBe('queued');
  });

  it('maybeDelivered error → ambiguous', async () => {
    const fake = createFakeConnector();
    h = makeHarness({ connectors: [fake] });
    const { agentId } = await connectBridge(fake);
    const { messageId } = await h.store.enqueueOutbound(agentId, { kind: 'text', body: 'x', links: [] });
    fake.script.pushSend(new ConnectorError('retryable', 'timeout', { maybeDelivered: true }));
    await h.outbox._runForTest(agentId);
    expect(msgRow(messageId).send_state).toBe('ambiguous');
  });

  it('reconcile runs before new claims; found → on_bridge, not_found → re-sent once', async () => {
    const fake = createFakeConnector();
    h = makeHarness({ connectors: [fake] });
    const { agentId } = await connectBridge(fake);
    const a = (await h.store.enqueueOutbound(agentId, { kind: 'text', body: 'a', links: [] })).messageId;
    const b = (await h.store.enqueueOutbound(agentId, { kind: 'text', body: 'b', links: [] })).messageId;
    const c = (await h.store.enqueueOutbound(agentId, { kind: 'text', body: 'c', links: [] })).messageId;
    h.raw.prepare(`UPDATE persistent_agent_messages SET send_state = 'ambiguous', send_attempts = 1 WHERE id IN (?, ?)`).run(a, b);
    fake.script.pushReconcile([
      { messageId: a, outcome: 'found', receipt: { state: 'on_bridge', acceptedAt: h.clock.now().toISOString() } },
      { messageId: b, outcome: 'not_found' },
    ]);
    await h.outbox._runForTest(agentId);
    const order = fake.calls.map((x) => x.method);
    expect(order[0]).toBe('reconcile');
    expect(order.filter((m) => m === 'send')).toHaveLength(2);
    const sentIds = fake.calls.filter((x) => x.method === 'send').map((x) => (x.args[0] as { id: string }).id);
    expect(sentIds).toEqual([b, c]);
    expect(msgRow(a).send_state).toBe('on_bridge');
    expect(msgRow(b).send_state).toBe('on_bridge');
  });

  it('auth error → connection auth_failed, message queued, run stops', async () => {
    const fake = createFakeConnector({ kind: 'native' });
    h = makeHarness({ connectors: [fake] });
    const { agentId, connectionId } = await connectNative();
    const m1 = (await h.store.enqueueOutbound(agentId, { kind: 'text', body: '1', links: [] })).messageId;
    await h.store.enqueueOutbound(agentId, { kind: 'text', body: '2', links: [] });
    fake.script.pushSend(new ConnectorError('auth', 'API key rejected', { httpStatus: 401 }));
    await h.outbox._runForTest(agentId);
    expect(sends(fake)).toBe(1);
    expect(connRow(connectionId).state).toBe('auth_failed');
    expect(msgRow(m1).send_state).toBe('queued');
    expect(msgRow(m1).send_attempts).toBe(0);
    const cred = h.raw.prepare('SELECT state FROM vendor_credentials').get() as { state: string };
    expect(cred.state).toBe('auth_failed');
  });

  it('rate_limited → rate_limited_until set, no claim until then', async () => {
    const fake = createFakeConnector();
    h = makeHarness({ connectors: [fake] });
    const { agentId, connectionId } = await connectBridge(fake);
    await h.store.enqueueOutbound(agentId, { kind: 'text', body: '1', links: [] });
    fake.script.pushSend(new ConnectorError('rate_limited', 'busy', { retryAfterMs: 30_000 }));
    await h.outbox._runForTest(agentId);
    const until = String(connRow(connectionId).rate_limited_until);
    expect(Date.parse(until) - h.clock.now().getTime()).toBe(30_000);
    await h.outbox._runForTest(agentId);
    expect(sends(fake)).toBe(1);
    h.clock.advance(30_000);
    await h.outbox._runForTest(agentId);
    expect(sends(fake)).toBe(2);
  });

  it('unregistered connector → queued +5 min', async () => {
    const fake = createFakeConnector();
    h = makeHarness({ connectors: [fake] });
    const { agentId } = await connectBridge(fake);
    const { messageId } = await h.store.enqueueOutbound(agentId, { kind: 'text', body: '1', links: [] });
    h.registry.unregister('bridge');
    await h.outbox._runForTest(agentId);
    const row = msgRow(messageId);
    expect(row.send_state).toBe('queued');
    expect(row.last_error).toBe('Connector disabled');
    expect(Date.parse(String(row.next_attempt_at)) - h.clock.now().getTime()).toBe(5 * 60_000);
  });

  it('not_found on send leaves the message queued and marks the connection revoked', async () => {
    const fake = createFakeConnector();
    h = makeHarness({ connectors: [fake] });
    const { agentId, connectionId } = await connectBridge(fake);
    const { messageId } = await h.store.enqueueOutbound(agentId, { kind: 'text', body: '1', links: [] });
    fake.script.pushSend(new ConnectorError('not_found', 'gone', { httpStatus: 404 }));
    await h.outbox._runForTest(agentId);
    expect(msgRow(messageId).send_state).toBe('queued');
    expect(connRow(connectionId).state).toBe('revoked');
  });

  it('serial per agent: a kick during a run causes exactly one more run, never two concurrent sends', async () => {
    const fake = createFakeConnector();
    h = makeHarness({ connectors: [fake] });
    const { agentId } = await connectBridge(fake);
    let inFlight = 0;
    let maxInFlight = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const held = async (): Promise<SendReceipt> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight -= 1;
      return { state: 'on_bridge', acceptedAt: h.clock.now().toISOString() };
    };
    fake.script.pushSend(held);
    await h.store.enqueueOutbound(agentId, { kind: 'text', body: '1', links: [] });
    const run = h.outbox._runForTest(agentId);
    await vi.waitFor(() => expect(inFlight).toBe(1));
    await h.store.enqueueOutbound(agentId, { kind: 'text', body: '2', links: [] });
    h.outbox.kick(agentId);
    h.outbox.kick(agentId);
    release();
    await run;
    expect(maxInFlight).toBe(1);
    expect(sends(fake)).toBe(2);
  });

  it('crash between claim and settle neither loses nor double-sends when reconcile finds the echo', async () => {
    const fake = createFakeConnector();
    h = makeHarness({ connectors: [fake] });
    const { agentId } = await connectBridge(fake);
    const { messageId } = await h.store.enqueueOutbound(agentId, { kind: 'text', body: 'once', links: [] });
    const claimed = await h.store.claimOutbound(agentId, h.clock.now());
    expect(claimed?.id).toBe(messageId);
    // the send reached the relay, then the app died before settle
    const handle = h.buildHandle(String(claimed?.connection_id));
    if (!handle) throw new Error('no handle');
    await fake.connector.send(handle, { id: messageId, kind: 'text', body: 'once', links: [], contentHash: '', isProbe: false, createdAt: '' }, { signal: new AbortController().signal });
    expect(await h.store.requeueInFlightAsAmbiguous()).toBe(1);
    fake.script.setDefaultReconcile('found');
    await h.outbox._runForTest(agentId);
    expect(sends(fake)).toBe(1);
    expect(fake.calls.some((c) => c.method === 'reconcile')).toBe(true);
    expect(msgRow(messageId).send_state).toBe('on_bridge');
  });

  it('disable → enable → send is claimed and sent', async () => {
    const fake = createFakeConnector();
    h = makeHarness({ connectors: [fake] });
    const { agentId } = await connectBridge(fake);
    await h.store.enqueueOutbound(agentId, { kind: 'text', body: '1', links: [] });
    h.outbox.stop();
    await h.outbox._runForTest(agentId);
    expect(sends(fake)).toBe(0);
    h.outbox.start();
    await h.outbox._runForTest(agentId);
    expect(sends(fake)).toBe(1);
  });

  it('a run with nothing claimable takes no token', async () => {
    const fake = createFakeConnector();
    h = makeHarness({ connectors: [fake] });
    const { agentId } = await connectBridge(fake);
    const take = vi.spyOn(h.budget, 'take');
    await h.outbox._runForTest(agentId);
    expect(take).not.toHaveBeenCalled();
  });

  it('reconcile of 3 items takes 3 tokens', async () => {
    const fake = createFakeConnector();
    h = makeHarness({ connectors: [fake] });
    const { agentId } = await connectBridge(fake);
    for (let i = 0; i < 3; i++) await h.store.enqueueOutbound(agentId, { kind: 'text', body: `${i}`, links: [] });
    h.raw.prepare(`UPDATE persistent_agent_messages SET send_state = 'ambiguous'`).run();
    fake.script.setDefaultReconcile('found');
    const take = vi.spyOn(h.budget, 'take');
    await h.outbox._runForTest(agentId);
    expect(take).toHaveBeenCalledTimes(3);
    expect((fake.calls.find((c) => c.method === 'reconcile')?.args[0] as unknown[]).length).toBe(3);
  });

  it('a paused send refunds the attempt and stops', async () => {
    const fake = createFakeConnector();
    h = makeHarness({ connectors: [fake] });
    const { agentId } = await connectBridge(fake);
    const { messageId } = await h.store.enqueueOutbound(agentId, { kind: 'text', body: '1', links: [] });
    fake.script.pushSend(new ConnectorError('paused', 'Signed out', { code: 'signed_out' }));
    await h.outbox._runForTest(agentId);
    expect(msgRow(messageId).send_state).toBe('queued');
    expect(msgRow(messageId).send_attempts).toBe(0);
    expect(msgRow(messageId).next_attempt_at).toBeNull();
  });

  it('sweep kicks only agents with actionable rows', async () => {
    const fake = createFakeConnector();
    h = makeHarness({ connectors: [fake] });
    const { agentId } = await connectBridge(fake);
    await h.store.enqueueOutbound(agentId, { kind: 'text', body: '1', links: [] });
    const kick = vi.spyOn(h.outbox, 'kick');
    h.outbox.sweep();
    expect(kick).toHaveBeenCalledWith(agentId);
    h.running.value = false;
    kick.mockClear();
    h.outbox.sweep();
    expect(kick).not.toHaveBeenCalled();
  });
});
