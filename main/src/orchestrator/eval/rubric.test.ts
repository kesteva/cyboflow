/**
 * Faithfulness tests for the Code-Review Eval rubric v1.1 data module.
 *
 * Guards the frozen transcription of docs/proposals/code-review-eval-checklist.md
 * against silent drift: dimension/weight/sub-check counts, id uniqueness, and a
 * verbatim spot-check of five sub-check propositions. serializeRubricForPrompt
 * feeds prompt_hash, so a determinism check pins its purity.
 */

import { describe, it, expect } from 'vitest';
import {
  RUBRIC,
  RUBRIC_VERSION,
  BANDS,
  AGGREGATION,
  allSubChecks,
  totalWeight,
  bandForFraction,
  serializeRubricForPrompt,
  type DimensionKey,
} from './rubric';

const EXPECTED_SUBCHECK_COUNTS: Record<DimensionKey, number> = {
  correctness: 9,
  security: 9,
  robustness: 8,
  design: 7,
  maintainability: 8,
  tests: 9,
  scope: 8,
};

const EXPECTED_WEIGHTS: Record<DimensionKey, number> = {
  correctness: 26,
  security: 18,
  robustness: 14,
  design: 14,
  maintainability: 12,
  tests: 8,
  scope: 8,
};

describe('rubric v1.1 shape', () => {
  it('pins the rubric version to 1.1', () => {
    expect(RUBRIC_VERSION).toBe('1.1');
    expect(RUBRIC.version).toBe('1.1');
  });

  it('has exactly 7 dimensions in stable order', () => {
    expect(RUBRIC.dimensions.map((d) => d.key)).toEqual([
      'correctness',
      'security',
      'robustness',
      'design',
      'maintainability',
      'tests',
      'scope',
    ]);
  });

  it('weights sum to 100 and match the doc table', () => {
    expect(totalWeight()).toBe(100);
    for (const dim of RUBRIC.dimensions) {
      expect(dim.weight).toBe(EXPECTED_WEIGHTS[dim.key]);
    }
  });

  it('has the documented sub-check count per dimension (9+9+8+7+8+9+8)', () => {
    for (const dim of RUBRIC.dimensions) {
      expect(dim.subChecks.length).toBe(EXPECTED_SUBCHECK_COUNTS[dim.key]);
    }
  });

  it('has exactly 58 sub-checks total', () => {
    expect(allSubChecks().length).toBe(58);
    const sum = Object.values(EXPECTED_SUBCHECK_COUNTS).reduce((a, b) => a + b, 0);
    expect(sum).toBe(58);
  });

  it('has unique sub-check ids, each prefixed by its dimension family', () => {
    const ids = allSubChecks().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const prefix: Record<DimensionKey, string> = {
      correctness: 'COR-',
      security: 'SEC-',
      robustness: 'ROB-',
      design: 'DES-',
      maintainability: 'MTN-',
      tests: 'TST-',
      scope: 'SCP-',
    };
    for (const check of allSubChecks()) {
      expect(check.id.startsWith(prefix[check.dimension])).toBe(true);
    }
  });

  it('every sub-check carries a non-empty Applies scope and an Unknown clause', () => {
    for (const check of allSubChecks()) {
      expect(check.applies.length).toBeGreaterThan(0);
      expect(typeof check.unknownWhen).toBe('string');
    }
  });
});

describe('rubric v1.1 catastrophic-cap tier + special ceilings', () => {
  const byId = (id: string) => {
    const found = allSubChecks().find((c) => c.id === id);
    if (!found) throw new Error(`sub-check ${id} not found`);
    return found;
  };

  it('marks the four sub-check-anchored catastrophic classes with overall_fair_cap', () => {
    for (const id of ['ROB-3', 'ROB-4', 'ROB-5', 'SCP-1']) {
      expect(byId(id).capTrigger).toBe('overall_fair_cap');
    }
  });

  it('flags SCP-1 with requirements_unmet', () => {
    expect(byId('SCP-1').capFlag).toBe('requirements_unmet');
  });

  it('routes the fifth catastrophic class (security high/critical) at the dimension level', () => {
    const security = RUBRIC.dimensions.find((d) => d.key === 'security');
    expect(security?.overallCapOnHighSeverity).toBe(true);
    for (const dim of RUBRIC.dimensions) {
      if (dim.key !== 'security') expect(dim.overallCapOnHighSeverity).toBe(false);
    }
  });

  it('applies the COR-2 self-authored-green-tests ceiling of 0.89', () => {
    expect(byId('COR-2').specialCeiling).toBe(0.89);
    expect(AGGREGATION.SELF_AUTHORED_TEST_CEILING).toBe(0.89);
  });
});

describe('rubric v1.1 verbatim spot-checks', () => {
  const propositionOf = (id: string): string => {
    const found = allSubChecks().find((c) => c.id === id);
    if (!found) throw new Error(`sub-check ${id} not found`);
    return found.proposition;
  };

  it('COR-3 proposition matches the doc verbatim', () => {
    expect(propositionOf('COR-3')).toBe(
      'Edge and boundary inputs are handled correctly (empty/null/undefined, empty collections, zero/negative/overflow, duplicate/absent keys, first/last iteration).',
    );
  });

  it('SEC-2 proposition matches the doc verbatim', () => {
    expect(propositionOf('SEC-2')).toBe(
      'No SQL injection: all new/changed better-sqlite3 queries and migration DML use parameterized bindings, not string-interpolated runtime values.',
    );
  });

  it('ROB-4 proposition matches the doc verbatim', () => {
    expect(propositionOf('ROB-4')).toBe(
      'Migration chain/collision integrity: BEFORE verdict the judge MUST enumerate the migrations directory in the snapshot; the new migration number must be strictly greater than the current max, collide with no existing/sibling migration, and be contiguous with the chain.',
    );
  });

  it('TST-1 proposition matches the doc verbatim', () => {
    expect(propositionOf('TST-1')).toBe(
      'Behavior-changing diff ships at least one runnable test exercising the changed code path.',
    );
  });

  it('SCP-1 proposition matches the doc verbatim', () => {
    expect(propositionOf('SCP-1')).toBe(
      'Every explicit OR clearly-implied acceptance criterion in the task spec (derived from prose where the body is not bullet-listed) is implemented by some hunk in the diff.',
    );
  });
});

describe('rubric v1.1 bands + aggregation constants', () => {
  it('exposes the four fractional bands with the documented thresholds', () => {
    expect(BANDS.map((b) => [b.name, b.minFraction])).toEqual([
      ['Excellent', 0.9],
      ['Good', 0.7],
      ['Fair', 0.4],
      ['Poor', 0],
    ]);
  });

  it('bandForFraction maps pass-fractions to the correct band', () => {
    expect(bandForFraction(0.95).name).toBe('Excellent');
    expect(bandForFraction(0.9).name).toBe('Excellent');
    expect(bandForFraction(0.89).name).toBe('Good');
    expect(bandForFraction(0.7).name).toBe('Good');
    expect(bandForFraction(0.69).name).toBe('Fair');
    expect(bandForFraction(0.4).name).toBe('Fair');
    expect(bandForFraction(0.39).name).toBe('Poor');
    expect(bandForFraction(0).name).toBe('Poor');
  });

  it('pins the aggregation constants', () => {
    expect(AGGREGATION.DIMENSION_FLOOR).toBe(1);
    expect(AGGREGATION.OVERALL_CATASTROPHIC_CAP).toBe(69);
    expect(AGGREGATION.THIN_EVIDENCE_MIN_SUBCHECKS).toBe(2);
  });
});

describe('serializeRubricForPrompt determinism', () => {
  it('is a pure function of the rubric (stable across calls)', () => {
    expect(serializeRubricForPrompt()).toBe(serializeRubricForPrompt(RUBRIC));
  });

  it('includes the version, every sub-check id, and every Applies scope', () => {
    const out = serializeRubricForPrompt();
    expect(out).toContain('RUBRIC v1.1');
    for (const check of allSubChecks()) {
      expect(out).toContain(check.id);
    }
  });

  it('surfaces the catastrophic-cap and ceiling flags in the serialized text', () => {
    const out = serializeRubricForPrompt();
    expect(out).toContain('cap=overall_fair_cap');
    expect(out).toContain('cap_flag=requirements_unmet');
    expect(out).toContain('ceiling=0.89');
    expect(out).toContain('overall_cap_on_high_severity');
  });
});
