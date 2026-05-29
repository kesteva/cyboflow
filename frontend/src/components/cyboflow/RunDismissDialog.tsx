import { useCallback } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ConfirmDialog } from '../ConfirmDialog';
import { trpc } from '../../trpc/client';
import { useErrorStore } from '../../stores/errorStore';

interface RunDismissDialogProps {
  isOpen: boolean;
  onClose: () => void;
  runId: string;
  onSuccess?: () => void;
}

/**
 * Run-scoped twin of SessionDismissDialog (GAP-B). Removes the workflow run's
 * worktree and marks the run canceled via `cyboflow.runs.dismiss`, discarding
 * any unmerged changes.
 */
export function RunDismissDialog({ isOpen, onClose, runId, onSuccess }: RunDismissDialogProps) {
  const handleConfirm = useCallback(() => {
    void trpc.cyboflow.runs.dismiss
      .mutate({ runId })
      .then(() => {
        onSuccess?.();
      })
      .catch((err: unknown) => {
        useErrorStore.getState().showError({
          title: 'Dismiss failed',
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, [runId, onSuccess]);

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={handleConfirm}
      title="Dismiss run?"
      message="Any unmerged changes in this run's worktree will be lost. The worktree will be permanently removed. This cannot be undone."
      confirmText="Dismiss"
      cancelText="Cancel"
      confirmButtonClass="bg-status-error hover:bg-status-error text-white"
      icon={<AlertTriangle className="w-6 h-6 text-status-error" />}
    />
  );
}
