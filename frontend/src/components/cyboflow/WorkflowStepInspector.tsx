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
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { effectiveMaxConcurrency } from '../../../../shared/types/workflows';
import type {
  FanOutInnerStep,
  WorkflowAgentConfig,
  WorkflowAgentCustomCopy,
  WorkflowDefinition,
  WorkflowPhase,
  WorkflowStep,
} from '../../../../shared/types/workflows';
import { SPRINT_BATCH_CAP } from '../../../../shared/types/sprintBatch';
import { AGENT_MODEL_ALIASES, AGENT_MODEL_LABELS } from '../../../../shared/types/agents';
import type { AgentEntry, AgentModelAlias } from '../../../../shared/types/agents';
import { HUMAN_GATE_AGENT, resolveStepAgentKey } from '../../../../shared/types/agentIdentity';
import { CLI_TOOLS } from '../../../../shared/types/cliTools';
import type { CliTool } from '../../../../shared/types/cliTools';
import type { McpEntry } from '../../../../shared/types/integrations';
import { trpc } from '../../trpc/client';
import type { WorkflowEditorAction, WorkflowEditorState } from '../../hooks/useWorkflowEditorState';
import { AGENT_OPTIONS, MCP_OPTIONS } from './workflowEditorOptions';

type InspectorTab = 'step' | 'agent' | 'mcp';

export interface WorkflowStepInspectorProps {
  definition: WorkflowDefinition;
  selectedStepId: string | null;
  selectedFanOutInner: WorkflowEditorState['selectedFanOutInner'];
  dispatch: React.Dispatch<WorkflowEditorAction>;
  /**
   * The editor project's CUSTOM agent keys (bare, e.g. `my-helper`), merged into
   * the AGENT-tab <select> so a custom-flow step can bind one from the dropdown
   * instead of free-typing the key. Optional — defaults to none (built-in flows
   * use prose, not step bindings, so the list is only effective in custom flows).
   */
  customAgentKeys?: string[];
  /**
   * The FULL effective agent catalogue (builtins + overrides + customs) for the
   * editor project, threaded from the modal's `agents.list` fetch. Drives the
   * per-workflow-agent config section (model pin + read-only/customizable agent
   * body). Optional — defaults to none, which renders the "no predefined agent"
   * note for every bound key.
   */
  agentEntries?: AgentEntry[];
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

function findFanOutInner(
  definition: WorkflowDefinition,
  selection: WorkflowEditorState['selectedFanOutInner'],
): { phase: WorkflowPhase; step: WorkflowStep; inner: FanOutInnerStep; innerIndex: number } | null {
  if (selection === null) return null;
  const found = findStep(definition, selection.stepId);
  const inner = found?.step.fanOut?.inner[selection.innerIndex];
  if (found === null || inner === undefined) return null;
  return { ...found, inner, innerIndex: selection.innerIndex };
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

function innerDisplayName(inner: FanOutInnerStep): string {
  return inner.name != null && inner.name.trim().length > 0 ? inner.name : inner.id;
}

export function WorkflowStepInspector({
  definition,
  selectedStepId,
  selectedFanOutInner,
  dispatch,
  customAgentKeys = [],
  agentEntries = [],
}: WorkflowStepInspectorProps) {
  const [tab, setTab] = useState<InspectorTab>('step');
  const foundInner = findFanOutInner(definition, selectedFanOutInner);
  const found = findStep(definition, selectedStepId);
  const agentConfigs = definition.agentConfigs;

  if (foundInner !== null) {
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
        <InnerFanOutInspector
          phase={foundInner.phase}
          step={foundInner.step}
          inner={foundInner.inner}
          innerIndex={foundInner.innerIndex}
          dispatch={dispatch}
          customAgentKeys={customAgentKeys}
          agentEntries={agentEntries}
          agentConfigs={agentConfigs}
        />
      </div>
    );
  }

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
          <StepTab phase={found.phase} step={found.step} dispatch={dispatch} customAgentKeys={customAgentKeys} />
        ) : tab === 'agent' ? (
          <AgentTab
            phase={found.phase}
            step={found.step}
            dispatch={dispatch}
            customAgentKeys={customAgentKeys}
            agentEntries={agentEntries}
            agentConfigs={agentConfigs}
          />
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

function agentOptionsFor(agent: string, customAgentKeys: readonly string[]) {
  const builtinOptions = AGENT_OPTIONS as readonly string[];
  const extraCustomKeys = customAgentKeys.filter((k) => !builtinOptions.includes(k));
  const agentOptions = [...builtinOptions, ...extraCustomKeys];
  const customKeySet = new Set(extraCustomKeys);
  const agentInList = agentOptions.includes(agent);
  return { agentOptions, customKeySet, agentInList };
}

function InnerFanOutInspector({
  phase,
  step,
  inner,
  innerIndex,
  dispatch,
  customAgentKeys,
  agentEntries,
  agentConfigs,
}: {
  phase: WorkflowPhase;
  step: WorkflowStep;
  inner: FanOutInnerStep;
  innerIndex: number;
  dispatch: React.Dispatch<WorkflowEditorAction>;
  customAgentKeys: readonly string[];
  agentEntries: readonly AgentEntry[];
  agentConfigs: Record<string, WorkflowAgentConfig> | undefined;
}) {
  const { agentOptions, customKeySet, agentInList } = agentOptionsFor(inner.agent, customAgentKeys);
  const siblingTargets = step.fanOut?.inner
    .map((candidate, idx) => ({ candidate, idx }))
    .filter(({ idx }) => idx !== innerIndex) ?? [];

  return (
    <>
      <div
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--color-border-primary)',
          background: 'rgba(201,100,66,0.05)',
        }}
      >
        <div
          style={{
            fontSize: 9,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: 'var(--color-status-error)',
            fontWeight: 700,
          }}
        >
          ⇄ Fan-out inner · {phase.label} · {step.id}
        </div>
        <div style={{ marginTop: 5, fontSize: 9.5, color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
          Edits one persisted <b>FanOutInnerStep</b>. Runtime lane loopback is reserved.
        </div>
      </div>
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '14px 16px',
          fontSize: 11,
          lineHeight: 1.45,
          color: 'var(--color-text-primary)',
        }}
        data-testid="inspector-fanout-inner-editor"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={labelStyle} htmlFor="insp-inner-name">name</label>
            <input
              id="insp-inner-name"
              type="text"
              value={inner.name ?? ''}
              onChange={(e) =>
                dispatch({
                  type: 'SET_FANOUT_INNER_FIELD',
                  phaseId: phase.id,
                  stepId: step.id,
                  innerIndex,
                  field: 'name',
                  value: e.target.value,
                })
              }
              style={inputStyle}
              data-testid="inspector-fanout-inner-name-input"
            />
          </div>

          <div>
            <label style={labelStyle} htmlFor="insp-inner-id">id</label>
            <FanOutInnerIdInput
              id="insp-inner-id"
              value={inner.id}
              onCommit={(value) =>
                dispatch({
                  type: 'SET_FANOUT_INNER_FIELD',
                  phaseId: phase.id,
                  stepId: step.id,
                  innerIndex,
                  field: 'id',
                  value,
                })
              }
              style={inputStyle}
              testId="inspector-fanout-inner-id-input"
            />
          </div>

          <div>
            <label style={labelStyle} htmlFor="insp-inner-agent">agent</label>
            <select
              id="insp-inner-agent"
              value={inner.agent}
              onChange={(e) =>
                dispatch({
                  type: 'SET_FANOUT_INNER_FIELD',
                  phaseId: phase.id,
                  stepId: step.id,
                  innerIndex,
                  field: 'agent',
                  value: e.target.value,
                })
              }
              style={inputStyle}
              data-testid="inspector-fanout-inner-agent-select"
            >
              {!agentInList && inner.agent.length > 0 && (
                <option value={inner.agent}>{inner.agent} (custom)</option>
              )}
              {agentOptions.map((a) => (
                <option key={a} value={a}>
                  {customKeySet.has(a) ? `${a} (custom)` : a}
                </option>
              ))}
            </select>
          </div>

          <AgentConfigSection
            variant="inner"
            // Key the config by the CANONICAL agent key (the same key the canvas +
            // run-side overlay use), not the raw step label — a legacy label like
            // 'executor' resolves to 'implement'. `?? inner.agent` preserves the
            // human-gate early-return (resolveStepAgentKey returns null for it).
            agentKey={resolveStepAgentKey(inner.id, inner.agent) ?? inner.agent}
            agentEntries={agentEntries}
            agentConfigs={agentConfigs}
            dispatch={dispatch}
          />

          <ToggleRow
            label="optional"
            checked={inner.optional === true}
            onToggle={() =>
              dispatch({
                type: 'TOGGLE_FANOUT_INNER_OPTIONAL',
                phaseId: phase.id,
                stepId: step.id,
                innerIndex,
              })
            }
            testId="inspector-fanout-inner-optional-toggle"
          />

          <div>
            <label style={labelStyle} htmlFor="insp-inner-loopback">loopback</label>
            <select
              id="insp-inner-loopback"
              value={inner.loopback ?? ''}
              onChange={(e) =>
                dispatch({
                  type: 'SET_FANOUT_INNER_LOOPBACK',
                  phaseId: phase.id,
                  stepId: step.id,
                  innerIndex,
                  loopback: e.target.value === '' ? null : e.target.value,
                })
              }
              style={inputStyle}
              data-testid="inspector-fanout-inner-loopback-select"
            >
              <option value="">(none)</option>
              {siblingTargets.map(({ candidate }) => (
                <option key={candidate.id} value={candidate.id}>
                  {innerDisplayName(candidate)} · {candidate.id}
                </option>
              ))}
            </select>
            <p
              style={{ marginTop: 6, fontSize: 9.5, color: 'var(--color-text-tertiary)' }}
              data-testid="inspector-fanout-inner-loopback-note"
            >
              Re-delegates this step on orchestrated lanes. Programmatic runs honor it only for visual-verify.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

function StepTab({ phase, step, dispatch, customAgentKeys }: TabProps & { customAgentKeys: readonly string[] }) {
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

      <FanOutSection phase={phase} step={step} dispatch={dispatch} customAgentKeys={customAgentKeys} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fan-out (parallel per-item) editor — lives under the STEP tab
// ---------------------------------------------------------------------------

/**
 * Toggle + editor for `step.fanOut`. The master toggle flips the template
 * between parallel (default cap, maxConcurrency absent) and serial
 * (maxConcurrency: 1) — it never deletes `fanOut`; a fresh template is only
 * seeded the first time a step with no `fanOut` is toggled on. The "remove
 * fan-out" affordance (REMOVE_STEP_FANOUT) is the only way to drop the
 * template entirely. Whenever a template is present (serial or parallel) the
 * editor stays open — items still walk the inner chain one at a time when
 * serial. The server zod schema (fanOutSchema) is authoritative on save —
 * this stays plain TS and never validates.
 */
function FanOutSection({
  phase,
  step,
  dispatch,
  customAgentKeys,
}: TabProps & { customAgentKeys: readonly string[] }): ReactElement {
  const fanOut = step.fanOut;
  const hasFanOut = fanOut !== undefined;
  const maxConcurrency = fanOut !== undefined ? effectiveMaxConcurrency(fanOut) : null;
  const isParallel = maxConcurrency !== null && maxConcurrency > 1;
  const unsupportedOver = fanOut !== undefined && fanOut.over !== 'tasks';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        paddingTop: 12,
        borderTop: '1px dotted var(--color-border-primary)',
      }}
      data-testid="inspector-fanout-section"
    >
      <ToggleRow
        label="fan-out (parallel per-item)"
        checked={isParallel}
        onToggle={() =>
          dispatch({ type: 'SET_STEP_FANOUT', phaseId: phase.id, stepId: step.id, enabled: !isParallel })
        }
        testId="inspector-toggle-fanout"
      />

      {!hasFanOut && (
        <p
          style={{ margin: 0, fontSize: 9.5, color: 'var(--color-text-tertiary)', lineHeight: 1.45 }}
          data-testid="inspector-fanout-off-note"
        >
          This step runs once until a fan-out template is added.
        </p>
      )}

      {hasFanOut && !isParallel && (
        <p
          style={{ margin: 0, fontSize: 9.5, color: 'var(--color-text-tertiary)', lineHeight: 1.45 }}
          data-testid="inspector-fanout-serial-note"
        >
          Serial: items run one at a time through the chain. Enable to run up to the concurrency cap in parallel.
        </p>
      )}

      {hasFanOut && fanOut !== undefined && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="inspector-fanout-editor">
          <div>
            <label style={labelStyle} htmlFor="insp-fanout-over">over (item source)</label>
            <select
              id="insp-fanout-over"
              value={fanOut.over}
              onChange={() =>
                dispatch({ type: 'SET_FANOUT_OVER', phaseId: phase.id, stepId: step.id })
              }
              style={inputStyle}
              data-testid="inspector-fanout-over-input"
            >
              {unsupportedOver && (
                <option value={fanOut.over}>{fanOut.over} (unsupported)</option>
              )}
              <option value="tasks">tasks</option>
            </select>
            <p style={{ marginTop: 6, fontSize: 9.5, color: 'var(--color-text-tertiary)' }}>
              {unsupportedOver
                ? 'Unsupported item source — switch to tasks to run fan-out.'
                : 'Drives both execution planes — orchestrated runs receive these instructions in their prompt; programmatic runs are host-driven.'}
            </p>
          </div>

          <div>
            <label style={labelStyle} htmlFor="insp-fanout-max-concurrency">max concurrency</label>
            <input
              id="insp-fanout-max-concurrency"
              type="number"
              min={1}
              step={1}
              value={effectiveMaxConcurrency(fanOut)}
              onChange={(e) =>
                dispatch({
                  type: 'SET_FANOUT_MAX_CONCURRENCY',
                  phaseId: phase.id,
                  stepId: step.id,
                  value: Number.parseInt(e.target.value, 10) || 1,
                })
              }
              style={inputStyle}
              data-testid="inspector-fanout-max-concurrency"
            />
            <p style={{ marginTop: 6, fontSize: 9.5, color: 'var(--color-text-tertiary)' }}>
              Items dispatched at once. Default when unset: {SPRINT_BATCH_CAP}. 1 = serial.
            </p>
          </div>

          <div>
            <label style={labelStyle}>inner chain (per item)</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {fanOut.inner.map((inner, idx) => {
                const { agentOptions, customKeySet, agentInList } = agentOptionsFor(inner.agent, customAgentKeys);
                return (
                <div
                  key={idx}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    padding: '8px',
                    border: '1px solid var(--color-border-primary)',
                    background: 'var(--color-bg-primary)',
                  }}
                  data-testid={`inspector-fanout-inner-${idx}`}
                >
                  <input
                    type="text"
                    value={inner.name ?? ''}
                    onChange={(e) =>
                      dispatch({
                        type: 'SET_FANOUT_INNER_FIELD',
                        phaseId: phase.id,
                        stepId: step.id,
                        innerIndex: idx,
                        field: 'name',
                        value: e.target.value,
                      })
                    }
                    placeholder="name (lane label)"
                    style={inputStyle}
                    data-testid={`inspector-fanout-inner-name-${idx}`}
                  />
                  <FanOutInnerIdInput
                    value={inner.id}
                    onCommit={(value) =>
                      dispatch({
                        type: 'SET_FANOUT_INNER_FIELD',
                        phaseId: phase.id,
                        stepId: step.id,
                        innerIndex: idx,
                        field: 'id',
                        value,
                      })
                    }
                    placeholder="id"
                    style={inputStyle}
                    testId={`inspector-fanout-inner-id-${idx}`}
                  />
                  <select
                    value={inner.agent}
                    onChange={(e) =>
                      dispatch({
                        type: 'SET_FANOUT_INNER_FIELD',
                        phaseId: phase.id,
                        stepId: step.id,
                        innerIndex: idx,
                        field: 'agent',
                        value: e.target.value,
                      })
                    }
                    style={inputStyle}
                    data-testid={`inspector-fanout-inner-agent-${idx}`}
                  >
                    {!agentInList && inner.agent.length > 0 && (
                      <option value={inner.agent}>{inner.agent} (custom)</option>
                    )}
                    {agentOptions.map((a) => (
                      <option key={a} value={a}>
                        {customKeySet.has(a) ? `${a} (custom)` : a}
                      </option>
                    ))}
                  </select>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <ToggleRow
                      label="optional"
                      checked={inner.optional === true}
                      onToggle={() =>
                        dispatch({
                          type: 'TOGGLE_FANOUT_INNER_OPTIONAL',
                          phaseId: phase.id,
                          stepId: step.id,
                          innerIndex: idx,
                        })
                      }
                      testId={`inspector-fanout-inner-optional-${idx}`}
                    />
                    <button
                      type="button"
                      onClick={() =>
                        dispatch({
                          type: 'REMOVE_FANOUT_INNER',
                          phaseId: phase.id,
                          stepId: step.id,
                          innerIndex: idx,
                        })
                      }
                      disabled={fanOut.inner.length <= 1}
                      style={{
                        fontFamily: 'inherit',
                        fontSize: 9,
                        letterSpacing: '0.14em',
                        textTransform: 'uppercase',
                        background: 'transparent',
                        border: '1px solid var(--color-text-primary)',
                        color: 'var(--color-text-primary)',
                        padding: '3px 8px',
                        cursor: fanOut.inner.length <= 1 ? 'not-allowed' : 'pointer',
                        opacity: fanOut.inner.length <= 1 ? 0.4 : 1,
                        flexShrink: 0,
                      }}
                      data-testid={`inspector-fanout-inner-remove-${idx}`}
                    >
                      remove
                    </button>
                  </div>
                </div>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => dispatch({ type: 'ADD_FANOUT_INNER', phaseId: phase.id, stepId: step.id })}
              style={{
                marginTop: 8,
                fontFamily: 'inherit',
                fontSize: 9.5,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                background: 'transparent',
                border: '1px dashed var(--color-text-primary)',
                color: 'var(--color-text-primary)',
                padding: '5px 0',
                width: '100%',
                cursor: 'pointer',
              }}
              data-testid="inspector-fanout-inner-add"
            >
              + add inner step
            </button>
          </div>

          <button
            type="button"
            onClick={() => dispatch({ type: 'REMOVE_STEP_FANOUT', phaseId: phase.id, stepId: step.id })}
            style={{
              alignSelf: 'flex-start',
              marginTop: 2,
              fontFamily: 'inherit',
              fontSize: 9,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              background: 'transparent',
              border: 0,
              color: 'var(--color-text-tertiary)',
              padding: 0,
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
            data-testid="inspector-fanout-remove"
          >
            remove fan-out
          </button>
        </div>
      )}
    </div>
  );
}

function FanOutInnerIdInput({
  id,
  value,
  onCommit,
  placeholder,
  style,
  testId,
}: {
  id?: string;
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  style: React.CSSProperties;
  testId: string;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  function commit(): void {
    if (draft !== value) onCommit(draft);
    // Resync unconditionally: the reducer kebab-normalizes the committed draft,
    // and when normalization is a fixed point (e.g. 'ITEM' → current id 'item')
    // the `value` prop never changes, so the [value] effect alone would leave a
    // stale un-normalized draft on screen.
    setDraft(value);
  }

  return (
    <input
      id={id}
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      placeholder={placeholder}
      style={style}
      data-testid={testId}
    />
  );
}

// ---------------------------------------------------------------------------
// AGENT tab
// ---------------------------------------------------------------------------

function AgentTab({
  phase,
  step,
  dispatch,
  customAgentKeys,
  agentEntries,
  agentConfigs,
}: TabProps & {
  customAgentKeys: readonly string[];
  agentEntries: readonly AgentEntry[];
  agentConfigs: Record<string, WorkflowAgentConfig> | undefined;
}) {
  // Merge the static suggestion list with the project's CUSTOM agent keys so a
  // custom-flow step can bind a project custom agent from the dropdown rather
  // than free-typing its key. Built-ins come first, then any custom key not
  // already present (deduped, order-preserving). Dispatch already accepts any
  // agent string — the overlay writer emits a cyboflow-<key>.md for every
  // effective custom — so this only widens what the picker can REPRESENT.
  const builtinOptions = AGENT_OPTIONS as readonly string[];
  const extraCustomKeys = customAgentKeys.filter((k) => !builtinOptions.includes(k));
  const agentOptions = [...builtinOptions, ...extraCustomKeys];
  const customKeySet = new Set(extraCustomKeys);
  // Free-text agents: if the current agent isn't in the merged list, surface it
  // as an extra option so the <select> can still represent it.
  const agentInList = agentOptions.includes(step.agent);
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
          {agentOptions.map((a) => (
            <option key={a} value={a}>
              {customKeySet.has(a) ? `${a} (custom)` : a}
            </option>
          ))}
        </select>
      </div>

      <AgentConfigSection
        variant="agent"
        // Key the config by the CANONICAL agent key (the same key the canvas +
        // run-side overlay use), not the raw step label — a legacy label like
        // 'executor' resolves to 'implement'. `?? step.agent` preserves the
        // human-gate early-return (resolveStepAgentKey returns null for it).
        agentKey={resolveStepAgentKey(step.id, step.agent) ?? step.agent}
        agentEntries={agentEntries}
        agentConfigs={agentConfigs}
        dispatch={dispatch}
      />

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
// Workflow-scoped agent config — model pin + read-only / customizable body.
// Shared by the AGENT tab and the fan-out inner inspector; scope is per
// WORKFLOW-AGENT (keyed by agent key), NOT per step, so a config edited here
// applies to every step (including fan-out inner steps) binding this agent.
// ---------------------------------------------------------------------------

const hintStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 9.5,
  color: 'var(--color-text-tertiary)',
  lineHeight: 1.45,
};

const microLabelStyle: React.CSSProperties = {
  fontSize: 9,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: 'var(--color-text-secondary)',
};

/** Read-only / editable system-prompt block (shared dimensions + rail aesthetic). */
const promptBlockStyle: React.CSSProperties = {
  maxHeight: 220,
  overflow: 'auto',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 10,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  border: '1px solid var(--color-border-primary)',
  background: 'var(--color-bg-primary)',
  padding: '8px',
  color: 'var(--color-text-primary)',
  boxSizing: 'border-box',
};

const sectionButtonStyle: React.CSSProperties = {
  fontFamily: 'inherit',
  fontSize: 9.5,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  background: 'transparent',
  border: '1px solid var(--color-text-primary)',
  color: 'var(--color-text-primary)',
  padding: '5px 10px',
  cursor: 'pointer',
  alignSelf: 'flex-start',
};

/** The AgentConfigSection outer container (dotted top rule + column layout). */
const sectionContainerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  paddingTop: 12,
  borderTop: '1px dotted var(--color-border-primary)',
};

function AgentConfigSection({
  variant,
  agentKey,
  agentEntries,
  agentConfigs,
  dispatch,
}: {
  variant: 'agent' | 'inner';
  agentKey: string;
  agentEntries: readonly AgentEntry[];
  agentConfigs: Record<string, WorkflowAgentConfig> | undefined;
  dispatch: React.Dispatch<WorkflowEditorAction>;
}) {
  // The human gate is not an agent (no model to pin, no body to edit).
  if (agentKey === HUMAN_GATE_AGENT) return null;

  const isInner = variant === 'inner';
  const config = agentConfigs?.[agentKey];
  const entry = agentEntries.find((e) => e.agentKey === agentKey);
  const sectionTestId = isInner ? 'inspector-inner-agent-config' : 'inspector-agent-config';

  // A free-typed unknown key has no effective agent to bind a config onto — the
  // run-side overlay only maps configs onto EXISTING effective agents, so a model
  // pinned here could never apply. Show just the muted note (no model select).
  if (entry === undefined) {
    return (
      <div style={sectionContainerStyle} data-testid={sectionTestId}>
        <p style={hintStyle} data-testid={`${sectionTestId}-unknown`}>
          No predefined agent exists for this key.
        </p>
      </div>
    );
  }

  const modelId = isInner ? 'insp-inner-model' : 'insp-model';
  const modelTestId = isInner ? 'inspector-inner-model-select' : 'inspector-model-select';
  const hintTestId = isInner ? 'inspector-inner-model-hint' : 'inspector-model-hint';

  const selectedModel: AgentModelAlias | '' = config?.model ?? '';
  const inheriting = config?.model === undefined;
  const pinLabel = entry.model != null ? AGENT_MODEL_LABELS[entry.model] : null;
  const inheritSentence =
    pinLabel !== null ? `Inherits ${pinLabel} (agent setting).` : 'Inherits the run model.';

  return (
    <div style={sectionContainerStyle} data-testid={sectionTestId}>
      {/* ── Model pin ─────────────────────────────────────────────────────── */}
      <div>
        <label style={labelStyle} htmlFor={modelId}>model</label>
        <select
          id={modelId}
          value={selectedModel}
          onChange={(e) =>
            dispatch({
              type: 'SET_AGENT_MODEL',
              agentKey,
              model: e.target.value === '' ? null : (e.target.value as AgentModelAlias),
            })
          }
          style={inputStyle}
          data-testid={modelTestId}
        >
          <option value="">(inherit)</option>
          {AGENT_MODEL_ALIASES.map((alias) => (
            <option key={alias} value={alias}>{AGENT_MODEL_LABELS[alias]}</option>
          ))}
        </select>
        <p style={hintStyle} data-testid={hintTestId}>
          {inheriting ? `${inheritSentence} ` : ''}Applies to every step using <b>{agentKey}</b> in this flow.
        </p>
      </div>

      {/* ── Agent definition (read-only view, or workflow-scoped custom copy) ─ */}
      {config?.custom === undefined ? (
        <AgentDefinitionReadOnly agentKey={agentKey} entry={entry} dispatch={dispatch} />
      ) : (
        <AgentDefinitionEditable agentKey={agentKey} custom={config.custom} dispatch={dispatch} />
      )}
    </div>
  );
}

/** The base agent body, verbatim + read-only, with a "customize for this flow" CTA. */
function AgentDefinitionReadOnly({
  agentKey,
  entry,
  dispatch,
}: {
  agentKey: string;
  entry: AgentEntry;
  dispatch: React.Dispatch<WorkflowEditorAction>;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={microLabelStyle}>agent definition</div>
      <p style={{ margin: 0, fontSize: 10.5, color: 'var(--color-text-primary)' }}>{entry.description}</p>

      <div>
        <span style={microLabelStyle}>tools </span>
        <span style={{ fontSize: 10.5 }}>{entry.tools.length > 0 ? entry.tools.join(', ') : '(none)'}</span>
      </div>
      <div>
        <span style={microLabelStyle}>mcps </span>
        <span style={{ fontSize: 10.5 }}>{entry.enabledMcps.length > 0 ? entry.enabledMcps.join(', ') : '(none)'}</span>
      </div>

      <div style={promptBlockStyle} data-testid="inspector-agent-prompt">{entry.systemPrompt}</div>

      <button
        type="button"
        onClick={() =>
          dispatch({
            type: 'SET_AGENT_CUSTOM',
            agentKey,
            custom: {
              description: entry.description,
              systemPrompt: entry.systemPrompt,
              tools: [...entry.tools],
              enabledMcps: [...entry.enabledMcps],
            },
          })
        }
        style={sectionButtonStyle}
        data-testid="inspector-agent-customize"
      >
        Customize for this flow
      </button>
    </div>
  );
}

/** The editable workflow-scoped custom copy: description / prompt / tools / mcps + revert. */
function AgentDefinitionEditable({
  agentKey,
  custom,
  dispatch,
}: {
  agentKey: string;
  custom: WorkflowAgentCustomCopy;
  dispatch: React.Dispatch<WorkflowEditorAction>;
}) {
  const mcpOptions = useMcpOptions(custom.enabledMcps);
  const toolsSet = new Set<string>(custom.tools);
  const mcpSet = new Set(custom.enabledMcps);

  const toggleTool = (tool: CliTool) => {
    const next = toolsSet.has(tool)
      ? custom.tools.filter((t) => t !== tool)
      : [...custom.tools, tool];
    dispatch({ type: 'SET_AGENT_CUSTOM_FIELD', agentKey, field: 'tools', value: next });
  };
  const toggleMcp = (server: string) => {
    const next = mcpSet.has(server)
      ? custom.enabledMcps.filter((m) => m !== server)
      : [...custom.enabledMcps, server];
    dispatch({ type: 'SET_AGENT_CUSTOM_FIELD', agentKey, field: 'enabledMcps', value: next });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={microLabelStyle}>agent definition</span>
        <span
          style={{
            fontSize: 8.5,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'var(--color-status-info)',
            border: '1px solid var(--color-status-info)',
            padding: '1px 5px',
          }}
          data-testid="inspector-agent-workflow-copy-badge"
        >
          workflow copy
        </span>
      </div>

      <p style={hintStyle} data-testid="inspector-agent-workflow-scope-hint">
        Applies to every step using <b>{agentKey}</b> in this flow.
      </p>

      <div>
        <label style={labelStyle} htmlFor="insp-agent-desc">description</label>
        <input
          id="insp-agent-desc"
          type="text"
          value={custom.description}
          onChange={(e) =>
            dispatch({ type: 'SET_AGENT_CUSTOM_FIELD', agentKey, field: 'description', value: e.target.value })
          }
          style={inputStyle}
          data-testid="inspector-agent-description-input"
        />
      </div>

      <div>
        <label style={labelStyle} htmlFor="insp-agent-prompt">system prompt</label>
        <textarea
          id="insp-agent-prompt"
          value={custom.systemPrompt}
          onChange={(e) =>
            dispatch({ type: 'SET_AGENT_CUSTOM_FIELD', agentKey, field: 'systemPrompt', value: e.target.value })
          }
          style={{ ...promptBlockStyle, width: '100%', minHeight: 140, resize: 'vertical' }}
          data-testid="inspector-agent-prompt"
        />
      </div>

      <div>
        <div style={{ ...microLabelStyle, marginBottom: 6 }}>tools</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }} data-testid="inspector-agent-tools">
          {CLI_TOOLS.map((tool) => (
            <ChipToggle
              key={tool}
              label={tool}
              on={toolsSet.has(tool)}
              onToggle={() => toggleTool(tool)}
              testId={`inspector-agent-tool-${tool}`}
            />
          ))}
        </div>
      </div>

      <div>
        <div style={{ ...microLabelStyle, marginBottom: 6 }}>mcps</div>
        {mcpOptions.length === 0 ? (
          <p style={hintStyle} data-testid="inspector-agent-mcps-empty">No MCP servers are configured.</p>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }} data-testid="inspector-agent-mcps">
            {mcpOptions.map((server) => (
              <ChipToggle
                key={server}
                label={server}
                on={mcpSet.has(server)}
                onToggle={() => toggleMcp(server)}
                testId={`inspector-agent-mcp-${server}`}
              />
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => dispatch({ type: 'SET_AGENT_CUSTOM', agentKey, custom: null })}
        style={sectionButtonStyle}
        data-testid="inspector-agent-revert"
      >
        Revert to predefined
      </button>
    </div>
  );
}

/**
 * The selectable MCP server names — the CLI catalogue (`mcps.list`) deduped by
 * name minus the single-writer `cyboflow` server, unioned with any already-
 * granted server so a stale grant stays visible. Mirrors AgentEditorForm's
 * source of truth. A fetch failure degrades to just the granted servers.
 */
function useMcpOptions(enabledMcps: readonly string[]): string[] {
  const [mcps, setMcps] = useState<McpEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await trpc.cyboflow.mcps.list.query();
        if (!cancelled) setMcps(list);
      } catch {
        if (!cancelled) setMcps([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const names = new Set<string>();
  for (const entry of mcps) {
    if (entry.name === 'cyboflow' || entry.name.startsWith('cyboflow_')) continue;
    names.add(entry.name);
  }
  for (const server of enabledMcps) names.add(server);
  return Array.from(names).sort();
}

/** Compact paper-token toggle chip (tools / mcps). */
function ChipToggle({
  label,
  on,
  onToggle,
  testId,
}: {
  label: string;
  on: boolean;
  onToggle: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      style={{
        fontFamily: 'inherit',
        fontSize: 9.5,
        letterSpacing: '0.04em',
        padding: '3px 7px',
        border: '1px solid var(--color-text-primary)',
        background: on ? 'var(--color-text-primary)' : 'transparent',
        color: on ? 'var(--color-bg-primary)' : 'var(--color-text-primary)',
        cursor: 'pointer',
        borderRadius: 0,
      }}
      data-testid={testId}
    >
      {label}
    </button>
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
