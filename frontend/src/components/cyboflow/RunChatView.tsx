/**
 * RunChatView — Chat tab content for the per-run bottom pane.
 *
 * Renders the run's conversation through the SHARED <ChatTranscript>, fed by the
 * fully-correlated `UnifiedMessage[]` projection from
 * `cyboflow.runs.listUnifiedMessages`. This gives the workflow-run chat the same
 * fidelity as the quick session (tool_use folded with its result, sub-agents
 * nested, thinking blocks kept, internal tool_result "user" echoes suppressed) —
 * replacing the bespoke raw-event bubble rendering this component used before
 * (which leaked raw `toolu_` ids, JSON.stringify'd tool input, and rendered
 * tool_result echoes as fake "user" turns).
 *
 * Data flow:
 *  - Initial / runId-change fetch via `listUnifiedMessages({ runId })`.
 *  - Debounced re-fetch whenever `cyboflowStore.streamEvents` for this run
 *    changes (live updates) — same strategy as the quick session's debounced
 *    reload. No renderer-side projector.
 *
 * This component owns the ChatTranscript presentational state (collapse/expand
 * sets, scroll refs, scroll-button tracking, copy handler, settings) exactly the
 * way RichOutputView does, and wraps the transcript with:
 *  - the inline `AskUserQuestionCard` (injected at the AskUserQuestion tool_use
 *    position via the transcript's `renderToolCallExtra` hook),
 *  - the per-run `PendingApprovalsForRun` strip, and
 *  - the `ChatInput` bar.
 *
 * Modes:
 *  - runId non-null: full conversation view (this file's main branch)
 *  - runId null + activeQuickSessionId non-null: quick-session placeholder
 *  - runId null + activeQuickSessionId null: "No active run" placeholder
 */
import { useEffect, useRef, useMemo, useState, useCallback, type ReactElement, type ReactNode } from 'react';
import { History } from 'lucide-react';
import { ChatInput } from './ChatInput';
import { InteractiveTerminalView } from './InteractiveTerminalView';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useActiveRunsStore } from '../../stores/activeRunsStore';
import { useQuestionStore } from '../../stores/questionStore';
import { AskUserQuestionCard } from '../AskUserQuestion/AskUserQuestionCard';
import { PendingApprovalsForRun } from '../ReviewQueue/PendingApprovalsForRun';
import { ChatTranscript } from '../chat/ChatTranscript';
import { PromptNavigation, type PromptMarker } from '../panels/claude/PromptNavigation';
import { trpc } from '../../trpc/client';
import type { UnifiedMessage } from '../../../../shared/types/unifiedMessage';
import type { RichOutputSettings } from '../panels/ai/AbstractAIPanel';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RICH_OUTPUT_SETTINGS_KEY = 'richOutputSettings';

const defaultSettings: RichOutputSettings = {
  showToolCalls: true,
  compactMode: false,
  collapseTools: true,
  showThinking: true,
  showSessionInit: false,
};

/** Debounce window for live re-fetch after a streamEvents delta lands. */
const LIVE_REFETCH_DEBOUNCE_MS = 400;

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function RunChatView({ runId }: { runId: string | null }): ReactElement {
  const activeQuickSessionId = useCyboflowStore((s) => s.activeQuickSessionId);
  const streamEvents = useCyboflowStore((s) => s.streamEvents);
  const questionQueue = useQuestionStore((s) => s.queue);
  const runsByProject = useActiveRunsStore((s) => s.runsByProject);

  // -------------------------------------------------------------------------
  // Substrate gate (IDEA-013 / IDEA-030). Resolve the run row the same way
  // ChatInput does — scan `runsByProject` for the row whose id === runId (run
  // ids are unique across projects). `ActiveRunRow.substrate` is the
  // AppRouter-inferred field (populated by the list SELECT in TASK-813); do NOT
  // re-declare the substrate union here. When the substrate is 'interactive',
  // the transcript region is swapped for a live xterm (InteractiveTerminalView).
  // -------------------------------------------------------------------------
  const run = useMemo(() => {
    if (runId === null) return null;
    for (const rows of Object.values(runsByProject)) {
      const found = rows.find((r) => r.id === runId);
      if (found) return found;
    }
    return null;
  }, [runId, runsByProject]);
  const isInteractive = run?.substrate === 'interactive';

  // -------------------------------------------------------------------------
  // Messages + load state
  // -------------------------------------------------------------------------

  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // ChatTranscript state — owned here exactly like RichOutputView owns it.
  // -------------------------------------------------------------------------

  const [collapsedMessages, setCollapsedMessages] = useState<Set<string>>(new Set());
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const settings = useMemo<RichOutputSettings>(() => {
    try {
      const saved = localStorage.getItem(RICH_OUTPUT_SETTINGS_KEY);
      return saved ? { ...defaultSettings, ...JSON.parse(saved) } : defaultSettings;
    } catch {
      return defaultSettings;
    }
  }, []);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const userMessageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const wasAtBottomRef = useRef(true);
  const previousMessageCountRef = useRef(0);

  // -------------------------------------------------------------------------
  // Fetch — listUnifiedMessages. Result type is INFERRED from AppRouter; the
  // local `UnifiedMessage` import is only used for the state annotation.
  // -------------------------------------------------------------------------

  const loadMessages = useCallback(async (currentRunId: string): Promise<void> => {
    const container = scrollContainerRef.current;
    if (container) {
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      wasAtBottomRef.current = distanceFromBottom < 50;
    }

    try {
      const result = await trpc.cyboflow.runs.listUnifiedMessages.query({ runId: currentRunId });
      setMessages(result);
      setLoadError(null);

      // Auto-expand sub-agent (Task) tools so nested sub-agent transcripts show.
      const subAgentIds = new Set<string>();
      for (const msg of result) {
        for (const seg of msg.segments) {
          if (seg.type === 'tool_call' && seg.tool.name === 'Task') {
            subAgentIds.add(seg.tool.id);
          }
        }
      }
      if (subAgentIds.size > 0) {
        setExpandedTools((prev) => {
          const next = new Set(prev);
          subAgentIds.forEach((id) => next.add(id));
          return next;
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setLoadError(message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial / runId-change load.
  useEffect(() => {
    if (runId === null) {
      setMessages([]);
      setLoadError(null);
      setIsLoading(false);
      return;
    }

    let aborted = false;
    setIsLoading(true);
    setLoadError(null);
    setMessages([]);
    previousMessageCountRef.current = 0;
    wasAtBottomRef.current = true;

    void (async () => {
      try {
        const result = await trpc.cyboflow.runs.listUnifiedMessages.query({ runId });
        if (aborted) return;
        setMessages(result);
        const subAgentIds = new Set<string>();
        for (const msg of result) {
          for (const seg of msg.segments) {
            if (seg.type === 'tool_call' && seg.tool.name === 'Task') {
              subAgentIds.add(seg.tool.id);
            }
          }
        }
        if (subAgentIds.size > 0) {
          setExpandedTools((prev) => {
            const next = new Set(prev);
            subAgentIds.forEach((id) => next.add(id));
            return next;
          });
        }
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
  }, [runId]);

  // -------------------------------------------------------------------------
  // Live re-fetch — debounced re-query whenever this run's streamEvents change.
  // streamEvents is cleared on setActiveRun, so its length growing is a proxy
  // for "new deltas for the active run arrived". We re-query the projection
  // rather than building a renderer-side projector.
  // -------------------------------------------------------------------------

  const streamEventCount = streamEvents.length;

  useEffect(() => {
    if (runId === null) return;
    if (streamEventCount === 0) return;

    const timer = setTimeout(() => {
      void loadMessages(runId);
    }, LIVE_REFETCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [runId, streamEventCount, loadMessages]);

  // -------------------------------------------------------------------------
  // Auto-scroll on new messages (mirrors RichOutputView).
  // -------------------------------------------------------------------------

  useEffect(() => {
    const hasNewMessages = messages.length > previousMessageCountRef.current;
    previousMessageCountRef.current = messages.length;

    if (messagesEndRef.current && !isLoading && hasNewMessages && wasAtBottomRef.current) {
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' as ScrollBehavior });
      });
    }
  }, [messages, isLoading]);

  // -------------------------------------------------------------------------
  // Scroll-button + at-bottom tracking.
  // -------------------------------------------------------------------------

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      wasAtBottomRef.current = distanceFromBottom < 50;
      setShowScrollButton(distanceFromBottom > clientHeight);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();

    return () => container.removeEventListener('scroll', handleScroll);
  }, [messages]);

  // -------------------------------------------------------------------------
  // ChatTranscript callbacks.
  // -------------------------------------------------------------------------

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const toggleMessageCollapse = useCallback((messageId: string) => {
    setCollapsedMessages((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);

  const toggleToolExpand = useCallback((toolId: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(toolId)) next.delete(toolId);
      else next.add(toolId);
      return next;
    });
  }, []);

  const copyMessageContent = useCallback(async (message: UnifiedMessage) => {
    const contentParts: string[] = [];
    message.segments.forEach((seg) => {
      if (seg.type === 'text' && seg.content) {
        contentParts.push(seg.content);
      } else if (seg.type === 'thinking' && seg.content) {
        contentParts.push(`*Thinking:*\n${seg.content}`);
      } else if (seg.type === 'tool_call' && seg.tool) {
        contentParts.push(`**Tool: ${seg.tool.name}**\n\`\`\`json\n${JSON.stringify(seg.tool.input, null, 2)}\n\`\`\``);
        if (seg.tool.result) {
          contentParts.push(`**Result:**\n${seg.tool.result.content}`);
        }
      } else if (seg.type === 'diff' && seg.diff) {
        contentParts.push(`\`\`\`diff\n${seg.diff}\n\`\`\``);
      }
    });
    try {
      await navigator.clipboard.writeText(contentParts.join('\n\n'));
      setCopiedMessageId(message.id);
      setTimeout(() => setCopiedMessageId(null), 2000);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  }, []);

  // -------------------------------------------------------------------------
  // Inline AskUserQuestionCard injection.
  //
  // MessageProjection keeps AskUserQuestion as a tool_call segment whose
  // `tool.id` equals the Question's `toolUseId`. We render the interactive
  // card at that exact tool_use position via ChatTranscript's
  // `renderToolCallExtra` hook so the question stays inline in the transcript.
  // -------------------------------------------------------------------------

  const renderToolCallExtra = useCallback((toolCallId: string): ReactNode => {
    const question = questionQueue.find((q) => q.toolUseId === toolCallId);
    if (question != null) {
      return <AskUserQuestionCard item={question} />;
    }
    return null;
  }, [questionQueue]);

  // -------------------------------------------------------------------------
  // Filter session-init messages unless the setting opts in (mirrors RichOutputView).
  // -------------------------------------------------------------------------

  const filteredMessages = useMemo(() => {
    if (settings.showSessionInit) return messages;
    return messages.filter((msg) => !(msg.role === 'system' && msg.metadata?.systemSubtype === 'init'));
  }, [messages, settings.showSessionInit]);

  // -------------------------------------------------------------------------
  // Prompt-history markers for the left rail. Derived from the SAME
  // `filteredMessages` array ChatTranscript renders, counting user turns in
  // order so each marker's index lines up with ChatTranscript's
  // `userMessageIndex` keys in `userMessageRefs` (the scroll targets).
  // -------------------------------------------------------------------------

  const promptMarkers = useMemo<PromptMarker[]>(() => {
    // The live terminal owns the transcript in interactive mode; the rail (and
    // therefore these markers) is not rendered, so skip the derivation entirely.
    if (isInteractive) return [];
    const markers: PromptMarker[] = [];
    let userIdx = 0;
    for (const msg of filteredMessages) {
      if (msg.role !== 'user') continue;
      const text = msg.segments
        .filter((s) => s.type === 'text')
        .map((s) => (s.type === 'text' ? s.content : ''))
        .join('\n')
        .trim();
      markers.push({
        id: userIdx,
        prompt_text: text || '(no text)',
        output_index: userIdx,
        timestamp: msg.timestamp,
      });
      userIdx += 1;
    }
    return markers;
  }, [filteredMessages, isInteractive]);

  const handleNavigateToPrompt = useCallback((_marker: PromptMarker, index: number): void => {
    const el = userMessageRefs.current.get(index);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('highlight-prompt');
    setTimeout(() => el.classList.remove('highlight-prompt'), 2000);
  }, []);

  // -------------------------------------------------------------------------
  // Render branches
  // -------------------------------------------------------------------------

  if (runId === null && activeQuickSessionId !== null) {
    return (
      <div className="p-4 text-sm text-text-secondary">
        Quick session chat (history rendered by panel surface)
      </div>
    );
  }

  if (runId === null) {
    return (
      <div className="p-4 text-sm text-text-secondary">
        No active run
      </div>
    );
  }

  // runId is non-null — full conversation view (transcript column + right prompt rail).
  return (
    <div className="flex h-full">
      {/* Main column: transcript + approvals + input. */}
      <div className="relative flex flex-1 min-w-0 flex-col">
        {/* Prompt-rail toggle — only meaningful for the structured transcript;
            dropped in interactive mode (live terminal has no prompt history). */}
        {!isInteractive && (
          <button
            type="button"
            onClick={() => setSidebarCollapsed((v) => !v)}
            title={sidebarCollapsed ? 'Show prompt history' : 'Hide prompt history'}
            aria-label={sidebarCollapsed ? 'Show prompt history' : 'Hide prompt history'}
            data-testid="run-chat-prompt-rail-toggle"
            className="absolute right-2 top-2 z-10 rounded p-1 text-text-tertiary hover:bg-surface-secondary hover:text-text-secondary"
          >
            <History className="h-4 w-4" />
          </button>
        )}

        <div className="flex-1 overflow-hidden">
          {isInteractive ? (
            /* Interactive substrate: the live PTY xterm IS the transcript
               surface. The structured ChatTranscript stays dormant (not
               rendered) so the conversation is never double-rendered. */
            <InteractiveTerminalView runId={runId} />
          ) : loadError !== null ? (
            <div className="p-4 text-xs text-status-error">Error loading history: {loadError}</div>
          ) : (
            <ChatTranscript
              messages={filteredMessages}
              settings={settings}
              agentName="Claude"
              isWaitingForResponse={false}
              collapsedMessages={collapsedMessages}
              onToggleMessageCollapse={toggleMessageCollapse}
              expandedTools={expandedTools}
              onToggleToolExpand={toggleToolExpand}
              copiedMessageId={copiedMessageId}
              onCopyMessage={copyMessageContent}
              scrollContainerRef={scrollContainerRef}
              messagesEndRef={messagesEndRef}
              userMessageRefs={userMessageRefs}
              showScrollButton={showScrollButton}
              onScrollToBottom={scrollToBottom}
              renderToolCallExtra={renderToolCallExtra}
            />
          )}
        </div>

        <PendingApprovalsForRun runId={runId} />

        <ChatInput runId={runId} />
      </div>

      {/* Right prompt-history rail (collapsible) — controlled by promptMarkers.
          Dropped in interactive mode (no parsed-message markers there). */}
      {!isInteractive && !sidebarCollapsed && (
        <div className="w-[230px] shrink-0 h-full overflow-hidden">
          <PromptNavigation
            panelId={runId}
            prompts={promptMarkers}
            onNavigateToPrompt={handleNavigateToPrompt}
          />
        </div>
      )}
    </div>
  );
}
