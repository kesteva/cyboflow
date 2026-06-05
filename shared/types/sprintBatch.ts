/**
 * Shared types for the parallel-sprint batch subsystem (feat/parallel-sprint).
 *
 * A "sprint batch" runs a set of tasks in parallel over ONE shared integration
 * branch with bounded concurrency and a single human review at finalize. These
 * row types + status unions are consumed by both the main process
 * (SprintBatchScheduler, migration 022) and the renderer (batch picker / progress
 * UI). Keep this file free of Node.js built-ins so it can be imported anywhere.
 */
import type { CliSubstrate } from './substrate';

/** Lifecycle state of a whole batch. Terminal: completed | failed | canceled. */
export type SprintBatchStatus =
  | 'planning'
  | 'running'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'canceled';

/**
 * Lifecycle of a single task's membership in a batch, independent of the global
 * board stage:
 *  - queued      — selected, not yet launched.
 *  - running     — a per-task run is in flight.
 *  - integrated  — the per-task run drained clean AND its branch merged into the
 *                  integration branch. This is the "satisfied" state for
 *                  dependency gating (NOT global board stage 9).
 *  - failed      — the per-task run failed OR its merge conflicted. Surfaced;
 *                  does not crash the batch.
 *  - blocked     — reserved: a task whose only prereq failed (not auto-set in
 *                  this phase; the scheduler leaves such a task `queued`).
 */
export type SprintBatchTaskStatus =
  | 'queued'
  | 'running'
  | 'integrated'
  | 'failed'
  | 'blocked';

/**
 * Terminal batch statuses — batches in these states cannot transition further.
 * Mirrors TERMINAL_RUN_STATUSES in shared/types/cyboflow.ts. The boot
 * rehydrator selects NON-terminal batches to resume.
 */
export const TERMINAL_BATCH_STATUSES = ['completed', 'failed', 'canceled'] as const;
export type TerminalBatchStatus = (typeof TERMINAL_BATCH_STATUSES)[number];

/**
 * Fixed parallel-agent concurrency. At most this many `task` runs execute
 * simultaneously, regardless of batch size or substrate.
 */
export const SPRINT_BATCH_CAP = 5;

/**
 * Soft selection cap N (the number of tasks a user may multi-select into one
 * batch), keyed by substrate. Protects context/host resources — NOT the
 * concurrency limit (that is SPRINT_BATCH_CAP).
 */
export const SPRINT_BATCH_MAX_TASKS: Readonly<Record<CliSubstrate, number>> = {
  sdk: 15,
  interactive: 10,
} as const;

/** Row shape of the `sprint_batches` table (migration 022). */
export interface SprintBatchRow {
  id: string;
  project_id: number;
  substrate: CliSubstrate;
  status: SprintBatchStatus;
  /** 'sprint/<id8>' — created off the project main branch at create. NULL only transiently. */
  integration_branch: string | null;
  /** Project main branch captured at create (triage). */
  base_branch: string | null;
  /** Integration branch start sha (triage). */
  base_sha: string | null;
  /** Bounded concurrency for this batch (defaults to SPRINT_BATCH_CAP). */
  concurrency: number;
  /** The single sprint-init run that drives dependency analysis (soft link). */
  init_run_id: string | null;
  /** The single sprint-finalize run (soft link). */
  finalize_run_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/** Row shape of the `sprint_batch_tasks` table (migration 022). */
export interface SprintBatchTaskRow {
  id: number;
  batch_id: string;
  task_id: string;
  status: SprintBatchTaskStatus;
  /** The per-task run currently/last executing this task (soft link). */
  run_id: string | null;
  /** Merge-conflict / run-fail detail when status='failed'. */
  error_message: string | null;
  integrated_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Read-model for batch progress (cyboflow.runs.batchProgress). A small
 * aggregate the picker / progress UI can poll without loading every row.
 */
export interface SprintBatchProgress {
  status: SprintBatchStatus;
  total: number;
  queued: number;
  running: number;
  integrated: number;
  failed: number;
}
