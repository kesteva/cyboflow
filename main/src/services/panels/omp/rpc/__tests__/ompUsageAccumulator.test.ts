import { describe, expect, it } from 'vitest';
import { OmpTurnUsageAccumulator } from '../ompUsageAccumulator';
import type { OmpUsage } from '../ompContract';

function usage(overrides: Partial<OmpUsage> = {}): OmpUsage {
  return {
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheWrite: 40,
    totalTokens: 100,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
    ...overrides,
  };
}

describe('OmpTurnUsageAccumulator', () => {
  it('reports nothing before any usage is accrued', () => {
    const accumulator = new OmpTurnUsageAccumulator();
    expect(accumulator.snapshot()).toBeUndefined();
    // A missing cost must read as "unknown", never as a recorded $0.
    expect(accumulator.costUsd()).toBeUndefined();
  });

  it('maps OMP token fields straight across without subtraction', () => {
    const accumulator = new OmpTurnUsageAccumulator();
    accumulator.addMessageUsage(usage());
    // OMP's fields are disjoint, so cacheRead is NOT deducted from input the way
    // the Codex accumulator must.
    expect(accumulator.snapshot()).toEqual({
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
    });
    expect(accumulator.costUsd()).toBe(1);
  });

  it('sums across several assistant messages in one turn', () => {
    const accumulator = new OmpTurnUsageAccumulator();
    accumulator.addMessageUsage(usage(), 'msg_1');
    accumulator.addMessageUsage(usage({ input: 5, output: 5, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } }), 'msg_2');

    expect(accumulator.snapshot()).toEqual({
      input_tokens: 15,
      output_tokens: 25,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
    });
    expect(accumulator.costUsd()).toBe(1.5);
    expect(accumulator.accruedMessages).toBe(2);
  });

  it('de-duplicates a repeated responseId — the double-billing guard', () => {
    const accumulator = new OmpTurnUsageAccumulator();
    accumulator.addMessageUsage(usage(), 'msg_1');
    accumulator.addMessageUsage(usage(), 'msg_1');
    accumulator.addMessageUsage(usage(), 'msg_1');

    expect(accumulator.costUsd()).toBe(1);
    expect(accumulator.accruedMessages).toBe(1);
  });

  it('still accrues messages that carry no responseId', () => {
    const accumulator = new OmpTurnUsageAccumulator();
    accumulator.addMessageUsage(usage());
    accumulator.addMessageUsage(usage());
    expect(accumulator.accruedMessages).toBe(2);
    expect(accumulator.costUsd()).toBe(2);
  });

  it('ignores an absent usage block', () => {
    const accumulator = new OmpTurnUsageAccumulator();
    accumulator.addMessageUsage(undefined);
    expect(accumulator.snapshot()).toBeUndefined();
  });

  it('accrues zero cost when a message reports tokens but no cost breakdown', () => {
    const accumulator = new OmpTurnUsageAccumulator();
    accumulator.addMessageUsage(usage({ cost: undefined }));
    expect(accumulator.snapshot()).toEqual({
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
    });
    expect(accumulator.costUsd()).toBe(0);
  });

  it('reads usage off an assistant message directly', () => {
    const accumulator = new OmpTurnUsageAccumulator();
    accumulator.addAssistantMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      usage: usage(),
      responseId: 'msg_1',
    });
    accumulator.addAssistantMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      usage: usage(),
      responseId: 'msg_1',
    });
    expect(accumulator.accruedMessages).toBe(1);
  });

  it('reset() clears the delta AND the de-dup memory so the next turn starts clean', () => {
    const accumulator = new OmpTurnUsageAccumulator();
    accumulator.addMessageUsage(usage(), 'msg_1');
    accumulator.reset();

    expect(accumulator.snapshot()).toBeUndefined();
    expect(accumulator.costUsd()).toBeUndefined();

    // The SAME responseId must accrue again after a reset — a turn boundary
    // ends the de-dup window, otherwise a resumed session would under-bill.
    accumulator.addMessageUsage(usage(), 'msg_1');
    expect(accumulator.costUsd()).toBe(1);
  });

  it('keeps three turns as three separate deltas, never a running rollup', () => {
    const accumulator = new OmpTurnUsageAccumulator();
    const deltas: Array<number | undefined> = [];
    for (const total of [1, 2, 3]) {
      accumulator.reset();
      accumulator.addMessageUsage(usage({
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
      }));
      deltas.push(accumulator.costUsd());
    }
    // Deltas, not 1 / 3 / 6 — that cumulative shape is the double-billing bug.
    expect(deltas).toEqual([1, 2, 3]);
  });
});
