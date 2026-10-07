import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { makeAgent, makeMessage, makeStatus } from './fixtures';
import type { ThreadEvent } from '../types';

let getThreadQuery: ReturnType<typeof vi.fn>;
let markReadMutate: ReturnType<typeof vi.fn>;
let threadSubscribe: ReturnType<typeof vi.fn>;
let threadUnsub: ReturnType<typeof vi.fn>;
let listAgentsQuery: ReturnType<typeof vi.fn>;
let threadHandlers: { onData: (e: ThreadEvent) => void } | null;

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      persistentAgents: {
        status: { query: vi.fn().mockResolvedValue({ devBuild: true, configEnabled: true, enabled: true, killed: false, running: true, bridgeDisabled: false }) },
        listAgents: { get query() { return listAgentsQuery; } },
        getThread: { get query() { return getThreadQuery; } },
        markRead: { get mutate() { return markReadMutate; } },
        send: { mutate: vi.fn().mockResolvedValue({ ok: true, messageId: 'x' }) },
        onAgentsChanged: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
        onThreadEvent: { get subscribe() { return threadSubscribe; } },
      },
      cloud: { openDevicesPage: { mutate: vi.fn() } },
    },
  },
}));

import { PersistentAgentThreadView } from '../PersistentAgentThreadView';
import { usePersistentAgentsStore } from '../../../stores/persistentAgentsStore';

const mk = (i: number, over: Parameters<typeof makeMessage>[0] = {}) =>
  makeMessage({ id: `m${i}`, createdAt: new Date(Date.UTC(2026, 9, 7, 10, 0, i)).toISOString(), body: `body ${i}`, ...over });

let teardown: (() => void) | null = null;

beforeEach(() => {
  threadHandlers = null;
  threadUnsub = vi.fn();
  getThreadQuery = vi.fn().mockResolvedValue({ agentId: 'a1', messages: [mk(1)], hasMore: false });
  markReadMutate = vi.fn().mockResolvedValue({ unread: 0 });
  listAgentsQuery = vi.fn().mockResolvedValue([makeAgent({ unreadCount: 2 })]);
  threadSubscribe = vi.fn().mockImplementation((_i: { agentId: string }, h: { onData: (e: ThreadEvent) => void }) => {
    threadHandlers = h;
    return { unsubscribe: threadUnsub };
  });
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  usePersistentAgentsStore.setState({ featureStatus: null, agents: [], agentsStatus: 'idle', threads: {}, connectors: null });
});

afterEach(() => {
  teardown?.();
  teardown = null;
});

async function mount(): Promise<ReturnType<typeof render>> {
  teardown = usePersistentAgentsStore.getState().init();
  await waitFor(() => expect(usePersistentAgentsStore.getState().agents).toHaveLength(1));
  return render(<PersistentAgentThreadView agentId="a1" onBack={vi.fn()} onOpenPairing={vi.fn()} onReconnect={vi.fn()} />);
}

describe('PersistentAgentThreadView', () => {
  it('mounting opens the thread subscription and seeds the thread; unmounting closes it', async () => {
    const { unmount } = await mount();
    expect(threadSubscribe).toHaveBeenCalledTimes(1);
    expect(threadSubscribe.mock.calls[0][0]).toEqual({ agentId: 'a1' });
    await waitFor(() => expect(getThreadQuery).toHaveBeenCalledWith({ agentId: 'a1', limit: 100 }));
    unmount();
    expect(threadUnsub).toHaveBeenCalledTimes(1);
  });

  it('marks read on mount and again for a new inbound message, but not for an outbound-only change', async () => {
    await mount();
    await waitFor(() => expect(markReadMutate).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(markReadMutate).toHaveBeenCalledWith({ agentId: 'a1' });

    // an outbound-only change
    getThreadQuery.mockResolvedValue({ agentId: 'a1', messages: [mk(1), mk(2, { direction: 'out', author: 'user', sendState: 'on_bridge' })], hasMore: false });
    act(() => threadHandlers?.onData({ agentId: 'a1', kind: 'messages', messageIds: ['m2'] }));
    await screen.findByText('body 2');
    await new Promise((r) => setTimeout(r, 450));
    expect(markReadMutate).toHaveBeenCalledTimes(1);

    // a new inbound message
    getThreadQuery.mockResolvedValue({
      agentId: 'a1',
      messages: [mk(1), mk(2, { direction: 'out', author: 'user', sendState: 'on_bridge' }), mk(3)],
      hasMore: false,
    });
    act(() => threadHandlers?.onData({ agentId: 'a1', kind: 'messages', messageIds: ['m3'] }));
    await screen.findByText('body 3');
    await waitFor(() => expect(markReadMutate).toHaveBeenCalledTimes(2), { timeout: 2000 });
  });

  it('Load earlier is offered when hasMore and pages with before = the oldest id', async () => {
    getThreadQuery.mockResolvedValue({ agentId: 'a1', messages: [mk(5), mk(6)], hasMore: true });
    await mount();
    const btn = await screen.findByTestId('thread-load-earlier');
    getThreadQuery.mockResolvedValue({ agentId: 'a1', messages: [mk(3), mk(4)], hasMore: false });
    fireEvent.click(btn);
    await waitFor(() => expect(getThreadQuery).toHaveBeenLastCalledWith({ agentId: 'a1', before: 'm5', limit: 100 }));
    await screen.findByText('body 3');
    expect(screen.queryByTestId('thread-load-earlier')).toBeNull();
  });

  it('a log region renders the messages in order', async () => {
    getThreadQuery.mockResolvedValue({ agentId: 'a1', messages: [mk(1), mk(2), mk(3)], hasMore: false });
    await mount();
    const log = await screen.findByRole('log');
    await screen.findByText('body 3');
    const order = Array.from(log.querySelectorAll('p')).map((p) => p.textContent);
    expect(order).toEqual(['body 1', 'body 2', 'body 3']);
  });

  it('shows the empty state for a Bridge agent with no messages', async () => {
    getThreadQuery.mockResolvedValue({ agentId: 'a1', messages: [], hasMore: false });
    await mount();
    expect(await screen.findByTestId('thread-empty')).toHaveTextContent(
      'No messages yet. Say hello — it reaches My dot the next time it checks in.',
    );
  });

  it('shows an alert with Retry when the first load fails', async () => {
    getThreadQuery.mockRejectedValue(new Error('boom'));
    await mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    getThreadQuery.mockResolvedValue({ agentId: 'a1', messages: [mk(1)], hasMore: false });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('body 1');
  });

  it('keeps the feature status helper in the fixture honest', () => {
    expect(makeStatus().running).toBe(true);
  });
});
