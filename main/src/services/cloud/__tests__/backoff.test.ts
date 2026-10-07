import { describe, it, expect } from 'vitest';
import { computeBackoffMs, DEFAULT_RATE_LIMIT_BACKOFF_MS, parseRetryAfter } from '../backoff';

describe('computeBackoffMs', () => {
  it('stays within [base/2, base] per attempt (random 0 and 1)', () => {
    for (const attempt of [0, 1, 2, 3]) {
      const base = 30_000 * 2 ** attempt;
      expect(computeBackoffMs({ attempt, random: () => 0 })).toBe(base / 2);
      expect(computeBackoffMs({ attempt, random: () => 1 })).toBe(base);
    }
  });

  it('caps the base at capMs', () => {
    expect(computeBackoffMs({ attempt: 20, random: () => 1 })).toBe(900_000);
    expect(computeBackoffMs({ attempt: 20, random: () => 0 })).toBe(450_000);
    expect(computeBackoffMs({ attempt: 5, capMs: 100_000, random: () => 1 })).toBe(100_000);
  });

  it('floors the delay at Retry-After', () => {
    expect(computeBackoffMs({ attempt: 0, retryAfterMs: 120_000, random: () => 0 })).toBe(120_000);
    expect(computeBackoffMs({ attempt: 0, retryAfterMs: 1_000, random: () => 0 })).toBe(15_000);
  });

  it('honours baseMs / capMs (the Bridge relay parameters)', () => {
    expect(computeBackoffMs({ attempt: 1, baseMs: 30_000, capMs: 300_000, random: () => 1 })).toBe(60_000);
  });

  it('treats a negative attempt as 0', () => {
    expect(computeBackoffMs({ attempt: -3, random: () => 1 })).toBe(30_000);
  });
});

describe('parseRetryAfter', () => {
  const NOW = Date.parse('2026-10-07T12:00:00.000Z');

  it('parses integer seconds', () => {
    expect(parseRetryAfter('120', NOW)).toBe(120_000);
    expect(parseRetryAfter(' 0 ', NOW)).toBe(0);
  });

  it('caps integer seconds at one hour', () => {
    expect(parseRetryAfter('999999', NOW)).toBe(3_600_000);
  });

  it('parses an HTTP-date relative to now, never negative', () => {
    expect(parseRetryAfter('Wed, 07 Oct 2026 12:01:00 GMT', NOW)).toBe(60_000);
    expect(parseRetryAfter('Wed, 07 Oct 2026 11:00:00 GMT', NOW)).toBe(0);
  });

  it('returns undefined for null, empty and garbage', () => {
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
    expect(parseRetryAfter('', NOW)).toBeUndefined();
    expect(parseRetryAfter('soon', NOW)).toBeUndefined();
    expect(parseRetryAfter('-5', NOW)).toBeUndefined();
  });

  it('exports the rate-limit floor', () => {
    expect(DEFAULT_RATE_LIMIT_BACKOFF_MS).toBe(30_000);
  });
});
