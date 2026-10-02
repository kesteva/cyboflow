/**
 * useUnifiedAgentThreadMessages tests — mirrors the shape a
 * useUnifiedRunMessages test would take (no such file exists for that sibling
 * hook yet; useUnifiedPanelMessages.test.ts is the closest precedent for the
 * "fetch on mount, refetch on a live-tail signal" contract).
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let mockListMessagesQuery: ReturnType<typeof vi.fn>;

vi.mock('../../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      agentThread: {
        listMessages: { get query() { return mockListMessagesQuery; } },
      },
    },
  },
}));

import { useAgentThreadStore } from '../../../../stores/agentThreadStore';
import { AGENT_THREAD_PAGE_SIZE, useUnifiedAgentThreadMessages } from '../useUnifiedAgentThreadMessages';
import type { UnifiedMessage } from '../../../../../../shared/types/unifiedMessage';

function msg(id: string): UnifiedMessage {
  return { id, role: 'assistant', timestamp: '2026-01-01T00:00:00.000Z', segments: [{ type: 'text', content: id }] };
}

function page(ids: string[], startIndex = 0, totalCount = startIndex + ids.length) {
  return { messages: ids.map(msg), startIndex, totalCount };
}

beforeEach(() => {
  mockListMessagesQuery = vi.fn().mockResolvedValue(page([]));
  useAgentThreadStore.setState({ liveTailTick: 0 });
});

describe('useUnifiedAgentThreadMessages', () => {
  it('fetches once for a given threadId on mount', async () => {
    renderHook(() => useUnifiedAgentThreadMessages('thread-1'));

    await waitFor(() => expect(mockListMessagesQuery).toHaveBeenCalledTimes(1));
    expect(mockListMessagesQuery).toHaveBeenCalledWith({ threadId: 'thread-1', limit: AGENT_THREAD_PAGE_SIZE });
  });

  it('does not fetch when threadId is null', async () => {
    renderHook(() => useUnifiedAgentThreadMessages(null));

    await Promise.resolve();
    expect(mockListMessagesQuery).not.toHaveBeenCalled();
  });

  it('refetches messages when the store liveTailTick advances (debounced)', async () => {
    renderHook(() => useUnifiedAgentThreadMessages('thread-1'));
    await waitFor(() => expect(mockListMessagesQuery).toHaveBeenCalledTimes(1));

    act(() => {
      useAgentThreadStore.setState((s) => ({ liveTailTick: s.liveTailTick + 1 }));
    });

    await waitFor(() => expect(mockListMessagesQuery).toHaveBeenCalledTimes(2), { timeout: 1_000 });
  });

  it('re-fetches from scratch when threadId changes', async () => {
    const { rerender } = renderHook(
      ({ threadId }: { threadId: string | null }) => useUnifiedAgentThreadMessages(threadId),
      { initialProps: { threadId: 'thread-1' } },
    );
    await waitFor(() => expect(mockListMessagesQuery).toHaveBeenCalledTimes(1));

    rerender({ threadId: 'thread-2' });
    await waitFor(() => expect(mockListMessagesQuery).toHaveBeenCalledTimes(2));
    expect(mockListMessagesQuery).toHaveBeenLastCalledWith({ threadId: 'thread-2', limit: AGENT_THREAD_PAGE_SIZE });
  });

  it('surfaces a load error message', async () => {
    mockListMessagesQuery = vi.fn().mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useUnifiedAgentThreadMessages('thread-1'));

    await waitFor(() => expect(result.current.loadError).toBe('network down'));
    expect(result.current.isLoading).toBe(false);
  });

  it('anchors live refetches at the loaded window start so the window grows, not slides', async () => {
    mockListMessagesQuery = vi.fn().mockResolvedValueOnce(page(['m300', 'm301'], 300));
    const { result } = renderHook(() => useUnifiedAgentThreadMessages('thread-1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(result.current.hasEarlier).toBe(true);
    expect(result.current.earlierCount).toBe(300);

    mockListMessagesQuery.mockResolvedValueOnce(page(['m300', 'm301', 'm302'], 300));
    act(() => {
      useAgentThreadStore.setState((s) => ({ liveTailTick: s.liveTailTick + 1 }));
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(3), { timeout: 1_000 });
    expect(mockListMessagesQuery).toHaveBeenLastCalledWith({ threadId: 'thread-1', fromIndex: 300 });
  });

  it('loadEarlier moves the window start back one page', async () => {
    mockListMessagesQuery = vi.fn().mockResolvedValueOnce(page(['m200'], 200));
    const { result } = renderHook(() => useUnifiedAgentThreadMessages('thread-1'));
    await waitFor(() => expect(result.current.earlierCount).toBe(200));

    const earlierStart = 200 - AGENT_THREAD_PAGE_SIZE;
    mockListMessagesQuery.mockResolvedValueOnce(page(['older', 'm200'], earlierStart));
    act(() => result.current.loadEarlier());
    await waitFor(() => expect(result.current.earlierCount).toBe(earlierStart));
    expect(mockListMessagesQuery).toHaveBeenLastCalledWith({ threadId: 'thread-1', fromIndex: earlierStart });
    expect(result.current.messages.map((m) => m.id)).toEqual(['older', 'm200']);
    expect(result.current.isLoadingEarlier).toBe(false);
  });

  it('loadEarlier is a no-op once the whole history is loaded', async () => {
    mockListMessagesQuery = vi.fn().mockResolvedValueOnce(page(['m0'], 0));
    const { result } = renderHook(() => useUnifiedAgentThreadMessages('thread-1'));
    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.hasEarlier).toBe(false);
    act(() => result.current.loadEarlier());
    expect(mockListMessagesQuery).toHaveBeenCalledTimes(1);
  });

  it('drops a stale response that resolves after a newer request', async () => {
    mockListMessagesQuery = vi.fn().mockResolvedValueOnce(page(['m10'], 10));
    const { result } = renderHook(() => useUnifiedAgentThreadMessages('thread-1'));
    await waitFor(() => expect(result.current.earlierCount).toBe(10));

    // A live refetch that resolves LATE, then a load-earlier that resolves first.
    let resolveSlow: (v: ReturnType<typeof page>) => void = () => {};
    mockListMessagesQuery.mockImplementationOnce(() => new Promise((r) => { resolveSlow = r; }));
    act(() => {
      useAgentThreadStore.setState((s) => ({ liveTailTick: s.liveTailTick + 1 }));
    });
    await waitFor(() => expect(mockListMessagesQuery).toHaveBeenCalledTimes(2), { timeout: 1_000 });

    mockListMessagesQuery.mockResolvedValueOnce(page(['m0', 'm10'], 0));
    act(() => result.current.loadEarlier());
    await waitFor(() => expect(result.current.earlierCount).toBe(0));

    await act(async () => {
      resolveSlow(page(['m10', 'm11'], 10));
    });
    expect(result.current.earlierCount).toBe(0);
    expect(result.current.messages.map((m) => m.id)).toEqual(['m0', 'm10']);
  });
});
