/**
 * useUnifiedRunMessages — run-scoped message source for the unified chat.
 *
 * Fetches a workflow run's fully-correlated `UnifiedMessage[]` projection via
 * `cyboflow.runs.listUnifiedMessages({ runId })` and live-refetches (debounced)
 * whenever the run's stream flushes (`cyboflowStore.streamEventsVersion` bumps).
 * Extracted verbatim from
 * the old RunChatView body so the run host and the shared `UnifiedChatView`
 * share a single data path (the quick-session sibling is
 * `useUnifiedPanelMessages`).
 *
 * `enabled === false` (e.g. the interactive substrate, whose live xterm owns the
 * transcript) skips ALL fetching and returns an empty, settled state — the hook
 * is still called unconditionally to respect the rules of hooks.
 *
 * Identity-preserving merge: each live refetch returns a BRAND-NEW array of
 * new objects, which — installed verbatim — destroyed all reference identity
 * and re-rendered/re-parsed the entire transcript on every ~400ms lull. The
 * merge layer (`mergeUnifiedMessages`) rebuilds the next array from the fetched
 * snapshot but reuses the previous message OBJECT for any entry whose complete
 * value is unchanged, so the transcript's per-row memoization can skip untouched
 * rows. When nothing changed at all it returns the PRIOR array reference so the
 * downstream `useMemo`/`React.memo` chain short-circuits entirely.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
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

/**
 * Structural deep-equality over the full `UnifiedMessage` shape. `UnifiedMessage`
 * carries open-ended `Record<string, unknown>` corners (metadata, tool input),
 * so the comparison walks values generically rather than field-by-field — an
 * id-only reuse would render stale content because a same-id assistant message
 * gains segments and its tool calls gain correlated results mid-stream.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  const aArray = Array.isArray(a);
  const bArray = Array.isArray(b);
  if (aArray !== bArray) return false;
  if (aArray && bArray) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}

/** Full-value equality of two UnifiedMessage snapshots. */
export function unifiedMessagesEqual(a: UnifiedMessage, b: UnifiedMessage): boolean {
  return deepEqual(a, b);
}

/**
 * Build the next messages array from the fetched snapshot, in fetched order.
 * The fetch result (`listUnifiedMessages`) is the authoritative ordered source:
 *   - each entry reuses the PREVIOUS object only when its complete value is
 *     deep-equal (so a grown/mutated message becomes a new object → its row
 *     re-renders, while untouched rows keep identity → their rows skip);
 *   - ids present only in `prev` are dropped (never resurrected);
 *   - when every entry is reference-reused AND order/length are unchanged, the
 *     PRIOR array object itself is returned so identity propagates untouched.
 */
export function mergeUnifiedMessages(
  prev: UnifiedMessage[],
  next: UnifiedMessage[],
): UnifiedMessage[] {
  const prevById = new Map<string, UnifiedMessage>();
  for (const message of prev) prevById.set(message.id, message);

  let unchanged = prev.length === next.length;
  const merged = next.map((message, index) => {
    const prior = prevById.get(message.id);
    if (prior !== undefined && unifiedMessagesEqual(prior, message)) {
      if (unchanged && prev[index] !== prior) unchanged = false;
      return prior;
    }
    unchanged = false;
    return message;
  });

  return unchanged ? prev : merged;
}

export function useUnifiedRunMessages(
  runId: string | null,
  enabled = true,
): UnifiedMessagesState {
  const streamEventsVersion = useCyboflowStore((s) => s.streamEventsVersion);
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Run-selection token: the latest selected runId. A live response for a run
  // that is no longer selected must never land (the user may have switched runs
  // while its fetch was in flight), so `loadMessages` re-checks this before it
  // installs anything.
  const selectedRunIdRef = useRef<string | null>(runId);
  useEffect(() => {
    selectedRunIdRef.current = runId;
  }, [runId]);

  // Re-query helper for the live path (preserves the prior messages on error).
  const loadMessages = useCallback(async (currentRunId: string): Promise<void> => {
    try {
      const result = await trpc.cyboflow.runs.listUnifiedMessages.query({ runId: currentRunId });
      // Discard a stale response for a run that is no longer selected.
      if (selectedRunIdRef.current !== currentRunId) return;
      setMessages((prev) => mergeUnifiedMessages(prev, result));
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
        // A fresh conversation resets to [] above, so there is nothing to reuse;
        // route through the merge for a single, consistent install path.
        setMessages((prev) => mergeUnifiedMessages(prev, result));
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

  // Debounced live re-fetch. streamEventsVersion is reset to 0 on every
  // setActiveRun and bumps once per flush, so a change is a proxy for "new
  // deltas for the active run arrived". Keyed on the version rather than
  // streamEvents.length because the capped buffer stops growing at the cap yet
  // must keep triggering refetches. This trailing debounce is also the settle
  // refetch that catches a final reply once the run stops streaming — a 'result'
  // flushes immediately and bumps the version, so the settle path still fires.
  useEffect(() => {
    if (!enabled || runId === null) return;
    if (streamEventsVersion === 0) return;
    const timer = setTimeout(() => {
      void loadMessages(runId);
    }, LIVE_REFETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, runId, streamEventsVersion, loadMessages]);

  return { messages, isLoading, loadError };
}
