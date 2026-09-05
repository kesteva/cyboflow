import { useCallback, useEffect, useState } from 'react';
import type { Session } from '../../../types/session';
import { API } from '../../../utils/api';
import { usePendingSendStore } from '../../../stores/pendingSendStore';
import { useComposerFocusRequest } from '../../../stores/composerFocusStore';
import { errorText } from '../../../utils/errorText';
import { kbdHint } from '../../../utils/platform';
import { ModelPill, isOpusModel, modelDisplayLabel, MODEL_OPTIONS } from './ModelPill';
import { FastModePill } from './FastModePill';
import { EffortPill } from './EffortPill';
import { PermissionModePill } from './PermissionModePill';
import { useSessionStore } from '../../../stores/sessionStore';
import { UnifiedComposer } from './UnifiedComposer';
import { resolveChatVisibility } from './useChatVisibility';
import type { AttachedImage, AttachedText, ComposerAttachments } from './attachments';
import type { FastModeStateNotice } from '../../../../../shared/types/panels';
import { providerForRuntimeValue } from '../../../../../shared/types/agentRuntime';
import type { ReasoningEffort } from '../../../../../shared/types/reasoningEffort';
import type { Question } from '../../../../../shared/types/questions';
import { useQuestionStore } from '../../../stores/questionStore';
import { trpc } from '../../../trpc/client';

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
    /** abort the in-flight turn and drive this message now (Interrupt & send). */
    interrupt?: boolean,
    /** client pending-send id, so a status-flap queue fallback is addressable. */
    pendingId?: string,
  ) => Promise<{ success: boolean; error?: string; queued?: boolean }>;
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
   * Fable 5.1 → Opus) mid-call. The host shows it in the same toast slot.
   */
  onModelFallback?: (message: string) => void;
  /**
   * Surface a notice when a turn REQUESTED fast mode but the CLI declined it
   * (entitlement / cooldown — see FastModePill). Same toast slot as the above.
   * Naturally one-off: the main process only pushes fast-mode-state CHANGES.
   */
  onFastModeDeclined?: (message: string) => void;
  /**
   * The oldest pending AskUserQuestion gate for this session (keyed on the
   * __quick__ chat_run_id sentinel), or null. While a gate is open the composer
   * send ANSWERS it instead of continuing the conversation — the turn is parked
   * inside the question hook, so a continue would either destructively abort it
   * or starve on the claude-continue lock the parked turn is holding.
   */
  activeQuestion?: Question | null;
  /**
   * Host-computed turn-in-flight signal (`sessionRunning || live-tail
   * isGenerating`). The composer uses this as its authoritative running state
   * for the Stop / Queue / Interrupt affordances — `activeSession.status` alone
   * is unreliable for quick SDK turns (the backend does not always flip it to
   * 'running' while the SDK streams, so a genuinely generating turn would show
   * no Stop button). Deliberately EXCLUDES the optimistic 'sending' pending row
   * (which can stick after the turn ends and freeze Stop ON). Undefined falls
   * back to the status check.
   */
  working?: boolean;
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
    activeQuestion = null,
    working,
  } = props;

  const transport = interactive ? 'interactive' : 'sdk';
  const agentProvider =
    activeSession.agentProvider ?? providerForRuntimeValue(activeSession.agentRuntime);
  // `running` is the AUTHORITATIVE, self-clearing turn-in-flight signal. The host
  // (ClaudePanel) supplies it as `working` = `sessionRunning || live-tail
  // isGenerating` — a genuinely generating quick SDK turn frequently does NOT
  // have `activeSession.status === 'running'` (the backend does not reliably flip
  // the durable status while the SDK streams), so relying on status alone hides
  // the Stop button mid-generation. `working` deliberately EXCLUDES the optimistic
  // 'sending' pending row (which can stick after the turn ends and freeze Stop
  // ON); isGenerating self-clears at the turn's `result` — or, on a user cancel,
  // when useIPCEvents resets the live-tail buffer on the cancellation message.
  // Falls back to the status check when the host does not pass `working`.
  const running = working ?? activeSession.status === 'running';
  const updateSession = useSessionStore((s) => s.updateSession);

  // Global ⌘' (toggleChat) focus mailbox. The quick-session composer registers
  // under the SESSION id — NOT the panel-scoped `hostKey` below, which is the
  // pending-send key and is per-panel. The shortcut handler resolves
  // `activeRunId ?? selectedSessionId`, and a quick session has no active run,
  // so the session id is what arrives (see composerFocusStore's key scheme).
  useComposerFocusRequest(activeSession.id, textareaRef);

  // Question-gate answer plumbing: direct-answer submits reuse the card's
  // trpc mutation; multi-question gates go through the card's Other-text bus.
  const setOtherText = useQuestionStore((s) => s.setOtherText);
  const clearOtherText = useQuestionStore((s) => s.clearOtherText);

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
  // Per-agent reasoning-effort selection (IDEA-029), persisted on the panel like
  // model/fastMode — hydrated on mount so the EffortPill reflects the launch
  // choice (wizard select) or a prior in-composer change.
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | null>(null);
  // Latest CLI-reported fast-mode state (ground truth vs the request toggle) —
  // snapshot on mount, then live per-turn pushes. Lets the Fast pill warn when
  // the opt-in was declined (entitlement / cooldown) instead of lying.
  const [fastModeReport, setFastModeReport] = useState<FastModeStateNotice | null>(null);
  useEffect(() => {
    if (interactive || !panelId) {
      setModelId(null);
      setFastMode(false);
      setFastModeReport(null);
      setReasoningEffort(null);
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
    API.claudePanels
      .getEffort(panelId)
      .then((res) => {
        if (!cancelled && res.success) setReasoningEffort((res.data as ReasoningEffort | null) ?? null);
      })
      .catch(() => {
        /* non-fatal: effort pill falls back to 'Default' */
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

  // A turn that discovered its pinned model was pulled mid-call (e.g. Fable 5.1)
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
        // PANEL-SCOPED relay: a session can host multiple PTY chat panels (Add
        // chat), so the composed turn must reach THIS panel's own live REPL — the
        // session-scoped path resolves the session's FIRST panel, misrouting an
        // added panel's ⌃G turn. panels:send-input relays a PTY panel through
        // relayOrSpawnPtyPanel, keyed by panelId. The session-scoped fallback
        // covers the (theoretical) caller with no panelId.
        const relay = panelId
          ? API.panels.sendInput(panelId, text)
          : API.sessions.sendInput(activeSession.id, text);
        void relay
          .then((result) => {
            if (!result.success) setInput(text);
          })
          .catch(() => setInput(text));
        return;
      }
      // SDK, question gate open: the turn is PARKED inside the AskUserQuestion
      // hook awaiting the human's answer — the send IS the answer. A single-
      // question gate is answered directly as free text (same payload the card's
      // "Other" submit builds); a multi-question gate can't be answered by one
      // text blob, so route the text onto the card's Other-input bus instead
      // (mirrors ChatInput's workflow-question mode) and let the card submit.
      // Checked BEFORE the `running` branch: a queued message would strand
      // behind a gate only the card could clear.
      if (activeQuestion != null) {
        const q = activeQuestion;
        if (q.questions.length === 1) {
          const qp = q.questions[0];
          setInput('');
          // Return the promise so UnifiedComposer awaits it and clears the
          // composer attachments ONLY on success — a throw preserves them (and
          // the draft) for retry, instead of silently discarding the images.
          return (async () => {
            try {
              // Persist attachments to disk and fold their paths into the answer
              // (QuestionRouter embeds them via <attachments>), mirroring
              // AskUserQuestionCard — text answers must not drop their images.
              const attachmentPaths: string[] = [];
              for (const t of atts.texts) {
                attachmentPaths.push(await window.electronAPI.sessions.saveLargeText(q.runId, t.content));
              }
              if (atts.images.length > 0) {
                const imagePaths = await window.electronAPI.sessions.saveImages(
                  q.runId,
                  atts.images.map((img) => ({ name: img.name, dataUrl: img.dataUrl, type: img.type })),
                );
                attachmentPaths.push(...imagePaths);
              }
              await trpc.cyboflow.questions.answer.mutate({
                questionId: q.id,
                answers: { [qp.question]: text.trim() },
                ...(attachmentPaths.length > 0 ? { attachments: attachmentPaths } : {}),
              });
              clearOtherText(q.id);
            } catch (err) {
              setInput(text);
              throw err;
            }
          })();
        }
        setOtherText(q.id, text);
        setInput('');
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
            if (!res.success || res.data?.queued !== true) {
              setPendingStatus(hostKey, id, 'failed', res.error);
            }
          })
          .catch((error) => setPendingStatus(hostKey, id, 'failed', errorText(error)));
        return;
      }

      // SDK, idle: dispatch via the panel handlers, which return the outcome.
      setInput('');
      const id = addPending(hostKey, text, 'sending');
      const dispatch =
        activeSession.status === 'waiting'
          ? handleSendInput(text, atts.images, atts.texts)
          // Thread the pending-send id so a status-flap continue that reaches an
          // already-running backend turn is queued UNDER this id — the displayed
          // 'queued' row can then dequeue the real server entry (behavior below).
          : handleContinueConversation(text, atts.images, atts.texts, modelId ?? undefined, false, id);
      // Promise.resolve tolerates a non-promise return (e.g. a test stub);
      // `res && res.success === false` only flips on an explicit failure result.
      void Promise.resolve(dispatch)
        .then((res) => {
          if (res && res.success === false) setPendingStatus(hostKey, id, 'failed', res.error);
          // Status-flap fallback: the backend queued this continue (keyed by `id`)
          // instead of dispatching it. Flip the optimistic 'sending' row to the
          // addressable 'queued' state so it reconciles/dequeues like a normal
          // running-state queue, instead of lingering as a stuck 'sending' row.
          else if (res && (res as { queued?: boolean }).queued === true) setPendingStatus(hostKey, id, 'queued');
        })
        .catch((error) => setPendingStatus(hostKey, id, 'failed', errorText(error)));
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
      activeQuestion,
      setOtherText,
      clearOtherText,
    ],
  );

  // "Interrupt & send": abort the live turn and drive the message as a fresh
  // turn NOW (interrupt=true → continuePanel's abort-then-continue), instead of
  // queueing it for the rest boundary. Shows a normal 'sending' pending row
  // (reconciled away when the real user turn lands), NOT a 'queued' one.
  const onInterruptSend = useCallback(
    (atts: ComposerAttachments) => {
      const text = input;
      if (!text.trim()) return;
      setInput('');
      const id = addPending(hostKey, text, 'sending');
      void Promise.resolve(
        handleContinueConversation(text, atts.images, atts.texts, modelId ?? undefined, true),
      )
        .then((res) => {
          if (res && res.success === false) setPendingStatus(hostKey, id, 'failed', res.error);
        })
        .catch((error) => setPendingStatus(hostKey, id, 'failed', errorText(error)));
    },
    [input, setInput, hostKey, addPending, setPendingStatus, handleContinueConversation, modelId],
  );

  // The interrupt affordance is an SDK, running-with-no-open-question capability
  // for BOTH Claude and Codex (they share the panels:continue interrupt path — the
  // codex branch aborts the app-server turn, then delivers the message as a fresh
  // resumed turn). PTY relays its own input (no queue/interrupt), and an open
  // question gate must be ANSWERED rather than interrupted. Gate the handler here
  // so UnifiedComposer keeps its plain Stop button everywhere else.
  const supportsInterrupt = !interactive && activeQuestion == null;


  const placeholder = interactive
    ? `Message the live session…  (${kbdHint('mod', 'Enter')} to send)`
    : activeQuestion != null
      ? `Answer the question…  (${kbdHint('mod', 'Enter')} to send)`
      : activeSession.status === 'waiting'
        ? `Enter your response…  (${kbdHint('mod', 'Enter')} to send)`
        : `Write a command…  (${kbdHint('mod', 'Enter')} to send)`;

  const modelLabel = interactive
    ? null
    : modelId
      ? modelDisplayLabel(modelId, agentProvider)
      : null;

  // Interactive model selector for an IDLE quick SDK session — replaces the
  // read-only "Sonnet 🔒" pill. While running, fall through to the read-only
  // modelLabel pill (a model change only takes effect on the next turn, and the
  // in-flight turn already chose its model). PTY/flow runs never get this.
  const modelSlot =
    !interactive && !running && panelId ? (
      <ModelPill
        panelId={panelId}
        agentProvider={agentProvider}
        currentModel={modelId}
        onModelChange={handleModelChange}
      />
    ) : undefined;

  // Opus-only fast-mode toggle, next to the checkpoint pill. Mirrors the model
  // pill's mounting (idle quick SDK only) and is shown only while Opus is the
  // selected model — fast mode has no effect on other models.
  const fastModeSlot =
    !interactive && !running && panelId && isOpusModel(modelId) ? (
      <FastModePill panelId={panelId} fastMode={fastMode} onChange={setFastMode} report={fastModeReport} />
    ) : undefined;

  // Reasoning-effort selector (IDEA-029), next to the model pill. Mirrors the
  // model pill's mounting (idle non-PTY quick session only) — a running turn's
  // effort choice is already baked into the in-flight spawn and a mid-turn change
  // would be discarded. Shown for BOTH providers that carry the flag: Claude
  // (Options.effort / --effort) and codex-sdk (startCodexSdkTurn → the app-server
  // turn's effort). codex-pty is the only effort-incapable runtime, and it always
  // renders as `interactive`, so the `!interactive` guard already excludes it —
  // EffortPill's agentProvider prop picks the right scale (Codex none..xhigh).
  const effortSlot =
    !interactive && !running && panelId ? (
      <EffortPill
        panelId={panelId}
        agentProvider={agentProvider}
        currentEffort={reasoningEffort}
        onEffortChange={setReasoningEffort}
      />
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

  // Per-panel substrate override (added chats only, TASK-104) is now chosen at
  // "Add chat" creation time via the PanelTabBar picker, not edited after the
  // fact here — see PanelTabBar's Add-chat dropdown.

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
      // Interrupt & send (Claude SDK, running, no open question): abort the live
      // turn and drive this message now — offered alongside Queue while running.
      onInterruptSend={supportsInterrupt && running ? onInterruptSend : undefined}
      onTogglePtyOpen={interactive ? onTogglePtyOpen : undefined}
      supportsAttachments={!interactive}
      modelLabel={modelLabel}
      modelSlot={modelSlot}
      permissionSlot={permissionSlot}
      effortLabel={effortLabel}
      fastSlot={fastModeSlot}
      effortSlot={effortSlot}
      compactSlot={compactSlot}
    />
  );
}
