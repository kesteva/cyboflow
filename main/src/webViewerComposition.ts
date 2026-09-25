/**
 * webViewerComposition — the native web viewer's composition root
 * (docs/proposals/native-web-viewer.md §3.1).
 *
 * A SIBLING of index.ts on purpose, exactly like verifyComposition.ts /
 * evalComposition.ts: it imports `electron` and concrete services freely, so it
 * must stay OUT of `main/src/orchestrator/**`, whose standalone-typecheck
 * invariant scans for precisely those imports. index.ts is also at its file-size
 * ratchet cap, with the headroom this keeps it inside.
 *
 * It assembles the WebViewerManager, hands the router its seams, renders the
 * per-tab context menu, and — the part that is easy to forget — wires TEARDOWN.
 */
import { app, clipboard, Menu, shell, type BrowserWindow } from 'electron';
import type { ConfigManager } from './services/configManager';
import type { SessionManager } from './services/sessionManager';
import type { DatabaseService } from './database/database';
import { WebTabsRepository } from './database/webTabsRepository';
import { PersistingWebViewer } from './services/webViewer/webViewerPersistence';
import { WebViewerConsent, WEB_CONSENT_EVENT } from './services/webViewer/webViewerConsent';
import { onRunTerminal } from './services/cyboflow/transitions';
import {
  WebViewerManager,
  WEB_VIEWER_CHORD,
  WEB_VIEWER_CONTEXT_MENU,
  WEB_VIEWER_NAVIGATED,
  WEB_VIEWER_POPUP,
  WEB_VIEWER_TAB_CLOSED,
  WEB_VIEWER_TAB_STATE,
} from './services/webViewer/webViewerManager';
import type {
  WebViewerConsentLike,
  WebViewerEventsLike,
  WebViewerLike,
} from './orchestrator/trpc/contracts/webViewerOps';
import type { WebViewerNavigatedEvent } from './services/webViewer/webViewerManager';

export interface WebViewerCompositionDeps {
  configManager: ConfigManager;
  sessionManager: SessionManager;
  /** Tab rows + the web audit trail (migration 146). */
  databaseService: DatabaseService;
  /**
   * ACCESSOR, never a captured window: macOS re-creates the main window on dock
   * activate, so a captured reference would leave the manager parenting views to
   * a destroyed window and orphaning live remote webContents.
   */
  getMainWindow: () => BrowserWindow | null;
  devMode: boolean;
}

export interface WebViewerComposition {
  webViewer: WebViewerLike;
  webViewerEvents: WebViewerEventsLike;
  webViewerConsent: WebViewerConsentLike;
  /** The consent service itself, for the MCP tool handlers. */
  consent: WebViewerConsent;
  manager: WebViewerManager;
  /** Destroy every view for one cyboflow session (archive / merge / delete). */
  disposeSession: (sessionId: string) => void;
}

export function composeWebViewer(deps: WebViewerCompositionDeps): WebViewerComposition {
  const { configManager, sessionManager, databaseService, getMainWindow, devMode } = deps;

  const manager = new WebViewerManager({
    getMainWindow,
    // Read LIVE per call, not snapshotted: flipping the kill switch in Settings
    // must take effect on the next open without a relaunch.
    isEnabled: () => configManager.getWebViewerConfig().enabled,
    persistLogin: () => configManager.getWebViewerConfig().persistLogin,
    shortcutOverrides: () => configManager.getConfig().keyboardShortcuts,
    devMode,
    platform: process.platform === 'darwin' ? 'mac' : 'other',
  });
  // The router sees the PERSISTING wrapper, so every open/close is recorded and
  // audited by construction. The bare manager stays the event source.
  const repo = new WebTabsRepository(databaseService.getDb());
  const viewer = new PersistingWebViewer(manager, repo);

  // ---------------------------------------------------------------------
  // Consent (§7): its own prompts, never QuestionRouter. Every request,
  // grant, denial, timeout and revocation lands in the audit trail.
  // ---------------------------------------------------------------------
  const consent = new WebViewerConsent({
    audit: (ev) => {
      repo.appendEvent({
        sessionId: ev.sessionId,
        tabId: ev.tabId,
        runId: ev.runId,
        kind: ev.kind,
        origin: ev.origin,
        detail: ev.detail ?? null,
      });
    },
  });
  // Grants follow the tab's principal: an in-page same-origin change keeps
  // them, anything else drops them.
  manager.on(WEB_VIEWER_NAVIGATED, (ev: WebViewerNavigatedEvent) => {
    consent.onNavigation(ev.tabId, { epoch: ev.epoch, principal: ev.principal, inPage: ev.inPage });
  });
  manager.on(WEB_VIEWER_TAB_CLOSED, (ev: { tabId: string; reason: string }) => {
    if (ev.reason !== 'evicted') consent.revokeTab(ev.tabId, `tab_${ev.reason}`);
  });
  // A finished run keeps nothing: grants go, open prompts are denied.
  onRunTerminal((runId) => consent.revokeRun(runId));

  const webViewerConsent: WebViewerConsentLike = {
    listPending: (sessionId) => consent.listPending(sessionId),
    respond: (requestId, decision) => consent.respond(requestId, decision),
    listGrants: (sessionId) => consent.listGrants(sessionId),
    revokeGrant: (grantId) => consent.revokeGrant(grantId, 'revoked_by_user'),
    revokeTab: (tabId) => consent.revokeTab(tabId, 'revoked_by_user'),
    activity: (sessionId, tabId) => {
      try {
        return repo.listEvents(sessionId, 200, tabId);
      } catch (err) {
        console.warn('[WebViewer] activity read failed:', err);
        return [];
      }
    },
  };

  // ---------------------------------------------------------------------
  // Per-tab context menu.
  //
  // A focused native view swallows the app's own context menu along with every
  // other keystroke and click, so the tab needs its own. Built HERE rather than
  // in the manager to keep Menu/clipboard out of the view-lifecycle module.
  // ---------------------------------------------------------------------
  manager.on(
    WEB_VIEWER_CONTEXT_MENU,
    (payload: { tabId: string; linkURL: string; selectionText: string }) => {
      const items: Electron.MenuItemConstructorOptions[] = [];
      if (payload.selectionText.length > 0) {
        items.push({
          label: 'Copy',
          click: () => clipboard.writeText(payload.selectionText),
        });
      }
      if (payload.linkURL.length > 0) {
        items.push({
          label: 'Copy link address',
          click: () => clipboard.writeText(payload.linkURL),
        });
        items.push({
          label: 'Open link in browser',
          click: () => {
            if (/^https?:\/\//i.test(payload.linkURL)) void shell.openExternal(payload.linkURL);
          },
        });
      }
      if (items.length > 0) items.push({ type: 'separator' });
      items.push({ label: 'Reload', click: () => void manager.reload(payload.tabId) });
      items.push({
        label: 'Open page in browser',
        click: () => {
          void manager.get(payload.tabId).then((snapshot) => {
            if (snapshot?.currentUrl) manager.openExternally(snapshot.currentUrl);
          });
        },
      });
      Menu.buildFromTemplate(items).popup({ window: getMainWindow() ?? undefined });
    },
  );

  // ---------------------------------------------------------------------
  // Teardown.
  //
  // `sessionManager` emits 'session-deleted' for BOTH a real delete and an
  // ARCHIVE — and dismissing a session in the UI archives it
  // (`UPDATE sessions SET archived = 1`), so the ON DELETE CASCADE on
  // session_web_tabs never fires. Hooking the event rather than the archive call
  // site also keeps `ipc/session.ts` untouched, which matters because that file
  // sits exactly at its file-size ratchet cap.
  //
  // Without this, a dismissed or merged session keeps live renderers, network
  // traffic, telemetry buffers and (later) debugger attachments alive until the
  // whole window closes.
  // ---------------------------------------------------------------------
  sessionManager.on('session-deleted', (session: { id: string }) => {
    // Views AND tab rows (archive never cascades); the audit trail is kept.
    consent.disposeSession(session.id);
    viewer.disposeSession(session.id);
  });
  app.on('before-quit', () => {
    // Views only — the rows are what bring the tabs back on the next launch.
    manager.disposeAll();
  });

  return {
    webViewer: viewer,
    webViewerEvents: {
      emitter: manager,
      tabStateChannel: WEB_VIEWER_TAB_STATE,
      tabClosedChannel: WEB_VIEWER_TAB_CLOSED,
      chordChannel: WEB_VIEWER_CHORD,
      popupChannel: WEB_VIEWER_POPUP,
      consentEmitter: consent,
      consentChannel: WEB_CONSENT_EVENT,
    },
    webViewerConsent,
    consent,
    manager,
    disposeSession: (sessionId: string) => {
      consent.disposeSession(sessionId);
      viewer.disposeSession(sessionId);
    },
  };
}
