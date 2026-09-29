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

const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i;

/**
 * The URL a user TYPED into the new-tab field, or null. Unlike `viewableHref`
 * a bare host is accepted, the way an address bar does: `example.com/x` →
 * https, `localhost:5173` → http (a dev server rarely serves TLS). Anything
 * with a space or no dot is a search, not an address, and the viewer has no
 * search engine to send it to.
 */
export function typedUrl(input: string): string | null {
  const text = input.trim();
  if (text.length === 0 || /\s/.test(text)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return viewableHref(text);
  if (LOCAL_HOST.test(text)) return viewableHref(`http://${text}`);
  // `mailto:x@y.z` / `javascript:…` — a scheme, not a host:port.
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text)) return null;
  const host = text.split(/[/?#]/, 1)[0].replace(/:\d+$/, '');
  if (!host.includes('.')) return null;
  return viewableHref(`https://${text}`);
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
