/**
 * useWebViewerBridge — main → renderer web-viewer events.
 *
 * Pinned here: a popup whose open main REJECTS (the per-session tab cap, the kill
 * switch) must not leave a strip entry with no view behind it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

type PopupHandler = (ev: { sessionId: string; openerTabId: string; url: string }) => void;
let popupHandler: PopupHandler | null = null;
const openMutate = vi.fn();
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
      },
    },
  },
}));

const { useWebViewerBridge } = await import('../useWebViewerBridge');
const { useCenterPaneStore } = await import('../../stores/centerPaneStore');
const { useErrorStore } = await import('../../stores/errorStore');

const KEY = 'sess-1';
const webTabs = () =>
  (useCenterPaneStore.getState().bySession[KEY]?.tabs ?? []).filter((t) => t.kind === 'web');

beforeEach(() => {
  popupHandler = null;
  openMutate.mockReset();
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
