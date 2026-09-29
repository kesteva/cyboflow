import { useState, useCallback, useEffect } from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { ConfirmDialog } from '../ConfirmDialog';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { API } from '../../utils/api';
import { useErrorStore } from '../../stores/errorStore';

// How long we wait on the delivery-state probe before failing open to the
// plain confirm. The probe shells out to several git subprocesses
// (merge-base --fork-point, two rev-list --count, git cherry, git diff) — a
// wedged one must not leave the dialog stuck on a spinner forever.
const PROBE_TIMEOUT_MS = 3000;

type ProbeState = 'loading' | 'delivered' | 'completedNoCode' | 'plain';

interface SessionDismissDialogProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;
  // `completed` distinguishes "marked complete then dismissed" from a plain
  // dismiss so the caller (CyboflowRoot) can show a different toast.
  // `result.tasksMovedToDone` (TASK-296) is only set on the landed close-out
  // path — how many integrated sprint-lane tasks the close-out just moved to
  // Done. `result.laneTasksLeftOpen` is the complement: set when the session
  // has its own commits not (yet) on main, so the close-out stamped
  // bookkeeping only and left those lane tasks open.
  onSuccess?: (completed?: boolean, result?: { tasksMovedToDone?: number; laneTasksLeftOpen?: number }) => void;
}

export function SessionDismissDialog({ isOpen, onClose, sessionId, onSuccess }: SessionDismissDialogProps) {
  // Four-state, NOT boolean: 'loading' is not a cosmetic spinner — it is what
  // stops a fast click from taking the destructive path before we actually
  // know whether this session's work already landed. If we rendered the
  // plain ConfirmDialog (enabled Dismiss button) while the probe is still in
  // flight, a user who opens Dismiss and clicks immediately would destroy
  // exactly the findings this whole flow exists to preserve — the probe's
  // subprocess chain is plausibly 200-800ms on a real repo, so that window is
  // real, not theoretical. Only a DEFINITE delivered/landed=true unlocks the
  // 'delivered' three-way choice; 'completedNoCode' unlocks the SAME choice
  // with different copy for a DB-only run (Planner/Launch) that produced no
  // commits; a resolved-false probe, a rejected probe, OR the watchdog below
  // all land on 'plain' — the existing ConfirmDialog, unchanged.
  const [probeState, setProbeState] = useState<ProbeState>('loading');
  const [isStamping, setIsStamping] = useState(false);
  // TASK-296: how many integrated sprint-lane tasks Mark-complete would move
  // to Done — only ever nonzero when the probe reported `landed`. Drives the
  // Mark-complete button copy ("Mark complete (moves N tasks to Done)").
  const [laneTaskCount, setLaneTaskCount] = useState(0);

  useEffect(() => {
    if (!isOpen) {
      setProbeState('loading');
      setIsStamping(false);
      setLaneTaskCount(0);
      return;
    }
    let cancelled = false;

    // Watchdog: a wedged git subprocess must still fail open, not strand the
    // dialog on a spinner. Cleared as soon as the probe actually settles.
    const watchdog = setTimeout(() => {
      if (!cancelled) setProbeState('plain');
    }, PROBE_TIMEOUT_MS);

    API.sessions.getDeliveryState(sessionId)
      .then((result) => {
        if (cancelled) return;
        clearTimeout(watchdog);
        if (result.success && result.data && (result.data.delivered || result.data.landed)) {
          setProbeState('delivered');
          setLaneTaskCount(result.data.integratedLaneCount ?? 0);
        } else if (result.success && result.data && result.data.completedNoCode) {
          setProbeState('completedNoCode');
        } else {
          setProbeState('plain');
        }
      })
      .catch(() => {
        if (cancelled) return;
        clearTimeout(watchdog);
        // Fail open — the plain confirm still works even if the probe errors.
        setProbeState('plain');
      });

    return () => {
      cancelled = true;
      clearTimeout(watchdog);
    };
  }, [isOpen, sessionId]);

  // Shared delete step, used by both the plain confirm and "Dismiss anyway".
  const runDelete = useCallback((onComplete?: () => void) => {
    void API.sessions.delete(sessionId).then((result) => {
      // Honor the IPC result: a failed delete (e.g. "Session is already archived")
      // must NOT fire the success toast — otherwise the caller shows "Session
      // dismissed" while nothing changed.
      if (result.success) {
        onSuccess?.();
        onComplete?.();
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

  const handlePlainConfirm = useCallback(() => {
    runDelete();
  }, [runDelete]);

  const handleDismissAnyway = useCallback(() => {
    runDelete(onClose);
  }, [runDelete, onClose]);

  const handleMarkComplete = useCallback(async () => {
    setIsStamping(true);
    try {
      const stampResult = await API.sessions.markComplete(sessionId);
      if (!stampResult.success) {
        // Do NOT delete on a failed stamp — dismissing anyway would silently
        // destroy the findings this whole flow exists to preserve.
        useErrorStore.getState().showError({
          title: 'Mark complete failed',
          error: stampResult.error ?? 'Unknown error',
        });
        return;
      }
      const deleteResult = await API.sessions.delete(sessionId);
      if (deleteResult.success) {
        onSuccess?.(true, {
          tasksMovedToDone: stampResult.data.tasksMovedToDone,
          laneTasksLeftOpen: stampResult.data.laneTasksLeftOpen,
        });
        onClose();
      } else {
        useErrorStore.getState().showError({
          title: 'Dismiss failed',
          error: deleteResult.error ?? 'Unknown error',
        });
      }
    } catch (err) {
      useErrorStore.getState().showError({
        title: 'Mark complete failed',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsStamping(false);
    }
  }, [sessionId, onSuccess, onClose]);

  if (probeState === 'loading') {
    // No destructive control here on purpose — see the probeState comment
    // above. Cancel is the only action; it's non-destructive either way.
    return (
      <Modal isOpen={isOpen} onClose={onClose} size="sm">
        <div className="p-6" data-testid="dismiss-probe-loading">
          <div className="flex items-center gap-3 mb-4">
            <Loader2 className="w-5 h-5 text-text-secondary animate-spin flex-shrink-0" />
            <h3 className="text-lg font-medium text-text-primary">Checking session...</h3>
          </div>
          <p className="text-text-secondary leading-relaxed mb-6">
            Checking whether this session's work already landed in the main branch before
            offering to dismiss it.
          </p>
          <div className="flex justify-end">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  if (probeState === 'delivered') {
    return (
      <Modal isOpen={isOpen} onClose={onClose} size="sm">
        <div className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <CheckCircle2 className="w-6 h-6 text-status-success flex-shrink-0" />
            <h3 className="text-lg font-medium text-text-primary">This session's work looks merged</h3>
          </div>
          <p className="text-text-secondary leading-relaxed mb-6">
            This session's changes already appear to be in the main branch. Mark complete keeps
            the findings its runs produced — they describe code that is now in the tree. Dismiss
            anyway discards those findings along with the session.
          </p>
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={isStamping}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={handleDismissAnyway}
              disabled={isStamping}
            >
              Dismiss anyway
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleMarkComplete()}
              loading={isStamping}
              loadingText="Marking complete..."
            >
              {laneTaskCount > 0 ? `Mark complete (moves ${laneTaskCount} tasks to Done)` : 'Mark complete'}
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  if (probeState === 'completedNoCode') {
    return (
      <Modal isOpen={isOpen} onClose={onClose} size="sm">
        <div className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <CheckCircle2 className="w-6 h-6 text-status-success flex-shrink-0" />
            <h3 className="text-lg font-medium text-text-primary">This session's run already completed</h3>
          </div>
          <p className="text-text-secondary leading-relaxed mb-6">
            This session's run completed without changing the repository — its work lives in the
            backlog. Mark complete keeps its findings; Dismiss anyway discards them.
          </p>
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={isStamping}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={handleDismissAnyway}
              disabled={isStamping}
            >
              Dismiss anyway
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleMarkComplete()}
              loading={isStamping}
              loadingText="Marking complete..."
            >
              Mark complete
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={onClose}
      onConfirm={handlePlainConfirm}
      title="Dismiss session?"
      message="Any unmerged changes in this session will be lost. The worktree will be permanently removed and the session archived. This cannot be undone."
      confirmText="Dismiss"
      cancelText="Cancel"
      confirmButtonClass="bg-status-error hover:bg-status-error text-white"
      icon={<AlertTriangle className="w-6 h-6 text-status-error" />}
    />
  );
}
