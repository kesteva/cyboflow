/**
 * webViewerCaps — the eviction order, the pin rules and the open rejections.
 * docs/proposals/native-web-viewer.md §3.4.
 */
import { describe, it, expect } from 'vitest';
import {
  checkOpen,
  DEFAULT_CAP_LIMITS,
  isPinned,
  selectEvictions,
  type CapLimits,
  type CapRecord,
} from '../webViewerCaps';

const NOW = 1_000_000_000;
const LIMITS: CapLimits = { ...DEFAULT_CAP_LIMITS, maxLoadedViews: 3, maxLoadedViewsGlobal: 5, maxTabs: 4 };

function rec(tabId: string, over: Partial<CapRecord> = {}): CapRecord {
  return {
    tabId,
    sessionId: 's1',
    openedBy: 'user',
    loaded: true,
    visible: false,
    lastActiveAt: NOW - 1000,
    lastAgentReadAt: null,
    ...over,
  };
}

describe('isPinned', () => {
  it('pins an agent-opened tab, and a human tab an agent read within the TTL', () => {
    expect(isPinned(rec('a', { openedBy: 'agent' }), NOW)).toBe(true);
    expect(isPinned(rec('b', { lastAgentReadAt: NOW - 60_000 }), NOW)).toBe(true);
    expect(isPinned(rec('c'), NOW)).toBe(false);
  });

  it('lets a read-pin expire after pinTtlMs', () => {
    const stale = rec('b', { lastAgentReadAt: NOW - DEFAULT_CAP_LIMITS.pinTtlMs });
    expect(isPinned(stale, NOW)).toBe(false);
  });
});

describe('selectEvictions', () => {
  it('evicts nothing within the caps', () => {
    expect(selectEvictions([rec('a'), rec('b'), rec('c')], NOW, { limits: LIMITS })).toEqual([]);
  });

  it('evicts the least-recently-active unpinned tab first', () => {
    const records = [
      rec('old', { lastActiveAt: NOW - 9000 }),
      rec('mid', { lastActiveAt: NOW - 5000 }),
      rec('new', { lastActiveAt: NOW - 1000 }),
      rec('newest', { lastActiveAt: NOW }),
    ];
    expect(selectEvictions(records, NOW, { limits: LIMITS })).toEqual(['old']);
  });

  it('prefers any unpinned tab over a pinned one, however stale', () => {
    const records = [
      rec('pinned-ancient', { openedBy: 'agent', lastActiveAt: NOW - 99_999 }),
      rec('u1', { lastActiveAt: NOW - 10 }),
      rec('u2', { lastActiveAt: NOW - 5 }),
      rec('u3', { lastActiveAt: NOW }),
    ];
    expect(selectEvictions(records, NOW, { limits: LIMITS })).toEqual(['u1']);
  });

  it('makes pins COMPETE within the cap — least-recently-read pin goes first', () => {
    // An agent opening tabs in a loop must not hold unbounded renderers alive.
    const records = [
      rec('p1', { openedBy: 'agent', lastAgentReadAt: NOW - 100 }),
      rec('p2', { openedBy: 'agent', lastAgentReadAt: NOW - 900 }),
      rec('p3', { openedBy: 'agent', lastAgentReadAt: NOW - 50 }),
      rec('p4', { openedBy: 'agent', lastAgentReadAt: NOW - 10 }),
    ];
    expect(selectEvictions(records, NOW, { limits: LIMITS })).toEqual(['p2']);
  });

  it('never evicts the visible tab or the protected (just-loaded) tab', () => {
    const records = [
      rec('visible', { visible: true, lastActiveAt: 0 }),
      rec('fresh', { lastActiveAt: 1 }),
      rec('b', { lastActiveAt: NOW - 10 }),
      rec('c', { lastActiveAt: NOW }),
    ];
    expect(selectEvictions(records, NOW, { limits: LIMITS, protectTabId: 'fresh' })).toEqual(['b']);
  });

  it('ignores rows that hold no view', () => {
    const records = [rec('a'), rec('b'), rec('c'), rec('row', { loaded: false })];
    expect(selectEvictions(records, NOW, { limits: LIMITS })).toEqual([]);
  });

  it('enforces the GLOBAL ceiling across sessions that are each within their own cap', () => {
    const records = [
      ...['a1', 'a2', 'a3'].map((id, i) => rec(id, { sessionId: 'A', lastActiveAt: NOW - 100 + i })),
      ...['b1', 'b2', 'b3'].map((id, i) => rec(id, { sessionId: 'B', lastActiveAt: NOW - 50 + i })),
    ];
    // 6 loaded, global 5 → exactly one, the app-wide LRU.
    expect(selectEvictions(records, NOW, { limits: LIMITS })).toEqual(['a1']);
  });
});

describe('checkOpen', () => {
  it('rejects past maxTabs with tab_limit_reached, for agents and humans alike', () => {
    expect(checkOpen(4, 'agent', [], NOW, LIMITS)).toEqual({ ok: false, error: 'tab_limit_reached' });
    expect(checkOpen(4, 'user', [], NOW, LIMITS)).toEqual({ ok: false, error: 'tab_limit_reached' });
    expect(checkOpen(3, 'agent', [], NOW, LIMITS)).toEqual({ ok: true });
  });

  it('rate-limits agent opens within the window but never human ones', () => {
    const burst = Array.from({ length: LIMITS.agentOpenBurst }, (_, i) => NOW - i);
    expect(checkOpen(0, 'agent', burst, NOW, LIMITS)).toEqual({ ok: false, error: 'rate_limited' });
    expect(checkOpen(0, 'user', burst, NOW, LIMITS)).toEqual({ ok: true });
    const expired = burst.map((t) => t - LIMITS.agentOpenWindowMs);
    expect(checkOpen(0, 'agent', expired, NOW, LIMITS)).toEqual({ ok: true });
  });
});
