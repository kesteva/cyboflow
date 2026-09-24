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

// Partial mock of the shared runtime module: keeps every real export except
// isClaudeOnlyAgentKey, which is overridden to answer true ONLY for a
// synthetic 'mock-claude-only-agent' key. Production CLAUDE_ONLY_AGENT_KEYS is
// empty (visual-verify moved off it once it gained a Codex runtime), so the
// claude-only render branch in AgentConfigSection is otherwise unreachable —
// this mock lets one describe block below still exercise it.
vi.mock('../../../../../shared/types/agentRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../shared/types/agentRuntime')>();
  return {
    ...actual,
    isClaudeOnlyAgentKey: (key: string) => key === 'mock-claude-only-agent',
  };
});

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

// Deterministic Codex catalog — avoids the real IPC probe, mirrors
// VariantEditorModal.codex.test.tsx's mock of the same store.
vi.mock('../../../stores/codexModelCatalogStore', () => ({
  useCodexModelCatalog: () => ({
    options: [
      { id: 'auto', label: 'Auto/default', description: 'Use the Codex runtime default', isDefault: false },
      { id: 'gpt-5.2-codex', label: 'gpt-5.2-codex', description: 'Codex', isDefault: true },
    ],
    defaultModel: 'gpt-5.2-codex',
    loading: false,
    error: null,
  }),
}));

// Deterministic OMP catalog — the rows are the canonical `<ompProvider>/<id>`
// form the store composes, since that is what a pin persists.
vi.mock('../../../stores/ompModelCatalogStore', () => ({
  useOmpModelCatalog: () => ({
    options: [
      { id: 'anthropic/claude-haiku-4-5', label: 'claude-haiku-4-5', provider: 'anthropic' },
      { id: 'openai/gpt-5.4', label: 'gpt-5.4', provider: 'openai' },
    ],
    loading: false,
    error: null,
  }),
}));

import { WorkflowStepInspector } from '../WorkflowStepInspector';
import { useConfigStore } from '../../../stores/configStore';
import type { AppConfig } from '../../../types/config';

/**
 * Switch a provider on for one test. OMP's access key floors to DISABLED when
 * absent (unlike claude/codex), so its runtime row is filtered out of the picker
 * until the user opts in — the same courtesy filter every launch surface applies.
 */
function enableProviders(): void {
  useConfigStore.setState({
    config: {
      gitRepoPath: '/repo',
      agentProviderAccess: { claude: true, codex: true, omp: true },
    } as AppConfig,
  });
}

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
    runtime: null,
    providerModel: null,
    codexModel: null,
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
  agentProvider?: 'claude' | 'codex' | 'omp';
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
      {...(opts.agentProvider ? { agentProvider: opts.agentProvider } : {})}
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
  // The config store is module-global; reset it so one test's `enableProviders`
  // cannot decide what a later test's picker offers.
  useConfigStore.setState({ config: null });
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

  it('replaces the per-agent model pin with a single-model note when the provider is codex', () => {
    renderInspector({
      definition: makeDefinition({ implement: { model: 'sonnet' } }),
      selectedStepId: 'impl',
      agentProvider: 'codex',
    });
    openAgentTab();

    // No Claude model <select> under codex — a run-level guidance note instead.
    expect(screen.queryByTestId('inspector-model-select')).not.toBeInTheDocument();
    const note = screen.getByTestId('inspector-model-select-codex-note');
    expect(note).toHaveTextContent('Codex runs use a single model per run');
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

    expect(screen.getByTestId('inspector-model-hint')).toHaveTextContent('Inherits Opus 5.5 (agent setting).');
  });
});

// ---------------------------------------------------------------------------
// Runtime picker + Codex model picker (Slice C)
// ---------------------------------------------------------------------------

describe('AgentConfigSection — runtime picker', () => {
  it('defaults the runtime select to (inherit) and dispatches SET_AGENT_RUNTIME on change', () => {
    const { dispatch } = renderInspector({ definition: makeDefinition(), selectedStepId: 'impl' });
    openAgentTab();

    const select = screen.getByTestId('inspector-agent-runtime-select') as HTMLSelectElement;
    expect(select.value).toBe('');

    fireEvent.change(select, { target: { value: 'codex-sdk' } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_AGENT_RUNTIME', agentKey: 'implement', runtime: 'codex-sdk' });
  });

  it('maps the "(inherit)" option back to a null runtime', () => {
    const { dispatch } = renderInspector({
      definition: makeDefinition({ implement: { runtime: 'claude-interactive' } }),
      selectedStepId: 'impl',
    });
    openAgentTab();

    const select = screen.getByTestId('inspector-agent-runtime-select') as HTMLSelectElement;
    expect(select.value).toBe('claude-interactive');

    fireEvent.change(select, { target: { value: '' } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_AGENT_RUNTIME', agentKey: 'implement', runtime: null });
  });

  it('shows the Claude model select (not the Codex one) while runtime is (inherit) or claude-*', () => {
    renderInspector({ definition: makeDefinition(), selectedStepId: 'impl' });
    openAgentTab();

    expect(screen.getByTestId('inspector-model-select')).toBeInTheDocument();
    expect(screen.queryByTestId('inspector-codex-model-select')).not.toBeInTheDocument();
  });

  it('still renders the runtime select when the run provider is codex (a per-agent runtime pin is honoured on any run)', () => {
    const { dispatch } = renderInspector({
      definition: makeDefinition(),
      selectedStepId: 'impl',
      agentProvider: 'codex',
    });
    openAgentTab();

    const select = screen.getByTestId('inspector-agent-runtime-select') as HTMLSelectElement;
    // Unpinned: inherits the run's provider, so the model control is the
    // single-model-per-run note rather than a per-agent pin.
    expect(select.value).toBe('');
    expect(screen.getByTestId('inspector-model-select-codex-note')).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'claude-sdk' } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_AGENT_RUNTIME', agentKey: 'implement', runtime: 'claude-sdk' });
  });

  it('gives a codex-run agent pinned back to claude-sdk the Claude model select', () => {
    renderInspector({
      definition: makeDefinition({ implement: { runtime: 'claude-sdk' } }),
      selectedStepId: 'impl',
      agentProvider: 'codex',
    });
    openAgentTab();

    expect(screen.getByTestId('inspector-model-select')).toBeInTheDocument();
    expect(screen.queryByTestId('inspector-model-select-codex-note')).not.toBeInTheDocument();
  });

  it('gives a codex-run agent an explicit provider-model pin once it pins a runtime', () => {
    renderInspector({
      definition: makeDefinition({ implement: { runtime: 'codex-sdk' } }),
      selectedStepId: 'impl',
      agentProvider: 'codex',
    });
    openAgentTab();

    expect(screen.getByTestId('inspector-codex-model-select')).toBeInTheDocument();
    expect(screen.queryByTestId('inspector-model-select-codex-note')).not.toBeInTheDocument();
  });
});

describe('AgentConfigSection — Codex model picker', () => {
  it('replaces the Claude model select with the Codex model select once runtime is codex-sdk', () => {
    renderInspector({
      definition: makeDefinition({ implement: { runtime: 'codex-sdk' } }),
      selectedStepId: 'impl',
    });
    openAgentTab();

    expect(screen.queryByTestId('inspector-model-select')).not.toBeInTheDocument();
    const select = screen.getByTestId('inspector-codex-model-select') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'auto', 'gpt-5.2-codex']);
  });

  it('reflects a pinned providerModel and dispatches SET_AGENT_PROVIDER_MODEL on change', () => {
    const { dispatch } = renderInspector({
      definition: makeDefinition({ implement: { runtime: 'codex-sdk', providerModel: 'gpt-5.2-codex' } }),
      selectedStepId: 'impl',
    });
    openAgentTab();

    const select = screen.getByTestId('inspector-codex-model-select') as HTMLSelectElement;
    expect(select.value).toBe('gpt-5.2-codex');

    fireEvent.change(select, { target: { value: 'auto' } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_AGENT_PROVIDER_MODEL', agentKey: 'implement', providerModel: 'auto' });
  });

  it('reflects a pin carried under the deprecated codexModel alias (a definition an older writer saved)', () => {
    renderInspector({
      definition: makeDefinition({ implement: { runtime: 'codex-sdk', codexModel: 'gpt-5.2-codex' } }),
      selectedStepId: 'impl',
    });
    openAgentTab();

    const select = screen.getByTestId('inspector-codex-model-select') as HTMLSelectElement;
    expect(select.value).toBe('gpt-5.2-codex');
  });

  it('maps the "(inherit)" option back to a null providerModel', () => {
    const { dispatch } = renderInspector({
      definition: makeDefinition({ implement: { runtime: 'codex-sdk', providerModel: 'gpt-5.2-codex' } }),
      selectedStepId: 'impl',
    });
    openAgentTab();

    fireEvent.change(screen.getByTestId('inspector-codex-model-select'), { target: { value: '' } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_AGENT_PROVIDER_MODEL', agentKey: 'implement', providerModel: null });
  });
});

/**
 * The per-agent provider model picker is PROVIDER-DRIVEN, not Codex-shaped.
 *
 * The field used to be selected by a literal `selectedRuntime === 'codex-sdk'`
 * and labelled "codex model" in prose. Under an `omp-sdk` pin that meant the
 * Claude alias list rendered instead of OMP's catalogue — a pin the run would
 * then drop — and, once fixed naively, a field labelled "codex model" over OMP
 * models. Both are exactly the kind of miss no other test notices.
 */
describe('AgentConfigSection — OMP model picker (the provider-driven field)', () => {
  it('renders the OMP catalogue, labelled for OMP, once runtime is omp-sdk', () => {
    renderInspector({
      definition: makeDefinition({ implement: { runtime: 'omp-sdk' } }),
      selectedStepId: 'impl',
    });
    openAgentTab();

    expect(screen.queryByTestId('inspector-model-select')).not.toBeInTheDocument();
    const select = screen.getByTestId('inspector-codex-model-select') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      '',
      'anthropic/claude-haiku-4-5',
      'openai/gpt-5.4',
    ]);
    // The label names the pinned provider — never the other vendor.
    expect(screen.getByText('OMP model')).toBeInTheDocument();
    expect(screen.queryByText('Codex model')).not.toBeInTheDocument();
  });

  it('reflects an OMP providerModel pin and dispatches SET_AGENT_PROVIDER_MODEL on change', () => {
    const { dispatch } = renderInspector({
      definition: makeDefinition({
        implement: { runtime: 'omp-sdk', providerModel: 'anthropic/claude-haiku-4-5' },
      }),
      selectedStepId: 'impl',
    });
    openAgentTab();

    const select = screen.getByTestId('inspector-codex-model-select') as HTMLSelectElement;
    expect(select.value).toBe('anthropic/claude-haiku-4-5');

    fireEvent.change(select, { target: { value: 'openai/gpt-5.4' } });
    expect(dispatch).toHaveBeenCalledWith({
      type: 'SET_AGENT_PROVIDER_MODEL',
      agentKey: 'implement',
      providerModel: 'openai/gpt-5.4',
    });
  });

  it('offers omp-sdk in the per-agent runtime select once the provider is on', () => {
    enableProviders();
    const { dispatch } = renderInspector({
      definition: makeDefinition({ implement: {} }),
      selectedStepId: 'impl',
    });
    openAgentTab();

    const select = screen.getByTestId('inspector-agent-runtime-select') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toContain('omp-sdk');

    fireEvent.change(select, { target: { value: 'omp-sdk' } });
    expect(dispatch).toHaveBeenCalledWith({
      type: 'SET_AGENT_RUNTIME',
      agentKey: 'implement',
      runtime: 'omp-sdk',
    });
  });

  it('offers OMP`s effort scale under an omp-sdk pin, not Claude`s', () => {
    // OMP's scale starts at 'off' and Claude's at 'low'; a stale cross-provider
    // value is dropped at spawn, so offering the wrong one silently loses the pin.
    renderInspector({
      definition: makeDefinition({ implement: { runtime: 'omp-sdk' } }),
      selectedStepId: 'impl',
    });
    openAgentTab();

    const effort = screen.getByTestId('inspector-agent-effort-select') as HTMLSelectElement;
    const levels = Array.from(effort.options).map((o) => o.value);
    expect(levels).toContain('off');
    expect(levels).toContain('max');
    expect(levels).not.toContain('none'); // Codex's floor, not OMP's
  });

  it('shows the single-model note for a WHOLE-RUN OMP provider, named for OMP', () => {
    renderInspector({
      definition: makeDefinition({ implement: {} }),
      selectedStepId: 'impl',
      agentProvider: 'omp',
    });
    openAgentTab();

    expect(screen.getByTestId('inspector-model-select-codex-note')).toHaveTextContent(
      /OMP runs use a single model per run/,
    );
  });
});

describe('AgentConfigSection — visual-verify now gets the normal runtime treatment', () => {
  // The verification agent gained a Codex runtime implementation
  // (codexVerificationAgentQuery — the runner dispatches on the resolved
  // provider), so `visual-verify` was removed from CLAUDE_ONLY_AGENT_KEYS. It
  // now renders the full runtime select + Codex controls exactly like any
  // other agent key — the claude-only lock no longer applies to it.
  function makeVisualVerifyDefinition(agentConfigs?: WorkflowDefinition['agentConfigs']): WorkflowDefinition {
    return {
      id: 'sprint',
      phases: [
        {
          id: 'execute',
          label: 'Execute',
          color: '#c96442',
          steps: [{ id: 'verify', name: 'Visual verify', agent: 'visual-verify', mcps: [], retries: 0 }],
        },
      ],
      ...(agentConfigs ? { agentConfigs } : {}),
    };
  }

  const visualVerifyEntry = () => makeEntry({ agentKey: 'visual-verify', name: 'cyboflow-visual-verify' });

  it('renders the normal runtime select, not the claude-only note', () => {
    renderInspector({
      definition: makeVisualVerifyDefinition(),
      selectedStepId: 'verify',
      agentEntries: [visualVerifyEntry()],
    });
    openAgentTab();

    expect(screen.getByTestId('inspector-agent-runtime-select')).toBeInTheDocument();
    expect(screen.queryByTestId('inspector-agent-runtime-select-claude-only')).not.toBeInTheDocument();
  });

  it('shows Codex controls once the Codex runtime is pinned', () => {
    renderInspector({
      definition: makeVisualVerifyDefinition({ 'visual-verify': { runtime: 'codex-sdk' } }),
      selectedStepId: 'verify',
      agentEntries: [visualVerifyEntry()],
    });
    openAgentTab();

    expect(screen.getByTestId('inspector-codex-model-select')).toBeInTheDocument();
    expect(screen.queryByTestId('inspector-model-select')).not.toBeInTheDocument();
  });

  it('replaces the per-agent model pin with a single-model note when the run provider is codex', () => {
    renderInspector({
      definition: makeVisualVerifyDefinition(),
      selectedStepId: 'verify',
      agentEntries: [visualVerifyEntry()],
      agentProvider: 'codex',
    });
    openAgentTab();

    expect(screen.queryByTestId('inspector-model-select')).not.toBeInTheDocument();
    expect(screen.getByTestId('inspector-model-select-codex-note')).toBeInTheDocument();
  });

  it('keeps the Claude model select editable and dispatches SET_AGENT_MODEL', () => {
    const { dispatch } = renderInspector({
      definition: makeVisualVerifyDefinition(),
      selectedStepId: 'verify',
      agentEntries: [visualVerifyEntry()],
    });
    openAgentTab();

    const select = screen.getByTestId('inspector-model-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'opus' } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_AGENT_MODEL', agentKey: 'visual-verify', model: 'opus' });
  });
});

describe('AgentConfigSection — claude-only render branch (isClaudeOnlyAgentKey mocked)', () => {
  // CLAUDE_ONLY_AGENT_KEYS is empty in production, so this branch is
  // currently unreachable for any shipped agent key (visual-verify moved off
  // it above). Mock isClaudeOnlyAgentKey for a synthetic key so the branch
  // itself — the "Always runs on Claude" note replacing the runtime select —
  // still gets exercised.
  const MOCK_CLAUDE_ONLY_KEY = 'mock-claude-only-agent';

  function makeMockClaudeOnlyDefinition(agentConfigs?: WorkflowDefinition['agentConfigs']): WorkflowDefinition {
    return {
      id: 'sprint',
      phases: [
        {
          id: 'execute',
          label: 'Execute',
          color: '#c96442',
          steps: [{ id: 'verify', name: 'Mocked', agent: MOCK_CLAUDE_ONLY_KEY, mcps: [], retries: 0 }],
        },
      ],
      ...(agentConfigs ? { agentConfigs } : {}),
    };
  }

  const mockClaudeOnlyEntry = () =>
    makeEntry({ agentKey: MOCK_CLAUDE_ONLY_KEY, name: `cyboflow-${MOCK_CLAUDE_ONLY_KEY}` });

  it('renders a static "Always runs on Claude" line instead of a runtime select', () => {
    renderInspector({
      definition: makeMockClaudeOnlyDefinition(),
      selectedStepId: 'verify',
      agentEntries: [mockClaudeOnlyEntry()],
    });
    openAgentTab();

    expect(screen.getByTestId('inspector-agent-runtime-select-claude-only')).toHaveTextContent(
      'Always runs on Claude',
    );
    expect(screen.queryByTestId('inspector-agent-runtime-select')).not.toBeInTheDocument();
  });

  it('never shows Codex controls, even when the run provider is codex', () => {
    renderInspector({
      definition: makeMockClaudeOnlyDefinition(),
      selectedStepId: 'verify',
      agentEntries: [mockClaudeOnlyEntry()],
      agentProvider: 'codex',
    });
    openAgentTab();

    expect(screen.queryByTestId('inspector-codex-model-select')).not.toBeInTheDocument();
    expect(screen.queryByTestId('inspector-model-select-codex-note')).not.toBeInTheDocument();
    expect(screen.getByTestId('inspector-model-select')).toBeInTheDocument();
  });

  it('keeps the Claude model select editable and dispatches SET_AGENT_MODEL', () => {
    const { dispatch } = renderInspector({
      definition: makeMockClaudeOnlyDefinition(),
      selectedStepId: 'verify',
      agentEntries: [mockClaudeOnlyEntry()],
    });
    openAgentTab();

    const select = screen.getByTestId('inspector-model-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'opus' } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_AGENT_MODEL', agentKey: MOCK_CLAUDE_ONLY_KEY, model: 'opus' });
  });

  it('leaves the full runtime select in place for a non-mocked agent (implement)', () => {
    renderInspector({ definition: makeDefinition(), selectedStepId: 'impl' });
    openAgentTab();

    expect(screen.getByTestId('inspector-agent-runtime-select')).toBeInTheDocument();
    expect(screen.queryByTestId('inspector-agent-runtime-select-claude-only')).not.toBeInTheDocument();
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

  it('renders the inner runtime select (distinct testid) and, once codex-sdk, the inner codex model select', () => {
    const { dispatch } = renderInspector({
      definition: fanOutDefinition(),
      selectedStepId: 'impl',
      selectedFanOutInner: { stepId: 'impl', innerIndex: 0 },
    });

    const runtimeSelect = screen.getByTestId('inspector-inner-agent-runtime-select');
    expect(runtimeSelect).toBeInTheDocument();

    fireEvent.change(runtimeSelect, { target: { value: 'codex-sdk' } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_AGENT_RUNTIME', agentKey: 'implement', runtime: 'codex-sdk' });
  });

  it('shows the inner codex model select once the fan-out inner agent config pins codex-sdk', () => {
    const { dispatch } = renderInspector({
      definition: fanOutInnerCodexDefinition(),
      selectedStepId: 'impl',
      selectedFanOutInner: { stepId: 'impl', innerIndex: 0 },
    });

    expect(screen.queryByTestId('inspector-inner-model-select')).not.toBeInTheDocument();
    const codexSelect = screen.getByTestId('inspector-inner-codex-model-select') as HTMLSelectElement;
    expect(codexSelect.value).toBe('');

    fireEvent.change(codexSelect, { target: { value: 'auto' } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_AGENT_PROVIDER_MODEL', agentKey: 'implement', providerModel: 'auto' });
  });

  function fanOutInnerCodexDefinition(): WorkflowDefinition {
    return { ...fanOutDefinition(), agentConfigs: { implement: { runtime: 'codex-sdk' } } };
  }
});
