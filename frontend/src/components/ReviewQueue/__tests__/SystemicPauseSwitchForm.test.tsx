/**
 * SystemicPauseSwitchForm — the inline "Switch runtime & retry" control for a
 * `gate:systemic-pause:<stepId>` decision item (plan v2).
 *
 * Covers: provider readiness gates the runtime options (disabled + reason
 * suffix for anything not 'detected'); the default runtime prefers a READY
 * provider other than the blocked one; the same-provider warning; the model
 * control switching shape (Claude alias select vs. a provider catalog select)
 * as the selected runtime's provider changes; the scope radio hiding "only
 * these agents" for a fan-out pause; the submitted payload shape; every noOp
 * reason's sentence; and the retried:false note.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReviewItem, ReviewItemPayload } from '../../../../../shared/types/reviews';
import type { AppConfig } from '../../../types/config';

const mockDetect = vi.fn();
vi.mock('../../../utils/api', () => ({
  API: {
    providers: {
      detect: (...args: unknown[]) => mockDetect(...args),
    },
  },
}));

const mockSwitchPausedStepAgents = vi.fn();
vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      runs: {
        switchPausedStepAgents: { mutate: (...args: unknown[]) => mockSwitchPausedStepAgents(...args) },
      },
    },
  },
}));

// Deterministic catalogs — mirrors WorkflowStepInspector.agentConfig.test.tsx's
// mock of the same two stores.
vi.mock('../../../stores/codexModelCatalogStore', () => ({
  useCodexModelCatalog: () => ({
    options: [
      { id: 'auto', label: 'Auto/default', description: 'Use the Codex runtime default', isDefault: false },
      { id: 'gpt-5.4-codex', label: 'gpt-5.4-codex', description: 'Codex', isDefault: true },
    ],
    defaultModel: 'gpt-5.4-codex',
    loading: false,
    error: null,
  }),
}));

vi.mock('../../../stores/ompModelCatalogStore', () => ({
  useOmpModelCatalog: () => ({
    options: [
      { id: 'anthropic/claude-haiku-4-5', label: 'claude-haiku-4-5', ompProvider: 'anthropic' },
    ],
    loading: false,
    error: null,
  }),
}));

vi.mock('../../../stores/providerModelCatalogStore', () => ({
  useProviderModelCatalog: (provider: string, enabled: boolean) => ({
    catalog:
      provider === 'pi' && enabled
        ? { models: [{ id: 'anthropic/pi-opus', label: 'pi-opus', ompProvider: 'anthropic' }] }
        : null,
    loading: false,
    error: null,
  }),
}));

import { SystemicPauseSwitchForm } from '../SystemicPauseSwitchForm';
import { AGENT_MODEL_ALIASES, AGENT_MODEL_LABELS } from '../../../../../shared/types/agents';
import { useActiveRunsStore } from '../../../stores/activeRunsStore';
import { useConfigStore } from '../../../stores/configStore';
import { useRunAgentTargetsStore } from '../../../stores/runAgentTargetsStore';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    workflow_id: 'wf-1',
    project_id: 5,
    status: 'paused' as const,
    worktree_path: '/tmp/wt',
    branch_name: 'cyboflow/run-1',
    created_at: '',
    updated_at: '',
    started_at: null,
    ended_at: null,
    stuck_reason: null,
    permission_mode_snapshot: 'default' as const,
    workflowName: 'sprint',
    agent_provider: 'claude' as const,
    agent_runtime: 'claude-sdk' as const,
    model: null,
    execution_model: 'programmatic' as const,
    ...overrides,
  };
}

function makePauseItem(
  overrides: Partial<ReviewItem> = {},
  payloadOverrides: Record<string, unknown> = {},
): ReviewItem {
  return {
    id: overrides.id ?? 'rvw_pause',
    project_id: overrides.project_id ?? 5,
    run_id: overrides.run_id ?? 'run-1',
    entity_type: null,
    entity_id: null,
    kind: 'decision',
    status: 'pending',
    blocking: true,
    audience: 'human',
    title: 'Systemic pause',
    body: null,
    severity: null,
    priority: null,
    staged_at: null,
    selected: false,
    source: 'gate:systemic-pause:implement',
    payload: {
      kind: 'decision',
      gate: 'systemic-pause',
      agentKeys: ['implement'],
      blockedProvider: 'claude',
      origin: 'step',
      fanOut: false,
      ...payloadOverrides,
    } as unknown as ReviewItemPayload,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    resolved_by: null,
    resolution: null,
    ...overrides,
  };
}

/** detect() resolves per-provider from this map; providers absent = never called. */
function mockDetectStates(states: Partial<Record<string, string>>): void {
  mockDetect.mockImplementation(async (provider: string) => {
    const state = states[provider];
    if (state === undefined) throw new Error(`unexpected detect(${provider})`);
    return { success: true, data: { state } };
  });
}

function enableProviders(providers: Record<string, boolean> = { claude: true, codex: true, omp: true }): void {
  useConfigStore.setState({
    config: { gitRepoPath: '/repo', agentProviderAccess: providers } as AppConfig,
  });
}

async function waitForReadiness(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('pause-switch-submit')).not.toHaveTextContent('Checking'));
}

beforeEach(() => {
  mockDetect.mockReset();
  mockSwitchPausedStepAgents.mockReset();
  mockSwitchPausedStepAgents.mockResolvedValue({
    delivered: true,
    agentKeys: ['implement'],
    target: { runtime: 'codex-sdk' },
    retried: true,
  });
  useActiveRunsStore.setState({ runsByProject: { 5: [makeRun()] } });
  enableProviders();
});

describe('SystemicPauseSwitchForm', () => {
  it('offers only DETECTED providers; others render disabled with the reason suffix', async () => {
    mockDetectStates({ claude: 'loggedOut', codex: 'detected', omp: 'unavailable' });
    render(<SystemicPauseSwitchForm item={makePauseItem()} onDone={vi.fn()} />);
    await waitForReadiness();

    const select = screen.getByTestId('pause-switch-runtime') as HTMLSelectElement;
    const options = within(select).getAllByRole('option') as HTMLOptionElement[];
    const byValue = (v: string) => options.find((o) => o.value === v)!;

    expect(byValue('claude-sdk').disabled).toBe(true);
    expect(byValue('claude-sdk').textContent).toContain('not signed in');
    expect(byValue('codex-sdk').disabled).toBe(false);
    expect(byValue('codex-sdk').textContent).not.toContain('—');
    expect(byValue('omp-sdk').disabled).toBe(true);
    expect(byValue('omp-sdk').textContent).toContain('not installed');
    // pi is off in Settings (enableProviders' default omits it) — disabled with
    // its own reason, and never probed at all.
    expect(byValue('pi-sdk').disabled).toBe(true);
    expect(byValue('pi-sdk').textContent).toContain('turned off in Settings');
    expect(mockDetect).not.toHaveBeenCalledWith('pi');
  });

  it('defaults the runtime to the first READY provider other than the blocked one', async () => {
    mockDetectStates({ claude: 'loggedOut', codex: 'detected', omp: 'unavailable' });
    render(<SystemicPauseSwitchForm item={makePauseItem()} onDone={vi.fn()} />);
    await waitForReadiness();
    await waitFor(() =>
      expect((screen.getByTestId('pause-switch-runtime') as HTMLSelectElement).value).toBe('codex-sdk'),
    );
    // Not the blocked provider's own runtime.
    expect(screen.queryByTestId('pause-switch-same-provider')).not.toBeInTheDocument();
  });

  it('warns when the selected runtime is still on the blocked provider (nothing else is ready)', async () => {
    mockDetectStates({ claude: 'detected', codex: 'unavailable', omp: 'unavailable' });
    render(<SystemicPauseSwitchForm item={makePauseItem()} onDone={vi.fn()} />);
    await waitForReadiness();
    await waitFor(() => expect(screen.getByTestId('pause-switch-same-provider')).toBeInTheDocument());
    // Claude IS ready, so the (same-provider) switch is still submittable.
    expect(screen.getByTestId('pause-switch-submit')).not.toBeDisabled();
    expect(screen.queryByTestId('pause-switch-blocked')).not.toBeInTheDocument();
  });

  it('with NO ready provider the submit is disabled and the form says why (never a guaranteed refusal)', async () => {
    mockDetectStates({ claude: 'loggedOut', codex: 'unavailable', omp: 'missing' });
    render(<SystemicPauseSwitchForm item={makePauseItem()} onDone={vi.fn()} />);
    await waitForReadiness();
    await waitFor(() => expect(screen.getByTestId('pause-switch-blocked')).toBeInTheDocument());
    expect(screen.getByTestId('pause-switch-blocked')).toHaveTextContent('No provider is installed and signed in');
    const submit = screen.getByTestId('pause-switch-submit');
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(mockSwitchPausedStepAgents).not.toHaveBeenCalled();
    // The select fell back to the run's own (unready) runtime — visibly disabled.
    const select = screen.getByTestId('pause-switch-runtime') as HTMLSelectElement;
    expect(select.value).toBe('claude-sdk');
    const claudeOption = within(select).getAllByRole('option').find((o) => (o as HTMLOptionElement).value === 'claude-sdk');
    expect((claudeOption as HTMLOptionElement).disabled).toBe(true);
  });

  it('the model control is the Claude alias select when the selected runtime is Claude', async () => {
    mockDetectStates({ claude: 'detected', codex: 'unavailable', omp: 'unavailable' });
    render(<SystemicPauseSwitchForm item={makePauseItem()} onDone={vi.fn()} />);
    await waitForReadiness();
    const modelSelect = screen.getByTestId('pause-switch-model') as HTMLSelectElement;
    const optionLabels = within(modelSelect)
      .getAllByRole('option')
      .map((o) => o.textContent);
    // Through AGENT_MODEL_LABELS, not literals — the alias→label pin moves
    // with model bumps (Opus 5 → 5.5) and this test is about the SHAPE.
    expect(optionLabels).toEqual(['(inherit)', ...AGENT_MODEL_ALIASES.map((a) => AGENT_MODEL_LABELS[a])]);
  });

  it('the model control is the provider catalog select once a Codex runtime is chosen', async () => {
    mockDetectStates({ claude: 'loggedOut', codex: 'detected', omp: 'unavailable' });
    render(<SystemicPauseSwitchForm item={makePauseItem()} onDone={vi.fn()} />);
    await waitForReadiness();
    await waitFor(() =>
      expect((screen.getByTestId('pause-switch-runtime') as HTMLSelectElement).value).toBe('codex-sdk'),
    );
    const modelSelect = screen.getByTestId('pause-switch-model') as HTMLSelectElement;
    const optionLabels = within(modelSelect)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(optionLabels).toEqual(['(provider default)', 'Auto/default', 'gpt-5.4-codex']);
  });

  it('the "only these agents" scope is hidden for a fan-out pause, shown otherwise', async () => {
    mockDetectStates({ claude: 'detected', codex: 'unavailable', omp: 'unavailable' });
    const { rerender } = render(
      <SystemicPauseSwitchForm item={makePauseItem({}, { fanOut: true })} onDone={vi.fn()} />,
    );
    await waitForReadiness();
    expect(screen.queryByTestId('pause-switch-scope-step')).not.toBeInTheDocument();
    expect(screen.getByTestId('pause-switch-scope-provider')).toBeInTheDocument();

    rerender(<SystemicPauseSwitchForm item={makePauseItem({ id: 'rvw_pause2' }, { fanOut: false })} onDone={vi.fn()} />);
    await waitForReadiness();
    expect(screen.getByTestId('pause-switch-scope-step')).toBeInTheDocument();
  });

  it('the "only these agents" scope is hidden when the pause carries no agentKeys, even without fanOut', async () => {
    mockDetectStates({ claude: 'detected', codex: 'unavailable', omp: 'unavailable' });
    render(
      <SystemicPauseSwitchForm item={makePauseItem({}, { fanOut: false, agentKeys: [] })} onDone={vi.fn()} />,
    );
    await waitForReadiness();
    expect(screen.queryByTestId('pause-switch-scope-step')).not.toBeInTheDocument();
  });

  it('submits {runtime, model, providerModel: null, effort} for a Claude target', async () => {
    mockDetectStates({ claude: 'detected', codex: 'unavailable', omp: 'unavailable' });
    const onDone = vi.fn();
    render(<SystemicPauseSwitchForm item={makePauseItem({ id: 'rvw_submit_claude' })} onDone={onDone} />);
    await waitForReadiness();

    fireEvent.change(screen.getByTestId('pause-switch-model'), { target: { value: 'opus' } });
    fireEvent.change(screen.getByTestId('pause-switch-effort'), { target: { value: 'high' } });
    fireEvent.click(screen.getByTestId('pause-switch-submit'));

    await waitFor(() =>
      expect(mockSwitchPausedStepAgents).toHaveBeenCalledWith({
        runId: 'run-1',
        reviewItemId: 'rvw_submit_claude',
        scope: 'provider',
        target: { runtime: 'claude-sdk', model: 'opus', providerModel: null, effort: 'high' },
      }),
    );
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it('submits {runtime, model: null, providerModel, effort} for a non-Claude target', async () => {
    mockDetectStates({ claude: 'loggedOut', codex: 'detected', omp: 'unavailable' });
    render(<SystemicPauseSwitchForm item={makePauseItem({ id: 'rvw_submit_codex' })} onDone={vi.fn()} />);
    await waitForReadiness();
    await waitFor(() =>
      expect((screen.getByTestId('pause-switch-runtime') as HTMLSelectElement).value).toBe('codex-sdk'),
    );

    fireEvent.change(screen.getByTestId('pause-switch-model'), { target: { value: 'gpt-5.4-codex' } });
    fireEvent.click(screen.getByTestId('pause-switch-scope-step'));
    fireEvent.click(screen.getByTestId('pause-switch-submit'));

    await waitFor(() =>
      expect(mockSwitchPausedStepAgents).toHaveBeenCalledWith({
        runId: 'run-1',
        reviewItemId: 'rvw_submit_codex',
        scope: 'step',
        target: { runtime: 'codex-sdk', model: null, providerModel: 'gpt-5.4-codex', effort: null },
      }),
    );
  });

  const noOpCases: Array<[string, string]> = [
    ['not_found', 'Run not found.'],
    ['not_programmatic', 'Only programmatic runs can switch agents.'],
    ['no_target', 'Pick a runtime, model or effort to switch to.'],
    ['invalid_target', "That runtime/model/effort combination isn't valid."],
    ['provider_disabled', 'That provider is switched off in Settings → Integrations.'],
    ['provider_unavailable', "That provider isn't installed or signed in on this machine."],
    ['item_not_pending', 'This pause has already cleared — the switch was not applied.'],
    ['item_mismatch', "This pause item is no longer the run's current pause; reload and try again."],
    ['no_agents', 'No agent in this run is on that provider.'],
    [
      'step_scope_unavailable',
      "Only-these-agents isn't available for a fan-out pause; switch every agent on the provider instead.",
    ],
    ['origin_triage', "The run's supervisor (always Claude) hit the limit; switching the step agents can't move it."],
  ];

  it.each(noOpCases)('renders the sentence for noOp reason %s', async (reason, sentence) => {
    mockDetectStates({ claude: 'detected', codex: 'unavailable', omp: 'unavailable' });
    mockSwitchPausedStepAgents.mockResolvedValueOnce({ noOp: reason });
    const onDone = vi.fn();
    render(<SystemicPauseSwitchForm item={makePauseItem({ id: `rvw_noop_${reason}` })} onDone={onDone} />);
    await waitForReadiness();
    fireEvent.click(screen.getByTestId('pause-switch-submit'));
    await waitFor(() => expect(screen.getByTestId('pause-switch-error')).toHaveTextContent(sentence));
    // A refused switch never collapses the form.
    expect(onDone).not.toHaveBeenCalled();
  });

  it('bumps the run\'s agent-targets version once the switch is delivered (canvas + chip re-fetch on it), not on a noOp', async () => {
    mockDetectStates({ claude: 'detected', codex: 'unavailable', omp: 'unavailable' });
    useRunAgentTargetsStore.setState({ versionByRun: {} });
    mockSwitchPausedStepAgents.mockResolvedValueOnce({ noOp: 'item_not_pending' });
    const { unmount } = render(
      <SystemicPauseSwitchForm item={makePauseItem({ id: 'rvw_bump_noop' })} onDone={vi.fn()} />,
    );
    await waitForReadiness();
    fireEvent.click(screen.getByTestId('pause-switch-submit'));
    await waitFor(() => expect(screen.getByTestId('pause-switch-error')).toBeInTheDocument());
    expect(useRunAgentTargetsStore.getState().versionByRun['run-1']).toBeUndefined();
    unmount();

    render(<SystemicPauseSwitchForm item={makePauseItem({ id: 'rvw_bump_ok' })} onDone={vi.fn()} />);
    await waitForReadiness();
    fireEvent.click(screen.getByTestId('pause-switch-submit'));
    await waitFor(() => expect(useRunAgentTargetsStore.getState().versionByRun['run-1']).toBe(1));
  });

  it('shows the note and still calls onDone when the switch delivered but did not retry', async () => {
    mockDetectStates({ claude: 'detected', codex: 'unavailable', omp: 'unavailable' });
    mockSwitchPausedStepAgents.mockResolvedValueOnce({
      delivered: true,
      agentKeys: ['implement'],
      target: { runtime: 'claude-sdk' },
      retried: false,
      note: 'The pause had already cleared; the switch applies from the next spawn.',
    });
    const onDone = vi.fn();
    render(<SystemicPauseSwitchForm item={makePauseItem({ id: 'rvw_retried_false' })} onDone={onDone} />);
    await waitForReadiness();
    fireEvent.click(screen.getByTestId('pause-switch-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('pause-switch-note')).toHaveTextContent(
        'The pause had already cleared; the switch applies from the next spawn.',
      ),
    );
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
