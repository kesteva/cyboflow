import type Database from 'better-sqlite3';
import type { ApprovalStatus, WorkflowRunStatus } from '../../../../shared/types/cyboflow';

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
