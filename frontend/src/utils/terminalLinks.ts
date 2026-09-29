/**
 * terminalLinks — clickable URLs in an xterm.
 *
 * Two kinds of link reach a terminal, and xterm handles them separately:
 *  - plain URLs in the output, which only become links through a link provider
 *    (`@xterm/addon-web-links`);
 *  - OSC 8 hyperlinks (`ESC ] 8 ;; url ESC \ text …`), which the `claude` CLI
 *    prints for its own links. xterm's DEFAULT handler for these calls
 *    `window.confirm` + `window.open` — wrong in Electron — so `linkHandler` is
 *    always replaced.
 *
 * Both go through `openTerminalLink`: an http(s) URL opens as a web tab in the
 * session the terminal belongs to (the `WebLinkContext` handler the host passes
 * via `resolveOpen`, read at CLICK time because cached terminals outlive the
 * mount that created them), or in the OS browser when the terminal sits outside
 * any session. Every other scheme is ignored: a terminal can print anything,
 * and `file:` / custom-protocol links are not ours to launch.
 */
import type { Terminal } from '@xterm/xterm';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { WebLinkHandler } from '../contexts/WebLinkContext';
import { viewableHref } from './openWebLink';

export function openTerminalLink(uri: string, open: WebLinkHandler | null): void {
  const url = viewableHref(uri);
  if (url === null) return;
  if (open) open(url);
  else void window.electronAPI?.openExternal(url);
}

/** Make `term`'s URLs clickable. Call once per Terminal, before or after `open()`. */
export function attachTerminalLinks(term: Terminal, resolveOpen: () => WebLinkHandler | null): void {
  term.loadAddon(new WebLinksAddon((_event, uri) => openTerminalLink(uri, resolveOpen())));
  term.options.linkHandler = {
    activate: (_event, text) => openTerminalLink(text, resolveOpen()),
    allowNonHttpProtocols: false,
  };
}
