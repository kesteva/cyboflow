/**
 * ChatInput — the run-host adapter for the unified composer.
 *
 * Owns the per-run mode detection + the substrate-specific send paths, and
 * renders the shared <UnifiedComposer> (the bifurcated bespoke input it used to
 * carry is gone — the folder/branch chips moved to <ChatMetaStrip> in
 * RunChatView). The composer UI is now identical to the quick-session panel.
 *
 * Precedence: an active RUN (`activeRunId`) wins over a co-selected quick
 * session, so a run nested in a session drives the chat to the run while
 * `selectedSessionId` stays pointed at the parent session for Diff /
 * File-Explorer / panels. Quick mode is reached only when `activeRunId` is null.
 *
 *   quick             — `activeRunId` is null AND `selectedSessionId` is
 *                       non-null; text is sent via
 *                       `API.sessions.sendInput(selectedSessionId, text)`.
 *
 *   workflow-question — a pending Question exists for this run; text is
 *                       forwarded to `questionStore` via `setOtherText`.
 *
 *   workflow-interactive — an interactive-substrate run that is running; each
 *                       line is relayed into the live PTY (body, then a separate
 *                       '\r' after the bracketed-paste window). The PTY composer
 *                       is hidden by default and revealed with ⌃G.
 *
 *   workflow-monitor  — an SDK run with an ACTIVE on-demand monitor (the
 *                       monitor-unify refactor; gated on config
 *                       `programmaticSupervisor: 'sdk'`). The input is ENABLED so
 *                       the user can query the monitor; Send →
 *                       `trpc.cyboflow.monitor.send.mutate`. The user's turn + the
 *                       monitor's reply arrive via the unified stream (injected
 *                       server-side → raw_events → streamEvents live-refresh →
 *                       listUnifiedMessages), so there is NO optimistic insert.
 *                       Sits BELOW `workflow-question` (an open AskUserQuestion
 *                       gate still owns the composer).
 *
 *   workflow-idle     — a non-interactive run with no pending question. ENABLED
 *                       only when the run rests in `awaiting_review` (a free-form
 *                       nudge re-spawns the SDK conversation via `runs.nudge`);
 *                       otherwise disabled with a hint.
 *
 *   none              — neither runId nor selectedSessionId; renders nothing.
 */
import { useEffect, useMemo, useState, useRef } from 'react';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useQuestionStore } from '../../stores/questionStore';
import { useActiveRunsStore } from '../../stores/activeRunsStore';
import { API } from '../../utils/api';
import type { IPCResponse } from '../../utils/api';
import { trpc } from '../../trpc/client';
import { UnifiedComposer } from './unified/UnifiedComposer';
import { PermissionModePill } from './unified/PermissionModePill';
import { resolveChatVisibility } from './unified/useChatVisibility';
import type { PermissionMode } from '../../../../shared/types/workflows';

/**
 * Delay (ms) between relaying the message body and the separate '\r' that submits
 * it. claude 2.1.x captures a single input burst as a bracketed paste, so a '\r'
 * appended to the body is swallowed as a literal newline and never submits; the
 * Enter must arrive as its own keystroke after the paste-coalescing window closes.
 */
const SUBMIT_DELAY_MS = 300;

/** Human-readable message for a nudge no-op reason (falls back to the raw reason). */
function nudgeReasonMessage(reason: string): string {
  switch (reason) {
    case 'blocked':
      return 'Resolve the blocking review item(s) for this run first.';
    case 'no_session':
      return 'This run has no resumable session to continue.';
    case 'not_idle':
      return 'This run is no longer awaiting review.';
    case 'terminal':
      return 'This run has ended and cannot be nudged.';
    case 'execute_failed':
      return 'The agent could not be re-driven — check the run logs.';
    default:
      return `Nudge ignored: ${reason}`;
  }
}

/**
 * Human-readable message for a setPermissionMode no-op reason. The mutation
 * returns `{ noOp: true, reason: 'not_found' | 'already_terminal' }`; mapping it
 * here gives PermissionModePill a meaningful error to log instead of `undefined`.
 */
function setPermissionModeReasonMessage(reason: 'not_found' | 'already_terminal'): string {
  switch (reason) {
    case 'not_found':
      return 'Run not found';
    case 'already_terminal':
      return 'Run has ended and its permission mode can no longer change';
    default:
      return `Permission mode change ignored: ${reason}`;
  }
}

/**
 * Human-readable message for a queueInput no-op reason (falls back to the raw
 * reason). Used by the "always allow messaging a running flow" path: while an SDK
 * run executes, Send QUEUES the message for the next turn.
 */
function queueInputReasonMessage(reason: string): string {
  switch (reason) {
    case 'terminal':
      return 'This run has ended and cannot receive messages.';
    case 'not_running':
      return 'This run is no longer executing — try again once it resumes.';
    case 'not_found':
      return 'Run not found.';
    case 'empty':
      return 'Nothing to send.';
    default:
      return `Message not queued: ${reason}`;
  }
}

/** Human-readable message for a reopen no-op reason (falls back to the raw reason). */
function reopenReasonMessage(reason: string): string {
  switch (reason) {
    case 'no_session':
      return 'This run has no resumable session to reopen.';
    case 'not_failed':
      return 'This run is no longer in a failed state.';
    case 'interactive_unsupported':
      return 'Interactive (PTY) runs cannot be reopened — only SDK runs resume.';
    case 'execute_failed':
      return 'The agent could not be re-driven — check the run logs.';
    default:
      return `Reopen ignored: ${reason}`;
  }
}

export interface ChatInputProps {
  runId: string | null;
  /**
   * Surface a confirmation after a run permission-mode change. The host
   * (RunChatView) shows a toast; the message is supplied by PermissionModePill's
   * appliedMessage (SDK runs apply the change on the next message). Only fired on
   * a confirmed write.
   */
  onPermissionApplied?: (message: string) => void;
}

export function ChatInput({ runId, onPermissionApplied }: ChatInputProps): React.ReactElement | null {
  const selectedSessionId = useCyboflowStore((s) => s.selectedSessionId);
  const activeRunId = useCyboflowStore((s) => s.activeRunId);
  const runsByProject = useActiveRunsStore((s) => s.runsByProject);

  const activeQuestion = useQuestionStore((s) =>
    s.queue.find((q) => q.runId === runId && q.status === 'pending'),
  );
  const setOtherText = useQuestionStore((s) => s.setOtherText);

  const activeRun = useMemo(() => {
    if (activeRunId === null) return null;
    for (const rows of Object.values(runsByProject)) {
      const found = rows.find((r) => r.id === activeRunId);
      if (found) return found;
    }
    return null;
  }, [activeRunId, runsByProject]);

  const [text, setText] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const substrate = activeRun?.substrate === 'interactive' ? 'interactive' : 'sdk';
  const isInteractive = substrate === 'interactive';

  // ⌃G reveals the relay composer for interactive runs (the live PTY xterm above
  // is the primary input; this composer is the rich-text relay). Captured at the
  // window level (capture phase) so the keystroke toggles the composer instead of
  // reaching xterm as a BEL (\x07). No-op for SDK runs (input always visible).
  const [ptyOpen, setPtyOpen] = useState(false);
  useEffect(() => {
    if (!isInteractive) {
      setPtyOpen(false);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault();
        e.stopPropagation();
        setPtyOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [isInteractive]);

  // -- on-demand monitor gate (monitor-unify) -------------------------------
  // An SDK programmatic run can carry an active monitor session (gated on config
  // `programmaticSupervisor: 'sdk'`); when it does, the run-chat composer is
  // ENABLED so the user can query the monitor and its reply renders in the same
  // unified Chat pane. The default review-queue path (no monitor) resolves
  // inactive and the composer stays disabled exactly as before. The probe is gated
  // on `substrate === 'sdk'` so the quick / interactive / orchestrated send paths
  // are never touched.
  //
  // We RE-PROBE on the run's status (not just on runId), because the monitor
  // session is registered only while the controller walks the DAG (registered at
  // run start; unregistered when the walk drains to awaiting_review). A one-shot
  // probe would (a) miss the active window if it fired while the run was still
  // 'starting' — leaving the composer permanently disabled — and (b) go stale
  // after drain. Keying on `status` makes starting→running enable it and
  // running→awaiting_review/terminal disable it (reverting to the nudge
  // affordance).
  const isSdkRun = activeRun?.substrate === 'sdk';
  const runStatus = activeRun?.status;
  const [monitorActive, setMonitorActive] = useState(false);

  useEffect(() => {
    if (runId === null || !isSdkRun) {
      setMonitorActive(false);
      return;
    }
    let cancelled = false;
    void trpc.cyboflow.monitor.isActive
      .query({ runId })
      .then((r) => {
        if (!cancelled) setMonitorActive(r.active);
      })
      .catch(() => {
        // Fail-soft: leave the composer in its default (disabled) state.
        if (!cancelled) setMonitorActive(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, isSdkRun, runStatus]);

  // -- mode gate ------------------------------------------------------------
  const isInteractiveRunning =
    runId != null && activeRun?.substrate === 'interactive' && activeRun.status === 'running';

  const mode:
    | 'quick'
    | 'workflow-question'
    | 'workflow-interactive'
    | 'workflow-monitor'
    | 'workflow-idle'
    | 'none' =
    runId != null
      ? activeQuestion != null
        ? 'workflow-question'
        : isInteractiveRunning
          ? 'workflow-interactive'
          : monitorActive
            ? 'workflow-monitor'
            : 'workflow-idle'
      : selectedSessionId != null
        ? 'quick'
        : 'none';

  const isIdleNudgeable = mode === 'workflow-idle' && activeRun?.status === 'awaiting_review';
  const isPaused = mode === 'workflow-idle' && activeRun?.status === 'paused';
  // A FAILED sdk run can be REOPENED — re-driven from its preserved SDK session
  // (runs.reopen). The escape hatch for a run that died at a gate. Interactive
  // runs have no --resume, so they stay disabled (isInteractive normalizes an
  // absent substrate to sdk, matching this component's substrate handling).
  const isReopenable =
    mode === 'workflow-idle' && activeRun?.status === 'failed' && !isInteractive;
  // "Always allow messaging a running flow": an SDK run that is mid-flight
  // (running / starting) lands in workflow-idle (no question, no active monitor),
  // and used to be DISABLED. It is now ENABLED so the user can always message the
  // agent — but the SDK runs a one-shot query() per turn (no mid-turn input), so
  // Send QUEUES the text via runs.queueInput and the backend delivers it as the
  // NEXT turn (at the drained REST seam). Interactive running runs keep their live
  // PTY relay path (workflow-interactive, above); paused/stuck/awaiting_input are
  // excluded by the explicit running/starting check.
  const isSdkRunning =
    mode === 'workflow-idle' &&
    !isInteractive &&
    (activeRun?.status === 'running' || activeRun?.status === 'starting');
  const isDisabled =
    mode === 'workflow-idle' && !isIdleNudgeable && !isReopenable && !isSdkRunning;

  // -- send dispatch --------------------------------------------------------
  const handleSend = async (): Promise<void> => {
    if (isDisabled || text.trim().length === 0 || isSending) return;

    if (mode === 'quick') {
      setIsSending(true);
      setSendError(null);
      try {
        const result: IPCResponse<void> = await API.sessions.sendInput(selectedSessionId!, text);
        if (result.success) setText('');
        else setSendError(result.error ?? 'Send failed');
      } catch (err: unknown) {
        setSendError(err instanceof Error ? err.message : 'Send failed');
      } finally {
        setIsSending(false);
      }
      return;
    }

    if (mode === 'workflow-interactive') {
      setIsSending(true);
      setSendError(null);
      try {
        await trpc.cyboflow.runs.relayInput.mutate({ runId: runId!, text });
        await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS));
        await trpc.cyboflow.runs.relayInput.mutate({ runId: runId!, text: '\r' });
        setText('');
      } catch (err: unknown) {
        setSendError(err instanceof Error ? err.message : 'Send failed');
      } finally {
        setIsSending(false);
      }
      return;
    }

    if (mode === 'workflow-monitor') {
      if (runId == null) {
        console.warn('[ChatInput] workflow-monitor mode but runId is null at send time');
        return;
      }
      // Query the run's on-demand monitor. NO optimistic insert: the server
      // injects the user's turn AND the monitor's reply into the unified stream,
      // which the run-chat refetches off the streamEvents delta (RunChatView), so
      // both render there. We only clear the composer on a confirmed delivery.
      setIsSending(true);
      setSendError(null);
      try {
        const result = await trpc.cyboflow.monitor.send.mutate({ runId, text });
        if (result.delivered) setText('');
        else setSendError('The monitor is no longer active for this run.');
      } catch (err: unknown) {
        setSendError(err instanceof Error ? err.message : 'Send failed');
      } finally {
        setIsSending(false);
      }
      return;
    }

    if (mode === 'workflow-question') {
      if (activeQuestion == null) {
        console.warn('[ChatInput] workflow-question mode but activeQuestion is null at send time');
        return;
      }
      setOtherText(activeQuestion.id, text);
      setText('');
      return;
    }

    if (mode === 'workflow-idle' && isIdleNudgeable) {
      if (runId == null) {
        console.warn('[ChatInput] workflow-idle nudge but runId is null at send time');
        return;
      }
      setIsSending(true);
      setSendError(null);
      try {
        const result = await trpc.cyboflow.runs.nudge.mutate({ runId, text });
        if ('delivered' in result) setText('');
        else setSendError(nudgeReasonMessage(result.reason));
      } catch (err: unknown) {
        setSendError(err instanceof Error ? err.message : 'Nudge failed');
      } finally {
        setIsSending(false);
      }
      return;
    }

    if (mode === 'workflow-idle' && isReopenable) {
      if (runId == null) {
        console.warn('[ChatInput] workflow-idle reopen but runId is null at send time');
        return;
      }
      setIsSending(true);
      setSendError(null);
      try {
        const result = await trpc.cyboflow.runs.reopen.mutate({ runId, text });
        if ('delivered' in result) setText('');
        else setSendError(reopenReasonMessage(result.reason));
      } catch (err: unknown) {
        setSendError(err instanceof Error ? err.message : 'Reopen failed');
      } finally {
        setIsSending(false);
      }
      return;
    }

    if (mode === 'workflow-idle' && isSdkRunning) {
      if (runId == null) {
        console.warn('[ChatInput] workflow-idle queueInput but runId is null at send time');
        return;
      }
      // "Always allow messaging a running flow": the SDK run is mid-turn, so the
      // message is QUEUED (runs.queueInput) and delivered at the next turn
      // boundary — NOT relayed live and NOT a nudge (which only re-drives a rested
      // run). Clear the composer on a confirmed queue; surface the no-op reason
      // (terminal / not_running / …) otherwise so the text is retained for retry.
      setIsSending(true);
      setSendError(null);
      try {
        const result = await trpc.cyboflow.runs.queueInput.mutate({ runId, text });
        if ('queued' in result) setText('');
        else setSendError(queueInputReasonMessage(result.reason));
      } catch (err: unknown) {
        setSendError(err instanceof Error ? err.message : 'Queue failed');
      } finally {
        setIsSending(false);
      }
    }
  };

  if (mode === 'none') return null;

  const placeholder =
    mode === 'quick'
      ? 'Write a command…  (⌘↵ to send)'
      : isPaused
        ? 'Run paused — Resume to continue'
        : isIdleNudgeable
          ? 'Nudge the agent — continues the conversation…'
          : isReopenable
          ? 'Reopen — re-drive this failed run…'
          : isSdkRunning
            ? 'Queue a message for the agent — sent on its next turn…'
            : mode === 'workflow-interactive'
              ? 'Message the running session — relayed safely…'
              : mode === 'workflow-monitor'
                ? 'Ask the monitor about this run…'
                : mode === 'workflow-question'
                  ? 'Type your answer…'
                  : 'Message the running flow…';

  const disabledHint = isPaused
    ? 'Run paused — Resume to continue the conversation'
    : 'Input enabled when the agent asks a question or the run is awaiting your review';

  const visibility = resolveChatVisibility({
    transport: substrate,
    mode: runId != null ? 'flow' : 'quick',
    running: false,
    ptyOpen,
  });

  // Runtime agent-permission selector for a NON-TERMINAL SDK run (ISSUE #2).
  // Persists to workflow_runs.permission_mode_snapshot via runs.setPermissionMode;
  // the executor re-reads it FRESH per spawn so the change governs the next turn.
  // Gated to substrate === 'sdk' because the interactive PTY substrate writes its
  // permission hook to .claude/settings.json at SPAWN only (no live update). We do
  // NOT mirror into the store optimistically — the setPermissionMode emit triggers
  // activeRunsStore.refresh(), which re-reads the canonical value within a tick.
  const runIsTerminal =
    activeRun != null &&
    ['completed', 'failed', 'canceled'].includes(activeRun.status);
  const permissionSlot =
    runId != null && activeRun != null && !isInteractive && !runIsTerminal ? (
      <PermissionModePill
        currentMode={activeRun.permission_mode_snapshot ?? 'default'}
        persist={async (mode: PermissionMode) => {
          const res = await trpc.cyboflow.runs.setPermissionMode.mutate({
            runId,
            permissionMode: mode,
          });
          // Map the noOp reason to a user-facing error so PermissionModePill logs
          // a meaningful message (not `undefined`) instead of silently swallowing
          // the failure.
          if ('updated' in res) return { success: true };
          return { success: false, error: setPermissionModeReasonMessage(res.reason) };
        }}
        // No-op: activeRun is store-derived; the setPermissionMode emit triggers a
        // runs.list refresh so the canonical value flows back through the store.
        onModeChange={() => {}}
        // Confirmation toast (hoisted to RunChatView) on a confirmed write only.
        // SDK runs re-read permission_mode_snapshot per spawn, so the change
        // governs the next message — not the in-flight turn.
        onApplied={onPermissionApplied ? (_mode, message) => onPermissionApplied(message) : undefined}
        appliedMessage="Permission mode updated — applies on your next message"
      />
    ) : undefined;

  return (
    <UnifiedComposer
      visibility={visibility}
      running={false}
      value={text}
      onChange={setText}
      textareaRef={textareaRef}
      placeholder={placeholder}
      disabled={isDisabled}
      disabledHint={isDisabled ? disabledHint : undefined}
      // "Always allow messaging a running flow": while an SDK run executes the
      // message is buffered for its next turn, so the action is QUEUE (not Send).
      primaryLabel={isSdkRunning ? 'Queue' : 'Send'}
      onSubmit={() => handleSend()}
      onTogglePtyOpen={isInteractive ? () => setPtyOpen((v) => !v) : undefined}
      permissionSlot={permissionSlot}
      sendError={sendError}
    />
  );
}
