/**
 * Native web viewer — shared wire + config types.
 *
 * This module is compiled into BOTH the Electron main process and the Vite
 * renderer, so it must stay Electron-free: no `electron` import, no Node
 * built-ins, pure types plus a runtime guard. See
 * docs/proposals/native-web-viewer.md.
 */
import type { WebTabOpener } from './centerPane';
import type { ReservedChordAction } from './reservedChords';

/**
 * Stored shape of the `webViewer` config block. Every member is optional and
 * floors on READ (see ConfigManager.getWebViewerConfig), so config.json stays
 * byte-identical for users who never touch the feature — the same contract as
 * `visualVerify` and `idleSessionReview`.
 *
 * The split between `enabled` and the three agent members is deliberate:
 * HUMAN browsing ships ON (it is the feature), every AGENT capability ships
 * OFF. `enabled: false` is the master kill switch and disables the agent
 * capabilities too, regardless of their own values.
 */
export interface WebViewerConfig {
  /** Master switch for the whole viewer. Absent → floors to `true`. */
  enabled?: boolean;
  /** Let agents read telemetry / DOM / text / screenshots. Absent → `false`. */
  agentObserve?: boolean;
  /** Let agents drive a tab (navigate / click / type / eval). Absent → `false`. */
  agentDrive?: boolean;
  /**
   * Keep the human partition persistent (`persist:cyboflow-web-viewer`), so
   * logins survive a restart. Absent → `true`. Agent-opened tabs always use a
   * per-session ephemeral partition and are unaffected by this.
   */
  persistLogin?: boolean;
}

/** Fully-resolved web-viewer config (every member present). */
export interface ResolvedWebViewerConfig {
  enabled: boolean;
  agentObserve: boolean;
  agentDrive: boolean;
  persistLogin: boolean;
}

/**
 * Floor values applied on read for any omitted member. Human browsing on,
 * every agent capability off.
 */
export const WEB_VIEWER_DEFAULTS: ResolvedWebViewerConfig = {
  enabled: true,
  agentObserve: false,
  agentDrive: false,
  persistLogin: true,
};

/**
 * The complete set of storable keys. The config boundary iterates THIS, never
 * the caller's own object keys, so an unknown property can never reach
 * config.json.
 */
export const WEB_VIEWER_CONFIG_KEYS = [
  'enabled',
  'agentObserve',
  'agentDrive',
  'persistLogin',
] as const satisfies readonly (keyof WebViewerConfig)[];

export type WebViewerConfigKey = (typeof WEB_VIEWER_CONFIG_KEYS)[number];

/**
 * Strict per-member guard for the config boundary. Booleans ONLY — the config
 * tRPC input accepts any plain object, so a string `"false"` would otherwise
 * pass validation and then read as truthy everywhere downstream.
 */
export function isWebViewerConfigValue(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

// ===========================================================================
// Wire shapes (main ↔ renderer). Also Electron-free — these cross the tRPC
// boundary and are read by the Vite renderer.
// ===========================================================================


/**
 * A tab's lifecycle state, reported verbatim to the renderer AND to agents.
 *
 * Every state here is one an agent could otherwise mistake for a blank page:
 * `hidden` (loaded but not painting), `evicted` (destroyed to stay under the
 * cap; a read re-navigates), `crashed` (the renderer died — every capture,
 * navigate and evaluate call would fail inconsistently), and the two fail-closed
 * blocks, `auth_required` (HTTP Basic) and `certificate_error`.
 */
export type WebTabState =
  | 'live'
  | 'hidden'
  | 'evicted'
  | 'crashed'
  | 'auth_required'
  | 'certificate_error';

/** Rect for the native view, in renderer CSS pixels (main scales by zoom). */
export interface WebTabBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The renderer's view of one tab. Carries the FULL `currentUrl`: this is the
 * human's own UI, which is exactly the surface the agent-facing redaction
 * (webViewerGuard.redactToOrigin) exists to keep URLs away from.
 */
export interface WebTabSnapshot {
  tabId: string;
  sessionId: string;
  state: WebTabState;
  currentUrl: string | null;
  title: string | null;
  openedBy: WebTabOpener;
  openedByRunId: string | null;
  humanTouched: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  /** Set when `state` is `'certificate_error'` / `'auth_required'`. */
  blockedReason: string | null;
}

/** Push payload for the `onTabState` subscription. */
/**
 * A persisted tab re-created (unloaded) by `webViewer.restore`, in strip order.
 * Carries what the renderer's `openWebTab` needs to rebuild the entry under the
 * SAME id — re-minting would orphan grants, cursors and the persisted row.
 */
export interface RestoredWebTab {
  tabId: string;
  initialUrl: string;
  currentUrl: string | null;
  title: string | null;
  openedBy: WebTabOpener;
  openedByRunId: string | null;
  humanTouched: boolean;
  position: number;
}

export interface WebTabStateEvent {
  sessionId: string;
  snapshot: WebTabSnapshot;
}

/** Push payload for the `onTabClosed` subscription (crash recovery, eviction). */
export interface WebTabClosedEvent {
  sessionId: string;
  tabId: string;
  /** Why it went away, so the strip can distinguish an evict from a close. */
  reason: 'closed' | 'evicted' | 'crashed' | 'disposed';
}

/**
 * Push payload for the `onReservedChord` subscription: a chord the app owns that
 * was pressed while a native view had focus, resolved in main and reported as a
 * SEMANTIC ACTION. Never a synthetic key event — replaying one into the renderer
 * would be indistinguishable from a real keystroke to every other listener and
 * would fire twice if the view ever stopped swallowing it.
 */
export interface WebViewerChordEvent {
  sessionId: string;
  tabId: string;
  action: ReservedChordAction;
}

/**
 * Push payload for the `onPopupRequested` subscription. A viewer page asked to
 * open a window; the renderer mints a tab id and opens it as another viewer tab.
 * `openerTabId` is the tab that asked, so the new tab can inherit its session
 * and sit next to it.
 */
export interface WebViewerPopupEvent {
  sessionId: string;
  openerTabId: string;
  url: string;
}

// ---------------------------------------------------------------------------
// Consent (docs/proposals/native-web-viewer.md §7)
// ---------------------------------------------------------------------------

/** What an agent asks to do with a tab. `drive` implies `observe`. */
export type WebConsentCapability = 'observe' | 'drive';

/**
 * A pending consent prompt, rendered as a sheet ON THE TAB it concerns. Carries
 * the ORIGIN only — the full URL is exactly what the agent is not yet allowed
 * to see, and the human decides on "this site", not on a path.
 */
export interface WebConsentRequest {
  requestId: string;
  sessionId: string;
  tabId: string;
  runId: string;
  capability: WebConsentCapability;
  origin: string | null;
  /** The agent's stated reason, clipped. Shown as the agent's claim, not fact. */
  reason: string | null;
  requestedAt: number;
}

/** Push payload for `onConsent`: a prompt opened, or one was resolved elsewhere. */
export type WebConsentEvent =
  | { kind: 'requested'; sessionId: string; request: WebConsentRequest }
  | { kind: 'resolved'; sessionId: string; requestId: string; tabId: string };

/** An active grant, as listed in the tab's Agent access view. */
export interface WebConsentGrant {
  grantId: string;
  sessionId: string;
  tabId: string;
  runId: string;
  capability: WebConsentCapability;
  origin: string | null;
  grantedAt: number;
}

/** One audit row, as shown in the tab's activity list. Origin only, never a URL. */
export interface WebActivityEntry {
  id: string;
  tabId: string | null;
  runId: string | null;
  kind: string;
  origin: string | null;
  detail: string | null;
  createdAt: string;
}
