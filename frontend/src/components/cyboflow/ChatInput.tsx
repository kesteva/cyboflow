/**
 * ChatInput — Mode-gated chat input bar for the per-run bottom pane.
 *
 * Dispatches user text to the correct transport for each of three modes:
 *
 *   quick             — `activeQuickSessionId` is non-null; text is sent via
 *                       `API.sessions.sendInput(activeQuickSessionId, text)`.
 *
 *   workflow-question — `runId` is non-null AND there is a pending Question
 *                       for this run; text is forwarded to `questionStore`
 *                       via `setOtherText(questionId, text)`. The
 *                       AskUserQuestionCard remains the sole submit authority
 *                       for the final answers payload.
 *
 *   workflow-idle     — `runId` is non-null but no pending Question exists;
 *                       textarea and Send button are both disabled with a
 *                       tooltip explaining why.
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

/** Max composer height (px) before the textarea scrolls instead of growing. */
const MAX_COMPOSER_HEIGHT = 160;

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

  const mode: 'quick' | 'workflow-question' | 'workflow-idle' | 'none' =
    activeQuickSessionId != null
      ? 'quick'
      : runId != null && activeQuestion != null
        ? 'workflow-question'
        : runId != null
          ? 'workflow-idle'
          : 'none';

  if (mode === 'none') return null;

  // -------------------------------------------------------------------------
  // Derived flags
  // -------------------------------------------------------------------------

  const isDisabled = mode === 'workflow-idle';
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

    if (mode === 'workflow-question') {
      if (activeQuestion == null) {
        // Defensive: should not happen given mode guard, but log and no-op.
        console.warn('[ChatInput] workflow-question mode but activeQuestion is null at send time');
        return;
      }
      setOtherText(activeQuestion.id, text);
      setText('');
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
        'flex flex-col rounded-lg border bg-surface-secondary transition-colors',
        'focus-within:border-interactive focus-within:ring-2 focus-within:ring-interactive',
        'border-border-primary',
        isDisabled && 'opacity-60',
      )}
    >
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={mode === 'quick' ? 'Send a message…' : 'Type your answer…'}
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
      className="flex items-center gap-2 px-0.5 text-[10px] text-text-tertiary"
      data-testid="run-chat-status-bar"
    >
      {folderName !== null && (
        <span className="flex items-center gap-1" title={worktreePath ?? undefined}>
          <Folder className="h-3 w-3" />
          <span className="truncate max-w-[160px]">{folderName}</span>
        </span>
      )}
      {branchName !== null && (
        <span className="flex items-center gap-1 font-mono" title={branchName}>
          <GitBranch className="h-3 w-3" />
          <span className="truncate max-w-[160px]">{branchName}</span>
        </span>
      )}
    </div>
  ) : null;

  return (
    <div className="flex flex-col gap-1 border-t border-border-primary bg-bg-primary p-2">
      {statusBar}
      {mode === 'workflow-idle' ? (
        <Tooltip content="Input enabled only when the agent asks a question">
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
