import { describe, expect, it } from 'vitest';
import { CodexDescendantRegistry, CodexResponsePairingLedger } from './usageLedger';
import type {
  RawResponseCompletedNotification,
  ThreadTokenUsageUpdatedNotification,
  TokenUsageBreakdown,
} from './protocol';

function usage(input: number, output: number, cached = 0): TokenUsageBreakdown {
  return {
    totalTokens: input + output,
    inputTokens: input,
    cachedInputTokens: cached,
    cacheWriteInputTokens: 0,
    outputTokens: output,
    reasoningOutputTokens: 0,
  };
}

function sum(a: TokenUsageBreakdown, b: TokenUsageBreakdown): TokenUsageBreakdown {
  return {
    totalTokens: a.totalTokens + b.totalTokens,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
  };
}

function response(
  responseId: string,
  value: TokenUsageBreakdown | null,
  turnId = 'turn-a',
  threadId = 't',
): RawResponseCompletedNotification {
  return { threadId, turnId, responseId, usage: value, usageMetadata: null };
}

function update(
  total: TokenUsageBreakdown,
  last: TokenUsageBreakdown,
  turnId = 'turn-a',
  threadId = 't',
): ThreadTokenUsageUpdatedNotification {
  return { threadId, turnId, tokenUsage: { total, last, modelContextWindow: null } };
}

/** Feeds `requests` as one update each, with a running `total`. */
function feedUpdates(ledger: CodexResponsePairingLedger, requests: TokenUsageBreakdown[], turnId = 'turn-a'): void {
  let total = usage(0, 0);
  for (const request of requests) {
    total = sum(total, request);
    ledger.observeTokenUsage(update(total, request, turnId));
  }
}

describe('CodexResponsePairingLedger', () => {
  it('skips a duplicate update whose total did not move, whatever its last says', () => {
    const ledger = new CodexResponsePairingLedger();
    const first = usage(10, 1);
    expect(ledger.observeTokenUsage(update(first, first))).toBe(true);
    // Same total, non-zero last: a re-emission, not a request.
    expect(ledger.observeTokenUsage(update(first, first))).toBe(false);
    const settlement = ledger.settle();
    expect(settlement.topups.get('t')).toEqual([first]);
  });

  it('tops up exactly the unmatched update when 3 updates meet 2 responses', () => {
    const ledger = new CodexResponsePairingLedger();
    const requests = [usage(10, 1), usage(20, 2), usage(30, 3)];
    feedUpdates(ledger, requests);
    ledger.observeResponse(response('r1', requests[0]));
    ledger.observeResponse(response('r3', requests[2]));
    expect(ledger.settle().topups.get('t')).toEqual([requests[1]]);
  });

  it('tops up a null-usage response from its update', () => {
    const ledger = new CodexResponsePairingLedger();
    const request = usage(10, 1);
    ledger.observeResponse(response('r1', null));
    feedUpdates(ledger, [request]);
    // The null response answered the update, so nothing is pending...
    expect(ledger.hasPendingResponse('t')).toBe(false);
    // ...but its tokens still come from the update.
    expect(ledger.settle().topups.get('t')).toEqual([request]);
  });

  it('matches an update in turn A with its response in turn B instead of topping it up', () => {
    const ledger = new CodexResponsePairingLedger();
    const request = usage(10, 1);
    feedUpdates(ledger, [request], 'turn-a');
    expect(ledger.hasPendingResponse('t')).toBe(true);
    ledger.observeResponse(response('r1', request, 'turn-b'));
    expect(ledger.hasPendingResponse('t')).toBe(false);
    expect(ledger.settle().topups.size).toBe(0);
  });

  it('tops up exactly one of two identical-usage requests when one response is missing', () => {
    const ledger = new CodexResponsePairingLedger();
    const request = usage(10, 1);
    feedUpdates(ledger, [request, request]);
    ledger.observeResponse(response('r1', request));
    expect(ledger.settle().topups.get('t')).toEqual([request]);
  });

  it('baselines a second turn on the same process against the first turn\'s last total', () => {
    const ledger = new CodexResponsePairingLedger();
    const a = usage(10, 1);
    const b = usage(20, 2);
    ledger.observeTokenUsage(update(a, a, 'turn-a'));
    // Turn B re-emits turn A's closing total before its own request: a duplicate.
    expect(ledger.observeTokenUsage(update(a, a, 'turn-b'))).toBe(false);
    expect(ledger.observeTokenUsage(update(sum(a, b), b, 'turn-b'))).toBe(true);
    expect(ledger.settle().topups.get('t')).toEqual([a, b]);
  });

  it('starts every thread of a new process at a zero baseline', () => {
    const first = new CodexResponsePairingLedger();
    const request = usage(10, 1);
    first.observeTokenUsage(update(request, request));
    first.settle();

    // A resumed thread in a new process restarts `total`; the same figure is a
    // fresh request there, not a duplicate of the old process's reading.
    const second = new CodexResponsePairingLedger();
    expect(second.observeTokenUsage(update(request, request))).toBe(true);
    // A zero total is never a request.
    const third = new CodexResponsePairingLedger();
    expect(third.observeTokenUsage(update(usage(0, 0), usage(0, 0)))).toBe(false);
  });

  it('counts compaction requests and never flags their oracle disagreement', () => {
    const ledger = new CodexResponsePairingLedger();
    const normal = usage(10, 1);
    const compaction = usage(50, 5);
    feedUpdates(ledger, [normal]);
    ledger.observeResponse(response('r1', normal));
    // The compaction request's response arrives, but `total` never includes it.
    ledger.observeResponse(response('r-compact', compaction));
    ledger.observeCompaction('t');
    const settlement = ledger.settle();
    expect(settlement.topups.size).toBe(0);
    expect(settlement.oracleMismatches).toEqual([]);
  });

  it('flags an oracle mismatch that compaction does not explain', () => {
    const ledger = new CodexResponsePairingLedger();
    const request = usage(10, 1);
    feedUpdates(ledger, [request]);
    ledger.observeResponse(response('r1', request));
    ledger.observeResponse(response('r2', usage(7, 1)));
    expect(ledger.settle().oracleMismatches).toEqual([{
      threadId: 't',
      oracleInput: 10,
      oracleOutput: 1,
      storedInput: 17,
      storedOutput: 2,
    }]);
  });

  it('reports a turn with usage snapshots but no responses as drift', () => {
    const ledger = new CodexResponsePairingLedger();
    feedUpdates(ledger, [usage(10, 1)], 'turn-a');
    ledger.observeResponse(response('r1', usage(3, 1), 'turn-b'));
    expect(ledger.settle().driftTurns).toEqual([{ threadId: 't', turnId: 'turn-a' }]);
  });

  it('ignores a replayed response id and anything after settlement', () => {
    const ledger = new CodexResponsePairingLedger();
    expect(ledger.observeResponse(response('r1', usage(1, 1)))).toBe(true);
    expect(ledger.observeResponse(response('r1', usage(1, 1)))).toBe(false);
    ledger.settle();
    expect(ledger.observeResponse(response('r2', usage(1, 1)))).toBe(false);
    expect(ledger.settle().topups.size).toBe(0);
  });
});

describe('CodexDescendantRegistry', () => {
  it('registers children of the root owner, transitively, keeping the first owner', () => {
    const registry = new CodexDescendantRegistry<string>((threadId) => (threadId === 'root' ? 'inv-1' : null));
    // A grandchild announced before its parent registers is held, then released.
    expect(registry.register('child', 'turn-c', [{ threadId: 'grandchild', model: null }])).toEqual([]);
    const added = registry.register('root', 'turn-r', [{ threadId: 'child', model: 'gpt-child' }]);
    expect(added.map((record) => [record.threadId, record.parentThreadId, record.owner])).toEqual([
      ['child', 'root', 'inv-1'],
      ['grandchild', 'child', 'inv-1'],
    ]);
    // Re-registration never moves the owner; it only fills a missing model.
    expect(registry.register('root', 'turn-r', [{ threadId: 'grandchild', model: 'gpt-grand' }])).toEqual([]);
    expect(registry.get('grandchild')).toMatchObject({ owner: 'inv-1', model: 'gpt-grand' });
    expect(registry.descendantsOf('inv-1')).toHaveLength(2);
  });

  it('resolves a model-less child to its nearest ancestor\'s model, flagged inferred', () => {
    const registry = new CodexDescendantRegistry<string>(() => 'inv-1');
    registry.register('root', 'turn', [{ threadId: 'child', model: 'gpt-child' }]);
    registry.register('child', 'turn', [{ threadId: 'grandchild', model: null }]);
    registry.register('root', 'turn', [{ threadId: 'bare', model: null }]);
    expect(registry.resolveModel('child', 'gpt-root')).toEqual({ model: 'gpt-child', inferred: false });
    expect(registry.resolveModel('grandchild', 'gpt-root')).toEqual({ model: 'gpt-child', inferred: true });
    expect(registry.resolveModel('bare', 'gpt-root')).toEqual({ model: 'gpt-root', inferred: true });
  });

  it('tracks terminal state per thread', () => {
    const registry = new CodexDescendantRegistry<string>(() => 'inv-1');
    expect(registry.isTerminal('child')).toBe(false);
    registry.markTerminal('child');
    expect(registry.isTerminal('child')).toBe(true);
    registry.markRunning('child');
    expect(registry.isTerminal('child')).toBe(false);
  });
});
