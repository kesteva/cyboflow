/**
 * Shared types for the parallel-sprint lane subsystem (feat/parallel-sprint).
 *
 * A "sprint batch" is the lane substrate for ONE session-hosted `sprint` run
 * seeded with N tasks: the sprint ORCHESTRATOR AGENT fans out per-task
 * subagents with bounded concurrency in the shared session worktree, and each
 * task's progress is a "lane" — a `sprint_batch_tasks` row (migration 022)
 * written through the `SprintLaneStore` chokepoint (driven by the
 * `cyboflow_update_sprint_task` MCP tool). These row types + status unions are
 * consumed by both the main process (SprintLaneStore, migration 022) and the
 * renderer (batch picker / lane progress UI). Keep this file free of Node.js
 * built-ins so it can be imported anywhere.
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
 * Lifecycle of a single task's lane within a batch, independent of the global
 * board stage:
 *  - queued      — selected, not yet picked up by a subagent.
 *  - running     — a per-task subagent is in flight.
 *  - integrated  — the task is COMPLETE AND COMMITTED in the shared session
 *                  worktree. (Historically: merged into a per-batch
 *                  integration branch; there is no per-task branch/merge in
 *                  the single-run model.) This is the "satisfied" state for
 *                  dependency gating (NOT global board stage 9).
 *  - failed      — the per-task subagent failed. Surfaced; does not crash the
 *                  sprint.
 *  - blocked     — a task whose prereq failed; the orchestrator skips it.
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
 * Fixed parallel-agent concurrency. At most this many per-task subagents
 * execute simultaneously, regardless of batch size or substrate.
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
  /** Legacy scheduler-model column — always NULL in the single-run lane model (the sprint executes in the session worktree; merge to main is the normal session Merge close-out). */
  integration_branch: string | null;
  /** Project main branch captured at create (triage). */
  base_branch: string | null;
  /** Integration branch start sha (triage). */
  base_sha: string | null;
  /** Bounded concurrency for this batch (defaults to SPRINT_BATCH_CAP). */
  concurrency: number;
  /** Legacy scheduler-model column (sprint-init run soft link) — always NULL in the single-run lane model. */
  init_run_id: string | null;
  /** Legacy scheduler-model column (sprint-finalize run soft link) — always NULL in the single-run lane model. */
  finalize_run_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/** Row shape of the `sprint_batch_tasks` table (migrations 022 + 023 + 025). */
export interface SprintBatchTaskRow {
  id: number;
  batch_id: string;
  task_id: string;
  status: SprintBatchTaskStatus;
  /** Legacy scheduler-model column (per-task run soft link) — always NULL in the single-run lane model. */
  run_id: string | null;
  /** Subagent-fail detail when status='failed'. */
  error_message: string | null;
  integrated_at: string | null;
  /** The lane step the per-task subagent is currently on (migration 023) — a SprintLaneStepId, or NULL before the first cyboflow_update_sprint_task report. */
  current_step_id: string | null;
  /**
   * Implement→verify retry counter (migration 025). 0 = first pass (render
   * nothing); the orchestrator reports attempt N (2, 3, ...) when it
   * RE-delegates implement after a task-verify FAIL or blocking review defect.
   */
  attempts: number;
  created_at: string;
  updated_at: string;
}

// ─── Lane step vocabulary + lane read-model ──────────────────────────────────

/**
 * The fixed per-task lane step vocabulary the sprint orchestrator's subagents
 * report through `cyboflow_update_sprint_task` (`current_step` enum). These
 * are LANE steps inside the single 'execute-tasks' workflow step — NOT
 * workflow step ids — and mirror the historical per-task sprint pipeline.
 */
export const SPRINT_LANE_STEP_IDS = [
  'implement',
  'write-tests',
  'code-review',
  'task-verify',
  'visual-verify',
] as const;
export type SprintLaneStepId = (typeof SPRINT_LANE_STEP_IDS)[number];

/**
 * Read-model for a single task lane (SprintLaneStore.listLanes /
 * cyboflow.runs.listLanes). `ref`/`title` are resolved fail-soft from the
 * `tasks` table (NULL when the task row is missing).
 */
export interface SprintLaneRow {
  batchId: string;
  taskId: string;
  status: SprintBatchTaskStatus;
  currentStepId: string | null;
  ref: string | null;
  title: string | null;
  /**
   * Implement→verify retry counter (migration 025). 0 = first pass (the UI
   * renders nothing); the orchestrator reports attempt N (2, 3, ...) when it
   * RE-delegates implement after a task-verify FAIL or blocking review defect.
   * UI: a running lane with attempts >= 2 shows the dashed loop edge
   * ("ATTEMPT n/3"); integrated with >= 2 shows "n attempts"; failed shows
   * "3/3 failed".
   */
  attempts: number;
  /**
   * Display refs (task ref, falling back to the raw task id) of this lane's
   * IN-BATCH blocking prerequisites (task_dependencies kind='blocking') whose
   * own lane in the SAME batch is not yet 'integrated'; [] when none.
   * Computed on read in listLanes — NOT stored.
   */
  blockedByRefs: string[];
  updatedAt: string;
}

/**
 * Event payload emitted by sprintLaneEvents on the per-run
 * `sprint-lane-<runId>` channel after every lane write. Consumed by the tRPC
 * lane subscription and the run progress rail.
 */
export interface SprintLaneChangedEvent {
  runId: string;
  batchId: string;
  taskId: string;
  status: SprintBatchTaskStatus;
  currentStepId: string | null;
  /** The lane's current attempts counter (see SprintLaneRow.attempts). */
  attempts: number;
  timestamp: string;
}
