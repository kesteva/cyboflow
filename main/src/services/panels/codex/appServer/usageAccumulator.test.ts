import { describe, expect, it } from 'vitest';
import { CodexTurnUsageAccumulator } from './usageAccumulator';

describe('CodexTurnUsageAccumulator', () => {
  it('sums response deltas without double-counting cache or reasoning', () => {
    const accumulator = new CodexTurnUsageAccumulator();
    accumulator.addLastUsage({
      totalTokens: 19,
      inputTokens: 12,
      cachedInputTokens: 4,
      cacheWriteInputTokens: 6,
      outputTokens: 7,
      reasoningOutputTokens: 2,
    });
    accumulator.addLastUsage({
      totalTokens: 10,
      inputTokens: 6,
      cachedInputTokens: 1,
      cacheWriteInputTokens: 2,
      outputTokens: 4,
      reasoningOutputTokens: 1,
    });

    // inputTokens is the whole prompt (cache reads + writes included), so both
    // are subtracted out: (12 - 4 - 6) + (6 - 1 - 2) = 5, and the four buckets
    // re-sum to the prompt: 5 + 5 + 8 = 18 = 12 + 6.
    expect(accumulator.snapshot()).toEqual({
      input_tokens: 5,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 8,
      output_tokens: 11,
      reasoning_output_tokens: 3,
    });
  });

  it('floors billable input at zero and omits usage before the first update', () => {
    const accumulator = new CodexTurnUsageAccumulator();
    expect(accumulator.snapshot()).toBeUndefined();

    accumulator.addLastUsage({
      totalTokens: 5,
      inputTokens: 2,
      cachedInputTokens: 5,
      cacheWriteInputTokens: 0,
      outputTokens: 3,
      reasoningOutputTokens: 0,
    });
    expect(accumulator.snapshot()?.input_tokens).toBe(0);
  });
});
