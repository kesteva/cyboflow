/**
 * centerPaneStore — `web` tab behaviour (docs/proposals/native-web-viewer.md).
 *
 * The contract that matters here is IDENTITY. Every other tab helper keys on
 * something immutable (a file path, an artifact id, an idea id); a web tab's URL
 * moves on the first click, so its id is an opaque uuid minted once and returned
 * synchronously to the caller, who hands the same id to `webViewer.open`. It is
 * the correlation key across the strip, the main-process view map, the
 * `session_web_tabs` row, the consent grants and the telemetry cursor — so two
 * opens of the same URL are two tabs, and a restore must REUSE the persisted id
 * rather than mint a new one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useCenterPaneStore } from '../centerPaneStore';
import { FLOW_TAB_ID, isWebTabId, makeWebTabId } from '../../../../shared/types/centerPane';

const KEY = 'session-1';

function reset(): void {
  useCenterPaneStore.setState({ bySession: {} });
}
function get() {
  return useCenterPaneStore.getState();
}
function tabs() {
  return get().bySession[KEY].tabs;
}

describe('makeWebTabId', () => {
  it('is opaque and unique — not a function of any URL', () => {
    const a = makeWebTabId();
    const b = makeWebTabId();
    expect(a).not.toBe(b);
    expect(isWebTabId(a)).toBe(true);
    expect(isWebTabId('file:src/index.ts')).toBe(false);
  });
});

describe('openWebTab', () => {
  beforeEach(reset);

  it('opens a focused user tab, labels it by hostname, and returns the id', () => {
    const id = get().openWebTab(KEY, { url: 'https://docs.anthropic.com/en/docs' });

    expect(isWebTabId(id)).toBe(true);
    const s = get().bySession[KEY];
    expect(s.activeTabId).toBe(id);
    expect(s.tabs).toHaveLength(2);
    expect(s.tabs[1]).toMatchObject({
      id,
      kind: 'web',
      label: 'docs.anthropic.com',
      initialUrl: 'https://docs.anthropic.com/en/docs',
      currentUrl: 'https://docs.anthropic.com/en/docs',
      openedBy: 'user',
    });
    expect(s.tabs[1].isNew).toBeUndefined();
  });

  it('does NOT dedupe by URL — two opens of one URL are two tabs', () => {
    const a = get().openWebTab(KEY, { url: 'http://localhost:5173/' });
    const b = get().openWebTab(KEY, { url: 'http://localhost:5173/' });

    expect(a).not.toBe(b);
    expect(tabs().filter((t) => t.kind === 'web')).toHaveLength(2);
  });

  it('an agent open lands in the background, pulses, and records its run', () => {
    const id = get().openWebTab(KEY, {
      url: 'https://example.test/preview',
      openedBy: 'agent',
      openedByRunId: 'run-77',
      focus: false,
    });

    const s = get().bySession[KEY];
    // Never steals focus — the Flow tab is still active.
    expect(s.activeTabId).toBe(FLOW_TAB_ID);
    expect(s.tabs[1]).toMatchObject({
      id,
      openedBy: 'agent',
      openedByRunId: 'run-77',
      isNew: true,
    });
  });

  it('reuses a supplied id (the restore path) instead of minting a second tab', () => {
    const persisted = makeWebTabId();
    get().openWebTab(KEY, {
      id: persisted,
      url: 'https://example.test/a',
      currentUrl: 'https://example.test/a/deep',
      humanTouched: true,
      focus: false,
    });
    const again = get().openWebTab(KEY, { id: persisted, url: 'https://example.test/a' });

    expect(again).toBe(persisted);
    expect(tabs().filter((t) => t.kind === 'web')).toHaveLength(1);
    expect(tabs()[1]).toMatchObject({
      id: persisted,
      currentUrl: 'https://example.test/a/deep',
      humanTouched: true,
    });
  });

  it('falls back to the raw string when the URL does not parse', () => {
    const id = get().openWebTab(KEY, { url: 'not a url' });
    expect(tabs().find((t) => t.id === id)?.label).toBe('not a url');
  });

  it('closes like any other non-pinned tab', () => {
    const id = get().openWebTab(KEY, { url: 'https://example.test/' });
    get().closeTab(KEY, id);
    expect(tabs()).toHaveLength(1);
    expect(get().bySession[KEY].activeTabId).toBe(FLOW_TAB_ID);
  });
});

describe('updateWebTab', () => {
  beforeEach(reset);

  it('rewrites currentUrl and title from a main-process event', () => {
    const id = get().openWebTab(KEY, { url: 'https://example.test/' });
    get().updateWebTab(KEY, id, {
      currentUrl: 'https://example.test/second',
      label: 'Second page',
    });

    expect(tabs().find((t) => t.id === id)).toMatchObject({
      initialUrl: 'https://example.test/',
      currentUrl: 'https://example.test/second',
      label: 'Second page',
    });
  });

  it('ignores an empty title rather than blanking the strip label', () => {
    const id = get().openWebTab(KEY, { url: 'https://example.test/' });
    get().updateWebTab(KEY, id, { label: '' });
    expect(tabs().find((t) => t.id === id)?.label).toBe('example.test');
  });

  it('LATCHES humanTouched — a patch can set it, never clear it', () => {
    const id = get().openWebTab(KEY, { url: 'https://example.test/' });
    get().updateWebTab(KEY, id, { humanTouched: true });
    expect(tabs().find((t) => t.id === id)?.humanTouched).toBe(true);

    // Clearing it would re-open free agent reads of a tab the user typed into.
    get().updateWebTab(KEY, id, { humanTouched: false });
    expect(tabs().find((t) => t.id === id)?.humanTouched).toBe(true);
  });

  it('is a no-op for an unknown id or a non-web tab', () => {
    get().ensureSession(KEY);
    const before = get().bySession[KEY];
    get().updateWebTab(KEY, 'web:missing', { currentUrl: 'https://x.test/' });
    get().updateWebTab(KEY, FLOW_TAB_ID, { currentUrl: 'https://x.test/' });
    expect(get().bySession[KEY].tabs).toEqual(before.tabs);
  });
});
