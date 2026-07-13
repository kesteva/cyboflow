/**
 * Unit tests for the PURE pairwise aggregation (aggregatePairwise). No SDK, no DB.
 * Exhaustive over the majority/tie/confidence/representative-rationale contract.
 */
import { describe, it, expect } from 'vitest';
import {
  aggregatePairwise,
  relabelSolutionsToArms,
  displayRationaleForVerdict,
} from './pairwiseScoring';
import type { PairwiseSample, PairwisePreference } from '../../../../shared/types/experiments';

let seq = 0;
function sample(preference: PairwisePreference, confidence: number, rationale = `r${seq}`): PairwiseSample {
  return {
    sampleIndex: seq++,
    positionAFirst: true,
    rawPreference: preference === 'tie' ? 'tie' : preference === 'A' ? '1' : '2',
    preference,
    confidence,
    rationale,
  };
}

/** Like `sample` but pins `positionAFirst` (which arm was shown as "Solution 1"). */
function orientedSample(
  preference: PairwisePreference,
  confidence: number,
  positionAFirst: boolean,
  rationale: string,
): PairwiseSample {
  return { ...sample(preference, confidence, rationale), positionAFirst };
}

describe('aggregatePairwise', () => {
  it('3-0 A: preference A, confidence = mean of the three A samples', () => {
    const v = aggregatePairwise([sample('A', 0.9), sample('A', 0.6), sample('A', 0.3)]);
    expect(v.preference).toBe('A');
    expect(v.aCount).toBe(3);
    expect(v.bCount).toBe(0);
    expect(v.tieCount).toBe(0);
    expect(v.sampleCount).toBe(3);
    expect(v.confidence).toBeCloseTo((0.9 + 0.6 + 0.3) / 3, 6);
  });

  it('2-1 A: majority A over B; confidence averages ONLY the winning-side samples', () => {
    const v = aggregatePairwise([sample('A', 0.8), sample('A', 0.4), sample('B', 0.99)]);
    expect(v.preference).toBe('A');
    expect(v.aCount).toBe(2);
    expect(v.bCount).toBe(1);
    expect(v.confidence).toBeCloseTo((0.8 + 0.4) / 2, 6);
  });

  it('1-1-1 (A/B/tie): count tie between A and B => tie verdict, confidence 0', () => {
    const v = aggregatePairwise([sample('A', 0.7), sample('B', 0.7), sample('tie', 0.1)]);
    expect(v.preference).toBe('tie');
    expect(v.aCount).toBe(1);
    expect(v.bCount).toBe(1);
    expect(v.tieCount).toBe(1);
    expect(v.confidence).toBe(0);
  });

  it('A==B even split => tie, confidence 0', () => {
    const v = aggregatePairwise([sample('A', 0.9), sample('B', 0.9)]);
    expect(v.preference).toBe('tie');
    expect(v.confidence).toBe(0);
  });

  it('all-tie ballot => tie', () => {
    const v = aggregatePairwise([sample('tie', 0.2), sample('tie', 0.5)]);
    expect(v.preference).toBe('tie');
    expect(v.tieCount).toBe(2);
    expect(v.confidence).toBe(0);
  });

  it('single survivor decides the verdict', () => {
    const v = aggregatePairwise([sample('B', 0.55)]);
    expect(v.preference).toBe('B');
    expect(v.sampleCount).toBe(1);
    expect(v.confidence).toBeCloseTo(0.55, 6);
  });

  it('empty input => defensive zero-confidence tie (no throw)', () => {
    const v = aggregatePairwise([]);
    expect(v.preference).toBe('tie');
    expect(v.confidence).toBe(0);
    expect(v.sampleCount).toBe(0);
    expect(v.rationale).toBe('');
  });

  it('representative rationale = highest-confidence WINNING-side sample', () => {
    const v = aggregatePairwise([
      sample('A', 0.4, 'weak-A'),
      sample('A', 0.95, 'strong-A'),
      sample('B', 0.99, 'strong-B'),
    ]);
    expect(v.preference).toBe('A');
    // The strong-B sample has the highest confidence overall but is on the LOSING side.
    expect(v.rationale).toBe('strong-A');
  });

  it('tie verdict draws its representative rationale from the whole ballot', () => {
    const v = aggregatePairwise([sample('A', 0.6, 'a'), sample('B', 0.8, 'b')]);
    expect(v.preference).toBe('tie');
    expect(v.rationale).toBe('b'); // highest-confidence overall
  });

  it('carries the samples verbatim on perSample', () => {
    const samples = [sample('A', 0.7), sample('tie', 0.2)];
    const v = aggregatePairwise(samples);
    expect(v.perSample).toEqual(samples);
  });
});

describe('relabelSolutionsToArms', () => {
  it('positionAFirst: Solution 1 => Arm A, Solution 2 => Arm B', () => {
    expect(relabelSolutionsToArms('Solution 1 beats Solution 2.', true)).toBe(
      'Arm A beats Arm B.',
    );
  });

  it('!positionAFirst: labels are flipped (Solution 2 => Arm A)', () => {
    expect(relabelSolutionsToArms('Solution 2 beats Solution 1.', false)).toBe(
      'Arm A beats Arm B.',
    );
  });

  it('rewrites possessives and is case-insensitive', () => {
    expect(relabelSolutionsToArms("solution 2's rigor outweighs Solution 1.", false)).toBe(
      "Arm A's rigor outweighs Arm B.",
    );
  });

  it('is idempotent on already-relabeled text', () => {
    expect(relabelSolutionsToArms('Arm A beats Arm B.', true)).toBe('Arm A beats Arm B.');
  });

  it('leaves unrelated "solution" prose untouched', () => {
    expect(relabelSolutionsToArms('The solution is elegant.', true)).toBe(
      'The solution is elegant.',
    );
  });
});

describe('displayRationaleForVerdict', () => {
  it('relabels using the winning-side source sample when A won but prose says "Solution 2"', () => {
    // The judge preferred Arm A in a sample where Arm A was shown SECOND (positionAFirst=false),
    // so its prose praises "Solution 2" — the exact contradiction the fix targets.
    const perSample = [
      orientedSample('A', 0.9, false, "Solution 2's completeness wins over Solution 1."),
      orientedSample('A', 0.4, true, 'weak-A'),
    ];
    const out = displayRationaleForVerdict(
      "Solution 2's completeness wins over Solution 1.",
      perSample,
      'A',
    );
    expect(out).toBe("Arm A's completeness wins over Arm B.");
  });

  it('prefers a winning-side sample over a losing-side one with identical text', () => {
    const shared = 'Solution 1 is better.';
    const perSample = [
      orientedSample('B', 0.8, true, shared), // losing side; Solution 1 = Arm A here
      orientedSample('A', 0.9, false, shared), // winning side; Solution 1 = Arm B here
    ];
    // Winning-side source has positionAFirst=false => Solution 1 = Arm B.
    expect(displayRationaleForVerdict(shared, perSample, 'A')).toBe('Arm B is better.');
  });

  it('tie verdict resolves the source from the whole ballot', () => {
    const perSample = [orientedSample('tie', 0.3, false, 'Solution 1 and Solution 2 are equivalent.')];
    expect(displayRationaleForVerdict('Solution 1 and Solution 2 are equivalent.', perSample, 'tie')).toBe(
      'Arm B and Arm A are equivalent.',
    );
  });

  it('leaves text untouched when no source sample matches (legacy/empty ballot)', () => {
    expect(displayRationaleForVerdict('Solution 2 wins.', [], 'A')).toBe('Solution 2 wins.');
    expect(
      displayRationaleForVerdict('Solution 2 wins.', [orientedSample('A', 0.9, true, 'other')], 'A'),
    ).toBe('Solution 2 wins.');
  });

  it('empty rationale short-circuits', () => {
    expect(displayRationaleForVerdict('', [orientedSample('A', 0.9, true, 'x')], 'A')).toBe('');
  });
});
