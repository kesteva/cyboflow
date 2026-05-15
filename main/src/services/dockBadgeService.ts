/**
 * dockBadgeService — macOS dock badge management.
 *
 * Exposes a single `setBadgeCount` method that updates the macOS dock badge
 * to reflect the current number of pending approvals.
 *
 * Platform behaviour:
 *   - macOS: calls `app.dock.setBadge` with the count string, or '' to clear.
 *   - Other platforms: no-op (v1 is macOS-only, but the guard is explicit so
 *     the service can be imported safely on any platform in tests).
 *
 * Clamp rule: negative values are treated as 0 (badge cleared). This prevents
 * a stale decrement from showing a nonsensical negative badge.
 */
import { app } from 'electron';

export const dockBadgeService = {
  /**
   * Update the macOS dock badge to show `n` pending approvals.
   *
   * @param n - The count to display. Values < 0 are clamped to 0 (badge cleared).
   *            A value of 0 clears the badge (no dot or number shown in the dock).
   */
  setBadgeCount(n: number): void {
    const clamped = Math.max(0, n);
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setBadge(clamped === 0 ? '' : String(clamped));
    }
  },
};
