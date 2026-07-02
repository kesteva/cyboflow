import { describe, it, expect } from 'vitest';
import {
  bandDisplay,
  scoreToBand,
  gateStatus,
  formatRuntime,
  FINDING_SEVERITY_LABEL,
} from '../runEvalDisplay';

describe('bandDisplay', () => {
  it('maps each band to an uppercased label and a color token', () => {
    expect(bandDisplay('Excellent').label).toBe('EXCELLENT');
    expect(bandDisplay('Good').label).toBe('GOOD');
    expect(bandDisplay('Fair').label).toBe('FAIR');
    expect(bandDisplay('Poor').label).toBe('POOR');
    expect(bandDisplay('Excellent').textClass).toContain('success');
    expect(bandDisplay('Poor').textClass).toContain('error');
  });

  it('colors Good green (success) to match the approved mock-up', () => {
    expect(bandDisplay('Good').textClass).toContain('success');
    expect(bandDisplay('Fair').textClass).toContain('warning');
  });
});

describe('scoreToBand', () => {
  it('derives a band from a 0-100 dimension score at the documented thresholds', () => {
    expect(scoreToBand(90)).toBe('Excellent');
    expect(scoreToBand(100)).toBe('Excellent');
    expect(scoreToBand(89)).toBe('Good');
    expect(scoreToBand(70)).toBe('Good');
    expect(scoreToBand(68)).toBe('Fair');
    expect(scoreToBand(50)).toBe('Fair');
    expect(scoreToBand(49)).toBe('Poor');
    expect(scoreToBand(0)).toBe('Poor');
  });
});

describe('FINDING_SEVERITY_LABEL', () => {
  it('maps stored severities to the mock-up chip labels', () => {
    expect(FINDING_SEVERITY_LABEL.error).toBe('MUST-FIX');
    expect(FINDING_SEVERITY_LABEL.warning).toBe('GUIDELINE');
    expect(FINDING_SEVERITY_LABEL.info).toBe('NIT');
  });
});

describe('gateStatus', () => {
  it('coerces booleans, strings and objects to pass/fail/unknown', () => {
    expect(gateStatus(true)).toBe('pass');
    expect(gateStatus(false)).toBe('fail');
    expect(gateStatus('passed')).toBe('pass');
    expect(gateStatus('FAILED')).toBe('fail');
    expect(gateStatus('meh')).toBe('unknown');
    expect(gateStatus({ status: 'pass' })).toBe('pass');
    expect(gateStatus({ passed: false })).toBe('fail');
    expect(gateStatus(undefined)).toBe('unknown');
    expect(gateStatus(null)).toBe('unknown');
  });
});

describe('formatRuntime', () => {
  const now = Date.parse('2026-07-01T00:05:00.000Z');

  it('returns null without a start stamp', () => {
    expect(formatRuntime(null, null, now)).toBeNull();
  });

  it('formats a completed run from start→end', () => {
    expect(formatRuntime('2026-07-01T00:00:00.000Z', '2026-07-01T00:02:05.000Z', now)).toBe('2m 5s');
  });

  it('drops the minute component under a minute', () => {
    expect(formatRuntime('2026-07-01T00:00:00.000Z', '2026-07-01T00:00:42.000Z', now)).toBe('42s');
  });

  it('measures to now while the run has not ended', () => {
    expect(formatRuntime('2026-07-01T00:00:00.000Z', null, now)).toBe('5m 0s');
  });

  it('never returns a negative runtime', () => {
    expect(formatRuntime('2026-07-01T00:10:00.000Z', '2026-07-01T00:00:00.000Z', now)).toBe('0s');
  });
});
