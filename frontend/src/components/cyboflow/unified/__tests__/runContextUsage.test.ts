import { describe, it, expect } from 'vitest';
import {
  deriveRunContextUsage,
  deriveRunContextUsageParts,
  stepRunContextUsageParts,
  EMPTY_CONTEXT_USAGE_PARTS,
} from '../runContextUsage';
import type { StreamEvent } from '../../../../utils/cyboflowApi';

// Minimal stream-event fixtures. The real StreamEvent union carries many more
// required fields (timestamp, runId, …); tests intentionally fake the shape and
// cast — only the fields the deriver reads matter.
function assistant(usage: Record<string, number>): StreamEvent {
  return { type: 'assistant', payload: { message: { usage } } } as unknown as StreamEvent;
}
function result(modelUsage: Record<string, unknown> | undefined): StreamEvent {
  return { type: 'result', payload: { modelUsage } } as unknown as StreamEvent;
}
function streamDelta(): StreamEvent {
  return {
    type: 'stream_event',
    payload: { event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } },
  } as unknown as StreamEvent;
}
const MODEL = 'claude-opus-4-8';

/** Fold the incremental step over a sequence, matching the store's flush loop. */
function foldParts(events: StreamEvent[]): { used: number | null; contextWindow: number | null } {
  return events.reduce(stepRunContextUsageParts, EMPTY_CONTEXT_USAGE_PARTS);
}

describe('deriveRunContextUsage', () => {
  it('returns null for an empty stream', () => {
    expect(deriveRunContextUsage([])).toBeNull();
  });

  it('returns null when only assistant usage has arrived (no context window yet)', () => {
    // The window only comes from a result event; until then the meter is "--%".
    expect(deriveRunContextUsage([assistant({ input_tokens: 5000, cache_read_input_tokens: 40000 })])).toBeNull();
  });

  it('takes the WINDOW from a result but the NUMERATOR from per-turn assistant usage', () => {
    const events = [
      // result carries the window; its OWN (cumulative) token counts are ignored
      result({ [MODEL]: { contextWindow: 200000, inputTokens: 8000, cacheReadInputTokens: 120000, cacheCreationInputTokens: 0 } }),
      assistant({ input_tokens: 2000, cache_read_input_tokens: 60000, cache_creation_input_tokens: 0 }),
    ];
    // used = the assistant turn (62000), NOT the result's cumulative 128000.
    expect(deriveRunContextUsage(events)).toBe('62k/200k tokens (31%)');
  });

  it('returns null for a result with no preceding assistant usage (window only → "--%")', () => {
    // A result establishes the window but its cumulative counts are not a live
    // snapshot; with no per-turn assistant usage there is no numerator.
    expect(
      deriveRunContextUsage([result({ [MODEL]: { contextWindow: 200000, inputTokens: 8000, cacheReadInputTokens: 120000 } })]),
    ).toBeNull();
  });

  it('does NOT let a trailing cumulative result peg the meter (regression: ctx 100% bug)', () => {
    // Exact payloads from the wedged Ship run ee0f2a69: the final result's
    // modelUsage summed 2.39M cumulative tokens (mostly cache re-reads) — the
    // old deriver clamped that to the 1M window and showed 100%. The true live
    // context is the last assistant turn (~96k = 10%).
    const events = [
      assistant({ input_tokens: 1, cache_read_input_tokens: 95708, cache_creation_input_tokens: 273 }),
      result({
        ['claude-opus-4-7[1m]']: {
          contextWindow: 1_000_000,
          inputTokens: 171,
          cacheReadInputTokens: 2_156_264,
          cacheCreationInputTokens: 235_454,
        },
      }),
    ];
    expect(deriveRunContextUsage(events)).toBe('96k/1000k tokens (10%)');
  });

  it('keeps the last-seen window and tracks the newer assistant usage (live update)', () => {
    const events = [
      result({ [MODEL]: { contextWindow: 200000, inputTokens: 8000, cacheReadInputTokens: 120000 } }),
      // a later in-flight turn — no new result yet, so the window persists
      assistant({ input_tokens: 2000, cache_read_input_tokens: 150000, cache_creation_input_tokens: 0 }),
    ];
    // used = 152000 over the prior 200000 window → 76%
    expect(deriveRunContextUsage(events)).toBe('152k/200k tokens (76%)');
  });

  it('clamps used to the window (never reports over 100%)', () => {
    const events = [
      result({ [MODEL]: { contextWindow: 200000, inputTokens: 1000 } }),
      assistant({ input_tokens: 300000 }),
    ];
    expect(deriveRunContextUsage(events)).toBe('200k/200k tokens (100%)');
  });

  it('ignores malformed modelUsage (no numeric contextWindow → null)', () => {
    expect(deriveRunContextUsage([result({ [MODEL]: { contextWindow: 'lots' } })])).toBeNull();
    expect(deriveRunContextUsage([result({})])).toBeNull();
    expect(deriveRunContextUsage([result(undefined)])).toBeNull();
  });

  it('ignores a window with zero used tokens', () => {
    expect(deriveRunContextUsage([result({ [MODEL]: { contextWindow: 200000 } })])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// stepRunContextUsageParts — the incremental form used by the store at flush
// time. It MUST equal a full re-scan (deriveRunContextUsageParts), and must
// preserve object identity when an event carries no meter fact (so a zustand
// selector on the stored parts short-circuits).
// ---------------------------------------------------------------------------

describe('stepRunContextUsageParts (incremental) equals the full scan', () => {
  const sequences: Array<[string, StreamEvent[]]> = [
    ['empty', []],
    ['assistant-only (no window yet)', [assistant({ input_tokens: 5000, cache_read_input_tokens: 40000 })]],
    ['result-only (no numerator)', [result({ [MODEL]: { contextWindow: 200000 } })]],
    [
      'assistant + result + next-turn deltas + later assistant',
      [
        assistant({ input_tokens: 5000, cache_read_input_tokens: 40000 }),
        result({ [MODEL]: { contextWindow: 200000, inputTokens: 8000, cacheReadInputTokens: 120000 } }),
        streamDelta(),
        streamDelta(),
        assistant({ input_tokens: 2000, cache_read_input_tokens: 60000, cache_creation_input_tokens: 0 }),
        result({ [MODEL]: { contextWindow: 200000 } }),
      ],
    ],
    [
      'cumulative trailing result must NOT peg (regression: ctx 100%)',
      [
        assistant({ input_tokens: 1, cache_read_input_tokens: 95708, cache_creation_input_tokens: 273 }),
        result({
          ['claude-opus-4-7[1m]']: {
            contextWindow: 1_000_000,
            inputTokens: 171,
            cacheReadInputTokens: 2_156_264,
            cacheCreationInputTokens: 235_454,
          },
        }),
      ],
    ],
    ['zero-usage assistant is ignored', [
      result({ [MODEL]: { contextWindow: 200000 } }),
      assistant({ input_tokens: 3000, cache_read_input_tokens: 5000 }),
      assistant({ input_tokens: 0, cache_read_input_tokens: 0 }),
    ]],
    ['malformed window ignored', [result({ [MODEL]: { contextWindow: 'lots' } as unknown as Record<string, number> })]],
  ];

  it.each(sequences)('(b) matches deriveRunContextUsageParts for: %s', (_label, events) => {
    expect(foldParts(events)).toEqual(deriveRunContextUsageParts(events));
  });

  it('returns the SAME object reference when an event carries no meter fact', () => {
    const parts = { used: 62000, contextWindow: 200000 };
    // A stream_event delta, an assistant with an equal count, and a result with
    // an equal window all leave both numbers untouched → identity preserved.
    expect(stepRunContextUsageParts(parts, streamDelta())).toBe(parts);
    expect(stepRunContextUsageParts(parts, assistant({ input_tokens: 62000 }))).toBe(parts);
    expect(stepRunContextUsageParts(parts, result({ [MODEL]: { contextWindow: 200000 } }))).toBe(parts);
  });

  it('returns a NEW object when a number changes', () => {
    const parts = { used: 1000, contextWindow: null as number | null };
    const next = stepRunContextUsageParts(parts, result({ [MODEL]: { contextWindow: 200000 } }));
    expect(next).not.toBe(parts);
    expect(next).toEqual({ used: 1000, contextWindow: 200000 });
  });
});
