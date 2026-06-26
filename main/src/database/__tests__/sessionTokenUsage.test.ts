import { describe, it, expect } from 'vitest';
import { sumSessionOutputTokenUsage } from '../sessionTokenUsage';

const row = (o: unknown) => ({ data: JSON.stringify(o) });

const ZERO = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheCreationTokens: 0,
  messageCount: 0,
};

describe('sumSessionOutputTokenUsage', () => {
  it('sums per-turn usage from SDK `result` messages (the nested shape)', () => {
    const rows = [
      row({
        type: 'result',
        usage: {
          input_tokens: 3,
          output_tokens: 104,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 1000,
        },
      }),
      row({
        type: 'result',
        usage: {
          input_tokens: 3,
          output_tokens: 68,
          cache_read_input_tokens: 21476,
          cache_creation_input_tokens: 0,
        },
      }),
    ];
    expect(sumSessionOutputTokenUsage(rows)).toEqual({
      totalInputTokens: 6,
      totalOutputTokens: 172,
      totalCacheReadTokens: 21476,
      totalCacheCreationTokens: 1000,
      messageCount: 2,
    });
  });

  it('ignores assistant messages so a single turn is not double-counted', () => {
    // The regression: an assistant message ALSO carries usage (nested one level
    // deeper, under message.usage) and several fire per turn — summing them
    // would over-count. Only the `result` row should be counted.
    const rows = [
      row({
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 9,
            output_tokens: 7,
            cache_read_input_tokens: 42952,
            cache_creation_input_tokens: 27684,
          },
        },
      }),
      row({
        type: 'result',
        usage: {
          input_tokens: 3,
          output_tokens: 250,
          cache_read_input_tokens: 21476,
          cache_creation_input_tokens: 0,
        },
      }),
    ];
    expect(sumSessionOutputTokenUsage(rows)).toEqual({
      totalInputTokens: 3,
      totalOutputTokens: 250,
      totalCacheReadTokens: 21476,
      totalCacheCreationTokens: 0,
      messageCount: 1,
    });
  });

  it('ignores stream_event / system / rate_limit_event / session_info rows', () => {
    const rows = [
      row({ type: 'stream_event', event: { type: 'content_block_delta' } }),
      row({ type: 'system', subtype: 'hook_started' }),
      row({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }),
      row({ type: 'session_info', initial_prompt: 'hi' }),
    ];
    expect(sumSessionOutputTokenUsage(rows)).toEqual(ZERO);
  });

  it('honours legacy flat rows (usage at the top level, no envelope `type`)', () => {
    const rows = [
      row({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      }),
    ];
    expect(sumSessionOutputTokenUsage(rows)).toEqual({
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalCacheReadTokens: 10,
      totalCacheCreationTokens: 5,
      messageCount: 1,
    });
  });

  it('treats missing usage fields as 0 and skips unparseable rows', () => {
    const rows = [
      { data: 'not json' },
      row({ type: 'result', usage: { output_tokens: 42 } }),
    ];
    expect(sumSessionOutputTokenUsage(rows)).toEqual({
      totalInputTokens: 0,
      totalOutputTokens: 42,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      messageCount: 1,
    });
  });

  it('returns all-zero for an empty session', () => {
    expect(sumSessionOutputTokenUsage([])).toEqual(ZERO);
  });
});
