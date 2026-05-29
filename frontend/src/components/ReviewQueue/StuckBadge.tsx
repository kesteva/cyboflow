/**
 * StuckBadge — pill indicator rendered on PendingApprovalCard when
 * the underlying workflow run has transitioned to status = 'stuck'.
 *
 * Renders the literal text "STUCK" inside a red pill. When a `reason`
 * string is supplied (serialized StuckReason JSON or a human-readable
 * label) it is surfaced as the native HTML `title` tooltip so the user
 * can hover/long-press to read why the run was classified stuck.
 *
 * When `detectedAt` (Unix epoch ms) is also supplied, a relative-time
 * suffix (e.g. "· 2m") is appended to the tooltip to indicate how long
 * the run has been stuck.
 *
 * TASK-502, TASK-624 — stuck-detection-and-observability epic.
 */
import React from 'react';
import { formatAge } from '../../utils/approvalFormatters';

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
  /**
   * Unix epoch milliseconds when the run was classified stuck.
   * When provided, appended to the native title attribute as a relative-time
   * suffix (e.g. "cross_run_deadlock · 2m") so the user can hover to see
   * both the reason and how long the run has been stuck.
   */
  detectedAt?: number;
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
export function StuckBadge({ reason, detectedAt }: StuckBadgeProps): React.ReactElement {
  const baseTitle = reason ?? undefined;
  const suffix = detectedAt !== undefined ? formatAge(new Date(detectedAt).toISOString()) : undefined;
  const title = baseTitle && suffix ? `${baseTitle} · ${suffix}` : (baseTitle ?? suffix);

  return (
    <span
      title={title}
      className="ml-1 inline-flex items-center px-1.5 py-0.5 text-xs font-bold tracking-wide text-white bg-status-error rounded"
    >
      STUCK
    </span>
  );
}
