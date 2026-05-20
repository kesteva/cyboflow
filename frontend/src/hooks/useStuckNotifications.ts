import { useEffect, useRef, useState } from 'react';
import { API } from '../utils/api';
import { useReviewQueueSlice } from '../stores/reviewQueueSlice';
import type { StuckReason } from '../../../shared/types/stuckDetection';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NotificationSettings {
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map each `StuckReason` variant to a short human-readable string shown
 * in the notification body.
 */
export function stuckReasonText(reason: StuckReason): string {
  switch (reason.kind) {
    case 'self_deadlock': return 'self-deadlock';
    case 'cross_run_deadlock': return 'cross-run deadlock';
    case 'orphan_pty': return 'Claude process exited';
    case 'stale_socket': return 'permission socket disconnected';
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Observes `useReviewQueueSlice.runStatusMap` for transitions into `'stuck'`
 * and fires exactly one macOS desktop notification per `runId` per app launch.
 * The slice owns the tRPC subscription; this hook is a downstream observer.
 *
 * Mounted exactly once at the `App` top level — never inside a view component
 * so the suppression set is never reset by a view unmount.
 *
 * Gated by the `notifications.enabled` flag from the global config; if the
 * user has disabled notifications, stuck notifications are also suppressed.
 *
 * The suppression set lives in a `useRef` (in-memory only).  It does NOT
 * persist to `localStorage` / `sessionStorage` — a fresh app launch resets
 * the set so the user sees at least one stuck notification per restart.
 */
export function useStuckNotifications(): void {
  /** Runs that have already triggered a notification this app launch. */
  const notifiedRunsRef = useRef<Set<string>>(new Set());

  const [settings, setSettings] = useState<NotificationSettings>({
    enabled: true,
  });

  // -- Permission helper ----------------------------------------------------

  const requestPermission = (): Promise<boolean> => {
    if (!('Notification' in window)) return Promise.resolve(false);
    if (Notification.permission === 'granted') return Promise.resolve(true);
    if (Notification.permission === 'denied') return Promise.resolve(false);
    return Notification.requestPermission().then((p) => p === 'granted');
  };

  // -- Load notification settings on first mount ----------------------------

  useEffect(() => {
    API.config.get().then((response) => {
      if (response.success && response.data?.notifications) {
        const notifSettings = response.data.notifications as { enabled: boolean };
        setSettings({ enabled: notifSettings.enabled });
      }
    }).catch((err: unknown) => {
      console.warn('[useStuckNotifications] Failed to load notification settings:', err);
    });

    requestPermission();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: runs once on mount only
  }, []);

  // -- Observe slice runStatusMap for stuck transitions ---------------------

  useEffect(() => {
    // Snapshot of runIds we have seen as stuck — used to detect transitions
    // (a runId entering the map at 'stuck' or moving from non-stuck → 'stuck').
    // Initialize from current state so a stuck entry already present at mount
    // does NOT immediately re-fire — first-real-transition semantics.
    const prevStuck = new Set<string>(
      Object.entries(useReviewQueueSlice.getState().runStatusMap)
        .filter(([, status]) => status === 'stuck')
        .map(([runId]) => runId),
    );

    const unsubscribe = useReviewQueueSlice.subscribe((state) => {
      for (const [runId, status] of Object.entries(state.runStatusMap)) {
        if (status !== 'stuck') continue;
        if (prevStuck.has(runId)) continue;
        prevStuck.add(runId);

        // Per-app-launch suppression
        if (notifiedRunsRef.current.has(runId)) continue;
        if (!settings.enabled) continue;
        notifiedRunsRef.current.add(runId);

        const reason = state.runReasonMap[runId];
        requestPermission().then((hasPermission) => {
          if (!hasPermission) return;
          new Notification('Run Stuck ⚠️', {
            body: reason
              ? `Run ${runId.slice(0, 8)} is stuck: ${stuckReasonText(reason)}`
              : `Run ${runId.slice(0, 8)} is stuck`,
            icon: '/favicon.ico',
            badge: '/favicon.ico',
            requireInteraction: false,
          });
        }).catch((err: unknown) => {
          console.warn('[useStuckNotifications] Failed to show notification:', err);
        });
      }
    });

    return unsubscribe;
  }, [settings.enabled]);
}
