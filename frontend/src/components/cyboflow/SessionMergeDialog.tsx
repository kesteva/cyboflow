import { useState, useCallback, useEffect } from 'react';
import { GitMerge, GitBranch, CheckCircle2 } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Textarea } from '../ui/Input';
import { API } from '../../utils/api';
import { useErrorStore } from '../../stores/errorStore';
import { cn } from '../../utils/cn';

type MergeStrategy = 'squash' | 'preserve';

interface SessionMergeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;
  onSuccess?: () => void;
}

export function SessionMergeDialog({ isOpen, onClose, sessionId, onSuccess }: SessionMergeDialogProps) {
  const [strategy, setStrategy] = useState<MergeStrategy | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [isMerging, setIsMerging] = useState(false);
  // Set when the merge is BLOCKED because main has advanced and a rebase is
  // needed first. Distinct from a generic merge error — shown inline so the
  // operator can rebase (via chat) and retry without losing the dialog.
  const [rebaseNotice, setRebaseNotice] = useState<string | null>(null);
  // Set when the branch had NOTHING left to merge — its work is already in
  // main, almost always because the agent merged it in chat. Not an error:
  // offer Mark complete instead of the generic "Merge failed" toast.
  const [alreadyMergedNotice, setAlreadyMergedNotice] = useState(false);
  const [isStamping, setIsStamping] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setStrategy(null);
      setCommitMessage('');
      setIsMerging(false);
      setRebaseNotice(null);
      setAlreadyMergedNotice(false);
      setIsStamping(false);
    }
  }, [isOpen]);

  // Prefill the squash message from the branch's own commit subjects: a single
  // commit becomes the message verbatim; several become a headline (oldest
  // subject) plus a bullet per remaining commit. Never clobbers user typing.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    API.sessions
      .getBranchCommitSubjects(sessionId)
      .then((result) => {
        if (cancelled || !result.success || !result.data) return;
        const subjects = [...result.data.subjects].reverse(); // newest-first → chronological
        if (subjects.length === 0) return;
        const prefill =
          subjects.length === 1
            ? subjects[0]
            : `${subjects[0]}\n\n${subjects.slice(1).map((s) => `- ${s}`).join('\n')}`;
        setCommitMessage((prev) => (prev === '' ? prefill : prev));
      })
      .catch(() => {
        // Prefill is best-effort — the dialog works with an empty message field.
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, sessionId]);

  const canConfirm = strategy !== null && (strategy === 'preserve' || commitMessage.trim().length > 0);

  const handleConfirm = useCallback(async () => {
    if (!canConfirm || isMerging) return;
    setIsMerging(true);
    setRebaseNotice(null);
    setAlreadyMergedNotice(false);

    try {
      const result = strategy === 'squash'
        ? await API.sessions.squashAndRebaseToMain(sessionId, commitMessage.trim())
        : await API.sessions.rebaseToMain(sessionId);

      if (!result.success && result.needsRebase) {
        // Merge blocked: main moved ahead. Surface inline and keep the dialog
        // open — do NOT delete the session or fire onSuccess. The operator
        // rebases the worktree (e.g. via chat), then merges again.
        setRebaseNotice(
          result.error ??
            'Main has new commits since this branch started. Rebase this worktree onto main before merging.',
        );
        setIsMerging(false);
        return;
      }

      if (!result.success && result.alreadyUpToDate) {
        // The branch has nothing left to give main — its work is already
        // there (almost always because the agent merged it in chat). This is
        // not a failure: surface the inline notice with a Mark-complete
        // action instead of the generic error toast, and keep the dialog
        // open so the operator can choose.
        setAlreadyMergedNotice(true);
        setIsMerging(false);
        return;
      }

      if (!result.success) {
        useErrorStore.getState().showError({
          title: 'Merge failed',
          error: result.error ?? 'An unknown error occurred during merge.',
        });
        setIsMerging(false);
        return;
      }

      await API.sessions.delete(sessionId);
      onSuccess?.();
      onClose();
    } catch (err) {
      useErrorStore.getState().showError({
        title: 'Merge failed',
        error: err instanceof Error ? err.message : String(err),
      });
      setIsMerging(false);
    }
  }, [canConfirm, isMerging, strategy, sessionId, commitMessage, onSuccess, onClose]);

  // The alreadyUpToDate notice's own action: stamp the session complete (so
  // the archive keeps its findings), then archive it. Order matters — see
  // API.sessions.markComplete's doc comment.
  const handleMarkComplete = useCallback(async () => {
    setIsStamping(true);
    try {
      const stampResult = await API.sessions.markComplete(sessionId);
      if (!stampResult.success) {
        useErrorStore.getState().showError({
          title: 'Mark complete failed',
          error: stampResult.error ?? 'Unknown error',
        });
        return;
      }
      const deleteResult = await API.sessions.delete(sessionId);
      if (!deleteResult.success) {
        useErrorStore.getState().showError({
          title: 'Dismiss failed',
          error: deleteResult.error ?? 'Unknown error',
        });
        return;
      }
      onSuccess?.();
      onClose();
    } catch (err) {
      useErrorStore.getState().showError({
        title: 'Mark complete failed',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsStamping(false);
    }
  }, [sessionId, onSuccess, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canConfirm && !isMerging) {
        e.preventDefault();
        void handleConfirm();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, canConfirm, isMerging, handleConfirm]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md">
      <div className="p-6">
        <h2 className="text-lg font-semibold text-text-primary mb-4">Merge session changes</h2>

        {rebaseNotice && (
          <div
            data-testid="merge-rebase-notice"
            role="alert"
            className="mb-4 flex items-start gap-2 rounded-lg border border-status-warning/40 bg-status-warning/10 p-3"
          >
            <GitBranch size={16} className="mt-0.5 flex-shrink-0 text-status-warning" />
            <div className="text-sm text-text-primary">
              <span className="font-medium">Rebase required before merging.</span>{' '}
              <span className="text-text-secondary">{rebaseNotice}</span>
            </div>
          </div>
        )}

        {alreadyMergedNotice && (
          <div
            data-testid="merge-already-up-to-date-notice"
            role="alert"
            className="mb-4 flex items-start gap-2 rounded-lg border border-status-success/40 bg-status-success/10 p-3"
          >
            <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0 text-status-success" />
            <div className="text-sm text-text-primary flex-1">
              <span className="font-medium">Nothing left to merge.</span>{' '}
              <span className="text-text-secondary">
                This branch's work is already in main. Mark the session complete to keep the
                findings its runs produced.
              </span>
              <div className="mt-2">
                <Button
                  data-testid="merge-mark-complete"
                  size="sm"
                  onClick={() => void handleMarkComplete()}
                  loading={isStamping}
                  loadingText="Marking complete..."
                >
                  Mark session complete
                </Button>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 mb-4">
          <button
            data-testid="strategy-squash"
            onClick={() => setStrategy('squash')}
            className={cn(
              'flex flex-col items-center gap-2 rounded-lg border-2 p-4 transition-colors',
              strategy === 'squash'
                ? 'border-interactive bg-interactive/10'
                : 'border-border-primary hover:border-border-secondary',
            )}
          >
            <GitMerge size={24} className="text-text-secondary" />
            <span className="text-sm font-medium text-text-primary">Squash merge</span>
            <span className="text-xs text-text-secondary text-center">Combine all commits into one</span>
          </button>

          <button
            data-testid="strategy-preserve"
            onClick={() => setStrategy('preserve')}
            className={cn(
              'flex flex-col items-center gap-2 rounded-lg border-2 p-4 transition-colors',
              strategy === 'preserve'
                ? 'border-interactive bg-interactive/10'
                : 'border-border-primary hover:border-border-secondary',
            )}
          >
            <GitBranch size={24} className="text-text-secondary" />
            <span className="text-sm font-medium text-text-primary">Preserve commits</span>
            <span className="text-xs text-text-secondary text-center">Replay all commits onto main</span>
          </button>
        </div>

        {strategy === 'squash' && (
          <div className="mb-4" data-testid="squash-commit-message">
            <Textarea
              label="Commit message"
              placeholder="Describe the changes..."
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              rows={3}
              fullWidth
              className="resize-y"
            />
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={isMerging}>
            Cancel
          </Button>
          <Button
            data-testid="merge-confirm"
            disabled={!canConfirm || isMerging}
            loading={isMerging}
            loadingText="Merging..."
            onClick={() => void handleConfirm()}
          >
            Merge
          </Button>
        </div>
      </div>
    </Modal>
  );
}
