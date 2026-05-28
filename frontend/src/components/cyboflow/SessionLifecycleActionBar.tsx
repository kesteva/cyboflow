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

  // Merge/PR are disabled while the work is still in flight. For a session that
  // is its status === 'running'; for a workflow run it is any non-terminal,
  // non-completed status (still executing or awaiting human triage).
  const isRunning =
    target.kind === 'session'
      ? target.session.status === 'running'
      : target.status !== 'completed' && target.status !== 'failed' && target.status !== 'canceled';

  // Create-PR currently has no run-scoped close-out (it needs the session-only
  // gitPush / getRemoteUrl surface — see GAP-B report). Offer it for sessions
  // only; runs surface Merge + Dismiss.
  const showCreatePr = target.kind === 'session';

  return (
    <div className="flex items-center gap-1.5" data-testid="session-lifecycle-action-bar">
      <div className="mx-2 h-4 w-px bg-border-primary" />

      <button
        data-testid="session-action-merge"
        disabled={isRunning}
        onClick={onMerge}
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        title={isRunning ? 'Stop the session before merging' : 'Merge changes into base branch'}
      >
        <GitMerge size={14} />
        Merge
      </button>

      {showCreatePr && (
        <button
          data-testid="session-action-create-pr"
          disabled={isRunning}
          onClick={onCreatePR}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          title={isRunning ? 'Stop the session before creating a PR' : 'Create a pull request'}
        >
          <ExternalLink size={14} />
          Create PR
        </button>
      )}

      <button
        data-testid="session-action-dismiss"
        onClick={onDismiss}
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
        title="Dismiss this session and remove its worktree"
      >
        <Trash2 size={14} />
        Dismiss
      </button>
    </div>
  );
}
