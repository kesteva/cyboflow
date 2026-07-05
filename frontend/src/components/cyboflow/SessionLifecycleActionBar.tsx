import { GitMerge, ExternalLink, Trash2 } from 'lucide-react';
import { useLifecycleTarget } from '../../hooks/useLifecycleTarget';

interface SessionLifecycleActionBarProps {
  onMerge?: () => void;
  onCreatePR?: () => void;
  onDismiss?: () => void;
}

export function SessionLifecycleActionBar({ onMerge, onCreatePR, onDismiss }: SessionLifecycleActionBarProps) {
  const target = useLifecycleTarget();
  if (!target) return null;

  // Merge / Create-PR accept the session's artifact. They are offered only once
  // the work is finished and awaiting the user's decision — a session still
  // `running` is in flight, so accept is disabled while running. (The run-scoped
  // close-out was removed in Phase 4a; the target is always a session now.)
  const acceptDisabled = target.session.status === 'running';

  // In-place sessions work directly in the project checkout — there is no
  // worktree to merge or open a PR from, so those accept actions are hidden.
  // Dismiss stays (it just closes the session), with copy that reflects the
  // checkout is left untouched.
  const inPlace = target.session.inPlace === true;

  return (
    <div className="flex items-center gap-1.5" data-testid="session-lifecycle-action-bar">
      <div className="mx-2 h-4 w-px bg-border-primary" />

      {!inPlace && (
        <button
          data-testid="session-action-merge"
          disabled={acceptDisabled}
          onClick={onMerge}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          title={acceptDisabled ? 'Wait for the work to finish before merging' : 'Merge changes into base branch'}
        >
          <GitMerge size={14} />
          Merge
        </button>
      )}

      {!inPlace && (
        <button
          data-testid="session-action-create-pr"
          disabled={acceptDisabled}
          onClick={onCreatePR}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          title={acceptDisabled ? 'Wait for the work to finish before creating a PR' : 'Create a pull request'}
        >
          <ExternalLink size={14} />
          Create PR
        </button>
      )}

      <button
        data-testid="session-action-dismiss"
        onClick={onDismiss}
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-status-error disabled:cursor-not-allowed disabled:opacity-50"
        title={inPlace ? 'Close this session. Your project checkout is untouched.' : 'Dismiss this session and remove its worktree'}
      >
        <Trash2 size={14} />
        Dismiss
      </button>
    </div>
  );
}
