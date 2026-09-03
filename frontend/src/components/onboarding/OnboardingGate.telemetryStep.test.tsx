/**
 * OnboardingGate — step 5 (Telemetry) integration coverage (TASK-066). Drives
 * the real onboardingStore + configStore (only the API layer is mocked) so the
 * gate's resolve/submit/error wiring is exercised end to end: resolved
 * initialization from AppConfig.telemetry (never a hardcoded default), replay
 * re-resolving fresh, each single-channel-off + both-off continuation, the
 * complete persisted payload (installId preserved), changed-vs-unchanged event
 * emission, duplicate-submit prevention, and the retryable failure path. Also
 * covers this step's participation in the shared modal chrome (dialog title +
 * "STEP n / total" progress, Back, Skip) — the chrome itself is generic
 * (OnboardingModalCard, no dedicated test file of its own), so these assert
 * step 5 wires into it correctly rather than re-testing the chrome's mechanics.
 *
 * Steps 1-4 are skipped by jumping the store directly to step 5 after boot
 * hydration resolves — this file is scoped to step 5's behavior, not the full
 * tour walkthrough (Back/Skip/goTo store-level mechanics live in
 * onboardingStore.test.ts; onboardingTelemetry.test.ts covers the emitted
 * onboarding_* usage-telemetry events).
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OnboardingGate } from './OnboardingGate';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { useConfigStore } from '../../stores/configStore';
import type { AppConfig } from '../../types/config';

const trackEvent = vi.fn();
const projectsGetAll = vi.fn();
const configGet = vi.fn();
const configUpdate = vi.fn();

vi.mock('../../utils/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/telemetry')>();
  return {
    ...actual,
    trackEvent: (...a: unknown[]) => trackEvent(...a),
    // Delegate to the REAL diff-and-emit helper with the spy injected, so the
    // shared logic stays single-source while assertions still see the events.
    emitTelemetryChangeEvents: (
      baseline: Parameters<typeof actual.emitTelemetryChangeEvents>[0],
      next: Parameters<typeof actual.emitTelemetryChangeEvents>[1],
    ) => actual.emitTelemetryChangeEvents(baseline, next, ((...a: unknown[]) => trackEvent(...a)) as typeof actual.trackEvent),
  };
});

vi.mock('../../utils/api', () => ({
  API: {
    projects: { getAll: (...a: unknown[]) => projectsGetAll(...a) },
    config: {
      get: (...a: unknown[]) => configGet(...a),
      update: (...a: unknown[]) => configUpdate(...a),
    },
    dialog: { openFile: vi.fn(), openDirectory: vi.fn() },
  },
}));

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

beforeEach(() => {
  trackEvent.mockReset();
  projectsGetAll.mockReset().mockResolvedValue({ success: true, data: [] });
  configGet.mockReset().mockResolvedValue({ success: true, data: baseAppConfig() });
  configUpdate.mockReset().mockResolvedValue({ success: true });
  useOnboardingStore.setState(INITIAL_ONBOARDING_STATE);
  useConfigStore.setState({ config: null, isLoading: false, error: null });
});

/** Renders the gate, waits for boot hydration, then jumps directly to step 5. */
async function mountAtTelemetryStep(config: AppConfig | null): Promise<void> {
  render(<OnboardingGate />);
  await waitFor(() => expect(useOnboardingStore.getState().hydrated).toBe(true));
  act(() => {
    if (config) useConfigStore.setState({ config });
    useOnboardingStore.setState({ status: 'active', step: 5, maxVisitedStep: 4 });
  });
}

describe('OnboardingGate — Telemetry step (5)', () => {
  it('resolves the draft from AppConfig.telemetry, not a hardcoded default', async () => {
    await mountAtTelemetryStep(
      baseAppConfig({ telemetry: { installId: 'inst-2', errorReportingEnabled: true, usageMetricsEnabled: false } }),
    );

    const errors = await screen.findByRole('switch', { name: 'Send anonymized crash & error reports' });
    const usage = screen.getByRole('switch', { name: 'Send anonymized feature usage metrics' });
    expect(errors).toHaveAttribute('aria-checked', 'true');
    expect(usage).toHaveAttribute('aria-checked', 'false');
  });

  it('re-resolves fresh on replay instead of carrying over a stale draft', async () => {
    await mountAtTelemetryStep(
      baseAppConfig({ telemetry: { installId: 'inst-3', errorReportingEnabled: true, usageMetricsEnabled: true } }),
    );
    await screen.findByRole('switch', { name: 'Send anonymized crash & error reports' });

    // Leave step 4, change the resolved config (simulating a Settings edit
    // between tour runs), then re-enter step 4 as Settings → Replay walkthrough
    // would (restart() re-walks the whole tour from step 0).
    act(() => {
      useOnboardingStore.setState({ step: 0 });
    });
    act(() => {
      useConfigStore.setState({
        config: baseAppConfig({ telemetry: { installId: 'inst-3', errorReportingEnabled: false, usageMetricsEnabled: false } }),
      });
      useOnboardingStore.setState({ step: 5 });
    });

    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Send anonymized crash & error reports' })).toHaveAttribute(
        'aria-checked',
        'false',
      );
    });
    expect(screen.getByRole('switch', { name: 'Send anonymized feature usage metrics' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('continues with both channels off', async () => {
    await mountAtTelemetryStep(baseAppConfig());
    fireEvent.click(await screen.findByRole('switch', { name: 'Send anonymized crash & error reports' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Send anonymized feature usage metrics' }));

    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));

    await waitFor(() => expect(useOnboardingStore.getState().step).toBe(6));
    expect(configUpdate).toHaveBeenCalledWith({
      telemetry: { installId: 'inst-1', errorReportingEnabled: false, usageMetricsEnabled: false },
    });
  });

  it('continues with only Sentry (crash/error) off, Aptabase (usage) left on', async () => {
    await mountAtTelemetryStep(baseAppConfig());
    fireEvent.click(await screen.findByRole('switch', { name: 'Send anonymized crash & error reports' }));

    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));

    await waitFor(() => expect(useOnboardingStore.getState().step).toBe(6));
    expect(configUpdate).toHaveBeenCalledWith({
      telemetry: { installId: 'inst-1', errorReportingEnabled: false, usageMetricsEnabled: true },
    });
  });

  it('continues with only Aptabase (usage) off, Sentry (crash/error) left on', async () => {
    await mountAtTelemetryStep(baseAppConfig());
    fireEvent.click(await screen.findByRole('switch', { name: 'Send anonymized feature usage metrics' }));

    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));

    await waitFor(() => expect(useOnboardingStore.getState().step).toBe(6));
    expect(configUpdate).toHaveBeenCalledWith({
      telemetry: { installId: 'inst-1', errorReportingEnabled: true, usageMetricsEnabled: false },
    });
    expect(trackEvent).toHaveBeenCalledWith('telemetry_opt_out_changed', { channel: 'usage', enabled: false });
    expect(trackEvent).not.toHaveBeenCalledWith('telemetry_opt_out_changed', { channel: 'errors', enabled: true });
  });

  it('submits the complete telemetry object, preserving installId, and advances on success', async () => {
    await mountAtTelemetryStep(baseAppConfig());
    fireEvent.click(await screen.findByRole('button', { name: 'Next →' }));

    await waitFor(() =>
      expect(configUpdate).toHaveBeenCalledWith({
        telemetry: { installId: 'inst-1', errorReportingEnabled: true, usageMetricsEnabled: true },
      }),
    );
    await waitFor(() => expect(useOnboardingStore.getState().step).toBe(6));
  });

  it('emits telemetry_opt_out_changed only for the channel that actually changed', async () => {
    await mountAtTelemetryStep(baseAppConfig());
    fireEvent.click(await screen.findByRole('switch', { name: 'Send anonymized crash & error reports' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));

    await waitFor(() => expect(useOnboardingStore.getState().step).toBe(6));
    expect(trackEvent).toHaveBeenCalledWith('telemetry_opt_out_changed', { channel: 'errors', enabled: false });
    expect(trackEvent).not.toHaveBeenCalledWith('telemetry_opt_out_changed', { channel: 'usage', enabled: true });
  });

  it('emits nothing when neither channel changed', async () => {
    await mountAtTelemetryStep(baseAppConfig());
    fireEvent.click(await screen.findByRole('button', { name: 'Next →' }));

    await waitFor(() => expect(useOnboardingStore.getState().step).toBe(6));
    expect(trackEvent).not.toHaveBeenCalledWith('telemetry_opt_out_changed', expect.anything());
  });

  it('prevents a duplicate submit from a rapid double-click', async () => {
    let resolveUpdate!: (v: { success: true }) => void;
    configUpdate.mockReturnValue(new Promise((resolve) => { resolveUpdate = resolve; }));
    await mountAtTelemetryStep(baseAppConfig());

    const nextButton = await screen.findByRole('button', { name: 'Next →' });
    fireEvent.click(nextButton);
    fireEvent.click(nextButton);
    fireEvent.click(nextButton);

    expect(configUpdate).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveUpdate({ success: true });
      configGet.mockResolvedValue({ success: true, data: baseAppConfig() });
      await Promise.resolve();
    });
    await waitFor(() => expect(useOnboardingStore.getState().step).toBe(6));
    expect(configUpdate).toHaveBeenCalledTimes(1);
  });

  it('leaves the user on step 4 with a visible retryable error when the save fails', async () => {
    configUpdate.mockResolvedValue({ success: false, error: 'disk full' });
    await mountAtTelemetryStep(baseAppConfig());

    fireEvent.click(await screen.findByRole('button', { name: 'Next →' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('disk full');
    expect(useOnboardingStore.getState().step).toBe(5);
    expect(useOnboardingStore.getState().status).toBe('active');
  });

  it('retries successfully after a prior failure', async () => {
    configUpdate.mockResolvedValueOnce({ success: false, error: 'disk full' });
    await mountAtTelemetryStep(baseAppConfig());

    const nextButton = await screen.findByRole('button', { name: 'Next →' });
    fireEvent.click(nextButton);
    await screen.findByRole('alert');

    configUpdate.mockResolvedValueOnce({ success: true });
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));

    await waitFor(() => expect(useOnboardingStore.getState().step).toBe(6));
    expect(configUpdate).toHaveBeenCalledTimes(2);
  });

  // Card chrome (title, "STEP n / total" progress, Back/Skip) is rendered by
  // the shared OnboardingModalCard, driven by the real (unmocked)
  // onboardingStore — these assert THIS step (5) actually wires up to it
  // correctly, not the chrome's own generic mechanics.
  it('renders the dialog title and progress indicator for step 5', async () => {
    await mountAtTelemetryStep(baseAppConfig());
    await screen.findByRole('switch', { name: 'Send anonymized crash & error reports' });

    expect(screen.getByRole('dialog', { name: 'Choose what to share' })).toBeInTheDocument();
    expect(screen.getByText('STEP 6 / 7')).toBeInTheDocument();
  });

  it('Back from step 5 returns to the Permission step (4) and unmounts the telemetry toggles', async () => {
    await mountAtTelemetryStep(baseAppConfig());
    await screen.findByRole('switch', { name: 'Send anonymized crash & error reports' });

    fireEvent.click(screen.getByRole('button', { name: '← Back' }));

    expect(useOnboardingStore.getState().step).toBe(4);
    await waitFor(() =>
      expect(screen.queryByRole('switch', { name: 'Send anonymized crash & error reports' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('dialog', { name: 'Set your permission mode' })).toBeInTheDocument();
  });

  it('Skip from step 5 exits the tour (status → skipped) without persisting telemetry', async () => {
    await mountAtTelemetryStep(baseAppConfig());
    await screen.findByRole('switch', { name: 'Send anonymized crash & error reports' });

    fireEvent.click(screen.getByTestId('onboarding-skip'));

    expect(useOnboardingStore.getState().status).toBe('skipped');
    expect(configUpdate).not.toHaveBeenCalled();
  });
});
