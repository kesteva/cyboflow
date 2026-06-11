/**
 * stepTransitionBridge — builds WorkflowStepTransitionEvent, writes
 * workflow_runs.current_step_id, and emits via stepTransitionEvents.
 *
 * Design notes:
 *  - Write-then-emit ordering: the DB UPDATE always precedes the emit so any
 *    subscriber reading workflow_runs sees a consistent current_step_id.
 *  - Missing workflow_runs row fallback: logs warn via the provided LoggerLike
 *    (or console.warn when no logger is available), does NOT throw.
 *  - stepId validation: buildStepTransitionEvent resolves the run's EFFECTIVE
 *    workflow definition (resolveWorkflowDefinition(name, spec_json) — the
 *    runtime source of truth that overrides the static WORKFLOW_DEFINITIONS
 *    seed) and rejects any stepId not present in its flat steps (warn, return
 *    null, no write, no emit). Any validated step id is accepted, not only the
 *    INITIAL_STEP_IDS entry; resolveInitialStepId remains the lifecycle
 *    fallback used by the index.ts StepTransitionEmitterLike adapter.
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', or any concrete service in main/src/services/*.
 */
import { stepTransitionEvents } from './trpc/routers/events';
import type { DatabaseLike, LoggerLike } from './types';
import type { CyboflowWorkflowName, WorkflowStepTransitionEvent } from '../../../shared/types/workflows';
import { CYBOFLOW_WORKFLOW_NAMES, resolveWorkflowDefinition } from '../../../shared/types/workflows';

export type { WorkflowStepTransitionEvent } from '../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// v1 step-id resolution
// ---------------------------------------------------------------------------

/**
 * Maps each CyboflowWorkflowName to its first step id (v1 single-step-per-
 * workflow model). At run start, current_step_id is set to this step so only
 * it shows "running" and everything after is "pending". When the run
 * terminates, getPhaseState and mergeTransition mark ALL steps as "done"
 * regardless of position.
 */
const INITIAL_STEP_IDS: Record<CyboflowWorkflowName, string> = {
  planner: 'context',
  sprint:  'analyze-dependencies',
} as const;

/**
 * Returns the stable initial step id for a given Cyboflow workflow name,
 * or null if the name is not a known CyboflowWorkflowName.
 *
 * When null, the caller MUST skip both the DB write and the emit.
 *
 * @param workflowName - The `workflows.name` value from the database row.
 */
export function resolveInitialStepId(workflowName: string): string | null {
  if ((CYBOFLOW_WORKFLOW_NAMES as readonly string[]).includes(workflowName)) {
    return INITIAL_STEP_IDS[workflowName as CyboflowWorkflowName];
  }
  return null;
}

// ---------------------------------------------------------------------------
// stepId validation (dynamic step-id model)
// ---------------------------------------------------------------------------

/**
 * Returns true iff `stepId` is present in the run's EFFECTIVE workflow
 * definition (post user-editable-workflows merge). The effective def is
 * resolved via `resolveWorkflowDefinition(workflowName, specJson)` — the
 * runtime source of truth that fully overrides the static
 * `WORKFLOW_DEFINITIONS` seed. Validating against the resolved def means an
 * edited/custom step id present only in `spec_json` is accepted, and a step id
 * removed by an edit is rejected.
 *
 * A `null` resolution (a custom flow whose `spec_json` is missing/broken) →
 * `false` (reject). Pure: no DB, no logger.
 *
 * @param workflowName - The `workflows.name` value from the database row.
 * @param specJson     - The `workflows.spec_json` value from the database row.
 * @param stepId       - The step id to validate.
 */
function isValidStepId(
  workflowName: string,
  specJson: string | null | undefined,
  stepId: string,
): boolean {
  const def = resolveWorkflowDefinition(workflowName, specJson);
  if (def === null) return false;
  return def.phases
    .flatMap((p) => p.steps)
    .map((s) => s.id)
    .includes(stepId);
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
 *                via resolveInitialStepId() before calling.
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

  // Resolve the run's workflow name + spec_json by JOIN on runId, then validate
  // the stepId against the run's EFFECTIVE definition (dynamic step-id model:
  // resolveWorkflowDefinition is the runtime source of truth, NOT the static
  // WORKFLOW_DEFINITIONS seed). This makes a typo / unknown / removed-by-edit
  // step id impossible to write — no UPDATE, no emit (FIND-SPRINT-024-4
  // silent-corruption class). Mirrors the JOIN in index.ts:599-604.
  const runRow = db
    .prepare(
      `SELECT w.name AS workflowName, w.spec_json AS specJson
       FROM workflow_runs r
       JOIN workflows w ON w.id = r.workflow_id
       WHERE r.id = ?`,
    )
    .get(runId) as { workflowName: string; specJson: string | null } | undefined;

  if (runRow === undefined) {
    const msg = `[stepTransitionBridge] No workflow_runs row found for runId=${runId} — skipping step transition emit`;
    if (logger) {
      logger.warn(msg, { runId, stepId, status });
    } else {
      console.warn(msg);
    }
    return null;
  }

  if (!isValidStepId(runRow.workflowName, runRow.specJson, stepId)) {
    const msg = `[stepTransitionBridge] Rejecting unknown stepId=${stepId} for runId=${runId} (workflow=${runRow.workflowName}) — no write/emit`;
    if (logger) {
      logger.warn(msg, { runId, stepId, status });
    } else {
      console.warn(msg);
    }
    return null;
  }

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
