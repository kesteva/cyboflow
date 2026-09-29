/**
 * Occlusion counter — the single signal that hides every native web view.
 *
 * A `WebContentsView` is composited by main ABOVE all renderer DOM, so no
 * z-index can put a modal, dropdown or context menu over it: the overlay paints
 * behind the page, or is unclickable where the page covers it. The only cure is
 * to take the view off screen while anything overlays the app. This counter is
 * that "anything": each overlay holds a lease while open, and the viewer hides
 * while the count is non-zero.
 *
 * It is a count, not a boolean, because overlays nest (Settings → a tracker
 * dialog → a confirm) and each closes independently. Leases, not bare
 * increment/decrement, because an unbalanced decrement from a double cleanup
 * would un-hide the view under a still-open modal — a release is idempotent.
 *
 * A resize drag also holds a lease: the native view swallows mouse events once
 * the cursor crosses it, so a drag that passes over the page would lose its
 * `mouseup` and stay stuck resizing.
 *
 * See docs/proposals/native-web-viewer.md §3.7.
 */

type Listener = () => void;

const leases = new Set<symbol>();
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Take an occlusion lease. Returns its release; calling the release more than
 * once is a no-op.
 */
export function acquireOcclusion(reason = 'overlay'): () => void {
  const lease = Symbol(reason);
  leases.add(lease);
  if (leases.size === 1) notify();
  return () => {
    if (!leases.delete(lease)) return;
    if (leases.size === 0) notify();
  };
}

export function isOccluded(): boolean {
  return leases.size > 0;
}

export function getOcclusionCount(): number {
  return leases.size;
}

/** Subscribe to occluded/unoccluded transitions (not every count change). */
export function subscribeOcclusion(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: drop every lease without notifying. */
export function resetOcclusionForTests(): void {
  leases.clear();
}
