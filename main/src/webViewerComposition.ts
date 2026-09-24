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
import {
  WebViewerManager,
  WEB_VIEWER_CHORD,
  WEB_VIEWER_CONTEXT_MENU,
  WEB_VIEWER_POPUP,
  WEB_VIEWER_TAB_CLOSED,
  WEB_VIEWER_TAB_STATE,
} from './services/webViewer/webViewerManager';
import type { WebViewerEventsLike, WebViewerLike } from './orchestrator/trpc/contracts/webViewerOps';

export interface WebViewerCompositionDeps {
  configManager: ConfigManager;
  sessionManager: SessionManager;
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
  /** Destroy every view for one cyboflow session (archive / merge / delete). */
  disposeSession: (sessionId: string) => void;
}

export function composeWebViewer(deps: WebViewerCompositionDeps): WebViewerComposition {
  const { configManager, sessionManager, getMainWindow, devMode } = deps;

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
    manager.disposeSession(session.id);
  });
  app.on('before-quit', () => {
    manager.disposeAll();
  });

  return {
    webViewer: manager,
    webViewerEvents: {
      emitter: manager,
      tabStateChannel: WEB_VIEWER_TAB_STATE,
      tabClosedChannel: WEB_VIEWER_TAB_CLOSED,
      chordChannel: WEB_VIEWER_CHORD,
      popupChannel: WEB_VIEWER_POPUP,
    },
    disposeSession: (sessionId: string) => manager.disposeSession(sessionId),
  };
}
