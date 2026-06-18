import { describe, it, expect } from 'vitest';
import { parseContextUsage, contextMeterClass } from '../contextUsage';

describe('parseContextUsage', () => {
  it('parses the SDK producer string', () => {
    expect(parseContextUsage('54k/200k tokens (27%)')).toEqual({
      used: '54k',
      total: '200k',
      percent: 27,
    });
  });

  it('handles raw token counts (no k suffix)', () => {
    expect(parseContextUsage('512/200k tokens (0%)')).toEqual({
      used: '512',
      total: '200k',
      percent: 0,
    });
  });

  it('returns null for the placeholder / empty forms (no NaN%)', () => {
    expect(parseContextUsage('-- tokens (--%)')).toBeNull();
    expect(parseContextUsage(null)).toBeNull();
    expect(parseContextUsage(undefined)).toBeNull();
    expect(parseContextUsage('')).toBeNull();
    expect(parseContextUsage('garbage')).toBeNull();
  });
});

describe('contextMeterClass', () => {
  it('tiers the fill color: >80 rust, >50 amber, else green', () => {
    expect(contextMeterClass(95)).toBe('bg-interactive');
    expect(contextMeterClass(81)).toBe('bg-interactive');
    expect(contextMeterClass(80)).toBe('bg-status-warning');
    expect(contextMeterClass(51)).toBe('bg-status-warning');
    expect(contextMeterClass(50)).toBe('bg-status-success');
    expect(contextMeterClass(0)).toBe('bg-status-success');
  });
});
