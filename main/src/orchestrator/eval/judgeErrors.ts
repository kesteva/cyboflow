/**
 * judgeErrors — typed, DETERMINISTIC per-sample judge failures shared by the
 * Claude (evalJudgeQuery) and Codex (codexEvalJudgeQuery) judge boundaries and
 * classified by EvalWorker's retry logic.
 *
 * "Deterministic" here means an identical immediate retry is ~guaranteed to fail
 * the same way while burning the full wall-clock again: a sample that consumed
 * its whole deadline (timeout) or its whole turn budget (max-turns) will do so
 * again under the same contention/diff. The worker therefore does NOT re-try the
 * slot, and when EVERY slot failed deterministically it does not re-run the whole
 * eval either — otherwise the per-attempt deadline compounds through 2 slot tries
 * × 3 eval attempts × N serialized jurors into an hours-scale stall of the
 * concurrency-1 EvalWorker queue (found by adversarial review of the 180s→300s
 * deadline bump).
 *
 * Pure module (no imports) so evalWorker can import it without dragging in the
 * SDK/service graph — same layering trick as codexJudge.CodexJurorUnavailableError.
 */

/** The per-sample deadline fired before the judge emitted structured output. */
export class EvalJudgeTimeoutError extends Error {
  override readonly name = 'EvalJudgeTimeoutError';
}

/** The judge exhausted its turn budget before emitting structured output. */
export class EvalJudgeMaxTurnsError extends Error {
  override readonly name = 'EvalJudgeMaxTurnsError';
}

/** True for failures the worker must NOT spend a second identical try on. */
export function isDeterministicJudgeFailure(err: unknown): boolean {
  return err instanceof EvalJudgeTimeoutError || err instanceof EvalJudgeMaxTurnsError;
}
