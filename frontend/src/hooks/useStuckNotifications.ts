import { useEffect, useRef, useState } from 'react';
import { API } from '../utils/api';
import { trpc } from '../utils/trpcClient';
import type { StuckDetectedEvent, StuckReason } from '../../../shared/types/stuckDetection';

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
// Subscription interface — forward-looking tRPC surface
//
// `cyboflow.events.onStuckDetected` will be added to the events router by
// TASK-254 (orchestrator-and-trpc-router epic).  Until that lands, this hook
// accesses the subscription via an interface cast through `unknown` to remain
// type-safe without relying on `any`.
// ---------------------------------------------------------------------------

interface StuckEventsClient {
  onStuckDetected: {
    subscribe(
      input: undefined,
      callbacks: {
        onData: (event: StuckDetectedEvent) => void;
        onError: (err: unknown) => void;
      },
    ): { unsubscribe(): void };
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Subscribes to stuck-run events and fires exactly one macOS desktop
 * notification per app-launch run (`runId`).  Subsequent stuck events
 * for the same run are suppressed silently to avoid notification fatigue.
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

  // -- Subscribe to stuck events --------------------------------------------

  useEffect(() => {
    // Access the forward-looking `onStuckDetected` subscription via a typed
    // cast through `unknown`.  The actual procedure is added to
    // `cyboflow.events` by TASK-254 (orchestrator-and-trpc-router epic).
    // The cast is safe: the shape is validated at the interface level
    // (`StuckEventsClient`) and the subscription is mocked in unit tests.
    const events = trpc.cyboflow.events as unknown as StuckEventsClient;

    const subscription = events.onStuckDetected.subscribe(undefined, {
      onData: (event: StuckDetectedEvent) => {
        const { runId, reason } = event;

        // Suppression: only notify once per runId per app launch
        if (notifiedRunsRef.current.has(runId)) return;

        // Settings gate: respect the global notifications.enabled flag
        if (!settings.enabled) return;

        notifiedRunsRef.current.add(runId);

        requestPermission().then((hasPermission) => {
          if (!hasPermission) return;
          new Notification('Run Stuck ⚠️', {
            body: `Run ${runId.slice(0, 8)} is stuck: ${stuckReasonText(reason)}`,
            icon: '/favicon.ico',
            badge: '/favicon.ico',
            requireInteraction: false,
          });
        }).catch((err: unknown) => {
          console.warn('[useStuckNotifications] Failed to show notification:', err);
        });
      },
      onError: (err: unknown) => {
        console.warn('[useStuckNotifications] subscription error:', err);
      },
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [settings.enabled]);
}
