import { describe, it, expect } from 'vitest';
import { primaryModelContextWindow, primaryModelUsageEntry } from '../primaryModelUsage';

describe('primaryModelUsage', () => {
  it('picks the main model over a Haiku side query listed FIRST (regression: 1M Opus read as 200k)', () => {
    const modelUsage = {
      'claude-haiku-4-5-20251001': { contextWindow: 200000, inputTokens: 897 },
      'claude-opus-5-5[1m]': { contextWindow: 1000000, inputTokens: 2 },
    };
    expect(primaryModelContextWindow(modelUsage)).toBe(1000000);
    expect(primaryModelUsageEntry(modelUsage)).toBe(modelUsage['claude-opus-5-5[1m]']);
  });

  it('keeps the earlier entry on a tie', () => {
    const modelUsage = { a: { contextWindow: 200000 }, b: { contextWindow: 200000 } };
    expect(primaryModelUsageEntry(modelUsage)).toBe(modelUsage.a);
  });

  it('skips malformed entries and non-positive windows', () => {
    expect(
      primaryModelContextWindow({ a: null, b: { contextWindow: 'lots' }, c: { contextWindow: 0 }, d: { contextWindow: 200000 } }),
    ).toBe(200000);
  });

  it('returns null when nothing reports a window', () => {
    expect(primaryModelContextWindow(undefined)).toBeNull();
    expect(primaryModelContextWindow({})).toBeNull();
    expect(primaryModelContextWindow({ a: { inputTokens: 5 } })).toBeNull();
  });
});
