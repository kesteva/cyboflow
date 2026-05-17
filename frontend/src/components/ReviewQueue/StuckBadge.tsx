/**
 * StuckBadge — pill indicator rendered on PendingApprovalCard when
 * the underlying workflow run has transitioned to status = 'stuck'.
 *
 * Renders the literal text "STUCK" inside a red pill. When a `reason`
 * string is supplied (serialized StuckReason JSON or a human-readable
 * label) it is surfaced as the native HTML `title` tooltip so the user
 * can hover/long-press to read why the run was classified stuck.
 *
 * TASK-502 — stuck-detection-and-observability epic.
 */
import React from 'react';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface StuckBadgeProps {
  /**
   * Optional human-readable description of why the run is stuck.
   * Rendered as a native tooltip (title attribute) on the pill element.
   * When null or undefined, no tooltip is shown.
   */
  reason?: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Pill badge rendering the text "STUCK" in red.
 *
 * Composes cleanly alongside the "Why stuck?" button (TASK-504) — both
 * live inside the flex header row of PendingApprovalCard's CardChrome.
 *
 * Visual spec: small, bold, red background, white text, rounded corners.
 * Uses Tailwind utility classes (no inline styles) as required by TASK-502
 * acceptance criteria.
 */
export function StuckBadge({ reason }: StuckBadgeProps): React.ReactElement {
  return (
    <span
      title={reason ?? undefined}
      className="ml-1 inline-flex items-center px-1.5 py-0.5 text-xs font-bold tracking-wide text-white bg-red-600 rounded"
    >
      STUCK
    </span>
  );
}
