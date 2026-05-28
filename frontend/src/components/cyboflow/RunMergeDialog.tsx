import { useState, useCallback, useEffect } from 'react';
import { GitMerge, GitBranch } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Textarea } from '../ui/Textarea';
import { trpc } from '../../trpc/client';
import { useErrorStore } from '../../stores/errorStore';
import { cn } from '../../utils/cn';

type MergeStrategy = 'squash' | 'preserve';

interface RunMergeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  runId: string;
  onSuccess?: () => void;
}

/**
 * Run-scoped twin of SessionMergeDialog (GAP-B). Drives the squash / preserve
 * choice for a planner / workflow run, calling `cyboflow.runs.merge` (which
 * merges the run's worktree into main, removes the worktree, and marks the run
 * completed) instead of the session-scoped `sessions:*` merge IPC.
 */
export function RunMergeDialog({ isOpen, onClose, runId, onSuccess }: RunMergeDialogProps) {
  const [strategy, setStrategy] = useState<MergeStrategy | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [isMerging, setIsMerging] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setStrategy(null);
      setCommitMessage('');
      setIsMerging(false);
    }
  }, [isOpen]);

  const canConfirm = strategy !== null && (strategy === 'preserve' || commitMessage.trim().length > 0);

  const handleConfirm = useCallback(async () => {
    if (!canConfirm || isMerging || strategy === null) return;
    setIsMerging(true);
    try {
      await trpc.cyboflow.runs.merge.mutate({
        runId,
        strategy,
        commitMessage: strategy === 'squash' ? commitMessage.trim() : undefined,
      });
      onSuccess?.();
      onClose();
    } catch (err) {
      useErrorStore.getState().showError({
        title: 'Merge failed',
        error: err instanceof Error ? err.message : String(err),
      });
      setIsMerging(false);
    }
  }, [canConfirm, isMerging, strategy, runId, commitMessage, onSuccess, onClose]);

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
        <h2 className="text-lg font-semibold text-text-primary mb-4">Merge run changes</h2>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <button
            data-testid="run-strategy-squash"
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
            data-testid="run-strategy-preserve"
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
          <div className="mb-4" data-testid="run-squash-commit-message">
            <Textarea
              label="Commit message"
              placeholder="Describe the changes..."
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              rows={3}
            />
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={isMerging}>
            Cancel
          </Button>
          <Button
            data-testid="run-merge-confirm"
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
