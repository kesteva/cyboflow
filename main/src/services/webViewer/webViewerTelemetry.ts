/**
 * webViewerTelemetry — per-tab ring buffers of what a page did, for agents to
 * read later (the observe tools read these; nothing here is agent-facing yet).
 *
 * WHY NOT CDP. An always-on debugger session is detachable by one keystroke
 * (the app menu's `toggleDevTools` role acts on the FOCUSED webContents, and
 * opening DevTools detaches `webContents.debugger` for good), and `pnpm dev`
 * already has an external CDP client on :9223. So the always-on signals come
 * from non-detachable surfaces: `console-message` (WebContents-wide, subframes
 * included, with frame attribution), the navigation events, `did-fail-load`,
 * `render-process-gone`, and the partition's `webRequest` observers. The
 * debugger is reserved for on-demand snapshot / evaluate / screenshot / input.
 *
 * REDACTION IS THE WRITER'S JOB. `append*` are the only way into a buffer and
 * they take already-typed fields, never raw headers — `Cookie`, `Set-Cookie` and
 * `Authorization` cannot land here because no code path hands them over. URLs
 * go through `redactUrl`: userinfo and fragment dropped, query VALUES replaced
 * (keys kept, so `?token=` is still visibly a token parameter).
 *
 * CURSORS. Every ring numbers its entries with its own monotonic `seq`. A
 * reader passes the last seq it saw for that kind and gets everything after it,
 * plus an exact `gap` count when entries it never saw were already evicted — a
 * truncated read never masquerades as a complete one.
 *
 * ATTRIBUTION IS NULLABLE. `webRequest` details carry only an OPTIONAL
 * `webContentsId` / `frame`: service-worker requests and requests whose frame
 * already navigated land in an `unattributed` ring per partition rather than
 * being misfiled against the wrong document. A completion with no recorded
 * start reports its timestamp and no fabricated duration.
 *
 * See docs/proposals/native-web-viewer.md §3.2–3.3.
 */

export const TELEMETRY_LIMITS = {
  console: 500,
  network: 500,
  navigation: 100,
  /** Console text and failure strings are truncated to this many chars. */
  maxText: 2000,
  maxUrl: 2048,
  /** In-flight request starts kept per partition before the oldest is dropped. */
  maxPendingRequests: 2000,
} as const;

export type TelemetryKind = 'console' | 'network' | 'navigation';

interface FrameRef {
  /** Redacted frame URL. */
  frameUrl: string | null;
  frameOrigin: string | null;
}

export interface ConsoleEntry extends FrameRef {
  seq: number;
  at: number;
  level: 'debug' | 'info' | 'warning' | 'error';
  message: string;
  source: string | null;
  line: number | null;
}

export interface NetworkEntry extends FrameRef {
  seq: number;
  at: number;
  method: string;
  url: string;
  resourceType: string;
  status: number | null;
  fromCache: boolean;
  /** Null when no start was observed (cache hit, or a start before attach). */
  durationMs: number | null;
  error: string | null;
}

export interface NavigationEntry {
  seq: number;
  at: number;
  kind: 'start' | 'commit' | 'in_page' | 'fail' | 'crash';
  url: string | null;
  detail: string | null;
}

export type TelemetryEntry = ConsoleEntry | NetworkEntry | NavigationEntry;

export interface TelemetryRead<T> {
  entries: T[];
  /** The seq to pass next time. */
  cursor: number;
  /** Entries after `since` that were evicted before this read. 0 = complete. */
  gap: number;
}

/**
 * Redact a URL for storage: drop userinfo and fragment, replace query values.
 * Returns null for anything that does not parse (never the raw string).
 */
export function redactUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  if (url.search.length > 0) {
    const keys = [...url.searchParams.keys()];
    const redacted = new URLSearchParams();
    for (const key of keys) redacted.append(key, '…');
    url.search = redacted.toString();
  }
  const out = url.href;
  return out.length > TELEMETRY_LIMITS.maxUrl ? out.slice(0, TELEMETRY_LIMITS.maxUrl) : out;
}

function originOf(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const origin = new URL(raw).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

function clip(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  return text.length > TELEMETRY_LIMITS.maxText ? `${text.slice(0, TELEMETRY_LIMITS.maxText)}…` : text;
}

/** A bounded ring with its own contiguous seq, so a gap count is exact. */
class Ring<T extends { seq: number }> {
  private readonly items: T[] = [];
  private seq = 0;
  /** Highest seq evicted so far. Seqs are contiguous, so (since, this] were lost. */
  private evictedThrough = 0;
  constructor(private readonly cap: number) {}

  push(entry: Omit<T, 'seq'>): void {
    this.items.push({ ...entry, seq: ++this.seq } as T);
    if (this.items.length > this.cap) {
      const dropped = this.items.shift();
      if (dropped) this.evictedThrough = dropped.seq;
    }
  }

  read(since: number): TelemetryRead<T> {
    return {
      entries: this.items.filter((e) => e.seq > since),
      cursor: this.seq,
      gap: this.evictedThrough > since ? this.evictedThrough - since : 0,
    };
  }
}

interface TabBuffers {
  console: Ring<ConsoleEntry>;
  network: Ring<NetworkEntry>;
  navigation: Ring<NavigationEntry>;
}

export interface FrameLike {
  url?: string;
  origin?: string;
}

export class WebViewerTelemetry {
  private readonly tabs = new Map<string, TabBuffers>();
  /** webContents.id → tabId, for webRequest attribution. */
  private readonly byWebContents = new Map<number, string>();
  /** Requests with no attributable tab, per partition. */
  private readonly unattributed = new Map<string, Ring<NetworkEntry>>();
  /** request id → start timestamp, per partition. */
  private readonly starts = new Map<string, Map<number, number>>();

  constructor(private readonly now: () => number = Date.now) {}

  // ---------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------

  /** Bind a live webContents to a tab. Re-binding (a fresh view) keeps the rings. */
  attach(tabId: string, webContentsId: number): void {
    this.ensure(tabId);
    this.byWebContents.set(webContentsId, tabId);
  }

  /** The view went away (eviction, crash recovery). Rings survive; attribution does not. */
  detach(webContentsId: number): void {
    this.byWebContents.delete(webContentsId);
  }

  /** The TAB went away (close, teardown). Everything goes. */
  forget(tabId: string): void {
    this.tabs.delete(tabId);
    for (const [wcId, t] of this.byWebContents) if (t === tabId) this.byWebContents.delete(wcId);
  }

  tabFor(webContentsId: number | undefined): string | null {
    return webContentsId === undefined ? null : (this.byWebContents.get(webContentsId) ?? null);
  }

  // ---------------------------------------------------------------------
  // Writers — the ONLY way into a ring. Typed fields in, redacted fields stored.
  // ---------------------------------------------------------------------

  appendConsole(
    tabId: string,
    msg: { level: ConsoleEntry['level']; message: string; sourceId?: string; lineNumber?: number; frame?: FrameLike | null },
  ): void {
    const tab = this.ensure(tabId);
    tab.console.push({
      at: this.now(),
      level: msg.level,
      message: clip(msg.message) ?? '',
      source: redactUrl(msg.sourceId),
      line: typeof msg.lineNumber === 'number' ? msg.lineNumber : null,
      ...this.frameRef(msg.frame),
    });
  }

  appendNavigation(tabId: string, kind: NavigationEntry['kind'], url: string | null, detail?: string | null): void {
    const tab = this.ensure(tabId);
    tab.navigation.push({
      at: this.now(),
      kind,
      url: redactUrl(url),
      detail: clip(detail ?? null),
    });
  }

  /** `webRequest.onBeforeRequest` — the start half of the request-id correlation. */
  requestStarted(partition: string, req: { id: number; timestamp: number }): void {
    let map = this.starts.get(partition);
    if (!map) {
      map = new Map();
      this.starts.set(partition, map);
    }
    map.set(req.id, req.timestamp);
    if (map.size > TELEMETRY_LIMITS.maxPendingRequests) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }

  /** `webRequest.onCompleted` / `onErrorOccurred` — the terminal half. */
  requestFinished(
    partition: string,
    req: {
      id: number;
      url: string;
      method: string;
      resourceType: string;
      timestamp: number;
      webContentsId?: number;
      frame?: FrameLike | null;
      statusCode?: number;
      fromCache: boolean;
      error?: string;
    },
  ): void {
    const started = this.starts.get(partition)?.get(req.id);
    this.starts.get(partition)?.delete(req.id);
    const tabId = this.tabFor(req.webContentsId);
    const base = {
      at: req.timestamp,
      method: req.method,
      url: redactUrl(req.url) ?? '(unparseable)',
      resourceType: req.resourceType,
      status: typeof req.statusCode === 'number' && req.statusCode > 0 ? req.statusCode : null,
      fromCache: req.fromCache,
      durationMs: started === undefined ? null : Math.max(0, Math.round(req.timestamp - started)),
      error: req.error && req.error.length > 0 ? clip(req.error) : null,
      ...this.frameRef(req.frame),
    };
    if (tabId !== null) {
      this.ensure(tabId).network.push(base);
      return;
    }
    let ring = this.unattributed.get(partition);
    if (!ring) {
      ring = new Ring<NetworkEntry>(TELEMETRY_LIMITS.network);
      this.unattributed.set(partition, ring);
    }
    ring.push(base);
  }

  // ---------------------------------------------------------------------
  // Readers
  // ---------------------------------------------------------------------

  read(tabId: string, kind: 'console', since?: number): TelemetryRead<ConsoleEntry> | null;
  read(tabId: string, kind: 'network', since?: number): TelemetryRead<NetworkEntry> | null;
  read(tabId: string, kind: 'navigation', since?: number): TelemetryRead<NavigationEntry> | null;
  read(tabId: string, kind: TelemetryKind, since = 0): TelemetryRead<TelemetryEntry> | null {
    const tab = this.tabs.get(tabId);
    if (!tab) return null;
    return tab[kind].read(since) as TelemetryRead<TelemetryEntry>;
  }

  readUnattributed(partition: string, since = 0): TelemetryRead<NetworkEntry> {
    const ring = this.unattributed.get(partition);
    return ring ? ring.read(since) : { entries: [], cursor: 0, gap: 0 };
  }

  // ---------------------------------------------------------------------

  private ensure(tabId: string): TabBuffers {
    let tab = this.tabs.get(tabId);
    if (!tab) {
      tab = {
        console: new Ring(TELEMETRY_LIMITS.console),
        network: new Ring(TELEMETRY_LIMITS.network),
        navigation: new Ring(TELEMETRY_LIMITS.navigation),
      };
      this.tabs.set(tabId, tab);
    }
    return tab;
  }

  private frameRef(frame: FrameLike | null | undefined): FrameRef {
    // Reading a destroyed WebFrameMain's properties throws; treat as unknown.
    try {
      const url = frame?.url ?? null;
      return { frameUrl: redactUrl(url), frameOrigin: originOf(url) };
    } catch {
      return { frameUrl: null, frameOrigin: null };
    }
  }
}
