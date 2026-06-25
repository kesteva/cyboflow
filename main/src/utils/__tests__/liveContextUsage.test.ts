import { describe, it, expect } from 'vitest';
import {
  deriveLiveContextUsage,
  formatContextTokens,
  type ContextOutput,
} from '../liveContextUsage';

/** An assistant `json` output whose message carries the given usage buckets. */
function assistant(usage: {
  input?: number;
  cacheRead?: number;
  cacheCreation?: number;
}): ContextOutput {
  return {
    type: 'json',
    data: {
      type: 'assistant',
      message: {
        usage: {
          input_tokens: usage.input ?? 0,
          cache_read_input_tokens: usage.cacheRead ?? 0,
          cache_creation_input_tokens: usage.cacheCreation ?? 0,
        },
      },
    },
  };
}

/** A result `json` output exposing a modelUsage contextWindow (+ optional
 *  cumulative counts that the deriver must IGNORE for the numerator). */
function result(contextWindow: number, cumulative?: { input?: number; cacheRead?: number }): ContextOutput {
  return {
    type: 'json',
    data: {
      type: 'result',
      modelUsage: {
        'claude-opus-4-8': {
          contextWindow,
          inputTokens: cumulative?.input ?? 0,
          cacheReadInputTokens: cumulative?.cacheRead ?? 0,
        },
      },
    },
  };
}

function init(contextWindow: number): ContextOutput {
  return { type: 'json', data: { type: 'system', subtype: 'init', context_window: contextWindow } };
}

describe('formatContextTokens', () => {
  it('compacts >= 1k to "Nk" and leaves sub-1k exact', () => {
    expect(formatContextTokens(76000)).toBe('76k');
    expect(formatContextTokens(1_000_000)).toBe('1000k');
    expect(formatContextTokens(950)).toBe('950');
  });
});

describe('deriveLiveContextUsage', () => {
  it('pairs the newest assistant live prompt with the result context window', () => {
    // input 1000 + cacheRead 16000 + cacheCreation 1000 = 18000 of a 1M window.
    const outputs = [
      assistant({ input: 1000, cacheRead: 16000, cacheCreation: 1000 }),
      result(1_000_000),
    ];
    expect(deriveLiveContextUsage(outputs)).toBe('18k/1000k tokens (2%)');
  });

  it('does NOT peg at 100% when the result event reports a huge CUMULATIVE total', () => {
    // The regression: a long, tool-heavy turn. The result's cumulative counts
    // (8.3M) dwarf the 1M window, but the live prompt of the newest assistant
    // message is only ~18k — the meter must read ~2%, not 100%.
    const outputs = [
      assistant({ input: 13000, cacheRead: 4000, cacheCreation: 1000 }), // 18k live
      result(1_000_000, { input: 640000, cacheRead: 7674110 }), // 8.3M cumulative — ignored
    ];
    expect(deriveLiveContextUsage(outputs)).toBe('18k/1000k tokens (2%)');
  });

  it('takes the FIRST (newest, caller-ordered) assistant message when several are present', () => {
    const outputs = [
      assistant({ cacheRead: 54000 }), // newest → wins
      assistant({ cacheRead: 200000 }), // older → ignored
      result(200000),
    ];
    expect(deriveLiveContextUsage(outputs)).toBe('54k/200k tokens (27%)');
  });

  it('clamps a single turn that genuinely fills the window to 100% (real, not a mask)', () => {
    const outputs = [assistant({ cacheRead: 1_200_000 }), result(1_000_000)];
    expect(deriveLiveContextUsage(outputs)).toBe('1000k/1000k tokens (100%)');
  });

  it('sources the context window from an init message when no result is present', () => {
    const outputs = [assistant({ input: 5000, cacheRead: 49000 }), init(200000)];
    expect(deriveLiveContextUsage(outputs)).toBe('54k/200k tokens (27%)');
  });

  it('returns null with no assistant usage (caller falls back to legacy extraction)', () => {
    expect(deriveLiveContextUsage([result(1_000_000)])).toBeNull();
  });

  it('returns null when an assistant message has no usable usage', () => {
    const outputs = [
      { type: 'json', data: { type: 'assistant', message: {} } },
      result(1_000_000),
    ];
    expect(deriveLiveContextUsage(outputs)).toBeNull();
  });

  it('returns null when there is no context window to pair the numerator with', () => {
    expect(deriveLiveContextUsage([assistant({ cacheRead: 18000 })])).toBeNull();
  });

  it('ignores non-json outputs (e.g. PTY stdout)', () => {
    const outputs: ContextOutput[] = [
      { type: 'stdout', data: 'some terminal text' },
      assistant({ cacheRead: 18000 }),
      result(1_000_000),
    ];
    expect(deriveLiveContextUsage(outputs)).toBe('18k/1000k tokens (2%)');
  });
});
