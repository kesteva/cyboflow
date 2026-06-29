/**
 * useUnifiedPanelMessages — quick-session (panel-scoped) message source for the
 * unified chat.
 *
 * The quick-session sibling of `useUnifiedRunMessages`. Reconstructs the
 * conversation as `UnifiedMessage[]` from the panel's stored outputs by merging
 * `API.panels.getConversationMessages` (the real user prompts) with
 * `API.panels.getJsonMessages` (the projected assistant/tool turns — already the
 * shared `UnifiedMessage` shape) and running them through the
 * `ClaudeMessageTransformer` (an identity pass-through that fills any gaps).
 * Live-refetches (debounced) on the window `session-output-available` event for
 * this panel — the exact strategy the old RichOutputView used (an SDK quick
 * session never populates `cyboflowStore.streamEvents`, so the run hook's
 * streamEvents trigger does not apply here).
 *
 * `enabled === false` (e.g. an interactive/PTY quick session, whose live xterm
 * owns the transcript) skips ALL fetching and returns an empty, settled state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API } from '../../../utils/api';
import { ClaudeMessageTransformer } from '../../panels/ai/transformers/ClaudeMessageTransformer';
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

export function useUnifiedPanelMessages(
  panelId: string | null,
  enabled = true,
): UnifiedMessagesState {
  // One transformer per hook instance (matches RichOutputView's lifetime).
  const transformer = useMemo(() => new ClaudeMessageTransformer(), []);
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Guard against concurrent loads (the live event can fire mid-load).
  const isLoadingRef = useRef(false);
  // Stash the latest loader so the live-event effect can call it without
  // re-registering the listener on every loader identity change.
  const loadRef = useRef<(() => Promise<void>) | null>(null);

  const loadMessages = useCallback(async (): Promise<void> => {
    if (!enabled || !panelId) return;
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;
    try {
      setLoadError(null);
      const [conversationResponse, outputResponse] = await Promise.all([
        API.panels.getConversationMessages(panelId),
        API.panels.getJsonMessages(panelId),
      ]);

      // Conversation messages carry the actual user prompts; convert them to the
      // UnifiedMessage shape so the identity transformer doesn't emit objects
      // missing `segments`. Skip local-command echoes (slash-command stdout).
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

      const allMessages: unknown[] = [...userPrompts];
      if (outputResponse.success && Array.isArray(outputResponse.data)) {
        allMessages.push(...outputResponse.data);
      }

      // Order by timestamp so user prompts interleave with their responses.
      allMessages.sort((a, b) => {
        const timeA = new Date((a as { timestamp?: string }).timestamp ?? '').getTime();
        const timeB = new Date((b as { timestamp?: string }).timestamp ?? '').getTime();
        return timeA - timeB;
      });

      setMessages(transformer.transform(allMessages));
    } catch (err: unknown) {
      console.error('[useUnifiedPanelMessages] Failed to load messages:', err);
      setLoadError('Failed to load conversation history');
    } finally {
      setIsLoading(false);
      isLoadingRef.current = false;
    }
  }, [enabled, panelId, transformer]);

  useEffect(() => {
    loadRef.current = loadMessages;
  }, [loadMessages]);

  // Initial load on panelId change.
  useEffect(() => {
    if (!enabled || !panelId) {
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
