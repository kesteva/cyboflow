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

interface OnboardingCardProps {
  /** When true, the card returns null immediately (controlled dismiss). */
  dismissed?: boolean;
  /** Called when the user clicks "Got it". Parent should set dismissed=true. */
  onDismiss?: () => void;
}

/**
 * One-shot onboarding card for the Review Queue.
 *
 * Supports two modes:
 * - Uncontrolled (no props): manages its own dismissed state, reads the
 *   preference on mount, and writes it when "Got it" is clicked.
 * - Controlled (dismissed + onDismiss props): the parent owns the dismissed
 *   state; the card renders null when dismissed=true and calls onDismiss on
 *   "Got it". The parent is responsible for reading/writing the preference.
 *
 * ReviewQueueView uses the controlled mode so that the y/n keypress path can
 * also unmount the card within the same React render cycle.
 */
export default function OnboardingCard({ dismissed: dismissedProp, onDismiss }: OnboardingCardProps = {}): React.ReactElement | null {
  const isControlled = dismissedProp !== undefined;

  const [dismissedLocal, setDismissedLocal] = useState(false);
  const [checked, setChecked] = useState(isControlled); // In controlled mode, skip the async check.

  useEffect(() => {
    // In controlled mode the parent has already read the preference.
    if (isControlled) return;

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
          setDismissedLocal(true);
        }
      } catch {
        // Silently proceed — show card if the preference can't be read.
      } finally {
        setChecked(true);
      }
    })();
  }, [isControlled]);

  async function handleGotIt(): Promise<void> {
    if (isControlled) {
      onDismiss?.();
    } else {
      await dismissOnboarding();
      setDismissedLocal(true);
    }
  }

  const effectiveDismissed = isControlled ? (dismissedProp ?? false) : dismissedLocal;

  // Wait until the preference has been checked to avoid a flash of content.
  if (!checked || effectiveDismissed) {
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
