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

  // Merge / Create-PR accept the run's artifact. They are offered only once the
  // work is finished and awaiting the user's decision:
  //   - session: status === 'running' is still in flight → disabled while running.
  //   - run: only a finished/awaiting-decision run (awaiting_review or stuck) may
  //     be accepted. The executor never auto-completes; a clean drain rests the
  //     run in awaiting_review. running / starting / queued / awaiting_input are
  //     still executing, so accept is disabled.
  const acceptDisabled =
    target.kind === 'session'
      ? target.session.status === 'running'
      : !(target.status === 'awaiting_review' || target.status === 'stuck');

  // Create-PR is now available for runs too (cyboflow.runs.createPr — GAP-B
  // un-defer). Both surfaces offer Merge + Create-PR + Dismiss.
  const showCreatePr = true;

  return (
    <div className="flex items-center gap-1.5" data-testid="session-lifecycle-action-bar">
      <div className="mx-2 h-4 w-px bg-border-primary" />

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

      {showCreatePr && (
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
        title="Dismiss this session and remove its worktree"
      >
        <Trash2 size={14} />
        Dismiss
      </button>
    </div>
  );
}
