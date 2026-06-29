/**
 * useUnifiedRunMessages — run-scoped message source for the unified chat.
 *
 * Fetches a workflow run's fully-correlated `UnifiedMessage[]` projection via
 * `cyboflow.runs.listUnifiedMessages({ runId })` and live-refetches (debounced)
 * whenever the run's `cyboflowStore.streamEvents` grow. Extracted verbatim from
 * the old RunChatView body so the run host and the shared `UnifiedChatView`
 * share a single data path (the quick-session sibling is
 * `useUnifiedPanelMessages`).
 *
 * `enabled === false` (e.g. the interactive substrate, whose live xterm owns the
 * transcript) skips ALL fetching and returns an empty, settled state — the hook
 * is still called unconditionally to respect the rules of hooks.
 */
import { useCallback, useEffect, useState } from 'react';
import { trpc } from '../../../trpc/client';
import { useCyboflowStore } from '../../../stores/cyboflowStore';
import type { UnifiedMessage } from '../../../../../shared/types/unifiedMessage';

/** Debounce window for the live re-fetch after a streamEvents delta lands. */
const LIVE_REFETCH_DEBOUNCE_MS = 400;

export interface UnifiedMessagesState {
  messages: UnifiedMessage[];
  isLoading: boolean;
  loadError: string | null;
}

export function useUnifiedRunMessages(
  runId: string | null,
  enabled = true,
): UnifiedMessagesState {
  const streamEvents = useCyboflowStore((s) => s.streamEvents);
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Re-query helper for the live path (preserves the prior messages on error).
  const loadMessages = useCallback(async (currentRunId: string): Promise<void> => {
    try {
      const result = await trpc.cyboflow.runs.listUnifiedMessages.query({ runId: currentRunId });
      setMessages(result);
      setLoadError(null);
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial / runId-change load.
  useEffect(() => {
    if (!enabled || runId === null) {
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
        const result = await trpc.cyboflow.runs.listUnifiedMessages.query({ runId });
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
  }, [enabled, runId]);

  // Debounced live re-fetch. streamEvents is cleared on every setActiveRun, so
  // its length growing is a proxy for "new deltas for the active run arrived".
  const streamEventCount = streamEvents.length;
  useEffect(() => {
    if (!enabled || runId === null) return;
    if (streamEventCount === 0) return;
    const timer = setTimeout(() => {
      void loadMessages(runId);
    }, LIVE_REFETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, runId, streamEventCount, loadMessages]);

  return { messages, isLoading, loadError };
}
