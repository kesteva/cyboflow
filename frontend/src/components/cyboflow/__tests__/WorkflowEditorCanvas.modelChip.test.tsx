/**
 * WorkflowEditorCanvas — "model" step-card meta-row tests (Lane E of the
 * workflow-scoped agent-config feature).
 *
 * Renders WorkflowEditorCanvas directly (no reducer/store needed — the canvas
 * is a pure presentational component over `definition` + `agentModelPins`),
 * mirroring the plain-render setup in WorkflowCanvasEdges.test.tsx.
 *
 * Behaviors verified:
 *   (a) A workflow `agentConfigs[agentKey].model` override wins and is styled
 *       distinctly (var(--color-status-info), NOT the loop row's error red).
 *   (b) Absent an override, the agent's Agents-pane `agentModelPins` entry is
 *       shown with normal <b> styling.
 *   (c) Absent both, the literal "run model" renders in tertiary + italic.
 *   (d) The human-gate step renders no model row at all.
 *   (e) A step whose agent carries a workflow `custom` copy gets the asterisk
 *       marker; agents without one do not.
 *   (f) Fan-out inner cards apply the identical precedence + marker rules.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { WorkflowEditorCanvas } from '../WorkflowEditorCanvas';
import type { WorkflowDefinition } from '../../../../../shared/types/workflows';
import { AGENT_MODEL_LABELS, type AgentModelAlias } from '../../../../../shared/types/agents';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const DEFINITION: WorkflowDefinition = {
  id: 'sprint',
  agentConfigs: {
    // (a) workflow override — beats any pin.
    implement: { model: 'opus' },
    // (e) customized copy, no model override — marker only.
    'code-review': {
      custom: {
        description: 'workflow-scoped copy',
        systemPrompt: 'You are a customized code reviewer for this flow.',
        tools: ['Read', 'Edit'],
        enabledMcps: [],
      },
    },
  },
  phases: [
    {
      id: 'plan',
      label: 'Plan',
      color: '#3b6dd6',
      steps: [
        // (c) no override, no pin → literal "run model"
        { id: 'context-step', name: 'Context', agent: 'context', mcps: [], retries: 0 },
        // (a) workflow override wins over the pin below
        { id: 'implement-step', name: 'Implement', agent: 'implement', mcps: [], retries: 2 },
        // (b) no override → falls back to the Agents-pane pin
        { id: 'review-step', name: 'Review', agent: 'sprint-review', mcps: [], retries: 1 },
        // (d) human gate — no model row at all
        { id: 'approve-step', name: 'Approve', agent: 'human', mcps: [], retries: 0, human: true },
        // (e) customized agent, no override/pin → "run model" text + asterisk marker
        { id: 'code-review-step', name: 'Code review', agent: 'code-review', mcps: [], retries: 0 },
      ],
    },
    {
      id: 'execute',
      label: 'Execute',
      color: '#c96442',
      steps: [
        {
          id: 'sprint-batch',
          name: 'Sprint batch',
          agent: 'implement',
          mcps: [],
          retries: 0,
          fanOut: {
            over: 'tasks',
            inner: [
              // (f) shares the outer 'implement' agentConfigs override
              { id: 'inner-implement', agent: 'implement', name: 'Implement' },
              // (f) falls back to the pin (no workflow override for write-tests)
              { id: 'inner-write-tests', agent: 'write-tests', name: 'Write tests' },
              // (f) customized marker parity
              { id: 'inner-code-review', agent: 'code-review', name: 'Code review' },
            ],
          },
        },
      ],
    },
  ],
};

const AGENT_MODEL_PINS: Record<string, AgentModelAlias | null> = {
  'sprint-review': 'haiku',
  'write-tests': 'sonnet',
};

function renderCanvas() {
  return render(
    <WorkflowEditorCanvas
      definition={DEFINITION}
      selectedStepId={null}
      selectedFanOutInner={null}
      dispatch={vi.fn()}
      agentModelPins={AGENT_MODEL_PINS}
    />,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowEditorCanvas — model meta row (outer step card)', () => {
  it('(a) renders the workflow agentConfigs override, styled distinctly from error red', () => {
    renderCanvas();
    const el = screen.getByTestId('editor-step-model-implement-step');
    expect(el).toHaveTextContent(AGENT_MODEL_LABELS.opus);
    expect(el).toHaveStyle({ color: 'var(--color-status-info)' });
  });

  it('(b) falls back to the Agents-pane pin label when no workflow override is set', () => {
    renderCanvas();
    const el = screen.getByTestId('editor-step-model-review-step');
    expect(el).toHaveTextContent(AGENT_MODEL_LABELS.haiku);
    expect(el).not.toHaveStyle({ color: 'var(--color-status-info)' });
  });

  it('(c) renders the literal "run model" (tertiary + italic) when neither is set', () => {
    renderCanvas();
    const el = screen.getByTestId('editor-step-model-context-step');
    expect(el).toHaveTextContent('run model');
    expect(el).toHaveStyle({ color: 'var(--color-text-tertiary)', fontStyle: 'italic' });
  });

  it('(d) skips the model row entirely for the human-gate step', () => {
    renderCanvas();
    expect(screen.queryByTestId('editor-step-model-approve-step')).toBeNull();
  });

  it('(e) marks the agent row with an asterisk only when the workflow carries a custom copy', () => {
    renderCanvas();
    const marker = screen.getByTestId('editor-step-agent-custom-code-review-step');
    expect(marker).toBeInTheDocument();
    expect(marker).toHaveAttribute('title', 'Customized for this flow');

    // No custom config on these agents → no marker.
    expect(screen.queryByTestId('editor-step-agent-custom-context-step')).toBeNull();
    expect(screen.queryByTestId('editor-step-agent-custom-implement-step')).toBeNull();
  });
});

describe('WorkflowEditorCanvas — model meta row (fan-out inner cards)', () => {
  it('(f) applies the override, pin, and marker rules identically on inner cards', () => {
    renderCanvas();

    const innerOverride = screen.getByTestId('editor-fanout-inner-model-inner-implement');
    expect(innerOverride).toHaveTextContent(AGENT_MODEL_LABELS.opus);
    expect(innerOverride).toHaveStyle({ color: 'var(--color-status-info)' });

    const innerPin = screen.getByTestId('editor-fanout-inner-model-inner-write-tests');
    expect(innerPin).toHaveTextContent(AGENT_MODEL_LABELS.sonnet);
    expect(innerPin).not.toHaveStyle({ color: 'var(--color-status-info)' });

    expect(screen.getByTestId('editor-fanout-inner-agent-custom-inner-code-review')).toBeInTheDocument();
    expect(screen.queryByTestId('editor-fanout-inner-agent-custom-inner-implement')).toBeNull();
  });

  it('(g) renders the CANONICAL agent key on inner cards for a legacy label', () => {
    // A legacy 'executor' binding resolves to canonical 'implement' — the card must
    // display the same key the config/model lookups (and the inspector) use, not the
    // raw label, or the UI would contradict where the config actually applies.
    const def: WorkflowDefinition = {
      id: 'legacy',
      agentConfigs: { implement: { model: 'opus' } },
      phases: [
        {
          id: 'exec',
          label: 'Execute',
          color: '#c96442',
          steps: [
            {
              id: 'batch',
              name: 'Batch',
              agent: 'batch-host',
              mcps: [],
              retries: 0,
              fanOut: { over: 'tasks', inner: [{ id: 'inner-legacy', agent: 'executor', name: 'Implement' }] },
            },
          ],
        },
      ],
    };
    render(
      <WorkflowEditorCanvas
        definition={def}
        selectedStepId={null}
        selectedFanOutInner={null}
        dispatch={vi.fn()}
        agentModelPins={{}}
      />,
    );

    // Canonical key shown; raw legacy label absent.
    expect(screen.getByText('implement')).toBeInTheDocument();
    expect(screen.queryByText('executor')).toBeNull();
    // And the config keyed by the canonical key drives the inner model row.
    expect(screen.getByTestId('editor-fanout-inner-model-inner-legacy')).toHaveTextContent(
      AGENT_MODEL_LABELS.opus,
    );
  });
});
