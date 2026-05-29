/**
 * WorkflowStepInspector — 300px right pane of the blueprint editor.
 *
 * Three tabs (Direction A inspector language):
 *   STEP  — name input, desc textarea, retries number input, optional + human toggles.
 *   AGENT — agent <select> (AGENT_OPTIONS, free text allowed) + loopback <select>
 *           (other same-phase step ids, '(none)' option).
 *   MCP   — toggle rows for MCP_OPTIONS (checked when present in step.mcps).
 *
 * Dispatches editor actions for the currently-selected step; the parent
 * (WorkflowEditorModal) owns the reducer state. Paper design tokens only.
 *
 * FEATURE: user-editable workflow blueprint editor.
 */
import { useState } from 'react';
import type { WorkflowDefinition, WorkflowPhase, WorkflowStep } from '../../../../shared/types/workflows';
import type { WorkflowEditorAction } from '../../hooks/useWorkflowEditorState';
import { AGENT_OPTIONS, MCP_OPTIONS } from './workflowEditorOptions';

type InspectorTab = 'step' | 'agent' | 'mcp';

export interface WorkflowStepInspectorProps {
  definition: WorkflowDefinition;
  selectedStepId: string | null;
  dispatch: React.Dispatch<WorkflowEditorAction>;
}

/** Locate the selected step and its containing phase within the definition. */
function findStep(
  definition: WorkflowDefinition,
  stepId: string | null,
): { phase: WorkflowPhase; step: WorkflowStep } | null {
  if (stepId === null) return null;
  for (const phase of definition.phases) {
    const step = phase.steps.find((s) => s.id === stepId);
    if (step) return { phase, step };
  }
  return null;
}

const labelStyle: React.CSSProperties = {
  fontSize: 9,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--color-text-secondary)',
  display: 'block',
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  fontFamily: 'inherit',
  fontSize: 11,
  border: '1px solid var(--color-text-primary)',
  background: 'var(--color-input-bg)',
  padding: '4px 6px',
  width: '100%',
  color: 'var(--color-input-text)',
  borderRadius: 0,
  boxSizing: 'border-box',
};

export function WorkflowStepInspector({
  definition,
  selectedStepId,
  dispatch,
}: WorkflowStepInspectorProps) {
  const [tab, setTab] = useState<InspectorTab>('step');
  const found = findStep(definition, selectedStepId);

  return (
    <div
      style={{
        width: 300,
        flexShrink: 0,
        borderLeft: '1px solid var(--color-border-primary)',
        background: 'var(--color-bg-secondary)',
        display: 'flex',
        flexDirection: 'column',
      }}
      data-testid="workflow-step-inspector"
    >
      {/* ── Tabs ─────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--color-border-primary)' }}>
        {(['step', 'agent', 'mcp'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            style={{
              flex: 1,
              padding: '8px 0',
              fontFamily: 'inherit',
              fontSize: 10,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              background: tab === t ? 'var(--color-bg-primary)' : 'transparent',
              border: 0,
              borderBottom: tab === t ? '2px solid var(--color-text-primary)' : '2px solid transparent',
              color: tab === t ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
              cursor: 'pointer',
            }}
            data-testid={`inspector-tab-${t}`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '14px 16px',
          fontSize: 11,
          lineHeight: 1.45,
          color: 'var(--color-text-primary)',
        }}
        data-testid="inspector-body"
      >
        {found === null ? (
          <p style={{ color: 'var(--color-text-secondary)' }}>Select a step to edit it.</p>
        ) : tab === 'step' ? (
          <StepTab phase={found.phase} step={found.step} dispatch={dispatch} />
        ) : tab === 'agent' ? (
          <AgentTab phase={found.phase} step={found.step} dispatch={dispatch} />
        ) : (
          <McpTab phase={found.phase} step={found.step} dispatch={dispatch} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// STEP tab
// ---------------------------------------------------------------------------

interface TabProps {
  phase: WorkflowPhase;
  step: WorkflowStep;
  dispatch: React.Dispatch<WorkflowEditorAction>;
}

function StepTab({ phase, step, dispatch }: TabProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
        {phase.label} · <span style={{ fontFamily: 'inherit' }}>{step.id}</span>
      </div>

      <div>
        <label style={labelStyle} htmlFor="insp-name">name</label>
        <input
          id="insp-name"
          type="text"
          value={step.name}
          onChange={(e) =>
            dispatch({ type: 'SET_STEP_FIELD', phaseId: phase.id, stepId: step.id, field: 'name', value: e.target.value })
          }
          style={inputStyle}
          data-testid="inspector-name-input"
        />
      </div>

      <div>
        <label style={labelStyle} htmlFor="insp-desc">description</label>
        <textarea
          id="insp-desc"
          value={step.desc ?? ''}
          onChange={(e) =>
            dispatch({ type: 'SET_STEP_FIELD', phaseId: phase.id, stepId: step.id, field: 'desc', value: e.target.value })
          }
          rows={4}
          style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }}
          data-testid="inspector-desc-input"
        />
      </div>

      <div>
        <label style={labelStyle} htmlFor="insp-retries">retries</label>
        <input
          id="insp-retries"
          type="number"
          min={0}
          step={1}
          value={step.retries}
          onChange={(e) =>
            dispatch({
              type: 'SET_STEP_FIELD',
              phaseId: phase.id,
              stepId: step.id,
              field: 'retries',
              value: Number.parseInt(e.target.value, 10) || 0,
            })
          }
          style={inputStyle}
          data-testid="inspector-retries-input"
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <ToggleRow
          label="optional"
          checked={step.optional === true}
          onToggle={() => dispatch({ type: 'TOGGLE_OPTIONAL', phaseId: phase.id, stepId: step.id })}
          testId="inspector-toggle-optional"
        />
        <ToggleRow
          label="human checkpoint"
          checked={step.human === true}
          onToggle={() => dispatch({ type: 'TOGGLE_HUMAN', phaseId: phase.id, stepId: step.id })}
          testId="inspector-toggle-human"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AGENT tab
// ---------------------------------------------------------------------------

function AgentTab({ phase, step, dispatch }: TabProps) {
  // Free-text agents: if the current agent isn't in the suggested list, surface
  // it as an extra option so the <select> can still represent it.
  const agentInList = (AGENT_OPTIONS as readonly string[]).includes(step.agent);
  const samePhaseTargets = phase.steps.filter((s) => s.id !== step.id);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <label style={labelStyle} htmlFor="insp-agent">agent</label>
        <select
          id="insp-agent"
          value={step.agent}
          onChange={(e) =>
            dispatch({ type: 'SET_STEP_FIELD', phaseId: phase.id, stepId: step.id, field: 'agent', value: e.target.value })
          }
          style={inputStyle}
          data-testid="inspector-agent-select"
        >
          {!agentInList && step.agent.length > 0 && (
            <option value={step.agent}>{step.agent} (custom)</option>
          )}
          {AGENT_OPTIONS.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </div>

      <div>
        <label style={labelStyle} htmlFor="insp-loopback">loopback (on failure)</label>
        <select
          id="insp-loopback"
          value={step.loopback ?? ''}
          onChange={(e) =>
            dispatch({
              type: 'SET_LOOPBACK',
              phaseId: phase.id,
              stepId: step.id,
              loopback: e.target.value === '' ? null : e.target.value,
            })
          }
          style={inputStyle}
          data-testid="inspector-loopback-select"
        >
          <option value="">(none)</option>
          {samePhaseTargets.map((s) => (
            <option key={s.id} value={s.id}>{s.name} · {s.id}</option>
          ))}
        </select>
        <p style={{ marginTop: 6, fontSize: 9.5, color: 'var(--color-text-tertiary)' }}>
          Intra-phase only — loop back to another step in <b>{phase.label}</b>.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MCP tab
// ---------------------------------------------------------------------------

function McpTab({ phase, step, dispatch }: TabProps) {
  return (
    <div>
      <h3 style={{ ...labelStyle, marginBottom: 10 }}>Tools / MCP whitelist</h3>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {MCP_OPTIONS.map((m) => {
          const on = step.mcps.includes(m);
          return (
            <button
              key={m}
              type="button"
              onClick={() => dispatch({ type: 'TOGGLE_MCP', phaseId: phase.id, stepId: step.id, mcp: m })}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '6px 0',
                fontSize: 10.5,
                fontFamily: 'inherit',
                background: 'transparent',
                border: 0,
                borderBottom: '1px dotted var(--color-border-primary)',
                color: 'var(--color-text-primary)',
                cursor: 'pointer',
                width: '100%',
                textAlign: 'left',
              }}
              data-testid={`inspector-mcp-${m}`}
              aria-pressed={on}
            >
              <span style={{ fontWeight: on ? 600 : 400 }}>{m}</span>
              <span
                style={{
                  width: 22,
                  height: 12,
                  border: '1px solid var(--color-text-primary)',
                  background: on ? 'var(--color-text-primary)' : 'var(--color-input-bg)',
                  position: 'relative',
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    content: '',
                    position: 'absolute',
                    top: 1,
                    left: on ? 11 : 1,
                    width: 8,
                    height: 8,
                    background: on ? 'var(--color-bg-primary)' : 'var(--color-status-error)',
                  }}
                />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared toggle row (optional / human)
// ---------------------------------------------------------------------------

function ToggleRow({
  label,
  checked,
  onToggle,
  testId,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '4px 0',
        fontSize: 10.5,
        fontFamily: 'inherit',
        background: 'transparent',
        border: 0,
        color: 'var(--color-text-primary)',
        cursor: 'pointer',
        width: '100%',
        textAlign: 'left',
      }}
      data-testid={testId}
      aria-pressed={checked}
    >
      <span style={{ fontWeight: checked ? 600 : 400 }}>{label}</span>
      <span
        style={{
          width: 22,
          height: 12,
          border: '1px solid var(--color-text-primary)',
          background: checked ? 'var(--color-text-primary)' : 'var(--color-input-bg)',
          position: 'relative',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 1,
            left: checked ? 11 : 1,
            width: 8,
            height: 8,
            background: checked ? 'var(--color-bg-primary)' : 'var(--color-status-error)',
          }}
        />
      </span>
    </button>
  );
}
