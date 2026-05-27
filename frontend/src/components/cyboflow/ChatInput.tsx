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
import { useState } from 'react';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useQuestionStore } from '../../stores/questionStore';
import { Textarea } from '../ui/Textarea';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { API } from '../../utils/api';
import type { IPCResponse } from '../../utils/api';

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

  // Inline selector: most-recently-created pending Question for this run.
  const activeQuestion = useQuestionStore((s) =>
    s.queue.find((q) => q.runId === runId && q.status === 'pending'),
  );
  const setOtherText = useQuestionStore((s) => s.setOtherText);

  const [text, setText] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);

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

  const textarea = (
    <Textarea
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={handleKeyDown}
      placeholder={
        mode === 'quick'
          ? 'Send a message…'
          : 'Type your answer…'
      }
      disabled={isDisabled}
      rows={2}
      className="resize-none text-xs"
    />
  );

  return (
    <div className="flex flex-col gap-1 border-t border-border-primary bg-bg-primary p-2">
      <div className="flex gap-2 items-end">
        <div className="flex-1">
          {mode === 'workflow-idle' ? (
            <Tooltip content="Input enabled only when the agent asks a question">
              {textarea}
            </Tooltip>
          ) : (
            textarea
          )}
        </div>
        <Button
          size="sm"
          variant="primary"
          disabled={!canSend}
          onClick={() => void handleSend()}
        >
          Send
        </Button>
      </div>
      {sendError !== null && (
        <p className="text-xs text-status-error" role="alert">
          {sendError}
        </p>
      )}
    </div>
  );
}
