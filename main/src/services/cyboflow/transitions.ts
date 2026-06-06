import type Database from 'better-sqlite3';
import type { ApprovalStatus, WorkflowRunStatus } from '../../../../shared/types/cyboflow';
import { TERMINAL_RUN_STATUSES_SQL_IN } from '../../../../shared/types/cyboflow';
import { assertTransitionAllowed } from './stateMachine';

/**
 * Thrown when a state transition is rejected because the source row was no
 * longer in the expected status (e.g. the run was canceled before the
 * approval write landed). better-sqlite3 auto-rolls back the surrounding
 * transaction when this propagates out.
 */
export class TransitionRejectedError extends Error {
  readonly code = 'TRANSITION_REJECTED' as const;
  constructor(
    message: string,
    readonly details: {
      runId: string;
      expectedStatus: WorkflowRunStatus | ApprovalStatus;
      entity: 'workflow_run' | 'approval';
    },
  ) {
    super(message);
    this.name = 'TransitionRejectedError';
  }
}

export interface TransitionToAwaitingReviewParams {
  runId: string;
  approvalId: string;
  toolName: string;
  toolInputJson: string;
  toolUseId: string;
  rationale: string | null;
}

/**
 * Atomically: (1) UPDATE workflow_runs SET status='awaiting_review' WHERE
 * id = ? AND status = 'running'; (2) INSERT INTO approvals (..., status='pending').
 * Runs inside BEGIN IMMEDIATE so the RESERVED lock is acquired up front
 * (closes the SELECT-then-INSERT race with concurrent cancellations).
 * Throws TransitionRejectedError if the UPDATE affects 0 rows; the INSERT
 * is rolled back automatically.
 */
export function transitionToAwaitingReview(
  db: Database.Database,
  params: TransitionToAwaitingReviewParams,
): void {
  const updateRun = db.prepare(
    `UPDATE workflow_runs
        SET status = 'awaiting_review', updated_at = CURRENT_TIMESTAMP
      WHERE id = @runId AND status = 'running'`,
  );
  const insertApproval = db.prepare(
    `INSERT INTO approvals
       (id, run_id, tool_name, tool_input_json, tool_use_id, rationale, status)
     VALUES
       (@approvalId, @runId, @toolName, @toolInputJson, @toolUseId, @rationale, 'pending')`,
  );

  const tx = db.transaction((p: TransitionToAwaitingReviewParams) => {
    assertTransitionAllowed('running', 'awaiting_review', p.runId);
    const result = updateRun.run({ runId: p.runId });
    if (result.changes === 0) {
      throw new TransitionRejectedError(
        `Cannot transition run ${p.runId} to awaiting_review: not in 'running' state`,
        { runId: p.runId, expectedStatus: 'running', entity: 'workflow_run' },
      );
    }
    insertApproval.run({
      approvalId: p.approvalId,
      runId: p.runId,
      toolName: p.toolName,
      toolInputJson: p.toolInputJson,
      toolUseId: p.toolUseId,
      rationale: p.rationale,
    });
  });

  tx.immediate(params);
}

// ---------------------------------------------------------------------------
// transitionToRunning
// ---------------------------------------------------------------------------

export interface TransitionToRunningParams {
  runId: string;
}

/**
 * Guarded UPDATE: workflow_runs status = 'running' WHERE id = ? AND status = 'starting'.
 * Throws TransitionRejectedError if the run is no longer in 'starting' state.
 */
export function transitionToRunning(
  db: Database.Database,
  params: TransitionToRunningParams,
): void {
  assertTransitionAllowed('starting', 'running', params.runId);
  const result = db.prepare(
    `UPDATE workflow_runs
        SET status = 'running',
            started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
            updated_at = CURRENT_TIMESTAMP
      WHERE id = @runId AND status = 'starting'`,
  ).run({ runId: params.runId });
  if (result.changes === 0) {
    throw new TransitionRejectedError(
      `Cannot transition run ${params.runId} to running: not in 'starting' state`,
      { runId: params.runId, expectedStatus: 'starting', entity: 'workflow_run' },
    );
  }
}

// ---------------------------------------------------------------------------
// transitionToCompleted
// ---------------------------------------------------------------------------

export interface TransitionToCompletedParams {
  runId: string;
  /**
   * `completed` is set ONLY by an explicit user accept decision (Merge or
   * Create-PR), never by the run executor. The run rests in `awaiting_review`
   * on SDK drain (or is `stuck`); the accept decision then completes it from
   * whatever non-terminal status it currently holds.
   *
   * 'running' is retained for the in-flight accept case (no approval pending),
   * 'awaiting_review' is the common rest-state accept, and 'stuck' covers
   * accepting a flagged-but-deliverable run — all three are in ALLOWED_TRANSITIONS.
   */
  fromStatus: 'running' | 'awaiting_review' | 'stuck';
}

/**
 * Guarded UPDATE: workflow_runs status = 'completed' WHERE id = ? AND status = @fromStatus.
 * Sets ended_at = CURRENT_TIMESTAMP on the same UPDATE.
 * Throws TransitionRejectedError if the row was not in the expected status.
 */
export function transitionToCompleted(
  db: Database.Database,
  params: TransitionToCompletedParams,
): void {
  assertTransitionAllowed(params.fromStatus, 'completed', params.runId);
  const result = db.prepare(
    `UPDATE workflow_runs
        SET status = 'completed', ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = @runId AND status = @fromStatus`,
  ).run({ runId: params.runId, fromStatus: params.fromStatus });
  if (result.changes === 0) {
    throw new TransitionRejectedError(
      `Cannot transition run ${params.runId} to completed: not in '${params.fromStatus}' state`,
      { runId: params.runId, expectedStatus: params.fromStatus, entity: 'workflow_run' },
    );
  }
}

// ---------------------------------------------------------------------------
// transitionRunningToAwaitingReview (rest transition — NO approval)
// ---------------------------------------------------------------------------

export interface TransitionRunningToAwaitingReviewParams {
  runId: string;
}

/**
 * REST transition fired by the run executor when the SDK iterator drains without
 * error: workflow_runs status = 'awaiting_review' WHERE id = ? AND status = 'running'.
 *
 * Semantics: "the agent finished its turn; the run now awaits the user's
 * Merge / Create-PR / Dismiss decision." Unlike transitionToAwaitingReview, this
 * does NOT INSERT a pending `approvals` row — it is the plain rest state, not a
 * tool-approval gate. The two awaiting_review entry points are distinguished by
 * the presence (approval gate) or absence (agent finished) of a PENDING approvals
 * row for the run.
 *
 * Guarded on status='running' so it is a safe no-op (rejected → swallowed by the
 * executor's try/catch) when the run is already parked in awaiting_review /
 * awaiting_input / stuck or has already gone terminal.
 *
 * Throws TransitionRejectedError if the run is not in 'running' state.
 */
export function transitionRunningToAwaitingReview(
  db: Database.Database,
  params: TransitionRunningToAwaitingReviewParams,
): void {
  assertTransitionAllowed('running', 'awaiting_review', params.runId);
  const result = db.prepare(
    `UPDATE workflow_runs
        SET status = 'awaiting_review', updated_at = CURRENT_TIMESTAMP
      WHERE id = @runId AND status = 'running'`,
  ).run({ runId: params.runId });
  if (result.changes === 0) {
    throw new TransitionRejectedError(
      `Cannot rest run ${params.runId} in awaiting_review: not in 'running' state`,
      { runId: params.runId, expectedStatus: 'running', entity: 'workflow_run' },
    );
  }
}

// ---------------------------------------------------------------------------
// transitionToFailed
// ---------------------------------------------------------------------------

export interface TransitionToFailedParams {
  runId: string;
  fromStatus: 'starting' | 'running' | 'awaiting_review' | 'stuck';
  errorMessage: string;
}

/**
 * Guarded UPDATE: workflow_runs status = 'failed' WHERE id = ? AND status = @fromStatus.
 * Sets error_message and ended_at = CURRENT_TIMESTAMP on the same UPDATE.
 * Throws TransitionRejectedError if the row was not in the expected status.
 */
export function transitionToFailed(
  db: Database.Database,
  params: TransitionToFailedParams,
): void {
  assertTransitionAllowed(params.fromStatus, 'failed', params.runId);
  const result = db.prepare(
    `UPDATE workflow_runs
        SET status = 'failed',
            error_message = @errorMessage,
            ended_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = @runId AND status = @fromStatus`,
  ).run({ runId: params.runId, fromStatus: params.fromStatus, errorMessage: params.errorMessage });
  if (result.changes === 0) {
    throw new TransitionRejectedError(
      `Cannot transition run ${params.runId} to failed: not in '${params.fromStatus}' state`,
      { runId: params.runId, expectedStatus: params.fromStatus, entity: 'workflow_run' },
    );
  }
}

// ---------------------------------------------------------------------------
// transitionToCanceled
// ---------------------------------------------------------------------------

export interface TransitionToCanceledParams {
  runId: string;
}

/**
 * Guarded UPDATE: workflow_runs status = 'canceled' WHERE id = ? AND status NOT IN
 * ('canceled', 'failed', 'completed'). Sets ended_at = CURRENT_TIMESTAMP.
 *
 * Design divergence from other helpers: this transition does NOT take a
 * `fromStatus` parameter because cancel is valid from ANY non-terminal source
 * state (queued, starting, running, awaiting_review, stuck). Forcing callers to
 * pass a fromStatus would require a SELECT-then-UPDATE round trip. The SQL guard
 * `status NOT IN (...)` is sufficient; assertTransitionAllowed is deliberately
 * skipped here.
 *
 * Throws TransitionRejectedError if the row is already in a terminal state
 * (canceled, failed, completed) — i.e. changes === 0.
 */
export function transitionToCanceled(
  db: Database.Database,
  params: TransitionToCanceledParams,
): void {
  const result = db.prepare(
    `UPDATE workflow_runs
        SET status = 'canceled', ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = @runId AND status NOT IN ${TERMINAL_RUN_STATUSES_SQL_IN}`,
  ).run({ runId: params.runId });
  if (result.changes === 0) {
    throw new TransitionRejectedError(
      `Cannot transition run ${params.runId} to canceled: already in a terminal state`,
      { runId: params.runId, expectedStatus: 'canceled', entity: 'workflow_run' },
    );
  }
}

// ---------------------------------------------------------------------------
// transitionToPaused (Phase 4b — SDK-only Pause)
// ---------------------------------------------------------------------------

export interface TransitionToPausedParams {
  runId: string;
}

/**
 * Guarded UPDATE: workflow_runs status = 'paused' WHERE id = ? AND status IN
 * ('running', 'awaiting_review'). Pause is SDK-only and valid from a LIVE turn
 * ('running') OR an idle-rested run ('awaiting_review') — both edges are listed
 * in ALLOWED_TRANSITIONS.
 *
 * Design divergence (mirrors transitionToCanceled): two legal source states, so
 * no `fromStatus` parameter and no per-edge assertTransitionAllowed call — the
 * `status IN (...)` SQL guard is sufficient and avoids a SELECT-then-UPDATE round
 * trip. Both 'running'->'paused' and 'awaiting_review'->'paused' are in the table.
 *
 * Deliberately does NOT set ended_at (paused is NON-terminal) and does NOT touch
 * claude_session_id / current_step_id — those are PRESERVED so Resume can
 * re-drive via the SDK --resume path (transitionPausedToRunning).
 *
 * Throws TransitionRejectedError if the run is not in a pausable state (changes === 0).
 */
export function transitionToPaused(
  db: Database.Database,
  params: TransitionToPausedParams,
): void {
  const result = db.prepare(
    `UPDATE workflow_runs
        SET status = 'paused', updated_at = CURRENT_TIMESTAMP
      WHERE id = @runId AND status IN ('running', 'awaiting_review')`,
  ).run({ runId: params.runId });
  if (result.changes === 0) {
    throw new TransitionRejectedError(
      `Cannot pause run ${params.runId}: not in 'running' or 'awaiting_review' state`,
      { runId: params.runId, expectedStatus: 'running', entity: 'workflow_run' },
    );
  }
}

// ---------------------------------------------------------------------------
// transitionPausedToRunning (Phase 4b — SDK-only Resume)
// ---------------------------------------------------------------------------

export interface TransitionPausedToRunningParams {
  runId: string;
}

/**
 * Guarded UPDATE: workflow_runs status = 'running' WHERE id = ? AND status = 'paused'.
 * Resume re-drives the SDK run via the existing --resume path; the run returns to
 * 'running' and rests/completes from there. started_at is left as-is (the run
 * already started before it was paused).
 *
 * Throws TransitionRejectedError if the run is not in 'paused' state.
 */
export function transitionPausedToRunning(
  db: Database.Database,
  params: TransitionPausedToRunningParams,
): void {
  assertTransitionAllowed('paused', 'running', params.runId);
  const result = db.prepare(
    `UPDATE workflow_runs
        SET status = 'running', updated_at = CURRENT_TIMESTAMP
      WHERE id = @runId AND status = 'paused'`,
  ).run({ runId: params.runId });
  if (result.changes === 0) {
    throw new TransitionRejectedError(
      `Cannot resume run ${params.runId}: not in 'paused' state`,
      { runId: params.runId, expectedStatus: 'paused', entity: 'workflow_run' },
    );
  }
}

export interface TransitionFromAwaitingReviewParams {
  runId: string;
  approvalId: string;
  decision: Exclude<ApprovalStatus, 'pending'>; // 'approved' | 'rejected' | 'timed_out'
  decidedBy: string;
}

/**
 * Atomically: (1) UPDATE workflow_runs SET status='running' WHERE id = ?
 * AND status = 'awaiting_review'; (2) UPDATE approvals SET status=@decision,
 * decided_at=CURRENT_TIMESTAMP, decided_by=@decidedBy WHERE id=@approvalId
 * AND status='pending'. Same BEGIN IMMEDIATE + status-guard pattern. If
 * either UPDATE affects 0 rows, throws TransitionRejectedError and the
 * partial work is rolled back.
 */
export function transitionFromAwaitingReview(
  db: Database.Database,
  params: TransitionFromAwaitingReviewParams,
): void {
  const updateRun = db.prepare(
    `UPDATE workflow_runs
        SET status = 'running', updated_at = CURRENT_TIMESTAMP
      WHERE id = @runId AND status = 'awaiting_review'`,
  );
  const updateApproval = db.prepare(
    `UPDATE approvals
        SET status = @decision,
            decided_at = CURRENT_TIMESTAMP,
            decided_by = @decidedBy
      WHERE id = @approvalId AND status = 'pending'`,
  );

  const tx = db.transaction((p: TransitionFromAwaitingReviewParams) => {
    assertTransitionAllowed('awaiting_review', 'running', p.runId);
    const runResult = updateRun.run({ runId: p.runId });
    if (runResult.changes === 0) {
      throw new TransitionRejectedError(
        `Cannot transition run ${p.runId} out of awaiting_review: not in 'awaiting_review' state`,
        { runId: p.runId, expectedStatus: 'awaiting_review', entity: 'workflow_run' },
      );
    }
    const approvalResult = updateApproval.run({
      approvalId: p.approvalId,
      decision: p.decision,
      decidedBy: p.decidedBy,
    });
    if (approvalResult.changes === 0) {
      throw new TransitionRejectedError(
        `Cannot decide approval ${p.approvalId}: not in 'pending' state`,
        { runId: p.runId, expectedStatus: 'pending', entity: 'approval' },
      );
    }
  });

  tx.immediate(params);
}
