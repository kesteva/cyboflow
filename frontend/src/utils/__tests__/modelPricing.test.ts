import { describe, it, expect } from 'vitest';
import { ratesForModel, computeSessionCostUsd, formatCostUsd } from '../modelPricing';
import type { SessionTokenBreakdown } from '../../hooks/useSessionMetrics';

const empty: SessionTokenBreakdown = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

const perMTok = (n: number) => n / 1_000_000;

describe('ratesForModel', () => {
  it('prices each generation at its own list rate, tolerating [1m] and date suffixes', () => {
    expect(ratesForModel('claude-opus-5-5[1m]')?.input).toBeCloseTo(perMTok(4));
    expect(ratesForModel('claude-opus-5')?.output).toBeCloseTo(perMTok(25));
    expect(ratesForModel('claude-opus-4-8[1m]')?.input).toBeCloseTo(perMTok(5));
    expect(ratesForModel('claude-opus-4-1-20250805')?.input).toBeCloseTo(perMTok(15));
    expect(ratesForModel('claude-sonnet-5-5')?.output).toBeCloseTo(perMTok(10));
    expect(ratesForModel('claude-sonnet-5')?.input).toBeCloseTo(perMTok(2));
    expect(ratesForModel('claude-sonnet-4-6')?.input).toBeCloseTo(perMTok(3));
    expect(ratesForModel('claude-sonnet-4-20250514')?.output).toBeCloseTo(perMTok(15));
    expect(ratesForModel('claude-3-7-sonnet-20250219')?.input).toBeCloseTo(perMTok(3));
    expect(ratesForModel('claude-haiku-5-5')?.input).toBeCloseTo(perMTok(0.1));
    expect(ratesForModel('claude-haiku-4-5-20251001')?.output).toBeCloseTo(perMTok(5));
  });

  it('prices Fable 5.2 at $8/$40, earlier Fable snapshots at $10/$50, Mythos like Fable', () => {
    expect(ratesForModel('claude-fable-5-2')?.output).toBeCloseTo(perMTok(40));
    expect(ratesForModel('claude-fable-5-1')?.input).toBeCloseTo(perMTok(10));
    expect(ratesForModel('claude-fable-5-1[1m]')?.output).toBeCloseTo(perMTok(50));
    expect(ratesForModel('claude-fable-5')?.output).toBeCloseTo(perMTok(50));
    expect(ratesForModel('claude-mythos-5-2')?.input).toBeCloseTo(perMTok(8));
  });

  it('prices a picker alias as the model it runs today', () => {
    expect(ratesForModel('fable')).toEqual(ratesForModel('claude-fable-5-2'));
    expect(ratesForModel('opus')).toEqual(ratesForModel('claude-opus-5-5[1m]'));
    expect(ratesForModel('sonnet')).toEqual(ratesForModel('claude-sonnet-5-5'));
    expect(ratesForModel('haiku')).toEqual(ratesForModel('claude-haiku-4-5'));
  });

  it('uses each generation\'s own cache-write and cache-read rates', () => {
    const opus55 = ratesForModel('claude-opus-5-5');
    expect(opus55?.cacheWrite).toBeCloseTo(perMTok(5));
    expect(opus55?.cacheRead).toBeCloseTo(perMTok(0.2));
    const opus48 = ratesForModel('claude-opus-4-8');
    expect(opus48?.cacheWrite).toBeCloseTo(perMTok(6.25));
    expect(opus48?.cacheRead).toBeCloseTo(perMTok(0.5));
    expect(ratesForModel('claude-sonnet-5-5')?.cacheRead).toBeCloseTo(perMTok(0.1));
    expect(ratesForModel('claude-fable-5-1')?.cacheRead).toBeCloseTo(perMTok(0.25));
  });

  it('falls back to the family\'s current model for an unlisted version', () => {
    expect(ratesForModel('claude-opus-6')).toEqual(ratesForModel('opus'));
  });

  it('returns null for unknown / missing models', () => {
    expect(ratesForModel('gpt-4o')).toBeNull();
    expect(ratesForModel(null)).toBeNull();
  });
});

describe('computeSessionCostUsd', () => {
  it('sums all four categories at the model rates', () => {
    // 1M input + 1M output on Opus 4.8 = $5 + $25 = $30
    const cost = computeSessionCostUsd(
      { input: 1_000_000, output: 1_000_000, cacheWrite: 0, cacheRead: 0 },
      'claude-opus-4-8',
    );
    expect(cost).toBeCloseTo(30);
  });

  it('prices cache write and read at the generation\'s cache rates', () => {
    // 1M cache-write on Opus 5.5 = $5; 1M cache-read = $0.20
    const cost = computeSessionCostUsd(
      { input: 0, output: 0, cacheWrite: 1_000_000, cacheRead: 1_000_000 },
      'opus',
    );
    expect(cost).toBeCloseTo(5.2);
  });

  it('returns null when the model is unknown', () => {
    expect(computeSessionCostUsd(empty, 'mystery-model')).toBeNull();
    expect(computeSessionCostUsd(empty, null)).toBeNull();
  });
});

describe('formatCostUsd', () => {
  it('renders an em-dash for null', () => {
    expect(formatCostUsd(null)).toBe('—');
  });

  it('renders <$0.01 for a non-zero sub-cent total', () => {
    expect(formatCostUsd(0.004)).toBe('<$0.01');
  });

  it('renders $0.00 for exactly zero', () => {
    expect(formatCostUsd(0)).toBe('$0.00');
  });

  it('renders two decimal places otherwise', () => {
    expect(formatCostUsd(0.19)).toBe('$0.19');
    expect(formatCostUsd(12.5)).toBe('$12.50');
  });
});
