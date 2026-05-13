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
 * Rationale: the database CHECK constraint enforces "status is one of 8
 * values" but cannot enforce "this transition from A to B is legal".
 * This table is the in-process source of truth.
 */
export const ALLOWED_TRANSITIONS: Record<
  WorkflowRunStatus,
  readonly WorkflowRunStatus[]
> = {
  queued:          ['starting', 'canceled'],
  starting:        ['running', 'failed', 'canceled'],
  running:         ['awaiting_review', 'completed', 'failed', 'canceled', 'stuck'],
  awaiting_review: ['running', 'canceled', 'stuck', 'failed'],
  stuck:           ['running', 'canceled', 'failed'],
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
  return (ALLOWED_TRANSITIONS[from] as readonly WorkflowRunStatus[]).includes(to);
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
