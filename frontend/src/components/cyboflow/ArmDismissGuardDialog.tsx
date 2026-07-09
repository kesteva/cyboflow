import { useCallback, useEffect, useState } from 'react';
import { FlaskConical, X } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useErrorStore } from '../../stores/errorStore';
import type { ExperimentArm, ExperimentStatus } from '../../../../shared/types/experiments';

interface ArmDismissGuardDialogProps {
  isOpen: boolean;
  onClose: () => void;
  experimentId: string;
  /** Which arm the session-to-dismiss is (from the matched session column). */
  arm: ExperimentArm;
  /** The live status that triggered the guard — 'running' or 'grading'. */
  status: ExperimentStatus;
  /** Enriched display name (e.g. 'sprint A/B · fast-mode'); best-effort, optional. */
  experimentName?: string;
  /**
   * Proceed with the ORIGINAL session-dismiss continuation (dismiss THIS arm
   * only, leaving the other arm + experiment intact). The caller wires this to
   * the unchanged dismiss path.
   */
  onDismissArm: () => void;
}

/**
 * Guard shown when the user tries to dismiss a session that is one arm of a LIVE
 * A/B experiment (status 'running' | 'grading'). Silently tearing down half an
 * experiment strands it in 'grading' and mints an unresolvable blocking review
 * item — so we intercept and offer the three coherent choices instead.
 *
 * Structure/styling mirror RunCancelDialog → ConfirmDialog (fixed overlay,
 * bg-surface-primary card, danger primary), extended to THREE actions because a
 * two-button confirm cannot express "cancel the whole experiment" vs. "dismiss
 * just this arm" vs. "keep everything".
 *
 *   [Cancel whole experiment]  danger — experiments.abandon; the route dismisses
 *                              BOTH arm sessions + cleans the reports server-side,
 *                              so we do NOT run the normal session-delete path.
 *   [Dismiss only this arm]    → onDismissArm (the unchanged dismiss continuation).
 *   [Keep]                     → onClose; nothing happens.
 */
export function ArmDismissGuardDialog({
  isOpen,
  onClose,
  experimentId,
  arm,
  status,
  experimentName,
  onDismissArm,
}: ArmDismissGuardDialogProps) {
  const [abandoning, setAbandoning] = useState(false);

  // Escape closes the guard (parity with ConfirmDialog). Enter is intentionally
  // NOT bound — with three actions there is no unambiguous default.
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const handleAbandon = useCallback(() => {
    setAbandoning(true);
    // abandon tears down BOTH arms (dismisses both sessions server-side) and
    // resolves the experiment's reports — so on success we just close; we never
    // run the normal session-delete continuation.
    void trpc.cyboflow.experiments.abandon
      .mutate({ experimentId })
      .then(() => {
        setAbandoning(false);
        onClose();
      })
      .catch((err: unknown) => {
        setAbandoning(false);
        useErrorStore.getState().showError({
          title: 'Cancel experiment failed',
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, [experimentId, onClose]);

  if (!isOpen) return null;

  const experimentPhrase =
    status === 'grading' ? 'an A/B experiment awaiting its verdict' : 'a running A/B experiment';

  return (
    <div className="fixed inset-0 bg-modal-overlay flex items-center justify-center z-50">
      <div className="bg-surface-primary rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center space-x-3">
            <div className="flex-shrink-0">
              <FlaskConical className="w-6 h-6 text-status-warning" />
            </div>
            <h3 className="text-lg font-medium text-text-primary">
              This session is arm {arm} of {experimentPhrase}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-secondary transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="mb-6 space-y-2">
          {experimentName && (
            <p className="text-sm font-medium text-text-secondary">{experimentName}</p>
          )}
          <p className="text-text-secondary leading-relaxed">
            Dismissing just this arm leaves the experiment ungraded — it can never reach a verdict
            with an arm torn out. Cancel the whole experiment to tear down both arms and clean up
            its reports, or dismiss only this arm and leave the other running.
          </p>
        </div>

        <div className="flex justify-end space-x-3">
          <button
            onClick={onClose}
            disabled={abandoning}
            className="px-4 py-2 text-sm font-medium text-text-secondary bg-bg-tertiary hover:bg-bg-hover rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            Keep
          </button>
          <button
            onClick={onDismissArm}
            disabled={abandoning}
            className="px-4 py-2 text-sm font-medium text-text-secondary bg-bg-tertiary hover:bg-bg-hover rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            Dismiss only this arm
          </button>
          <button
            onClick={handleAbandon}
            disabled={abandoning}
            className="px-4 py-2 text-sm font-medium rounded-md transition-colors bg-status-error hover:bg-status-error text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {abandoning ? 'Canceling…' : 'Cancel whole experiment'}
          </button>
        </div>
      </div>
    </div>
  );
}
