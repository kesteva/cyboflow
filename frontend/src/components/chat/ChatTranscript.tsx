import React, { useMemo } from 'react';
import type { LucideIcon } from 'lucide-react';
import { User, Bot, Eye, EyeOff, CheckCircle, XCircle, ArrowDown, Copy, Check, Terminal, Info, Loader2, Clock, Settings2 } from 'lucide-react';
import { parseTimestamp, formatDistanceToNow } from '../../utils/timestampUtils';
import { ThinkingPlaceholder, InlineWorkingIndicator } from '../session/ThinkingPlaceholder';
import { MessageSegment } from '../panels/ai/components/MessageSegment';
import { ToolCallView } from '../panels/ai/components/ToolCallView';
import { ToolCallGroup } from '../panels/ai/components/ToolCallGroup';
import { TodoListDisplay } from '../panels/ai/components/TodoListDisplay';
import type { UnifiedMessage } from '../../../../shared/types/unifiedMessage';
import type { RichOutputSettings } from '../panels/ai/AbstractAIPanel';

const formatStatusLabel = (value: string): string =>
  value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char: string) => char.toUpperCase());

const sessionStatusStyles: Record<string, {
  icon: LucideIcon;
  container: string;
  iconWrapper: string;
  title?: string;
  titleClass: string;
}> = {
  completed: {
    icon: CheckCircle,
    container: 'bg-status-success/10 border-status-success/30',
    iconWrapper: 'bg-status-success/20 text-status-success',
    title: 'Session Completed',
    titleClass: 'text-status-success'
  },
  running: {
    icon: Loader2,
    container: 'bg-interactive/10 border-interactive/30',
    iconWrapper: 'bg-interactive/20 text-interactive-on-dark',
    title: 'Session Running',
    titleClass: 'text-interactive-on-dark'
  },
  initializing: {
    icon: Loader2,
    container: 'bg-interactive/10 border-interactive/30',
    iconWrapper: 'bg-interactive/20 text-interactive-on-dark',
    title: 'Session Initializing',
    titleClass: 'text-interactive-on-dark'
  },
  waiting: {
    icon: Clock,
    container: 'bg-status-warning/10 border-status-warning/30',
    iconWrapper: 'bg-status-warning/20 text-status-warning',
    title: 'Waiting for Input',
    titleClass: 'text-status-warning'
  },
  paused: {
    icon: Clock,
    container: 'bg-status-warning/10 border-status-warning/30',
    iconWrapper: 'bg-status-warning/20 text-status-warning',
    title: 'Session Paused',
    titleClass: 'text-status-warning'
  },
  error: {
    icon: XCircle,
    container: 'bg-status-error/10 border-status-error/30',
    iconWrapper: 'bg-status-error/20 text-status-error',
    title: 'Session Error',
    titleClass: 'text-status-error'
  },
  default: {
    icon: Info,
    container: 'bg-surface-tertiary/50 border-border-primary',
    iconWrapper: 'bg-surface-secondary text-text-secondary',
    title: 'Session Update',
    titleClass: 'text-text-secondary'
  }
};

export interface ChatTranscriptProps {
  /** Messages already filtered for display (e.g. session-init removed when settings.showSessionInit is false). */
  messages: UnifiedMessage[];
  /** Rich output display settings (tool calls, compact mode, thinking, etc.). */
  settings: RichOutputSettings;
  /** Display name for the assistant role (e.g. "Claude"). */
  agentName: string;
  /** Whether system status messages (completed status, task_started) should render. Defaults to true. */
  showSystemMessages?: boolean;
  /** Whether to render the thinking placeholder / inline working indicator at the tail. */
  isWaitingForResponse?: boolean;

  /** Per-message collapse state (keyed by message id). Owned by the caller. */
  collapsedMessages: Set<string>;
  onToggleMessageCollapse: (messageId: string) => void;
  /** Per-tool expand state (keyed by tool id). Owned by the caller. */
  expandedTools: Set<string>;
  onToggleToolExpand: (toolId: string) => void;
  /** Id of the message most recently copied (drives the copy-button check icon). */
  copiedMessageId: string | null;
  onCopyMessage: (message: UnifiedMessage) => void;

  /** Settings panel controls (panel-only; presentational here). */
  showSettings?: boolean;
  onSettingsChange?: (settings: RichOutputSettings) => void;

  /** Imperative scroll plumbing owned by the caller. */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  userMessageRefs: React.MutableRefObject<Map<number, HTMLDivElement>>;
  showScrollButton: boolean;
  onScrollToBottom: () => void;

  /**
   * Optional hook to inject extra UI directly beneath a tool_call at its
   * matching tool_use position (keyed by the tool-call id). Used by the
   * workflow-run chat to render the inline `AskUserQuestionCard` where the
   * `AskUserQuestion` tool_use appears. Returns `null`/`undefined` for tool
   * calls that need no extra UI. When omitted, ChatTranscript renders no
   * extras (default behavior for RichOutputView).
   */
  renderToolCallExtra?: (toolCallId: string) => React.ReactNode;
}

/**
 * Pure presentational chat transcript: messages in -> JSX out.
 *
 * Holds NO data fetching, NO IPC, NO window-event listeners, and NO
 * localStorage access. All state (collapse/expand/copy/scroll) is owned by the
 * caller and passed in as props so this component can be reused across the
 * quick-session chat (RichOutputView) and future consumers.
 */
export const ChatTranscript: React.FC<ChatTranscriptProps> = ({
  messages: filteredMessages,
  settings,
  agentName,
  showSystemMessages: showSystemMessagesProp,
  isWaitingForResponse = false,
  collapsedMessages,
  onToggleMessageCollapse,
  expandedTools,
  onToggleToolExpand,
  copiedMessageId,
  onCopyMessage,
  showSettings,
  onSettingsChange,
  scrollContainerRef,
  messagesEndRef,
  userMessageRefs,
  showScrollButton,
  onScrollToBottom,
  renderToolCallExtra,
}) => {
  const showSystemMessages = showSystemMessagesProp ?? true;

  // Render any caller-supplied extras (e.g. inline AskUserQuestionCard) for the
  // tool_call segments of a message, keyed by tool-call id. No-op when the
  // caller does not pass `renderToolCallExtra` — preserves RichOutputView's
  // existing behavior.
  const renderToolCallExtras = (message: UnifiedMessage): React.ReactNode => {
    if (!renderToolCallExtra) return null;
    const extras = message.segments
      .filter((seg): seg is Extract<typeof seg, { type: 'tool_call' }> => seg.type === 'tool_call')
      .map((seg) => {
        const extra = renderToolCallExtra(seg.tool.id);
        if (extra == null) return null;
        return <div key={`${message.id}-extra-${seg.tool.id}`}>{extra}</div>;
      })
      .filter((node): node is React.ReactElement => node !== null);
    if (extras.length === 0) return null;
    return <>{extras}</>;
  };

  // Render a complete message
  const renderMessage = (message: UnifiedMessage, index: number, userMessageIndex?: number) => {
    const isCollapsed = collapsedMessages.has(message.id);
    const isUser = message.role === 'user';
    const isSystem = message.role === 'system';
    const hasTextContent = message.segments.some(seg => seg.type === 'text');
    const textContent = message.segments
      .filter(seg => seg.type === 'text')
      .map(seg => seg.type === 'text' ? seg.content : '')
      .join('\n\n');

    // Check if message has tool calls, thinking, diffs or tool results
    const hasToolCalls = message.segments.some(seg => seg.type === 'tool_call');
    const hasThinking = message.segments.some(seg => seg.type === 'thinking');
    const hasDiffs = message.segments.some(seg => seg.type === 'diff');
    const hasToolResults = message.segments.some(seg => seg.type === 'tool_result');

    // Determine if we need extra spacing before this message
    const prevMessage = index > 0 ? filteredMessages[index - 1] : null;
    const needsExtraSpacing = prevMessage && (
      (prevMessage.role !== message.role) ||
      (hasThinking && !prevMessage.segments.some(seg => seg.type === 'thinking'))
    );

    // Special rendering for system messages
    if (isSystem) {
      return renderSystemMessage(message, needsExtraSpacing || false);
    }

    // Check if this message has any renderable content (including TodoWrite for now, filtered later)
    const hasRenderableContent = hasTextContent || hasToolCalls || hasThinking || hasDiffs || hasToolResults;

    // If no renderable content and not a special system message, skip or show raw
    if (!hasRenderableContent) {
      // Check if it's a system_info only message that should be handled differently
      const hasSystemInfo = message.segments.some(seg => seg.type === 'system_info');
      if (hasSystemInfo) {
        // Return null to skip rendering - these are handled in renderSystemMessage
        return null;
      }

      // For other messages with no renderable content, show as raw JSON fallback
      if (message.segments.length > 0) {
        return (
          <div
            key={message.id}
            className={`
              rounded-lg transition-all bg-surface-tertiary/50 border border-border-primary
              ${settings.compactMode ? 'p-3' : 'p-4'}
              ${needsExtraSpacing ? 'mt-4' : ''}
            `}
          >
            <div className="text-xs text-text-tertiary mb-2">Unhandled message type</div>
            <pre className="text-xs text-text-secondary font-mono overflow-x-auto">
              {JSON.stringify(message, null, 2)}
            </pre>
          </div>
        );
      }

      // Skip completely empty messages
      return null;
    }

    return (
      <div
        key={message.id}
        ref={isUser && userMessageIndex !== undefined ? (el) => {
          if (el) userMessageRefs.current.set(userMessageIndex, el);
        } : undefined}
        className={`
          rounded-lg transition-all relative group
          ${isUser ? 'bg-surface-secondary' : hasThinking ? 'bg-surface-primary/50' : 'bg-surface-primary'}
          ${hasToolCalls ? 'bg-surface-tertiary/30' : ''}
          ${settings.compactMode ? 'p-3' : 'p-4'}
          ${needsExtraSpacing ? 'mt-4' : ''}
        `}
      >
        {/* Message Header */}
        <div className="flex items-center gap-2 mb-2">
          <div className={`
            rounded-full p-1.5 flex-shrink-0
            ${isUser ? 'bg-status-success/20 text-status-success' : 'bg-interactive/20 text-interactive-on-dark'}
          `}>
            {isUser ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
          </div>
          <div className="flex-1 flex items-baseline gap-2">
            <span className="font-medium text-text-primary text-sm">
              {isUser ? 'You' : agentName}
            </span>
            <span className="text-xs text-text-tertiary">
              {formatDistanceToNow(parseTimestamp(message.timestamp))}
            </span>
            {message.metadata?.duration && (
              <span className="text-xs text-text-tertiary">
                · {(message.metadata.duration / 1000).toFixed(1)}s
              </span>
            )}
          </div>
          {/* Action buttons */}
          <div className="flex items-center gap-1">
            {/* Copy button - only for assistant messages */}
            {!isUser && (
              <button
                onClick={() => onCopyMessage(message)}
                className="p-1.5 rounded-lg bg-surface-secondary/80 hover:bg-surface-secondary transition-all opacity-0 group-hover:opacity-100 border border-border-primary"
                title="Copy message content as markdown"
              >
                {copiedMessageId === message.id ? (
                  <Check className="w-3.5 h-3.5 text-status-success" />
                ) : (
                  <Copy className="w-3.5 h-3.5 text-text-tertiary hover:text-text-secondary" />
                )}
              </button>
            )}
            {/* Hide/Show button for long messages */}
            {hasTextContent && textContent.length > 200 && (
              <button
                onClick={() => onToggleMessageCollapse(message.id)}
                className="p-1.5 rounded-lg hover:bg-surface-secondary/50 transition-colors text-text-tertiary hover:text-text-secondary"
                title={isCollapsed ? "Show full message" : "Collapse message"}
              >
                {isCollapsed ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
              </button>
            )}
          </div>
        </div>

        {/* Message Content */}
        <div className="ml-7 space-y-2">
          {/* Thinking segments */}
          {settings.showThinking && message.segments
            .filter(seg => seg.type === 'thinking')
            .map((seg, idx) => (
              <MessageSegment
                key={`${message.id}-thinking-${idx}`}
                segment={seg}
                messageId={message.id}
                index={idx}
                isUser={isUser}
                expandedTools={expandedTools}
                collapseTools={settings.collapseTools}
                showToolCalls={settings.showToolCalls}
                showThinking={settings.showThinking}
                onToggleToolExpand={onToggleToolExpand}
              />
            ))
          }

          {/* Text segments - combined into one block */}
          {hasTextContent && (
            <MessageSegment
              segment={{ type: 'text', content: textContent }}
              messageId={message.id}
              index={0}
              isUser={isUser}
              isCollapsed={isCollapsed}
              expandedTools={expandedTools}
              collapseTools={settings.collapseTools}
              showToolCalls={settings.showToolCalls}
              showThinking={settings.showThinking}
              onToggleToolExpand={onToggleToolExpand}
            />
          )}

          {/* Group consecutive tools, but break on TodoWrite and filter out SlashCommand */}
          {settings.showToolCalls && (() => {
            const toolSegments = message.segments.filter(seg =>
              seg.type === 'tool_call' && seg.tool.name !== 'SlashCommand'
            );
            if (toolSegments.length === 0) return null;

            const groups: { tools: typeof message.segments, isTodoWrite: boolean }[] = [];
            let currentGroup: typeof message.segments = [];

            toolSegments.forEach((seg) => {
              if (seg.type === 'tool_call' && seg.tool.name === 'TodoWrite') {
                // If we have a current group, save it
                if (currentGroup.length > 0) {
                  groups.push({ tools: currentGroup, isTodoWrite: false });
                  currentGroup = [];
                }
                // Add TodoWrite as its own group
                groups.push({ tools: [seg], isTodoWrite: true });
              } else {
                // Add to current group
                currentGroup.push(seg);
              }
            });

            // Don't forget the last group if it exists
            if (currentGroup.length > 0) {
              groups.push({ tools: currentGroup, isTodoWrite: false });
            }

            return groups.map((group, groupIdx) => {
              if (group.isTodoWrite && group.tools.length === 1) {
                const seg = group.tools[0];
                if (seg.type === 'tool_call' && seg.tool.result) {
                  try {
                    const resultData = typeof seg.tool.result.content === 'string'
                      ? JSON.parse(seg.tool.result.content)
                      : seg.tool.result.content;
                    if (resultData.todos && Array.isArray(resultData.todos)) {
                      return (
                        <TodoListDisplay
                          key={`${message.id}-todo-${groupIdx}`}
                          todos={resultData.todos}
                        />
                      );
                    }
                  } catch (e) {
                    // If parsing fails, show as regular tool
                  }
                }
                // Fallback to regular tool display if TodoWrite has no valid result
                return (
                  <MessageSegment
                    key={`${message.id}-tool-group-${groupIdx}`}
                    segment={seg}
                    messageId={message.id}
                    index={groupIdx}
                    isUser={isUser}
                    expandedTools={expandedTools}
                    collapseTools={settings.collapseTools}
                    showToolCalls={settings.showToolCalls}
                    showThinking={settings.showThinking}
                    onToggleToolExpand={onToggleToolExpand}
                  />
                );
              } else {
                // Regular tool group
                return (
                  <ToolCallGroup
                    key={`${message.id}-tool-group-${groupIdx}`}
                    tools={group.tools}
                    expandedTools={expandedTools}
                    collapseTools={settings.collapseTools}
                    onToggleToolExpand={onToggleToolExpand}
                  />
                );
              }
            });
          })()}

          {/* Diff segments */}
          {message.segments
            .filter(seg => seg.type === 'diff')
            .map((seg, idx) => (
              <MessageSegment
                key={`${message.id}-diff-${idx}`}
                segment={seg}
                messageId={message.id}
                index={idx}
                isUser={isUser}
                expandedTools={expandedTools}
                collapseTools={settings.collapseTools}
                showToolCalls={settings.showToolCalls}
                showThinking={settings.showThinking}
                onToggleToolExpand={onToggleToolExpand}
              />
            ))
          }

          {/* Tool results - only show if not already shown as part of tool calls */}
          {settings.showToolCalls && message.segments
            .filter(seg => seg.type === 'tool_result')
            .map((seg, idx) => (
              <MessageSegment
                key={`${message.id}-result-${idx}`}
                segment={seg}
                messageId={message.id}
                index={idx}
                isUser={isUser}
                expandedTools={expandedTools}
                collapseTools={settings.collapseTools}
                showToolCalls={settings.showToolCalls}
                showThinking={settings.showThinking}
                onToggleToolExpand={onToggleToolExpand}
              />
            ))
          }

          {/* Caller-supplied per-tool extras (e.g. inline AskUserQuestionCard). */}
          {renderToolCallExtras(message)}
        </div>
      </div>
    );
  };

  const renderSystemMessage = (message: UnifiedMessage, needsExtraSpacing: boolean) => {
    const textContent = message.segments
      .filter(seg => seg.type === 'text')
      .map(seg => seg.type === 'text' ? seg.content : '')
      .join('\n\n');

    const errorSegment = message.segments.find(seg => seg.type === 'error');
    if (errorSegment?.type === 'error' && errorSegment.error) {
      const { message: errorMessage, details } = errorSegment.error;

      return (
        <div
          key={message.id}
          className={`
            rounded-lg transition-all bg-status-error/10 border border-status-error/30
            ${settings.compactMode ? 'p-3' : 'p-4'}
            ${needsExtraSpacing ? 'mt-4' : ''}
          `}
        >
          <div className="flex items-start gap-3">
            <div className="rounded-full p-2 bg-status-error/20 text-status-error">
              <XCircle className="w-5 h-5" />
            </div>
            <div className="flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-status-error">
                  {errorMessage || 'Session Error'}
                </span>
                <span className="text-sm text-text-tertiary">
                  {formatDistanceToNow(parseTimestamp(message.timestamp))}
                </span>
              </div>
              {details && (
                <pre className="bg-status-error/10 border border-status-error/30 rounded p-3 text-xs text-status-error/90 whitespace-pre-wrap font-mono overflow-x-auto">
                  {typeof details === 'string' ? details : JSON.stringify(details, null, 2)}
                </pre>
              )}
            </div>
          </div>
        </div>
      );
    }


    if (message.metadata?.systemSubtype === 'init') {
      const info = message.segments.find(seg => seg.type === 'system_info');
      if (info?.type === 'system_info') {
        // Type guard helper to safely convert unknown values to strings
        const toString = (value: unknown): string => typeof value === 'string' ? value : '';

        const infoData = info.info || {};
        const model = toString(infoData.model);
        const cwd = toString(infoData.cwd);
        const toolsLength = Array.isArray(infoData.tools) ? infoData.tools.length : 0;
        return (
          <div
            key={message.id}
            className={`
              rounded-lg transition-all bg-surface-tertiary border border-border-primary
              ${settings.compactMode ? 'p-3' : 'p-4'}
            `}
          >
            <div className="flex items-start gap-3">
              <div className="rounded-full p-2 bg-interactive/10 text-interactive-on-dark">
                <Settings2 className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <span className="font-semibold text-text-primary">Session Started</span>
                  <span className="text-sm text-text-tertiary">
                    {formatDistanceToNow(parseTimestamp(message.timestamp))}
                  </span>
                </div>
                <div className="text-sm text-text-secondary space-y-1">
                  <div>Model: <span className="text-text-primary font-mono">{model}</span></div>
                  <div>Working Directory: <span className="text-text-primary font-mono text-xs">{cwd}</span></div>
                  <div>
                    Tools: <span className="text-text-tertiary">{toolsLength} available</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      }
    } else if (message.metadata?.systemSubtype === 'error') {
      const errorInfo = message.segments.find(seg => seg.type === 'system_info')?.info || {};

      // Type guard helper to safely convert unknown values to strings
      const toString = (value: unknown): string => typeof value === 'string' ? value : '';

      const errorMessage = toString(errorInfo.message) || textContent;
      const errorTitle = toString(errorInfo.error) || 'Session Error';

      return (
        <div
          key={message.id}
          className={`
            rounded-lg transition-all bg-status-error/10 border border-status-error/30
            ${settings.compactMode ? 'p-3' : 'p-4'}
            ${needsExtraSpacing ? 'mt-4' : ''}
          `}
        >
          <div className="flex items-start gap-3">
            <div className="rounded-full p-2 bg-status-error/20 text-status-error">
              <XCircle className="w-5 h-5" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2">
                <span className="font-semibold text-status-error">{errorTitle}</span>
                <span className="text-sm text-text-tertiary">
                  {formatDistanceToNow(parseTimestamp(message.timestamp))}
                </span>
                {message.metadata?.duration && (
                  <span className="text-xs text-text-tertiary">
                    · {(message.metadata.duration / 1000).toFixed(1)}s
                  </span>
                )}
              </div>
              <div className="text-sm text-text-primary whitespace-pre-wrap">
                {errorMessage}
              </div>
            </div>
          </div>
        </div>
      );
    } else if (message.metadata?.systemSubtype === 'context_compacted') {
      const infoSegment = message.segments.find(seg => seg.type === 'system_info');

      // Type guard helper to safely convert unknown values to strings
      const toString = (value: unknown): string => typeof value === 'string' ? value : '';

      const helpMessage = infoSegment?.type === 'system_info' ?
        toString(infoSegment.info?.message) || 'Context has been compacted. You can continue chatting - your next message will automatically include the context summary above.' :
        'Context has been compacted. You can continue chatting - your next message will automatically include the context summary above.';

      return (
        <div
          key={message.id}
          className={`
            rounded-lg transition-all bg-status-warning/10 border border-status-warning/30
            ${settings.compactMode ? 'p-3' : 'p-4'}
            ${needsExtraSpacing ? 'mt-4' : ''}
          `}
        >
          <div className="flex items-start gap-3">
            <div className="rounded-full p-2 bg-status-warning/20 text-status-warning">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
              </svg>
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-3">
                <span className="font-semibold text-status-warning">Context Compacted</span>
                <span className="text-sm text-text-tertiary">
                  {formatDistanceToNow(parseTimestamp(message.timestamp))}
                </span>
              </div>

              {/* Summary content */}
              <div className="bg-surface-secondary rounded-lg p-3 mb-3 border border-border-primary">
                <div className="text-sm text-text-secondary font-mono whitespace-pre-wrap">
                  {textContent}
                </div>
              </div>

              {/* Clear instruction message */}
              <div className="flex items-start gap-2">
                <CheckCircle className="w-4 h-4 text-status-success mt-0.5 flex-shrink-0" />
                <div className="text-sm text-text-primary">
                  <span className="font-medium">Ready to continue!</span> {helpMessage}
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    } else if (message.metadata?.systemSubtype === 'slash_command_result') {
      // Render slash command result with subtle styling
      return (
        <div
          key={message.id}
          className={`
            rounded-lg transition-all border bg-surface-tertiary/50 border-border-primary
            ${settings.compactMode ? 'p-3' : 'p-4'}
            ${needsExtraSpacing ? 'mt-4' : ''}
          `}
        >
          <div className="flex items-start gap-3">
            <div className="rounded-full p-2 bg-surface-secondary text-text-secondary">
              <Terminal className="w-5 h-5" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2">
                <span className="font-semibold text-text-primary">
                  Result
                </span>
                <span className="text-sm text-text-tertiary">
                  {formatDistanceToNow(parseTimestamp(message.timestamp))}
                </span>
              </div>
              <div className="bg-surface-secondary rounded-lg p-3 text-sm text-text-primary whitespace-pre-wrap font-mono">
                {textContent}
              </div>
            </div>
          </div>
        </div>
      );
    } else if (message.metadata?.systemSubtype === 'git_operation' || message.metadata?.systemSubtype === 'git_error') {
      const isError = message.metadata.systemSubtype === 'git_error';
      const rawOutput = textContent;
      const isSuccess = !isError && (rawOutput.includes('✓') || rawOutput.includes('Successfully'));

      // Parse the git operation message for better formatting
      const lines = rawOutput.split('\n');
      const mainMessage = lines.filter(line => !line.includes('🔄 GIT OPERATION') && line.trim()).join('\n');

      return (
        <div
          key={message.id}
          className={`
            rounded-lg transition-all border
            ${isError
              ? 'bg-status-error/10 border-status-error/30'
              : isSuccess
                ? 'bg-status-success/10 border-status-success/30'
                : 'bg-interactive/10 border-interactive/30'
            }
            ${settings.compactMode ? 'p-3' : 'p-4'}
            ${needsExtraSpacing ? 'mt-4' : ''}
          `}
        >
          <div className="flex items-start gap-3">
            <div className={`
              rounded-full p-2
              ${isError
                ? 'bg-status-error/20 text-status-error'
                : isSuccess
                  ? 'bg-status-success/20 text-status-success'
                  : 'bg-interactive/20 text-interactive-on-dark'
              }
            `}>
              {isError ? (
                <XCircle className="w-5 h-5" />
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                </svg>
              )}
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2">
                <span className={`
                  font-semibold
                  ${isError ? 'text-status-error' : isSuccess ? 'text-status-success' : 'text-interactive-on-dark'}
                `}>
                  {isError ? 'Git Operation Failed' : '🔄 Git Operation'}
                </span>
                <span className="text-sm text-text-tertiary">
                  {formatDistanceToNow(parseTimestamp(message.timestamp))}
                </span>
              </div>
              <div className="space-y-2">
                {mainMessage.split('\n').map((line, idx) => {
                  const trimmedLine = line.trim();
                  if (!trimmedLine) return null;

                  if (isError) {
                    if (trimmedLine.startsWith('✗')) {
                      return (
                        <div key={idx} className="flex items-center gap-2 text-status-error font-medium">
                          <span className="text-base">✗</span>
                          <span>{trimmedLine.substring(1).trim()}</span>
                        </div>
                      );
                    } else if (trimmedLine.includes('Git output:')) {
                      return (
                        <div key={idx} className="text-sm text-text-secondary font-medium border-t border-status-error/20 pt-2 mt-2">
                          {trimmedLine}
                        </div>
                      );
                    } else {
                      return (
                        <div key={idx} className="text-sm text-status-error font-mono bg-surface-secondary/50 p-2 rounded border border-status-error/20">
                          {trimmedLine}
                        </div>
                      );
                    }
                  } else {
                    if (trimmedLine.startsWith('✓')) {
                      return (
                        <div key={idx} className="flex items-center gap-2 text-status-success font-medium">
                          <span className="text-base">✓</span>
                          <span>{trimmedLine.substring(1).trim()}</span>
                        </div>
                      );
                    } else if (trimmedLine.startsWith('Commit message:') || trimmedLine.includes('Git output:')) {
                      return (
                        <div key={idx} className="text-sm text-text-secondary font-medium border-t border-border-primary pt-2 mt-2">
                          {trimmedLine}
                        </div>
                      );
                    } else {
                      return (
                        <div key={idx} className="text-text-primary">
                          {trimmedLine}
                        </div>
                      );
                    }
                  }
                })}
              </div>
            </div>
          </div>
        </div>
      );
    }

    // Check if there's system_info to display
    const systemInfo = message.segments.find(seg => seg.type === 'system_info');
    if (systemInfo?.type === 'system_info' && systemInfo.info) {
      const info = systemInfo.info;

      // Type guard helpers to safely convert unknown values
      const toString = (value: unknown): string => typeof value === 'string' ? value : '';
      const toNumber = (value: unknown): number => typeof value === 'number' ? value : 0;

      // Handle specific system_info types
      if (info.type === 'session_status') {
        const rawStatus = typeof info.status === 'string' ? info.status : 'unknown';
        const statusKey = rawStatus.toLowerCase();
        const config = sessionStatusStyles[statusKey] || sessionStatusStyles.default;
        const StatusIcon = config.icon;
        const title = config.title ?? formatStatusLabel(rawStatus);

        if (!showSystemMessages && statusKey === 'completed') {
          return null;
        }

        const statusMessage = typeof info.message === 'string' && info.message.trim().length > 0
          ? info.message
          : `Session status updated to ${formatStatusLabel(rawStatus)}`;

        const detailsContent = info.details && typeof info.details === 'string'
          ? info.details
          : info.details && typeof info.details === 'object'
            ? JSON.stringify(info.details, null, 2)
            : null;

        return (
          <div
            key={message.id}
            className={`
              rounded-lg transition-all border
              ${config.container}
              ${settings.compactMode ? 'p-3' : 'p-4'}
              ${needsExtraSpacing ? 'mt-4' : ''}
            `}
          >
            <div className="flex items-start gap-3">
              <div className={`rounded-full p-2 ${config.iconWrapper}`}>
                <StatusIcon className={`w-5 h-5 ${statusKey === 'running' || statusKey === 'initializing' ? 'animate-spin' : ''}`} />
              </div>
              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <span className={`font-semibold ${config.titleClass}`}>
                    {title}
                  </span>
                  <span className="text-sm text-text-tertiary">
                    {formatDistanceToNow(parseTimestamp(message.timestamp))}
                  </span>
                </div>
                <div className="text-sm text-text-secondary whitespace-pre-wrap">
                  {statusMessage}
                </div>
                {detailsContent && (
                  <pre className="bg-surface-secondary/70 border border-border-primary rounded p-3 text-xs text-text-secondary whitespace-pre-wrap font-mono overflow-x-auto">
                    {detailsContent}
                  </pre>
                )}
              </div>
            </div>
          </div>
        );
      }

      if (info.type === 'task_started') {
        if (!showSystemMessages) {
          return null;
        }

        const modelContextWindow = toNumber(info.model_context_window);

        return (
          <div
            key={message.id}
            className={`
              rounded-lg transition-all bg-interactive/5 border border-interactive/20
              ${settings.compactMode ? 'p-2' : 'p-3'}
              ${needsExtraSpacing ? 'mt-4' : ''}
            `}
          >
            <div className="flex items-center gap-2 text-xs text-interactive">
              <span>📋</span>
              <span>Task started</span>
              {modelContextWindow > 0 && (
                <span className="text-text-tertiary">
                  • Context: {(modelContextWindow / 1000).toFixed(0)}k tokens
                </span>
              )}
            </div>
          </div>
        );
      }

      if (info.type === 'task_complete') {
        const lastMessage = toString(info.last_message);

        return (
          <div
            key={message.id}
            className={`
              rounded-lg transition-all bg-status-success/5 border border-status-success/20
              ${settings.compactMode ? 'p-2' : 'p-3'}
              ${needsExtraSpacing ? 'mt-4' : ''}
            `}
          >
            <div className="flex items-center gap-2 text-xs text-status-success">
              <span>✅</span>
              <span>Task completed</span>
              {lastMessage && (
                <span className="text-text-tertiary">• {lastMessage}</span>
              )}
            </div>
          </div>
        );
      }

      if (info.type === 'token_usage') {
        const inputTokens = toNumber(info.input_tokens);
        const outputTokens = toNumber(info.output_tokens);
        const totalTokens = toNumber(info.total_tokens);
        const cachedTokens = toNumber(info.cached_tokens);

        return (
          <div
            key={message.id}
            className={`
              rounded-lg transition-all bg-surface-tertiary/30 border border-border-primary
              ${settings.compactMode ? 'p-2' : 'p-3'}
              ${needsExtraSpacing ? 'mt-4' : ''}
            `}
          >
            <div className="flex items-center gap-3 text-xs text-text-tertiary">
              <span>🔢</span>
              <span>Tokens:</span>
              {inputTokens > 0 && <span>In: {inputTokens.toLocaleString()}</span>}
              {outputTokens > 0 && <span>Out: {outputTokens.toLocaleString()}</span>}
              {totalTokens > 0 && <span className="text-text-secondary">Total: {totalTokens.toLocaleString()}</span>}
              {cachedTokens > 0 && (
                <span className="text-interactive">Cached: {cachedTokens.toLocaleString()}</span>
              )}
            </div>
          </div>
        );
      }
    }

    // Default system message rendering - only if there's text content
    if (textContent) {
      return (
        <div
          key={message.id}
          className={`
            rounded-lg transition-all bg-surface-tertiary/50 border border-border-primary
            ${settings.compactMode ? 'p-3' : 'p-4'}
            ${needsExtraSpacing ? 'mt-4' : ''}
          `}
        >
          <div className="text-sm text-text-secondary">
            {textContent}
          </div>
        </div>
      );
    }

    // If no text content and no recognized system_info, return null to skip
    return null;
  };

  // Memoize the rendered messages to prevent unnecessary re-renders
  const renderedMessages = useMemo(() => {
    let userMessageIndex = 0;
    const elements: (React.ReactElement | null)[] = [];

    // Group consecutive tool-only messages
    let i = 0;
    while (i < filteredMessages.length) {
      const msg = filteredMessages[i];
      const isUser = msg.role === 'user';

      // Check if this message contains only tool calls
      const hasOnlyToolCalls = !isUser &&
        msg.segments.length > 0 &&
        msg.segments.every(seg => seg.type === 'tool_call');

      if (hasOnlyToolCalls && settings.showToolCalls) {
        // Collect consecutive tool messages, but break on TodoWrite
        const toolGroups: { messages: typeof filteredMessages, isTodoWrite: boolean }[] = [];
        let currentGroup: typeof filteredMessages = [];
        const messagesToProcess = [msg];
        let j = i + 1;

        // First collect all consecutive tool-only messages
        while (j < filteredMessages.length) {
          const nextMsg = filteredMessages[j];
          const nextHasOnlyToolCalls = !nextMsg.role || (nextMsg.role === 'assistant' &&
            nextMsg.segments.length > 0 &&
            nextMsg.segments.every(seg => seg.type === 'tool_call'));

          if (nextHasOnlyToolCalls) {
            messagesToProcess.push(nextMsg);
            j++;
          } else {
            break;
          }
        }

        // Now group them, breaking on TodoWrite
        for (const toolMsg of messagesToProcess) {
          const hasTodoWrite = toolMsg.segments.some(seg =>
            seg.type === 'tool_call' && seg.tool.name === 'TodoWrite'
          );

          if (hasTodoWrite) {
            // Save current group if any
            if (currentGroup.length > 0) {
              toolGroups.push({ messages: currentGroup, isTodoWrite: false });
              currentGroup = [];
            }
            // Add TodoWrite message as its own group
            toolGroups.push({ messages: [toolMsg], isTodoWrite: true });
          } else {
            // Add to current group
            currentGroup.push(toolMsg);
          }
        }

        // Save last group if any
        if (currentGroup.length > 0) {
          toolGroups.push({ messages: currentGroup, isTodoWrite: false });
        }

        // toolMessages is no longer needed since we use toolGroups now

        // Render each group
        if (toolGroups.length > 0) {
          toolGroups.forEach((group, groupIdx) => {
            if (group.isTodoWrite) {
              // Render TodoWrite display
              const todoMsg = group.messages[0];
              const todoSegment = todoMsg.segments.find(seg =>
                seg.type === 'tool_call' && seg.tool.name === 'TodoWrite'
              );

              if (todoSegment && todoSegment.type === 'tool_call') {
                let todos = todoSegment.tool.input?.todos;
                if (!todos && todoSegment.tool.result) {
                  try {
                    const resultContent = typeof todoSegment.tool.result.content === 'string'
                      ? JSON.parse(todoSegment.tool.result.content)
                      : todoSegment.tool.result.content;
                    todos = resultContent?.todos;
                  } catch (e) {
                    // Failed to parse result
                  }
                }

                // Type guard to ensure todos is an array
                const validTodos = Array.isArray(todos) ? todos : [];

                if (validTodos.length > 0) {
                  // Wrap TodoListDisplay in an assistant message block
                  elements.push(
                    <div
                      key={`todo-display-${i}-${groupIdx}`}
                      className={`
                        rounded-lg transition-all relative group
                        bg-surface-primary
                        ${settings.compactMode ? 'p-3 mt-2' : 'p-4 mt-3'}
                      `}
                    >
                      {/* Message Header */}
                      <div className="flex items-center gap-2 mb-2">
                        <div className="rounded-full p-1.5 flex-shrink-0 bg-interactive/20 text-interactive-on-dark">
                          <Bot className="w-4 h-4" />
                        </div>
                        <div className="flex-1 flex items-baseline gap-2">
                          <span className="font-medium text-text-primary text-sm">
                            {agentName}
                          </span>
                          <span className="text-xs text-text-tertiary">
                            {formatDistanceToNow(parseTimestamp(todoMsg.timestamp))}
                          </span>
                        </div>
                      </div>

                      {/* Todo List Content */}
                      <div className="ml-7">
                        <TodoListDisplay todos={validTodos} timestamp={todoMsg.timestamp} />
                      </div>
                    </div>
                  );
                }
              }
            } else if (group.messages.length > 1) {
              // Render tool group
              const allToolSegments = group.messages.flatMap(m =>
                m.segments.filter(seg => seg.type === 'tool_call')
              );

              elements.push(
                <div
                  key={`tool-group-${i}-${groupIdx}`}
                  className={`rounded-lg bg-surface-primary ${settings.compactMode ? 'p-3 mt-2' : 'p-4 mt-3'}`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <div className="rounded-full p-1.5 flex-shrink-0 bg-interactive/20 text-interactive-on-dark">
                      <Bot className="w-4 h-4" />
                    </div>
                    <div className="flex-1 flex items-baseline gap-2">
                      <span className="font-medium text-text-primary text-sm">
                        {agentName}
                      </span>
                      <span className="text-xs text-text-tertiary">
                        Tool sequence
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px]">
                      {allToolSegments.filter(seg => seg.type === 'tool_call' && seg.tool.status === 'success').length > 0 && (
                        <span className="text-status-success">
                          {allToolSegments.filter(seg => seg.type === 'tool_call' && seg.tool.status === 'success').length}✓
                        </span>
                      )}
                      {allToolSegments.filter(seg => seg.type === 'tool_call' && seg.tool.status === 'error').length > 0 && (
                        <span className="text-status-error">
                          {allToolSegments.filter(seg => seg.type === 'tool_call' && seg.tool.status === 'error').length}✗
                        </span>
                      )}
                      {allToolSegments.filter(seg => seg.type === 'tool_call' && seg.tool.status === 'pending').length > 0 && (
                        <span className="text-text-tertiary">
                          {allToolSegments.filter(seg => seg.type === 'tool_call' && seg.tool.status === 'pending').length}⏳
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="ml-7 space-y-[1px]">
                    {allToolSegments.map((seg, segIdx) => (
                      <div key={`grouped-tool-${i}-${groupIdx}-${segIdx}`}>
                        {seg.type === 'tool_call' && (
                          <ToolCallView
                            tool={seg.tool}
                            isExpanded={settings.collapseTools ? expandedTools.has(seg.tool.id) : false}
                            collapseTools={settings.collapseTools}
                            onToggleExpand={onToggleToolExpand}
                            expandedTools={expandedTools}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
              // Inline tool-call extras (e.g. AskUserQuestionCard) for grouped tools.
              group.messages.forEach((toolMsg) => {
                const extras = renderToolCallExtras(toolMsg);
                if (extras) {
                  elements.push(
                    <React.Fragment key={`tool-group-extra-${i}-${groupIdx}-${toolMsg.id}`}>
                      {extras}
                    </React.Fragment>,
                  );
                }
              });
            } else if (group.messages.length === 1) {
              // Single tool message, render normally
              const element = renderMessage(group.messages[0], i);
              elements.push(element);
            }
          });

          i = j; // Skip all the messages we processed
        } else {
          // Single tool-only message, render normally
          const element = renderMessage(msg, i, isUser ? userMessageIndex : undefined);
          if (isUser) userMessageIndex++;
          elements.push(element);
          i++;
        }
      } else {
        // Regular message, render normally
        const element = renderMessage(msg, i, isUser ? userMessageIndex : undefined);
        if (isUser) userMessageIndex++;

        // If this message has TodoWrite mixed with other content, also render TodoWrite separately
        if (!isUser && msg.segments.some(seg => seg.type === 'tool_call' && seg.tool.name === 'TodoWrite')) {
          // Find the last TodoWrite in this message
          const todoSegments = msg.segments.filter(seg => seg.type === 'tool_call' && seg.tool.name === 'TodoWrite');
          const lastTodoSegment = todoSegments[todoSegments.length - 1];

          if (lastTodoSegment && lastTodoSegment.type === 'tool_call' && lastTodoSegment.tool.input?.todos) {
            // Type guard to ensure todos is an array
            const todoList = Array.isArray(lastTodoSegment.tool.input.todos) ? lastTodoSegment.tool.input.todos : [];

            if (todoList.length > 0) {
              // First add the regular message (with TodoWrite filtered out in renderMessage)
              elements.push(element);

              // Then add the TodoWrite display separately, wrapped in an assistant message block
              const todoElement = (
              <div
                key={`todo-display-${msg.id}`}
                className={`
                  rounded-lg transition-all relative group
                  bg-surface-primary
                  ${settings.compactMode ? 'p-3 mt-2' : 'p-4 mt-3'}
                `}
              >
                {/* Message Header */}
                <div className="flex items-center gap-2 mb-2">
                  <div className="rounded-full p-1.5 flex-shrink-0 bg-interactive/20 text-interactive-on-dark">
                    <Bot className="w-4 h-4" />
                  </div>
                  <div className="flex-1 flex items-baseline gap-2">
                    <span className="font-medium text-text-primary text-sm">
                      {agentName}
                    </span>
                    <span className="text-xs text-text-tertiary">
                      {formatDistanceToNow(parseTimestamp(msg.timestamp))}
                    </span>
                  </div>
                </div>

                {/* Todo List Content */}
                <div className="ml-7">
                  <TodoListDisplay todos={todoList} timestamp={msg.timestamp} />
                </div>
              </div>
            );
            elements.push(todoElement);
            } else {
              elements.push(element);
            }
          } else {
            elements.push(element);
          }
        } else {
          elements.push(element);
        }
        i++;
      }
    }

    return elements.filter(element => element !== null); // Filter out null elements
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredMessages, collapsedMessages, expandedTools, settings, onToggleToolExpand, agentName, showSystemMessages, copiedMessageId, renderToolCallExtra]);

  return (
    <div className="h-full flex flex-col bg-bg-primary relative">
      {/* Settings Panel */}
      {showSettings && onSettingsChange && (
        <div className="px-4 py-3 border-b border-border-primary bg-surface-secondary">
          <div className="flex flex-wrap gap-4 text-xs">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.showToolCalls}
                onChange={(e) => onSettingsChange({ ...settings, showToolCalls: e.target.checked })}
                className="rounded border-border-primary"
              />
              <span>Show Tool Calls</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.compactMode}
                onChange={(e) => onSettingsChange({ ...settings, compactMode: e.target.checked })}
                className="rounded border-border-primary"
              />
              <span>Compact Mode</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.showThinking}
                onChange={(e) => onSettingsChange({ ...settings, showThinking: e.target.checked })}
                className="rounded border-border-primary"
              />
              <span>Show Thinking</span>
            </label>
          </div>
        </div>
      )}

      {/* Messages */}
      <div
        className="flex-1 overflow-y-auto relative scrollbar-thin scrollbar-thumb-border-secondary scrollbar-track-transparent hover:scrollbar-thumb-border-primary"
        ref={scrollContainerRef}
        style={{
          scrollbarWidth: 'thin',
          scrollbarColor: 'var(--color-border-secondary) transparent'
        }}
      >
        <div className={`mx-auto ${settings.compactMode ? 'max-w-6xl' : 'max-w-5xl'} py-4`}>
          {filteredMessages.length === 0 && !isWaitingForResponse ? (
            <div className="text-center text-text-tertiary py-8">
              No messages to display
            </div>
          ) : (
            <div className="space-y-4 px-4">
              {renderedMessages}
              {isWaitingForResponse && (
                filteredMessages.length === 0 ||
                (filteredMessages.length > 0 && filteredMessages[filteredMessages.length - 1].role === 'user') ? (
                  <ThinkingPlaceholder />
                ) : (
                  <InlineWorkingIndicator />
                )
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Scroll to bottom button - centered above input */}
        {showScrollButton && (
          <div className="sticky bottom-4 flex justify-center pointer-events-none">
            <button
              onClick={onScrollToBottom}
              className="pointer-events-auto p-3 bg-interactive hover:bg-interactive-hover text-white rounded-full shadow-lg transition-all hover:scale-110 flex items-center gap-2"
              title="Scroll to bottom"
            >
              <ArrowDown className="w-5 h-5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

ChatTranscript.displayName = 'ChatTranscript';
