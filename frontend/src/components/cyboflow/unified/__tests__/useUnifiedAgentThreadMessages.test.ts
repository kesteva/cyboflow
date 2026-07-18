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
import { useUnifiedAgentThreadMessages } from '../useUnifiedAgentThreadMessages';

beforeEach(() => {
  mockListMessagesQuery = vi.fn().mockResolvedValue([]);
  useAgentThreadStore.setState({ liveTailTick: 0 });
});

describe('useUnifiedAgentThreadMessages', () => {
  it('fetches once for a given threadId on mount', async () => {
    renderHook(() => useUnifiedAgentThreadMessages('thread-1'));

    await waitFor(() => expect(mockListMessagesQuery).toHaveBeenCalledTimes(1));
    expect(mockListMessagesQuery).toHaveBeenCalledWith({ threadId: 'thread-1' });
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
    expect(mockListMessagesQuery).toHaveBeenLastCalledWith({ threadId: 'thread-2' });
  });

  it('surfaces a load error message', async () => {
    mockListMessagesQuery = vi.fn().mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useUnifiedAgentThreadMessages('thread-1'));

    await waitFor(() => expect(result.current.loadError).toBe('network down'));
    expect(result.current.isLoading).toBe(false);
  });
});
