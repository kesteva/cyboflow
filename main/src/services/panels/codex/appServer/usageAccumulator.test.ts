import { describe, expect, it } from 'vitest';
import { CodexTurnUsageAccumulator, CodexUsageTotals } from './usageAccumulator';
import type { TokenUsageBreakdown } from './protocol';

function usage(input: number, cached: number, cacheWrite: number, output: number, reasoning = 0): TokenUsageBreakdown {
  return {
    totalTokens: input + output,
    inputTokens: input,
    cachedInputTokens: cached,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: output,
    reasoningOutputTokens: reasoning,
  };
}

describe('CodexUsageTotals', () => {
  it('sums response deltas without double-counting cache or reasoning', () => {
    const totals = new CodexUsageTotals();
    totals.add(usage(12, 4, 6, 7, 2));
    totals.add(usage(6, 1, 2, 4, 1));

    // inputTokens is the whole prompt (cache reads + writes included), so both
    // are subtracted out: (12 - 4 - 6) + (6 - 1 - 2) = 5, and the four buckets
    // re-sum to the prompt: 5 + 5 + 8 = 18 = 12 + 6.
    expect(totals.snapshot()).toEqual({
      input_tokens: 5,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 8,
      output_tokens: 11,
      reasoning_output_tokens: 3,
    });
  });

  it('floors uncached input at zero per response and omits usage before the first add', () => {
    const totals = new CodexUsageTotals();
    expect(totals.snapshot()).toBeUndefined();
    totals.add(usage(2, 5, 0, 3));
    totals.add(usage(10, 1, 1, 0));
    // The first response's negative remainder never eats into the second's 8.
    expect(totals.snapshot()?.input_tokens).toBe(8);
  });
});

describe('CodexTurnUsageAccumulator', () => {
  it('counts one response', () => {
    const accumulator = new CodexTurnUsageAccumulator('root');
    expect(accumulator.observeResponse('root', 'r1', usage(10, 3, 0, 7, 2))).toBe(true);
    expect(accumulator.rootSnapshot()).toEqual({
      input_tokens: 7,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 0,
      output_tokens: 7,
      reasoning_output_tokens: 2,
    });
  });

  it('adds several responses up', () => {
    const accumulator = new CodexTurnUsageAccumulator('root');
    accumulator.observeResponse('root', 'r1', usage(10, 3, 0, 7));
    accumulator.observeResponse('root', 'r2', usage(20, 10, 5, 4));
    expect(accumulator.rootSnapshot()).toMatchObject({
      input_tokens: 12,
      cache_read_input_tokens: 13,
      cache_creation_input_tokens: 5,
      output_tokens: 11,
    });
  });

  it('adds 0 for a repeated responseId', () => {
    const accumulator = new CodexTurnUsageAccumulator('root');
    accumulator.observeResponse('root', 'r1', usage(10, 3, 0, 7));
    expect(accumulator.observeResponse('root', 'r1', usage(10, 3, 0, 7))).toBe(false);
    expect(accumulator.rootSnapshot()?.output_tokens).toBe(7);
  });

  it('keeps rootSnapshot and descendantSnapshots disjoint', () => {
    const accumulator = new CodexTurnUsageAccumulator(null);
    accumulator.observeResponse('child-a', 'c1', usage(5, 0, 0, 1));
    accumulator.setRootThread('root');
    accumulator.observeResponse('root', 'r1', usage(10, 0, 0, 2));
    accumulator.observeResponse('child-b', 'c2', usage(8, 0, 0, 3));
    accumulator.observeResponse('child-a', 'c3', usage(4, 0, 0, 1));

    expect(accumulator.rootSnapshot()).toMatchObject({ input_tokens: 10, output_tokens: 2 });
    const descendants = accumulator.descendantSnapshots();
    expect([...descendants.keys()].sort()).toEqual(['child-a', 'child-b']);
    expect(descendants.get('child-a')).toMatchObject({ input_tokens: 9, output_tokens: 2 });
    expect(descendants.get('child-b')).toMatchObject({ input_tokens: 8, output_tokens: 3 });
  });

  it('remembers a null-usage response without counting tokens', () => {
    const accumulator = new CodexTurnUsageAccumulator('root');
    expect(accumulator.observeResponse('root', 'r1', null)).toBe(true);
    expect(accumulator.rootSnapshot()).toBeUndefined();
    expect(accumulator.observeResponse('root', 'r1', usage(10, 0, 0, 1))).toBe(false);
  });
});
