/**
 * persistentAgentsStore: init idempotency, feature gating, subscribe-then-seed ordering, debounced signals,
 * stale-response dropping, thread subscriptions (ref-counted, merged by id, hole detection), markRead
 * debouncing and the mutation wrappers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DISABLED_PERSISTENT_AGENTS_STATUS } from '../../../../shared/types/persistentAgents';
import type { AppConfig } from '../../types/config';
import { makeAgent, makeBridgeConnector, makeMessage, makeStatus } from '../../components/agentsEnv/__tests__/fixtures';
import type { AgentsChangedEvent, ThreadEvent } from '../../components/agentsEnv/types';

type Handlers<T> = { onData: (v: T) => void; onError: (e: unknown) => void };

let order: string[];
let statusQuery: ReturnType<typeof vi.fn>;
let listAgentsQuery: ReturnType<typeof vi.fn>;
let listConnectorsQuery: ReturnType<typeof vi.fn>;
let getThreadQuery: ReturnType<typeof vi.fn>;
let sendMutate: ReturnType<typeof vi.fn>;
let markReadMutate: ReturnType<typeof vi.fn>;
let switchMutate: ReturnType<typeof vi.fn>;
let cancelSwitchMutate: ReturnType<typeof vi.fn>;
let archiveMutate: ReturnType<typeof vi.fn>;
let agentsSubscribe: ReturnType<typeof vi.fn>;
let threadSubscribe: ReturnType<typeof vi.fn>;
let agentsUnsub: ReturnType<typeof vi.fn>;
let threadUnsub: ReturnType<typeof vi.fn>;
let agentsHandlers: Handlers<AgentsChangedEvent> | null;
let threadHandlers: Handlers<ThreadEvent> | null;

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      persistentAgents: {
        status: { get query() { return statusQuery; } },
        listAgents: { get query() { return listAgentsQuery; } },
        listConnectors: { get query() { return listConnectorsQuery; } },
        getThread: { get query() { return getThreadQuery; } },
        send: { get mutate() { return sendMutate; } },
        markRead: { get mutate() { return markReadMutate; } },
        switchConnection: { get mutate() { return switchMutate; } },
        cancelSwitch: { get mutate() { return cancelSwitchMutate; } },
        archiveAgent: { get mutate() { return archiveMutate; } },
        onAgentsChanged: { get subscribe() { return agentsSubscribe; } },
        onThreadEvent: { get subscribe() { return threadSubscribe; } },
      },
    },
  },
}));

import { usePersistentAgentsStore, mergeThreadMessages, THREAD_PAGE_SIZE } from '../persistentAgentsStore';
import { useConfigStore } from '../configStore';

const store = usePersistentAgentsStore;
const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};
const mk = (i: number, over: Parameters<typeof makeMessage>[0] = {}) =>
  makeMessage({ id: `m${i}`, createdAt: new Date(Date.UTC(2026, 9, 7, 10, 0, i)).toISOString(), ...over });

let teardown: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  order = [];
  agentsHandlers = null;
  threadHandlers = null;
  agentsUnsub = vi.fn();
  threadUnsub = vi.fn();
  statusQuery = vi.fn().mockResolvedValue(makeStatus());
  listAgentsQuery = vi.fn().mockImplementation(async () => {
    order.push('listAgents');
    return [makeAgent()];
  });
  listConnectorsQuery = vi.fn().mockResolvedValue([makeBridgeConnector()]);
  getThreadQuery = vi.fn().mockResolvedValue({ agentId: 'a1', messages: [], hasMore: false });
  sendMutate = vi.fn().mockResolvedValue({ ok: true, messageId: 'm9' });
  markReadMutate = vi.fn().mockResolvedValue({ unread: 0 });
  switchMutate = vi.fn().mockResolvedValue({ ok: true, agentId: 'a1', connectionId: 'c2', pairing: null });
  cancelSwitchMutate = vi.fn().mockResolvedValue({ ok: true });
  archiveMutate = vi.fn().mockResolvedValue({ ok: true });
  agentsSubscribe = vi.fn().mockImplementation((_i: undefined, h: Handlers<AgentsChangedEvent>) => {
    order.push('subscribe');
    agentsHandlers = h;
    return { unsubscribe: agentsUnsub };
  });
  threadSubscribe = vi.fn().mockImplementation((_i: { agentId: string }, h: Handlers<ThreadEvent>) => {
    threadHandlers = h;
    return { unsubscribe: threadUnsub };
  });
  store.setState({ featureStatus: null, connectors: null, agents: [], agentsStatus: 'idle', agentsError: null, threads: {} });
  useConfigStore.setState({ config: null });
});

afterEach(() => {
  teardown?.();
  teardown = null;
  vi.useRealTimers();
});

async function start(): Promise<void> {
  teardown = store.getState().init();
  await advance(0);
}

describe('persistentAgentsStore: lifecycle', () => {
  it('init is idempotent', async () => {
    const t1 = store.getState().init();
    const t2 = store.getState().init();
    teardown = t1;
    await advance(0);
    expect(statusQuery).toHaveBeenCalledTimes(1);
    expect(t2).toBe(t1);
  });

  it('a disabled status opens no subscription', async () => {
    statusQuery.mockResolvedValue(makeStatus({ enabled: false, running: false, configEnabled: false }));
    await start();
    expect(agentsSubscribe).not.toHaveBeenCalled();
    expect(store.getState().agents).toEqual([]);
  });

  it('enabled but killed (running false) opens no subscription and lists nothing', async () => {
    statusQuery.mockResolvedValue(makeStatus({ enabled: true, killed: true, running: false }));
    await start();
    expect(agentsSubscribe).not.toHaveBeenCalled();
    expect(listAgentsQuery).not.toHaveBeenCalled();
    expect(store.getState().agents).toEqual([]);
  });

  it('a throwing status query reads as disabled', async () => {
    statusQuery.mockRejectedValue(new Error('no router'));
    await start();
    expect(store.getState().featureStatus).toEqual(DISABLED_PERSISTENT_AGENTS_STATUS);
  });

  it('subscribes BEFORE seeding listAgents', async () => {
    await start();
    expect(order.slice(0, 2)).toEqual(['subscribe', 'listAgents']);
  });

  it('a signal re-queries, debounced', async () => {
    await start();
    expect(listAgentsQuery).toHaveBeenCalledTimes(1);
    agentsHandlers?.onData({ kind: 'agents', agentId: null });
    agentsHandlers?.onData({ kind: 'unread', agentId: 'a1' });
    agentsHandlers?.onData({ kind: 'agents', agentId: null });
    await advance(100);
    expect(listAgentsQuery).toHaveBeenCalledTimes(1);
    await advance(100);
    expect(listAgentsQuery).toHaveBeenCalledTimes(2);
  });

  it('drops stale listAgents responses', async () => {
    await start();
    let releaseFirst: (v: unknown) => void = () => {};
    listAgentsQuery
      .mockImplementationOnce(() => new Promise((r) => { releaseFirst = r; }))
      .mockResolvedValueOnce([makeAgent({ id: 'second' })]);
    const first = store.getState().refreshAgents();
    const second = store.getState().refreshAgents();
    await second;
    releaseFirst([makeAgent({ id: 'first' })]);
    await first;
    expect(store.getState().agents.map((a) => a.id)).toEqual(['second']);
  });

  it('reopens after a subscription error and re-seeds', async () => {
    await start();
    agentsHandlers?.onError(new Error('x'));
    await advance(1000);
    expect(agentsSubscribe).toHaveBeenCalledTimes(2);
    expect(listAgentsQuery).toHaveBeenCalledTimes(2);
  });

  it('a config change re-reads the status and a disable tears the subscription down', async () => {
    await start();
    expect(store.getState().agents).toHaveLength(1);
    statusQuery.mockResolvedValue(makeStatus({ enabled: false, running: false }));
    useConfigStore.setState({ config: { agents: { enabled: false } } as unknown as AppConfig });
    await advance(0);
    expect(agentsUnsub).toHaveBeenCalled();
    expect(store.getState().agents).toEqual([]);
  });

  it('teardown closes every subscription and ignores late results', async () => {
    await start();
    let release: (v: unknown) => void = () => {};
    listAgentsQuery.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const pending = store.getState().refreshAgents();
    const releaseThread = store.getState().openThread('a1');
    expect(releaseThread).toBeTypeOf('function');
    teardown?.();
    teardown = null;
    expect(agentsUnsub).toHaveBeenCalled();
    expect(threadUnsub).toHaveBeenCalled();
    store.setState({ agents: [] });
    release([makeAgent({ id: 'late' })]);
    await pending;
    expect(store.getState().agents).toEqual([]);
  });
});

describe('persistentAgentsStore: connectors', () => {
  beforeEach(start);

  it('loadConnectors is not cached: two calls, two queries', async () => {
    await store.getState().loadConnectors();
    await store.getState().loadConnectors();
    expect(listConnectorsQuery).toHaveBeenCalledTimes(2);
  });

  it('keeps the previous connectors when a reload fails', async () => {
    await store.getState().loadConnectors();
    listConnectorsQuery.mockRejectedValueOnce(new Error('x'));
    const res = await store.getState().loadConnectors();
    expect(res).toHaveLength(1);
    expect(store.getState().connectors).toHaveLength(1);
  });

  it('a connection signal with no agent re-queries listConnectors', async () => {
    await start();
    expect(listConnectorsQuery).not.toHaveBeenCalled();
    agentsHandlers?.onData({ kind: 'connection', agentId: null });
    await advance(200);
    expect(listConnectorsQuery).toHaveBeenCalledTimes(1);
    agentsHandlers?.onData({ kind: 'connection', agentId: 'a1' });
    await advance(200);
    expect(listConnectorsQuery).toHaveBeenCalledTimes(1);
  });
});

describe('persistentAgentsStore: threads', () => {
  beforeEach(start);

  it('openThread is ref-counted', async () => {
    const r1 = store.getState().openThread('a1');
    const r2 = store.getState().openThread('a1');
    await advance(0);
    expect(threadSubscribe).toHaveBeenCalledTimes(1);
    r1();
    r1();
    expect(threadUnsub).not.toHaveBeenCalled();
    r2();
    expect(threadUnsub).toHaveBeenCalledTimes(1);
  });

  it('seeds the thread and keeps the cache across a reopen', async () => {
    getThreadQuery.mockResolvedValue({ agentId: 'a1', messages: [mk(1), mk(2)], hasMore: false });
    const release = store.getState().openThread('a1');
    await advance(0);
    expect(store.getState().threads.a1.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    release();
    getThreadQuery.mockImplementation(() => new Promise(() => {}));
    store.getState().openThread('a1');
    expect(store.getState().threads.a1.messages).toHaveLength(2);
  });

  it('a thread signal refetches and replaces by id', async () => {
    getThreadQuery.mockResolvedValue({ agentId: 'a1', messages: [mk(1, { direction: 'out', sendState: 'on_bridge' })], hasMore: false });
    store.getState().openThread('a1');
    await advance(0);
    expect(store.getState().threads.a1.messages[0].pickedUpAt).toBeNull();
    getThreadQuery.mockResolvedValue({
      agentId: 'a1',
      messages: [mk(1, { direction: 'out', sendState: 'on_bridge', pickedUpAt: '2026-10-07T10:05:00.000Z' })],
      hasMore: false,
    });
    threadHandlers?.onData({ agentId: 'a1', kind: 'receipts', messageIds: ['m1'] });
    await advance(200);
    const msgs = store.getState().threads.a1.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].pickedUpAt).toBe('2026-10-07T10:05:00.000Z');
  });

  it('loadEarlier prepends with before = the oldest id', async () => {
    getThreadQuery.mockResolvedValue({ agentId: 'a1', messages: [mk(5), mk(6)], hasMore: true });
    store.getState().openThread('a1');
    await advance(0);
    getThreadQuery.mockResolvedValue({ agentId: 'a1', messages: [mk(3), mk(4)], hasMore: false });
    await store.getState().loadEarlier('a1');
    expect(getThreadQuery).toHaveBeenLastCalledWith({ agentId: 'a1', before: 'm5', limit: THREAD_PAGE_SIZE });
    const t = store.getState().threads.a1;
    expect(t.messages.map((m) => m.id)).toEqual(['m3', 'm4', 'm5', 'm6']);
    expect(t.hasMore).toBe(false);
  });

  it('a refetch that leaves a hole discards the cache', async () => {
    getThreadQuery.mockResolvedValue({ agentId: 'a1', messages: [mk(1), mk(2), mk(3)], hasMore: false });
    store.getState().openThread('a1');
    await advance(0);
    const page = Array.from({ length: 100 }, (_, i) => mk(10 + i));
    getThreadQuery.mockResolvedValue({ agentId: 'a1', messages: page, hasMore: true });
    threadHandlers?.onData({ agentId: 'a1', kind: 'messages', messageIds: [] });
    await advance(200);
    const t = store.getState().threads.a1;
    expect(t.messages).toHaveLength(100);
    expect(t.messages[0].id).toBe('m10');
    expect(t.hasMore).toBe(true);
  });

  it('send refetches on ok and returns a LocalFailure on a throw', async () => {
    store.getState().openThread('a1');
    await advance(0);
    const calls = getThreadQuery.mock.calls.length;
    const ok = await store.getState().send('a1', 'hi');
    expect(ok).toEqual({ ok: true, messageId: 'm9' });
    expect(sendMutate).toHaveBeenCalledWith({ agentId: 'a1', text: 'hi' });
    await advance(0);
    expect(getThreadQuery.mock.calls.length).toBe(calls + 1);
    sendMutate.mockRejectedValue(new Error('ipc down'));
    const bad = await store.getState().send('a1', 'hi');
    expect(bad).toEqual({ ok: false, error: 'unknown', message: 'ipc down' });
  });

  it('markRead zeroes the unread count at once and calls the mutation once (debounced)', async () => {
    store.setState({ agents: [makeAgent({ unreadCount: 3 })] });
    store.getState().markRead('a1');
    store.getState().markRead('a1');
    expect(store.getState().agents[0].unreadCount).toBe(0);
    await advance(100);
    expect(markReadMutate).not.toHaveBeenCalled();
    await advance(300);
    expect(markReadMutate).toHaveBeenCalledTimes(1);
    expect(markReadMutate).toHaveBeenCalledWith({ agentId: 'a1' });
  });
});

describe('mergeThreadMessages', () => {
  it('unions by id, incoming wins, sorted by createdAt then id (SQLite and ISO shapes)', () => {
    const a = makeMessage({ id: 'b', createdAt: '2026-10-07 10:00:00', body: 'old' });
    const b = makeMessage({ id: 'a', createdAt: '2026-10-07T10:00:00.000Z' });
    const c = makeMessage({ id: 'c', createdAt: '2026-10-07T09:59:00.000Z' });
    const incoming = makeMessage({ id: 'b', createdAt: '2026-10-07T10:00:00.000Z', body: 'new' });
    const out = mergeThreadMessages([a, b], [incoming, c]);
    expect(out.map((m) => m.id)).toEqual(['c', 'a', 'b']);
    expect(out[2].body).toBe('new');
  });
});

describe('persistentAgentsStore: mutations', () => {
  beforeEach(start);

  it('switchConnection, cancelSwitch and archiveAgent call their mutations and refresh agents on ok', async () => {
    const before = listAgentsQuery.mock.calls.length;
    await store.getState().switchConnection('a1', { kind: 'bridge', connectorId: 'bridge', transport: 'relay-mcp' });
    expect(switchMutate).toHaveBeenCalledWith({
      agentId: 'a1',
      connection: { kind: 'bridge', connectorId: 'bridge', transport: 'relay-mcp' },
    });
    await store.getState().cancelSwitch('a1');
    expect(cancelSwitchMutate).toHaveBeenCalledWith({ agentId: 'a1' });
    await store.getState().archiveAgent('a1');
    expect(archiveMutate).toHaveBeenCalledWith({ agentId: 'a1' });
    await advance(0);
    expect(listAgentsQuery.mock.calls.length).toBe(before + 3);
  });

  it('does not refresh agents when the mutation reports a non-not_found failure', async () => {
    archiveMutate.mockResolvedValue({ ok: false, error: 'invalid', message: 'bad' });
    const before = listAgentsQuery.mock.calls.length;
    const res = await store.getState().archiveAgent('a1');
    expect(res.ok).toBe(false);
    await advance(0);
    expect(listAgentsQuery.mock.calls.length).toBe(before);
  });

  it('refreshes agents when the mutation reports not_found', async () => {
    archiveMutate.mockResolvedValue({ ok: false, error: 'not_found', message: 'gone' });
    const before = listAgentsQuery.mock.calls.length;
    const res = await store.getState().archiveAgent('a1');
    expect(res.ok).toBe(false);
    await advance(0);
    expect(listAgentsQuery.mock.calls.length).toBe(before + 1);
  });
});
