/**
 * useUnifiedAgentThreadMessages — agent-thread-scoped message source for the
 * unified chat (S1.2). Mirrors {@link useUnifiedRunMessages} structurally
 * (initial/threadId-change fetch effect + a separate live-refetch effect), but
 * the live-tail signal it watches is `agentThreadStore.liveTailTick` — a
 * counter the store already debounces ~150ms internally (a single agent turn
 * can stream many token deltas; see agentThreadStore's doc comment) — rather
 * than a raw growing event array. This hook's OWN debounce below is
 * deliberately short: it exists to preserve the exact fetch-on-settle shape
 * `useUnifiedRunMessages` uses (and to survive a rapid unmount cleanly), not to
 * add meaningful additional coalescing on top of the store's.
 *
 * Colocated next to its sibling `useUnifiedRunMessages.ts` / `useUnifiedPanelMessages.ts`
 * (not `frontend/src/hooks/`) — all three are unified-chat message sources.
 */
import { useCallback, useEffect, useState } from 'react';
import { trpc } from '../../../trpc/client';
import { useAgentThreadStore } from '../../../stores/agentThreadStore';
import type { UnifiedMessage } from '../../../../../shared/types/unifiedMessage';

/** Local settle window on top of the store's own ~150ms debounce (see doc comment above). */
const LOCAL_REFETCH_DEBOUNCE_MS = 50;

export interface UnifiedAgentThreadMessagesState {
  messages: UnifiedMessage[];
  isLoading: boolean;
  loadError: string | null;
}

export function useUnifiedAgentThreadMessages(threadId: string | null): UnifiedAgentThreadMessagesState {
  const liveTailTick = useAgentThreadStore((s) => s.liveTailTick);
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Re-query helper for the live path (preserves the prior messages on error).
  const loadMessages = useCallback(async (currentThreadId: string): Promise<void> => {
    try {
      const result = await trpc.cyboflow.agentThread.listMessages.query({ threadId: currentThreadId });
      setMessages(result);
      setLoadError(null);
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial / threadId-change load.
  useEffect(() => {
    if (threadId === null) {
      setMessages([]);
      setLoadError(null);
      setIsLoading(false);
      return;
    }

    let aborted = false;
    setIsLoading(true);
    setLoadError(null);
    setMessages([]);

    void (async () => {
      try {
        const result = await trpc.cyboflow.agentThread.listMessages.query({ threadId });
        if (aborted) return;
        setMessages(result);
      } catch (err: unknown) {
        if (aborted) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!aborted) setIsLoading(false);
      }
    })();

    return () => {
      aborted = true;
    };
  }, [threadId]);

  // Debounced live re-fetch, triggered by the store's already-debounced tick.
  // Skip tick===0 (mount default — the initial-load effect above owns that fetch).
  useEffect(() => {
    if (threadId === null) return;
    if (liveTailTick === 0) return;
    const timer = setTimeout(() => {
      void loadMessages(threadId);
    }, LOCAL_REFETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [threadId, liveTailTick, loadMessages]);

  return { messages, isLoading, loadError };
}
