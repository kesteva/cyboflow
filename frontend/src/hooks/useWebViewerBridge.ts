/**
 * useWebViewerBridge — the per-session wiring between the main-process web viewer
 * and the renderer's tab store.
 *
 * Three streams, all of which exist because the native view is outside the
 * renderer's world:
 *
 *  - `onReservedChord`: a chord the app owns, pressed while a native view had
 *    focus. Main resolved it and reports a SEMANTIC ACTION, which is republished
 *    on the local chord bus so every `useReservedChord` fires as it would for a
 *    real keystroke. Without this, every app shortcut and Escape handler is dead
 *    while the viewer has focus.
 *  - `onPopupRequested`: a page called `window.open`. It never gets a real window
 *    (that would carry the viewer's partition with none of its guards or
 *    occlusion handling), so the request arrives here and becomes another tab.
 *  - `onTabClosed`: main destroyed a view — a crash, an eviction, or session
 *    teardown. The strip has to follow, or it shows a tab with nothing behind it.
 *
 * See docs/proposals/native-web-viewer.md §3.6.
 */
import { useEffect } from 'react';
import { trpc } from '../trpc/client';
import { useCenterPaneStore } from '../stores/centerPaneStore';
import { openUserWebTab } from '../utils/openWebLink';
import { publishReservedChord } from './useReservedChord';

export function useWebViewerBridge(sessionKey: string | null): void {
  useEffect(() => {
    if (sessionKey === null || sessionKey.length === 0) return;
    let cancelled = false;

    // Rebuild the strip from the persisted rows. Main re-creates each tab
    // UNLOADED under its persisted id (grants, cursors and position survive);
    // it loads on first focus. Idempotent, so a remount is harmless.
    void trpc.cyboflow.webViewer.restore
      .mutate({ sessionId: sessionKey })
      .then((tabs) => {
        if (cancelled) return;
        const store = useCenterPaneStore.getState();
        for (const tab of tabs) {
          store.openWebTab(sessionKey, {
            id: tab.tabId,
            url: tab.initialUrl,
            ...(tab.currentUrl !== null ? { currentUrl: tab.currentUrl } : {}),
            ...(tab.title !== null && tab.title.length > 0 ? { label: tab.title } : {}),
            openedBy: tab.openedBy,
            ...(tab.openedByRunId !== null ? { openedByRunId: tab.openedByRunId } : {}),
            humanTouched: tab.humanTouched,
            focus: false,
            quiet: true,
          });
        }
      })
      .catch((err: unknown) => console.warn('[useWebViewerBridge] restore failed:', err));

    const chords = trpc.cyboflow.webViewer.onReservedChord.subscribe(
      { sessionId: sessionKey },
      {
        onData: (ev) => publishReservedChord(ev.action),
        onError: (err: unknown) =>
          console.warn('[useWebViewerBridge] onReservedChord error:', err),
      },
    );

    const popups = trpc.cyboflow.webViewer.onPopupRequested.subscribe(
      { sessionId: sessionKey },
      {
        onData: (ev) => {
          // A popup does NOT steal focus — the user did not ask for it.
          openUserWebTab(sessionKey, ev.url, { focus: false });
        },
        onError: (err: unknown) =>
          console.warn('[useWebViewerBridge] onPopupRequested error:', err),
      },
    );

    const closed = trpc.cyboflow.webViewer.onTabClosed.subscribe(
      { sessionId: sessionKey },
      {
        onData: (ev) => {
          // An EVICTION is not a close: the tab stays as a URL row and a focus
          // re-navigates it. Only a real teardown removes the strip entry.
          if (ev.reason === 'evicted') return;
          if (ev.reason === 'crashed') return;
          useCenterPaneStore.getState().closeTab(sessionKey, ev.tabId);
        },
        onError: (err: unknown) => console.warn('[useWebViewerBridge] onTabClosed error:', err),
      },
    );

    return () => {
      cancelled = true;
      chords.unsubscribe();
      popups.unsubscribe();
      closed.unsubscribe();
    };
  }, [sessionKey]);
}
