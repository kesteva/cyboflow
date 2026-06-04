/**
 * WorkflowEditorCanvas — editable phase/step graph for the blueprint editor.
 *
 * Renders dashed phase bands (Direction A / WorkflowStepCard visual language)
 * laid out left-to-right, each holding a vertical column of editable step nodes.
 * A node shows the phase head bar (black per the Direction A spec), step name,
 * agent + retry meta, and a status foot; the selected node carries a 3px rust
 * outline (var(--color-status-error)).
 *
 * Note: the SVG connector edges drawn by the read-only WorkflowCanvas (via
 * WorkflowCanvasEdges) are not rendered here yet — loopback targets surface as a
 * node meta line ("loop <id>"). Drawing editable orthogonal connectors is a
 * tracked follow-up; the band + ordered-node layout conveys the graph order.
 *
 * Editing affordances:
 *   - Per node: move up / move down / remove (dispatched to the reducer).
 *   - Per phase: add step, move phase left/right, remove phase, edit label
 *     (input) + colour (swatch picker from PHASE_COLORS).
 *
 * This is the EDIT surface; the read-only run view stays WorkflowCanvas.tsx.
 * Paper design tokens only (no re-derived palette).
 *
 * FEATURE: user-editable workflow blueprint editor.
 */
import type { WorkflowDefinition, WorkflowPhase, WorkflowStep } from '../../../../shared/types/workflows';
import type { WorkflowEditorAction } from '../../hooks/useWorkflowEditorState';
import { PHASE_COLORS } from './workflowEditorOptions';

export interface WorkflowEditorCanvasProps {
  definition: WorkflowDefinition;
  selectedStepId: string | null;
  dispatch: React.Dispatch<WorkflowEditorAction>;
}

// Editor step-node width — matches the documented Direction A editor node (178px).
const COL_W = 178;

export function WorkflowEditorCanvas({
  definition,
  selectedStepId,
  dispatch,
}: WorkflowEditorCanvasProps) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        overflow: 'auto',
        padding: '40px 20px 20px',
        display: 'flex',
        gap: 46,
        alignItems: 'flex-start',
        // 24px dotted-grid backdrop (Protoflow flow canvas).
        background:
          'linear-gradient(var(--color-grid-line, rgba(106,94,68,0.07)) 1px, transparent 1px) 0 0 / 24px 24px, ' +
          'linear-gradient(90deg, var(--color-grid-line, rgba(106,94,68,0.07)) 1px, transparent 1px) 0 0 / 24px 24px, ' +
          'var(--color-bg-primary)',
      }}
      data-testid="workflow-editor-canvas"
    >
      {definition.phases.map((phase, phaseIdx) => (
        <PhaseBand
          key={phase.id}
          phase={phase}
          phaseIndex={phaseIdx}
          phaseCount={definition.phases.length}
          selectedStepId={selectedStepId}
          dispatch={dispatch}
        />
      ))}

      {/* Add-phase column */}
      <button
        type="button"
        onClick={() => dispatch({ type: 'ADD_PHASE' })}
        style={{
          flexShrink: 0,
          marginTop: 4,
          width: 120,
          minHeight: 80,
          border: '1px dashed var(--color-border-primary)',
          background: 'transparent',
          color: 'var(--color-text-secondary)',
          fontFamily: 'inherit',
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          cursor: 'pointer',
        }}
        data-testid="editor-add-phase"
      >
        + phase
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PhaseBand
// ---------------------------------------------------------------------------

interface PhaseBandProps {
  phase: WorkflowPhase;
  phaseIndex: number;
  phaseCount: number;
  selectedStepId: string | null;
  dispatch: React.Dispatch<WorkflowEditorAction>;
}

function PhaseBand({ phase, phaseIndex, phaseCount, selectedStepId, dispatch }: PhaseBandProps) {
  return (
    <div
      style={{
        position: 'relative',
        flexShrink: 0,
        width: COL_W + 24,
        padding: '12px 12px 14px',
        border: '1px dashed var(--color-text-tertiary)',
      }}
      data-testid={`editor-phase-band-${phase.id}`}
    >
      {/* Phase label tab */}
      <span
        style={{
          position: 'absolute',
          top: -9,
          left: 8,
          background: 'var(--color-bg-primary)',
          padding: '0 6px',
          fontSize: 10,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
          color: phase.color,
        }}
        data-testid={`editor-phase-label-${phase.id}`}
      >
        {phase.label.toUpperCase()} · phase {String(phaseIndex + 1).padStart(2, '0')}
      </span>

      {/* ── Phase controls: label input + colour swatches + move/remove ──── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
        <input
          type="text"
          value={phase.label}
          onChange={(e) => dispatch({ type: 'SET_PHASE_LABEL', phaseId: phase.id, label: e.target.value })}
          aria-label={`Phase label for ${phase.id}`}
          style={{
            fontFamily: 'inherit',
            fontSize: 11,
            border: '1px solid var(--color-text-primary)',
            background: 'var(--color-input-bg)',
            padding: '3px 6px',
            width: '100%',
            color: 'var(--color-input-text)',
            borderRadius: 0,
            boxSizing: 'border-box',
          }}
          data-testid={`editor-phase-label-input-${phase.id}`}
        />

        <div style={{ display: 'flex', gap: 4 }}>
          {PHASE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => dispatch({ type: 'SET_PHASE_COLOR', phaseId: phase.id, color: c })}
              aria-label={`Set phase colour ${c}`}
              title={c}
              style={{
                width: 18,
                height: 18,
                background: c,
                border: phase.color.toLowerCase() === c.toLowerCase()
                  ? '2px solid var(--color-text-primary)'
                  : '1px solid var(--color-border-primary)',
                cursor: 'pointer',
                padding: 0,
              }}
              data-testid={`editor-phase-swatch-${phase.id}-${c}`}
            />
          ))}
        </div>

        <div style={{ display: 'flex', gap: 4 }}>
          <IconBtn
            label="Move phase left"
            disabled={phaseIndex === 0}
            onClick={() => dispatch({ type: 'MOVE_PHASE', phaseId: phase.id, dir: 'up' })}
            testId={`editor-phase-move-left-${phase.id}`}
          >
            ←
          </IconBtn>
          <IconBtn
            label="Move phase right"
            disabled={phaseIndex === phaseCount - 1}
            onClick={() => dispatch({ type: 'MOVE_PHASE', phaseId: phase.id, dir: 'down' })}
            testId={`editor-phase-move-right-${phase.id}`}
          >
            →
          </IconBtn>
          <IconBtn
            label="Remove phase"
            disabled={phaseCount <= 1}
            onClick={() => dispatch({ type: 'REMOVE_PHASE', phaseId: phase.id })}
            testId={`editor-phase-remove-${phase.id}`}
          >
            ✕
          </IconBtn>
        </div>
      </div>

      {/* ── Step nodes ──────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {phase.steps.map((step, stepIdx) => (
          <StepNode
            key={step.id}
            phase={phase}
            step={step}
            stepIndex={stepIdx}
            stepCount={phase.steps.length}
            selected={step.id === selectedStepId}
            dispatch={dispatch}
          />
        ))}
      </div>

      {/* Add-step button */}
      <button
        type="button"
        onClick={() => dispatch({ type: 'ADD_STEP', phaseId: phase.id })}
        style={{
          marginTop: 12,
          width: COL_W,
          padding: '6px 0',
          border: '1px dashed var(--color-border-primary)',
          background: 'transparent',
          color: 'var(--color-text-secondary)',
          fontFamily: 'inherit',
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          cursor: 'pointer',
        }}
        data-testid={`editor-add-step-${phase.id}`}
      >
        + step
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StepNode
// ---------------------------------------------------------------------------

interface StepNodeProps {
  phase: WorkflowPhase;
  step: WorkflowStep;
  stepIndex: number;
  stepCount: number;
  selected: boolean;
  dispatch: React.Dispatch<WorkflowEditorAction>;
}

function StepNode({ phase, step, stepIndex, stepCount, selected, dispatch }: StepNodeProps) {
  const isHuman = step.human === true;
  const isOptional = step.optional === true;

  // Head bar: black (Direction A) by default; hatched amber for human steps.
  const headBackground = isHuman
    ? 'repeating-linear-gradient(135deg, var(--human, #d99a3d) 0px 6px, var(--human-hatch, #c98a2d) 6px 12px)'
    : 'var(--color-text-primary)';

  return (
    <div
      onClick={() => dispatch({ type: 'SELECT_STEP', stepId: step.id })}
      style={{
        position: 'relative',
        width: COL_W,
        border: '1.4px solid var(--color-text-primary)',
        background: 'var(--color-surface-primary)',
        cursor: 'pointer',
        ...(selected
          ? {
              outlineStyle: 'solid',
              outlineWidth: '3px',
              outlineColor: 'var(--color-status-error)',
              outlineOffset: '3px',
            }
          : {}),
      }}
      data-testid={`editor-step-node-${step.id}`}
      aria-pressed={selected}
    >
      {/* Human badge */}
      {isHuman && (
        <span
          aria-label="human step"
          style={{
            position: 'absolute',
            top: -10,
            right: -10,
            width: 22,
            height: 22,
            borderRadius: '50%',
            background: 'var(--human, #d99a3d)',
            border: '1.5px solid var(--color-text-primary)',
            color: 'var(--color-text-primary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 3,
          }}
          data-testid={`editor-step-human-badge-${step.id}`}
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="6" cy="4" r="2" />
            <path d="M2 11c.4-2.3 2-3.5 4-3.5s3.6 1.2 4 3.5" />
          </svg>
        </span>
      )}

      {/* Head bar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '5px 8px',
          background: headBackground,
          // Invert against the head background so the label stays legible when
          // --color-text-primary flips (ink in paper, white in dark/lilac). Matches
          // the inspector's on-state knob, which uses --color-bg-primary for cream-on-ink.
          color: 'var(--color-bg-primary)',
          fontSize: 9,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span>{phase.label.slice(0, 3).toUpperCase()}</span>
          {isOptional && (
            <span
              style={{
                fontSize: 8.5,
                letterSpacing: '0.14em',
                fontWeight: 700,
                background: 'rgba(255,255,255,0.22)',
                padding: '1px 5px',
              }}
              data-testid={`editor-step-optional-chip-${step.id}`}
            >
              OPTIONAL
            </span>
          )}
        </span>
        <span style={{ opacity: 0.55 }}>{String(stepIndex + 1).padStart(2, '0')}</span>
      </div>

      {/* Body */}
      <div style={{ padding: '9px 10px 10px' }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            lineHeight: 1.25,
            color: 'var(--color-text-primary)',
            letterSpacing: '-0.01em',
            wordBreak: 'break-word',
          }}
        >
          {step.name}
        </div>
        <div
          style={{
            marginTop: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
            fontSize: 10,
            color: 'var(--color-text-secondary)',
          }}
        >
          <span>
            <span style={{ display: 'inline-block', width: 42, color: 'var(--color-text-tertiary)' }}>agent</span>
            <b style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{step.agent}</b>
          </span>
          <span>
            <span style={{ display: 'inline-block', width: 42, color: 'var(--color-text-tertiary)' }}>retry</span>
            <b style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>×{step.retries}</b>
          </span>
          {step.loopback && (
            <span>
              <span style={{ display: 'inline-block', width: 42, color: 'var(--color-text-tertiary)' }}>loop</span>
              <b style={{ color: 'var(--color-status-error)', fontWeight: 600 }}>{step.loopback}</b>
            </span>
          )}
        </div>
      </div>

      {/* Foot — per-node controls (move up/down, remove) */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '5px 8px',
          borderTop: '1px dashed var(--color-border-primary)',
        }}
      >
        <IconBtn
          label="Move step up"
          disabled={stepIndex === 0}
          onClick={(e) => {
            e?.stopPropagation();
            dispatch({ type: 'MOVE_STEP', phaseId: phase.id, stepId: step.id, dir: 'up' });
          }}
          testId={`editor-step-move-up-${step.id}`}
        >
          ↑
        </IconBtn>
        <IconBtn
          label="Move step down"
          disabled={stepIndex === stepCount - 1}
          onClick={(e) => {
            e?.stopPropagation();
            dispatch({ type: 'MOVE_STEP', phaseId: phase.id, stepId: step.id, dir: 'down' });
          }}
          testId={`editor-step-move-down-${step.id}`}
        >
          ↓
        </IconBtn>
        <span style={{ flex: 1 }} />
        <IconBtn
          label="Remove step"
          disabled={stepCount <= 1}
          onClick={(e) => {
            e?.stopPropagation();
            dispatch({ type: 'REMOVE_STEP', phaseId: phase.id, stepId: step.id });
          }}
          testId={`editor-step-remove-${step.id}`}
        >
          ✕
        </IconBtn>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// IconBtn — small square paper-token control button
// ---------------------------------------------------------------------------

function IconBtn({
  children,
  label,
  onClick,
  disabled,
  testId,
}: {
  children: React.ReactNode;
  label: string;
  onClick: (e?: React.MouseEvent) => void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      style={{
        width: 20,
        height: 20,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '1px solid var(--color-border-primary)',
        background: 'var(--color-surface-primary)',
        color: 'var(--color-text-secondary)',
        fontFamily: 'inherit',
        fontSize: 11,
        lineHeight: 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        padding: 0,
        borderRadius: 0,
      }}
      data-testid={testId}
    >
      {children}
    </button>
  );
}
