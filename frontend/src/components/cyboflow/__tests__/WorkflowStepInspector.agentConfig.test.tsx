/**
 * WorkflowStepInspector — workflow-scoped agent config section (Lane D).
 *
 * The AGENT tab and the fan-out inner inspector both render an AgentConfigSection
 * under the agent <select>. It exposes a per-workflow-agent MODEL pin and a
 * read-only / customizable copy of the base agent body. This suite drives the
 * inspector directly with a spy dispatch (the inspector is controlled — props,
 * not internal state, decide what renders), asserting the reducer actions each
 * control fires and the inherit-hint / human-gate / unknown-key branches.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowDefinition } from '../../../../../shared/types/workflows';
import type { AgentEntry } from '../../../../../shared/types/agents';

// The customizable body's MCP chips fetch the CLI catalogue via mcps.list —
// stub it so the useMcpOptions effect resolves in jsdom.
const mockMcpsList = vi.fn();
vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      mcps: { list: { query: (...args: unknown[]) => mockMcpsList(...args) } },
    },
  },
}));

import { WorkflowStepInspector } from '../WorkflowStepInspector';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    agentKey: 'implement',
    name: 'cyboflow-implement',
    role: 'sprint',
    description: 'Implements the assigned task.',
    systemPrompt: 'You are the implement agent.\nDo the work.',
    tools: ['Read', 'Edit', 'Write'],
    model: null,
    enabledMcps: ['filesystem'],
    source: 'builtin',
    isCustom: false,
    isOverridden: false,
    usage: { workflowCount: 0, usedBy: [], dispatchedBy: [] },
    stats: {
      model: 'inherits run model',
      estPromptTokens: 0,
      costUsd: null,
      lastEditedAt: null,
      toolsEnabled: 3,
      toolsTotal: 8,
    },
    ...overrides,
  };
}

/** A single-phase definition; the second step is the human gate. */
function makeDefinition(agentConfigs?: WorkflowDefinition['agentConfigs']): WorkflowDefinition {
  return {
    id: 'sprint',
    phases: [
      {
        id: 'execute',
        label: 'Execute',
        color: '#c96442',
        steps: [
          { id: 'impl', name: 'Implement', agent: 'implement', mcps: [], retries: 0 },
          { id: 'gate', name: 'Approve', agent: 'human', mcps: [], retries: 0, human: true },
          { id: 'mystery', name: 'Mystery', agent: 'nonexistent-agent', mcps: [], retries: 0 },
        ],
      },
    ],
    ...(agentConfigs ? { agentConfigs } : {}),
  };
}

function renderInspector(opts: {
  definition: WorkflowDefinition;
  selectedStepId: string | null;
  selectedFanOutInner?: { stepId: string; innerIndex: number } | null;
  agentEntries?: AgentEntry[];
  dispatch?: ReturnType<typeof vi.fn>;
}) {
  const dispatch = opts.dispatch ?? vi.fn();
  render(
    <WorkflowStepInspector
      definition={opts.definition}
      selectedStepId={opts.selectedStepId}
      selectedFanOutInner={opts.selectedFanOutInner ?? null}
      dispatch={dispatch}
      agentEntries={opts.agentEntries ?? [makeEntry()]}
    />,
  );
  return { dispatch };
}

/** Switch the tabbed inspector to the AGENT tab (default tab is STEP). */
function openAgentTab() {
  fireEvent.click(screen.getByTestId('inspector-tab-agent'));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMcpsList.mockResolvedValue([{ name: 'filesystem' }, { name: 'git' }, { name: 'cyboflow' }]);
});

// ---------------------------------------------------------------------------
// Model pin
// ---------------------------------------------------------------------------

describe('AgentConfigSection — model pin', () => {
  it('shows the current pinned model and dispatches SET_AGENT_MODEL on change', () => {
    const { dispatch } = renderInspector({
      definition: makeDefinition({ implement: { model: 'sonnet' } }),
      selectedStepId: 'impl',
    });
    openAgentTab();

    const select = screen.getByTestId('inspector-model-select') as HTMLSelectElement;
    expect(select.value).toBe('sonnet');

    fireEvent.change(select, { target: { value: 'haiku' } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_AGENT_MODEL', agentKey: 'implement', model: 'haiku' });
  });

  it('maps the "(inherit)" option back to a null model', () => {
    const { dispatch } = renderInspector({
      definition: makeDefinition({ implement: { model: 'sonnet' } }),
      selectedStepId: 'impl',
    });
    openAgentTab();

    fireEvent.change(screen.getByTestId('inspector-model-select'), { target: { value: '' } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_AGENT_MODEL', agentKey: 'implement', model: null });
  });

  it('inherit hint reads "run model" when the agent pins nothing', () => {
    renderInspector({
      definition: makeDefinition(),
      selectedStepId: 'impl',
      agentEntries: [makeEntry({ model: null })],
    });
    openAgentTab();

    const hint = screen.getByTestId('inspector-model-hint');
    expect(hint).toHaveTextContent('Inherits the run model.');
    expect(hint).toHaveTextContent('Applies to every step using implement in this flow.');
  });

  it('inherit hint names the agent pin when the entry pins a model', () => {
    renderInspector({
      definition: makeDefinition(),
      selectedStepId: 'impl',
      agentEntries: [makeEntry({ model: 'opus' })],
    });
    openAgentTab();

    expect(screen.getByTestId('inspector-model-hint')).toHaveTextContent('Inherits Opus 4.8 (agent setting).');
  });
});

// ---------------------------------------------------------------------------
// Read-only body + customize
// ---------------------------------------------------------------------------

describe('AgentConfigSection — read-only body', () => {
  it('renders the base agent body verbatim (description, tools, mcps, full prompt)', () => {
    renderInspector({ definition: makeDefinition(), selectedStepId: 'impl' });
    openAgentTab();

    expect(screen.getByTestId('inspector-agent-prompt')).toHaveTextContent('You are the implement agent.');
    expect(screen.getByText('Implements the assigned task.')).toBeInTheDocument();
    // No workflow-copy badge until the user customizes.
    expect(screen.queryByTestId('inspector-agent-workflow-copy-badge')).toBeNull();
  });

  it('"Customize for this flow" seeds SET_AGENT_CUSTOM with the full base copy', () => {
    const { dispatch } = renderInspector({ definition: makeDefinition(), selectedStepId: 'impl' });
    openAgentTab();

    fireEvent.click(screen.getByTestId('inspector-agent-customize'));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'SET_AGENT_CUSTOM',
      agentKey: 'implement',
      custom: {
        description: 'Implements the assigned task.',
        systemPrompt: 'You are the implement agent.\nDo the work.',
        tools: ['Read', 'Edit', 'Write'],
        enabledMcps: ['filesystem'],
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Customized (editable) body
// ---------------------------------------------------------------------------

describe('AgentConfigSection — customized body', () => {
  const CUSTOM_DEF = () =>
    makeDefinition({
      implement: {
        custom: {
          description: 'Forked helper.',
          systemPrompt: 'Custom prompt body.',
          tools: ['Read'],
          enabledMcps: [],
        },
      },
    });

  it('shows the workflow-copy badge and editable fields', async () => {
    renderInspector({ definition: CUSTOM_DEF(), selectedStepId: 'impl' });
    openAgentTab();
    // Flush the useMcpOptions fetch (mcps.list) so its state update settles in act.
    await screen.findByTestId('inspector-agent-mcps');

    expect(screen.getByTestId('inspector-agent-workflow-copy-badge')).toBeInTheDocument();
    expect((screen.getByTestId('inspector-agent-prompt') as HTMLTextAreaElement).value).toBe('Custom prompt body.');
  });

  it('editing the prompt dispatches SET_AGENT_CUSTOM_FIELD', async () => {
    const { dispatch } = renderInspector({ definition: CUSTOM_DEF(), selectedStepId: 'impl' });
    openAgentTab();
    await screen.findByTestId('inspector-agent-mcps');

    fireEvent.change(screen.getByTestId('inspector-agent-prompt'), { target: { value: 'Edited body.' } });
    expect(dispatch).toHaveBeenCalledWith({
      type: 'SET_AGENT_CUSTOM_FIELD',
      agentKey: 'implement',
      field: 'systemPrompt',
      value: 'Edited body.',
    });
  });

  it('toggling a tool chip dispatches the new tools array', async () => {
    const { dispatch } = renderInspector({ definition: CUSTOM_DEF(), selectedStepId: 'impl' });
    openAgentTab();
    await screen.findByTestId('inspector-agent-mcps');

    // 'Read' is already on → toggling adds 'Edit'.
    fireEvent.click(screen.getByTestId('inspector-agent-tool-Edit'));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'SET_AGENT_CUSTOM_FIELD',
      agentKey: 'implement',
      field: 'tools',
      value: ['Read', 'Edit'],
    });
  });

  it('toggling an MCP chip dispatches the new enabledMcps array', async () => {
    const { dispatch } = renderInspector({ definition: CUSTOM_DEF(), selectedStepId: 'impl' });
    openAgentTab();
    await screen.findByTestId('inspector-agent-mcps');

    // Catalogue = filesystem, git (cyboflow filtered out); none granted → adds it.
    fireEvent.click(screen.getByTestId('inspector-agent-mcp-git'));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'SET_AGENT_CUSTOM_FIELD',
      agentKey: 'implement',
      field: 'enabledMcps',
      value: ['git'],
    });
  });

  it('"Revert to predefined" dispatches SET_AGENT_CUSTOM null', async () => {
    const { dispatch } = renderInspector({ definition: CUSTOM_DEF(), selectedStepId: 'impl' });
    openAgentTab();
    await screen.findByTestId('inspector-agent-mcps');

    fireEvent.click(screen.getByTestId('inspector-agent-revert'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_AGENT_CUSTOM', agentKey: 'implement', custom: null });
  });
});

// ---------------------------------------------------------------------------
// Human gate + unknown key branches
// ---------------------------------------------------------------------------

describe('AgentConfigSection — special agent keys', () => {
  it('renders neither the model select nor the definition block for the human gate', () => {
    renderInspector({ definition: makeDefinition(), selectedStepId: 'gate' });
    openAgentTab();

    // The AGENT tab still renders (agent select + loopback), but the config
    // section is absent for the human gate.
    expect(screen.getByTestId('inspector-agent-select')).toBeInTheDocument();
    expect(screen.queryByTestId('inspector-agent-config')).toBeNull();
    expect(screen.queryByTestId('inspector-model-select')).toBeNull();
  });

  it('renders ONLY the muted note (no model select) for an unknown key', () => {
    renderInspector({ definition: makeDefinition(), selectedStepId: 'mystery' });
    openAgentTab();

    // A model pinned on an unknown (free-typed) key could never apply at runtime —
    // the overlay maps configs only onto existing effective agents. So the section
    // shows just the note, with NO model select.
    expect(screen.queryByTestId('inspector-model-select')).toBeNull();
    expect(screen.getByTestId('inspector-agent-config-unknown')).toHaveTextContent('No predefined agent exists');
    // No read-only body / customize CTA when there's nothing to copy.
    expect(screen.queryByTestId('inspector-agent-customize')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Legacy label → canonical key resolution
// ---------------------------------------------------------------------------

describe('AgentConfigSection — legacy label resolution (canonical key)', () => {
  // 'executor' is a LEGACY step label that resolveStepAgentKey maps to the
  // canonical key 'implement' (see shared/types/agentIdentity.ts LEGACY_BY_LABEL).
  function legacyDefinition(): WorkflowDefinition {
    return {
      id: 'sprint',
      phases: [
        {
          id: 'execute',
          label: 'Execute',
          color: '#c96442',
          steps: [{ id: 'legacy', name: 'Legacy', agent: 'executor', mcps: [], retries: 0 }],
        },
      ],
    };
  }

  it('keys by the canonical key so a legacy label renders the known-agent block (not the note)', () => {
    // agentEntries default carries 'implement' — the canonical key 'executor' maps to.
    renderInspector({ definition: legacyDefinition(), selectedStepId: 'legacy' });
    openAgentTab();

    // Resolves to 'implement' (in agentEntries) → the read-only body renders, and the
    // "no predefined agent" unknown note is ABSENT.
    expect(screen.queryByTestId('inspector-agent-config-unknown')).toBeNull();
    expect(screen.getByTestId('inspector-agent-prompt')).toHaveTextContent('You are the implement agent.');
  });

  it('dispatches SET_AGENT_MODEL with the canonical key (implement), not the raw label', () => {
    const { dispatch } = renderInspector({ definition: legacyDefinition(), selectedStepId: 'legacy' });
    openAgentTab();

    fireEvent.change(screen.getByTestId('inspector-model-select'), { target: { value: 'sonnet' } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_AGENT_MODEL', agentKey: 'implement', model: 'sonnet' });
  });
});

// ---------------------------------------------------------------------------
// Fan-out inner variant
// ---------------------------------------------------------------------------

describe('AgentConfigSection — fan-out inner variant', () => {
  function fanOutDefinition(): WorkflowDefinition {
    return {
      id: 'sprint',
      phases: [
        {
          id: 'execute',
          label: 'Execute',
          color: '#c96442',
          steps: [
            {
              id: 'impl',
              name: 'Implement',
              agent: 'implement',
              mcps: [],
              retries: 0,
              fanOut: { over: 'tasks', inner: [{ id: 'item', agent: 'implement', name: 'Item' }] },
            },
          ],
        },
      ],
    };
  }

  it('renders the inner model select (distinct testid) under the inner agent select', () => {
    const { dispatch } = renderInspector({
      definition: fanOutDefinition(),
      selectedStepId: 'impl',
      selectedFanOutInner: { stepId: 'impl', innerIndex: 0 },
    });

    // The inner inspector renders without tabs — the config section is inline.
    const select = screen.getByTestId('inspector-inner-model-select');
    expect(select).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'sonnet' } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_AGENT_MODEL', agentKey: 'implement', model: 'sonnet' });
  });
});
