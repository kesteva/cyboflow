/**
 * Solution-thoroughness vocabulary: the `THOROUGHNESS:` brief flag parser and the
 * tuning-level mapping.
 *
 * The parser's contract is LENIENT-BUT-NEVER-GUESSING: it tolerates the shapes an
 * interview agent actually writes (bullet lists, bold markers, mixed case), and
 * returns null for anything it cannot read as one of the three levels. Null is
 * load-bearing — it is what keeps an unstamped project on today's behaviour.
 */
import { describe, it, expect } from 'vitest';
import {
  SOLUTION_THOROUGHNESS_LEVELS,
  isSolutionThoroughness,
  parseThoroughnessDeclaration,
  parseThoroughnessFlag,
  thoroughnessToTuningLevel,
} from '../thoroughness';

describe('parseThoroughnessDeclaration', () => {
  const SMOKE_BRIEF = [
    '# Pocket List — Project Brief',
    '',
    '## Vision',
    'A tiny to-do page. Production quality is not the goal.',
    '',
    '## Solution thoroughness',
    'This is a prototype: throwaway, built to prove the interaction feels right. A v1 comes later.',
    '',
    '## Problem & users',
    'One user, production someday.',
  ].join('\n');

  it('prefers the THOROUGHNESS: flag line when both channels exist', () => {
    expect(parseThoroughnessDeclaration(`THOROUGHNESS: production\n${SMOKE_BRIEF}`)).toBe('production');
  });

  it('falls back to the first level word of the "Solution thoroughness" section (the 2026-09-15 smoke brief)', () => {
    expect(parseThoroughnessDeclaration(SMOKE_BRIEF)).toBe('prototype');
  });

  it('reads the section at any heading level and any case', () => {
    expect(parseThoroughnessDeclaration('### SOLUTION THOROUGHNESS (declared)\nWe ship a V1 here.')).toBe('v1');
  });

  it('never reads a level word outside that section', () => {
    expect(parseThoroughnessDeclaration('## Vision\nThis is a prototype.\n## Users\nproduction users')).toBeNull();
    expect(parseThoroughnessDeclaration('## Solution thoroughness\n\n## Next\nprototype')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseThoroughnessDeclaration('')).toBeNull();
    expect(parseThoroughnessDeclaration(null)).toBeNull();
    expect(parseThoroughnessDeclaration(undefined)).toBeNull();
  });
});

describe('SOLUTION_THOROUGHNESS_LEVELS', () => {
  it('is the three levels in increasing order of finish', () => {
    expect(SOLUTION_THOROUGHNESS_LEVELS).toEqual(['prototype', 'v1', 'production']);
  });

  it('isSolutionThoroughness narrows exactly those three', () => {
    for (const level of SOLUTION_THOROUGHNESS_LEVELS) expect(isSolutionThoroughness(level)).toBe(true);
    for (const bogus of ['thorough', 'efficient', 'standard', 'V1', '', null, undefined, 3]) {
      expect(isSolutionThoroughness(bogus)).toBe(false);
    }
  });
});

describe('parseThoroughnessFlag', () => {
  it('reads a bare flag line beside the existing brief flags', () => {
    const brief = [
      '# Project brief',
      '',
      'THOROUGHNESS: v1',
      'UI_PROTOTYPE: yes',
      'ARCH_DESIGN: no',
    ].join('\n');
    expect(parseThoroughnessFlag(brief)).toBe('v1');
  });

  it('tolerates a bullet marker, bold markers, and mixed case', () => {
    expect(parseThoroughnessFlag('- **THOROUGHNESS:** Production')).toBe('production');
    expect(parseThoroughnessFlag('  * thoroughness: PROTOTYPE  ')).toBe('prototype');
    expect(parseThoroughnessFlag('**Thoroughness**: v1')).toBe('v1');
  });

  it('takes the LAST flag line when a revised brief appends a correction', () => {
    const brief = ['THOROUGHNESS: prototype', '', 'Revised after the gate:', 'THOROUGHNESS: production'].join(
      '\n',
    );
    expect(parseThoroughnessFlag(brief)).toBe('production');
  });

  it('returns null rather than guessing when the flag is absent or unrecognized', () => {
    expect(parseThoroughnessFlag('UI_PROTOTYPE: yes\nARCH_DESIGN: no')).toBeNull();
    expect(parseThoroughnessFlag('THOROUGHNESS: thorough')).toBeNull();
    expect(parseThoroughnessFlag('THOROUGHNESS:')).toBeNull();
    expect(parseThoroughnessFlag('')).toBeNull();
    expect(parseThoroughnessFlag(null)).toBeNull();
    expect(parseThoroughnessFlag(undefined)).toBeNull();
  });

  it('does NOT match across a newline (a bare key cannot be completed by a later word)', () => {
    expect(parseThoroughnessFlag('THOROUGHNESS:\nproduction')).toBeNull();
  });

  it('ignores the word appearing in prose without the flag shape', () => {
    expect(
      parseThoroughnessFlag('We discussed thoroughness at length and settled on production quality.'),
    ).toBeNull();
  });
});

describe('thoroughnessToTuningLevel', () => {
  it('maps each level onto its tuning preset', () => {
    expect(thoroughnessToTuningLevel('prototype')).toBe('efficient');
    expect(thoroughnessToTuningLevel('v1')).toBe('standard');
    expect(thoroughnessToTuningLevel('production')).toBe('thorough');
  });

  it('is total — every level has an answer', () => {
    for (const level of SOLUTION_THOROUGHNESS_LEVELS) {
      expect(['efficient', 'standard', 'thorough']).toContain(thoroughnessToTuningLevel(level));
    }
  });
});
