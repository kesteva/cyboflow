import { useCallback } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ConfirmDialog } from '../ConfirmDialog';
import { API } from '../../utils/api';
import { useErrorStore } from '../../stores/errorStore';

interface SessionDismissDialogProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;
  onSuccess?: () => void;
}

export function SessionDismissDialog({ isOpen, onClose, sessionId, onSuccess }: SessionDismissDialogProps) {
  const handleConfirm = useCallback(() => {
    void API.sessions.delete(sessionId).then((result) => {
      // Honor the IPC result: a failed delete (e.g. "Session is already archived")
      // must NOT fire the success toast — otherwise the caller shows "Session
      // dismissed" while nothing changed.
      if (result.success) {
        onSuccess?.();
      } else {
        useErrorStore.getState().showError({
          title: 'Dismiss failed',
          error: result.error ?? 'Unknown error',
        });
      }
    }).catch((err: unknown) => {
      useErrorStore.getState().showError({
        title: 'Dismiss failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, [sessionId, onSuccess]);

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={handleConfirm}
      title="Dismiss session?"
      message="Any unmerged changes in this session will be lost. The worktree will be permanently removed and the session archived. This cannot be undone."
      confirmText="Dismiss"
      cancelText="Cancel"
      confirmButtonClass="bg-status-error hover:bg-status-error text-white"
      icon={<AlertTriangle className="w-6 h-6 text-status-error" />}
    />
  );
}
