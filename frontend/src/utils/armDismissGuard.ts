import type { ExperimentArm, ExperimentRow } from '../../../shared/types/experiments';

/**
 * A live experiment that the session-to-dismiss is an arm of, plus which arm
 * letter it is (derived from which session column matched).
 */
export interface GuardedExperimentMatch {
  experiment: ExperimentRow;
  arm: ExperimentArm;
}

/**
 * Decide whether dismissing a session would tear down half of a LIVE A/B
 * experiment, and if so, which arm the session is.
 *
 * Guard iff some experiment is still live — status 'running' (one/both arms
 * executing) or 'grading' (both arms settled, awaiting the human verdict) — AND
 * the session is one of its two arms. A 'decided' experiment is NOT guarded:
 * dismissing/merging the winner is the normal close-out; likewise 'abandoned'
 * (already torn down). `session_a_id` is checked before `session_b_id`, so the
 * degenerate case of a session appearing in both columns resolves to arm A.
 *
 * Returns null when no live experiment claims the session — the caller then
 * proceeds with the ordinary dismiss flow.
 */
export function findGuardedExperimentForSession(
  sessionId: string,
  experiments: readonly ExperimentRow[],
): GuardedExperimentMatch | null {
  for (const experiment of experiments) {
    if (experiment.status !== 'running' && experiment.status !== 'grading') continue;
    if (experiment.session_a_id === sessionId) return { experiment, arm: 'A' };
    if (experiment.session_b_id === sessionId) return { experiment, arm: 'B' };
  }
  return null;
}
