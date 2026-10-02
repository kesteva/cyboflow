/**
 * useUnifiedPanelMessages — quick-session (panel-scoped) message source for the
 * unified chat.
 *
 * The quick-session sibling of `useUnifiedRunMessages`. Reconstructs the
 * conversation as `UnifiedMessage[]` from the panel's stored outputs by merging
 * `API.panels.getConversationMessages` (the real user prompts) with
 * `API.panels.getJsonMessages` (the projected assistant/tool turns — already the
 * shared `UnifiedMessage` shape, projected main-side).
 * Live-refetches (debounced) on the window `session-output-available` event for
 * this panel — the strategy the old quick-session chat view used (an SDK quick
 * session never populates `cyboflowStore.streamEvents`, so the run hook's
 * streamEvents trigger does not apply here).
 *
 * `enabled === false` (e.g. an interactive/PTY quick session, whose live xterm
 * owns the transcript) skips ALL fetching and returns an empty, settled state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { API } from '../../../utils/api';
import type { UnifiedMessage } from '../../../../../shared/types/unifiedMessage';
import type { UnifiedMessagesState } from './useUnifiedRunMessages';

/** Conversation-history row shape returned by `panels:get-conversation-messages`. */
interface ConversationMessage {
  id: number;
  session_id: string;
  message_type: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

/** Debounce window for the live re-fetch after a session-output delta lands. */
const LIVE_REFETCH_DEBOUNCE_MS = 500;

function userText(message: UnifiedMessage): string | null {
  if (message.role !== 'user') return null;
  const text = message.segments
    .filter((segment) => segment.type === 'text')
    .map((segment) => segment.type === 'text' ? segment.content : '')
    .join('\n')
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * Merge panel conversation rows with projected provider output.
 *
 * SDK providers echo the submitted user turn in their structured stream. The
 * same turn is also persisted immediately in conversation_messages so it can
 * render before provider startup completes. Once the projected echo exists it
 * is canonical; drop matching conversation copies while preserving repeated
 * projected turns with identical text.
 */
export function mergePanelMessageSources(
  conversationUserMessages: UnifiedMessage[],
  projectedMessages: UnifiedMessage[],
): UnifiedMessage[] {
  const projectedUserTexts = new Set(
    projectedMessages
      .map(userText)
      .filter((text): text is string => text !== null),
  );
  const merged: UnifiedMessage[] = [
    ...conversationUserMessages.filter((message) => {
      const text = userText(message);
      return text === null || !projectedUserTexts.has(text);
    }),
    ...projectedMessages,
  ];
  merged.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return merged;
}

export function useUnifiedPanelMessages(
  panelId: string | null,
  enabled = true,
): UnifiedMessagesState {
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Guard against concurrent loads (the live event can fire mid-load). A
  // blocked load is remembered below: dropping it can strand the optimistic
  // pending-send row forever when the in-flight request returns a snapshot from
  // before the user turn was persisted.
  const isLoadingRef = useRef(false);
  const reloadRequestedRef = useRef(false);
  // Stash the latest loader so the live-event effect can call it without
  // re-registering the listener on every loader identity change.
  const loadRef = useRef<(() => Promise<void>) | null>(null);

  const loadMessages = useCallback(async (): Promise<void> => {
    if (!enabled || !panelId) return;
    if (isLoadingRef.current) {
      reloadRequestedRef.current = true;
      return;
    }
    isLoadingRef.current = true;
    try {
      setLoadError(null);
      const [conversationResponse, outputResponse] = await Promise.all([
        API.panels.getConversationMessages(panelId),
        API.panels.getJsonMessages(panelId),
      ]);

      // Conversation messages carry the actual user prompts; convert them to the
      // UnifiedMessage shape (with `segments`) so they merge with the projected
      // turns. Skip local-command echoes (slash-command stdout).
      const userPrompts: UnifiedMessage[] = [];
      if (conversationResponse.success && Array.isArray(conversationResponse.data)) {
        (conversationResponse.data as ConversationMessage[]).forEach((msg) => {
          if (msg.message_type !== 'user') return;
          if (typeof msg.content === 'string' && msg.content.includes('<local-command-stdout>')) {
            return;
          }
          userPrompts.push({
            id: `user-${msg.timestamp}-${userPrompts.length}`,
            role: 'user',
            timestamp: msg.timestamp,
            segments: [{ type: 'text', content: typeof msg.content === 'string' ? msg.content : '' }],
          });
        });
      }

      let projectedMessages: UnifiedMessage[] = [];
      if (outputResponse.success && Array.isArray(outputResponse.data)) {
        // Already projected main-side into the shared UnifiedMessage shape.
        projectedMessages = outputResponse.data as UnifiedMessage[];
      }
      setMessages(mergePanelMessageSources(userPrompts, projectedMessages));
    } catch (err: unknown) {
      console.error('[useUnifiedPanelMessages] Failed to load messages:', err);
      setLoadError('Failed to load conversation history');
    } finally {
      setIsLoading(false);
      isLoadingRef.current = false;
      // Coalesce any number of output notifications received during this fetch
      // into one trailing refresh. Use loadRef so a panel switch that happened
      // while the old request was in flight reloads the current panel instead
      // of replaying this callback's stale panelId closure.
      if (reloadRequestedRef.current) {
        reloadRequestedRef.current = false;
        void loadRef.current?.();
      }
    }
  }, [enabled, panelId]);

  useEffect(() => {
    loadRef.current = loadMessages;
  }, [loadMessages]);

  // Initial load on panelId change.
  useEffect(() => {
    if (!enabled || !panelId) {
      reloadRequestedRef.current = false;
      setMessages([]);
      setLoadError(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    void loadMessages();
  }, [enabled, panelId, loadMessages]);

  // Live append via the window `session-output-available` CustomEvent for this
  // panel, debounced (re-reads from the DB to stay consistent).
  useEffect(() => {
    if (!enabled || !panelId) return;
    let debounceTimer: ReturnType<typeof setTimeout>;
    const handler = (event: Event) => {
      const ce = event as CustomEvent<{ sessionId?: string; panelId?: string }>;
      const detail = ce.detail ?? (event as unknown as { sessionId?: string; panelId?: string });
      if (detail && (detail.sessionId === panelId || detail.panelId === panelId)) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          void loadRef.current?.();
        }, LIVE_REFETCH_DEBOUNCE_MS);
      }
    };
    window.addEventListener('session-output-available', handler as EventListener);
    return () => {
      clearTimeout(debounceTimer);
      window.removeEventListener('session-output-available', handler as EventListener);
    };
  }, [enabled, panelId]);

  return { messages, isLoading, loadError };
}
