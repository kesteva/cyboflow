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
import { effectiveMaxConcurrency } from '../../../../shared/types/workflows';
import type { WorkflowAgentConfig, WorkflowDefinition, WorkflowPhase, WorkflowStep } from '../../../../shared/types/workflows';
import { resolveStepAgentKey, HUMAN_GATE_AGENT } from '../../../../shared/types/agentIdentity';
import { AGENT_MODEL_LABELS, type AgentModelAlias } from '../../../../shared/types/agents';
import type { WorkflowEditorAction, WorkflowEditorState } from '../../hooks/useWorkflowEditorState';
import { PHASE_COLORS } from './workflowEditorOptions';

export interface WorkflowEditorCanvasProps {
  definition: WorkflowDefinition;
  selectedStepId: string | null;
  selectedFanOutInner: WorkflowEditorState['selectedFanOutInner'];
  dispatch: React.Dispatch<WorkflowEditorAction>;
  /**
   * agentKey → the agent's Agents-pane model pin (`null` = inherits the run
   * model). Falls back to the literal "run model" when a key is absent.
   * Optional so the canvas compiles before the modal wires it through.
   */
  agentModelPins?: Record<string, AgentModelAlias | null>;
}

// Editor step-node width — matches the documented Direction A editor node (178px).
const COL_W = 178;

export function WorkflowEditorCanvas({
  definition,
  selectedStepId,
  selectedFanOutInner,
  dispatch,
  agentModelPins,
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
          definition={definition}
          phase={phase}
          phaseIndex={phaseIdx}
          phaseCount={definition.phases.length}
          selectedStepId={selectedStepId}
          selectedFanOutInner={selectedFanOutInner}
          dispatch={dispatch}
          agentModelPins={agentModelPins}
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
  definition: WorkflowDefinition;
  phase: WorkflowPhase;
  phaseIndex: number;
  phaseCount: number;
  selectedStepId: string | null;
  selectedFanOutInner: WorkflowEditorState['selectedFanOutInner'];
  dispatch: React.Dispatch<WorkflowEditorAction>;
  agentModelPins?: Record<string, AgentModelAlias | null>;
}

function PhaseBand({
  definition,
  phase,
  phaseIndex,
  phaseCount,
  selectedStepId,
  selectedFanOutInner,
  dispatch,
  agentModelPins,
}: PhaseBandProps) {
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
            definition={definition}
            phase={phase}
            step={step}
            stepIndex={stepIdx}
            stepCount={phase.steps.length}
            selected={step.id === selectedStepId}
            selectedFanOutInner={selectedFanOutInner?.stepId === step.id ? selectedFanOutInner : null}
            dispatch={dispatch}
            agentModelPins={agentModelPins}
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
  definition: WorkflowDefinition;
  phase: WorkflowPhase;
  step: WorkflowStep;
  stepIndex: number;
  stepCount: number;
  selected: boolean;
  selectedFanOutInner: WorkflowEditorState['selectedFanOutInner'];
  dispatch: React.Dispatch<WorkflowEditorAction>;
  agentModelPins?: Record<string, AgentModelAlias | null>;
}

function StepNode({
  definition,
  phase,
  step,
  stepIndex,
  stepCount,
  selected,
  selectedFanOutInner,
  dispatch,
  agentModelPins,
}: StepNodeProps) {
  const isHuman = step.human === true;
  const isOptional = step.optional === true;
  const fanOut = step.fanOut;
  const isFanOut = fanOut !== undefined;
  // Canonical agent key this step's config/model overlay is keyed by — same
  // resolver used for the display label so legacy labels (e.g. 'idea-extractor')
  // and the canonical key (e.g. 'context') agree on which agentConfigs entry applies.
  const agentKey = resolveStepAgentKey(step.id, step.agent) ?? step.agent;
  const isHumanGate = step.agent === HUMAN_GATE_AGENT;
  const stepAgentConfig = definition.agentConfigs?.[agentKey];
  const fanOutCap = fanOut !== undefined ? effectiveMaxConcurrency(fanOut) : null;
  const isParallel = fanOutCap !== null && fanOutCap > 1;

  // Head bar: black (Direction A) by default; hatched amber for human steps.
  const headBackground = isHuman
    ? 'repeating-linear-gradient(135deg, var(--human, #d99a3d) 0px 6px, var(--human-hatch, #c98a2d) 6px 12px)'
    : isFanOut
      ? 'var(--color-status-error)'
      : 'var(--color-text-primary)';

  return (
    <div
      onClick={() => dispatch({ type: 'SELECT_STEP', stepId: step.id })}
      style={{
        position: 'relative',
        // The fan-out frame breaks out wider than a normal card; center it in
        // the phase band (which is COL_W + padding wide) instead of spilling
        // the whole breakout out of the right edge.
        width: isFanOut ? COL_W + 16 : COL_W,
        alignSelf: isFanOut ? 'center' : undefined,
        border: isFanOut ? '1.5px dashed var(--color-status-error)' : '1.4px solid var(--color-text-primary)',
        background: isFanOut ? 'rgba(201,100,66,0.045)' : 'var(--color-surface-primary)',
        padding: isFanOut ? 10 : 0,
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
      {isFanOut && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 9,
            fontSize: 9,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--color-status-error)',
            fontWeight: 700,
          }}
          data-testid={`editor-step-fanout-title-${step.id}`}
        >
          <span style={{ fontSize: 12 }}>⇄</span>
          <span>Fan-out template</span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              dispatch({ type: 'SET_STEP_FANOUT', phaseId: phase.id, stepId: step.id, enabled: !isParallel });
            }}
            style={{
              fontFamily: 'inherit',
              fontSize: 8.5,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              fontWeight: 700,
              padding: '3px 7px',
              border: '1px solid var(--color-status-error)',
              background: isParallel ? 'var(--color-status-error)' : 'transparent',
              color: isParallel ? 'var(--color-bg-primary)' : 'var(--color-status-error)',
              cursor: 'pointer',
            }}
            data-testid={`editor-step-parallel-chip-${step.id}`}
          >
            {isParallel ? `⇄ Parallel ×${fanOutCap}` : '→ Serial'}
          </button>
        </div>
      )}

      <div
        style={{
          border: isFanOut ? '1.4px solid var(--color-text-primary)' : '0',
          background: 'var(--color-surface-primary)',
        }}
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
            <b style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>
              {agentKey}
              {stepAgentConfig?.custom !== undefined && (
                <span
                  title="Customized for this flow"
                  data-testid={`editor-step-agent-custom-${step.id}`}
                >
                  *
                </span>
              )}
            </b>
          </span>
          <ModelMetaRow
            agentKey={agentKey}
            isHumanGate={isHumanGate}
            agentConfig={stepAgentConfig}
            agentModelPins={agentModelPins}
            labelWidth={42}
            testId={`editor-step-model-${step.id}`}
          />
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
        {!isFanOut && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              dispatch({ type: 'SET_STEP_FANOUT', phaseId: phase.id, stepId: step.id, enabled: true });
            }}
            style={{
              marginTop: 9,
              width: '100%',
              fontFamily: 'inherit',
              fontSize: 8.5,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              fontWeight: 700,
              padding: '4px 7px',
              border: '1px solid var(--color-status-error)',
              background: 'transparent',
              color: 'var(--color-status-error)',
              cursor: 'pointer',
            }}
            data-testid={`editor-step-make-parallel-${step.id}`}
          >
            ⇄ Make parallel
          </button>
        )}
      </div>
      </div>

      {fanOut !== undefined && (
        <div data-testid={`editor-step-fanout-frame-${step.id}`}>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '4px 8px',
              marginTop: 9,
              marginBottom: 11,
              padding: '6px 8px',
              border: '1px solid var(--color-border-primary)',
              background: 'var(--color-surface-primary)',
              fontSize: 9,
              color: 'var(--color-text-secondary)',
            }}
            data-testid={`editor-step-fanout-meta-${step.id}`}
          >
            <span><span style={{ color: 'var(--color-text-tertiary)' }}>over </span><b style={{ color: 'var(--color-text-primary)' }}>{fanOut.over}</b></span>
            <span><span style={{ color: 'var(--color-text-tertiary)' }}>cap </span><b style={{ color: 'var(--color-text-primary)' }}>{effectiveMaxConcurrency(fanOut)}</b></span>
            <span><b style={{ color: 'var(--color-status-error)' }}>{fanOut.inner.length} inner</b></span>
            <span style={{ color: 'var(--color-text-tertiary)' }}>
              {fanOut.over === 'tasks' ? 'both planes' : 'unsupported source'}
            </span>
          </div>

          <div style={{ position: 'relative' }}>
            <div
              style={{
                position: 'absolute',
                left: 6,
                top: 6,
                right: -6,
                bottom: -6,
                border: '1.4px solid #c9b48f',
                background: 'var(--color-surface-primary)',
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: 3,
                top: 3,
                right: -3,
                bottom: -3,
                border: '1.4px solid #b9a887',
                background: 'var(--color-surface-primary)',
              }}
            />
            <div style={{ position: 'relative' }}>
              {fanOut.inner.map((inner, innerIndex) => {
                const selectedInner = selectedFanOutInner?.innerIndex === innerIndex;
                return (
                  <div
                    key={`${inner.id}-${innerIndex}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      dispatch({ type: 'SELECT_FANOUT_INNER', stepId: step.id, innerIndex });
                    }}
                    style={{
                      position: 'relative',
                      border: '1.4px solid var(--color-text-primary)',
                      background: 'var(--color-surface-primary)',
                      marginBottom: innerIndex === fanOut.inner.length - 1 ? 0 : 9,
                      cursor: 'pointer',
                    }}
                    data-testid={`editor-fanout-inner-card-${step.id}-${innerIndex}`}
                    aria-pressed={selectedInner}
                  >
                    {selectedInner && (
                      <div
                        style={{
                          position: 'absolute',
                          inset: -3,
                          border: '2.5px solid var(--color-status-error)',
                          pointerEvents: 'none',
                        }}
                      />
                    )}
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '4px 7px',
                        background: 'var(--color-status-error)',
                        color: 'var(--color-bg-primary)',
                        fontSize: 8.5,
                        letterSpacing: '0.14em',
                        textTransform: 'uppercase',
                      }}
                    >
                      <span style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                        <span>INR</span>
                        {inner.optional === true && <span style={{ background: 'rgba(255,255,255,0.24)', padding: '0 4px' }}>OPT</span>}
                        {inner.loopback && <span style={{ background: 'rgba(255,255,255,0.24)', padding: '0 4px' }}>⟲ RESERVED</span>}
                      </span>
                      <span style={{ opacity: 0.65 }}>{String(innerIndex + 1).padStart(2, '0')}</span>
                    </div>
                    <div style={{ padding: '7px 8px 8px' }}>
                      <div style={{ fontSize: 11, fontWeight: 600, lineHeight: 1.25 }}>
                        {inner.name != null && inner.name.trim().length > 0 ? inner.name : inner.id}
                      </div>
                      {(() => {
                        const innerAgentKey = resolveStepAgentKey(inner.id, inner.agent) ?? inner.agent;
                        const innerIsHumanGate = inner.agent === HUMAN_GATE_AGENT;
                        const innerAgentConfig = definition.agentConfigs?.[innerAgentKey];
                        return (
                          <div
                            style={{
                              marginTop: 6,
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 2,
                              fontSize: 9.5,
                              color: 'var(--color-text-secondary)',
                            }}
                          >
                            <span>
                              <span style={{ color: 'var(--color-text-tertiary)', display: 'inline-block', width: 38 }}>agent</span>
                              <b style={{ color: 'var(--color-text-primary)' }}>
                                {innerAgentKey}
                                {innerAgentConfig?.custom !== undefined && (
                                  <span
                                    title="Customized for this flow"
                                    data-testid={`editor-fanout-inner-agent-custom-${inner.id}`}
                                  >
                                    *
                                  </span>
                                )}
                              </b>
                            </span>
                            <ModelMetaRow
                              agentKey={innerAgentKey}
                              isHumanGate={innerIsHumanGate}
                              agentConfig={innerAgentConfig}
                              agentModelPins={agentModelPins}
                              labelWidth={38}
                              testId={`editor-fanout-inner-model-${inner.id}`}
                            />
                            <span><span style={{ color: 'var(--color-text-tertiary)', display: 'inline-block', width: 38 }}>id</span><b style={{ color: 'var(--color-text-primary)' }}>{inner.id}</b></span>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

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
// ModelMetaRow — shared "model" meta line for the outer step card and each
// fan-out inner card. Effective value, in precedence order:
//   (a) this workflow's agentConfigs override for the agent  → styled as an
//       explicit override (var(--color-status-info), the reads-as-"set here"
//       accent that is NOT the loop row's error red)
//   (b) the agent's Agents-pane model pin                    → normal <b>
//   (c) neither set                                           → literal
//       "run model", tertiary + italic (inherits silently)
// Always rendered except for the human gate, which has no model to pin.
// ---------------------------------------------------------------------------

interface ModelMetaRowProps {
  agentKey: string;
  isHumanGate: boolean;
  agentConfig: WorkflowAgentConfig | undefined;
  agentModelPins?: Record<string, AgentModelAlias | null>;
  labelWidth: number;
  testId: string;
}

function ModelMetaRow({ isHumanGate, agentConfig, agentModelPins, agentKey, labelWidth, testId }: ModelMetaRowProps) {
  if (isHumanGate) return null;

  const override = agentConfig?.model;
  const pin = agentModelPins?.[agentKey];

  let text: string;
  let valueStyle: React.CSSProperties;
  if (override !== undefined) {
    text = AGENT_MODEL_LABELS[override];
    valueStyle = { color: 'var(--color-status-info)', fontWeight: 700 };
  } else if (pin != null) {
    text = AGENT_MODEL_LABELS[pin];
    valueStyle = { color: 'var(--color-text-primary)', fontWeight: 600 };
  } else {
    text = 'run model';
    valueStyle = { color: 'var(--color-text-tertiary)', fontStyle: 'italic', fontWeight: 400 };
  }

  return (
    <span>
      <span style={{ display: 'inline-block', width: labelWidth, color: 'var(--color-text-tertiary)' }}>model</span>
      <b style={valueStyle} data-testid={testId}>{text}</b>
    </span>
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
