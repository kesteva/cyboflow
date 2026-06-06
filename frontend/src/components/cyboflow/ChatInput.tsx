/**
 * ChatInput — Mode-gated chat input bar for the per-run bottom pane.
 *
 * Dispatches user text to the correct transport for each of three modes.
 *
 * Precedence: an active RUN (`activeRunId`) wins over a co-selected quick
 * session, so a run nested in a session drives the chat to the run while
 * `activeQuickSessionId` stays pointed at the parent session for Diff /
 * File-Explorer / panels. Quick mode is reached only when `activeRunId` is null.
 *
 *   quick             — `activeRunId` is null AND `activeQuickSessionId` is
 *                       non-null; text is sent via
 *                       `API.sessions.sendInput(activeQuickSessionId, text)`.
 *
 *   workflow-question — `runId` is non-null AND there is a pending Question
 *                       for this run; text is forwarded to `questionStore`
 *                       via `setOtherText(questionId, text)`. The
 *                       AskUserQuestionCard remains the sole submit authority
 *                       for the final answers payload.
 *
 *   workflow-idle     — `runId` is non-null but no pending Question exists.
 *                       When the run rests in `awaiting_review` the input is
 *                       ENABLED for a free-form "nudge": the text re-spawns the
 *                       run with `--resume` (a follow-up turn on the same SDK
 *                       conversation) via `trpc.cyboflow.runs.nudge`. In any
 *                       other idle status (running / starting / stuck / paused)
 *                       the textarea and Send button stay disabled with a
 *                       tooltip. A `paused` run (SDK-only Pause, Phase 4b) gets a
 *                       distinct "Resume to continue" hint — the user must Resume
 *                       from the run action bar before the chat re-enables.
 *
 *   none              — neither `runId` nor `activeQuickSessionId` is set;
 *                       renders nothing.
 *
 * Props:
 *   runId — the active workflow run id (null in quick-session or idle mode).
 */
import { useMemo, useState, useRef, useLayoutEffect } from 'react';
import { Send, Folder, GitBranch } from 'lucide-react';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useQuestionStore } from '../../stores/questionStore';
import { useActiveRunsStore } from '../../stores/activeRunsStore';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { cn } from '../../utils/cn';
import { API } from '../../utils/api';
import type { IPCResponse } from '../../utils/api';
import { trpc } from '../../trpc/client';

/** Max composer height (px) before the textarea scrolls instead of growing. */
const MAX_COMPOSER_HEIGHT = 160;

/**
 * Delay (ms) between relaying the message body and the separate '\r' that submits
 * it. claude 2.1.x captures a single input burst as a bracketed paste, so a '\r'
 * appended to the body is swallowed as a literal newline and never submits; the
 * Enter must arrive as its own keystroke after the paste-coalescing window closes.
 * Mirrors SUBMIT_DELAY_MS in main's interactiveClaudeManager (the initial-prompt
 * submit path).
 */
const SUBMIT_DELAY_MS = 300;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatInputProps {
  runId: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChatInput({ runId }: ChatInputProps): React.ReactElement | null {
  const activeQuickSessionId = useCyboflowStore((s) => s.activeQuickSessionId);
  const activeRunId = useCyboflowStore((s) => s.activeRunId);
  const runsByProject = useActiveRunsStore((s) => s.runsByProject);

  // Inline selector: most-recently-created pending Question for this run.
  const activeQuestion = useQuestionStore((s) =>
    s.queue.find((q) => q.runId === runId && q.status === 'pending'),
  );
  const setOtherText = useQuestionStore((s) => s.setOtherText);

  // -------------------------------------------------------------------------
  // Active-run worktree folder + branch for the status bar. The active-run
  // rows (with worktree_path + branch_name) live in activeRunsStore keyed by
  // projectId; we don't have the projectId in this subtree, so we scan all
  // projects for the row whose id === activeRunId (run ids are unique).
  // -------------------------------------------------------------------------
  const activeRun = useMemo(() => {
    if (activeRunId === null) return null;
    for (const rows of Object.values(runsByProject)) {
      const found = rows.find((r) => r.id === activeRunId);
      if (found) return found;
    }
    return null;
  }, [activeRunId, runsByProject]);

  const worktreePath = activeRun?.worktree_path ?? null;
  const branchName = activeRun?.branch_name ?? null;
  const folderName = worktreePath !== null ? worktreePath.split('/').filter(Boolean).pop() ?? null : null;

  const [text, setText] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the composer with its content (up to MAX_COMPOSER_HEIGHT), then
  // scroll — mirrors the quick-session composer's feel.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT)}px`;
  }, [text]);

  // -------------------------------------------------------------------------
  // Three-state gate
  // -------------------------------------------------------------------------

  // A run on the interactive substrate that is actively running gets an ENABLED
  // composer that relays each line as a real REPL turn into the live PTY (IDEA-030
  // / TASK-817). Every other workflow run keeps the legacy disabled 'workflow-idle'
  // composer. The substrate is read from the active-run row surfaced by TASK-813.
  const isInteractiveRunning =
    runId != null && activeRun?.substrate === 'interactive' && activeRun.status === 'running';

  // Precedence: an active RUN wins over a co-selected quick session. A run nested
  // in a session keeps activeQuickSessionId pointed at its parent session (so Diff /
  // File-Explorer / panels follow the session), while the chat input must follow the
  // RUN — hence the `runId` prop (the active run; === activeRunId in production) is
  // checked first. Quick mode is reached only when there is NO active run. Behavior
  // is unchanged today (the two are never both set until a run carries a session_id
  // in Phase 3); this is the forward-correct ordering.
  const mode: 'quick' | 'workflow-question' | 'workflow-interactive' | 'workflow-idle' | 'none' =
    runId != null
      ? runId != null && activeQuestion != null
        ? 'workflow-question'
        : isInteractiveRunning
          ? 'workflow-interactive'
          : runId != null
            ? 'workflow-idle'
            : 'none'
      : activeQuickSessionId != null
        ? 'quick'
        : 'none';

  if (mode === 'none') return null;

  // -------------------------------------------------------------------------
  // Derived flags
  // -------------------------------------------------------------------------

  // A run resting in `awaiting_review` is nudgeable: the user can type a
  // free-form follow-up that re-drives the (drained) SDK conversation. Any
  // other idle status (running / starting / stuck) keeps the input disabled.
  const isIdleNudgeable = mode === 'workflow-idle' && activeRun?.status === 'awaiting_review';
  // A run parked in the NON-terminal 'paused' status (SDK-only Pause, Phase 4b)
  // gets a DISABLED composer with a distinct hint — the user must Resume the run
  // (run action bar) before the conversation can continue. Treated separately
  // from the generic idle-disabled case so the messaging is unambiguous.
  const isPaused = mode === 'workflow-idle' && activeRun?.status === 'paused';
  const isDisabled = mode === 'workflow-idle' && !isIdleNudgeable;
  const canSend = !isDisabled && text.trim().length > 0 && !isSending;

  // -------------------------------------------------------------------------
  // Send handler
  // -------------------------------------------------------------------------

  const handleSend = async () => {
    if (!canSend) return;

    if (mode === 'quick') {
      setIsSending(true);
      setSendError(null);
      try {
        const result: IPCResponse<void> = await API.sessions.sendInput(activeQuickSessionId!, text);
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
      return;
    }

    if (mode === 'workflow-interactive') {
      // Submit the message the way a human paste+Enter does: relay the BODY as a
      // paste, then relay '\r' (Enter) as a SEPARATE keystroke after the
      // bracketed-paste window closes. claude 2.1.x captures a one-shot
      // `text + '\r'` as a paste whose trailing '\r' is a literal newline (never
      // Enter), so it would land in the composer and never submit. The
      // raw-keystroke path (InteractiveTerminalView) already sends Enter as its
      // own '\r'; this composer path owns the body/submit split. The input type is
      // AppRouter-inferred (no local RelayInput).
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
        // Defensive: should not happen given mode guard, but log and no-op.
        console.warn('[ChatInput] workflow-question mode but activeQuestion is null at send time');
        return;
      }
      setOtherText(activeQuestion.id, text);
      setText('');
      return;
    }

    if (mode === 'workflow-idle' && isIdleNudgeable) {
      if (runId == null) {
        // Defensive: should not happen given mode guard, but log and no-op.
        console.warn('[ChatInput] workflow-idle nudge but runId is null at send time');
        return;
      }
      // Free-form nudge — re-drives the run's SDK conversation as a follow-up
      // turn. Bypasses questionStore entirely (this is NOT an answer payload).
      setIsSending(true);
      setSendError(null);
      try {
        const result = await trpc.cyboflow.runs.nudge.mutate({ runId, text });
        if ('delivered' in result) {
          setText('');
        } else {
          setSendError(`Nudge ignored: ${result.reason}`);
        }
      } catch (err: unknown) {
        setSendError(err instanceof Error ? err.message : 'Nudge failed');
      } finally {
        setIsSending(false);
      }
    }
  };

  // -------------------------------------------------------------------------
  // Keyboard handler — Enter sends, Shift+Enter inserts newline
  // -------------------------------------------------------------------------

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const composer = (
    <div
      className={cn(
        'flex flex-col border bg-surface-primary transition-colors',
        'focus-within:border-border-hover',
        'border-border-primary',
        isDisabled && 'opacity-60',
      )}
    >
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={
          mode === 'quick'
            ? 'Send a message…'
            : isPaused
              ? 'Run paused — Resume to continue'
              : isIdleNudgeable
                ? 'Nudge the agent — continues the conversation…'
                : mode === 'workflow-interactive'
                  ? 'Message the running session — relayed safely…'
                  : 'Type your answer…'
        }
        disabled={isDisabled}
        rows={1}
        style={{ maxHeight: MAX_COMPOSER_HEIGHT }}
        className={cn(
          'w-full resize-none bg-transparent px-3 pt-2 pb-1 text-xs',
          'text-text-primary placeholder-text-tertiary',
          'focus:outline-none disabled:cursor-not-allowed',
        )}
      />
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <span className="text-[10px] text-text-tertiary">
          {isDisabled ? '' : 'Enter to send · Shift+Enter for newline'}
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
  );

  // Status bar — folder + branch chips for the active run, mirroring the
  // quick-session composer's status bar position (directly above the input).
  // Only shown in workflow modes and only when we have worktree/branch data.
  const showStatusBar = runId !== null && (folderName !== null || branchName !== null);
  const statusBar = showStatusBar ? (
    <div
      className="flex items-center gap-2 px-0.5 text-[10px]"
      data-testid="run-chat-status-bar"
    >
      {folderName !== null && (
        <span
          className="inline-flex items-center gap-1 border border-border-primary bg-surface-primary px-2 py-0.5 text-interactive"
          title={worktreePath ?? undefined}
        >
          <Folder className="h-3 w-3" />
          <span className="truncate max-w-[160px]">{folderName}</span>
        </span>
      )}
      {branchName !== null && (
        <span
          className="inline-flex items-center gap-1 border border-border-primary bg-surface-primary px-2 py-0.5 font-mono text-status-success"
          title={branchName}
        >
          <GitBranch className="h-3 w-3" />
          <span className="truncate max-w-[160px]">{branchName}</span>
        </span>
      )}
    </div>
  ) : null;

  return (
    <div className="flex flex-col gap-1 border-t border-border-primary bg-bg-primary p-2">
      {statusBar}
      {isDisabled ? (
        <Tooltip
          content={
            isPaused
              ? 'Run paused — Resume to continue the conversation'
              : 'Input enabled when the agent asks a question or the run is awaiting your review'
          }
        >
          {composer}
        </Tooltip>
      ) : (
        composer
      )}
      {sendError !== null && (
        <p className="text-xs text-status-error" role="alert">
          {sendError}
        </p>
      )}
    </div>
  );
}
