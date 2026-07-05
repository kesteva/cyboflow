import { useCallback, useEffect, useState } from 'react';
import type { Session } from '../../../types/session';
import { API } from '../../../utils/api';
import { usePendingSendStore } from '../../../stores/pendingSendStore';
import { CommitModePill } from '../../CommitModeToggle';
import { ModelPill, isOpusModel, modelDisplayLabel, MODEL_OPTIONS } from './ModelPill';
import { FastModePill } from './FastModePill';
import { PermissionModePill } from './PermissionModePill';
import { useSessionStore } from '../../../stores/sessionStore';
import { UnifiedComposer } from './UnifiedComposer';
import { resolveChatVisibility } from './useChatVisibility';
import type { AttachedImage, AttachedText, ComposerAttachments } from './attachments';
import type { FastModeStateNotice } from '../../../../../shared/types/panels';

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
  /** SDK send handlers (panel-scoped). Take the message text explicitly and
   *  RETURN the dispatch outcome so the composer can settle its pending-send
   *  entry (the composer owns clearing the draft, not these). */
  handleSendInput: (
    text: string,
    images?: AttachedImage[],
    texts?: AttachedText[],
  ) => Promise<{ success: boolean; error?: string }>;
  handleContinueConversation: (
    text: string,
    images?: AttachedImage[],
    texts?: AttachedText[],
    modelOverride?: string,
  ) => Promise<{ success: boolean; error?: string }>;
  handleStopSession?: () => void;
  handleCompactContext?: () => void;
  hasConversationHistory?: boolean;
  /** panel id — used to read the session's (read-only) model for display. */
  panelId?: string;
  /** interactive (PTY) quick session: composer is ⌃G-revealed. */
  interactive: boolean;
  ptyOpen?: boolean;
  onTogglePtyOpen?: () => void;
  /**
   * Surface a confirmation after a permission-mode change. The host (ClaudePanel)
   * shows a toast; the message is substrate/running-aware (SDK applies on the next
   * message, interactive PTY applies when the terminal restarts).
   */
  onPermissionApplied?: (message: string) => void;
  /**
   * Surface a notice when this session's turn fell back off a pulled model (e.g.
   * Fable 5 → Opus) mid-call. The host shows it in the same toast slot.
   */
  onModelFallback?: (message: string) => void;
  /**
   * Surface a notice when a turn REQUESTED fast mode but the CLI declined it
   * (entitlement / cooldown — see FastModePill). Same toast slot as the above.
   * Naturally one-off: the main process only pushes fast-mode-state CHANGES.
   */
  onFastModeDeclined?: (message: string) => void;
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
    onPermissionApplied,
    onModelFallback,
    onFastModeDeclined,
  } = props;

  const transport = interactive ? 'interactive' : 'sdk';
  const running = activeSession.status === 'running';
  const updateSession = useSessionStore((s) => s.updateSession);

  // Pending-send (optimistic echo). Keyed by the panel id — the same key the host
  // (ClaudePanel) uses as railId and reconciles against the transcript.
  const hostKey = panelId ?? activeSession.id;
  const addPending = usePendingSendStore((s) => s.addPending);
  const setPendingStatus = usePendingSendStore((s) => s.setStatus);
  const draftRequest = usePendingSendStore((s) => s.draftRequest[hostKey]);
  const clearDraftRequest = usePendingSendStore((s) => s.clearDraftRequest);

  // Reopen a queued/failed pending row: the store stages its text here; pull it
  // back into the composer draft, then ack so a later reopen of identical text
  // fires again (nonce-keyed).
  useEffect(() => {
    if (!draftRequest) return;
    setInput(draftRequest.text);
    clearDraftRequest(hostKey);
    textareaRef.current?.focus();
  }, [draftRequest, hostKey, setInput, clearDraftRequest, textareaRef]);

  // Read-only model display (set at session start; mid-session change deferred).
  // The model lives on the panel settings, not the Session row, so we fetch it.
  // The Opus-only fast-mode opt-in lives there too (persisted at launch); read it
  // so the composer toggle reflects the launch choice.
  const [modelId, setModelId] = useState<string | null>(null);
  const [fastMode, setFastMode] = useState(false);
  // Latest CLI-reported fast-mode state (ground truth vs the request toggle) —
  // snapshot on mount, then live per-turn pushes. Lets the Fast pill warn when
  // the opt-in was declined (entitlement / cooldown) instead of lying.
  const [fastModeReport, setFastModeReport] = useState<FastModeStateNotice | null>(null);
  useEffect(() => {
    if (interactive || !panelId) {
      setModelId(null);
      setFastMode(false);
      setFastModeReport(null);
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
    API.claudePanels
      .getFastModeState(panelId)
      .then((res) => {
        if (!cancelled && res.success) setFastModeReport(res.data ?? null);
      })
      .catch(() => {
        /* non-fatal: pill just can't warn */
      });
    return () => {
      cancelled = true;
    };
  }, [interactive, panelId]);

  // Live per-turn fast-mode pushes. A decline (a turn that REQUESTED fast mode
  // reporting anything but 'on') additionally raises a one-off toast — one-off
  // because the main process only emits on state change, so a run of declined
  // turns produces a single push. The mount-time snapshot above never toasts.
  useEffect(() => {
    if (interactive || !panelId) return;
    const unsubscribe = API.claudePanels.onFastModeState((notice) => {
      if (notice.panelId !== panelId) return;
      setFastModeReport(notice);
      if (notice.requestedFast && notice.state !== 'on') {
        onFastModeDeclined?.(
          notice.state === 'cooldown'
            ? 'Fast mode is cooling down after a rate limit — this turn ran at standard speed.'
            : "Fast mode isn't available on this account — it may need extra usage enabled. This turn ran at standard speed.",
        );
      }
    });
    return unsubscribe;
  }, [interactive, panelId, onFastModeDeclined]);

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

  // A turn that discovered its pinned model was pulled mid-call (e.g. Fable 5)
  // retries transparently on the fallback family (Opus). Reflect that swap in the
  // pill — persist the fallback alias so it sticks past a remount, update the
  // local display, and raise a one-off toast. Filtered to THIS panel's runs.
  useEffect(() => {
    if (interactive || !panelId) return;
    const unsubscribe = API.models.onModelFallback((notice) => {
      if (notice.panelId !== panelId) return;
      void API.claudePanels.setModel(panelId, notice.fallbackAlias);
      handleModelChange(notice.fallbackAlias);
      const fallbackLabel =
        MODEL_OPTIONS.find((o) => o.id === notice.fallbackAlias)?.label ?? notice.fallbackAlias;
      onModelFallback?.(
        `${notice.unavailableLabel} is unavailable — switched to ${fallbackLabel} for this run.`,
      );
    });
    return unsubscribe;
  }, [interactive, panelId, handleModelChange, onModelFallback]);

  const visibility = resolveChatVisibility({
    transport,
    mode: 'quick',
    running,
    ptyOpen,
  });

  // The send NEVER gates the composer's busy state: we push a pending-send entry
  // (the in-chat "sending" indication), clear the input INSTANTLY, and let the
  // dispatch promise settle only the entry's fate (reconciled away when the real
  // turn lands, or flipped to 'failed' on rejection). onSubmit returns without
  // awaiting the turn, so the composer is immediately ready for the next message.
  const onSubmit = useCallback(
    (atts: ComposerAttachments) => {
      const text = input;
      if (!text.trim()) return;
      // Interactive (PTY) relay: the live xterm IS the transcript, so there is no
      // structured user turn to reconcile against and no pending row is rendered
      // (ClaudePanel passes pendingSends=undefined for the interactive substrate).
      // Clear instantly; on the rare relay failure restore the draft — unlike the
      // SDK path there is no transcript echo, so restoring can't double-render.
      if (interactive) {
        setInput('');
        void API.sessions
          .sendInput(activeSession.id, text)
          .then((result) => {
            if (!result.success) setInput(text);
          })
          .catch(() => setInput(text));
        return;
      }
      // SDK, mid-turn: the run is RUNNING, so continuing would destructively abort
      // the in-flight turn. Instead QUEUE the message (buffered server-side,
      // delivered at the turn's rest boundary) and show a distinct 'queued' row.
      // The pending-send id is threaded as the queue entry id so click-to-reopen
      // can dequeue it precisely.
      if (running && panelId) {
        setInput('');
        const id = addPending(hostKey, text, 'queued');
        void API.panels
          .queueInput(panelId, id, text)
          .then((res) => {
            if (!res.success || res.data?.queued !== true) setPendingStatus(hostKey, id, 'failed');
          })
          .catch(() => setPendingStatus(hostKey, id, 'failed'));
        return;
      }

      // SDK, idle: dispatch via the panel handlers, which return the outcome.
      setInput('');
      const id = addPending(hostKey, text, 'sending');
      const dispatch =
        activeSession.status === 'waiting'
          ? handleSendInput(text, atts.images, atts.texts)
          : handleContinueConversation(text, atts.images, atts.texts, modelId ?? undefined);
      // Promise.resolve tolerates a non-promise return (e.g. a test stub);
      // `res && res.success === false` only flips on an explicit failure result.
      void Promise.resolve(dispatch)
        .then((res) => {
          if (res && res.success === false) setPendingStatus(hostKey, id, 'failed');
        })
        .catch(() => setPendingStatus(hostKey, id, 'failed'));
    },
    [
      interactive,
      activeSession.id,
      activeSession.status,
      running,
      panelId,
      modelId,
      input,
      setInput,
      hostKey,
      addPending,
      setPendingStatus,
      handleSendInput,
      handleContinueConversation,
    ],
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
      <FastModePill panelId={panelId} fastMode={fastMode} onChange={setFastMode} report={fastModeReport} />
    ) : undefined;

  // Agent-permission selector, next to the model pill. Persists to
  // sessions.agent_permission_mode and mirrors the change into the session store
  // for an instant label refresh. It renders for BOTH substrates and regardless
  // of running state, but the apply-timing differs and the copy is honest:
  //  - SDK (idle OR running): resolveSessionAgentPermissionMode re-reads the DB
  //    row on every spawn, so the change applies on the NEXT message (the
  //    in-flight turn already chose its gating). Status-independent → safe while
  //    running.
  //  - interactive PTY: the .claude/settings.json hook is read by `claude` only
  //    at spawn, so a live change applies when the terminal RESTARTS, never the
  //    next message. The IPC handler primes the file for the next spawn.
  const permissionTitle = interactive
    ? 'Agent permission — applies when the terminal restarts'
    : running
      ? 'Agent permission — applies on your next message (not the in-flight turn)'
      : 'Agent permission — applies on your next message';
  const permissionAppliedMessage = interactive
    ? 'Permission mode updated — applies when the terminal restarts'
    : 'Permission mode updated — applies on your next message';
  const permissionSlot = (
    <PermissionModePill
      currentMode={activeSession.agentPermissionMode ?? 'default'}
      persist={(mode) => API.sessions.updateAgentPermissionMode(activeSession.id, mode)}
      onModeChange={(mode) => updateSession({ ...activeSession, agentPermissionMode: mode })}
      onApplied={onPermissionApplied ? (_mode, message) => onPermissionApplied(message) : undefined}
      appliedMessage={permissionAppliedMessage}
      title={permissionTitle}
    />
  );

  // MCP / plugin selection is a SESSION-START decision now (the launch wizard's
  // Advanced section), not a mid-conversation toggle — a quick SDK session
  // spawns its MCP config once and the deny-list is enforced at spawn, so a
  // mid-turn pill was confusing (and the disabled server leaked back in via the
  // CLI's settingSources auto-load). The composer no longer carries MCP/plugin
  // pills; they live on the wizard only.

  // Read-only effort pill (set at session start; migration 029). Today the only
  // value is 'ultracode' — an interactive-only opt-in, so it shows on the PTY
  // composer (where the SDK-gated model pill never appears). null → no pill.
  const effortLabel = activeSession.effort === 'ultracode' ? 'ultracode' : null;

  // No commit-mode pill for in-place sessions: they share the user's real
  // checkout, so auto/structured commits are unavailable (creation forces
  // 'disabled' and the commit-mode IPC rejects changes — hiding the pill keeps
  // the UI from promising modes the backend refuses).
  const checkpointSlot = !interactive && activeSession.inPlace !== true ? (
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
      effortLabel={effortLabel}
      checkpointSlot={checkpointSlot}
      fastSlot={fastModeSlot}
      compactSlot={compactSlot}
    />
  );
}
