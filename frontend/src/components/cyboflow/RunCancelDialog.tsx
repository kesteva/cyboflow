import { useCallback } from 'react';
import { Ban } from 'lucide-react';
import { ConfirmDialog } from '../ConfirmDialog';
import { trpc } from '../../trpc/client';
import { useErrorStore } from '../../stores/errorStore';

interface RunCancelDialogProps {
  isOpen: boolean;
  onClose: () => void;
  runId: string;
  onSuccess?: () => void;
}

/**
 * Git-neutral run-Cancel confirm (session<->run restructure, Phase 4a).
 *
 * Cancel STOPS the live agent (both substrates, routed through the substrate
 * facade server-side) and marks the run terminal ('canceled'). It is purely
 * git-neutral: it NEVER removes the worktree, merges, or deletes a branch — the
 * session and its worktree are preserved. The session-scoped close-out (Merge /
 * PR / Dismiss) is the only path that touches git.
 *
 * Result handling mirrors SessionDismissDialog: only fire `onSuccess` when the
 * call resolves successfully, and call useErrorStore().showError on a rejected
 * promise. The `cyboflow.runs.cancel` route returns a discriminated union:
 *   { success: true }                — the run was stopped + marked canceled.
 *   { noOp: true; reason }           — a benign already-done / lost-race outcome
 *                                      (e.g. a double-click) — treated as
 *                                      success-ish, NOT surfaced as an error.
 * It never throws for not_found / terminal / race, so a rejected promise is a
 * genuine transport/wiring failure and is the only case that surfaces an error.
 */
export function RunCancelDialog({ isOpen, onClose, runId, onSuccess }: RunCancelDialogProps) {
  const handleConfirm = useCallback(() => {
    void trpc.cyboflow.runs.cancel
      .mutate({ runId })
      .then((res) => {
        // The route NEVER throws for not_found / already_terminal / race — those
        // resolve as the benign { noOp } variant. Both { success:true } and the
        // { noOp } already-done/lost-race outcome are success-ish, so a resolved
        // promise always fires onSuccess. A noOp must NOT surface as an error
        // (e.g. a double-click). We read `res` only to discriminate for clarity.
        if ('success' in res || 'noOp' in res) {
          onSuccess?.();
        }
      })
      .catch((err: unknown) => {
        // A rejected promise is a genuine transport/wiring failure
        // (METHOD_NOT_SUPPORTED if deps unwired) — the only case we surface.
        useErrorStore.getState().showError({
          title: 'Cancel failed',
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, [runId, onSuccess]);

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={handleConfirm}
      title="Cancel this run?"
      message="The agent will stop. The session and its worktree are preserved — nothing is merged or deleted."
      confirmText="Cancel run"
      cancelText="Keep running"
      confirmButtonClass="bg-status-error hover:bg-status-error text-white"
      icon={<Ban className="w-6 h-6 text-status-error" />}
    />
  );
}
