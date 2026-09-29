/**
 * WebLinkContext — routes markdown links into the web viewer.
 *
 * `MarkdownPreview`'s components map is MODULE-SCOPE on purpose (a fresh map per
 * render re-parses every transcript message), so its `a` entry cannot close over
 * a session. It reads this context instead. The default is `null`, which keeps
 * today's behaviour — `target=_blank`, escaped to the OS browser by main — for
 * every markdown surface that is not a chat (task bodies, file previews, the
 * assistant rail, …). Chat hosts wrap their transcript in a provider keyed to
 * the SAME session key their center pane uses, so a click opens a tab there.
 *
 * See docs/proposals/native-web-viewer.md §4.
 */
import { createContext, useCallback, type ReactNode } from 'react';
import { openUserWebTab } from '../utils/openWebLink';

/** Open an absolute http(s) URL as a web tab. */
export type WebLinkHandler = (url: string) => void;

export const WebLinkContext = createContext<WebLinkHandler | null>(null);

export function WebLinkProvider({
  sessionKey,
  children,
}: {
  /** The center-pane session key; null renders children with no routing. */
  sessionKey: string | null;
  children: ReactNode;
}): ReactNode {
  const open = useCallback(
    (url: string) => {
      if (sessionKey !== null) openUserWebTab(sessionKey, url);
    },
    [sessionKey],
  );
  if (sessionKey === null || sessionKey.length === 0) return children;
  return <WebLinkContext.Provider value={open}>{children}</WebLinkContext.Provider>;
}
