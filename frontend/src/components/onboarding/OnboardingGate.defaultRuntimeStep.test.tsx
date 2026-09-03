/**
 * OnboardingGate — step 2 (Default agent) integration coverage.
 *
 * The step is CONDITIONAL (rendered only when the Connect step left 2+
 * DEFAULT-ELIGIBLE providers activated — claude/codex; OMP is activatable but no
 * picker offers its runtimes) and its answer is not tour-local: Next persists the chosen
 * provider's structured runtime into AppConfig.defaultAgentRuntime — the middle
 * rung of resolveRunTypeLaunchDefaults, which quick sessions and flow runs both
 * resolve through. These tests drive the real onboardingStore + configStore
 * (only the API/IPC layers are mocked) so the seed → pick → persist → advance
 * wiring is exercised end to end.
 *
 * The store-level conditional-navigation mechanics (skip/back/goTo over step 2)
 * live in onboardingStore.test.ts; this file is scoped to what the gate renders
 * and writes.
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
// Next lands on the Model step (3), which discovers the Codex catalog whenever
// Codex is the resolved default agent.
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

const OMP_DETECTED: ProviderDetectionResult<'omp'> = {
  state: 'detected',
  binaryPath: '/usr/local/bin/omp',
  version: '17.3.3',
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
    if (provider === 'omp') return { success: true, data: OMP_DETECTED };
  }
  return { success: true };
});

beforeEach(() => {
  projectsGetAll.mockReset().mockResolvedValue({ success: true, data: [] });
  configGet.mockReset().mockResolvedValue({ success: true, data: baseAppConfig() });
  configUpdate.mockReset().mockResolvedValue({ success: true });
  configApplyRunTypeDefault.mockReset().mockResolvedValue({ success: true, data: {} });
  modelsGetCatalog
    .mockReset()
    .mockResolvedValue({ success: true, data: { models: [], defaultModel: null } });
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
 * Renders the gate, waits for boot hydration, then parks it on step 2 with the
 * given providers activated (probe green + consent toggle on).
 */
async function mountAtDefaultRuntimeStep(
  config: AppConfig,
  activated: { claude?: boolean; codex?: boolean; omp?: boolean },
): Promise<void> {
  render(<OnboardingGate />);
  await waitFor(() => expect(useOnboardingStore.getState().hydrated).toBe(true));
  act(() => {
    useConfigStore.setState({ config });
    useOnboardingStore.setState({
      status: 'active',
      step: 2,
      maxVisitedStep: 2,
      multiRuntime: true,
      detection: activated.claude ? CLAUDE_DETECTED : null,
      connected: activated.claude === true,
      codexDetection: activated.codex ? CODEX_DETECTED : null,
      codexConnected: activated.codex === true,
      ompDetection: activated.omp ? OMP_DETECTED : null,
      ompConnected: activated.omp === true,
    });
  });
  await screen.findByRole('radiogroup', { name: 'Default agent for new sessions' });
}

describe('OnboardingGate — Default agent step (2)', () => {
  it('offers exactly the activated providers, each labelled with the runtime it resolves to', async () => {
    await mountAtDefaultRuntimeStep(baseAppConfig(), { claude: true, codex: true });

    expect(screen.getByRole('radio', { name: /Claude/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Codex/ })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /OMP/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    // The provider→runtime mapping is shown, not implied.
    expect(screen.getByRole('radio', { name: /Claude/ })).toHaveTextContent('Claude SDK');
    expect(screen.getByRole('radio', { name: /Codex/ })).toHaveTextContent('Codex SDK');
  });

  it('still excludes OMP when it is activated too — it is not default-eligible', async () => {
    await mountAtDefaultRuntimeStep(baseAppConfig(), { claude: true, codex: true, omp: true });
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.queryByRole('radio', { name: /OMP/ })).not.toBeInTheDocument();
  });

  it('shows no blurbs — just the provider name and the runtime it resolves to', async () => {
    await mountAtDefaultRuntimeStep(baseAppConfig(), { claude: true, codex: true });

    expect(screen.getByRole('radio', { name: /Claude/ })).toHaveTextContent(/^ClaudeClaude SDK$/);
    expect(screen.getByRole('radio', { name: /Codex/ })).toHaveTextContent(/^CodexCodex SDK$/);
  });

  it('qualifies the Cyboflow-chat claim only while Codex is the highlighted pick', async () => {
    await mountAtDefaultRuntimeStep(baseAppConfig(), { claude: true, codex: true });

    // Claude preselected — nothing to qualify.
    expect(
      screen.queryByText('The Cyboflow chat assistant runs on Claude for now.'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: /Codex/ }));

    expect(
      await screen.findByText('The Cyboflow chat assistant runs on Claude for now.'),
    ).toBeInTheDocument();
  });

  it('preselects the first activated provider on a pristine install', async () => {
    await mountAtDefaultRuntimeStep(baseAppConfig(), { claude: true, codex: true });

    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Claude/ })).toHaveAttribute('aria-checked', 'true'),
    );
    expect(screen.getByRole('radio', { name: /Codex/ })).toHaveAttribute('aria-checked', 'false');
  });

  it('seeds from the SAVED defaultAgentRuntime on replay of a configured install', async () => {
    await mountAtDefaultRuntimeStep(baseAppConfig({ defaultAgentRuntime: 'codex-sdk' }), {
      claude: true,
      codex: true,
    });

    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Codex/ })).toHaveAttribute('aria-checked', 'true'),
    );
  });

  it('falls back to the first candidate when the saved default is no longer activated', async () => {
    // Saved default names Codex, but this run left only Claude + OMP on — the
    // step must never preselect a provider the Connect step did not activate.
    await mountAtDefaultRuntimeStep(baseAppConfig({ defaultAgentRuntime: 'codex-sdk' }), {
      claude: true,
      omp: true,
    });

    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Claude/ })).toHaveAttribute('aria-checked', 'true'),
    );
  });

  it('persists the picked provider’s structured runtime on Next, then advances to the Model step (3)', async () => {
    await mountAtDefaultRuntimeStep(baseAppConfig(), { claude: true, codex: true });

    fireEvent.click(screen.getByRole('radio', { name: /Codex/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));

    await waitFor(() =>
      expect(configUpdate).toHaveBeenCalledWith({ defaultAgentRuntime: 'codex-sdk' }),
    );
    await waitFor(() => expect(useOnboardingStore.getState().step).toBe(3));
  });

  it('persists the preselected provider when the user just presses Next', async () => {
    await mountAtDefaultRuntimeStep(baseAppConfig(), { claude: true, codex: true });

    fireEvent.click(await screen.findByRole('button', { name: 'Next →' }));

    await waitFor(() =>
      expect(configUpdate).toHaveBeenCalledWith({ defaultAgentRuntime: 'claude-sdk' }),
    );
  });

  it('advances anyway when the config write fails (non-fatal — Settings still owns the default)', async () => {
    configUpdate.mockRejectedValue(new Error('disk full'));
    await mountAtDefaultRuntimeStep(baseAppConfig(), { claude: true, codex: true });

    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));

    await waitFor(() => expect(useOnboardingStore.getState().step).toBe(3));
  });

  it('renders the dialog title and a progress counter that includes this step', async () => {
    await mountAtDefaultRuntimeStep(baseAppConfig(), { claude: true, codex: true });

    expect(screen.getByRole('dialog', { name: 'Pick your default agent' })).toBeInTheDocument();
    expect(screen.getByText('STEP 3 / 7')).toBeInTheDocument();
  });

  it('drops this step from the progress counter on a single-provider run', async () => {
    // Same chrome, multiRuntime off: the run shows 8 steps, and the step the
    // user is standing on renumbers accordingly.
    render(<OnboardingGate />);
    await waitFor(() => expect(useOnboardingStore.getState().hydrated).toBe(true));
    act(() => {
      useConfigStore.setState({ config: baseAppConfig() });
      useOnboardingStore.setState({
        status: 'active',
        step: 3,
        maxVisitedStep: 3,
        multiRuntime: false,
      });
    });

    expect(await screen.findByText('STEP 3 / 6')).toBeInTheDocument();
  });

  it('Back from the Model step (3) returns here when the step is part of the run', async () => {
    await mountAtDefaultRuntimeStep(baseAppConfig(), { claude: true, codex: true });

    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
    await waitFor(() => expect(useOnboardingStore.getState().step).toBe(3));

    fireEvent.click(screen.getByRole('button', { name: '← Back' }));
    expect(useOnboardingStore.getState().step).toBe(2);
    await screen.findByRole('radiogroup', { name: 'Default agent for new sessions' });
  });
});
