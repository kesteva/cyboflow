/**
 * OnboardingGate — step 1 (Connect) provider-access coverage.
 *
 * The step-1 toggles are not a tour-local consent flag: Continue persists them
 * to AppConfig.agentProviderAccess, the SAME field Settings → Integrations
 * edits, so a provider left off during onboarding is off app-wide (hidden from
 * every runtime picker, rejected at the launch seams).
 *
 * Drives the real onboardingStore + configStore (only the API/IPC layers are
 * mocked) so the seed → toggle → persist → advance wiring is exercised end to
 * end: seeding from a SAVED setting on replay, a pristine install staying
 * opt-in, the full (never partial) persisted payload, and the non-fatal
 * failure path.
 *
 * Continue ALSO owns the single-candidate `defaultAgentRuntime` write: when the
 * step leaves exactly one of {claude, codex} activated the conditional
 * Default-agent step (2) is skipped, so this is the only place such an install
 * can record which agent it launches on. Two candidates leave the field to
 * step 2.
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
import type { AgentProviderAccess } from '../../../../shared/types/agentRuntime';
import type { AppConfig } from '../../types/config';

const projectsGetAll = vi.fn();
const configGet = vi.fn();
const configUpdate = vi.fn();
const configApplyRunTypeDefault = vi.fn();
// Continue can land the tour on the Model step (3), which discovers the Codex
// catalog when Codex is the resolved default agent.
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

function baseAppConfig(access?: AgentProviderAccess): AppConfig {
  return {
    gitRepoPath: '/repo',
    telemetry: { installId: 'inst-1', errorReportingEnabled: true, usageMetricsEnabled: true },
    ...(access ? { agentProviderAccess: access } : {}),
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

// All three probes report a healthy account/binary, so the step's toggles are
// enabled and the "at least one detected provider" gate can actually be
// satisfied. OMP never participates in that gate (it is optional), but its
// probe still needs a response or the step stays in its loading state.
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

/** Renders the gate, waits for boot hydration, then parks it on step 1. */
async function mountAtConnectStep(config: AppConfig | null): Promise<void> {
  render(<OnboardingGate />);
  await waitFor(() => expect(useOnboardingStore.getState().hydrated).toBe(true));
  act(() => {
    if (config) useConfigStore.setState({ config });
    useOnboardingStore.setState({ status: 'active', step: 1, maxVisitedStep: 1 });
  });
  await screen.findByRole('switch', { name: 'Use Claude Code in Cyboflow' });
}

describe('OnboardingGate — Connect step (1) provider access', () => {
  it('leaves both toggles off on a pristine install (no saved setting)', async () => {
    await mountAtConnectStep(baseAppConfig());

    expect(screen.getByRole('switch', { name: 'Use Claude Code in Cyboflow' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByRole('switch', { name: 'Use Codex in Cyboflow' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    // The gate still demands an explicit opt-in.
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled();
  });

  it('seeds the toggles from the SAVED provider access (replay on a configured install)', async () => {
    await mountAtConnectStep(baseAppConfig({ claude: true, codex: false }));

    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Use Claude Code in Cyboflow' })).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    );
    expect(screen.getByRole('switch', { name: 'Use Codex in Cyboflow' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('persists BOTH toggles to agentProviderAccess on Continue, then advances', async () => {
    await mountAtConnectStep(baseAppConfig());

    fireEvent.click(screen.getByRole('switch', { name: 'Use Claude Code in Cyboflow' }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));

    // Full object, never a partial patch: the provider the user left off must be
    // written as explicitly off, not merely omitted (omission floors to ON).
    // OMP rides along at its untouched default (false) — the same absent⇒
    // disabled floor AGENT_PROVIDER_REGISTRY.omp itself uses. Claude is the sole
    // candidate, so the runtime rides along in the SAME write.
    await waitFor(() =>
      expect(configUpdate).toHaveBeenCalledWith({
        agentProviderAccess: { claude: true, codex: false, omp: false },
        defaultAgentRuntime: 'claude-sdk',
      }),
    );
    // ONE activated provider, so the conditional Default-agent step (2) has no
    // question to ask and Continue lands straight on the Model step (3).
    await waitFor(() => expect(useOnboardingStore.getState().step).toBe(3));
    expect(useOnboardingStore.getState().multiRuntime).toBe(false);
  });

  it('writes both providers on when the user enables both', async () => {
    await mountAtConnectStep(baseAppConfig());

    fireEvent.click(screen.getByRole('switch', { name: 'Use Claude Code in Cyboflow' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Use Codex in Cyboflow' }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));

    // TWO candidates: the runtime question belongs to step 2, so Continue must
    // NOT pre-answer it here.
    await waitFor(() =>
      expect(configUpdate).toHaveBeenCalledWith({
        agentProviderAccess: { claude: true, codex: true, omp: false },
      }),
    );
    // TWO activated providers ⇒ the Default-agent step is part of this run.
    await waitFor(() => expect(useOnboardingStore.getState().step).toBe(2));
    expect(useOnboardingStore.getState().multiRuntime).toBe(true);
  });

  it('leaves OMP off by default even when Continue is clicked without touching its toggle', async () => {
    await mountAtConnectStep(baseAppConfig());

    fireEvent.click(screen.getByRole('switch', { name: 'Use Claude Code in Cyboflow' }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));

    await waitFor(() =>
      expect(configUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ agentProviderAccess: expect.objectContaining({ omp: false }) }),
      ),
    );
  });

  it('persists an explicit OMP opt-in alongside claude, and never gates Continue on it', async () => {
    await mountAtConnectStep(baseAppConfig());

    fireEvent.click(screen.getByRole('switch', { name: 'Use Claude Code in Cyboflow' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Use OMP in Cyboflow' }));
    const continueButton = screen.getByRole('button', { name: /Continue/ });
    // Enabled purely off the claude toggle — OMP is never part of the gate.
    expect(continueButton).toBeEnabled();
    fireEvent.click(continueButton);

    await waitFor(() =>
      expect(configUpdate).toHaveBeenCalledWith({
        agentProviderAccess: { claude: true, codex: false, omp: true },
        defaultAgentRuntime: 'claude-sdk',
      }),
    );
    // Claude + OMP both activated, but OMP is not DEFAULT-eligible (no picker
    // offers its runtimes), so this is still a single-candidate run: the
    // Default-agent step is skipped and Continue lands on the Model step (3).
    await waitFor(() => expect(useOnboardingStore.getState().step).toBe(3));
    expect(useOnboardingStore.getState().multiRuntime).toBe(false);
  });

  it('writes codex-sdk as the default runtime on a Codex-only install', async () => {
    await mountAtConnectStep(baseAppConfig());

    fireEvent.click(screen.getByRole('switch', { name: 'Use Codex in Cyboflow' }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));

    await waitFor(() =>
      expect(configUpdate).toHaveBeenCalledWith({
        agentProviderAccess: { claude: false, codex: true, omp: false },
        defaultAgentRuntime: 'codex-sdk',
      }),
    );
  });

  it('seeds the OMP toggle from a saved setting, defaulting OFF when absent', async () => {
    await mountAtConnectStep(baseAppConfig({ claude: true, codex: false, omp: true }));

    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Use OMP in Cyboflow' })).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    );
  });

  it('leaves the OMP toggle off on a pristine install, unlike claude/codex which seed true', async () => {
    await mountAtConnectStep(baseAppConfig());

    expect(screen.getByRole('switch', { name: 'Use OMP in Cyboflow' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('advances anyway when the config write fails (non-fatal — Settings still owns the toggles)', async () => {
    configUpdate.mockRejectedValue(new Error('disk full'));
    await mountAtConnectStep(baseAppConfig());

    fireEvent.click(screen.getByRole('switch', { name: 'Use Codex in Cyboflow' }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));

    await waitFor(() => expect(useOnboardingStore.getState().step).toBe(3));
  });
});
