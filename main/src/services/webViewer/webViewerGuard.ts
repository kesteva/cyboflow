/**
 * webViewerGuard — the web viewer's navigation, scheme and URL-redaction policy.
 *
 * Pure and Electron-free so it is unit-testable without a window (precedent:
 * main/src/ipc/artifactFrameGuard.ts). Every rule here is a security boundary,
 * not a convenience: the viewer renders arbitrary remote pages and hands
 * observations to agents, so the answers to "may this navigate?" and "how much
 * of this URL may an agent see?" must be decidable in one place and provable in
 * a test.
 *
 * See docs/proposals/native-web-viewer.md.
 */

// Re-exported so call sites that already import the guard need not reach for a
// second module for the state union.
export type { WebTabState } from '../../../../shared/types/webViewer';

/**
 * Is this a URL the viewer may load at all? http and https ONLY.
 *
 * Deliberately narrower than `isSafeExternalOpenTarget` (which allows
 * `mailto:`): that governs handing a URL to the OS launcher, this governs
 * loading a document INSIDE the app. `file:` would give a remote-looking tab
 * read access to the local disk through the same-origin policy; `data:` and
 * `blob:` would let an agent-composed document run in the viewer's partition;
 * `javascript:` is script injection by definition.
 */
export function isViewableUrl(url: string): boolean {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return false;
  }
  return protocol === 'http:' || protocol === 'https:';
}

/**
 * Resolve a possibly-relative href against a base, then scheme-check it.
 *
 * The chat-link path cannot assume it has an absolute http(s) URL: markdown can
 * carry `./docs/x.md`, `#anchor`, `mailto:`, or a bare `example.com`. Returns
 * the normalized absolute URL, or null — and the caller falls back to the
 * existing OS-browser path rather than opening a tab.
 */
export function resolveViewableUrl(href: string, base?: string): string | null {
  const trimmed = href.trim();
  if (trimmed.length === 0) return null;
  let resolved: URL;
  try {
    resolved = base === undefined ? new URL(trimmed) : new URL(trimmed, base);
  } catch {
    return null;
  }
  if (!isViewableUrl(resolved.href)) return null;
  return resolved.href;
}

/**
 * Whether a navigation a LOADED viewer tab attempts should be blocked.
 *
 * Applies to `will-navigate` on the viewer's own `webContents`, so it governs
 * the page moving itself (a link click, a redirect, `location.href` from an
 * agent's `eval`). Anything not http(s) is blocked — including `about:` here,
 * unlike the artifact-frame guard: `about:blank` in a viewer tab is
 * indistinguishable from a suspended tab to an observing agent, and letting a
 * page navigate itself there would blank exactly the state requirement (2)
 * exists to report.
 */
export function shouldBlockViewerNavigation(targetUrl: string): boolean {
  return !isViewableUrl(targetUrl);
}

/**
 * The origin of a URL — scheme, host and port, nothing else — or null when it
 * does not parse.
 *
 * This is what an agent sees BEFORE a consent grant, and the `session_web_events`
 * audit column. Full URLs routinely carry OAuth authorization codes,
 * password-reset tokens, signed download parameters, document ids and search
 * queries, so a free tool that returned them would let an agent enumerate
 * secrets in addresses it is not allowed to read the pages of. Userinfo
 * (`https://user:pw@host/`) is dropped along with path, query and fragment —
 * `URL.origin` already excludes it, but it is called out because a hand-rolled
 * `scheme + '//' + host` would not.
 */
export function redactToOrigin(url: string | null | undefined): string | null {
  if (url === null || url === undefined || url.length === 0) return null;
  try {
    const parsed = new URL(url);
    // `origin` is the string "null" for an opaque origin; report that as absent
    // rather than leaking the literal.
    return parsed.origin === 'null' ? null : parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Do two URLs share an origin, for the consent recheck? EXACT scheme + host +
 * port equality, never a prefix compare — `https://evil.com/?x=github.com` and
 * `https://github.com.evil.com/` both defeat prefix matching.
 *
 * A URL that does not parse never matches anything, including another
 * unparseable one: failing closed is the only safe answer for a grant check.
 */
export function sameOrigin(a: string | null | undefined, b: string | null | undefined): boolean {
  const originA = redactToOrigin(a);
  const originB = redactToOrigin(b);
  if (originA === null || originB === null) return false;
  return originA === originB;
}

/**
 * How a popup (`window.open`, `target=_blank`) from a viewer page is handled.
 *
 * Never a real popup window: a `BrowserWindow` opened by a remote page would
 * carry the viewer's partition with none of its guards, chrome or occlusion
 * handling. http(s) becomes a new viewer tab; anything else is dropped. Note
 * this does NOT fall through to `shell.openExternal` — a remote page silently
 * launching the user's browser is a navigation the user never asked for.
 */
export type PopupDisposition = 'new-tab' | 'deny';

export function popupDisposition(url: string): PopupDisposition {
  return isViewableUrl(url) ? 'new-tab' : 'deny';
}

/** Hard resource caps, per cyboflow session. See §3.4 of the proposal. */
export const WEB_VIEWER_LIMITS = {
  /**
   * Live `WebContentsView`s per session. A loaded view holds a renderer
   * process, timers and network activity, so this is the cost ceiling; beyond
   * it the least-recently-used tab is DESTROYED and becomes a URL row that
   * re-navigates on demand.
   */
  maxLoadedViews: 6,
  /**
   * Tab ROWS per session. Past this an open is rejected outright with
   * `tab_limit_reached` rather than silently creating a row a later read would
   * resurrect.
   */
  maxTabs: 24,
  /**
   * Loaded views across ALL sessions. Without a global ceiling, N sessions
   * multiply the per-session cap.
   */
  maxLoadedViewsGlobal: 12,
  /**
   * How long an agent read keeps a tab pinned against voluntary unloading,
   * refreshed on each read. A pin exempts a tab from eviction PREFERENCE, not
   * from the caps — pins compete within `maxLoadedViews`, least-recently-read
   * evicted first, so an agent opening tabs in a loop cannot hold unbounded
   * renderers alive without ever asking a human.
   */
  pinTtlMs: 10 * 60 * 1000,
} as const;
