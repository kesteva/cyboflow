/**
 * webViewerCaps — the hard caps on web-viewer tabs, as pure policy.
 *
 * Kept free of Electron so the eviction order, the pin rules and the rate limit
 * are unit-testable without a window. The manager feeds it plain records and
 * applies the verdict (destroying views, rejecting opens).
 *
 * The rules (docs/proposals/native-web-viewer.md §3.4):
 *   - SUSPENSION ≠ UNLOADING. A background tab is detached from the window, not
 *     navigated anywhere: its document, JS context and telemetry stay alive, and
 *     its committed URL never changes.
 *   - An AGENT PIN (agent-opened, or read by an agent within `pinTtlMs`) makes a
 *     tab the LAST choice for voluntary unloading — never an exemption from the
 *     caps. Pins compete within the loaded cap, least-recently-read first, so an
 *     agent opening tabs in a loop cannot hold unbounded renderers alive.
 *   - Beyond a loaded cap the loser is DESTROYED (a URL row, re-navigated on
 *     demand) and the eviction is reported, never silent.
 *   - Past `maxTabs`, or past the agent-open rate, an open is REJECTED — it never
 *     creates an unloaded row a later read would resurrect.
 */
import { WEB_VIEWER_LIMITS } from './webViewerGuard';

export interface CapRecord {
  tabId: string;
  sessionId: string;
  openedBy: 'user' | 'agent';
  /** A live view exists (a renderer process is held). */
  loaded: boolean;
  /** Currently painted in the window. Never evicted. */
  visible: boolean;
  lastActiveAt: number;
  /** Last agent telemetry read, or null when no agent has read it. */
  lastAgentReadAt: number | null;
}

export interface CapLimits {
  maxLoadedViews: number;
  maxTabs: number;
  maxLoadedViewsGlobal: number;
  pinTtlMs: number;
  agentOpenBurst: number;
  agentOpenWindowMs: number;
}

export const DEFAULT_CAP_LIMITS: CapLimits = {
  maxLoadedViews: WEB_VIEWER_LIMITS.maxLoadedViews,
  maxTabs: WEB_VIEWER_LIMITS.maxTabs,
  maxLoadedViewsGlobal: WEB_VIEWER_LIMITS.maxLoadedViewsGlobal,
  pinTtlMs: WEB_VIEWER_LIMITS.pinTtlMs,
  agentOpenBurst: WEB_VIEWER_LIMITS.agentOpenBurst,
  agentOpenWindowMs: WEB_VIEWER_LIMITS.agentOpenWindowMs,
};

export function isPinned(record: CapRecord, now: number, limits: CapLimits = DEFAULT_CAP_LIMITS): boolean {
  if (record.openedBy === 'agent') return true;
  return record.lastAgentReadAt !== null && now - record.lastAgentReadAt < limits.pinTtlMs;
}

/**
 * Eviction order among candidates: unpinned before pinned; unpinned by
 * least-recently-active, pinned by least-recently-READ (an agent-opened tab
 * nobody has read yet ranks by when it was opened).
 */
function evictionRank(record: CapRecord, now: number, limits: CapLimits): [number, number] {
  if (!isPinned(record, now, limits)) return [0, record.lastActiveAt];
  return [1, record.lastAgentReadAt ?? record.lastActiveAt];
}

function byEvictionOrder(now: number, limits: CapLimits) {
  return (a: CapRecord, b: CapRecord): number => {
    const [ga, ta] = evictionRank(a, now, limits);
    const [gb, tb] = evictionRank(b, now, limits);
    return ga - gb || ta - tb;
  };
}

/**
 * Which loaded tabs to destroy so every session is within `maxLoadedViews` and
 * the whole app within `maxLoadedViewsGlobal`. `protectTabId` (the tab that just
 * loaded) and every visible tab are never chosen.
 */
export function selectEvictions(
  records: readonly CapRecord[],
  now: number,
  options: { protectTabId?: string; limits?: CapLimits } = {},
): string[] {
  const limits = options.limits ?? DEFAULT_CAP_LIMITS;
  const order = byEvictionOrder(now, limits);
  const evicted = new Set<string>();
  const evictable = (r: CapRecord): boolean =>
    r.loaded && !r.visible && r.tabId !== options.protectTabId && !evicted.has(r.tabId);

  const bySession = new Map<string, CapRecord[]>();
  for (const r of records) {
    if (!r.loaded) continue;
    const list = bySession.get(r.sessionId) ?? [];
    list.push(r);
    bySession.set(r.sessionId, list);
  }
  for (const list of bySession.values()) {
    let excess = list.length - limits.maxLoadedViews;
    for (const r of list.filter(evictable).sort(order)) {
      if (excess <= 0) break;
      evicted.add(r.tabId);
      excess -= 1;
    }
  }

  let globalExcess = records.filter((r) => r.loaded).length - evicted.size - limits.maxLoadedViewsGlobal;
  for (const r of records.filter(evictable).sort(order)) {
    if (globalExcess <= 0) break;
    evicted.add(r.tabId);
    globalExcess -= 1;
  }
  return [...evicted];
}

export type OpenVerdict = { ok: true } | { ok: false; error: 'tab_limit_reached' | 'rate_limited' };

/**
 * May a session open another tab? `recentAgentOpens` are the timestamps of this
 * session's agent opens (the caller prunes nothing — this reads the window).
 */
export function checkOpen(
  sessionTabCount: number,
  openedBy: 'user' | 'agent',
  recentAgentOpens: readonly number[],
  now: number,
  limits: CapLimits = DEFAULT_CAP_LIMITS,
): OpenVerdict {
  if (sessionTabCount >= limits.maxTabs) return { ok: false, error: 'tab_limit_reached' };
  if (openedBy === 'agent') {
    const inWindow = recentAgentOpens.filter((t) => now - t < limits.agentOpenWindowMs).length;
    if (inWindow >= limits.agentOpenBurst) return { ok: false, error: 'rate_limited' };
  }
  return { ok: true };
}
