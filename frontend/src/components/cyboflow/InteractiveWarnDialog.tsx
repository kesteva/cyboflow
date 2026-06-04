/**
 * InteractiveWarnDialog — first-interaction guardrail modal for the interactive
 * substrate (IDEA-030 / TASK-816).
 *
 * Shown at most ONCE per run, on the first direct mousedown anywhere on the live
 * PTY terminal surface. Direct keystrokes go straight to the running `claude
 * --resume` pty and can cancel the current step or break the orchestration loop,
 * so this modal nudges the operator toward the chat composer (which cyboflow
 * relays as a queued message) before letting them type into the terminal.
 *
 * It is a thin PRESENTATIONAL wrapper over `ui/Modal` — the scrim/card dismissal
 * contract ("overlay click dismisses, card click does not") is delegated to
 * Modal's mousedown-target guard; it is NOT re-implemented here. The two actions
 * are plain callbacks supplied by the caller (`InteractiveTerminalView`):
 *   - primary "Use chat instead"  → onUseChat (focus the composer, relay stays off)
 *   - ghost   "Interact anyway"   → onInteractAnyway (grant terminal focus + flip
 *                                    the per-run keystroke-relay flag, consumed by
 *                                    TASK-817)
 *
 * No tRPC subscription, no wire types — purely callback props.
 */
import { type CSSProperties, type ReactElement } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';

export interface InteractiveWarnDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Primary action: focus the chat composer; relay stays disabled. */
  onUseChat: () => void;
  /** Ghost action: grant terminal focus + enable the per-run keystroke relay. */
  onInteractAnyway: () => void;
}

/**
 * The design-specific hazard stripe (a 6px diagonal amber barber-pole). This
 * exact gradient is bespoke to the warn modal and is not a theme token, so it is
 * applied inline rather than via a Tailwind/CSS class.
 */
const HAZARD_STRIPE_STYLE: CSSProperties = {
  height: '6px',
  background:
    'repeating-linear-gradient(135deg, #d99a3d 0 6px, #c98a2d 6px 12px)',
};

export function InteractiveWarnDialog({
  isOpen,
  onClose,
  onUseChat,
  onInteractAnyway,
}: InteractiveWarnDialogProps): ReactElement {
  const handleUseChat = (): void => {
    onUseChat();
    onClose();
  };

  const handleInteractAnyway = (): void => {
    onInteractAnyway();
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      closeOnOverlayClick={true}
      showCloseButton={false}
    >
      {/* Hazard-stripe eyebrow — bespoke gradient, applied inline. */}
      <div style={HAZARD_STRIPE_STYLE} aria-hidden="true" />

      <div className="px-6 py-5">
        <div
          className="mb-3 flex items-center gap-1.5"
          style={{ color: '#a86b1d' }}
        >
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
          <span
            className="font-semibold uppercase"
            style={{ fontSize: '10px', letterSpacing: '0.18em' }}
          >
            Direct terminal access
          </span>
        </div>

        <h2
          className="font-bold text-text-primary"
          style={{ fontSize: '13.5px', lineHeight: 1.35 }}
        >
          Warning: interacting directly with the terminal can interrupt the
          running workflow.
        </h2>

        <p
          className="mt-2 text-text-secondary"
          style={{ fontSize: '11.5px', lineHeight: 1.5 }}
        >
          Keystrokes typed here go straight to the live pty session and can
          cancel the current step or break the orchestration loop. To send the
          agent a message, type it in the chat composer below instead — cyboflow
          relays it as a queued message without disturbing the running turn.
        </p>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={handleInteractAnyway}>
            Interact anyway
          </Button>
          <Button variant="primary" size="sm" onClick={handleUseChat}>
            Use chat instead
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default InteractiveWarnDialog;
