/**
 * answerRecoveryGateHandler — business logic for the `runs.answerRecoveryGate`
 * tRPC mutation (durable AskUserQuestion recovery gate answer path).
 *
 * A recovery gate (see ClaudeCodeManager.synthesizeAskUserQuestionRecoveryGate /
 * QuestionRouter.clearPendingForRun preserveGates) is a blocking `decision`
 * review item that outlived the SDK session that opened it. Answering it must:
 *   1. RESUME the run with the chosen answer as a `--resume` turn, and
 *   2. resolve the gate — but ONLY once the resume was actually accepted.
 *
 * ORDER IS LOAD-BEARING (adversarial-review finding, 2026-07-08): the earlier
 * version resolved the gate FIRST, then nudged. When the nudge no-op'd
 * (no_session / not_idle / race / execute_failed) the answer was lost with the
 * gate already cleared and no way to retry — and the UI hid the failure. So we
 * NUDGE FIRST (telling nudge to ignore THIS gate's own blocking row, which would
 * otherwise block its own resume) and resolve the gate ONLY on a confirmed
 * `delivered`. On any no-op the gate is left PENDING so the user can retry, and
 * the failure is surfaced to the caller.
 *
 * Standalone-typecheck invariant: all collaborators are injected, so this module
 * imports no 'electron' / 'better-sqlite3' / services and is unit-testable
 * without the tRPC context or the ReviewItemRouter singleton.
 */
import type { DatabaseLike, LoggerLike } from './types';
import type { NudgeRunResult } from './nudgeRunHandler';
import { ASK_USER_QUESTION_RECOVERY_SOURCE } from './reviewItemListing';

export interface AnswerRecoveryGateDeps {
  db: DatabaseLike;
  /**
   * Resume the run with `text` as the resumed turn, ignoring the given blocking
   * review item (the gate being answered). Wraps nudgeRunHandler in production.
   */
  nudge: (
    runId: string,
    text: string,
    opts: { ignoreBlockingReviewItemId: string },
  ) => Promise<NudgeRunResult>;
  /** Resolve the review item through the chokepoint. Wraps ReviewItemRouter. */
  resolveReviewItem: (projectId: number, reviewItemId: string, resolution: string) => Promise<void>;
  logger?: LoggerLike;
}

export interface AnswerRecoveryGateResult {
  /** True ONLY when the run resumed AND the gate was resolved. */
  resolved: boolean;
  /** The resume outcome — carried so the UI can explain a failed resume. */
  nudge: NudgeRunResult;
}

interface RecoveryGateRow {
  runId?: string | null;
  kind?: string;
  source?: string | null;
  status?: string;
}

/**
 * Answer a durable ask-user-question-recovery gate: resume the run with the
 * chosen answer, and resolve the gate only if the resume was delivered.
 *
 * Returns `{ resolved:false, nudge:{noOp:'not_found'} }` for a non-recovery /
 * missing / run-less / already-settled item (idempotent — a double-answer or a
 * card acting on a stale row never touches a live run).
 */
export async function answerRecoveryGateHandler(
  projectId: number,
  reviewItemId: string,
  answerText: string,
  deps: AnswerRecoveryGateDeps,
): Promise<AnswerRecoveryGateResult> {
  const item = deps.db
    .prepare('SELECT run_id AS runId, kind, source, status FROM review_items WHERE id = ? AND project_id = ?')
    .get(reviewItemId, projectId) as RecoveryGateRow | undefined;

  if (
    !item ||
    item.kind !== 'decision' ||
    item.source !== ASK_USER_QUESTION_RECOVERY_SOURCE ||
    !item.runId ||
    item.status !== 'pending'
  ) {
    return { resolved: false, nudge: { noOp: true, reason: 'not_found' } };
  }

  // Resume FIRST (ignoring this gate's own blocking row). nudgeRunHandler awaits
  // the resumed turn, so `delivered` means the agent received the answer.
  const nudge = await deps.nudge(item.runId, answerText, { ignoreBlockingReviewItemId: reviewItemId });

  if ('delivered' in nudge && nudge.delivered) {
    // Resume accepted → NOW it is safe to permanently clear the gate.
    await deps.resolveReviewItem(projectId, reviewItemId, answerText);
    return { resolved: true, nudge };
  }

  // Resume refused (no_session / not_idle / race / execute_failed / blocked by
  // ANOTHER item). Leave the gate PENDING so the answer is not lost — the user
  // can retry once the blocking condition clears.
  deps.logger?.warn?.('[answerRecoveryGate] resume refused; gate left pending for retry', {
    runId: item.runId,
    reviewItemId,
    reason: 'noOp' in nudge ? nudge.reason : 'unknown',
  });
  return { resolved: false, nudge };
}
