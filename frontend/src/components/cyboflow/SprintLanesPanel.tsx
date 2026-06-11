/**
 * SprintLanesPanel — structured per-task "lanes" for a sprint run (feat/
 * parallel-sprint, single-run lane model), rendered in the run progress rail
 * under the WorkflowProgressTimeline.
 *
 * One row per seeded task: ref (falling back to the task id), title, a status
 * pill (queued / running / integrated / failed / blocked) and — while running —
 * the lane step the per-task subagent reported via cyboflow_update_sprint_task.
 * Live state comes from {@link useSprintLanes} (snapshot + onSprintLaneChanged
 * subscription). Renders NOTHING when the run carries no lanes (non-sprint
 * runs, or a sprint launched without seed tasks), so it can be mounted
 * unconditionally next to the timeline.
 */
import type { ReactElement } from 'react';
import { useSprintLanes } from '../../hooks/useSprintLanes';
import type {
  SprintBatchTaskStatus,
  SprintLaneStepId,
} from '../../../../shared/types/sprintBatch';

// ---------------------------------------------------------------------------
// Status pill + lane-step label maps
// ---------------------------------------------------------------------------

/**
 * Pill classes per lane status — same compact rounded-full pill convention as
 * TaskBatchPickerModal's "in flight" / "blocked" badges.
 */
const STATUS_PILL_CLASS: Readonly<Record<SprintBatchTaskStatus, string>> = {
  queued: 'bg-bg-tertiary text-text-tertiary',
  running: 'bg-interactive/15 text-interactive',
  integrated: 'bg-status-success/15 text-status-success',
  failed: 'bg-status-error/15 text-status-error',
  blocked: 'bg-status-warning/15 text-status-warning',
};

/** Human-readable labels for the fixed lane step vocabulary. */
const LANE_STEP_LABEL: Readonly<Record<SprintLaneStepId, string>> = {
  implement: 'Implement',
  'write-tests': 'Write tests',
  'code-review': 'Code review',
  'task-verify': 'Verify',
  'visual-verify': 'Visual verify',
};

/** Label for a reported lane step — falls back to the raw id for unknown values. */
function laneStepLabel(stepId: string): string {
  return (LANE_STEP_LABEL as Readonly<Record<string, string>>)[stepId] ?? stepId;
}

// ---------------------------------------------------------------------------
// SprintLanesPanel
// ---------------------------------------------------------------------------

export function SprintLanesPanel({ runId }: { runId: string | null }): ReactElement | null {
  const { lanes } = useSprintLanes(runId);

  // Non-sprint runs (and seed-less sprints) have no lanes — render nothing.
  if (lanes.length === 0) return null;

  return (
    <section
      data-testid="sprint-lanes"
      className="border-t border-border-primary p-3 text-xs text-text-primary"
    >
      {/* Section header — mirrors the timeline's phase-header typography. */}
      <div className="mb-2 flex items-center gap-2">
        <span className="font-bold text-text-primary" style={{ fontSize: '11px' }}>
          Tasks
        </span>
        <span className="ml-auto text-text-secondary">{lanes.length} tasks</span>
      </div>

      <div className="flex flex-col gap-1">
        {lanes.map((lane) => (
          <div
            key={lane.taskId}
            data-testid={`sprint-lane-${lane.taskId}`}
            className="flex flex-col gap-0.5 border-l-2 border-border-primary py-1 pl-3"
          >
            <div className="flex items-center gap-2">
              <span className="font-medium text-text-primary">{lane.ref ?? lane.taskId}</span>
              <span
                className={`ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${STATUS_PILL_CLASS[lane.status]}`}
              >
                {lane.status}
              </span>
            </div>
            {lane.title !== null && (
              <span className="truncate text-text-secondary" title={lane.title}>
                {lane.title}
              </span>
            )}
            {/* Current lane step — only meaningful while the subagent runs. */}
            {lane.status === 'running' && lane.currentStepId !== null && (
              <span className="text-text-tertiary">{laneStepLabel(lane.currentStepId)}</span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
