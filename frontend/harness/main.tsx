/**
 * Static smoke harness for the workflow-scoped agent configs feature — renders
 * the REAL WorkflowEditorCanvas + two REAL WorkflowStepInspector instances from
 * this worktree with a fixture definition, so the cyboflow verification queue
 * (static-render-snapshot via capturePage) can capture + judge this branch's
 * actual components without an Electron preload.
 *
 * Staged states:
 *  - canvas: 'implement' card = workflow model override (Opus 4.8, accent),
 *    'review' card = Agents-pane pin fallback (Haiku 4.5), 'context' card =
 *    'run model', human-gate card = NO model row, 'code-review' card =
 *    asterisk custom marker; fan-out inner cards incl. a legacy 'executor'
 *    binding that must display canonical 'implement'.
 *  - inspector #1 (review-step): AGENT tab, inherit model select + pin hint,
 *    read-only definition + "Customize for this flow".
 *  - inspector #2 (code-review-step): AGENT tab, customized state — "workflow
 *    copy" badge, editable prompt, tool/MCP chips, "Revert to predefined".
 */
import { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { WorkflowEditorCanvas } from '../src/components/cyboflow/WorkflowEditorCanvas';
import { WorkflowStepInspector } from '../src/components/cyboflow/WorkflowStepInspector';
import type { WorkflowDefinition } from '../../shared/types/workflows';
import type { AgentEntry, AgentModelAlias } from '../../shared/types/agents';
import '../src/index.css';

const DEFINITION: WorkflowDefinition = {
  id: 'sprint',
  agentConfigs: {
    implement: { model: 'opus' },
    'code-review': {
      custom: {
        description: 'Workflow-scoped reviewer focused on schema changes.',
        systemPrompt:
          'You are a code reviewer customized for THIS flow. Focus on migration and schema-parity risks.\n\n## Result\nReturn the verdict.',
        tools: ['Read', 'Grep'],
        enabledMcps: ['git'],
      },
    },
  },
  phases: [
    {
      id: 'plan',
      label: 'Plan',
      color: '#3b6dd6',
      steps: [
        { id: 'context-step', name: 'Context', agent: 'context', mcps: [], retries: 0 },
        { id: 'implement-step', name: 'Implement', agent: 'implement', mcps: [], retries: 2 },
        { id: 'review-step', name: 'Sprint review', agent: 'sprint-review', mcps: [], retries: 1 },
        { id: 'approve-step', name: 'Approve plan', agent: 'human', mcps: [], retries: 0, human: true },
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
              { id: 'inner-legacy', agent: 'executor', name: 'Implement (legacy label)' },
              { id: 'inner-write-tests', agent: 'write-tests', name: 'Write tests' },
            ],
          },
        },
      ],
    },
  ],
};

function entry(
  agentKey: string,
  model: AgentModelAlias | null,
  description: string,
): AgentEntry {
  return {
    agentKey,
    name: `cyboflow-${agentKey}`,
    role: 'sprint',
    description,
    systemPrompt: `You are the ${agentKey} agent. Do the work carefully and report evidence.\n\n## Result\nReturn a concise summary.`,
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    model,
    enabledMcps: agentKey === 'sprint-review' ? ['git'] : [],
    source: 'builtin',
    isCustom: false,
    isOverridden: false,
    usage: { workflowCount: 1, usedBy: [], dispatchedBy: [] },
    stats: {
      model: model === null ? 'inherits run model' : model,
      estPromptTokens: 1200,
      costUsd: null,
      lastEditedAt: null,
      toolsEnabled: 4,
      toolsTotal: 10,
    },
  };
}

const AGENT_ENTRIES: AgentEntry[] = [
  entry('context', null, 'Gathers idea context before decomposition.'),
  entry('implement', null, 'Writes the diff for a single ready task.'),
  entry('sprint-review', 'haiku', 'Cross-task taste pass over the sprint diff.'),
  entry('code-review', null, 'Inline review of the task diff.'),
  entry('write-tests', 'sonnet', 'Adds tests covering the new diff.'),
];

const AGENT_MODEL_PINS: Record<string, AgentModelAlias | null> = Object.fromEntries(
  AGENT_ENTRIES.map((e) => [e.agentKey, e.model]),
);

function Harness() {
  // The inspector defaults to its STEP tab; the smoke stages the AGENT tab by
  // clicking the real tab buttons after mount (harness-only convenience).
  useEffect(() => {
    document
      .querySelectorAll<HTMLButtonElement>('[data-testid="inspector-tab-agent"]')
      .forEach((btn) => btn.click());
  }, []);

  const noop = () => {};
  return (
    <div style={{ display: 'flex', height: '100vh', background: 'var(--color-bg-secondary)' }}>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <WorkflowEditorCanvas
          definition={DEFINITION}
          selectedStepId={null}
          selectedFanOutInner={null}
          dispatch={noop}
          agentModelPins={AGENT_MODEL_PINS}
        />
      </div>
      <WorkflowStepInspector
        definition={DEFINITION}
        selectedStepId="review-step"
        selectedFanOutInner={null}
        dispatch={noop}
        agentEntries={AGENT_ENTRIES}
      />
      <WorkflowStepInspector
        definition={DEFINITION}
        selectedStepId="code-review-step"
        selectedFanOutInner={null}
        dispatch={noop}
        agentEntries={AGENT_ENTRIES}
      />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<Harness />);
