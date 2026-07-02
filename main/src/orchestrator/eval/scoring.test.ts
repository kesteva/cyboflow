/**
 * Unit tests for the PURE eval scoring core. These pin the tricky rubric rules the
 * proposal calls out ("How scoring works") so a regression in the math is loud:
 *   - UNKNOWN excluded from the dimension denominator (still counted),
 *   - thin-evidence (<2 applicable non-UNKNOWN) => INACTIVE + weight renormalization,
 *   - geometric-mean floor-at-1 (a zeroed dimension drags without zeroing overall),
 *   - catastrophic cap forces overall <= 69 (never averaged away),
 *   - GATED sentinel (deterministic-gate failure suppresses the quality headline).
 */
import { describe, it, expect } from 'vitest';
import { allSubChecks, type DimensionKey } from './rubric';
import {
  scoreSamples,
  isGated,
  type Verdict,
  type JudgeSample,
  type JudgeFinding,
  type SubCheckVerdict,
} from './scoring';

/** Build one sample: every sub-check gets `def` unless listed in `overrides`. */
function buildSample(
  overrides: Record<string, Verdict> = {},
  def: Verdict = 'PASS',
  findings: JudgeFinding[] = [],
): JudgeSample {
  const verdicts: SubCheckVerdict[] = allSubChecks().map((c) => ({
    id: c.id,
    verdict: overrides[c.id] ?? def,
    evidence: '',
  }));
  return { verdicts, findings };
}

/** All sub-check ids belonging to a dimension. */
function idsOf(dim: DimensionKey): string[] {
  return allSubChecks()
    .filter((c) => c.dimension === dim)
    .map((c) => c.id);
}

/** Set every sub-check of `dim` to `verdict` in an overrides map. */
function setDim(dim: DimensionKey, verdict: Verdict, into: Record<string, Verdict> = {}) {
  for (const id of idsOf(dim)) into[id] = verdict;
  return into;
}

const dimByKey = (result: ReturnType<typeof scoreSamples>, key: DimensionKey) => {
  const d = result.dimensions.find((x) => x.key === key);
  if (!d) throw new Error(`dimension ${key} missing`);
  return d;
};

describe('isGated', () => {
  it('treats absent gate results as NOT gated (absent != failed)', () => {
    expect(isGated(null)).toBe(false);
    expect(isGated(undefined)).toBe(false);
    expect(isGated({})).toBe(false);
    expect(isGated({ test: 'unknown', build: 'pass' })).toBe(false);
  });

  it('is gated when any hard gate explicitly failed', () => {
    expect(isGated({ test: 'fail' })).toBe(true);
    expect(isGated({ build: 'pass', typecheck: 'fail' })).toBe(true);
    expect(isGated({ lint: 'fail' })).toBe(true);
  });
});

describe('UNKNOWN exclusion', () => {
  it('excludes UNKNOWN votes from the pass-share denominator but counts them', () => {
    // Correctness: 2 PASS, 1 UNKNOWN, rest NOT_APPLICABLE.
    const cor = idsOf('correctness');
    const overrides: Record<string, Verdict> = {};
    setDim('correctness', 'NOT_APPLICABLE', overrides);
    overrides[cor[0]] = 'PASS';
    overrides[cor[1]] = 'PASS';
    overrides[cor[2]] = 'UNKNOWN';
    const result = scoreSamples([buildSample(overrides)]);
    const c = dimByKey(result, 'correctness');
    expect(c.active).toBe(true); // 2 applicable non-UNKNOWN >= threshold
    expect(c.passCount).toBe(2);
    expect(c.failCount).toBe(0);
    expect(c.unknownCount).toBe(1);
    expect(c.passFraction).toBe(1); // UNKNOWN not in denominator
    expect(c.score).toBe(100);
  });

  it('resolves a per-sub-check pass-share of >=0.5 to PASS across samples', () => {
    // COR-1 votes: PASS, PASS, UNKNOWN across 3 samples => resolved PASS (2/2).
    const cor = idsOf('correctness');
    const base: Record<string, Verdict> = setDim('correctness', 'NOT_APPLICABLE');
    base[cor[0]] = 'PASS';
    base[cor[1]] = 'PASS';
    const s1 = buildSample({ ...base, [cor[2]]: 'PASS' });
    const s2 = buildSample({ ...base, [cor[2]]: 'PASS' });
    const s3 = buildSample({ ...base, [cor[2]]: 'UNKNOWN' });
    const result = scoreSamples([s1, s2, s3]);
    const c = dimByKey(result, 'correctness');
    // COR-1, COR-2, COR-3 all resolve PASS (COR-3 has 2 PASS / 1 UNKNOWN).
    expect(c.passCount).toBe(3);
    expect(c.failCount).toBe(0);
    expect(c.unknownCount).toBe(0);
  });
});

describe('thin-evidence INACTIVE + weight renormalization', () => {
  it('marks a dimension with <2 applicable non-UNKNOWN sub-checks INACTIVE', () => {
    const sec = idsOf('security');
    const overrides = setDim('security', 'NOT_APPLICABLE');
    overrides[sec[0]] = 'PASS'; // only ONE applicable sub-check
    const result = scoreSamples([buildSample(overrides)]);
    const s = dimByKey(result, 'security');
    expect(s.active).toBe(false);
    expect(s.score).toBeNull();
    expect(s.passFraction).toBeNull();
  });

  it('renormalizes weights across only the ACTIVE dimensions', () => {
    // Active: correctness (all PASS => 100) + security (half PASS => 50).
    // Inactive: every other dimension (all NOT_APPLICABLE).
    const overrides: Record<string, Verdict> = {};
    for (const key of [
      'robustness',
      'design',
      'maintainability',
      'tests',
      'scope',
    ] as DimensionKey[]) {
      setDim(key, 'NOT_APPLICABLE', overrides);
    }
    // security: 9 sub-checks -> make ~half PASS half FAIL for fraction ~0.44.
    const sec = idsOf('security');
    sec.forEach((id, i) => (overrides[id] = i % 2 === 0 ? 'PASS' : 'FAIL'));
    const result = scoreSamples([buildSample(overrides)]);

    expect(dimByKey(result, 'correctness').active).toBe(true);
    expect(dimByKey(result, 'security').active).toBe(true);
    expect(dimByKey(result, 'robustness').active).toBe(false);
    expect(dimByKey(result, 'tests').active).toBe(false);

    // overall = weighted geo mean over {correctness(w26,100), security(w18,~44)}
    // renormalized to weights {26,18}. If weights were NOT renormalized (divided by
    // 100) the number would be far lower — this pins renormalization.
    const corScore = dimByKey(result, 'correctness').score as number;
    const secScore = dimByKey(result, 'security').score as number;
    const expected = Math.round(
      Math.exp((26 * Math.log(corScore) + 18 * Math.log(secScore)) / (26 + 18)),
    );
    expect(result.overallScore).toBe(expected);
    expect(result.overallScore).toBeGreaterThan(secScore); // pulled up by correctness
    expect(result.overallScore).toBeLessThan(corScore);
  });
});

describe('geometric-mean floor-at-1 (zeroed-tests drag)', () => {
  // One FAIL per non-test dimension (~85-89 each), tests all FAIL (=> 0, floored 1).
  const zeroedTests = (): Record<string, Verdict> => {
    const o: Record<string, Verdict> = {};
    o['COR-3'] = 'FAIL';
    o['SEC-3'] = 'FAIL';
    o['ROB-6'] = 'FAIL'; // not a cap-trigger
    o['DES-4'] = 'FAIL';
    o['MTN-4'] = 'FAIL';
    o['SCP-2'] = 'FAIL'; // not SCP-1 (no cap)
    setDim('tests', 'FAIL', o); // tests dimension forced to 0
    return o;
  };

  it('drags an otherwise-~85 run to ~60 (Fair) without zeroing overall', () => {
    const result = scoreSamples([buildSample(zeroedTests())]);
    expect(dimByKey(result, 'tests').active).toBe(true);
    expect(dimByKey(result, 'tests').score).toBe(0);
    expect(result.overallScore).not.toBeNull();
    // Calibration point from the proposal: lands ~60 (Fair band), well below the
    // ~85 the other dimensions would give on their own.
    expect(result.overallScore).toBeGreaterThanOrEqual(55);
    expect(result.overallScore).toBeLessThanOrEqual(66);
    expect(result.band).toBe('Fair');
  });

  it('the SAME run with healthy tests scores in the Good band (proves the drag)', () => {
    const o = zeroedTests();
    setDim('tests', 'PASS', o); // now tests pass
    const result = scoreSamples([buildSample(o)]);
    expect(dimByKey(result, 'tests').score).toBe(100);
    expect(result.overallScore).toBeGreaterThanOrEqual(82);
    expect(['Good', 'Excellent']).toContain(result.band);
  });
});

describe('catastrophic cap forces overall <= 69', () => {
  it('caps an otherwise-perfect run when a sample votes SCP-1 FAIL', () => {
    // Everything PASS except SCP-1 (unimplemented AC). Raw overall would be ~98.
    const result = scoreSamples([buildSample({ 'SCP-1': 'FAIL' })]);
    expect(result.capTriggered).toBe(true);
    expect(result.capTriggers).toContain('SCP-1');
    expect(result.requirementsUnmet).toBe(true);
    expect(result.overallScore).toBe(69); // clamped to the Fair ceiling
    expect(result.band).toBe('Fair');
    expect(result.ciHigh).toBeLessThanOrEqual(69);
  });

  it('fires the security cap on a high/critical (error) security finding', () => {
    const finding: JudgeFinding = {
      subCheckId: 'SEC-2',
      dimension: 'security',
      severity: 'error',
      title: 'SQL injection in migration DML',
      body: 'string-interpolated runtime value',
      netNew: true,
      catastrophic: true,
    };
    const result = scoreSamples([buildSample({}, 'PASS', [finding])]);
    expect(result.capTriggered).toBe(true);
    expect(result.securityFlag).toBe(true);
    expect(result.capTriggers).toContain('security');
    expect(result.overallScore).toBeLessThanOrEqual(69);
  });

  it('does NOT cap when the cap-trigger sub-check merely PASSES', () => {
    const result = scoreSamples([buildSample()]);
    expect(result.capTriggered).toBe(false);
    expect(result.overallScore).toBeGreaterThan(69);
  });
});

describe('GATED sentinel', () => {
  it('suppresses the quality headline when a hard gate failed', () => {
    const result = scoreSamples([buildSample()], { gateResults: { test: 'fail' } });
    expect(result.gated).toBe(true);
    expect(result.band).toBe('GATED');
    expect(result.overallScore).toBeNull();
    expect(result.ciLow).toBeNull();
    expect(result.ciHigh).toBeNull();
    // Dimensions are still computed (for the breakdown), just not headlined.
    expect(dimByKey(result, 'correctness').active).toBe(true);
  });

  it('is NOT gated when gate results are absent', () => {
    const result = scoreSamples([buildSample()]);
    expect(result.gated).toBe(false);
    expect(result.band).not.toBe('GATED');
    expect(result.overallScore).not.toBeNull();
  });
});

describe('fractional per-sub-check pass share (not binary majority)', () => {
  it('a systematically-split jury averages the pass FRACTIONS, not the binaries', () => {
    // 4 correctness sub-checks, each 2-PASS/1-FAIL across 3 samples. Rubric: each
    // contributes 0.667 => dimension mean 0.667 (Fair). A binary >=0.5 collapse
    // would resolve each PASS and score the dimension 100 (Excellent).
    const pick = idsOf('correctness').slice(0, 4);
    const base = setDim('correctness', 'NOT_APPLICABLE');
    const withPick = (v: Verdict): Record<string, Verdict> => ({
      ...base,
      ...Object.fromEntries(pick.map((id) => [id, v])),
    });
    const s1 = buildSample(withPick('PASS'));
    const s2 = buildSample(withPick('PASS'));
    const s3 = buildSample(withPick('FAIL'));
    const c = dimByKey(scoreSamples([s1, s2, s3]), 'correctness');
    expect(c.passFraction).toBeCloseTo(0.667, 2);
    expect(c.score).toBe(67);
    expect(c.band).toBe('Fair');
    expect(c.score).not.toBe(100);
  });
});

describe('dimension-level caps (ROB Poor, DES/SCP Fair, MTN-2∧MTN-4 Fair)', () => {
  it('a catastrophic ROB-3 FAIL soft-caps the robustness dimension at Poor (<0.40)', () => {
    const r = dimByKey(scoreSamples([buildSample({ 'ROB-3': 'FAIL' })]), 'robustness');
    expect(r.ceiling).toBe(0.39);
    expect(r.passFraction).toBeLessThanOrEqual(0.39);
    expect(r.band).toBe('Poor');
  });

  it('a DES-2 FAIL soft-caps the design dimension at Fair (<=0.69)', () => {
    const d = dimByKey(scoreSamples([buildSample({ 'DES-2': 'FAIL' })]), 'design');
    expect(d.ceiling).toBe(0.69);
    expect(d.passFraction).toBeLessThanOrEqual(0.69);
  });

  it('MTN-2 AND MTN-4 both FAIL caps maintainability at Fair via the pair rule', () => {
    const m = dimByKey(
      scoreSamples([buildSample({ 'MTN-2': 'FAIL', 'MTN-4': 'FAIL' })]),
      'maintainability',
    );
    expect(m.ceiling).toBe(0.69);
    expect(m.passFraction).toBeLessThanOrEqual(0.69);
  });

  it('MTN-2 alone (without MTN-4) does NOT trigger the pair cap', () => {
    const m = dimByKey(scoreSamples([buildSample({ 'MTN-2': 'FAIL' })]), 'maintainability');
    expect(m.ceiling).toBeNull();
  });
});

describe('inert diff (no active dimension) earns NO score, not 0/Poor', () => {
  it('yields null overall/band/CI when every sub-check is NOT_APPLICABLE', () => {
    const overrides: Record<string, Verdict> = {};
    for (const key of [
      'correctness',
      'security',
      'robustness',
      'design',
      'maintainability',
      'tests',
      'scope',
    ] as DimensionKey[]) {
      setDim(key, 'NOT_APPLICABLE', overrides);
    }
    const result = scoreSamples([buildSample(overrides)]);
    expect(result.overallScore).toBeNull();
    expect(result.band).toBeNull();
    expect(result.ciLow).toBeNull();
    expect(result.ciHigh).toBeNull();
    expect(result.gated).toBe(false);
  });
});

describe('security cap requires a CONFIRMED (catastrophic) finding', () => {
  it('does NOT fire on an unconfirmed high-severity security finding', () => {
    const finding: JudgeFinding = {
      subCheckId: 'SEC-2',
      dimension: 'security',
      severity: 'error',
      title: 'possible SSRF (reachability uncertain)',
      body: '',
      netNew: true,
      catastrophic: false, // PLAUSIBLE confidence-flag, not confirmed
    };
    const result = scoreSamples([buildSample({}, 'PASS', [finding])]);
    expect(result.securityFlag).toBe(false);
    expect(result.capTriggered).toBe(false);
  });
});

describe('test gate-dodge forces an ACTIVE tests dimension despite thin evidence', () => {
  it('TST-1 FAIL with all other TST sub-checks NA still scores tests 0 (not inactive)', () => {
    const o = setDim('tests', 'NOT_APPLICABLE');
    o['TST-1'] = 'FAIL';
    const t = dimByKey(scoreSamples([buildSample(o)]), 'tests');
    expect(t.active).toBe(true);
    expect(t.score).toBe(0);
  });
});

describe('special ceiling (COR-2 self-authored green tests)', () => {
  it('caps the correctness dimension at 0.89 when COR-2 resolves FAIL', () => {
    // All correctness PASS except COR-2 FAIL => raw fraction 8/9=0.889, but the
    // 0.89 ceiling still allows 0.889; force more context: fail COR-2 only.
    const result = scoreSamples([buildSample({ 'COR-2': 'FAIL' })]);
    const c = dimByKey(result, 'correctness');
    expect(c.ceiling).toBe(0.89);
    expect(c.passFraction).toBeLessThanOrEqual(0.89);
  });
});
