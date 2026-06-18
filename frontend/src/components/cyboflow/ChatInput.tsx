/**
 * ChatInput — the run-host adapter for the unified composer.
 *
 * Owns the per-run mode detection + the four substrate-specific send paths, and
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
import { resolveChatVisibility } from './unified/useChatVisibility';

/**
 * Delay (ms) between relaying the message body and the separate '\r' that submits
 * it. claude 2.1.x captures a single input burst as a bracketed paste, so a '\r'
 * appended to the body is swallowed as a literal newline and never submits; the
 * Enter must arrive as its own keystroke after the paste-coalescing window closes.
 */
const SUBMIT_DELAY_MS = 300;

export interface ChatInputProps {
  runId: string | null;
}

export function ChatInput({ runId }: ChatInputProps): React.ReactElement | null {
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

  // -- mode gate (unchanged from the bespoke composer) ----------------------
  const isInteractiveRunning =
    runId != null && activeRun?.substrate === 'interactive' && activeRun.status === 'running';

  const mode: 'quick' | 'workflow-question' | 'workflow-interactive' | 'workflow-idle' | 'none' =
    runId != null
      ? activeQuestion != null
        ? 'workflow-question'
        : isInteractiveRunning
          ? 'workflow-interactive'
          : 'workflow-idle'
      : selectedSessionId != null
        ? 'quick'
        : 'none';

  const isIdleNudgeable = mode === 'workflow-idle' && activeRun?.status === 'awaiting_review';
  const isPaused = mode === 'workflow-idle' && activeRun?.status === 'paused';
  const isDisabled = mode === 'workflow-idle' && !isIdleNudgeable;

  // -- send dispatch (the four paths, unchanged) ----------------------------
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
        else setSendError(`Nudge ignored: ${result.reason}`);
      } catch (err: unknown) {
        setSendError(err instanceof Error ? err.message : 'Nudge failed');
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
          : mode === 'workflow-interactive'
            ? 'Message the running session — relayed safely…'
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
      onSubmit={() => handleSend()}
      onTogglePtyOpen={isInteractive ? () => setPtyOpen((v) => !v) : undefined}
      sendError={sendError}
    />
  );
}
