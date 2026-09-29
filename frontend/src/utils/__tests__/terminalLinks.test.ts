/**
 * terminalLinks — both link kinds a terminal can show (plain URLs via the
 * web-links addon, OSC 8 hyperlinks via `linkHandler`) route to the session's web
 * tab, fall back to the OS browser outside a session, and launch nothing that is
 * not http(s).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal, ILinkHandler } from '@xterm/xterm';

let addonHandler: ((event: MouseEvent, uri: string) => void) | null = null;
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    constructor(handler: (event: MouseEvent, uri: string) => void) {
      addonHandler = handler;
    }
  },
}));

import { attachTerminalLinks } from '../terminalLinks';

const openExternal = vi.fn();
const click = new MouseEvent('click');

function fakeTerminal(): Terminal & { options: { linkHandler?: ILinkHandler | null } } {
  return { loadAddon: vi.fn(), options: {} } as unknown as Terminal & {
    options: { linkHandler?: ILinkHandler | null };
  };
}

beforeEach(() => {
  addonHandler = null;
  openExternal.mockReset();
  (window as unknown as { electronAPI: { openExternal: typeof openExternal } }).electronAPI = { openExternal };
});

describe('attachTerminalLinks', () => {
  it('opens a plain URL and an OSC 8 link through the session handler read at click time', () => {
    const term = fakeTerminal();
    let open: ((url: string) => void) | null = null;
    attachTerminalLinks(term, () => open);
    expect(term.loadAddon).toHaveBeenCalledTimes(1);

    // The handler is resolved per click: a host that mounts later still wins.
    const seen: string[] = [];
    open = (url) => seen.push(url);
    addonHandler?.(click, 'https://example.com/a');
    term.options.linkHandler?.activate(click, 'http://localhost:5173/x', {} as never);
    expect(seen).toEqual(['https://example.com/a', 'http://localhost:5173/x']);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('falls back to the OS browser outside a session', () => {
    const term = fakeTerminal();
    attachTerminalLinks(term, () => null);
    addonHandler?.(click, 'https://example.com/');
    expect(openExternal).toHaveBeenCalledWith('https://example.com/');
  });

  it('launches nothing for a non-http(s) OSC 8 link, and never enables other schemes', () => {
    const term = fakeTerminal();
    const open = vi.fn();
    attachTerminalLinks(term, () => open);
    term.options.linkHandler?.activate(click, 'file:///etc/passwd', {} as never);
    term.options.linkHandler?.activate(click, 'vscode://some/thing', {} as never);
    expect(open).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(term.options.linkHandler?.allowNonHttpProtocols).toBe(false);
  });
});
