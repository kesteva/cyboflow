import React, { useState, useEffect } from 'react';

// Type for IPC response
interface IPCResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Writes the onboarding-dismissed preference via IPC.
 * Exported so ReviewQueueView can call it on the user's first approve/reject.
 */
export async function dismissOnboarding(): Promise<void> {
  if (window.electron?.invoke) {
    await window.electron.invoke('preferences:set', 'cyboflow_onboarding_dismissed', 'true');
  }
}

/**
 * One-shot onboarding card for the Review Queue.
 *
 * On mount, reads cyboflow_onboarding_dismissed from user_preferences.
 * If already 'true', renders nothing (short-circuits).
 * Otherwise renders a welcome card with a "Got it" button that persists
 * the dismissal and unmounts the card.
 */
export default function OnboardingCard(): React.ReactElement | null {
  const [dismissed, setDismissed] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const electronInvoke = window.electron?.invoke;
    if (!electronInvoke) {
      setChecked(true);
      return;
    }
    void (async () => {
      try {
        const result = (await electronInvoke(
          'preferences:get',
          'cyboflow_onboarding_dismissed',
        )) as IPCResponse<string>;
        if (result?.data === 'true') {
          setDismissed(true);
        }
      } catch {
        // Silently proceed — show card if the preference can't be read.
      } finally {
        setChecked(true);
      }
    })();
  }, []);

  async function handleGotIt(): Promise<void> {
    await dismissOnboarding();
    setDismissed(true);
  }

  // Wait until the preference has been checked to avoid a flash of content.
  if (!checked || dismissed) {
    return null;
  }

  return (
    <div
      role="status"
      className="mx-3 mt-3 mb-1 rounded-lg border border-border-primary bg-bg-tertiary px-4 py-3 text-sm"
    >
      <p className="font-semibold text-text-primary mb-1">Welcome to Cyboflow</p>
      <p className="text-text-secondary mb-1">
        Cyboflow pauses Claude when it needs to take an action. Approve or reject in this queue.
      </p>
      <p className="text-xs text-text-muted mb-3">
        Keyboard: j/k navigate, y/n decide
      </p>
      <button
        onClick={() => void handleGotIt()}
        className="text-xs font-medium text-interactive hover:text-interactive-active"
      >
        Got it
      </button>
    </div>
  );
}
