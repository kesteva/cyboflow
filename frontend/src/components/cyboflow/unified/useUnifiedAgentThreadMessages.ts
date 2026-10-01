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
 * WINDOWED. The global thread is long-lived (tens of thousands of events), and
 * shipping + rendering its whole history on every rail mount and live-tail tick
 * froze the app. So the first load asks for only the newest
 * {@link AGENT_THREAD_PAGE_SIZE} messages and records where that window starts
 * (`startIndex`, an absolute index into the thread's projected history).
 * Live refetches re-request FROM that index, so the window grows as the turn
 * streams instead of sliding (a sliding window would hold the message count
 * flat and break the transcript's "new message → stay pinned" scroll).
 * `loadEarlier` moves the start back one page.
 *
 * Colocated next to its sibling `useUnifiedRunMessages.ts` / `useUnifiedPanelMessages.ts`
 * (not `frontend/src/hooks/`) — all three are unified-chat message sources.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '../../../trpc/client';
import { useAgentThreadStore } from '../../../stores/agentThreadStore';
import type { UnifiedMessage } from '../../../../../shared/types/unifiedMessage';

/** Local settle window on top of the store's own ~150ms debounce (see doc comment above). */
const LOCAL_REFETCH_DEBOUNCE_MS = 50;

/** Messages loaded on mount, and added per "load earlier". */
export const AGENT_THREAD_PAGE_SIZE = 150;

export interface UnifiedAgentThreadMessagesState {
  messages: UnifiedMessage[];
  isLoading: boolean;
  loadError: string | null;
  /** Older messages exist before the loaded window. */
  hasEarlier: boolean;
  /** Messages before the loaded window (0 when the whole history is loaded). */
  earlierCount: number;
  /** A "load earlier" fetch is in flight. */
  isLoadingEarlier: boolean;
  /** Extend the window back by one page. No-op when nothing earlier exists. */
  loadEarlier: () => void;
}

interface WindowRequest {
  limit?: number;
  fromIndex?: number;
}

export function useUnifiedAgentThreadMessages(threadId: string | null): UnifiedAgentThreadMessagesState {
  const liveTailTick = useAgentThreadStore((s) => s.liveTailTick);
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [startIndex, setStartIndex] = useState(0);
  const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);

  // The window's absolute start, read by the live refetch without making it an
  // effect dependency. null until the first page lands (a tick before then
  // falls back to a newest-page request).
  const startIndexRef = useRef<number | null>(null);
  // Latest-wins: a slow response (e.g. a live refetch) must never overwrite a
  // newer one (e.g. a "load earlier" that already widened the window).
  const requestSeqRef = useRef(0);

  const fetchWindow = useCallback(
    async (currentThreadId: string, request: WindowRequest): Promise<boolean> => {
      const seq = ++requestSeqRef.current;
      try {
        const page = await trpc.cyboflow.agentThread.listMessages.query({ threadId: currentThreadId, ...request });
        if (seq !== requestSeqRef.current) return false;
        startIndexRef.current = page.startIndex;
        setStartIndex(page.startIndex);
        setMessages(page.messages);
        setLoadError(null);
        return true;
      } catch (err: unknown) {
        if (seq !== requestSeqRef.current) return false;
        setLoadError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [],
  );

  // Initial / threadId-change load: the newest page only.
  useEffect(() => {
    // Invalidate anything in flight for the previous thread.
    requestSeqRef.current += 1;
    startIndexRef.current = null;
    setStartIndex(0);
    setIsLoadingEarlier(false);

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

    void fetchWindow(threadId, { limit: AGENT_THREAD_PAGE_SIZE }).finally(() => {
      if (!aborted) setIsLoading(false);
    });

    return () => {
      aborted = true;
    };
  }, [threadId, fetchWindow]);

  // Debounced live re-fetch, triggered by the store's already-debounced tick.
  // Skip tick===0 (mount default — the initial-load effect above owns that fetch).
  useEffect(() => {
    if (threadId === null) return;
    if (liveTailTick === 0) return;
    const timer = setTimeout(() => {
      const from = startIndexRef.current;
      void fetchWindow(threadId, from === null ? { limit: AGENT_THREAD_PAGE_SIZE } : { fromIndex: from });
    }, LOCAL_REFETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [threadId, liveTailTick, fetchWindow]);

  const loadEarlier = useCallback((): void => {
    const from = startIndexRef.current;
    if (threadId === null || from === null || from === 0) return;
    setIsLoadingEarlier(true);
    void fetchWindow(threadId, { fromIndex: Math.max(0, from - AGENT_THREAD_PAGE_SIZE) }).finally(() => {
      setIsLoadingEarlier(false);
    });
  }, [threadId, fetchWindow]);

  return {
    messages,
    isLoading,
    loadError,
    hasEarlier: startIndex > 0,
    earlierCount: startIndex,
    isLoadingEarlier,
    loadEarlier,
  };
}
