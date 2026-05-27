/**
 * stepTransitionBridge — builds WorkflowStepTransitionEvent, writes
 * workflow_runs.current_step_id, and emits via stepTransitionEvents.
 *
 * Design notes:
 *  - Write-then-emit ordering: the DB UPDATE always precedes the emit so any
 *    subscriber reading workflow_runs sees a consistent current_step_id.
 *  - Missing workflow_runs row fallback: logs warn via the provided LoggerLike
 *    (or console.warn when no logger is available), does NOT throw.
 *  - Uses a single-step-per-workflow model (v1): each named SoloFlow workflow
 *    maps to ONE representative step id. The executor emits 'running' at run
 *    start and 'done' at run end. The seam is designed to support MCP-tool-
 *    driven transitions in a future task.
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', or any concrete service in main/src/services/*.
 */
import { stepTransitionEvents } from './trpc/routers/events';
import type { DatabaseLike, LoggerLike } from './types';
import type { SoloFlowWorkflowName } from '../../../shared/types/workflows';
import { SOLOFLOW_WORKFLOW_NAMES } from '../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// WorkflowStepTransitionEvent
// ---------------------------------------------------------------------------

/**
 * Event payload emitted by stepTransitionEvents on the 'transition' channel.
 *
 * NOTE: shared/types/workflows.ts was extended with WorkflowStepState in
 * TASK-763 but WorkflowStepTransitionEvent was intentionally not added there
 * (it is an orchestrator-boundary type). Declared here per the TASK-765 plan's
 * Lowest Confidence Area note.
 */
export interface WorkflowStepTransitionEvent {
  /** The workflow_runs.id this transition belongs to. */
  runId: string;
  /** The step identifier (e.g. 'implement', 'extract' — bare WorkflowStep.id values). */
  stepId: string;
  /** New status of the step. */
  status: 'pending' | 'running' | 'done';
  /** ISO-8601 timestamp of the transition. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// v1 step-id resolution
// ---------------------------------------------------------------------------

/**
 * Maps each SoloFlowWorkflowName to its single representative step id (v1
 * single-step-per-workflow model). Step ids are bare WorkflowStep.id values
 * from WORKFLOW_DEFINITIONS — matching the lookup keys used by getPhaseState,
 * mergeTransition, and stepStatusMap.
 *
 * Mapping rationale:
 *  - soloflow  → implement  (execute phase primary step)
 *  - planner   → tasks      (main output of the planner workflow)
 *  - sprint    → implement  (per-task implementation step)
 *  - compound  → extract    (core learning-extraction step)
 *  - prune     → scan       (first meaningful pruner step)
 */
const TERMINAL_STEP_IDS: Record<SoloFlowWorkflowName, string> = {
  soloflow: 'implement',
  planner:  'tasks',
  sprint:   'implement',
  compound: 'extract',
  prune:    'scan',
} as const;

/**
 * Returns the stable terminal step id for a given SoloFlow workflow name,
 * or null if the name is not a known SoloFlowWorkflowName.
 *
 * When null, the caller MUST skip both the DB write and the emit.
 *
 * @param workflowName - The `workflows.name` value from the database row.
 */
export function resolveTerminalStepId(workflowName: string): string | null {
  if ((SOLOFLOW_WORKFLOW_NAMES as readonly string[]).includes(workflowName)) {
    return TERMINAL_STEP_IDS[workflowName as SoloFlowWorkflowName];
  }
  return null;
}

// ---------------------------------------------------------------------------
// buildStepTransitionEvent
// ---------------------------------------------------------------------------

/**
 * Build a WorkflowStepTransitionEvent, write current_step_id to workflow_runs,
 * and emit on stepTransitionEvents.
 *
 * Write-then-emit ordering is enforced: the parameterized UPDATE runs to
 * completion before emit() is called.
 *
 * Fail-soft contract:
 *  - If the workflow_runs row is missing, logs a warn via `logger` and returns
 *    without throwing.
 *  - If the UPDATE affects 0 rows (row vanished between resolve and write),
 *    logs a warn via `logger` and skips the emit.
 *
 * @param runId   The workflow_runs.id for the run being transitioned.
 * @param stepId  The step id to set as current_step_id. Caller resolves this
 *                via resolveTerminalStepId() before calling.
 * @param status  The new step status ('pending' | 'running' | 'done').
 * @param db      Narrow DatabaseLike interface.
 * @param logger  Optional LoggerLike for warn-level fallback logging.
 */
export function buildStepTransitionEvent(
  runId: string,
  stepId: string,
  status: WorkflowStepTransitionEvent['status'],
  db: DatabaseLike,
  logger?: LoggerLike,
): WorkflowStepTransitionEvent | null {
  const timestamp = new Date().toISOString();

  // Write current_step_id to DB BEFORE emitting (write-then-emit ordering).
  let changes = 0;
  try {
    const result = db
      .prepare('UPDATE workflow_runs SET current_step_id = ? WHERE id = ?')
      .run(stepId, runId);
    changes = result.changes;
  } catch (err) {
    const msg = `[stepTransitionBridge] DB UPDATE threw for runId=${runId}: ${err}`;
    if (logger) {
      logger.warn(msg, { runId, stepId, status });
    } else {
      console.warn(msg);
    }
    return null;
  }

  if (changes === 0) {
    const msg = `[stepTransitionBridge] No workflow_runs row found for runId=${runId} — skipping step transition emit`;
    if (logger) {
      logger.warn(msg, { runId, stepId, status });
    } else {
      console.warn(msg);
    }
    return null;
  }

  const event: WorkflowStepTransitionEvent = { runId, stepId, status, timestamp };

  // Emit AFTER the DB write completes.
  stepTransitionEvents.emit('transition', event);

  return event;
}
