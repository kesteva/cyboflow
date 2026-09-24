/**
 * useWebViewBounds — keep the main-process `WebContentsView` positioned over the
 * renderer's bounds-anchor rect, and hide it when the tab is not showing.
 *
 * The native view paints ABOVE all DOM, so it is not laid out by the renderer at
 * all: the anchor is an empty div whose rect is measured here and pushed to main.
 * Measured with a ResizeObserver plus a scroll/resize listener, coalesced through
 * one rAF so a window drag or a panel resize does not fire a tRPC mutation per
 * frame.
 *
 * SCALING HAPPENS IN MAIN, not here: `setBounds` is DIP-relative while
 * `getBoundingClientRect` returns renderer CSS px, so main multiplies by the
 * window's `getZoomFactor()`. Deriving the factor here from `devicePixelRatio`
 * would be wrong — that is zoomFactor × display scaleFactor.
 *
 * See docs/proposals/native-web-viewer.md §3.6.
 */
import { useEffect, useRef, type RefObject } from 'react';
import { trpc } from '../trpc/client';

export interface UseWebViewBoundsOptions {
  tabId: string;
  /** The anchor element the native view is positioned over. */
  anchorRef: RefObject<HTMLElement | null>;
  /**
   * Whether the tab is the active one. False hides the view without unloading
   * it — the document, its JS context, its listeners and its telemetry stay
   * alive, because blanking a background tab would blank exactly the state an
   * agent reads it for.
   */
  active: boolean;
}

export function useWebViewBounds({ tabId, anchorRef, active }: UseWebViewBoundsOptions): void {
  // Last pushed rect, so an observer firing with identical numbers (common on
  // scroll) does not round-trip to main.
  const lastRef = useRef<string>('');

  useEffect(() => {
    void trpc.cyboflow.webViewer.setVisible.mutate({ tabId, visible: active }).catch(() => {
      /* the tab may have closed underneath us */
    });
    return () => {
      // UNMOUNT HIDES. Only the active tab's body is mounted, so an unmount means
      // the user switched tabs — and a native view left visible would keep
      // painting over whatever replaced it. Hiding is not unloading: the
      // document, its JS context and its telemetry stay alive.
      void trpc.cyboflow.webViewer.setVisible.mutate({ tabId, visible: false }).catch(() => {
        /* the tab may have closed underneath us */
      });
    };
  }, [tabId, active]);

  useEffect(() => {
    if (!active) return;
    const anchor = anchorRef.current;
    if (!anchor) return;

    let frame = 0;
    const push = (): void => {
      frame = 0;
      const rect = anchor.getBoundingClientRect();
      const bounds = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
      if (key === lastRef.current) return;
      lastRef.current = key;
      void trpc.cyboflow.webViewer.setBounds.mutate({ tabId, ...bounds }).catch(() => {
        /* the tab may have closed underneath us */
      });
    };
    const schedule = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(push);
    };

    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(anchor);
    window.addEventListener('resize', schedule);
    // Capture phase: a scroll in ANY ancestor moves the anchor, and scroll does
    // not bubble.
    window.addEventListener('scroll', schedule, true);

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      // Reset so a re-mount re-pushes rather than trusting a stale key.
      lastRef.current = '';
    };
  }, [tabId, anchorRef, active]);
}
