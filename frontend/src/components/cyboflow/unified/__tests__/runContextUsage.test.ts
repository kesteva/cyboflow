import { describe, it, expect } from 'vitest';
import { deriveRunContextUsage } from '../runContextUsage';
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
const MODEL = 'claude-opus-4-8';

describe('deriveRunContextUsage', () => {
  it('returns null for an empty stream', () => {
    expect(deriveRunContextUsage([])).toBeNull();
  });

  it('returns null when only assistant usage has arrived (no context window yet)', () => {
    // The window only comes from a result event; until then the meter is "--%".
    expect(deriveRunContextUsage([assistant({ input_tokens: 5000, cache_read_input_tokens: 40000 })])).toBeNull();
  });

  it('computes the %-string from a result modelUsage (window + input + cache)', () => {
    const events = [
      result({ [MODEL]: { contextWindow: 200000, inputTokens: 8000, cacheReadInputTokens: 120000, cacheCreationInputTokens: 0 } }),
    ];
    // used = 8000 + 120000 = 128000 → 128k / 200k = 64%
    expect(deriveRunContextUsage(events)).toBe('128k/200k tokens (64%)');
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
