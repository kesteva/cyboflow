import { describe, it, expect } from 'vitest';
import { ratesForModel, computeSessionCostUsd, formatCostUsd } from '../modelPricing';
import type { SessionTokenBreakdown } from '../../hooks/useSessionMetrics';

const empty: SessionTokenBreakdown = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

describe('ratesForModel', () => {
  it('resolves families by substring, tolerating aliases and id suffixes', () => {
    expect(ratesForModel('claude-opus-4-8[1m]')?.input).toBeCloseTo(5 / 1_000_000);
    expect(ratesForModel('opus')?.output).toBeCloseTo(25 / 1_000_000);
    expect(ratesForModel('claude-sonnet-4-6')?.input).toBeCloseTo(3 / 1_000_000);
    expect(ratesForModel('claude-haiku-4-5')?.output).toBeCloseTo(5 / 1_000_000);
  });

  it('applies the 1.25x cache-write and 0.1x cache-read multipliers to the input rate', () => {
    const r = ratesForModel('opus');
    expect(r?.cacheWrite).toBeCloseTo((5 * 1.25) / 1_000_000);
    expect(r?.cacheRead).toBeCloseTo((5 * 0.1) / 1_000_000);
  });

  it('returns null for unknown / missing models', () => {
    expect(ratesForModel('gpt-4o')).toBeNull();
    expect(ratesForModel(null)).toBeNull();
  });
});

describe('computeSessionCostUsd', () => {
  it('sums all four categories at the model rates', () => {
    // 1M input + 1M output on opus = $5 + $25 = $30
    const cost = computeSessionCostUsd(
      { input: 1_000_000, output: 1_000_000, cacheWrite: 0, cacheRead: 0 },
      'claude-opus-4-8',
    );
    expect(cost).toBeCloseTo(30);
  });

  it('prices cache write and read at their multipliers', () => {
    // 1M cache-write on opus = $5 * 1.25 = $6.25; 1M cache-read = $0.50
    const cost = computeSessionCostUsd(
      { input: 0, output: 0, cacheWrite: 1_000_000, cacheRead: 1_000_000 },
      'opus',
    );
    expect(cost).toBeCloseTo(6.75);
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
