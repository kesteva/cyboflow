/**
 * ResumeSessionPrompt — open-time recovery prompt for a lost interactive (PTY)
 * quick session.
 *
 * When the app is closed/restarted the persistent `claude` REPL backing an
 * interactive quick session is gone, but the conversation's context survives on
 * disk (claude's transcript) and as `sessions.claude_session_id`. On reopening
 * such a session, ClaudePanel shows this prompt INSTEAD of silently letting the
 * next message start a brand-new conversation:
 *
 *   - primary "Resume previous session" → onResume: arms the deferred resume
 *     (sessions:resume-interactive). The next composer message continues the
 *     prior conversation with full context (`claude --resume <uuid>
 *     --fork-session`).
 *   - ghost   "Start fresh"             → onStartFresh: dismiss; the next message
 *     starts a new conversation (unchanged behavior).
 *
 * Thin PRESENTATIONAL wrapper over `ui/Modal` (mirrors InteractiveWarnDialog) —
 * the scrim/card dismissal contract is delegated to Modal; actions are plain
 * callbacks. No tRPC, no wire types.
 */
import { type ReactElement } from 'react';
import { History } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';

export interface ResumeSessionPromptProps {
  isOpen: boolean;
  onClose: () => void;
  /** Primary action: resume the prior conversation on the next message. */
  onResume: () => void;
  /** Ghost action: start a fresh conversation (dismiss). */
  onStartFresh: () => void;
}

export function ResumeSessionPrompt({
  isOpen,
  onClose,
  onResume,
  onStartFresh,
}: ResumeSessionPromptProps): ReactElement {
  const handleResume = (): void => {
    onResume();
    onClose();
  };

  const handleStartFresh = (): void => {
    onStartFresh();
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      closeOnOverlayClick={false}
      showCloseButton={false}
    >
      {/* Accent eyebrow stripe in the interactive (PTY) color. */}
      <div className="h-1.5 bg-interactive" aria-hidden="true" />

      <div className="px-6 py-5">
        <div className="mb-3 flex items-center gap-1.5 text-interactive">
          <History className="h-3.5 w-3.5" aria-hidden="true" />
          <span
            className="font-semibold uppercase"
            style={{ fontSize: '10px', letterSpacing: '0.18em' }}
          >
            Previous session found
          </span>
        </div>

        <h2
          className="font-bold text-text-primary"
          style={{ fontSize: '13.5px', lineHeight: 1.35 }}
        >
          Resume your previous terminal session?
        </h2>

        <p
          className="mt-2 text-text-secondary"
          style={{ fontSize: '11.5px', lineHeight: 1.5 }}
        >
          This session's interactive terminal was closed when the app last shut
          down. You can resume the previous conversation — your next message will
          continue it with the full prior context — or start fresh with a new
          conversation in the same worktree.
        </p>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={handleStartFresh}>
            Start fresh
          </Button>
          <Button variant="primary" size="sm" onClick={handleResume}>
            Resume previous session
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default ResumeSessionPrompt;
