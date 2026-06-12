import { Square, Pause, Play, Flag } from 'lucide-react';
import { useActiveRunsStore } from '../../stores/activeRunsStore';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useErrorStore } from '../../stores/errorStore';
import { useReviewQueueStore } from '../../stores/reviewQueueStore';
import { useAggregatedReviewItems } from '../../stores/landingStore';
import { trpc } from '../../trpc/client';
import { TERMINAL_RUN_STATUSES } from '../../../../shared/types/cyboflow';

/** Statuses from which an SDK run can be paused (mirrors the backend guard). */
const PAUSABLE_STATUSES: readonly string[] = ['running', 'awaiting_review'];

/**
 * Terminal statuses a run reaches on its OWN — these get the "End workflow" gate.
 * 'canceled' is deliberately excluded: a user-cancelled run returns to the
 * resting view via RunCancelDialog's own success path, so it never lingers here.
 */
const SELF_TERMINATED_STATUSES: readonly string[] = ['completed', 'failed'];

interface RunActionBarProps {
  /**
   * Open the git-neutral Cancel confirm. Wired by CyboflowRoot to a `setState`
   * that mounts RunCancelDialog. The bar itself owns no dialog state so the
   * dialog can survive the run going terminal (activeRunsStore reacts and the
   * bar unmounts, but the dialog lives in CyboflowRoot).
   */
  onCancel: () => void;
  /**
   * Open the "End workflow" confirm — the human gate that drops the centre pane
   * back to the session's resting view (QuickSessionCanvas) once a run has
   * reached a terminal status on its OWN (completed / failed). Distinct from
   * Cancel, which has its own confirm + already returns to the resting view.
   */
  onEndWorkflow: () => void;
}

/**
 * RunActionBar — RUN-scoped lifecycle controls (session<->run restructure,
 * Phase 4a + 4b). DISTINCT from SessionLifecycleActionBar (the SESSION close-out:
 * Merge / PR / Dismiss, which own the worktree/git lifecycle).
 *
 * Renders git-neutral run controls:
 *   - Cancel  (Phase 4a) — stops the agent and marks the run 'canceled' WITHOUT
 *     touching git (the session + worktree are preserved). Always available on a
 *     non-terminal run.
 *   - Pause   (Phase 4b, SDK-ONLY) — stops the active turn and parks the run in
 *     the NON-terminal 'paused' status, PRESERVING claude_session_id +
 *     current_step_id so Resume can re-drive via the SDK --resume path. Visible
 *     only while status ∈ {running, awaiting_review} AND substrate==='sdk' (an
 *     interactive run renders Pause DISABLED — the interactive substrate is
 *     fresh-session-only with no native --resume). Single-click, no confirm
 *     dialog (it's reversible). A benign noOp is treated as success (NOT
 *     error-toasted); only a rejected promise surfaces an error.
 *   - Resume  (Phase 4b, SDK-ONLY) — flips a 'paused' SDK run back to running and
 *     re-drives via --resume. Visible only while status==='paused'.
 *
 * The active run + its status/substrate are resolved from activeRunsStore by the
 * activeRunId in cyboflowStore. The bar renders nothing unless there is an
 * active, NON-terminal run (workflow runs in a terminal status — canceled /
 * failed / completed — have nothing to act on; 'paused' is non-terminal so the
 * bar stays mounted with the Resume affordance). Status stays fresh via
 * activeRunsStore's onRunStatusChanged subscription, so the controls update
 * reactively on pause/resume/cancel — NO optimistic local state.
 */
export function RunActionBar({ onCancel, onEndWorkflow }: RunActionBarProps) {
  const activeRunId = useCyboflowStore((s) => s.activeRunId);
  const runsByProject = useActiveRunsStore((s) => s.runsByProject);
  // Open-gate probe for the rested-run End-workflow affordance (hooks must run
  // unconditionally, before the early returns below). A run with a pending
  // permission approval or a blocking review item is gated — ending it would
  // silently bypass the gate, so the button hides (the backend rejects too).
  const approvals = useReviewQueueStore((s) => s.queue);
  const aggregatedReviewItems = useAggregatedReviewItems();

  if (activeRunId === null) return null;

  // Resolve the active run across every tracked project (the rail is keyed by
  // project, but the active run is unique by id). We need both its status and
  // its substrate ('sdk' | 'interactive') to gate the SDK-only Pause/Resume.
  let status: string | undefined;
  let substrate: string | undefined;
  for (const runs of Object.values(runsByProject)) {
    const run = runs.find((r) => r.id === activeRunId);
    if (run) {
      status = run.status;
      substrate = run.substrate;
      break;
    }
  }

  // Hide entirely when the run isn't in the store (e.g. a legacy parentless run
  // not surfaced here).
  if (status === undefined) return null;

  // A run that has reached a terminal status on its OWN (completed / failed) gets
  // the explicit "End workflow" gate: the human-confirmed step that drops the
  // centre pane back to the session's resting QuickSessionCanvas. The git-neutral
  // run controls (Pause / Resume / Cancel) no longer apply once terminal.
  if (SELF_TERMINATED_STATUSES.includes(status)) {
    return (
      <div className="flex items-center gap-1.5" data-testid="run-action-bar">
        <span className="text-xs font-medium uppercase tracking-wide text-text-muted">Run</span>
        <button
          data-testid="run-action-end"
          onClick={onEndWorkflow}
          className="inline-flex items-center gap-1 rounded border border-border-primary px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
          title="End this workflow and return to the session (its worktree and diff are preserved)"
        >
          <Flag size={14} />
          End workflow
        </button>
        <div className="mx-2 h-4 w-px bg-border-primary" />
      </div>
    );
  }

  // Any OTHER terminal status (canceled) has nothing to act on — Cancel already
  // returned to the resting view via its own path.
  if ((TERMINAL_RUN_STATUSES as readonly string[]).includes(status)) return null;

  // SDK-only Pause/Resume gating. The interactive substrate is fresh-session-only
  // (no native --resume), so Pause is rendered DISABLED for it and Resume never
  // applies (an interactive run never reaches 'paused').
  const isSdk = substrate === 'sdk';
  const showPause = PAUSABLE_STATUSES.includes(status) && status !== 'paused';
  const showResume = status === 'paused' && isSdk;

  // A RESTED run (clean drain → awaiting_review) with no open gate gets the
  // End-workflow affordance too: session-hosted runs have no run-scoped
  // Merge/Dismiss (the session owns git close-out), so without this a finished
  // Planner had no exit short of Cancel. Confirming completes the run via
  // runs.end and returns the pane to the resting canvas.
  const hasOpenGate =
    approvals.some((a) => a.runId === activeRunId) ||
    aggregatedReviewItems.some((it) => it.run_id === activeRunId && it.blocking);
  const showEnd = status === 'awaiting_review' && !hasOpenGate;

  // Single-click Pause — the route returns a discriminated union and NEVER throws
  // for not_found / interactive_unsupported / not_pausable / no_session / race
  // (those resolve as the benign { noOp } variant). A resolved promise is always
  // success-ish, so only a REJECTED promise (genuine transport/wiring failure,
  // e.g. METHOD_NOT_SUPPORTED if deps unwired) surfaces an error. Status updates
  // arrive reactively via activeRunsStore — no optimistic local state.
  const handlePause = () => {
    void trpc.cyboflow.runs.pause
      .mutate({ runId: activeRunId })
      .catch((err: unknown) => {
        useErrorStore.getState().showError({
          title: 'Pause failed',
          error: err instanceof Error ? err.message : String(err),
        });
      });
  };

  const handleResume = () => {
    void trpc.cyboflow.runs.resume
      .mutate({ runId: activeRunId })
      .catch((err: unknown) => {
        useErrorStore.getState().showError({
          title: 'Resume failed',
          error: err instanceof Error ? err.message : String(err),
        });
      });
  };

  return (
    <div className="flex items-center gap-1.5" data-testid="run-action-bar">
      <span className="text-xs font-medium uppercase tracking-wide text-text-muted">Run</span>

      {showEnd && (
        <button
          data-testid="run-action-end"
          onClick={onEndWorkflow}
          className="inline-flex items-center gap-1 rounded border border-border-primary px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
          title="Mark this workflow done and return to the session (its worktree and diff are preserved)"
        >
          <Flag size={14} />
          End workflow
        </button>
      )}

      {showPause && (
        <button
          data-testid="run-action-pause"
          onClick={isSdk ? handlePause : undefined}
          disabled={!isSdk}
          className="inline-flex items-center gap-1 rounded border border-border-primary px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-text-secondary"
          title={
            isSdk
              ? 'Pause this run — stops the active turn but keeps the conversation so you can Resume (git-neutral)'
              : 'Pause/Resume is SDK-only'
          }
        >
          <Pause size={14} />
          Pause
        </button>
      )}

      {showResume && (
        <button
          data-testid="run-action-resume"
          onClick={handleResume}
          className="inline-flex items-center gap-1 rounded border border-border-primary px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-status-success"
          title="Resume this paused run — continues the conversation via the SDK"
        >
          <Play size={14} />
          Resume
        </button>
      )}

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
          (no dangling divider when there's no actionable run). */}
      <div className="mx-2 h-4 w-px bg-border-primary" />
    </div>
  );
}
