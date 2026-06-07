import { useCallback } from 'react';
import { Flag } from 'lucide-react';
import { ConfirmDialog } from '../ConfirmDialog';

interface RunEndDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** The finished run's terminal status, used only to tailor the copy. */
  status?: string;
  /** Fired when the operator confirms ending the workflow. */
  onConfirm: () => void;
}

/**
 * End-of-workflow confirmation (session<->run restructure).
 *
 * Cancel already has its own human gate (RunCancelDialog). A run that reaches a
 * terminal status on its OWN — completed or failed — gets this explicit "end
 * workflow" step before the centre pane drops back to the session's resting view
 * (the QuickSessionCanvas). It is purely a navigation confirmation: the run is
 * already terminal, so confirming touches NO backend state — it just hands the
 * session back to the operator (who can start another workflow, or merge / PR /
 * dismiss the session). Nothing is merged or deleted; the worktree is preserved.
 */
export function RunEndDialog({ isOpen, onClose, status, onConfirm }: RunEndDialogProps) {
  const failed = status === 'failed';

  const handleConfirm = useCallback(() => {
    onConfirm();
  }, [onConfirm]);

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={handleConfirm}
      title={failed ? 'End this failed workflow?' : 'End this workflow?'}
      message={
        failed
          ? 'The run has stopped. Returning to the session keeps its worktree and diff — you can start another workflow or review and merge / dismiss the session.'
          : 'The workflow is complete. Return to the session to start another workflow, or review and merge / dismiss it. Its worktree and diff are preserved.'
      }
      confirmText="End workflow"
      cancelText="Stay on workflow"
      confirmButtonClass="bg-interactive hover:bg-interactive-hover text-text-on-interactive"
      icon={<Flag className="w-6 h-6 text-interactive" />}
    />
  );
}
