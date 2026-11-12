import { describe, it, expect } from 'vitest';
import { PendingRemotePreps } from '../remotePrepCancel';

describe('PendingRemotePreps', () => {
  it('cancels by spawnKey, panelId or runId, and null cancels all', () => {
    const preps = new PendingRemotePreps();
    const a = preps.begin('lane-a', 'run-1', 'run-1');
    const b = preps.begin('panel-b', 'panel-b');
    preps.cancel('lane-a');
    expect([a.cancelled, b.cancelled]).toEqual([true, false]);
    const c = preps.begin('run-2:item', 'run-2', 'run-2');
    preps.cancel('run-2');
    expect(c.cancelled).toBe(true);
    preps.cancel(null);
    expect(b.cancelled).toBe(true);
  });

  it('a stale cancel never poisons the next spawn on the same key', () => {
    const preps = new PendingRemotePreps();
    const first = preps.begin('k', 'p');
    preps.cancel('k');
    const second = preps.begin('k', 'p');
    preps.end('k', first); // the older spawn settling must not drop the newer token
    expect(second.cancelled).toBe(false);
    preps.cancel('k');
    expect(second.cancelled).toBe(true);
    preps.end('k', second);
    const third = preps.begin('k', 'p');
    expect(third.cancelled).toBe(false);
  });
});
