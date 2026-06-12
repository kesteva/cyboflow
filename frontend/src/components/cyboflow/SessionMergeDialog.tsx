import { useState, useCallback, useEffect } from 'react';
import { GitMerge, GitBranch } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Textarea } from '../ui/Textarea';
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

  useEffect(() => {
    if (isOpen) {
      setStrategy(null);
      setCommitMessage('');
      setIsMerging(false);
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

    try {
      const result = strategy === 'squash'
        ? await API.sessions.squashAndRebaseToMain(sessionId, commitMessage.trim())
        : await API.sessions.rebaseToMain(sessionId);

      if (!result.success) {
        useErrorStore.getState().showError({
          title: 'Merge failed',
          error: result.error ?? 'An unknown error occurred during merge.',
          details: result.details,
          command: result.command,
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
