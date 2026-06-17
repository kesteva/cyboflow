import React, { useState, useEffect } from 'react';
import { AIPanelProps, RichOutputSettings } from '../ai/AbstractAIPanel';
import { RichOutputWithSidebar } from './RichOutputWithSidebar';
import { MessagesView } from '../ai/MessagesView';
import { SessionStats } from './SessionStats';
import { ClaudeInputWithImages } from './ClaudeInputWithImages';
import { useClaudePanel } from '../../../hooks/useClaudePanel';
import { ClaudeSettingsPanel } from './ClaudeSettingsPanel';
import { ClaudeMessageTransformer } from '../ai/transformers/ClaudeMessageTransformer';
import { Send, Settings } from 'lucide-react';
import { useConfigStore } from '../../../stores/configStore';
import type { ClaudePanelState } from '../../../../../shared/types/panels';
import { ResizablePanel } from '../../ResizablePanel';
import { PendingApprovalsForRun } from '../../ReviewQueue/PendingApprovalsForRun';
import { useSession } from '../../../contexts/SessionContext';
import { useSessionStore } from '../../../stores/sessionStore';
import { InteractiveTerminalView } from '../../cyboflow/InteractiveTerminalView';
import { DemoTerminalView } from '../../cyboflow/DemoTerminalView';
import { Button } from '../../ui/Button';
import { API } from '../../../utils/api';
import type { IPCResponse } from '../../../utils/api';

export const ClaudePanel: React.FC<AIPanelProps> = React.memo(({ panel, isActive }) => {
  const hook = useClaudePanel(panel.id, isActive);
  const [activeView, setActiveView] = useState<'richOutput' | 'messages' | 'stats'>('richOutput');
  const [showSettings, setShowSettings] = useState(false);
  const [richOutputSettings, setRichOutputSettings] = useState(() => {
    const saved = localStorage.getItem('richOutputSettings');
    return saved ? JSON.parse(saved) : {
      showToolCalls: true,
      compactMode: false,
      collapseTools: true,  // Changed to true for collapsed by default
      showThinking: true,
      showSessionInit: false,
    };
  });

  // Create transformer once and memoize it
  const transformer = React.useMemo(() => new ClaudeMessageTransformer(), []);
  const activeSession = hook.activeSession;
  // Reliable run id for inline approvals: the surrounding SessionProvider holds
  // the freshly-fetched session (effectiveSession), whose runId reflects the
  // backfilled workflow_runs.id. The session-store copy (activeSession) can lag
  // with a null runId for freshly-created quick sessions, so prefer context.
  const sessionCtx = useSession();
  const approvalRunId = sessionCtx?.session.runId ?? activeSession?.runId ?? null;
  // Interactive-PTY render swap (PTY-backed quick sessions): when this panel's
  // session runs on the 'interactive' substrate, the live xterm
  // (InteractiveTerminalView, keyed by the sentinel __quick__ run id) replaces
  // the SDK structured transcript below. Session resolution mirrors
  // approvalRunId — prefer the SessionProvider's freshly-fetched session, fall
  // back to the store copy keyed by the panel's sessionId. Null-safe: an
  // interactive session whose runId has not landed yet keeps the SDK surface.
  const panelStoreSession = useSessionStore((state) =>
    state.sessions.find((s) => s.id === panel.sessionId),
  );
  const substrateSession = sessionCtx?.session ?? panelStoreSession;
  const interactiveRunId =
    substrateSession?.substrate === 'interactive' ? substrateSession.runId ?? null : null;
  const devModeEnabled = useConfigStore((state) => state.config?.devMode ?? false);
  const showDebugTabs = devModeEnabled;
  // Demo mode: an interactive quick session is stamped 'interactive' so this
  // panel swaps in a terminal surface, but the real PTY is never spawned
  // (ipc/session.ts). Render the canned DemoTerminalView instead of the live
  // InteractiveTerminalView (which would subscribe to an empty pty channel).
  const demoModeEnabled = useConfigStore((state) => state.config?.demoMode ?? false);
  const showDemoTerminal = demoModeEnabled && interactiveRunId !== null;

  // Interactive quick sessions are driven by typing DIRECTLY into the live PTY
  // terminal above, so the separate "Message the live session" composer is
  // redundant and is hidden by default. Ctrl+G summons it for rich multi-line
  // text entry (a slim hint bar advertises the shortcut while it is hidden).
  // Captured at the window level (capture phase) so the keystroke toggles the
  // composer instead of reaching xterm as a BEL (\x07).
  const [composerOpen, setComposerOpen] = useState(false);
  useEffect(() => {
    if (interactiveRunId === null) {
      setComposerOpen(false);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault();
        e.stopPropagation();
        setComposerOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [interactiveRunId]);

  const claudePanelState = (panel.state.customState as ClaudePanelState | undefined) ?? {};
  const contextUsage = claudePanelState.contextUsage ?? null;
  const autoContextRunState = claudePanelState.autoContextRunState ?? 'idle';
  const isContextUpdating = autoContextRunState === 'running';
  const contextDisplay = contextUsage ?? '-- tokens (--%)';

  // Extract and store slash commands when we get JSON messages with init
  useEffect(() => {
    if (!activeSession) return;

    const handleSlashCommandsFromMessages = () => {
      const jsonMessages = activeSession.jsonMessages || [];

      // Look for init message with slash_commands
      const initMessage = jsonMessages.find((msg: { type?: string; subtype?: string; slash_commands?: string[] }) =>
        msg.type === 'system' && msg.subtype === 'init' && msg.slash_commands
      );

      if (initMessage && Array.isArray(initMessage.slash_commands)) {
        console.log('[slash-debug] Found init message with slash commands for Cyboflow session:', activeSession.id);
        console.log('[slash-debug] Commands:', initMessage.slash_commands);

        try {
          const slashCommandsKey = `slashCommands_${activeSession.id}`;
          localStorage.setItem(slashCommandsKey, JSON.stringify(initMessage.slash_commands));
          console.log('[slash-debug] Stored slash commands for Cyboflow session:', activeSession.id);
        } catch (e) {
          console.warn('[slash-debug] Failed to store slash commands for Cyboflow session:', e);
        }
      }
    };

    handleSlashCommandsFromMessages();
  }, [activeSession?.jsonMessages, activeSession?.id]);

  const handleRichOutputSettingsChange = (newSettings: RichOutputSettings) => {
    setRichOutputSettings(newSettings);
    localStorage.setItem('richOutputSettings', JSON.stringify(newSettings));
  };

  const toggleSettings = () => {
    setShowSettings(!showSettings);
  };

  useEffect(() => {
    if (!devModeEnabled && activeView !== 'richOutput') {
      setActiveView('richOutput');
    }
  }, [devModeEnabled, activeView]);

  if (!activeSession) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-secondary">
        <div className="text-center p-8">
          <div className="text-4xl mb-4">🤖</div>
          <h2 className="text-xl font-semibold mb-2">Claude Panel</h2>
          <p className="text-sm">No active session</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-background">
      {/* Header — debug tabs drive the SDK structured views only, so they are
          dropped while the live PTY terminal owns the body. */}
      {showDebugTabs && interactiveRunId === null && (
        <div className="border-b border-border-primary bg-surface-primary shadow-sm">
          <div className="flex items-center justify-between px-4 h-12">
            <div className="flex items-center gap-2">
              <div className="flex">
                <button
                  onClick={() => setActiveView('richOutput')}
                  className={`px-4 py-2 text-sm font-medium transition-colors relative ${
                    activeView === 'richOutput'
                      ? 'text-text-primary'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  Output
                  {activeView === 'richOutput' && (
                    <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-interactive" />
                  )}
                </button>
                {devModeEnabled && (
                  <>
                    <button
                      onClick={() => setActiveView('messages')}
                      className={`px-4 py-2 text-sm font-medium transition-colors relative ${
                        activeView === 'messages'
                          ? 'text-text-primary'
                          : 'text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      Messages
                      {activeView === 'messages' && (
                        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-interactive" />
                      )}
                    </button>
                    <button
                      onClick={() => setActiveView('stats')}
                      className={`px-4 py-2 text-sm font-medium transition-colors relative ${
                        activeView === 'stats'
                          ? 'text-text-primary'
                          : 'text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      Stats
                      {activeView === 'stats' && (
                        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-interactive" />
                      )}
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              {activeView === 'richOutput' && (
                <button
                  onClick={toggleSettings}
                  className="p-1.5 rounded hover:bg-surface-hover transition-colors"
                  title="Display settings"
                >
                  <Settings className="w-4 h-4 text-text-secondary" />
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main content area */}
      {interactiveRunId !== null ? (
        /* Interactive substrate: the live PTY xterm IS the conversation
           surface (mirrors RunChatView's swap for workflow runs). The SDK
           structured surface stays dormant (not rendered) so the conversation
           is never double-rendered. The composer below is the dedicated
           InteractiveSessionComposer, which routes through the session-scoped
           sessions:input channel (relayed into the live PTY server-side).
           guardFirstInteraction={false}: quick sessions are user-driven, so
           direct typing into the terminal is the expected interaction — no
           first-mousedown warn dialog, keystroke relay on from mount (workflow
           runs keep the guardrail because cyboflow orchestrates them). */
        <div
          className="flex-1 overflow-hidden relative"
          data-testid="claude-panel-interactive-terminal"
        >
          {showDemoTerminal ? (
            <DemoTerminalView showComposer />
          ) : (
            <InteractiveTerminalView runId={interactiveRunId} guardFirstInteraction={false} />
          )}
        </div>
      ) : (
        <ClaudeMainContent
          panelId={panel.id}
          activeView={activeView}
          showDebugTabs={showDebugTabs}
          devModeEnabled={devModeEnabled}
          activeSession={activeSession}
          richOutputSettings={richOutputSettings}
          handleRichOutputSettingsChange={handleRichOutputSettingsChange}
          transformer={transformer}
          toggleSettings={toggleSettings}
        />
      )}

      {/* Settings Panel */}
      {showSettings && (
        <ClaudeSettingsPanel
          settings={richOutputSettings}
          onSettingsChange={handleRichOutputSettingsChange}
          onClose={() => setShowSettings(false)}
        />
      )}

      {/* Inline permission prompts — surfaces ApprovalRouter approvals directly
          above the input (instead of only in the detached Review Queue). Returns
          null when the session has no run or no pending approval for it. */}
      <PendingApprovalsForRun runId={approvalRunId} className="shrink-0 mx-4 mb-2" />

      {/* Composer - Always visible at bottom if not archived. Interactive
          sessions get the dedicated InteractiveSessionComposer instead of
          ClaudeInputWithImages: the latter's submit handlers hit the
          PANEL-scoped panels:send-input / panels:continue channels, which
          route straight to the SDK claudePanelManager with no substrate guard
          — for an interactive session that would spawn a COMPETING SDK
          conversation in the same worktree as the live PTY. */}
      {!activeSession.archived && (
        // Demo interactive sessions render the cosmetic composer INSIDE
        // DemoTerminalView (showComposer), so suppress the relay composer here.
        showDemoTerminal ? null :
        interactiveRunId !== null ? (
          // Live PTY quick session: hidden by default (type into the terminal),
          // toggled open with Ctrl+G for rich text entry.
          composerOpen ? (
            <InteractiveSessionComposer
              sessionId={activeSession.id}
              autoFocus
              onClose={() => setComposerOpen(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setComposerOpen(true)}
              data-testid="interactive-composer-hint"
              className="flex shrink-0 items-center justify-center gap-2 border-t border-border-primary bg-bg-primary px-3 py-1.5 text-[10px] text-text-tertiary hover:text-text-secondary"
            >
              Type in the terminal above · press
              <kbd className="rounded border border-border-primary px-1 py-0.5 font-mono text-[9px] text-text-secondary">⌃G</kbd>
              for rich text entry
            </button>
          )
        ) : (
          <ResizablePanel
            defaultHeight={200}
            minHeight={140}
            maxHeight={600}
            storageKey="claude-input-panel-height"
          >
            <ClaudeInputWithImages
              activeSession={activeSession}
              viewMode="richOutput"
              input={hook.input}
              setInput={hook.setInput}
              textareaRef={hook.textareaRef}
              handleTerminalCommand={hook.handleTerminalCommand}
              handleSendInput={hook.handleSendInput}
              handleContinueConversation={hook.handleContinueConversation}
              ultrathink={hook.ultrathink}
              setUltrathink={hook.setUltrathink}
              gitCommands={hook.gitCommands}
              handleCompactContext={hook.handleCompactContext}
              hasConversationHistory={hook.hasConversationHistory}
              contextCompacted={hook.contextCompacted}
              handleCancelRequest={hook.handleStopSession}
              contextUsageDisplay={contextDisplay}
              contextUpdating={isContextUpdating}
              panelId={panel.id}
            />
          </ResizablePanel>
        )
      )}

      {/* Show archived message if session is archived */}
      {activeSession.archived && (
        <div className="bg-surface-secondary border-t border-border-primary px-4 py-3 text-center text-text-muted text-sm">
          This session is archived. Unarchive it to continue the conversation.
        </div>
      )}

    </div>
  );
});

ClaudePanel.displayName = 'ClaudePanel';

// Dedicated composer for interactive-PTY quick sessions. Routes through the
// SESSION-scoped API.sessions.sendInput → sessions:input, which branches
// server-side: for substrate 'interactive' the body is relayed into the live
// PTY (followed by a separate Enter keystroke after the bracketed-paste window
// closes). ClaudeInputWithImages is deliberately NOT used here — its handlers
// (useClaudePanel handleSendInput / handleContinueConversation) hit the
// panel-scoped panels:send-input / panels:continue, which have no substrate
// guard and would spawn a competing SDK conversation alongside the live PTY.
// Enter sends, Shift+Enter inserts a newline (mirrors ChatInput).
const InteractiveSessionComposer: React.FC<{
  sessionId: string;
  autoFocus?: boolean;
  onClose?: () => void;
}> = ({ sessionId, autoFocus = false, onClose }) => {
  const [text, setText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  const canSend = text.trim().length > 0 && !isSending;

  const handleSend = async () => {
    if (!canSend) return;
    setIsSending(true);
    setSendError(null);
    try {
      const result: IPCResponse<void> = await API.sessions.sendInput(sessionId, text);
      if (result.success) {
        setText('');
      } else {
        setSendError(result.error ?? 'Send failed');
      }
    } catch (err: unknown) {
      setSendError(err instanceof Error ? err.message : 'Send failed');
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    } else if (e.key === 'Escape' && onClose) {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="flex flex-col gap-1 border-t border-border-primary bg-bg-primary p-2 shrink-0"
      data-testid="interactive-session-composer"
    >
      <div className="flex flex-col border border-border-primary bg-surface-primary transition-colors focus-within:border-border-hover">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message the live session…"
          disabled={isSending}
          rows={2}
          className="w-full resize-none bg-transparent px-3 pt-2 pb-1 text-xs text-text-primary placeholder-text-tertiary focus:outline-none disabled:cursor-not-allowed"
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <span className="text-[10px] text-text-tertiary">
            Enter to send · Shift+Enter for newline{onClose ? ' · Esc to close' : ''}
          </span>
          <Button
            size="sm"
            variant="primary"
            disabled={!canSend}
            onClick={() => void handleSend()}
            className="gap-1.5"
          >
            <Send className="h-3.5 w-3.5" />
            Send
          </Button>
        </div>
      </div>
      {sendError !== null && (
        <p className="text-xs text-status-error" role="alert">
          {sendError}
        </p>
      )}
    </div>
  );
};

// Memoized main content component to prevent unnecessary re-renders when input changes
const ClaudeMainContent = React.memo<{
  panelId: string;
  activeView: string;
  showDebugTabs: boolean;
  devModeEnabled: boolean;
  activeSession: { id: string; status: string };
  richOutputSettings: RichOutputSettings;
  handleRichOutputSettingsChange: (settings: RichOutputSettings) => void;
  transformer: ClaudeMessageTransformer;
  toggleSettings: () => void;
}>(({ panelId, activeView, showDebugTabs, devModeEnabled, activeSession, richOutputSettings, handleRichOutputSettingsChange, transformer, toggleSettings }) => {
  return (
    <div className="flex-1 overflow-hidden relative">
      {!showDebugTabs && (
        <div className="absolute top-3 right-3 z-10">
          <button
            onClick={toggleSettings}
            className="p-2 rounded border border-border-primary bg-surface-secondary shadow-sm hover:bg-surface-hover transition-colors"
            title="Display settings"
            aria-label="Open Claude settings"
          >
            <Settings className="w-4 h-4 text-text-secondary" />
          </button>
        </div>
      )}
      {activeView === 'richOutput' && (
        <RichOutputWithSidebar
          panelId={panelId}
          sessionStatus={activeSession.status}
          settings={richOutputSettings}
          onSettingsChange={handleRichOutputSettingsChange}
          transformer={transformer}
        />
      )}
      {devModeEnabled && activeView === 'messages' && (
        <MessagesView
          panelId={panelId}
          agentType="claude"
          outputEventName="session:output"
        />
      )}
      {devModeEnabled && activeView === 'stats' && (
        <SessionStats sessionId={activeSession.id} />
      )}
    </div>
  );
}, (prevProps, nextProps) => {
  // Custom comparison function - only re-render if these specific props change
  return (
    prevProps.panelId === nextProps.panelId &&
    prevProps.activeView === nextProps.activeView &&
    prevProps.showDebugTabs === nextProps.showDebugTabs &&
    prevProps.devModeEnabled === nextProps.devModeEnabled &&
    prevProps.activeSession.id === nextProps.activeSession.id &&
    prevProps.activeSession.status === nextProps.activeSession.status &&
    prevProps.richOutputSettings === nextProps.richOutputSettings &&
    prevProps.transformer === nextProps.transformer
  );
});

ClaudeMainContent.displayName = 'ClaudeMainContent';

// Default export for lazy loading
export default ClaudePanel;
