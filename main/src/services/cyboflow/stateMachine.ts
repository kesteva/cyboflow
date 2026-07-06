import type { WorkflowRunStatus } from '../../../../shared/types/cyboflow';

/**
 * Allowed state transitions for `workflow_runs.status`, per
 * `docs/cyboflow_system_design.md` §5.3.
 *
 * Source state -> set of target states it may transition to.
 * Terminal states (completed, failed, canceled) map to an empty set:
 * once a run reaches a terminal state, NO further transitions are legal —
 * not even same-status no-ops (e.g. completed -> completed is rejected).
 *
 * Rationale: the database CHECK constraint enforces "status is one of 10
 * values" but cannot enforce "this transition from A to B is legal".
 * This table is the in-process source of truth.
 *
 * `failed` is terminal to THIS state machine — but four sanctioned recovery
 * paths revive a failed (or, for retry, a resting awaiting_review) run
 * anyway, via a guarded raw `UPDATE workflow_runs SET status = ...` that
 * deliberately bypasses `assertTransitionAllowed` rather than widening the
 * table above: (1) runRecovery.recoverActiveStateOrphans (boot sweep, resets
 * stranded programmatic runs to 'starting'), (2) reopenRunHandler (SDK-only
 * failed -> running via --resume), (3) reviveQuickRunToRunning
 * (transitions.ts — quick-session sentinel run repair), and (4)
 * retryRunHandler (failed/resting-awaiting_review -> starting at a chosen
 * step, programmatic-only). Each is a narrow, explicitly-reasoned escape
 * hatch, not a general exception to terminality.
 */
export const ALLOWED_TRANSITIONS: Record<
  WorkflowRunStatus,
  readonly WorkflowRunStatus[]
> = {
  queued:          ['starting', 'canceled'],
  starting:        ['running', 'failed', 'canceled'],
  // running -> awaiting_input: the only way to enter awaiting_input — QuestionRouter
  // transitions atomically with the question INSERT (TASK-758).
  // running -> paused: SDK-only Pause from a live turn (Phase 4b). The active turn
  //   stops but claude_session_id + current_step_id are preserved for Resume.
  running:         ['awaiting_review', 'awaiting_input', 'completed', 'failed', 'canceled', 'stuck', 'paused'],
  // awaiting_review -> completed: the user accepted the run's artifact (Merge or
  //   Create-PR). The executor never auto-completes; a run RESTS in awaiting_review
  //   on SDK drain and only the user's accept decision drives it to completed.
  // awaiting_review -> running: existing approval cycle — an in-flight tool approval
  //   resolves back to running (transitionFromAwaitingReview).
  // awaiting_review -> paused: SDK-only Pause from an idle-rested run (Phase 4b).
  awaiting_review: ['running', 'completed', 'canceled', 'stuck', 'failed', 'paused'],
  // awaiting_input -> running: symmetric return when QuestionRouter.respond resolves.
  // awaiting_input -> canceled: user/system cancellation while a question is in flight.
  // awaiting_input -> failed: defensive — SDK loop crashed mid-question.
  // awaiting_input -> stuck is intentionally NOT allowed: per IDEA-025 Q2 resolution,
  // awaiting_input runs are exempt from stuck classification.
  awaiting_input:  ['running', 'canceled', 'failed'],
  // stuck -> completed: the user accepted the artifact of a run that the
  //   StuckDetector flagged (e.g. an orphaned PTY) but whose worktree still holds
  //   deliverable work. Merge / Create-PR is valid from a stuck run.
  stuck:           ['running', 'completed', 'canceled', 'failed'],
  // paused (Phase 4b, SDK-only, NON-terminal):
  //   paused -> running: Resume re-drives via the SDK --resume path
  //     (transitionPausedToRunning).
  //   paused -> canceled / failed: a paused run can still be canceled or fail.
  //   No paused -> completed/awaiting_review edge: Resume returns to 'running'
  //     first; the run rests/completes from there.
  paused:          ['running', 'canceled', 'failed'],
  completed:       [],
  failed:          [],
  canceled:        [],
};

/**
 * Pure predicate: is the (from -> to) transition allowed?
 * Returns false for any transition out of a terminal state, including
 * same-status no-ops.
 */
export function isTransitionAllowed(
  from: WorkflowRunStatus,
  to: WorkflowRunStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Typed error thrown when an illegal transition is attempted. Carries the
 * from/to states and the optional runId so callers can log a tight
 * forensic line without re-stringifying.
 */
export class IllegalTransitionError extends Error {
  public readonly from: WorkflowRunStatus;
  public readonly to: WorkflowRunStatus;
  public readonly runId: string | undefined;

  constructor(
    from: WorkflowRunStatus,
    to: WorkflowRunStatus,
    runId?: string,
  ) {
    const suffix = runId !== undefined ? ` (runId=${runId})` : '';
    super(`Illegal workflow_run status transition: ${from} -> ${to}${suffix}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
    this.runId = runId;
  }
}

/**
 * Assert variant: throws `IllegalTransitionError` if the transition is
 * not in `ALLOWED_TRANSITIONS`. Use this at the head of every code path
 * that issues an `UPDATE workflow_runs SET status = ?` statement.
 */
export function assertTransitionAllowed(
  from: WorkflowRunStatus,
  to: WorkflowRunStatus,
  runId?: string,
): void {
  if (!isTransitionAllowed(from, to)) {
    throw new IllegalTransitionError(from, to, runId);
  }
}
