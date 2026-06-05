/**
 * Pure home-classification + phase-stepper helpers for the landing experience.
 *
 * No React, no I/O — every function is deterministic given its inputs (the
 * caller supplies wall-clock `nowMs` so elapsed formatting stays testable).
 */

import type { WorkflowRunStatus } from '../../../shared/types/cyboflow';
import type { WorkflowDefinition } from '../../../shared/types/workflows';

/**
 * Coarse run-activity bucket used by the home/landing surfaces.
 *
 * - `active`   — the run is queued or making progress.
 * - `blocked`  — the run needs a human (review/input) or is stuck.
 * - `terminal` — the run is finished (completed/failed/canceled).
 */
export type RunActivity = 'blocked' | 'active' | 'terminal';

/**
 * Map a raw {@link WorkflowRunStatus} to its coarse {@link RunActivity} bucket.
 */
export function classifyRun(status: WorkflowRunStatus): RunActivity {
  switch (status) {
    case 'queued':
    case 'starting':
    case 'running':
      return 'active';
    case 'awaiting_review':
    case 'stuck':
    case 'awaiting_input':
      return 'blocked';
    case 'completed':
    case 'failed':
    case 'canceled':
      return 'terminal';
  }
}

/**
 * Top-level state the landing page renders, derived from project/run signals.
 *
 * - `empty`     — no projects yet.
 * - `reviews`   — something is waiting for the user (highest priority once projects exist).
 * - `some-idle` — work is in flight but some runs are idle.
 * - `all-active`— work is in flight and nothing is idle.
 * - `caught-up` — projects exist but nothing is active (incl. no runs at all).
 */
export type HomeState = 'empty' | 'reviews' | 'caught-up' | 'some-idle' | 'all-active';

/**
 * Derive the {@link HomeState} from the aggregate landing signals.
 *
 * Priority: no projects -> `empty`; else pending reviews -> `reviews`; else the
 * active/idle split decides `some-idle` / `all-active`; otherwise `caught-up`.
 */
export function deriveHomeState(input: {
  projectsCount: number;
  reviewsExist: boolean;
  anyActive: boolean;
  anyIdle: boolean;
}): HomeState {
  if (input.projectsCount === 0) return 'empty';
  if (input.reviewsExist) return 'reviews';
  if (input.anyActive && input.anyIdle) return 'some-idle';
  if (input.anyActive && !input.anyIdle) return 'all-active';
  return 'caught-up';
}

/**
 * Format the elapsed time between `startedAt` and `nowMs` as a compact label.
 *
 * Examples: `'12s'`, `'6m 36s'`, `'1h 12m'`. Returns `'—'` when `startedAt` is
 * `null` or cannot be parsed into a finite timestamp. `nowMs` is the current
 * epoch-millisecond time supplied by the caller (kept as a parameter so callers
 * can drive a deterministic, testable clock).
 */
export function formatElapsed(startedAt: string | null, nowMs: number): string {
  if (startedAt === null) return '—';

  const startMs = new Date(startedAt).getTime();
  if (Number.isNaN(startMs)) return '—';

  const elapsedMs = Math.max(0, nowMs - startMs);
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * One fill segment of the phase stepper — a single phase rendered as a bar.
 *
 * `color` is the LITERAL phase hex from the workflow definition (consumers set
 * it via inline style, never a token). `filled` is true up to and including the
 * current phase; `current` marks exactly the phase containing the active step.
 */
export interface PhaseFillSegment {
  phaseId: string;
  label: string;
  color: string;
  filled: boolean;
  current: boolean;
}

/**
 * Build the ordered phase-fill segments for the stepper.
 *
 * The current phase is the one whose steps include `currentStepId`. When no
 * phase matches (or `currentStepId` is null) the current index is `-1`, so
 * nothing is filled. Returns `[]` when `definition` is null.
 */
export function derivePhaseFill(
  definition: WorkflowDefinition | null,
  currentStepId: string | null,
): PhaseFillSegment[] {
  if (definition === null) return [];

  const currentIndex =
    currentStepId === null
      ? -1
      : definition.phases.findIndex((phase) =>
          phase.steps.some((step) => step.id === currentStepId),
        );

  return definition.phases.map((phase, index) => ({
    phaseId: phase.id,
    label: phase.label,
    color: phase.color,
    filled: index <= currentIndex,
    current: index === currentIndex,
  }));
}
