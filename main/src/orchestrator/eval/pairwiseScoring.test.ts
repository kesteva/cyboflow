/**
 * Unit tests for the PURE pairwise aggregation (aggregatePairwise). No SDK, no DB.
 * Exhaustive over the majority/tie/confidence/representative-rationale contract.
 */
import { describe, it, expect } from 'vitest';
import { aggregatePairwise } from './pairwiseScoring';
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
