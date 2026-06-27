/**
 * SprintSwimlaneCanvas — center-pane "swim lanes" canvas for a parallel sprint
 * run (feat/parallel-sprint, single-run lane model).
 *
 * Replaces WorkflowCanvas for runs that carry a non-null batch_id. Three
 * columns in the canvas plane:
 *   LEFT   — one collapsed card for the plan phase (testid swimlane-plan).
 *   CENTER — "EXECUTE / PARALLEL ×N" header + one lane per seeded task
 *            (testid swimlane-lane-<taskId>): lane header (status dot + ref +
 *            title + context label + chip), five step cards from
 *            SPRINT_LANE_STEP_IDS, and a dashed "ATTEMPT n/3" loop edge when
 *            the orchestrator re-delegated implement (attempts >= 2).
 *   RIGHT  — "SPRINT REVIEW" + the verify phase's step cards (reusing
 *            WorkflowStepCard, so human-review keeps the human-gate badge) +
 *            the merge-gate bar (testid swimlane-merge-gate).
 *
 * Lane chip mapping (contract #6): integrated → MERGED; running → RUNNING;
 * failed → ESCALATED (failed lanes surface at the human gate by design);
 * blocked OR (queued AND blockedByRefs.length > 0) → BLOCKED "waiting on
 * <refs>"; queued otherwise → QUEUED "waiting for worker slot".
 *
 * Live state: lanes stream via useSprintLanes (snapshot + onSprintLaneChanged);
 * workflow step/phase state arrives via the passed phaseState — no new
 * subscriptions. Visual language reuses WorkflowCanvas / WorkflowStepCard
 * (paper tokens, done-check, running outline, dotted-grid backdrop).
 */
import { useSprintLanes } from '../../hooks/useSprintLanes';
import type { SprintLane } from '../../hooks/useSprintLanes';
import type { UseWorkflowPhaseStateResult } from '../../hooks/useWorkflowPhaseState';
import type { WorkflowDefinition } from '../../../../shared/types/workflows';
import { WorkflowStepCard } from './WorkflowStepCard';
import type { StepStatus } from './WorkflowStepCard';
import {
  SPRINT_LANE_STEP_IDS,
  SPRINT_BATCH_CAP,
} from '../../../../shared/types/sprintBatch';
import type { SprintLaneStepId } from '../../../../shared/types/sprintBatch';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SprintSwimlaneCanvasProps {
  /** The sprint run's workflow_runs.id — drives useSprintLanes. */
  runId: string;
  /** Live workflow phase state (same object WorkflowCanvas receives). */
  phaseState: UseWorkflowPhaseStateResult;
  /** The run's raw lifecycle status (activeRun.status) for the summary row. */
  sprintStatus?: string;
}

/** Per-lane step visual state — 'failed' styles the current step of a failed lane. */
type LaneStepStatus = 'pending' | 'running' | 'done' | 'failed';

/** Chip vocabulary per contract #6. */
type LaneChip = 'MERGED' | 'RUNNING' | 'ESCALATED' | 'BLOCKED' | 'QUEUED';

// ---------------------------------------------------------------------------
// Lane derivation helpers
// ---------------------------------------------------------------------------

/** Short labels for the fixed lane step vocabulary (design: "VIS" is optional). */
const LANE_STEP_SHORT_LABEL: Readonly<Record<SprintLaneStepId, string>> = {
  implement: 'Implement',
  'write-tests': 'Write tests',
  'code-review': 'Code review',
  'task-verify': 'Verify',
  'visual-verify': 'Visual check',
  // The visual merge-gate park step — not a strip column (the sprint strip derives
  // from the 5 fanOut inner ids), but the vocabulary map must be total.
  'awaiting-verify': 'Awaiting verify',
};

/** One column of the lane step strip — id (lane currentStepId vocabulary) + label. */
interface LaneStepColumn {
  id: string;
  label: string;
  optional: boolean;
}

/**
 * Derives the lane step strip (ids + labels) from the active workflow definition.
 *
 * Generalizes the fixed SPRINT_LANE_STEP_IDS strip to any fanOut step: scans the
 * definition's phases for the FIRST step that declares `fanOut` and maps its
 * `inner` chain to columns (label = inner.name ?? inner.id; optional from the
 * inner step). When no fanOut step is present (e.g. an orchestrated/legacy def or
 * a null definition) it falls back to SPRINT_LANE_STEP_IDS with the canonical
 * short labels — so the sprint flow renders byte-identically.
 */
function laneStepIdsFor(definition: WorkflowDefinition | null): LaneStepColumn[] {
  const fanOutStep = definition?.phases
    .flatMap((p) => p.steps)
    .find((s) => s.fanOut !== undefined);
  if (fanOutStep?.fanOut !== undefined) {
    return fanOutStep.fanOut.inner.map((inner) => ({
      id: inner.id,
      label: inner.name ?? inner.id,
      optional: inner.optional === true,
    }));
  }
  return SPRINT_LANE_STEP_IDS.map((id) => ({
    id,
    label: LANE_STEP_SHORT_LABEL[id],
    optional: id === 'visual-verify',
  }));
}

/**
 * Derives the five per-step states from the lane:
 *   integrated      → all done;
 *   running/failed  → steps before current_step_id done, current = running
 *                     (failed styling on a failed lane), after pending;
 *   queued/blocked  → all pending (also when current_step_id is null/unknown).
 */
function laneStepStatuses(lane: SprintLane, stepIds: readonly string[]): LaneStepStatus[] {
  if (lane.status === 'integrated') {
    return stepIds.map(() => 'done');
  }
  if (lane.status === 'running' || lane.status === 'failed') {
    const idx = lane.currentStepId === null ? -1 : stepIds.indexOf(lane.currentStepId);
    return stepIds.map((_, i) => {
      if (idx === -1) return 'pending';
      if (i < idx) return 'done';
      if (i === idx) return lane.status === 'failed' ? 'failed' : 'running';
      return 'pending';
    });
  }
  return stepIds.map(() => 'pending');
}

/** Lane chip per contract #6. */
function laneChip(lane: SprintLane): LaneChip {
  switch (lane.status) {
    case 'integrated':
      return 'MERGED';
    case 'running':
      return 'RUNNING';
    case 'failed':
      return 'ESCALATED';
    case 'blocked':
      return 'BLOCKED';
    case 'queued':
      return lane.blockedByRefs.length > 0 ? 'BLOCKED' : 'QUEUED';
  }
}

/**
 * Right-aligned context label next to the chip. Null when the lane needs none
 * (plain RUNNING, or first-pass MERGED).
 */
function laneContextLabel(lane: SprintLane): string | null {
  const chip = laneChip(lane);
  if (chip === 'BLOCKED') {
    return lane.blockedByRefs.length > 0
      ? `waiting on ${lane.blockedByRefs.join(', ')}`
      : 'waiting on prerequisite';
  }
  if (chip === 'QUEUED') return 'waiting for worker slot';
  if (chip === 'ESCALATED') {
    return lane.attempts >= 2
      ? `${lane.attempts}/3 failed → human review`
      : 'failed → human review';
  }
  if (chip === 'MERGED' && lane.attempts >= 2) return `${lane.attempts} attempts`;
  return null;
}

/** Chip classes — same rounded-full pill convention as SprintLanesPanel. */
const CHIP_CLASS: Readonly<Record<LaneChip, string>> = {
  MERGED: 'bg-status-success/15 text-status-success',
  RUNNING: 'bg-interactive/15 text-interactive',
  ESCALATED: 'bg-status-error/15 text-status-error',
  BLOCKED: 'bg-status-warning/15 text-status-warning',
  QUEUED: 'bg-bg-tertiary text-text-tertiary',
};

/** Lane-header status dot color per chip. */
const CHIP_DOT_COLOR: Readonly<Record<LaneChip, string>> = {
  MERGED: 'var(--color-status-success)',
  RUNNING: 'var(--color-status-error)',
  ESCALATED: 'var(--color-status-error)',
  BLOCKED: 'var(--color-status-warning)',
  QUEUED: '#c8bea3',
};

// ---------------------------------------------------------------------------
// LaneStepCard — compact per-lane step card (WorkflowStepCard visual language)
// ---------------------------------------------------------------------------

function LaneStepCard({
  taskId,
  stepId,
  label,
  status,
  optional,
}: {
  taskId: string;
  stepId: string;
  label: string;
  status: LaneStepStatus;
  optional: boolean;
}) {
  const isPending = status === 'pending';
  const isRunning = status === 'running';
  const isDone = status === 'done';
  const isFailed = status === 'failed';

  const dotColor = isDone
    ? 'var(--color-status-success)'
    : isRunning || isFailed
      ? 'var(--color-status-error)'
      : '#c8bea3';

  return (
    <div
      data-testid={`swimlane-step-${taskId}-${stepId}`}
      data-status={status}
      style={{
        flex: 1,
        minWidth: 0,
        borderWidth: '1.2px',
        borderStyle: 'solid',
        borderColor: isFailed
          ? 'var(--color-status-error)'
          : isPending
            ? '#d8cfb8'
            : '#1a1815',
        background: isPending ? '#efeadc' : '#fff',
        padding: '4px 6px',
        position: 'relative',
        ...(isRunning
          ? {
              // Running: 2px rust outline — same language as WorkflowStepCard.
              outlineStyle: 'solid',
              outlineWidth: '2px',
              outlineColor: 'var(--color-status-error)',
              outlineOffset: '1px',
            }
          : {}),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
        {isDone ? (
          // Done: compact green check — WorkflowStepCard's done-check, scaled down.
          <span
            aria-label="completed"
            style={{
              width: 11,
              height: 11,
              borderRadius: '50%',
              background: 'var(--color-status-success)',
              color: '#fff',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <svg
              aria-hidden="true"
              width="7"
              height="7"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M2.5 7.5l3 3 6-6" />
            </svg>
          </span>
        ) : (
          <span
            className={isRunning ? 'animate-pulse' : undefined}
            style={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: dotColor,
              flexShrink: 0,
            }}
          />
        )}
        <span
          style={{
            fontSize: 9,
            fontWeight: 600,
            color: isPending ? '#9c8e6c' : isFailed ? 'var(--color-status-error)' : '#1a1815',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {label}
        </span>
        {optional && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 7.5,
              letterSpacing: '0.14em',
              fontWeight: 700,
              color: isPending ? '#b3a685' : '#6a5e44',
              border: '1px solid #d8cfb8',
              padding: '0 3px',
              flexShrink: 0,
            }}
          >
            OPT
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SprintSwimlaneCanvas
// ---------------------------------------------------------------------------

export function SprintSwimlaneCanvas({
  runId,
  phaseState,
  sprintStatus,
}: SprintSwimlaneCanvasProps) {
  const { lanes } = useSprintLanes(runId);
  const definition = phaseState.definition;

  // Lane step strip — derived from the active fanOut step's inner ids (falls back
  // to SPRINT_LANE_STEP_IDS for sprint / non-fanOut defs, so sprint is identical).
  const laneSteps = laneStepIdsFor(definition);

  // ── Workflow-step state derivation (same ordering rule as WorkflowCanvas) ──
  const stepIds = definition?.phases.flatMap((p) => p.steps.map((s) => s.id)) ?? [];
  const currentIdx =
    phaseState.currentStepId != null ? stepIds.indexOf(phaseState.currentStepId) : -1;
  const statusFor = (flatIdx: number): StepStatus => {
    if (currentIdx === -1) return 'pending';
    if (flatIdx < currentIdx) return 'done';
    if (flatIdx === currentIdx) return 'running';
    return 'pending';
  };

  // Plan = first phase (collapsed to one card); verify = last phase (only when
  // distinct from plan — robust against user-edited single-phase definitions).
  const planPhase = definition?.phases[0] ?? null;
  const verifyPhase =
    definition !== null && definition.phases.length >= 2
      ? definition.phases[definition.phases.length - 1]
      : null;
  const verifyFlatStart = verifyPhase !== null ? stepIds.length - verifyPhase.steps.length : 0;
  // Execute phase color for the center header strip (second phase when present).
  const executeColor = definition?.phases[1]?.color ?? '#6a5e44';

  // Collapsed plan-card status: done when every plan step is done, running when
  // any is the current step, pending otherwise.
  let planStatus: StepStatus = 'pending';
  if (planPhase !== null && planPhase.steps.length > 0) {
    const planStatuses = planPhase.steps.map((_, i) => statusFor(i));
    planStatus = planStatuses.every((s) => s === 'done')
      ? 'done'
      : planStatuses.some((s) => s === 'running')
        ? 'running'
        : 'pending';
  }

  // ── Lane aggregates ────────────────────────────────────────────────────────
  const total = lanes.length;
  const runningCount = lanes.filter((l) => l.status === 'running').length;
  const mergedCount = lanes.filter((l) => l.status === 'integrated').length;
  const escalatedCount = lanes.filter((l) => l.status === 'failed').length;

  return (
    <div className="flex flex-col h-full bg-bg-primary" data-testid="sprint-swimlane-canvas">
      {/* ── Summary row ──────────────────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '4px 8px',
          fontSize: 10,
          letterSpacing: '0.02em',
          color: 'var(--color-text-secondary)',
          padding: '7px 12px 6px',
          background: 'var(--color-bg-primary)',
          borderBottom: '1px dashed var(--color-border-primary)',
          flexShrink: 0,
        }}
        data-testid="swimlane-summary"
      >
        <span>
          <b style={{ color: 'var(--color-text-primary)', fontWeight: 700 }}>{total}</b>{' '}
          parallel tasks
        </span>
        <span>·</span>
        <span>
          workers{' '}
          <b style={{ color: 'var(--color-text-primary)', fontWeight: 700 }}>
            {runningCount}/{SPRINT_BATCH_CAP}
          </b>
        </span>
        <span>·</span>
        <span>
          merged{' '}
          <b style={{ color: 'var(--color-text-primary)', fontWeight: 700 }}>
            {mergedCount}/{total}
          </b>
        </span>
        {escalatedCount > 0 && (
          <span
            className="rounded-full bg-status-error/15 px-1.5 py-0.5 font-medium text-status-error"
            style={{ fontSize: 9, letterSpacing: '0.08em' }}
            data-testid="swimlane-summary-escalated"
          >
            {escalatedCount} ESCALATED
          </span>
        )}
        {sprintStatus !== undefined && (
          <span
            style={{
              marginLeft: 'auto',
              textTransform: 'uppercase',
              letterSpacing: '0.18em',
              fontSize: 9,
            }}
            data-testid="swimlane-summary-status"
          >
            {sprintStatus}
          </span>
        )}
      </div>

      {/* ── Canvas plane — three columns over the dotted grid ─────────────── */}
      <div
        style={{
          position: 'relative',
          flex: 1,
          overflowX: 'auto',
          overflowY: 'auto',
          display: 'flex',
          gap: 14,
          padding: '28px 12px 12px',
          alignItems: 'flex-start',
          // 24px dotted-grid backdrop — same as WorkflowCanvas inner.
          background:
            'linear-gradient(var(--color-grid-line, rgba(106,94,68,0.06)) 1px, transparent 1px) 0 0 / 24px 24px, ' +
            'linear-gradient(90deg, var(--color-grid-line, rgba(106,94,68,0.06)) 1px, transparent 1px) 0 0 / 24px 24px, ' +
            'var(--color-bg-primary)',
        }}
        data-testid="swimlane-canvas-inner"
      >
        {/* LEFT — collapsed plan card */}
        {planPhase !== null && planPhase.steps.length > 0 && (
          <div style={{ width: 138, flexShrink: 0, position: 'relative' }}>
            <span
              style={{
                position: 'absolute',
                top: -20,
                left: 4,
                fontSize: 9,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: planPhase.color,
                whiteSpace: 'nowrap',
              }}
            >
              {planPhase.label.toUpperCase()}
            </span>
            <div data-testid="swimlane-plan">
              <WorkflowStepCard
                step={planPhase.steps[0]}
                phase={planPhase}
                stepIndex={1}
                status={planStatus}
              />
            </div>
          </div>
        )}

        {/* CENTER — execute header + one lane per task */}
        <div style={{ flex: 1, minWidth: 320, position: 'relative' }}>
          <span
            style={{
              position: 'absolute',
              top: -20,
              left: 4,
              fontSize: 9,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: executeColor,
              whiteSpace: 'nowrap',
            }}
            data-testid="swimlane-execute-header"
          >
            EXECUTE / PARALLEL ×{total}
          </span>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {lanes.map((lane) => {
              const chip = laneChip(lane);
              const contextLabel = laneContextLabel(lane);
              const stepStatuses = laneStepStatuses(lane, laneSteps.map((s) => s.id));
              const displayRef = lane.ref ?? lane.taskId;

              return (
                <div
                  key={lane.taskId}
                  data-testid={`swimlane-lane-${lane.taskId}`}
                  style={{
                    borderWidth: '1.4px',
                    borderStyle: 'solid',
                    borderColor:
                      lane.status === 'failed'
                        ? 'var(--color-status-error)'
                        : lane.status === 'running' || lane.status === 'integrated'
                          ? '#1a1815'
                          : '#d8cfb8',
                    background: lane.status === 'queued' || lane.status === 'blocked' ? '#efeadc' : '#fff',
                    padding: '6px 8px 7px',
                  }}
                >
                  {/* Lane header */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      minWidth: 0,
                      marginBottom: 6,
                    }}
                  >
                    <span
                      className={chip === 'RUNNING' ? 'animate-pulse' : undefined}
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: CHIP_DOT_COLOR[chip],
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        fontSize: 10.5,
                        fontWeight: 700,
                        color: '#1a1815',
                        flexShrink: 0,
                      }}
                    >
                      {displayRef}
                    </span>
                    {lane.title !== null && (
                      <span
                        style={{
                          fontSize: 10,
                          color: '#6a5e44',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          minWidth: 0,
                        }}
                        title={lane.title}
                      >
                        {lane.title}
                      </span>
                    )}
                    <span style={{ flex: 1 }} />
                    {contextLabel !== null && (
                      <span
                        style={{
                          fontSize: 9,
                          color: '#6a5e44',
                          whiteSpace: 'nowrap',
                          flexShrink: 0,
                        }}
                        data-testid={`swimlane-context-${lane.taskId}`}
                      >
                        {contextLabel}
                      </span>
                    )}
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-0.5 font-medium ${CHIP_CLASS[chip]}`}
                      style={{ fontSize: 9, letterSpacing: '0.08em' }}
                      data-testid={`swimlane-chip-${lane.taskId}`}
                    >
                      {chip}
                    </span>
                  </div>

                  {/* Lane step cards — derived from the active fanOut inner ids */}
                  <div style={{ display: 'flex', gap: 6 }}>
                    {laneSteps.map((laneStep, i) => (
                      <LaneStepCard
                        key={laneStep.id}
                        taskId={lane.taskId}
                        stepId={laneStep.id}
                        label={laneStep.label}
                        status={stepStatuses[i]}
                        optional={laneStep.optional}
                      />
                    ))}
                  </div>

                  {/* Dashed attempt-loop edge — re-delegated implement (contract #5) */}
                  {lane.status === 'running' && lane.attempts >= 2 && (
                    <div
                      style={{
                        marginTop: 6,
                        paddingTop: 3,
                        borderTop: '1.4px dashed var(--color-status-error)',
                        fontSize: 8.5,
                        letterSpacing: '0.14em',
                        color: 'var(--color-status-error)',
                      }}
                      data-testid={`swimlane-attempt-${lane.taskId}`}
                    >
                      ↺ ATTEMPT {lane.attempts}/3
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* RIGHT — sprint review column + merge gate */}
        {verifyPhase !== null && (
          <div style={{ width: 138, flexShrink: 0, position: 'relative' }}>
            <span
              style={{
                position: 'absolute',
                top: -20,
                left: 4,
                fontSize: 9,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: verifyPhase.color,
                whiteSpace: 'nowrap',
              }}
            >
              SPRINT REVIEW
            </span>

            {verifyPhase.steps.map((step, stepInPhase) => {
              const flatIdx = verifyFlatStart + stepInPhase;
              return (
                <div key={step.id} style={{ height: 86, position: 'relative' }}>
                  <WorkflowStepCard
                    step={step}
                    phase={verifyPhase}
                    stepIndex={flatIdx + 1}
                    status={statusFor(flatIdx)}
                  />
                </div>
              );
            })}

            {/* Merge-gate bar */}
            <div
              style={{
                marginTop: 10,
                borderWidth: '1.4px',
                borderStyle: 'solid',
                borderColor: '#1a1815',
                background:
                  total > 0 && mergedCount === total
                    ? 'rgba(45,138,91,0.12)'
                    : '#fff',
                padding: '6px 8px',
                fontSize: 8.5,
                fontWeight: 700,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: '#1a1815',
                textAlign: 'center',
              }}
              data-testid="swimlane-merge-gate"
            >
              MERGE GATE · {mergedCount}/{total} MERGED
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
