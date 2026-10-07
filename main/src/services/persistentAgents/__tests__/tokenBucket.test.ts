import { describe, it, expect, vi, afterEach } from 'vitest';
import { TokenBuckets, budgetKeyFor } from '../tokenBucket';
import { createFakeConnector, makeHarness } from './fakeConnector';

afterEach(() => { vi.useRealTimers(); });

describe('TokenBuckets', () => {
  it('configure with capacity 20 allows a burst of 20 then refills at rate/60 per s', () => {
    let t = 0;
    const b = new TokenBuckets({ now: () => t });
    b.configure('k', 100, 20);
    for (let i = 0; i < 20; i++) expect(b.tryTake('k')).toBe(true);
    expect(b.tryTake('k')).toBe(false);
    expect(b.nextAvailableAt('k')).toBe(600);
    t = 599;
    expect(b.tryTake('k')).toBe(false);
    t = 600;
    expect(b.tryTake('k')).toBe(true);
    t = 600 + 60_000;
    for (let i = 0; i < 20; i++) expect(b.tryTake('k')).toBe(true);
    expect(b.tryTake('k')).toBe(false); // never above capacity
  });

  it('defaults to 120/min with capacity = rate', () => {
    const b = new TokenBuckets({ now: () => 0 });
    let n = 0;
    while (b.tryTake('fresh')) n += 1;
    expect(n).toBe(120);
  });

  it('refund returns one token, never above capacity', () => {
    const b = new TokenBuckets({ now: () => 0 });
    b.configure('k', 60, 1);
    expect(b.tryTake('k')).toBe(true);
    b.refund('k');
    b.refund('k');
    expect(b.tryTake('k')).toBe(true);
    expect(b.tryTake('k')).toBe(false);
  });

  it('take waits for a refill within maxWaitMs and gives up beyond it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const b = new TokenBuckets({ now: () => Date.now() });
    b.configure('k', 60, 1);
    expect(b.tryTake('k')).toBe(true);
    expect(await b.take('k', 500)).toBe(false); // next token in 1 s
    const p = b.take('k', 5_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await p).toBe(true);
  });

  it('budgetKeyFor uses the connector budget (with capacity) or a default key', () => {
    const h = makeHarness();
    const fake = createFakeConnector({ budget: { key: 'bridge-device', ratePerMinute: 100, capacity: 20 } });
    const handle = {
      connectionId: 'c1', agentId: 'a', agentHandle: 'a', agentDisplayName: 'A', vendor: 'other' as const, connectorId: 'bridge',
      connectorVersion: 1, kind: 'bridge' as const, transport: null, state: 'pending' as const, generation: 1, remoteId: null,
      remote: {}, credential: null, inboundCursor: null, relayEpoch: null,
    };
    expect(budgetKeyFor(h.budget, fake.connector, handle)).toBe('bridge-device');
    let n = 0;
    while (h.budget.tryTake('bridge-device')) n += 1;
    expect(n).toBe(20);
    const plain = createFakeConnector();
    expect(budgetKeyFor(h.budget, plain.connector, handle)).toBe('conn:c1');
    expect(budgetKeyFor(h.budget, plain.connector, { ...handle, credential: { id: 'k1', version: 1 } })).toBe('cred:k1');
    h.raw.close();
  });
});
