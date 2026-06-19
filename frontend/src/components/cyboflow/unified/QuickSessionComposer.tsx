import { useCallback, useEffect, useState } from 'react';
import type { Session } from '../../../types/session';
import { API } from '../../../utils/api';
import type { IPCResponse } from '../../../utils/api';
import { CommitModePill } from '../../CommitModeToggle';
import { useSessionStore } from '../../../stores/sessionStore';
import { UnifiedComposer } from './UnifiedComposer';
import { resolveChatVisibility } from './useChatVisibility';
import type { AttachedImage, AttachedText, ComposerAttachments } from './attachments';

/**
 * QuickSessionComposer — the panel-host adapter for the unified composer.
 *
 * Wraps <UnifiedComposer> with the quick-session send wiring, replacing both the
 * Crystal-era ClaudeInputWithImages (SDK) and the inline InteractiveSessionComposer
 * (PTY) that ClaudePanel used to branch between. The composer UI is now identical
 * to the run chat.
 *
 * Send transport (substrate-specific, behind one Send button):
 *  - SDK : panel-scoped handleSendInput (status 'waiting') / handleContinueConversation,
 *          which read the shared `input` (so the composer is controlled by it).
 *  - PTY : API.sessions.sendInput → relayed into the live PTY server-side.
 */
export interface QuickSessionComposerProps {
  activeSession: Session;
  /** controlled draft text from useClaudePanel. */
  input: string;
  setInput: (v: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** SDK send handlers (panel-scoped). */
  handleSendInput: (images?: AttachedImage[], texts?: AttachedText[]) => void;
  handleContinueConversation: (
    images?: AttachedImage[],
    texts?: AttachedText[],
    modelOverride?: string,
  ) => void;
  handleStopSession?: () => void;
  handleCompactContext?: () => void;
  hasConversationHistory?: boolean;
  /** toggle the ClaudeSettingsPanel (⚙). */
  onToggleSettings: () => void;
  /** panel id — used to read the session's (read-only) model for display. */
  panelId?: string;
  /** interactive (PTY) quick session: composer is ⌃G-revealed. */
  interactive: boolean;
  ptyOpen?: boolean;
  onTogglePtyOpen?: () => void;
}

const MODEL_LABELS: Record<string, string> = {
  auto: 'Auto',
  sonnet: 'Sonnet',
  opus: 'Opus',
  haiku: 'Haiku',
};

export function QuickSessionComposer(props: QuickSessionComposerProps): React.ReactElement {
  const {
    activeSession,
    input,
    setInput,
    textareaRef,
    handleSendInput,
    handleContinueConversation,
    handleStopSession,
    handleCompactContext,
    hasConversationHistory,
    onToggleSettings,
    panelId,
    interactive,
    ptyOpen = false,
    onTogglePtyOpen,
  } = props;

  const transport = interactive ? 'interactive' : 'sdk';
  const running = activeSession.status === 'running';
  const updateSession = useSessionStore((s) => s.updateSession);

  // Read-only model display (set at session start; mid-session change deferred).
  // The model lives on the panel settings, not the Session row, so we fetch it.
  const [modelId, setModelId] = useState<string | null>(null);
  useEffect(() => {
    if (interactive || !panelId) {
      setModelId(null);
      return;
    }
    let cancelled = false;
    API.claudePanels
      .getModel(panelId)
      .then((res) => {
        if (!cancelled && res.success && typeof res.data === 'string') setModelId(res.data);
      })
      .catch(() => {
        /* non-fatal: no model pill */
      });
    return () => {
      cancelled = true;
    };
  }, [interactive, panelId]);

  const visibility = resolveChatVisibility({
    transport,
    mode: 'quick',
    running,
    ptyOpen,
  });

  const onSubmit = useCallback(
    async (atts: ComposerAttachments) => {
      if (interactive) {
        const result: IPCResponse<void> = await API.sessions.sendInput(activeSession.id, input);
        if (result.success) setInput('');
        return;
      }
      // SDK: the handlers read the shared `input` and clear it themselves.
      if (activeSession.status === 'waiting') {
        handleSendInput(atts.images, atts.texts);
      } else {
        handleContinueConversation(atts.images, atts.texts, modelId ?? undefined);
      }
    },
    [interactive, activeSession.id, activeSession.status, modelId, input, setInput, handleSendInput, handleContinueConversation],
  );

  const effectiveMode =
    activeSession.commitMode ?? (activeSession.autoCommit === false ? 'disabled' : 'checkpoint');
  const isAutoCommitEnabled = effectiveMode !== 'disabled';

  const placeholder = interactive
    ? 'Message the live session…  (⌘↵ to send)'
    : activeSession.status === 'waiting'
      ? 'Enter your response…  (⌘↵ to send)'
      : 'Write a command…  (⌘↵ to send)';

  const modelLabel = interactive
    ? null
    : modelId
      ? MODEL_LABELS[modelId] ?? modelId
      : null;

  // Read-only effort pill (set at session start; migration 029). Today the only
  // value is 'ultracode' — an interactive-only opt-in, so it shows on the PTY
  // composer (where the SDK-gated model pill never appears). null → no pill.
  const effortLabel = activeSession.effort === 'ultracode' ? 'ultracode' : null;

  const checkpointSlot = !interactive ? (
    <CommitModePill
      sessionId={activeSession.id}
      currentMode={activeSession.commitMode}
      currentSettings={activeSession.commitModeSettings}
      autoCommit={activeSession.autoCommit}
      projectId={activeSession.projectId}
      isAutoCommitEnabled={isAutoCommitEnabled}
      // The pill persists the change itself (commit-mode:update-session-settings);
      // mirror it into the session store so the pill label reflects it immediately
      // instead of staying stale until the session is re-fetched.
      onModeChange={(mode, settings) =>
        updateSession({
          ...activeSession,
          commitMode: mode,
          commitModeSettings: JSON.stringify(settings),
        })
      }
    />
  ) : undefined;

  const compactSlot =
    !interactive && handleCompactContext && hasConversationHistory ? (
      <button
        type="button"
        onClick={handleCompactContext}
        disabled={running || activeSession.status === 'initializing'}
        title="Generate a summary of the conversation to continue in a fresh context window"
        className="inline-flex items-center border border-border-primary bg-surface-primary px-2.5 py-1.5 text-[10px] text-text-secondary transition-colors hover:border-border-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        Compact context
      </button>
    ) : undefined;

  return (
    <UnifiedComposer
      visibility={visibility}
      running={running}
      value={input}
      onChange={setInput}
      textareaRef={textareaRef}
      sessionId={activeSession.id}
      placeholder={placeholder}
      primaryLabel="Send"
      onSubmit={onSubmit}
      // Stop is an SDK-generation affordance; a live PTY REPL is always "running"
      // and is interrupted by typing into the terminal, not a composer Stop.
      onStop={!interactive && running ? handleStopSession : undefined}
      onTogglePtyOpen={interactive ? onTogglePtyOpen : undefined}
      supportsAttachments={!interactive}
      modelLabel={modelLabel}
      effortLabel={effortLabel}
      onToggleSettings={!interactive ? onToggleSettings : undefined}
      checkpointSlot={checkpointSlot}
      compactSlot={compactSlot}
    />
  );
}
