/**
 * FlowNameDialog — a small in-app name-entry dialog for the workflow editor.
 *
 * Replaces window.prompt() (which throws "prompt() is not supported." in
 * Electron's renderer) with a controlled-text-input Modal. Follows the
 * NewTaskDialog pattern: managed name/error state, trim + non-empty validation
 * with an inline error. Enter = confirm / Esc = cancel are handled by Modal's
 * keyboard handling.
 */
import { useEffect, useState } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../ui/Modal';

interface FlowNameDialogProps {
  isOpen: boolean;
  title: string;
  defaultValue: string;
  confirmLabel: string;
  /** Called with the trimmed, validated (non-empty) name. */
  onConfirm: (name: string) => void;
  onClose: () => void;
}

export function FlowNameDialog({
  isOpen,
  title,
  defaultValue,
  confirmLabel,
  onConfirm,
  onClose,
}: FlowNameDialogProps): React.JSX.Element {
  const [name, setName] = useState(defaultValue);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the input each time the dialog (re)opens, so a fresh open never
  // shows the previous entry.
  useEffect(() => {
    if (isOpen) {
      setName(defaultValue);
      setError(null);
    }
  }, [isOpen, defaultValue]);

  const handleConfirm = (): void => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError('A workflow name is required.');
      return;
    }
    onConfirm(trimmed);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm">
      <ModalHeader>{title}</ModalHeader>
      <ModalBody>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
            Name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleConfirm();
                }
              }}
              placeholder="flow name"
              className="rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text placeholder:text-input-placeholder"
              aria-label="Workflow name"
              data-testid="flow-name-input"
              autoFocus
            />
          </label>

          {error && (
            <p className="text-xs text-status-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <button
          type="button"
          onClick={onClose}
          className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover"
          data-testid="flow-name-cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={name.trim().length === 0}
          className="rounded-button bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="flow-name-confirm"
        >
          {confirmLabel}
        </button>
      </ModalFooter>
    </Modal>
  );
}
