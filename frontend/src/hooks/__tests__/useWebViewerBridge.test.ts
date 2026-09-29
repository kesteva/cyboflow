/**
 * useWebViewerBridge — main → renderer web-viewer events.
 *
 * Pinned here: a popup whose open main REJECTS (the per-session tab cap, the kill
 * switch) must not leave a strip entry with no view behind it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

type PopupHandler = (ev: { sessionId: string; openerTabId: string; url: string }) => void;
let popupHandler: PopupHandler | null = null;
type ConsentHandler = (ev: unknown) => void;
let consentHandler: ConsentHandler | null = null;
let openedHandler: ((ev: unknown) => void) | null = null;
let stateHandler: ((ev: unknown) => void) | null = null;
const openMutate = vi.fn();
const restoreMutate = vi.fn();
const sub = () => ({ unsubscribe: vi.fn() });

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      webViewer: {
        onReservedChord: { subscribe: vi.fn(sub) },
        onTabClosed: { subscribe: vi.fn(sub) },
        onPopupRequested: {
          subscribe: vi.fn((_input: unknown, opts: { onData: PopupHandler }) => {
            popupHandler = opts.onData;
            return sub();
          }),
        },
        open: { mutate: (...a: unknown[]) => openMutate(...a) },
        restore: { mutate: (...a: unknown[]) => restoreMutate(...a) },
        pendingConsents: { query: () => Promise.resolve([]) },
        onTabOpened: {
          subscribe: vi.fn((_input: unknown, opts: { onData: (ev: unknown) => void }) => {
            openedHandler = opts.onData;
            return sub();
          }),
        },
        onTabState: {
          subscribe: vi.fn((_input: unknown, opts: { onData: (ev: unknown) => void }) => {
            stateHandler = opts.onData;
            return sub();
          }),
        },
        onConsent: {
          subscribe: vi.fn((_input: unknown, opts: { onData: ConsentHandler }) => {
            consentHandler = opts.onData;
            return sub();
          }),
        },
      },
    },
  },
}));

const { useWebViewerBridge } = await import('../useWebViewerBridge');
const { useCenterPaneStore } = await import('../../stores/centerPaneStore');
const { useErrorStore } = await import('../../stores/errorStore');
const { useWebConsentStore } = await import('../../stores/webConsentStore');

const KEY = 'sess-1';
const webTabs = () =>
  (useCenterPaneStore.getState().bySession[KEY]?.tabs ?? []).filter((t) => t.kind === 'web');

beforeEach(() => {
  popupHandler = null;
  openMutate.mockReset();
  restoreMutate.mockReset();
  restoreMutate.mockResolvedValue([]);
  useCenterPaneStore.setState({ bySession: {} });
  useErrorStore.setState({ currentError: null } as never);
});
afterEach(() => vi.restoreAllMocks());

describe('useWebViewerBridge popups', () => {
  it('keeps the tab when main accepts the open', async () => {
    openMutate.mockResolvedValue({ ok: true, snapshot: {} });
    renderHook(() => useWebViewerBridge(KEY));
    popupHandler!({ sessionId: KEY, openerTabId: 'web:x', url: 'https://example.com/' });
    await waitFor(() => expect(openMutate).toHaveBeenCalled());
    expect(webTabs()).toHaveLength(1);
  });

  it('drops the strip entry and tells the user when the tab cap rejects it', async () => {
    openMutate.mockResolvedValue({ ok: false, error: 'tab_limit_reached' });
    const showError = vi.spyOn(useErrorStore.getState(), 'showError');
    renderHook(() => useWebViewerBridge(KEY));
    popupHandler!({ sessionId: KEY, openerTabId: 'web:x', url: 'https://example.com/' });
    await waitFor(() => expect(webTabs()).toHaveLength(0));
    expect(showError).toHaveBeenCalledWith(expect.objectContaining({ title: 'Too many web tabs' }));
  });
});

describe('useWebViewerBridge restore', () => {
  it('rebuilds persisted tabs under their PERSISTED ids, unfocused and unpulsed', async () => {
    restoreMutate.mockResolvedValue([
      {
        tabId: 'web:persisted-1',
        initialUrl: 'https://example.com/',
        currentUrl: 'https://example.com/deep',
        title: 'Deep page',
        openedBy: 'agent',
        openedByRunId: 'run-9',
        humanTouched: true,
        position: 0,
      },
    ]);
    renderHook(() => useWebViewerBridge(KEY));
    await waitFor(() => expect(webTabs()).toHaveLength(1));

    const [tab] = webTabs();
    // Re-minting would orphan the tab's grants, cursor and row.
    expect(tab.id).toBe('web:persisted-1');
    expect(tab.label).toBe('Deep page');
    expect(tab.currentUrl).toBe('https://example.com/deep');
    // The tripwire survives the restart.
    expect(tab.humanTouched).toBe(true);
    expect(tab.isNew).toBeFalsy();
    expect(useCenterPaneStore.getState().bySession[KEY].activeTabId).not.toBe('web:persisted-1');
    expect(restoreMutate).toHaveBeenCalledWith({ sessionId: KEY });
  });

  it('is idempotent across remounts — no duplicate strip entries', async () => {
    const row = {
      tabId: 'web:p',
      initialUrl: 'https://example.com/',
      currentUrl: null,
      title: null,
      openedBy: 'user' as const,
      openedByRunId: null,
      humanTouched: false,
      position: 0,
    };
    restoreMutate.mockResolvedValue([row]);
    const first = renderHook(() => useWebViewerBridge(KEY));
    await waitFor(() => expect(webTabs()).toHaveLength(1));
    first.unmount();
    renderHook(() => useWebViewerBridge(KEY));
    await waitFor(() => expect(restoreMutate).toHaveBeenCalledTimes(2));
    expect(webTabs()).toHaveLength(1);
  });
});

describe('useWebViewerBridge consent', () => {
  it('follows prompts opening and resolving', async () => {
    renderHook(() => useWebViewerBridge(KEY));
    await waitFor(() => expect(consentHandler).not.toBeNull());
    const request = {
      requestId: 'r1', sessionId: KEY, tabId: 'web:1', runId: 'run-1',
      capability: 'observe', origin: 'https://x.test', reason: null, requestedAt: 1,
    };
    act(() => consentHandler!({ kind: 'requested', sessionId: KEY, request }));
    expect(Object.keys(useWebConsentStore.getState().byRequestId)).toEqual(['r1']);
    act(() => consentHandler!({ kind: 'resolved', sessionId: KEY, requestId: 'r1', tabId: 'web:1' }));
    expect(useWebConsentStore.getState().byRequestId).toEqual({});
  });
});

describe('useWebViewerBridge agent tabs', () => {
  it('adds an agent-opened tab to the strip unfocused and pulsing, under main’s id', async () => {
    renderHook(() => useWebViewerBridge(KEY));
    await waitFor(() => expect(openedHandler).not.toBeNull());
    act(() =>
      openedHandler!({
        sessionId: KEY,
        snapshot: {
          tabId: 'web:agent-1', sessionId: KEY, state: 'hidden', currentUrl: 'http://localhost:5173/',
          title: null, openedBy: 'agent', openedByRunId: 'run-7', humanTouched: false,
          canGoBack: false, canGoForward: false, loading: true, blockedReason: null,
        },
      }),
    );
    const [tab] = webTabs();
    expect(tab).toMatchObject({ id: 'web:agent-1', openedBy: 'agent', openedByRunId: 'run-7', isNew: true });
    expect(useCenterPaneStore.getState().bySession[KEY].activeTabId).not.toBe('web:agent-1');
  });

  it('retitles a BACKGROUND tab — its body is not mounted, so only the bridge sees the event', async () => {
    renderHook(() => useWebViewerBridge(KEY));
    await waitFor(() => expect(stateHandler).not.toBeNull());
    const snapshot = {
      tabId: 'web:agent-2', sessionId: KEY, state: 'hidden', currentUrl: 'http://localhost:5173/',
      title: null, openedBy: 'agent', openedByRunId: 'run-7', humanTouched: false,
      canGoBack: false, canGoForward: false, loading: true, blockedReason: null,
    };
    act(() => openedHandler!({ sessionId: KEY, snapshot }));
    expect(webTabs()[0].label).toBe('localhost');
    act(() =>
      stateHandler!({
        sessionId: KEY,
        snapshot: { ...snapshot, title: 'Dev server', currentUrl: 'http://localhost:5173/app', loading: false },
      }),
    );
    expect(webTabs()[0]).toMatchObject({ label: 'Dev server', currentUrl: 'http://localhost:5173/app' });
    expect(useCenterPaneStore.getState().bySession[KEY].activeTabId).not.toBe('web:agent-2');
  });
});
