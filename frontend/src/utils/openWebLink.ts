/**
 * openWebLink — open a URL the USER chose as a web-viewer tab.
 *
 * One path for every user-initiated open (a chat link, a page's `window.open`),
 * so the strip entry, main's view and the failure handling cannot drift apart:
 *
 *  - the store mints the opaque tab id and main opens that exact tab;
 *  - a rejected open leaves no strip entry behind (there is no view for it);
 *  - the kill switch (`viewer_disabled`) falls back to the OS browser — the
 *    behaviour every link had before the viewer existed — and the tab cap tells
 *    the user why nothing opened.
 *
 * See docs/proposals/native-web-viewer.md §4.
 */
import { trpc } from '../trpc/client';
import { useCenterPaneStore } from '../stores/centerPaneStore';
import { useErrorStore } from '../stores/errorStore';

/**
 * The absolute http(s) URL an href names, or null. Relative hrefs are NOT
 * resolved: a chat message has no meaningful base, and resolving against the
 * renderer's own origin would invent a URL nobody wrote.
 */
export function viewableHref(href: string | undefined | null): string | null {
  if (typeof href !== 'string' || href.length === 0) return null;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function openInBrowser(url: string): void {
  void window.electronAPI?.openExternal(url);
}

export function openUserWebTab(sessionKey: string, url: string, options: { focus?: boolean } = {}): void {
  const tabId = useCenterPaneStore
    .getState()
    .openWebTab(sessionKey, { url, openedBy: 'user', focus: options.focus !== false });
  void trpc.cyboflow.webViewer.open
    .mutate({ sessionId: sessionKey, tabId, url, openedBy: 'user' })
    .then((res) => {
      if (res.ok) return;
      useCenterPaneStore.getState().closeTab(sessionKey, tabId);
      if (res.error === 'viewer_disabled') {
        openInBrowser(url);
      } else if (res.error === 'tab_limit_reached') {
        useErrorStore.getState().showError({
          title: 'Too many web tabs',
          error: 'Close a web tab in this session to open another.',
        });
      }
    })
    .catch((err: unknown) => console.warn('[openWebLink] open failed:', err));
}
