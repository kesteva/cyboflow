import type { RunEvalBand } from '../../../../shared/types/insights';

/**
 * Pure presentation helpers for the WorkflowSummaryPanel Score-summary module.
 * Kept separate from the component so the band/gate/runtime mappings are unit
 * testable without rendering (the panel's own tests mock tRPC).
 */

/** How many rubric dimensions the checklist defines (the "N / 7" denominator). */
export const RUBRIC_DIMENSION_COUNT = 7;

export interface BandDisplay {
  /** Uppercased band word shown as the hero label. */
  label: string;
  /** Tailwind text-color token for the band. */
  textClass: string;
  /** Tailwind bg-color token (for the CI marker / accents). */
  bgClass: string;
}

/**
 * Band → design-token mapping. Excellent/Good both read as positive (green),
 * Fair as caution (amber), Poor as error (red) — matching the approved mock-up,
 * which colors both Excellent and Good green. Uses the app's status tokens — no
 * raw hex — so it tracks the active theme. `label` is UPPERCASE for the hero;
 * the title-case band word is the `RunEvalBand` value itself.
 */
export function bandDisplay(band: RunEvalBand): BandDisplay {
  switch (band) {
    case 'Excellent':
      return { label: 'EXCELLENT', textClass: 'text-status-success', bgClass: 'bg-status-success' };
    case 'Good':
      return { label: 'GOOD', textClass: 'text-status-success', bgClass: 'bg-status-success' };
    case 'Fair':
      return { label: 'FAIR', textClass: 'text-status-warning', bgClass: 'bg-status-warning' };
    case 'Poor':
      return { label: 'POOR', textClass: 'text-status-error', bgClass: 'bg-status-error' };
  }
}

/**
 * Derive a band from a single 0-100 dimension score. The backend hands us an
 * overall `band` but per-dimension rows carry only a numeric `score`, so the
 * breakdown derives each dimension's band word/color here. Thresholds mirror the
 * mock-up's worked example (90→Excellent, 71-89→Good, 68→Fair): ≥90 Excellent,
 * ≥70 Good, ≥50 Fair, else Poor.
 */
export function scoreToBand(score: number): RunEvalBand {
  if (score >= 90) return 'Excellent';
  if (score >= 70) return 'Good';
  if (score >= 50) return 'Fair';
  return 'Poor';
}

/** Finding severity → the mock-up's action-oriented chip label. */
export const FINDING_SEVERITY_LABEL: Record<'info' | 'warning' | 'error', string> = {
  error: 'MUST-FIX',
  warning: 'GUIDELINE',
  info: 'NIT',
};

export type GateStatus = 'pass' | 'fail' | 'unknown';

/**
 * Coerce a single gate result (from the eval's `gateResults` blob) into a
 * pass/fail/unknown chip state. No deterministic gate artifact exists today for
 * orchestrated runs, so most values arrive missing → 'unknown'. Accepts the
 * shapes the worker might emit: boolean, a string verdict, or an object whose
 * `status`/`outcome`/`passed` field carries the verdict.
 */
export function gateStatus(value: unknown): GateStatus {
  if (value === undefined || value === null) return 'unknown';
  if (typeof value === 'boolean') return value ? 'pass' : 'fail';
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'pass' || v === 'passed' || v === 'ok' || v === 'success') return 'pass';
    if (v === 'fail' || v === 'failed' || v === 'error') return 'fail';
    return 'unknown';
  }
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if ('passed' in rec) return gateStatus(rec.passed);
    if ('status' in rec) return gateStatus(rec.status);
    if ('outcome' in rec) return gateStatus(rec.outcome);
  }
  return 'unknown';
}

/** The four deterministic gates the rubric names, in display order. */
export const GATE_KEYS = ['build', 'test', 'typecheck', 'lint'] as const;
export type GateKey = (typeof GATE_KEYS)[number];

/**
 * Elapsed runtime as a compact 'Xm Ys' (or 'Ys' under a minute). Returns null
 * when the run has no start stamp. While `endedAt` is still null (the panel is
 * mounted at awaiting_review before close-out), elapsed is measured to `now`.
 */
export function formatRuntime(
  startedAt: string | null,
  endedAt: string | null,
  now: number = Date.now(),
): string | null {
  if (startedAt === null) return null;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  const endMs = endedAt === null ? now : Date.parse(endedAt);
  const end = Number.isNaN(endMs) ? now : endMs;
  const totalSec = Math.max(0, Math.round((end - start) / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
