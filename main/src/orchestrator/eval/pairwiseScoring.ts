/**
 * pairwiseScoring — the PURE aggregation of K pairwise judge samples into one
 * verdict (A/B testing slice C). No SDK, no DB, no electron: a deterministic
 * function of its input samples, exhaustively unit-tested (mirrors scoring.ts for
 * the rubric jury).
 *
 * Aggregation contract:
 *  - Count A / B / tie votes across the surviving samples.
 *  - preference = strict majority of A vs B; ANY count tie (including aCount ===
 *    bCount, or an all-tie ballot) => 'tie'. A `tie` vote never wins on its own;
 *    it only prevents A or B from having a strict majority.
 *  - confidence = mean confidence of the WINNING-side samples (0 for a tie
 *    verdict — no winning side to average).
 *  - representative rationale = the highest-confidence sample on the winning side
 *    (for a tie verdict, the highest-confidence sample overall, so the card still
 *    surfaces a rationale).
 *  - sampleCount / aCount / bCount / tieCount are exposed verbatim so the UI can
 *    render the raw spread (a 2-1 win reads differently from a 3-0).
 *
 * The caller (PairwiseJudgeWorker) guarantees at least one surviving sample
 * before calling this; an empty input is still handled defensively (returns a
 * zero-confidence tie) rather than throwing.
 */
import type {
  PairwisePreference,
  PairwiseSample,
  PairwiseVerdict,
} from '../../../../shared/types/experiments';

/**
 * Aggregate the surviving pairwise samples into a single verdict. Pure.
 */
export function aggregatePairwise(samples: PairwiseSample[]): PairwiseVerdict {
  const aCount = samples.filter((s) => s.preference === 'A').length;
  const bCount = samples.filter((s) => s.preference === 'B').length;
  const tieCount = samples.filter((s) => s.preference === 'tie').length;

  // Strict majority of A vs B; any count tie => 'tie'.
  let preference: PairwisePreference;
  if (aCount > bCount) preference = 'A';
  else if (bCount > aCount) preference = 'B';
  else preference = 'tie';

  // Winning-side samples: those whose preference matches the verdict. For a tie
  // verdict there is no winning side, so confidence is 0 and the representative
  // rationale is drawn from the whole ballot.
  const winningSide =
    preference === 'tie' ? [] : samples.filter((s) => s.preference === preference);

  const confidence =
    winningSide.length === 0
      ? 0
      : winningSide.reduce((sum, s) => sum + s.confidence, 0) / winningSide.length;

  const rationalePool = winningSide.length > 0 ? winningSide : samples;
  const rationale = highestConfidenceRationale(rationalePool);

  return {
    preference,
    confidence,
    rationale,
    aCount,
    bCount,
    tieCount,
    sampleCount: samples.length,
    perSample: samples,
  };
}

/** The rationale of the highest-confidence sample in the pool ('' when empty). */
function highestConfidenceRationale(pool: PairwiseSample[]): string {
  let best: PairwiseSample | null = null;
  for (const s of pool) {
    if (best === null || s.confidence > best.confidence) best = s;
  }
  return best?.rationale ?? '';
}
