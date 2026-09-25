/**
 * webViewerManager — the main-process owner of every web-viewer tab.
 *
 * Holds one `WebContentsView` per loaded tab, attaches it to the main window's
 * `contentView`, positions it over the renderer's bounds anchor, and reports
 * lifecycle back to the renderer. The page is NEVER an iframe: every target the
 * viewer exists for refuses framing (measured 2026-09-23 — claude.ai and
 * docs.anthropic.com send `x-frame-options: SAMEORIGIN`, github.com sends
 * `deny`), and the packaged renderer CSP's `frame-src` would break an iframe
 * viewer in shipped builds only.
 *
 * Suspension is detach-not-unload: a background tab keeps its document, JS
 * context and committed URL. The hard caps (loaded views per session and
 * globally, tab rows, agent-open rate) are pure policy in `webViewerCaps.ts`;
 * this module applies the verdict and reports every eviction.
 *
 * See docs/proposals/native-web-viewer.md §3.1–3.2, §3.4, §3.6.
 */
import { EventEmitter } from 'events';
import { WebContentsView, shell, type BrowserWindow, type WebContents } from 'electron';
import type {
  WebTabBounds,
  WebTabSnapshot,
  WebTabState,
} from '../../../../shared/types/webViewer';
import type { WebTabOpener } from '../../../../shared/types/centerPane';
import type { KeyboardShortcutOverrides } from '../../../../shared/types/keyboardShortcuts';
import {
  matchReservedChord,
  resolveReservedChords,
  type ReservedChord,
  type ReservedChordAction,
} from '../../../../shared/types/reservedChords';
import type {
  WebViewerAck,
  WebViewerCoreLike,
  WebViewerOpenArgs,
  WebViewerOpenResult,
} from '../../orchestrator/trpc/contracts/webViewerOps';
import {
  popupDisposition,
  redactToOrigin,
  resolveViewableUrl,
  shouldBlockViewerNavigation,
} from './webViewerGuard';
import { hardenPartition, partitionFor } from './webViewerPartitions';
import { DEFAULT_CAP_LIMITS, checkOpen, selectEvictions, type CapRecord } from './webViewerCaps';
import { WebViewerTelemetry } from './webViewerTelemetry';

/** Channel names on the manager's emitter, bridged by the tRPC subscriptions. */
export const WEB_VIEWER_TAB_STATE = 'web-viewer:tab-state';
export const WEB_VIEWER_TAB_CLOSED = 'web-viewer:tab-closed';
export const WEB_VIEWER_CHORD = 'web-viewer:chord';
export const WEB_VIEWER_HUMAN_TOUCH = 'web-viewer:human-touch';
export const WEB_VIEWER_POPUP = 'web-viewer:popup';
export const WEB_VIEWER_CONTEXT_MENU = 'web-viewer:context-menu';
/** A committed main-frame navigation: consent rebinds or drops grants on it. */
export const WEB_VIEWER_NAVIGATED = 'web-viewer:navigated';

export interface WebViewerNavigatedEvent {
  sessionId: string;
  tabId: string;
  epoch: number;
  /** Redacted top-frame origin after the navigation. */
  principal: string | null;
  /** Same-document change (pushState / hash). */
  inPage: boolean;
}

/** What the consent layer needs to know about a tab, resolved at the moment of use. */
export interface WebTabConsentView {
  sessionId: string;
  tabId: string;
  openedBy: WebTabOpener;
  openedByRunId: string | null;
  humanTouched: boolean;
  partitionHumanTouched: boolean;
  principal: string | null;
  epoch: number;
  state: WebTabState;
  loading: boolean;
}

/** Everything the manager needs from the rest of main, injected. */
export interface WebViewerManagerDeps {
  /**
   * The main window, as an ACCESSOR rather than a captured reference. macOS
   * re-creates the window on dock activate, so a captured one would leave this
   * map pointing at views parented to a destroyed window — orphaning live remote
   * `webContents` that keep loading, running timers and holding sockets.
   * Precedent: `setupEventListeners(services, getMainWindow)`.
   */
  getMainWindow: () => BrowserWindow | null;
  /** Resolved config (`ConfigManager.getWebViewerConfig`), read per call. */
  isEnabled: () => boolean;
  persistLogin: () => boolean;
  /** The user's shortcut remaps, for the reserved-chord matcher. */
  shortcutOverrides: () => KeyboardShortcutOverrides | undefined;
  /** True in development — gates the dev-only Cmd-Shift-T chord. */
  devMode: boolean;
  platform: 'mac' | 'other';
  /** Clock seam for the caps' LRU and rate window. Defaults to `Date.now`. */
  now?: () => number;
}

interface TabRecord {
  tabId: string;
  sessionId: string;
  view: WebContentsView | null;
  partition: string;
  initialUrl: string;
  currentUrl: string | null;
  title: string | null;
  openedBy: WebTabOpener;
  openedByRunId: string | null;
  humanTouched: boolean;
  state: WebTabState;
  blockedReason: string | null;
  loading: boolean;
  visible: boolean;
  /** Last bounds the renderer reported, replayed after a re-attach. */
  bounds: WebTabBounds | null;
  /**
   * Bumped on every committed navigation, including in-page. Consent grants bind
   * to it, so a navigation invalidates them without any origin comparison.
   */
  navigationEpoch: number;
  lastActiveAt: number;
  /** Last agent telemetry read — refreshes the agent pin (§3.4). */
  lastAgentReadAt: number | null;
}

export class WebViewerManager extends EventEmitter implements WebViewerCoreLike {
  private readonly tabs = new Map<string, TabRecord>();
  private readonly deps: WebViewerManagerDeps;
  /** The window these views are currently parented to, for reap-on-close. */
  private attachedWindow: BrowserWindow | null = null;
  /** Per-session timestamps of recent agent opens, for the rate limit. */
  private readonly agentOpens = new Map<string, number[]>();
  /**
   * Partitions any tab of which a human has touched. Latched: cookies outlive
   * the tab, so a credential typed into one agent tab is reachable from its
   * siblings in the same jar — consent treats the whole jar as touched.
   */
  private readonly touchedPartitions = new Set<string>();
  /** Partitions whose `webRequest` observers are installed (one set per session). */
  private readonly instrumented = new Set<string>();
  /**
   * Always-on, non-CDP telemetry (console, navigation, network). Read by the
   * observe tools; nothing here reaches an agent without the consent layer.
   */
  readonly telemetry: WebViewerTelemetry;

  constructor(deps: WebViewerManagerDeps) {
    super();
    this.deps = deps;
    this.telemetry = new WebViewerTelemetry(() => this.now());
  }

  // -------------------------------------------------------------------------
  // WebViewerCoreLike
  // -------------------------------------------------------------------------

  async open(args: WebViewerOpenArgs): Promise<WebViewerOpenResult> {
    if (!this.deps.isEnabled()) return { ok: false, error: 'viewer_disabled' };

    const existing = this.tabs.get(args.tabId);
    if (existing) return { ok: true, snapshot: this.snapshot(existing) };

    const url = resolveViewableUrl(args.url);
    if (url === null) return { ok: false, error: 'invalid_arguments: url must be http(s)' };

    const now = this.now();
    const restore = args.restore;
    const verdict = checkOpen(
      this.tabIdsForSession(args.sessionId).length,
      args.openedBy,
      // A restore re-creates a row that already existed; it is not agent churn.
      restore ? [] : (this.agentOpens.get(args.sessionId) ?? []),
      now,
    );
    if (!verdict.ok) return { ok: false, error: verdict.error };
    if (args.openedBy === 'agent' && !restore) this.recordAgentOpen(args.sessionId, now);

    const partition = partitionFor(args.openedBy, args.sessionId, this.deps.persistLogin());
    const record: TabRecord = {
      tabId: args.tabId,
      sessionId: args.sessionId,
      view: null,
      partition,
      initialUrl: (restore && resolveViewableUrl(restore.initialUrl)) || url,
      currentUrl: url,
      title: restore?.title ?? null,
      openedBy: args.openedBy,
      openedByRunId: args.openedByRunId ?? null,
      humanTouched: restore?.humanTouched === true,
      // A deferred tab is a URL row with no renderer — exactly what an evicted
      // tab is, so it reports the same state and a read re-navigates it.
      state: args.deferLoad === true ? 'evicted' : 'hidden',
      blockedReason: null,
      loading: false,
      visible: false,
      bounds: null,
      navigationEpoch: 0,
      lastActiveAt: now,
      lastAgentReadAt: null,
    };
    this.tabs.set(args.tabId, record);
    if (record.humanTouched) this.touchedPartitions.add(partition);

    if (args.deferLoad !== true) {
      const created = this.createView(record);
      if (!created) {
        this.tabs.delete(args.tabId);
        return { ok: false, error: 'no_window' };
      }
      record.loading = true;
      void created.webContents.loadURL(url).catch((err: unknown) => {
        record.loading = false;
        this.fail(record, 'did_fail_load', err);
      });
      this.enforceLoadedCaps(record.tabId);
    }

    this.publish(record);
    return { ok: true, snapshot: this.snapshot(record) };
  }

  async navigate(tabId: string, url: string): Promise<WebViewerAck> {
    const record = this.tabs.get(tabId);
    if (!record) return { ok: false, error: 'tab_not_found' };
    const resolved = resolveViewableUrl(url);
    if (resolved === null) return { ok: false, error: 'invalid_arguments: url must be http(s)' };
    const wc = this.ensureLoaded(record);
    if (!wc) return { ok: false, error: record.state === 'crashed' ? 'tab_crashed' : 'no_window' };
    record.loading = true;
    this.publish(record);
    try {
      await wc.loadURL(resolved);
      return { ok: true };
    } catch (err) {
      record.loading = false;
      this.fail(record, 'did_fail_load', err);
      return { ok: false, error: 'navigation_failed' };
    }
  }

  async back(tabId: string): Promise<WebViewerAck> {
    return this.history(tabId, 'back');
  }

  async forward(tabId: string): Promise<WebViewerAck> {
    return this.history(tabId, 'forward');
  }

  async reload(tabId: string): Promise<WebViewerAck> {
    const record = this.tabs.get(tabId);
    if (!record) return { ok: false, error: 'tab_not_found' };
    // A crashed tab is recovered with a FRESH view, never a reused one: the dead
    // webContents' frame tokens, telemetry cursor and grants are all stale.
    if (record.state === 'crashed') {
      this.destroyView(record);
      record.state = 'evicted';
    }
    const wc = this.ensureLoaded(record);
    if (!wc) return { ok: false, error: 'no_window' };
    wc.reload();
    record.loading = true;
    this.publish(record);
    return { ok: true };
  }

  async close(tabId: string): Promise<WebViewerAck> {
    const record = this.tabs.get(tabId);
    if (!record) return { ok: false, error: 'tab_not_found' };
    this.destroyView(record);
    this.tabs.delete(tabId);
    this.telemetry.forget(tabId);
    this.emit(WEB_VIEWER_TAB_CLOSED, {
      sessionId: record.sessionId,
      tabId,
      reason: 'closed' as const,
    });
    return { ok: true };
  }

  async setBounds(tabId: string, bounds: WebTabBounds): Promise<WebViewerAck> {
    const record = this.tabs.get(tabId);
    if (!record) return { ok: false, error: 'tab_not_found' };
    record.bounds = bounds;
    this.applyBounds(record);
    return { ok: true };
  }

  async setVisible(tabId: string, visible: boolean): Promise<WebViewerAck> {
    const record = this.tabs.get(tabId);
    if (!record) return { ok: false, error: 'tab_not_found' };
    record.visible = visible;

    if (visible) {
      const wc = this.ensureLoaded(record);
      if (!wc) return { ok: false, error: 'no_window' };
      record.lastActiveAt = this.now();
    }

    const view: WebContentsView | null = record.view;
    if (view) {
      const window = this.requireWindow();
      if (window) {
        // Attach/detach rather than only toggling `setVisible`: a webContents
        // merely "displayed in" the window still forces frames to be drawn and
        // swapped for the whole window, which is the paint burn this avoids.
        if (visible) {
          window.contentView.addChildView(view);
          this.applyBounds(record);
        } else {
          // Hand keyboard focus back to the app before detaching: an overlay
          // opening over a focused page (the occlusion path) would otherwise
          // get no keystrokes — Escape included — until the user clicks it.
          if (view.webContents.isFocused()) window.webContents.focus();
          window.contentView.removeChildView(view);
        }
      }
      view.setVisible(visible);
    }
    if (record.state !== 'crashed' && record.state !== 'auth_required' && record.state !== 'certificate_error') {
      record.state = visible ? 'live' : record.view ? 'hidden' : 'evicted';
    }
    this.publish(record);
    return { ok: true };
  }

  async list(sessionId: string): Promise<WebTabSnapshot[]> {
    const out: WebTabSnapshot[] = [];
    for (const record of this.tabs.values()) {
      if (record.sessionId === sessionId) out.push(this.snapshot(record));
    }
    return out;
  }

  async get(tabId: string): Promise<WebTabSnapshot | null> {
    const record = this.tabs.get(tabId);
    return record ? this.snapshot(record) : null;
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /**
   * Destroy every view for one cyboflow session.
   *
   * Dismissing a session ARCHIVES it (`UPDATE sessions SET archived = 1`), so the
   * `ON DELETE CASCADE` on `session_web_tabs` never fires and the renderer's
   * `centerPaneStore` cleanup only drops Zustand state — it cannot destroy a
   * main-process view. Without this hook a dismissed or merged session keeps live
   * renderers, network traffic and telemetry alive until the whole window closes.
   */
  disposeSession(sessionId: string): void {
    for (const [tabId, record] of [...this.tabs]) {
      if (record.sessionId !== sessionId) continue;
      this.destroyView(record);
      this.tabs.delete(tabId);
      this.telemetry.forget(tabId);
      this.emit(WEB_VIEWER_TAB_CLOSED, { sessionId, tabId, reason: 'disposed' as const });
    }
    this.agentOpens.delete(sessionId);
    // The agent jar is per session and is discarded with it.
    this.touchedPartitions.delete(partitionFor('agent', sessionId, false));
  }

  /** Destroy everything (app quit, or the main window going away). */
  disposeAll(): void {
    for (const [tabId, record] of [...this.tabs]) {
      this.destroyView(record);
      this.tabs.delete(tabId);
      this.telemetry.forget(tabId);
      this.emit(WEB_VIEWER_TAB_CLOSED, {
        sessionId: record.sessionId,
        tabId,
        reason: 'disposed' as const,
      });
    }
  }

  /**
   * Record that an agent read this tab's telemetry. Refreshes the agent pin, so
   * the tab is among the last chosen for eviction for `pinTtlMs` — never exempt.
   */
  noteAgentRead(tabId: string): void {
    const record = this.tabs.get(tabId);
    if (record) record.lastAgentReadAt = this.now();
  }

  /** The tab as the consent layer sees it, resolved now. Null for an unknown tab. */
  consentView(tabId: string): WebTabConsentView | null {
    const r = this.tabs.get(tabId);
    if (!r) return null;
    return {
      sessionId: r.sessionId,
      tabId: r.tabId,
      openedBy: r.openedBy,
      openedByRunId: r.openedByRunId,
      humanTouched: r.humanTouched,
      partitionHumanTouched: this.touchedPartitions.has(r.partition),
      principal: redactToOrigin(r.currentUrl),
      epoch: r.navigationEpoch,
      state: r.state,
      loading: r.loading,
    };
  }

  /** Tab ids of one session, for callers that persist or audit. */
  tabIdsForSession(sessionId: string): string[] {
    const out: string[] = [];
    for (const record of this.tabs.values()) {
      if (record.sessionId === sessionId) out.push(record.tabId);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async history(tabId: string, direction: 'back' | 'forward'): Promise<WebViewerAck> {
    const record = this.tabs.get(tabId);
    if (!record) return { ok: false, error: 'tab_not_found' };
    const wc = record.view?.webContents;
    if (!wc || wc.isDestroyed()) return { ok: false, error: 'tab_evicted' };
    const nav = wc.navigationHistory;
    if (direction === 'back') {
      if (!nav.canGoBack()) return { ok: false, error: 'no_history' };
      nav.goBack();
    } else {
      if (!nav.canGoForward()) return { ok: false, error: 'no_history' };
      nav.goForward();
    }
    return { ok: true };
  }

  private requireWindow(): BrowserWindow | null {
    const window = this.deps.getMainWindow();
    if (!window || window.isDestroyed()) return null;
    if (this.attachedWindow !== window) {
      this.attachedWindow = window;
      // Reap on close, not on 'closed' of a stale reference: macOS re-creates the
      // window on dock activate, and without this every view parented to the old
      // one would stay alive and invisible.
      window.once('closed', () => {
        if (this.attachedWindow === window) this.attachedWindow = null;
        this.disposeAll();
      });
    }
    return window;
  }

  /**
   * Create the view, wire its handlers, and attach it if the tab is visible.
   * RETURNS the view (rather than a boolean plus a mutation) so callers keep a
   * non-null reference — reading `record.view` back after assigning it null
   * leaves TypeScript narrowing it to `never`.
   */
  private createView(record: TabRecord): WebContentsView | null {
    const window = this.requireWindow();
    if (!window) return null;

    const ses = hardenPartition(record.partition);
    const view = new WebContentsView({
      webPreferences: {
        // NO preload: the page must not see any cyboflow bridge.
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: record.partition,
        // `alert` / `confirm` / `prompt` from a remote page would block the whole
        // app on a modal it has no chrome for. Overrides `safeDialogs`, so never
        // set both.
        disableDialogs: true,
        autoplayPolicy: 'document-user-activation-required',
        webviewTag: false,
        // A remote page has no business with the app's spellcheck dictionaries.
        spellcheck: false,
      },
    });
    record.view = view;
    this.instrumentPartition(record.partition, ses);
    this.telemetry.attach(record.tabId, view.webContents.id);
    this.wireView(record, view.webContents, ses);
    if (record.visible) {
      window.contentView.addChildView(view);
      this.applyBounds(record);
    }
    view.setVisible(record.visible);
    return view;
  }

  private wireView(record: TabRecord, wc: WebContents, ses: Electron.Session): void {
    // --- navigation policy -------------------------------------------------
    wc.on('will-navigate', (event, url) => {
      if (shouldBlockViewerNavigation(url)) {
        event.preventDefault();
        console.warn('[WebViewer] blocked navigation to non-web scheme:', url);
      }
    });

    wc.setWindowOpenHandler(({ url }) => {
      // Never a real popup: a BrowserWindow opened by a remote page would carry
      // this partition with none of the guards, chrome or occlusion handling.
      if (popupDisposition(url) === 'new-tab') {
        this.emit(WEB_VIEWER_POPUP, {
          sessionId: record.sessionId,
          openerTabId: record.tabId,
          url,
        });
      }
      return { action: 'deny' };
    });

    // --- downloads ---------------------------------------------------------
    // v1 cancels. A download from a page inside the app would land in the user's
    // Downloads folder with no visible provenance and no agent-visible record.
    ses.on('will-download', (event) => {
      event.preventDefault();
    });

    // --- fail-closed auth + TLS, and HUMAN-ONLY --------------------------
    // Neither has a handler in main today, and local dev targets routinely use
    // HTTP Basic or a self-signed cert — without an explicit policy those pages
    // hang forever awaiting a callback. Both deny and surface a typed state; any
    // exception is a human's to grant and is NEVER inherited from a drive grant.
    wc.on('login', (event, _details, _authInfo, callback) => {
      event.preventDefault();
      callback();
      record.state = 'auth_required';
      record.blockedReason = 'This page asked for a username and password.';
      record.loading = false;
      this.publish(record);
    });

    wc.on('certificate-error', (event, url, error, _certificate, callback, isMainFrame) => {
      event.preventDefault();
      callback(false);
      if (!isMainFrame) return;
      record.state = 'certificate_error';
      record.blockedReason = `${error} (${url})`;
      record.loading = false;
      this.publish(record);
    });

    // --- lifecycle --------------------------------------------------------
    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame) return;
      this.telemetry.appendNavigation(record.tabId, 'start', details.url);
      record.loading = true;
      this.publish(record);
    });

    wc.on('did-navigate', (_event, url) => {
      this.telemetry.appendNavigation(record.tabId, 'commit', url);
      this.commitNavigation(record, url, false);
    });

    // `did-navigate` is NOT emitted for in-page navigation. Without this a
    // history.pushState / replaceState / hash change silently moves the visible
    // route while currentUrl, the persisted row, the URL chrome and the consent
    // navigation epoch all go stale — worst where it is least visible, since the
    // route can carry the sensitive part of the URL.
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.telemetry.appendNavigation(record.tabId, 'in_page', url);
      this.commitNavigation(record, url, true);
    });

    wc.on('page-title-updated', (_event, title) => {
      // Truncated, and never interpreted as markup by the strip.
      record.title = title.slice(0, 200);
      this.publish(record);
    });

    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame) return;
      // -3 is ERR_ABORTED — a navigation the user or a redirect superseded.
      if (errorCode === -3) return;
      this.telemetry.appendNavigation(record.tabId, 'fail', validatedUrl, `${errorCode} ${errorDescription}`);
      record.loading = false;
      record.blockedReason = errorDescription;
      this.publish(record);
    });

    wc.on('did-stop-loading', () => {
      record.loading = false;
      this.publish(record);
    });

    // A crashed renderer leaves the map pointing at a dead webContents, which
    // would otherwise be reported as `live`/`hidden` while every capture,
    // navigation and evaluate call fails inconsistently.
    wc.on('render-process-gone', (_event, details) => {
      this.telemetry.appendNavigation(record.tabId, 'crash', record.currentUrl, details.reason);
      record.state = 'crashed';
      record.blockedReason = details.reason;
      record.loading = false;
      record.navigationEpoch += 1; // invalidates grants bound to the old epoch
      this.emitNavigated(record, false);
      this.publish(record);
      this.emit(WEB_VIEWER_TAB_CLOSED, {
        sessionId: record.sessionId,
        tabId: record.tabId,
        reason: 'crashed' as const,
      });
    });

    // --- telemetry: console ---------------------------------------------
    // WebContents-wide (subframes included), with the logging frame attached —
    // so an artifact iframe's errors are visible without any CDP session.
    wc.on('console-message', (event) => {
      this.telemetry.appendConsole(record.tabId, {
        level: event.level,
        message: event.message,
        sourceId: event.sourceId,
        lineNumber: event.lineNumber,
        frame: (() => {
          try {
            return event.frame ? { url: event.frame.url } : null;
          } catch {
            return null; // the frame navigated or was destroyed
          }
        })(),
      });
    });

    // --- keyboard ---------------------------------------------------------
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      this.markHumanTouched(record);
      const chords = this.chords();
      const hit = matchReservedChord(
        {
          key: input.key,
          code: input.code,
          metaKey: input.meta,
          ctrlKey: input.control,
          shiftKey: input.shift,
          altKey: input.alt,
        },
        chords,
        this.deps.platform,
      );
      if (!hit) return;
      this.emitChord(record, hit.action);
      if (hit.suppress) {
        // preventDefault() suppresses BOTH the page and the menu accelerator.
        // Without it the page receives the same keystroke and acts on it twice.
        event.preventDefault();
      }
    });

    // A focused native view also swallows the app's context menu, so the tab
    // gets its own — copy / copy link / reload / open in browser.
    wc.on('context-menu', (_event, params) => {
      this.emit(WEB_VIEWER_CONTEXT_MENU, {
        sessionId: record.sessionId,
        tabId: record.tabId,
        x: params.x,
        y: params.y,
        linkURL: params.linkURL,
        selectionText: params.selectionText,
      });
    });

    // Focus is the pointer-side half of the tripwire: clicking into the view to
    // interact with it focuses it, and `before-input-event` only ever sees
    // KEYSTROKES, so without this a user who signed in using only the mouse
    // (a password manager autofill, an OAuth "Continue" button) would leave the
    // tab freely readable by agents.
    wc.on('focus', () => {
      this.markHumanTouched(record);
    });
  }

  /** Resolve the reserved-chord table for the current config. */
  private chords(): readonly ReservedChord[] {
    return resolveReservedChords(this.deps.shortcutOverrides(), { devMode: this.deps.devMode });
  }

  private emitChord(record: TabRecord, action: ReservedChordAction): void {
    this.emit(WEB_VIEWER_CHORD, {
      sessionId: record.sessionId,
      tabId: record.tabId,
      action,
    });
  }

  /**
   * Latch the human-interaction tripwire. From here on EVERY agent read of this
   * tab is consent-gated regardless of `openedBy`, because the user may have just
   * typed a credential into an agent-opened tab. Latches once and is persisted by
   * the listener, so it survives a restart.
   */
  private markHumanTouched(record: TabRecord): void {
    if (record.humanTouched) return;
    record.humanTouched = true;
    this.touchedPartitions.add(record.partition);
    this.emit(WEB_VIEWER_HUMAN_TOUCH, { sessionId: record.sessionId, tabId: record.tabId });
    this.publish(record);
  }

  private commitNavigation(record: TabRecord, url: string, inPage: boolean): void {
    record.currentUrl = url;
    record.navigationEpoch += 1;
    this.emitNavigated(record, inPage);
    record.blockedReason = null;
    // A successful commit clears a previous auth/TLS block.
    if (record.state === 'auth_required' || record.state === 'certificate_error') {
      record.state = record.visible ? 'live' : 'hidden';
    }
    record.lastActiveAt = this.now();
    this.publish(record);
  }

  private emitNavigated(record: TabRecord, inPage: boolean): void {
    const event: WebViewerNavigatedEvent = {
      sessionId: record.sessionId,
      tabId: record.tabId,
      epoch: record.navigationEpoch,
      principal: redactToOrigin(record.currentUrl),
      inPage,
    };
    this.emit(WEB_VIEWER_NAVIGATED, event);
  }

  private fail(record: TabRecord, reason: string, err: unknown): void {
    record.blockedReason = err instanceof Error ? err.message : reason;
    this.publish(record);
  }

  /** Re-create a destroyed/deferred view on demand. Null when there is no window. */
  private ensureLoaded(record: TabRecord): WebContents | null {
    const wc = record.view?.webContents;
    if (wc && !wc.isDestroyed()) return wc;
    if (record.state === 'crashed') return null;
    record.view = null;
    const view = this.createView(record);
    if (!view) return null;
    record.state = record.visible ? 'live' : 'hidden';
    record.loading = true;
    void view.webContents.loadURL(record.currentUrl ?? record.initialUrl).catch((err: unknown) => {
      record.loading = false;
      this.fail(record, 'did_fail_load', err);
    });
    this.enforceLoadedCaps(record.tabId);
    return view.webContents;
  }

  /**
   * Install the partition's network observers, once. Observational listeners
   * only (`onSendHeaders` / `onCompleted` / `onErrorOccurred`) — no blocking
   * `onBeforeRequest`, so telemetry never adds a round trip to a request. A
   * session holds ONE listener per webRequest event, which is safe here because
   * these partitions belong to the viewer alone.
   */
  private instrumentPartition(partition: string, ses: Electron.Session): void {
    if (this.instrumented.has(partition)) return;
    this.instrumented.add(partition);
    const t = this.telemetry;
    // Explicit fields, never a spread of `details`: it also carries the request
    // and response HEADERS (Cookie / Set-Cookie / Authorization), and reading a
    // destroyed frame's getter throws.
    const frameOf = (d: { frame?: Electron.WebFrameMain | null }) => {
      try {
        return d.frame ? { url: d.frame.url } : null;
      } catch {
        return null;
      }
    };
    ses.webRequest.onSendHeaders((d) => t.requestStarted(partition, { id: d.id, timestamp: d.timestamp }));
    ses.webRequest.onCompleted((d) =>
      t.requestFinished(partition, {
        id: d.id,
        url: d.url,
        method: d.method,
        resourceType: d.resourceType,
        timestamp: d.timestamp,
        webContentsId: d.webContentsId,
        frame: frameOf(d),
        statusCode: d.statusCode,
        fromCache: d.fromCache,
      }),
    );
    ses.webRequest.onErrorOccurred((d) =>
      t.requestFinished(partition, {
        id: d.id,
        url: d.url,
        method: d.method,
        resourceType: d.resourceType,
        timestamp: d.timestamp,
        webContentsId: d.webContentsId,
        frame: frameOf(d),
        fromCache: d.fromCache,
        error: d.error,
      }),
    );
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private recordAgentOpen(sessionId: string, now: number): void {
    const windowMs = DEFAULT_CAP_LIMITS.agentOpenWindowMs;
    const kept = (this.agentOpens.get(sessionId) ?? []).filter((t) => now - t < windowMs);
    kept.push(now);
    this.agentOpens.set(sessionId, kept);
  }

  /**
   * Destroy loaded views past the per-session and global caps. `protectTabId` is
   * the tab that just loaded — evicting it would make the open a no-op.
   *
   * Eviction DESTROYS the view (a URL row that re-navigates on demand) and is
   * always published as `state: 'evicted'`, never silent. The committed URL is
   * kept, so the re-navigation lands where the page was.
   */
  private enforceLoadedCaps(protectTabId: string): void {
    const records: CapRecord[] = [];
    for (const r of this.tabs.values()) {
      const wc = r.view?.webContents;
      records.push({
        tabId: r.tabId,
        sessionId: r.sessionId,
        openedBy: r.openedBy,
        loaded: wc !== undefined && !wc.isDestroyed() && r.state !== 'crashed',
        visible: r.visible,
        lastActiveAt: r.lastActiveAt,
        lastAgentReadAt: r.lastAgentReadAt,
      });
    }
    for (const tabId of selectEvictions(records, this.now(), { protectTabId })) {
      const record = this.tabs.get(tabId);
      if (!record) continue;
      this.destroyView(record);
      record.state = 'evicted';
      record.loading = false;
      this.publish(record);
    }
  }

  /**
   * Position the view over the renderer's anchor rect.
   *
   * SCALED IN MAIN, deliberately: `setBounds` is DIP-relative while
   * `getBoundingClientRect` is renderer CSS px, so the rect is multiplied by the
   * window's `getZoomFactor()` and rounded here. Do NOT derive the factor from
   * `devicePixelRatio` — that is zoomFactor × display scaleFactor, so it would
   * be wrong on every HiDPI screen.
   */
  private applyBounds(record: TabRecord): void {
    const view = record.view;
    const bounds = record.bounds;
    if (!view || !bounds) return;
    const window = this.requireWindow();
    if (!window) return;
    const zoom = window.webContents.getZoomFactor() || 1;
    view.setBounds({
      x: Math.round(bounds.x * zoom),
      y: Math.round(bounds.y * zoom),
      width: Math.max(0, Math.round(bounds.width * zoom)),
      height: Math.max(0, Math.round(bounds.height * zoom)),
    });
  }

  private destroyView(record: TabRecord): void {
    const view = record.view;
    record.view = null;
    if (!view) return;
    // The rings outlive the view (an evicted tab keeps its history); only the
    // webContents → tab attribution goes.
    this.telemetry.detach(view.webContents.id);
    const window = this.attachedWindow;
    if (window && !window.isDestroyed()) {
      try {
        window.contentView.removeChildView(view);
      } catch {
        // Already detached — the window may have gone in between.
      }
    }
    const wc = view.webContents;
    if (!wc.isDestroyed()) {
      wc.removeAllListeners();
      wc.close();
    }
  }

  private snapshot(record: TabRecord): WebTabSnapshot {
    const wc = record.view?.webContents;
    const alive = wc !== undefined && !wc.isDestroyed();
    return {
      tabId: record.tabId,
      sessionId: record.sessionId,
      state: record.state,
      currentUrl: record.currentUrl,
      title: record.title,
      openedBy: record.openedBy,
      openedByRunId: record.openedByRunId,
      humanTouched: record.humanTouched,
      canGoBack: alive ? wc.navigationHistory.canGoBack() : false,
      canGoForward: alive ? wc.navigationHistory.canGoForward() : false,
      loading: record.loading,
      blockedReason: record.blockedReason,
    };
  }

  private publish(record: TabRecord): void {
    this.emit(WEB_VIEWER_TAB_STATE, {
      sessionId: record.sessionId,
      snapshot: this.snapshot(record),
    });
  }

  /** Open a URL in the OS browser (the context-menu escape). */
  openExternally(url: string): void {
    if (resolveViewableUrl(url) === null) return;
    void shell.openExternal(url);
  }
}
