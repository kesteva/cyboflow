/**
 * OnboardingGate — step 3 (Model + reasoning effort) integration coverage.
 *
 * The step asks TWO questions on one card and writes them through TWO different
 * config channels, so these tests drive the real onboardingStore + configStore
 * (only the API/IPC layers are mocked) and assert the whole chain: the seeds it
 * opens on, the model→effort phase flip, and the persisted payloads.
 *
 * What the writes must look like, and why:
 * - `defaultLaunchModel` is the global model rung every launch resolves through;
 *   `assistantModel` follows only a CLAUDE pick (the chat assistant is hard-wired
 *   to ClaudeCodeManager, so a Codex id there would name a model its runtime
 *   cannot serve) and never for 'auto' (which means "no explicit model").
 * - the effort goes to the quick run type as a MERGE op — `replace` would drop
 *   whatever else the user stores under that key (model, permission mode,
 *   substrate, runtime).
 * - the two land in sequence, never concurrently: both refetch the whole config
 *   into the same store, so racing them lets the slower refetch overwrite the
 *   faster write's result.
 *
 * Codex adds two states Claude cannot have — the model list is DISCOVERED — and
 * both are covered: still loading (Next disabled, effort list inert) and
 * unreachable (a Retry well, the selection falling back to 'auto' so the step
 * stays completable).
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OnboardingGate } from './OnboardingGate';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { useConfigStore } from '../../stores/configStore';
import { resetProviderModelCatalogsForTests } from '../../stores/providerModelCatalogStore';
import { PROVIDERS_DETECT_CHANNEL } from '../../../../shared/types/onboarding';
import type { ProviderDetectionResult } from '../../../../shared/types/onboarding';
import type { AppConfig } from '../../types/config';

const projectsGetAll = vi.fn();
const configGet = vi.fn();
const configUpdate = vi.fn();
const configApplyRunTypeDefault = vi.fn();
const modelsGetCatalog = vi.fn();

vi.mock('../../utils/api', () => ({
  API: {
    projects: { getAll: (...a: unknown[]) => projectsGetAll(...a) },
    config: {
      get: (...a: unknown[]) => configGet(...a),
      update: (...a: unknown[]) => configUpdate(...a),
      applyRunTypeDefault: (...a: unknown[]) => configApplyRunTypeDefault(...a),
    },
    models: { getCatalog: (...a: unknown[]) => modelsGetCatalog(...a) },
    dialog: { openFile: vi.fn(), openDirectory: vi.fn() },
  },
}));

const CLAUDE_DETECTED: ProviderDetectionResult<'claude'> = {
  state: 'detected',
  credentials: { found: true, source: 'keychain', account: 'claude@example.com' },
  binary: { found: true, path: '/usr/local/bin/claude', version: '1.2.3' },
};

const CODEX_DETECTED: ProviderDetectionResult<'codex'> = {
  state: 'detected',
  runtime: { found: true, path: '/app/codex', version: '0.144.3' },
  account: { found: true, email: 'codex@example.com', planType: 'plus' },
};

const CODEX_CATALOG = {
  models: [
    { id: 'gpt-5.2-codex', label: 'gpt-5.2-codex', description: 'Deep agentic coding', isDefault: true },
    { id: 'gpt-5.2', label: 'gpt-5.2', description: 'General purpose', isDefault: false },
  ],
  defaultModel: 'gpt-5.2-codex',
};

function baseAppConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    gitRepoPath: '/repo',
    telemetry: { installId: 'inst-1', errorReportingEnabled: true, usageMetricsEnabled: true },
    ...over,
  };
}

const INITIAL_ONBOARDING_STATE = {
  status: 'idle' as const,
  step: 0,
  maxVisitedStep: 0,
  replay: false,
  detection: null,
  connected: false,
  codexDetection: null,
  codexConnected: false,
  ompDetection: null,
  ompConnected: false,
  permMode: 'auto' as const,
  defaultProvider: null,
  multiRuntime: true,
  defaultModel: null,
  defaultEffort: null,
  modelPhase: 'model' as const,
  handoffChoice: 'continue' as const,
  projectChoice: 'existing' as const,
  hydrated: false,
};

const invoke = vi.fn(async (channel: string, provider?: string) => {
  if (channel === PROVIDERS_DETECT_CHANNEL) {
    if (provider === 'claude') return { success: true, data: CLAUDE_DETECTED };
    if (provider === 'codex') return { success: true, data: CODEX_DETECTED };
  }
  return { success: true };
});

beforeEach(() => {
  projectsGetAll.mockReset().mockResolvedValue({ success: true, data: [] });
  configGet.mockReset().mockResolvedValue({ success: true, data: baseAppConfig() });
  configUpdate.mockReset().mockResolvedValue({ success: true });
  configApplyRunTypeDefault.mockReset().mockResolvedValue({ success: true, data: { previous: null } });
  modelsGetCatalog.mockReset().mockResolvedValue({ success: true, data: CODEX_CATALOG });
  resetProviderModelCatalogsForTests();
  invoke.mockClear();
  (window as unknown as { electron: { invoke: typeof invoke } }).electron = { invoke };
  useOnboardingStore.setState(INITIAL_ONBOARDING_STATE);
  useConfigStore.setState({ config: null, isLoading: false, error: null });
});

afterEach(() => {
  delete (window as unknown as { electron?: unknown }).electron;
});

/**
 * Renders the gate, waits for boot hydration, then parks it on step 3 with
 * `provider` as the resolved default agent.
 */
async function mountAtModelStep(
  config: AppConfig,
  provider: 'claude' | 'codex',
): Promise<void> {
  render(<OnboardingGate />);
  await waitFor(() => expect(useOnboardingStore.getState().hydrated).toBe(true));
  act(() => {
    useConfigStore.setState({ config });
    useOnboardingStore.setState({
      status: 'active',
      step: 3,
      maxVisitedStep: 3,
      // Both providers activated + a step-2 answer: the step-3 provider follows
      // the default-agent choice whenever step 2 was part of the run.
      multiRuntime: true,
      detection: CLAUDE_DETECTED,
      connected: true,
      codexDetection: CODEX_DETECTED,
      codexConnected: true,
      defaultProvider: provider,
    });
  });
  await screen.findByRole('dialog', { name: 'Pick a model' });
}

describe('OnboardingGate — Model step (3), Claude', () => {
  it('seeds Opus 5 + High on a pristine install and opens on the model list', async () => {
    await mountAtModelStep(baseAppConfig(), 'claude');

    await waitFor(() => expect(useOnboardingStore.getState().defaultModel).toBe('opus'));
    expect(useOnboardingStore.getState().defaultEffort).toBe('high');
    expect(useOnboardingStore.getState().modelPhase).toBe('model');

    expect(await screen.findByRole('radiogroup', { name: 'Default model' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Opus 5/ })).toHaveAttribute('aria-checked', 'true');
    // The effort question is not asked until a model is settled.
    expect(
      screen.queryByRole('radiogroup', { name: 'Default reasoning effort' }),
    ).not.toBeInTheDocument();
  });

  it('seeds from the SAVED defaults when they belong to the Claude family', async () => {
    await mountAtModelStep(
      baseAppConfig({
        defaultLaunchModel: 'sonnet',
        runTypeDefaults: { quick: { reasoningEffort: 'max' } },
      }),
      'claude',
    );

    await waitFor(() => expect(useOnboardingStore.getState().defaultModel).toBe('sonnet'));
    expect(useOnboardingStore.getState().defaultEffort).toBe('max');
  });

  it('drops a saved CODEX model rather than seeding it onto a Claude run', async () => {
    await mountAtModelStep(
      baseAppConfig({
        defaultLaunchModel: 'gpt-5.2-codex',
        // 'minimal' is Codex-only — invalid on Claude's scale.
        runTypeDefaults: { quick: { reasoningEffort: 'minimal' } },
      }),
      'claude',
    );

    await waitFor(() => expect(useOnboardingStore.getState().defaultModel).toBe('opus'));
    expect(useOnboardingStore.getState().defaultEffort).toBe('high');
  });

  it('picking a model reveals the effort list and collapses the model to a CHANGE row', async () => {
    await mountAtModelStep(baseAppConfig(), 'claude');
    await screen.findByRole('radiogroup', { name: 'Default model' });

    fireEvent.click(screen.getByRole('radio', { name: /Sonnet 5/ }));

    expect(useOnboardingStore.getState().defaultModel).toBe('sonnet');
    expect(useOnboardingStore.getState().modelPhase).toBe('effort');
    expect(
      await screen.findByRole('radiogroup', { name: 'Default reasoning effort' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Default model' })).not.toBeInTheDocument();

    // CHANGE goes back to the list without losing the pick.
    fireEvent.click(screen.getByRole('button', { name: 'CHANGE' }));
    expect(await screen.findByRole('radiogroup', { name: 'Default model' })).toBeInTheDocument();
    expect(useOnboardingStore.getState().defaultModel).toBe('sonnet');
  });

  it('offers Claude’s own effort scale, X-high included, and no Codex-only rung', async () => {
    await mountAtModelStep(baseAppConfig(), 'claude');
    fireEvent.click(await screen.findByRole('radio', { name: /Opus 5/ }));

    const group = await screen.findByRole('radiogroup', { name: 'Default reasoning effort' });
    expect(group).toHaveTextContent('X-high');
    expect(group).toHaveTextContent('Max');
    expect(group).not.toHaveTextContent('Minimal');
    expect(screen.getByRole('radio', { name: /High/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('the first Next only reveals the effort list — it does not advance or persist', async () => {
    await mountAtModelStep(baseAppConfig(), 'claude');
    await screen.findByRole('radiogroup', { name: 'Default model' });

    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));

    expect(useOnboardingStore.getState().step).toBe(3);
    expect(useOnboardingStore.getState().modelPhase).toBe('effort');
    expect(configUpdate).not.toHaveBeenCalled();
    expect(configApplyRunTypeDefault).not.toHaveBeenCalled();
  });

  it('persists the model, the assistant model and the quick effort, then advances', async () => {
    await mountAtModelStep(baseAppConfig(), 'claude');
    fireEvent.click(await screen.findByRole('radio', { name: /Sonnet 5/ }));
    fireEvent.click(await screen.findByRole('radio', { name: /X-high/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));

    await waitFor(() =>
      expect(configUpdate).toHaveBeenCalledWith({
        defaultLaunchModel: 'sonnet',
        assistantModel: 'sonnet',
      }),
    );
    // MERGE, never replace: everything else stored under the quick key survives.
    await waitFor(() =>
      expect(configApplyRunTypeDefault).toHaveBeenCalledWith('quick', {
        kind: 'merge',
        value: { reasoningEffort: 'xhigh' },
      }),
    );
    await waitFor(() => expect(useOnboardingStore.getState().step).toBe(4));
  });

  it('sequences the two writes — the effort op never starts before the model write settles', async () => {
    await mountAtModelStep(baseAppConfig(), 'claude');
    fireEvent.click(await screen.findByRole('radio', { name: /Opus 5/ }));

    let releaseUpdate!: (v: { success: true }) => void;
    configUpdate.mockReturnValue(new Promise((resolve) => { releaseUpdate = resolve; }));

    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));

    await waitFor(() => expect(configUpdate).toHaveBeenCalledTimes(1));
    expect(configApplyRunTypeDefault).not.toHaveBeenCalled();

    await act(async () => {
      releaseUpdate({ success: true });
      await Promise.resolve();
    });
    await waitFor(() => expect(configApplyRunTypeDefault).toHaveBeenCalledTimes(1));
  });

  it('omits assistantModel for the Auto row (there is no explicit model to pin)', async () => {
    await mountAtModelStep(baseAppConfig(), 'claude');
    fireEvent.click(await screen.findByRole('radio', { name: /^Auto/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));

    await waitFor(() =>
      expect(configUpdate).toHaveBeenCalledWith({ defaultLaunchModel: 'auto' }),
    );
  });

  it('advances anyway when both writes fail (non-fatal — Settings still owns them)', async () => {
    configUpdate.mockRejectedValue(new Error('disk full'));
    await mountAtModelStep(baseAppConfig(), 'claude');
    fireEvent.click(await screen.findByRole('radio', { name: /Opus 5/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));

    await waitFor(() => expect(useOnboardingStore.getState().step).toBe(4));
  });

  it('prevents a duplicate submit from a rapid double-click', async () => {
    let releaseUpdate!: (v: { success: true }) => void;
    await mountAtModelStep(baseAppConfig(), 'claude');
    fireEvent.click(await screen.findByRole('radio', { name: /Opus 5/ }));
    configUpdate.mockReturnValue(new Promise((resolve) => { releaseUpdate = resolve; }));

    const nextButton = screen.getByRole('button', { name: 'Next →' });
    fireEvent.click(nextButton);
    fireEvent.click(nextButton);
    fireEvent.click(nextButton);

    expect(configUpdate).toHaveBeenCalledTimes(1);
    await act(async () => {
      releaseUpdate({ success: true });
      await Promise.resolve();
    });
    await waitFor(() => expect(useOnboardingStore.getState().step).toBe(4));
    expect(configUpdate).toHaveBeenCalledTimes(1);
  });

  it('renders the dialog title and a progress counter for step 3', async () => {
    await mountAtModelStep(baseAppConfig(), 'claude');
    expect(screen.getByText('STEP 4 / 7')).toBeInTheDocument();
  });
});

describe('OnboardingGate — Model step (3), Codex', () => {
  it('seeds the catalog’s own default model and Codex’s medium effort', async () => {
    await mountAtModelStep(baseAppConfig(), 'codex');

    await waitFor(() => expect(useOnboardingStore.getState().defaultModel).toBe('gpt-5.2-codex'));
    expect(useOnboardingStore.getState().defaultEffort).toBe('medium');
    expect(screen.getByText(/Defaults for Codex/)).toBeInTheDocument();
  });

  it('offers the discovered rows plus the synthesized Auto row, and Codex’s own effort scale', async () => {
    await mountAtModelStep(baseAppConfig(), 'codex');
    const group = await screen.findByRole('radiogroup', { name: 'Default model' });

    expect(group).toHaveTextContent('Auto/default');
    expect(group).toHaveTextContent('gpt-5.2-codex');

    fireEvent.click(screen.getByRole('radio', { name: /^gpt-5\.2-codex/ }));
    const effort = await screen.findByRole('radiogroup', { name: 'Default reasoning effort' });
    // Codex-only rungs present, Claude-only 'max' absent.
    expect(effort).toHaveTextContent('None');
    expect(effort).toHaveTextContent('Minimal');
    expect(effort).not.toHaveTextContent('Max');
  });

  it('disables Next and renders the effort list inert while the catalog is loading', async () => {
    modelsGetCatalog.mockReturnValue(new Promise(() => { /* never settles */ }));
    await mountAtModelStep(baseAppConfig(), 'codex');

    expect(await screen.findByText(/Loading models from the Codex SDK/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next →' })).toBeDisabled();
    const effort = screen.getByRole('radiogroup', { name: 'Default reasoning effort' });
    expect(effort).toHaveAttribute('aria-disabled', 'true');
    // Nothing is seeded until discovery settles — the floor comes from the catalog.
    expect(useOnboardingStore.getState().defaultModel).toBeNull();
  });

  it('falls back to Auto with a Retry when the catalog is unreachable, and stays completable', async () => {
    modelsGetCatalog.mockResolvedValue({ success: false, error: 'codex app-server not reachable' });
    await mountAtModelStep(
      // A stale Codex id is stored — the failure must still land the user on
      // 'auto', the one selection that is valid with no catalog behind it.
      baseAppConfig({ defaultLaunchModel: 'gpt-5.2-codex' }),
      'codex',
    );

    expect(await screen.findByText(/Couldn’t reach the Codex SDK\.|Couldn't reach the Codex SDK\./))
      .toBeInTheDocument();
    await waitFor(() => expect(useOnboardingStore.getState().defaultModel).toBe('auto'));
    expect(screen.getByRole('button', { name: 'Next →' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
    await waitFor(() =>
      expect(configUpdate).toHaveBeenCalledWith({ defaultLaunchModel: 'auto' }),
    );
    // assistantModel is Claude-only — a Codex run must never pin it.
    expect(configUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ assistantModel: expect.anything() }),
    );
    await waitFor(() => expect(useOnboardingStore.getState().step).toBe(4));
  });

  it('Retry re-runs discovery and puts the model question back on the table', async () => {
    modelsGetCatalog.mockResolvedValueOnce({ success: false, error: 'nope' });
    await mountAtModelStep(baseAppConfig(), 'codex');
    await screen.findByRole('button', { name: 'Retry' });

    modelsGetCatalog.mockResolvedValue({ success: true, data: CODEX_CATALOG });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    // The well is gone and the fallback selection is shown as a real answer
    // again — CHANGE re-opens the (now discovered) list.
    const change = await screen.findByRole('button', { name: 'CHANGE' });
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(useOnboardingStore.getState().defaultModel).toBe('auto');

    fireEvent.click(change);
    expect(
      await screen.findByRole('radiogroup', { name: 'Default model' }),
    ).toHaveTextContent('gpt-5.2-codex');
  });

  it('never persists a Codex model as the chat assistant’s model', async () => {
    await mountAtModelStep(baseAppConfig(), 'codex');
    fireEvent.click(await screen.findByRole('radio', { name: /^gpt-5\.2-codex/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));

    await waitFor(() =>
      expect(configUpdate).toHaveBeenCalledWith({ defaultLaunchModel: 'gpt-5.2-codex' }),
    );
    await waitFor(() =>
      expect(configApplyRunTypeDefault).toHaveBeenCalledWith('quick', {
        kind: 'merge',
        value: { reasoningEffort: 'medium' },
      }),
    );
  });
});
