import { useCallback, useEffect, useState } from 'react';
import type { Session } from '../../../types/session';
import { API } from '../../../utils/api';
import type { IPCResponse } from '../../../utils/api';
import { CommitModePill } from '../../CommitModeToggle';
import { ModelPill, isOpusModel, modelDisplayLabel } from './ModelPill';
import { FastModePill } from './FastModePill';
import { PermissionModePill } from './PermissionModePill';
import { McpTogglePill } from './McpTogglePill';
import { PluginTogglePill } from './PluginTogglePill';
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
  /** panel id — used to read the session's (read-only) model for display. */
  panelId?: string;
  /** interactive (PTY) quick session: composer is ⌃G-revealed. */
  interactive: boolean;
  ptyOpen?: boolean;
  onTogglePtyOpen?: () => void;
}

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
  // The Opus-only fast-mode opt-in lives there too (persisted at launch); read it
  // so the composer toggle reflects the launch choice.
  const [modelId, setModelId] = useState<string | null>(null);
  const [fastMode, setFastMode] = useState(false);
  useEffect(() => {
    if (interactive || !panelId) {
      setModelId(null);
      setFastMode(false);
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
    API.claudePanels
      .getFastMode(panelId)
      .then((res) => {
        if (!cancelled && res.success && typeof res.data === 'boolean') setFastMode(res.data);
      })
      .catch(() => {
        /* non-fatal: fast toggle stays off */
      });
    return () => {
      cancelled = true;
    };
  }, [interactive, panelId]);

  // Switching away from Opus drops fast mode (it is Opus-only; the spawn seam
  // threads the persisted value ungated, so we never leave it true off-Opus).
  const handleModelChange = useCallback(
    (model: string) => {
      setModelId(model);
      if (!isOpusModel(model) && fastMode && panelId) {
        setFastMode(false);
        void API.claudePanels.setFastMode(panelId, false);
      }
    },
    [fastMode, panelId],
  );

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

  const modelLabel = interactive ? null : modelId ? modelDisplayLabel(modelId) : null;

  // Interactive model selector for an IDLE quick SDK session — replaces the
  // read-only "Sonnet 🔒" pill. While running, fall through to the read-only
  // modelLabel pill (a model change only takes effect on the next turn, and the
  // in-flight turn already chose its model). PTY/flow runs never get this.
  const modelSlot =
    !interactive && !running && panelId ? (
      <ModelPill panelId={panelId} currentModel={modelId} onModelChange={handleModelChange} />
    ) : undefined;

  // Opus-only fast-mode toggle, next to the checkpoint pill. Mirrors the model
  // pill's mounting (idle quick SDK only) and is shown only while Opus is the
  // selected model — fast mode has no effect on other models.
  const fastModeSlot =
    !interactive && !running && panelId && isOpusModel(modelId) ? (
      <FastModePill panelId={panelId} fastMode={fastMode} onChange={setFastMode} />
    ) : undefined;

  // Interactive agent-permission selector for an IDLE quick SDK session, next to
  // the model pill. Persists to sessions.agent_permission_mode (next-turn apply)
  // and mirrors the change into the session store for an instant label refresh.
  const permissionSlot =
    !interactive && !running ? (
      <PermissionModePill
        sessionId={activeSession.id}
        currentMode={activeSession.agentPermissionMode ?? 'default'}
        onModeChange={(mode) => updateSession({ ...activeSession, agentPermissionMode: mode })}
      />
    ) : undefined;

  // Multi-select MCP / plugin selectors for an IDLE quick SDK session, next to
  // the permission pill. The MCP pill shows servers enabled-by-default and
  // persists the unchecked COMPLEMENT to sessions.disabled_mcp_servers_json (a
  // DENY set); the plugin pill persists the checked set to enabled_plugins_json
  // (an ALLOW set). Both are read at SDK spawn (next-turn apply) and mirrored
  // into the session store here for an instant label refresh.
  const mcpSlot =
    !interactive && !running ? (
      <McpTogglePill
        sessionId={activeSession.id}
        disabled={activeSession.disabledMcpServers ?? []}
        onChange={(disabledMcpServers) =>
          updateSession({ ...activeSession, disabledMcpServers })
        }
      />
    ) : undefined;

  const pluginSlot =
    !interactive && !running ? (
      <PluginTogglePill
        sessionId={activeSession.id}
        selected={activeSession.enabledPlugins ?? []}
        onChange={(enabledPlugins) => updateSession({ ...activeSession, enabledPlugins })}
      />
    ) : undefined;

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
      modelSlot={modelSlot}
      permissionSlot={permissionSlot}
      mcpSlot={mcpSlot}
      pluginSlot={pluginSlot}
      effortLabel={effortLabel}
      checkpointSlot={checkpointSlot}
      fastSlot={fastModeSlot}
      compactSlot={compactSlot}
    />
  );
}
