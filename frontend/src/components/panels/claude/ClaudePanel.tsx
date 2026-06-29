import React, { useState, useEffect } from 'react';
import { AIPanelProps } from '../ai/AbstractAIPanel';
import { useClaudePanel } from '../../../hooks/useClaudePanel';
import { useConfigStore } from '../../../stores/configStore';
import type { ClaudePanelState } from '../../../../../shared/types/panels';
import { PendingApprovalsForRun } from '../../ReviewQueue/PendingApprovalsForRun';
import { useSession } from '../../../contexts/SessionContext';
import { useSessionStore } from '../../../stores/sessionStore';
import { InteractiveTerminalView } from '../../cyboflow/InteractiveTerminalView';
import { ResumeSessionPrompt } from '../../cyboflow/ResumeSessionPrompt';
import { DemoTerminalView } from '../../cyboflow/DemoTerminalView';
import { API } from '../../../utils/api';
import { QuickSessionComposer } from '../../cyboflow/unified/QuickSessionComposer';
import { UnifiedChatView } from '../../cyboflow/unified/UnifiedChatView';
import { useUnifiedPanelMessages } from '../../cyboflow/unified/useUnifiedPanelMessages';
import { SessionActionToast } from '../../cyboflow/SessionActionToast';

// Sessions whose open-time resume prompt the user explicitly declined ("Start
// fresh") this app run. Module-level so the decision survives ClaudePanel
// remounts (e.g. switching sessions and back) — without it the probe would
// re-offer resume every remount until the user finally sends a message.
const declinedResumeSessions = new Set<string>();

/** Test-only: clear the module-level declined-resume memory between cases. */
export function __resetDeclinedResumeForTests(): void {
  declinedResumeSessions.clear();
}

/**
 * ClaudePanel — quick-session host for the shared <UnifiedChatView>.
 *
 * Renders the SAME chat surface a workflow run renders (RunChatView): the SDK
 * substrate feeds the structured transcript from `useUnifiedPanelMessages`
 * (panel-scoped `getJsonMessages` + live `session-output-available`), and the
 * interactive (PTY) substrate swaps in the live xterm as the `interactiveBody`.
 * This file owns only the quick-session-specific wiring: the substrate render
 * gate, the open-time REPL resume recovery, the ⌃G composer reveal, and the
 * bottom region (approvals + the unified composer + permission toast).
 */
export const ClaudePanel: React.FC<AIPanelProps> = React.memo(({ panel, isActive }) => {
  const hook = useClaudePanel(panel.id, isActive);
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
  // the SDK structured transcript. Session resolution mirrors approvalRunId —
  // prefer the SessionProvider's freshly-fetched session, fall back to the store
  // copy keyed by the panel's sessionId.
  const panelStoreSession = useSessionStore((state) =>
    state.sessions.find((s) => s.id === panel.sessionId),
  );
  const substrateSession = sessionCtx?.session ?? panelStoreSession;
  const interactiveRunId =
    substrateSession?.substrate === 'interactive' ? substrateSession.runId ?? null : null;
  // Demo mode: an interactive quick session is stamped 'interactive' so this
  // panel swaps in a terminal surface, but the real PTY is never spawned
  // (ipc/session.ts). Render the canned DemoTerminalView instead of the live
  // InteractiveTerminalView (which would subscribe to an empty pty channel).
  const demoModeEnabled = useConfigStore((state) => state.config?.demoMode ?? false);
  const showDemoTerminal = demoModeEnabled && interactiveRunId !== null;

  // Interactive quick sessions are driven by typing DIRECTLY into the live PTY
  // terminal above, so the separate "Message the live session" composer is
  // redundant and is hidden by default. Ctrl+G summons it for rich multi-line
  // text entry. Captured at the window level (capture phase) so the keystroke
  // toggles the composer instead of reaching xterm as a BEL (\x07).
  const [composerOpen, setComposerOpen] = useState(false);
  // Substrate-aware confirmation for a permission-mode change from the composer
  // pill, co-located with the composer that triggers it.
  const [permissionToast, setPermissionToast] = useState<string | null>(null);

  // Open-time resume recovery for a lost interactive (PTY) quick session. After
  // an app restart the persistent REPL is gone but the prior conversation can be
  // resumed (sessions.claude_session_id + claude's on-disk transcript survive).
  const [resumePromptDismissed, setResumePromptDismissed] = useState(false);
  const [resumeArmed, setResumeArmed] = useState(false);
  const [canOfferResume, setCanOfferResume] = useState(false);

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
  // land in the rich text box instead of the live PTY terminal.
  useEffect(() => {
    if (!composerOpen) return;
    const id = requestAnimationFrame(() => hook.textareaRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [composerOpen, hook.textareaRef]);

  // Probe resume eligibility once per interactive quick session (skip demo, whose
  // REPL is never real). Resumable = REPL not live + a stored claude_session_id +
  // the worktree still on disk. Resets cleanly when the panel's session changes.
  useEffect(() => {
    const sessionId = panel.sessionId;
    setResumePromptDismissed(false);
    setResumeArmed(false);
    setCanOfferResume(false);
    if (interactiveRunId === null || showDemoTerminal || !sessionId) return;
    // The user already chose "Start fresh" for this session this app run — don't
    // re-offer until the REPL is live again (a new loss episode).
    if (declinedResumeSessions.has(sessionId)) return;
    let cancelled = false;
    void API.sessions
      .getInteractiveResumeState(sessionId)
      .then((res) => {
        if (cancelled) return;
        const data = res?.data;
        if (res?.success && data && !data.replRunning && data.claudeSessionId && data.worktreeExists) {
          setCanOfferResume(true);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [panel.sessionId, interactiveRunId, showDemoTerminal]);

  // The "Resuming…" hint is a transient cue shown while claude reopens the prior
  // conversation. Auto-clear it so it never sticks forever.
  useEffect(() => {
    if (!resumeArmed) return;
    const id = setTimeout(() => setResumeArmed(false), 12_000);
    return () => clearTimeout(id);
  }, [resumeArmed]);

  // "Resume previous session" → EAGERLY re-spawn the REPL (`--resume <uuid>`,
  // server-side) so the prior conversation reopens live immediately. Also DISMISS
  // the prompt for this mount: the probe never re-runs for a quick session (its
  // sentinel runId is constant), so canOfferResume stays stale-true and the
  // prompt would re-pop once the "Resuming…" hint clears.
  const handleResumeSession = (): void => {
    setResumeArmed(true);
    setResumePromptDismissed(true);
    void API.sessions.resumeInteractive(panel.sessionId).catch(() => undefined);
  };

  // "Start fresh" (or Escape) → decline: remember the choice and hide the prompt.
  const handleDeclineResume = (): void => {
    setResumePromptDismissed(true);
    declinedResumeSessions.add(panel.sessionId);
  };

  const claudePanelState = (panel.state.customState as ClaudePanelState | undefined) ?? {};
  // SDK substrate emits a "54k/200k tokens (27%)" string; null for PTY/empty.
  const contextUsage = claudePanelState.contextUsage ?? null;

  // Extract and store slash commands when we get JSON messages with init.
  useEffect(() => {
    if (!activeSession) return;
    const jsonMessages = activeSession.jsonMessages || [];
    const initMessage = jsonMessages.find(
      (msg: { type?: string; subtype?: string; slash_commands?: string[] }) =>
        msg.type === 'system' && msg.subtype === 'init' && msg.slash_commands,
    );
    if (initMessage && Array.isArray(initMessage.slash_commands)) {
      try {
        const slashCommandsKey = `slashCommands_${activeSession.id}`;
        localStorage.setItem(slashCommandsKey, JSON.stringify(initMessage.slash_commands));
      } catch (e) {
        console.warn('[slash-debug] Failed to store slash commands for Cyboflow session:', e);
      }
    }
  }, [activeSession?.jsonMessages, activeSession?.id]);

  // Unified-chat chrome derivations for this quick session. Use the PANE's own
  // session (substrateSession), falling back to the global activeSession only
  // when neither context nor store copy is present — the global store
  // activeSession can point at a different / lagging session than this panel.
  const paneSession = substrateSession ?? activeSession;
  const isInteractive = interactiveRunId !== null;

  // SDK structured transcript source (panel-scoped). Disabled on the interactive
  // substrate, whose live xterm owns the conversation surface.
  const { messages, loadError } = useUnifiedPanelMessages(panel.id, !isInteractive);

  if (!activeSession || !paneSession) {
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

  const sessionRunning = paneSession.status === 'running';
  const worktreePath = paneSession.worktreePath ?? null;
  const folderLabel =
    worktreePath !== null ? worktreePath.split('/').filter(Boolean).pop() ?? null : null;
  const branchName = hook.gitCommands?.currentBranch ?? null;

  // Interactive (PTY) substrate body — the live xterm (+ open-time resume
  // recovery overlay). guardFirstInteraction={false}: quick sessions are
  // user-driven, so direct typing into the terminal is the expected interaction.
  const interactiveBody =
    interactiveRunId !== null ? (
      <div className="flex-1 overflow-hidden relative h-full" data-testid="claude-panel-interactive-terminal">
        {showDemoTerminal ? (
          <DemoTerminalView showComposer />
        ) : (
          <InteractiveTerminalView runId={interactiveRunId} guardFirstInteraction={false} />
        )}
        {/* Open-time recovery: offer to resume the lost REPL's conversation. */}
        {!showDemoTerminal && (
          <ResumeSessionPrompt
            isOpen={canOfferResume && !resumePromptDismissed && !resumeArmed}
            onClose={handleDeclineResume}
            onResume={handleResumeSession}
            onStartFresh={handleDeclineResume}
          />
        )}
        {/* Transient cue while claude reopens the prior conversation. */}
        {resumeArmed && (
          <div
            className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded border border-interactive/40 bg-surface-secondary px-3 py-1.5 text-[11px] text-text-secondary shadow-sm"
            data-testid="resume-restored-hint"
          >
            Resuming previous session — your conversation will reappear below.
          </div>
        )}
      </div>
    ) : undefined;

  // Bottom region — approvals + the unified composer + permission toast +
  // archived banner. The composer's substrate-specific send is owned by
  // QuickSessionComposer; demo interactive sessions render their own cosmetic
  // composer inside DemoTerminalView, so suppress the relay composer there.
  const bottomSlot = (
    <>
      {/* Inline permission prompts — surfaces ApprovalRouter approvals directly
          above the input. Returns null when there is no pending approval. */}
      <PendingApprovalsForRun runId={approvalRunId} className="shrink-0 mx-4 mb-2" />

      {!paneSession.archived &&
        (showDemoTerminal ? null : (
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
            onPermissionApplied={setPermissionToast}
          />
        ))}

      {/* Permission-change confirmation — substrate-aware copy supplied by the
          composer. Positioned above the composer; auto-dismisses. */}
      {permissionToast !== null && (
        <div className="pointer-events-none absolute bottom-24 left-1/2 z-20 -translate-x-1/2">
          <div className="pointer-events-auto">
            <SessionActionToast
              message={permissionToast}
              isVisible={permissionToast !== null}
              onDismiss={() => setPermissionToast(null)}
            />
          </div>
        </div>
      )}

      {paneSession.archived && (
        <div className="bg-surface-secondary border-t border-border-primary px-4 py-3 text-center text-text-muted text-sm">
          This session is archived. Unarchive it to continue the conversation.
        </div>
      )}
    </>
  );

  return (
    <div className="relative flex-1 flex flex-col h-full bg-background">
      <UnifiedChatView
        name={isInteractive ? 'Terminal' : 'Claude'}
        transport={isInteractive ? 'interactive' : 'sdk'}
        mode="quick"
        running={sessionRunning}
        messages={messages}
        loadError={loadError}
        isWaitingForResponse={sessionRunning}
        folderLabel={folderLabel}
        folderTitle={worktreePath}
        branchName={branchName}
        contextUsage={contextUsage}
        railId={panel.id}
        interactiveBody={interactiveBody}
        bottomSlot={bottomSlot}
      />
    </div>
  );
});

ClaudePanel.displayName = 'ClaudePanel';

// Default export for lazy loading
export default ClaudePanel;
