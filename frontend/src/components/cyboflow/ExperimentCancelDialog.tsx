import { useCallback, useEffect, useState } from 'react';
import { FlaskConical, X } from 'lucide-react';
import { trpc } from '../../trpc/client';

interface ExperimentCancelDialogProps {
  isOpen: boolean;
  onClose: () => void;
  experimentId: string;
  /** Display name shown in the confirm copy (e.g. "sprint A/B · terse-prompts"). */
  experimentName?: string;
  /** Fired only after `experiments.abandon` resolves — the caller refetches. */
  onSuccess?: () => void;
}

/**
 * Cancel (abandon) a running/grading A/B experiment from the rail group row's
 * context menu. Abandon tears BOTH arms down: it cancels the still-running arm
 * runs, sweeps every arm-tagged (hidden) entity, and dismisses both arm sessions
 * + worktrees — destructive, so it is gated behind this confirm.
 *
 * Unlike RunCancelDialog (which reports failures via the global errorStore), this
 * surfaces the mutation error INLINE and keeps the dialog open, so the user can
 * read the reason (e.g. a CONFLICT if the experiment already settled) without the
 * confirm vanishing. A rejected promise leaves the experiment untouched.
 */
export function ExperimentCancelDialog({
  isOpen,
  onClose,
  experimentId,
  experimentName,
  onSuccess,
}: ExperimentCancelDialogProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset transient state whenever the dialog (re)opens for a fresh experiment.
  useEffect(() => {
    if (isOpen) {
      setPending(false);
      setError(null);
    }
  }, [isOpen, experimentId]);

  const handleConfirm = useCallback(() => {
    setPending(true);
    setError(null);
    void trpc.cyboflow.experiments.abandon
      .mutate({ experimentId })
      .then(() => {
        setPending(false);
        onSuccess?.();
        onClose();
      })
      .catch((err: unknown) => {
        setPending(false);
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [experimentId, onSuccess, onClose]);

  if (!isOpen) return null;

  const target = experimentName ? `"${experimentName}"` : 'this experiment';

  return (
    <div className="fixed inset-0 bg-modal-overlay flex items-center justify-center z-50">
      <div className="bg-surface-primary rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center space-x-3">
            <div className="flex-shrink-0">
              <FlaskConical className="w-6 h-6 text-status-error" />
            </div>
            <h3 className="text-lg font-medium text-text-primary">Cancel this experiment?</h3>
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-secondary transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="mb-4">
          <p className="text-text-secondary leading-relaxed">
            Both arms of {target} will stop. Their throwaway sessions and worktrees are
            removed and every hidden arm entity is discarded — nothing is merged or kept.
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-sm text-status-error">
            {error}
          </div>
        )}

        <div className="flex justify-end space-x-3">
          <button
            onClick={onClose}
            disabled={pending}
            className="px-4 py-2 text-sm font-medium text-text-secondary bg-bg-tertiary hover:bg-bg-hover rounded-md transition-colors disabled:opacity-60"
          >
            Keep running
          </button>
          <button
            onClick={handleConfirm}
            disabled={pending}
            className="px-4 py-2 text-sm font-medium rounded-md transition-colors bg-status-error hover:bg-status-error text-white disabled:opacity-60 disabled:cursor-wait"
          >
            {pending ? 'Cancelling…' : 'Cancel experiment'}
          </button>
        </div>
      </div>
    </div>
  );
}
