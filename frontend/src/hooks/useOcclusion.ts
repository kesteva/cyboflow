/**
 * React bindings for the occlusion counter (utils/occlusion.ts).
 *
 * `useOcclusion(open)` — every overlay that can paint over the center pane calls
 * this with its own open flag; the lease is held exactly while `open` is true
 * and released on close or unmount.
 *
 * `useIsOccluded()` — read side, used by the web viewer to hide its native view.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { acquireOcclusion, isOccluded, subscribeOcclusion } from '../utils/occlusion';

export function useOcclusion(open: boolean, reason?: string): void {
  useEffect(() => {
    if (!open) return;
    return acquireOcclusion(reason);
  }, [open, reason]);
}

export function useIsOccluded(): boolean {
  return useSyncExternalStore(subscribeOcclusion, isOccluded, isOccluded);
}
