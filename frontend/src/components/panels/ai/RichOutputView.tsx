import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react';
import { API } from '../../../utils/api';
import { MessageTransformer, UnifiedMessage } from './transformers/MessageTransformer';
import { RichOutputSettings } from './AbstractAIPanel';
import { ChatTranscript } from '../../chat/ChatTranscript';

// Interface for conversation messages from database
interface ConversationMessage {
  id: number;
  session_id: string;
  message_type: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

const defaultSettings: RichOutputSettings = {
  showToolCalls: true,
  compactMode: false,
  collapseTools: true, // Collapse tools by default
  showThinking: true,
  showSessionInit: false, // Hide by default - it's developer info
};

interface RichOutputViewProps {
  panelId: string;
  sessionStatus?: string;
  settings?: RichOutputSettings;
  onSettingsChange?: (settings: RichOutputSettings) => void;
  showSettings?: boolean;
  messageTransformer: MessageTransformer;
  outputEventName: string;
  getOutputsHandler: string;
  showSystemMessages?: boolean;
}

export const RichOutputView = React.forwardRef<{ scrollToPrompt: (promptIndex: number) => void }, RichOutputViewProps>(
  ({ panelId, sessionStatus, settings: propsSettings, onSettingsChange, showSettings, messageTransformer, outputEventName, getOutputsHandler, showSystemMessages: showSystemMessagesProp }, ref) => {
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsedMessages, setCollapsedMessages] = useState<Set<string>>(new Set());
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const showSystemMessages = showSystemMessagesProp ?? true;

  // Use parent-controlled settings if provided, otherwise use default
  const localSettings = useMemo<RichOutputSettings>(() => {
    const saved = localStorage.getItem('richOutputSettings');
    return saved ? JSON.parse(saved) : defaultSettings;
  }, []);

  const settings = propsSettings || localSettings;

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isLoadingRef = useRef(false);
  const userMessageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const wasAtBottomRef = useRef(true); // Start as true to scroll to bottom on first load
  const loadMessagesRef = useRef<(() => Promise<void>) | null>(null);
  const isFirstLoadRef = useRef(true); // Track if this is the first load
  const previousMessageCountRef = useRef(0); // Track previous message count

  // Save local settings to localStorage when they change
  useEffect(() => {
    if (!propsSettings) {
      localStorage.setItem('richOutputSettings', JSON.stringify(localSettings));
    }
  }, [localSettings, propsSettings]);
  
  // Expose scroll method via ref
  React.useImperativeHandle(ref, () => ({
    scrollToPrompt: (promptIndex: number) => {
      const messageDiv = userMessageRefs.current.get(promptIndex);
      if (messageDiv && scrollContainerRef.current) {
        // Scroll to the message with some offset from top
        messageDiv.scrollIntoView({ behavior: 'auto', block: 'center' });
        
        // Add a highlight effect
        messageDiv.classList.add('highlight-prompt');
        setTimeout(() => {
          messageDiv.classList.remove('highlight-prompt');
        }, 2000);
      }
    }
  }), []);

  const loadMessages = useCallback(async () => {
    // Prevent concurrent loads using ref
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;
    
    // Capture scroll position before loading
    const container = scrollContainerRef.current;
    if (container) {
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      const wasAtBottom = distanceFromBottom < 50;
      wasAtBottomRef.current = wasAtBottom;
    }
    
    try {
      setError(null);
      
      {
        // Use the existing API calls
        const [conversationResponse, outputResponse] = await Promise.all([
          API.panels.getConversationMessages(panelId),
          API.panels.getJsonMessages(panelId)
        ]);
        
        // Combine both sources - conversation messages have the actual user prompts.
        // Convert them to UnifiedMessage shape so the identity transformer doesn't
        // produce objects missing `segments` (crashes RichOutputView).
        const userPrompts: UnifiedMessage[] = [];
        if (conversationResponse.success && Array.isArray(conversationResponse.data)) {
          conversationResponse.data.forEach((msg: ConversationMessage) => {
            if (msg.message_type === 'user') {
              if (msg.content && typeof msg.content === 'string' && msg.content.includes('<local-command-stdout>')) {
                return;
              }

              userPrompts.push({
                id: `user-${msg.timestamp}-${userPrompts.length}`,
                role: 'user',
                timestamp: msg.timestamp,
                segments: [{ type: 'text', content: typeof msg.content === 'string' ? msg.content : '' }],
              });
            }
          });
        }

        // Combine user prompts with output messages.
        const allMessages: unknown[] = [...userPrompts];
        if (outputResponse.success && Array.isArray(outputResponse.data)) {
          allMessages.push(...outputResponse.data);
        }
        
        // Sort by timestamp to get correct order.
        allMessages.sort((a, b) => {
          const msgA = a as { timestamp?: string };
          const msgB = b as { timestamp?: string };
          const timeA = new Date(msgA.timestamp ?? '').getTime();
          const timeB = new Date(msgB.timestamp ?? '').getTime();
          return timeA - timeB;
        });
        
        // Transform messages using the provided transformer
        const conversationMessages = messageTransformer.transform(allMessages);
        setMessages(conversationMessages);
        
        // Auto-expand sub-agent (Task) tools
        const newSubAgentIds = new Set<string>();
        conversationMessages.forEach(msg => {
          msg.segments.forEach(seg => {
            if (seg.type === 'tool_call' && seg.tool.name === 'Task') {
              newSubAgentIds.add(seg.tool.id);
            }
          });
        });
        
        // Add sub-agent IDs to expanded tools
        if (newSubAgentIds.size > 0) {
          setExpandedTools(prev => {
            const next = new Set(prev);
            newSubAgentIds.forEach(id => next.add(id));
            return next;
          });
        }
      }
    } catch (err) {
      console.error('Failed to load messages:', err);
      setError('Failed to load conversation history');
    } finally {
      setLoading(false);
      isLoadingRef.current = false;
    }
  }, [panelId, messageTransformer, getOutputsHandler]);

  // Store loadMessages in ref to avoid dependency cycles
  useEffect(() => {
    loadMessagesRef.current = loadMessages;
  }, [loadMessages]);

  // Listen for real-time output updates - debounced to prevent performance issues
  useEffect(() => {
    let debounceTimer: NodeJS.Timeout;
    
    const handleOutputAvailable = (event: CustomEvent<{ sessionId?: string; panelId?: string; type?: string }> | { sessionId?: string; panelId?: string; type?: string; detail?: { sessionId?: string; panelId?: string; type?: string } }) => {
      // Handle both CustomEvent and Electron IPC events
      const detail = 'detail' in event ? event.detail : event;
      if (detail && (detail.sessionId === panelId || detail.panelId === panelId)) {
        // Debounce message reloading to prevent excessive re-renders
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          // Reload all messages from database to ensure consistency
          loadMessagesRef.current?.();
        }, 500); // Wait 500ms after last event
      }
    };
    
    // Listen for session output events
    window.addEventListener('session-output-available', handleOutputAvailable as EventListener);

    return () => {
      clearTimeout(debounceTimer);
      window.removeEventListener('session-output-available', handleOutputAvailable as EventListener);
    };
  }, [panelId, outputEventName]); // Remove messageTransformer from dependencies to avoid re-registering

  // Initial load - only when panelId actually changes
  useEffect(() => {
    if (!panelId) return;
    // Reset first load flag when session changes
    isFirstLoadRef.current = true;
    wasAtBottomRef.current = true; // Also reset to true for new sessions
    loadMessages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelId]); // Only depend on panelId, not loadMessages - we want this to run only on panel change

  // Removed redundant effect that was calling loadMessages on every parent re-render
  // Messages are loaded via the initial effect above and real-time updates via the output event listener

  // Track if user is at bottom - set up as soon as possible
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const checkIfAtBottom = () => {
      // Consider "at bottom" only if within 50px of the bottom
      // This ensures we don't auto-scroll if the user has intentionally scrolled up
      const threshold = 50;
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      const isAtBottom = distanceFromBottom < threshold;
      
      
      wasAtBottomRef.current = isAtBottom;
    };

    // Check initial position immediately
    checkIfAtBottom();

    // Add scroll listener
    container.addEventListener('scroll', checkIfAtBottom, { passive: true });
    
    return () => {
      container.removeEventListener('scroll', checkIfAtBottom);
    };
  }); // Run on every render to ensure we catch container availability

  // Auto-scroll to bottom when messages change or view loads
  useEffect(() => {
    // Only proceed if we have new messages (not just a re-render)
    const hasNewMessages = messages.length > previousMessageCountRef.current;
    previousMessageCountRef.current = messages.length;
    
    if (messagesEndRef.current && !loading && (hasNewMessages || isFirstLoadRef.current)) {
      // Use the wasAtBottomRef value that was captured BEFORE the messages updated
      // Don't double-check after DOM update as the scroll position will have changed
      if (isFirstLoadRef.current || wasAtBottomRef.current) {
        // Use requestAnimationFrame to ensure DOM has updated
        requestAnimationFrame(() => {
          // Use instant scrolling for better responsiveness during active output
          // Smooth scrolling can be too slow and cause users to miss content
          messagesEndRef.current?.scrollIntoView({ behavior: 'instant' as ScrollBehavior });
          // Mark first load as complete
          if (isFirstLoadRef.current) {
            isFirstLoadRef.current = false;
          }
        });
      }
    }
  }, [messages, loading]);

  // Handle scroll events to show/hide scroll button
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      // Show button if scrolled up more than one viewport height
      const scrolledUp = scrollHeight - scrollTop - clientHeight;
      setShowScrollButton(scrolledUp > clientHeight);
    };

    container.addEventListener('scroll', handleScroll);
    // Check initial state
    handleScroll();

    return () => container.removeEventListener('scroll', handleScroll);
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const toggleMessageCollapse = (messageId: string) => {
    setCollapsedMessages(prev => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  };

  const toggleToolExpand = (toolId: string) => {
    setExpandedTools(prev => {
      const next = new Set(prev);
      if (next.has(toolId)) {
        next.delete(toolId);
      } else {
        next.add(toolId);
      }
      return next;
    });
  };

  const copyMessageContent = async (message: UnifiedMessage) => {
    // Extract all text content from the message segments
    const contentParts: string[] = [];
    
    message.segments.forEach(seg => {
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
    
    const fullContent = contentParts.join('\n\n');
    
    try {
      await navigator.clipboard.writeText(fullContent);
      setCopiedMessageId(message.id);
      setTimeout(() => {
        setCopiedMessageId(null);
      }, 2000);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  };

  // Check if we're waiting for response
  const isWaitingForResponse = useMemo(() => {
    // Always show placeholder if session is actively running
    if (sessionStatus === 'running') {
      return true;
    }
    
    // Also show if waiting and last message is from user
    if (sessionStatus === 'waiting' && messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      return lastMessage.role === 'user';
    }
    
    return false;
  }, [messages, sessionStatus]);

  // Filter messages based on settings
  const filteredMessages = useMemo(() => {
    if (settings.showSessionInit) {
      return messages;
    }
    // Filter out session init messages
    return messages.filter(msg => !(msg.role === 'system' && msg.metadata?.systemSubtype === 'init'));
  }, [messages, settings.showSessionInit]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-text-secondary">Loading conversation...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-status-error">{error}</div>
      </div>
    );
  }

  return (
    <ChatTranscript
      messages={filteredMessages}
      settings={settings}
      agentName={messageTransformer.getAgentName()}
      showSystemMessages={showSystemMessages}
      isWaitingForResponse={isWaitingForResponse}
      collapsedMessages={collapsedMessages}
      onToggleMessageCollapse={toggleMessageCollapse}
      expandedTools={expandedTools}
      onToggleToolExpand={toggleToolExpand}
      copiedMessageId={copiedMessageId}
      onCopyMessage={copyMessageContent}
      showSettings={showSettings}
      onSettingsChange={onSettingsChange}
      scrollContainerRef={scrollContainerRef}
      messagesEndRef={messagesEndRef}
      userMessageRefs={userMessageRefs}
      showScrollButton={showScrollButton}
      onScrollToBottom={scrollToBottom}
    />
  );
});

RichOutputView.displayName = 'RichOutputView';
