/**
 * Narrow structural contracts for the web viewer's main-process services
 * (docs/proposals/native-web-viewer.md §3.5).
 *
 * WHY THESE EXIST, and why they are plain interfaces rather than imports:
 * `main/eslint.config.js` applies `no-restricted-imports` at ERROR level across
 * `src/orchestrator/**`, banning both `electron` and `**\/services/**`, and
 * `orchestrator/__tests__/standaloneInvariant.test.ts` backstops it (catching
 * dynamic `require` / `await import` too). That covers the tRPC router, the MCP
 * query handler and the MCP tool-handler module — none of which may value-import
 * the viewer manager, the driver, or `electron`. They get these seams instead,
 * wired concretely from `main/src/webViewerComposition.ts`.
 *
 * Consequence worth stating: `Electron.Debugger`, `WebContentsView` and
 * `WebFrameMain` must never appear in a signature here. A capture crosses the
 * seam as a path, an evaluation as a plain `{ ok, value }`, a frame as an opaque
 * token string.
 */
import type {
  RestoredWebTab,
  WebTabBounds,
  WebTabSnapshot,
} from '../../../../../shared/types/webViewer';

/** Open args. `tabId` is minted by the CALLER — see `makeWebTabId`. */
export interface WebViewerOpenArgs {
  sessionId: string;
  tabId: string;
  url: string;
  openedBy: 'user' | 'agent';
  /** The opening run, for an agent open. The owner that gates free observation. */
  openedByRunId?: string;
  /** Restore path: the tab exists as a row but is not loaded yet. */
  deferLoad?: boolean;
  /**
   * Restore path: the persisted row's fields. A restore is not a new open — it
   * skips the agent-open rate limit and carries `humanTouched` back, so a tab a
   * human typed into before a restart stays consent-gated after it.
   */
  restore?: { initialUrl: string; title: string | null; humanTouched: boolean };
}

export type WebViewerOpenResult =
  | { ok: true; snapshot: WebTabSnapshot }
  | { ok: false; error: string };

export type WebViewerAck = { ok: true } | { ok: false; error: string };

/**
 * View lifecycle + chrome. The renderer drives every member; agents reach the
 * same surface through the MCP handlers, under the consent rules.
 */
export interface WebViewerCoreLike {
  open(args: WebViewerOpenArgs): Promise<WebViewerOpenResult>;
  navigate(tabId: string, url: string): Promise<WebViewerAck>;
  back(tabId: string): Promise<WebViewerAck>;
  forward(tabId: string): Promise<WebViewerAck>;
  reload(tabId: string): Promise<WebViewerAck>;
  close(tabId: string): Promise<WebViewerAck>;
  /**
   * Bounds in RENDERER CSS PIXELS. The manager multiplies by the window's
   * `getZoomFactor()` and rounds, because `setBounds` is DIP-relative while
   * `getBoundingClientRect` is CSS px — scaling in the renderer would be wrong
   * at any zoom other than 1, and `devicePixelRatio` is the wrong number to
   * derive it from (it is zoomFactor × display scaleFactor).
   */
  setBounds(tabId: string, bounds: WebTabBounds): Promise<WebViewerAck>;
  /** Show/hide without unloading — see the suspension contract. */
  setVisible(tabId: string, visible: boolean): Promise<WebViewerAck>;
  list(sessionId: string): Promise<WebTabSnapshot[]>;
  /** One tab's current snapshot, or null when it is not a known tab. */
  get(tabId: string): Promise<WebTabSnapshot | null>;
}

/**
 * The full surface the router sees: the manager's lifecycle plus persistence.
 * `restore` re-creates a session's persisted tabs UNLOADED, reusing their ids,
 * and returns what the renderer needs to rebuild its strip.
 */
export interface WebViewerLike extends WebViewerCoreLike {
  restore(sessionId: string): Promise<RestoredWebTab[]>;
}

/** Whether the viewer is available at all, and what agents may do (config §7). */
export interface WebViewerCapabilityLike {
  enabled(): boolean;
  agentObserveEnabled(): boolean;
  agentDriveEnabled(): boolean;
}

/**
 * The manager's event channels, as a seam. The router bridges these into tRPC
 * subscriptions via `eventToAsyncIterable`; it must not import the manager (or
 * `electron`) to get at them, so the emitter and its channel names arrive here
 * instead, wired from `webViewerComposition.ts`.
 *
 * `EventEmitter` is a Node built-in, not a service — `routers/events.ts` already
 * imports it, so this does not touch the standalone invariant.
 */
export interface WebViewerEventsLike {
  emitter: import('events').EventEmitter;
  tabStateChannel: string;
  tabClosedChannel: string;
  chordChannel: string;
  /**
   * A popup (`window.open` / `target=_blank`) a viewer page asked for. Never a
   * real popup window — the renderer turns it into another viewer tab, so it owns
   * the tab id and the store entry.
   */
  popupChannel: string;
}
