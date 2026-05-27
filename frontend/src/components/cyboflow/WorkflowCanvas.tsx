/**
 * WorkflowCanvas — visual shell for the Active Workflow surface.
 *
 * Renders a meta row + horizontal phase columns (138px wide, 14px gap) with
 * step cards (86px row height) stacked vertically. State derivation:
 *   - steps before currentStepId → done
 *   - step matching currentStepId → running
 *   - steps after currentStepId → pending
 *   - currentStepId null / not found → all pending
 *
 * No tRPC calls, no SVG edge layer, no animated token in this task.
 * SVG edge layer and animated token deferred to TASK-770.
 *
 * TASK-769 / IDEA-026
 */
import type { WorkflowDefinition } from '../../../../shared/types/workflows';
import { WorkflowStepCard } from './WorkflowStepCard';
import type { StepStatus } from './WorkflowStepCard';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowCanvasProps {
  definition: WorkflowDefinition;
  currentStepId?: string | null;
  runLabel?: string;
  workflowTitle?: string;
  elapsed?: string;
  tokenCount?: string;
  isRunning?: boolean;
}

// ---------------------------------------------------------------------------
// WorkflowCanvas
// ---------------------------------------------------------------------------

export function WorkflowCanvas({
  definition,
  currentStepId = null,
  runLabel,
  workflowTitle,
  elapsed,
  tokenCount,
  isRunning = false,
}: WorkflowCanvasProps) {
  // ── Flatten all steps for state derivation ────────────────────────────────
  type FlatStep = {
    phaseIndex: number;
    stepIndex: number; // 1-based global
    phase: (typeof definition.phases)[number];
    step: (typeof definition.phases)[number]['steps'][number];
  };

  const allSteps: FlatStep[] = [];
  let globalIdx = 0;
  for (const phase of definition.phases) {
    for (const step of phase.steps) {
      globalIdx += 1;
      allSteps.push({
        phaseIndex: 0, // unused
        stepIndex: globalIdx,
        phase,
        step,
      });
    }
  }

  // Index of the currently-running step (-1 if not found or null)
  const currentIdx =
    currentStepId != null
      ? allSteps.findIndex((fs) => fs.step.id === currentStepId)
      : -1;

  // Derive per-step status
  const statusFor = (flatIdx: number): StepStatus => {
    if (currentIdx === -1) return 'pending';
    if (flatIdx < currentIdx) return 'done';
    if (flatIdx === currentIdx) return 'running';
    return 'pending';
  };

  // ── Layout constants (mirror FlowReadOnly from dashboard.jsx) ─────────────
  const COL_W = 138;
  const COL_GAP = 14;
  const ROW_H = 86;
  const TOP = 28; // vertical offset from canvas inner top for first card
  const LEFT = 12; // left padding of canvas inner

  // ── Build per-phase column layout ─────────────────────────────────────────
  const columns = definition.phases.map((phase, phaseIdx) => {
    const x = LEFT + phaseIdx * (COL_W + COL_GAP);
    return { phase, x };
  });

  // ── Canvas inner height: tallest column + TOP padding ────────────────────
  const maxSteps = Math.max(...definition.phases.map((p) => p.steps.length), 0);
  const canvasInnerHeight = TOP + maxSteps * ROW_H + 12;

  // ── Running pill — uses Tailwind animate-pulse (1.4s built-in) ───────────

  return (
    <div
      className="flex flex-col h-full bg-bg-primary"
      data-testid="workflow-canvas"
    >
      {/* ── Meta row ───────────────────────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '4px 12px',
          fontSize: 10,
          letterSpacing: '0.02em',
          color: 'var(--color-text-secondary)',
          padding: '7px 12px 6px',
          background: 'var(--color-bg-primary)',
          borderBottom: '1px dashed var(--color-border-primary)',
          flexShrink: 0,
        }}
        data-testid="workflow-canvas-meta"
      >
        {workflowTitle && (
          <span data-testid="workflow-canvas-workflow-title">
            <b style={{ color: 'var(--color-text-primary)', fontWeight: 700 }}>
              {workflowTitle}
            </b>
          </span>
        )}
        {runLabel && (
          <span data-testid="workflow-canvas-run-label">
            {' · '}
            {runLabel}
          </span>
        )}
        {elapsed !== undefined && (
          <span data-testid="workflow-canvas-elapsed">
            elapsed{' '}
            <b style={{ color: 'var(--color-text-primary)', fontWeight: 700 }}>{elapsed}</b>
          </span>
        )}
        {tokenCount !== undefined && (
          <span data-testid="workflow-canvas-tokens">
            tokens{' '}
            <b style={{ color: 'var(--color-text-primary)', fontWeight: 700 }}>{tokenCount}</b>
          </span>
        )}
        {isRunning && (
          <span
            style={{
              padding: '2px 8px',
              border: '1px solid var(--color-status-error)',
              color: 'var(--color-status-error)',
              textTransform: 'uppercase',
              letterSpacing: '0.18em',
              fontSize: 9,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
            }}
            data-testid="workflow-canvas-running-pill"
          >
            {/* Pulsing dot — Tailwind animate-pulse */}
            <span
              className="animate-pulse"
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--color-status-error)',
                display: 'inline-block',
              }}
            />
            running
          </span>
        )}
      </div>

      {/* ── Canvas inner — phase columns with step cards ───────────────────── */}
      <div
        style={{
          position: 'relative',
          flex: 1,
          overflowX: 'auto',
          overflowY: 'auto',
          display: 'flex',
          gap: COL_GAP,
          padding: `${TOP}px 12px 12px`,
          minHeight: canvasInnerHeight,
        }}
        data-testid="workflow-canvas-inner"
      >
        {/* SVG edge layer and animated token deferred to TASK-770 */}

        {columns.map(({ phase }, phaseIdx) => {
          // Track running flat-step index across phases
          let phaseFlatStart = 0;
          for (let i = 0; i < phaseIdx; i++) {
            phaseFlatStart += definition.phases[i].steps.length;
          }

          return (
            <div
              key={phase.id}
              style={{
                width: COL_W,
                flexShrink: 0,
                position: 'relative',
              }}
              data-testid={`phase-column-${phase.id}`}
            >
              {/* Band label — absolute, above the column */}
              <span
                style={{
                  position: 'absolute',
                  top: -20,
                  left: 4,
                  fontSize: 9,
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                  color: phase.color,
                  whiteSpace: 'nowrap',
                }}
                data-testid={`phase-band-${phase.id}`}
              >
                {phase.label.toUpperCase()}
              </span>

              {/* Step cards stacked vertically */}
              {phase.steps.map((step, stepInPhase) => {
                const flatIdx = phaseFlatStart + stepInPhase;
                const derivedStatus = statusFor(flatIdx);
                const globalStepIndex = flatIdx + 1; // 1-based

                return (
                  <div
                    key={step.id}
                    style={{
                      height: ROW_H,
                      position: 'relative',
                      marginBottom: stepInPhase < phase.steps.length - 1 ? 0 : 0,
                    }}
                    data-testid={`step-wrapper-${step.id}`}
                  >
                    <WorkflowStepCard
                      step={step}
                      phase={phase}
                      stepIndex={globalStepIndex}
                      status={derivedStatus}
                    />
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
