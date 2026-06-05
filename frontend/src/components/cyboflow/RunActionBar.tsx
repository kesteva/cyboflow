import { Square } from 'lucide-react';
import { useActiveRunsStore } from '../../stores/activeRunsStore';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { TERMINAL_RUN_STATUSES } from '../../../../shared/types/cyboflow';

interface RunActionBarProps {
  /**
   * Open the git-neutral Cancel confirm. Wired by CyboflowRoot to a `setState`
   * that mounts RunCancelDialog. The bar itself owns no dialog state so the
   * dialog can survive the run going terminal (activeRunsStore reacts and the
   * bar unmounts, but the dialog lives in CyboflowRoot).
   */
  onCancel: () => void;
}

/**
 * RunActionBar — RUN-scoped lifecycle controls (session<->run restructure,
 * Phase 4a). DISTINCT from SessionLifecycleActionBar (the SESSION close-out:
 * Merge / PR / Dismiss, which own the worktree/git lifecycle).
 *
 * This pass renders ONLY a git-neutral 'Cancel run' button — Pause / Resume are
 * deferred to a later pass. Cancel stops the agent and marks the run 'canceled'
 * WITHOUT touching git (the session + worktree are preserved).
 *
 * The active run + its status are resolved from activeRunsStore by the
 * activeRunId in cyboflowStore. The bar renders nothing unless there is an
 * active, NON-terminal run (workflow runs in a terminal status — canceled /
 * failed / completed — have nothing to cancel). Status stays fresh via
 * activeRunsStore's onRunStatusChanged subscription, so the bar disappears on
 * its own once Cancel lands.
 */
export function RunActionBar({ onCancel }: RunActionBarProps) {
  const activeRunId = useCyboflowStore((s) => s.activeRunId);
  const runsByProject = useActiveRunsStore((s) => s.runsByProject);

  if (activeRunId === null) return null;

  // Resolve the active run across every tracked project (the rail is keyed by
  // project, but the active run is unique by id).
  let status: string | undefined;
  for (const runs of Object.values(runsByProject)) {
    const run = runs.find((r) => r.id === activeRunId);
    if (run) {
      status = run.status;
      break;
    }
  }

  // Hide entirely when the run isn't in the store (e.g. a legacy parentless run
  // not surfaced here) or has already reached a terminal status — there is
  // nothing to cancel.
  if (status === undefined) return null;
  if ((TERMINAL_RUN_STATUSES as readonly string[]).includes(status)) return null;

  return (
    <div className="flex items-center gap-1.5" data-testid="run-action-bar">
      <span className="text-xs font-medium uppercase tracking-wide text-text-muted">Run</span>

      <button
        data-testid="run-action-cancel"
        onClick={onCancel}
        className="inline-flex items-center gap-1 rounded border border-border-primary px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-status-error"
        title="Stop the agent and cancel this run (git-neutral — the session and worktree are preserved)"
      >
        <Square size={14} />
        Cancel run
      </button>

      {/* Trailing divider separating the RUN grouping from the SESSION close-out
          bar. Lives inside RunActionBar so it self-hides together with the bar
          (no dangling divider when there's no cancelable run). */}
      <div className="mx-2 h-4 w-px bg-border-primary" />
    </div>
  );
}
