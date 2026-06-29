/**
 * UnifiedChatView — THE single chat surface shared by workflow runs and quick
 * sessions.
 *
 * Both the workflow-run host (`RunChatView`) and the quick-session host
 * (`ClaudePanel`) render this component so the two can never visually drift
 * again. It owns the chrome that used to be duplicated in each host:
 *   - the `ModeIdentityStrip` (top row),
 *   - the transcript region — the shared `<ChatTranscript>` for the SDK
 *     substrate, swapped for a host-supplied `interactiveBody` (the live PTY
 *     xterm) on the interactive substrate,
 *   - the right collapsible prompt-history rail (`PromptNavigation`, controlled
 *     by markers derived from the messages),
 *   - the `ChatMetaStrip` (folder · branch · context meter),
 *   - and ALL the `ChatTranscript` presentational state (collapse/expand sets,
 *     scroll refs, copy handler, auto-scroll, sub-agent auto-expand).
 *
 * What stays host-specific (and is injected) is exactly the part that is
 * SUPPOSED to differ: the message SOURCE (`messages` prop, fed by
 * `useUnifiedRunMessages` for runs / `useUnifiedPanelMessages` for quick
 * sessions), the identity/meta values, the interactive body, the inline
 * `renderToolCallExtra` (AskUserQuestion for runs), and the `bottomSlot` (the
 * host's approvals strip + composer adapter + any toast/banner).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { History } from 'lucide-react';
import { ModeIdentityStrip } from './ModeIdentityStrip';
import { ChatMetaStrip } from './ChatMetaStrip';
import type { ChatMode, ChatTransport, FlowRunStatus } from './useChatVisibility';
import { ChatTranscript } from '../../chat/ChatTranscript';
import { PromptNavigation, type PromptMarker } from '../../panels/claude/PromptNavigation';
import type { UnifiedMessage } from '../../../../../shared/types/unifiedMessage';
import type { RichOutputSettings } from '../../panels/ai/AbstractAIPanel';

// ---------------------------------------------------------------------------
// Settings — read once from localStorage, identical to the prior hosts.
// ---------------------------------------------------------------------------

const RICH_OUTPUT_SETTINGS_KEY = 'richOutputSettings';

const defaultSettings: RichOutputSettings = {
  showToolCalls: true,
  compactMode: false,
  collapseTools: true,
  showThinking: true,
  showSessionInit: false,
};

function readSettings(): RichOutputSettings {
  try {
    const saved = localStorage.getItem(RICH_OUTPUT_SETTINGS_KEY);
    return saved ? { ...defaultSettings, ...JSON.parse(saved) } : defaultSettings;
  } catch {
    return defaultSettings;
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface UnifiedChatViewProps {
  // -- mode identity -------------------------------------------------------
  /** session/panel label, e.g. "Claude" (SDK) or "Terminal" (PTY). */
  name: string;
  transport: ChatTransport;
  mode: ChatMode;
  running?: boolean;
  /** Flow run lifecycle status (flow mode only) — drives the identity pill. */
  runStatus?: FlowRunStatus | null;

  // -- transcript data -----------------------------------------------------
  /** Messages to render (already fetched by the host's source hook). */
  messages: UnifiedMessage[];
  /** Error string when the message load failed; renders an inline error. */
  loadError?: string | null;
  /** Render the inline working indicator at the tail (quick-session waiting). */
  isWaitingForResponse?: boolean;

  // -- meta strip ----------------------------------------------------------
  folderLabel: string | null;
  folderTitle?: string | null;
  branchName: string | null;
  contextUsage: string | null;

  // -- substrate / injection ----------------------------------------------
  /**
   * The interactive (PTY) substrate body — the live xterm (+ any overlays). When
   * `transport === 'interactive'` this REPLACES the transcript and the prompt
   * rail is dropped (the live terminal has no parsed prompt history).
   */
  interactiveBody?: ReactNode;
  /**
   * Inject extra UI directly beneath a tool_call at its tool_use position (the
   * workflow-run inline AskUserQuestionCard). No-op for the quick-session host.
   */
  renderToolCallExtra?: (toolCallId: string) => ReactNode;
  /**
   * Host-owned bottom region rendered below the meta strip — the approvals strip
   * + the host's composer adapter (`ChatInput` for runs, `QuickSessionComposer`
   * for quick sessions) + any host-specific toast / archived banner.
   */
  bottomSlot?: ReactNode;
  /** Stable id for the (controlled) prompt rail — runId for runs, panelId for quick. */
  railId?: string;
}

// ---------------------------------------------------------------------------
// UnifiedChatView
// ---------------------------------------------------------------------------

export function UnifiedChatView({
  name,
  transport,
  mode,
  running = false,
  runStatus = null,
  messages,
  loadError = null,
  isWaitingForResponse = false,
  folderLabel,
  folderTitle,
  branchName,
  contextUsage,
  interactiveBody,
  renderToolCallExtra,
  bottomSlot,
  railId = 'unified-chat',
}: UnifiedChatViewProps): ReactElement {
  const isInteractive = transport === 'interactive';

  // Settings are read once (shared key); the chat has no in-view settings UI.
  const settings = useMemo<RichOutputSettings>(() => readSettings(), []);

  // -- ChatTranscript presentational state (owned here for both hosts) -----
  const [collapsedMessages, setCollapsedMessages] = useState<Set<string>>(new Set());
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const userMessageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const wasAtBottomRef = useRef(true);
  const previousMessageCountRef = useRef(0);

  // Reset the transcript view state when the host switches the conversation
  // (railId = runId for runs, panelId for quick sessions). The live quick path
  // reuses ONE UnifiedChatView instance across session switches (the quick
  // PanelContainer slot is un-keyed), so without this the auto-scroll refs +
  // collapse/expand sets carry over from the previous conversation — leaving the
  // new one parked mid-history instead of pinned to its latest message (the old
  // RichOutputView force-scrolled to the bottom on every panel change). Declared
  // BEFORE the auto-scroll effect so a combined railId+messages render resets the
  // refs first. Mirrors the empty-intermediate-render reset the run host already
  // gets from `useUnifiedRunMessages`' setMessages([]) on runId change.
  useEffect(() => {
    previousMessageCountRef.current = 0;
    wasAtBottomRef.current = true;
    setCollapsedMessages(new Set());
    setExpandedTools(new Set());
  }, [railId]);

  // Filter session-init messages unless the setting opts in.
  const filteredMessages = useMemo(() => {
    if (settings.showSessionInit) return messages;
    return messages.filter(
      (msg) => !(msg.role === 'system' && msg.metadata?.systemSubtype === 'init'),
    );
  }, [messages, settings.showSessionInit]);

  // Auto-expand sub-agent (Task) tools so nested transcripts show. Additive: it
  // only ADDS newly-seen Task ids to the expanded set (never removes), so it
  // never triggers a render loop. Note a manually-collapsed Task can re-expand on
  // the next message delta — this matches the prior RunChatView/RichOutputView
  // behavior (both auto-expanded Task tools on every load).
  useEffect(() => {
    const subAgentIds = new Set<string>();
    for (const msg of messages) {
      for (const seg of msg.segments) {
        if (seg.type === 'tool_call' && seg.tool.name === 'Task') {
          subAgentIds.add(seg.tool.id);
        }
      }
    }
    if (subAgentIds.size === 0) return;
    setExpandedTools((prev) => {
      let changed = false;
      const next = new Set(prev);
      subAgentIds.forEach((id) => {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [messages]);

  // Auto-scroll on new messages when the user is pinned to the bottom.
  useEffect(() => {
    const hasNewMessages = filteredMessages.length > previousMessageCountRef.current;
    previousMessageCountRef.current = filteredMessages.length;
    if (messagesEndRef.current && hasNewMessages && wasAtBottomRef.current) {
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' as ScrollBehavior });
      });
    }
  }, [filteredMessages]);

  // Scroll-button + at-bottom tracking.
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
  }, [filteredMessages]);

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
        contentParts.push(
          `**Tool: ${seg.tool.name}**\n\`\`\`json\n${JSON.stringify(seg.tool.input, null, 2)}\n\`\`\``,
        );
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

  // -- prompt-history markers (derived from the SAME filtered messages) -----
  const promptMarkers = useMemo<PromptMarker[]>(() => {
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

  const showRail = !isInteractive;

  return (
    <div className="flex h-full">
      {/* Main column: identity strip + transcript region + meta strip + bottom slot. */}
      <div className="flex flex-1 min-w-0 flex-col">
        <ModeIdentityStrip
          name={name}
          transport={transport}
          mode={mode}
          running={running}
          runStatus={runStatus}
        />

        <div className="relative flex-1 overflow-hidden">
          {/* Prompt-rail toggle — only meaningful for the structured transcript. */}
          {showRail && (
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

          {isInteractive ? (
            /* Interactive substrate: the live PTY xterm IS the transcript. The
               structured ChatTranscript stays dormant (not rendered). */
            interactiveBody ?? null
          ) : loadError !== null ? (
            <div className="p-4 text-xs text-status-error">Error loading history: {loadError}</div>
          ) : (
            <ChatTranscript
              messages={filteredMessages}
              settings={settings}
              agentName="Claude"
              isWaitingForResponse={isWaitingForResponse}
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

        <ChatMetaStrip
          folderLabel={folderLabel}
          folderTitle={folderTitle}
          branchName={branchName}
          contextUsage={contextUsage}
        />

        {bottomSlot}
      </div>

      {/* Right prompt-history rail (collapsible) — controlled by promptMarkers. */}
      {showRail && !sidebarCollapsed && (
        <div className="w-[230px] shrink-0 h-full overflow-hidden">
          <PromptNavigation
            panelId={railId}
            prompts={promptMarkers}
            onNavigateToPrompt={handleNavigateToPrompt}
          />
        </div>
      )}
    </div>
  );
}
