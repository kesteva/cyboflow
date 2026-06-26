import React, { useState, useEffect } from 'react';
import { AIPanelProps, RichOutputSettings } from '../ai/AbstractAIPanel';
import { RichOutputWithSidebar } from './RichOutputWithSidebar';
import { MessagesView } from '../ai/MessagesView';
import { SessionStats } from './SessionStats';
import { useClaudePanel } from '../../../hooks/useClaudePanel';
import { ClaudeSettingsPanel } from './ClaudeSettingsPanel';
import { ClaudeMessageTransformer } from '../ai/transformers/ClaudeMessageTransformer';
import { Settings } from 'lucide-react';
import { useConfigStore } from '../../../stores/configStore';
import type { ClaudePanelState } from '../../../../../shared/types/panels';
import { PendingApprovalsForRun } from '../../ReviewQueue/PendingApprovalsForRun';
import { useSession } from '../../../contexts/SessionContext';
import { useSessionStore } from '../../../stores/sessionStore';
import { InteractiveTerminalView } from '../../cyboflow/InteractiveTerminalView';
import { DemoTerminalView } from '../../cyboflow/DemoTerminalView';
import { QuickSessionComposer } from '../../cyboflow/unified/QuickSessionComposer';
import { ModeIdentityStrip } from '../../cyboflow/unified/ModeIdentityStrip';
import { ChatMetaStrip } from '../../cyboflow/unified/ChatMetaStrip';

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

  // On ⌃G reveal, move focus into the composer so the user's next keystrokes
  // land in the rich text box instead of the live PTY terminal (otherwise they
  // have to click it). The rAF lets the textarea mount first — `inputVisible`
  // flips to true on the same render that sets composerOpen.
  useEffect(() => {
    if (!composerOpen) return;
    const id = requestAnimationFrame(() => hook.textareaRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [composerOpen, hook.textareaRef]);

  const claudePanelState = (panel.state.customState as ClaudePanelState | undefined) ?? {};
  // SDK substrate emits a "54k/200k tokens (27%)" string; null for PTY/empty.
  const contextUsage = claudePanelState.contextUsage ?? null;

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

  // Unified-chat chrome derivations for this quick session.
  //
  // Use the PANE's own session — substrateSession (the SessionProvider's
  // freshly-fetched session, else the store copy keyed by panel.sessionId),
  // falling back to the global activeSession only when neither is present. The
  // global store `activeSession` is keyed by the GLOBAL activeSessionId, which
  // can point at a different / lagging session than the one THIS panel renders
  // (same "prefer context over the laggy store copy" reasoning already applied
  // to approvalRunId + the substrate swap above). Feeding the composer the wrong
  // session read the wrong effort (read-only pill blank), folder/branch, running
  // state, AND send target. In normal single-session use paneSession ===
  // activeSession, so this is behavior-neutral there.
  const paneSession = substrateSession ?? activeSession;
  const isInteractive = interactiveRunId !== null;
  const sessionRunning = paneSession.status === 'running';
  const worktreePath = paneSession.worktreePath ?? null;
  const folderLabel =
    worktreePath !== null ? worktreePath.split('/').filter(Boolean).pop() ?? null : null;
  const branchName = hook.gitCommands?.currentBranch ?? null;

  return (
    <div className="flex-1 flex flex-col h-full bg-background">
      {/* Mode-identity strip — constant across SDK / PTY quick sessions. */}
      <ModeIdentityStrip
        name={isInteractive ? 'Terminal' : 'Claude'}
        transport={isInteractive ? 'interactive' : 'sdk'}
        mode="quick"
        running={sessionRunning}
      />

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

      {/* Meta strip — folder · branch · token/context meter, directly above the
          approvals + composer (consolidates the old ClaudeInputWithImages
          context bar). */}
      <ChatMetaStrip
        folderLabel={folderLabel}
        folderTitle={worktreePath}
        branchName={branchName}
        contextUsage={contextUsage}
      />

      {/* Inline permission prompts — surfaces ApprovalRouter approvals directly
          above the input (instead of only in the detached Review Queue). Returns
          null when the session has no run or no pending approval for it. */}
      <PendingApprovalsForRun runId={approvalRunId} className="shrink-0 mx-4 mb-2" />

      {/* Composer — unified across SDK + PTY quick sessions. The interactive
          (PTY) variant routes through API.sessions.sendInput (relayed into the
          live PTY) and is hidden behind ⌃G; the SDK variant uses the
          panel-scoped handlers. The substrate-specific send is owned by
          QuickSessionComposer, never the panel. */}
      {!paneSession.archived && (
        // Demo interactive sessions render the cosmetic composer INSIDE
        // DemoTerminalView (showComposer), so suppress the relay composer here.
        showDemoTerminal ? null : (
          <QuickSessionComposer
            activeSession={paneSession}
            input={hook.input}
            setInput={hook.setInput}
            textareaRef={hook.textareaRef}
            handleSendInput={hook.handleSendInput}
            handleContinueConversation={hook.handleContinueConversation}
            handleStopSession={hook.handleStopSession}
            handleCompactContext={hook.handleCompactContext}
            hasConversationHistory={hook.hasConversationHistory}
            panelId={panel.id}
            interactive={isInteractive}
            ptyOpen={composerOpen}
            onTogglePtyOpen={() => setComposerOpen((v) => !v)}
          />
        )
      )}

      {/* Show archived message if session is archived */}
      {paneSession.archived && (
        <div className="bg-surface-secondary border-t border-border-primary px-4 py-3 text-center text-text-muted text-sm">
          This session is archived. Unarchive it to continue the conversation.
        </div>
      )}

    </div>
  );
});

ClaudePanel.displayName = 'ClaudePanel';

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
