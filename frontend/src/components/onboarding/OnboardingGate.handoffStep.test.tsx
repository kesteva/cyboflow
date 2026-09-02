/**
 * OnboardingGate — step 6 ("You're set up") integration coverage.
 *
 * The last modal card is the fork between the tour's two halves, and the ONE
 * place a user can end the tour without ever seeing the guided set-up. Both
 * radio choices press the same button and call the same `next()`; what differs
 * is where the store lands — so these tests assert the pairing of the choice
 * with the button's LABEL (the only signal the user gets about what pressing it
 * does) and with the resulting transition.
 *
 * Drives the real onboardingStore (only the API/IPC layers are mocked); the
 * store-level transition rules live in onboardingStore.test.ts.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OnboardingGate } from './OnboardingGate';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { useConfigStore } from '../../stores/configStore';
import type { AppConfig } from '../../types/config';
import { peekAssistantGreeting } from '../agentRail/onboardingGreeting';

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

const invoke = vi.fn(async () => ({ success: true }));

beforeEach(() => {
  projectsGetAll.mockReset().mockResolvedValue({ success: true, data: [] });
  configGet.mockReset().mockResolvedValue({ success: true, data: baseAppConfig() });
  configUpdate.mockReset().mockResolvedValue({ success: true });
  configApplyRunTypeDefault.mockReset().mockResolvedValue({ success: true, data: { previous: null } });
  modelsGetCatalog
    .mockReset()
    .mockResolvedValue({ success: true, data: { models: [], defaultModel: null } });
  invoke.mockClear();
  (window as unknown as { electron: { invoke: typeof invoke } }).electron = { invoke };
  useOnboardingStore.setState(INITIAL_ONBOARDING_STATE);
  useConfigStore.setState({ config: null, isLoading: false, error: null });
});

afterEach(() => {
  delete (window as unknown as { electron?: unknown }).electron;
});

/** Renders the gate, waits for boot hydration, then jumps directly to step 6. */
async function mountAtHandoffStep(): Promise<void> {
  render(<OnboardingGate />);
  await waitFor(() => expect(useOnboardingStore.getState().hydrated).toBe(true));
  act(() => {
    useConfigStore.setState({ config: baseAppConfig() });
    useOnboardingStore.setState({ status: 'active', step: 6, maxVisitedStep: 6 });
  });
  await screen.findByRole('radiogroup', { name: 'How to start' });
}

describe('OnboardingGate — Handoff step (6)', () => {
  it('renders both choices with "Continue with onboarding" preselected', async () => {
    await mountAtHandoffStep();

    expect(screen.getByRole('dialog', { name: "You're set up" })).toBeInTheDocument();
    expect(screen.getByText('STEP 7 / 7')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Continue with onboarding/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: /Skip the set-up/ })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    // The duration promise the design makes for the guided half.
    expect(screen.getByRole('radio', { name: /Continue with onboarding/ })).toHaveTextContent(
      '~2 MIN',
    );
  });

  it('continues into the guided set-up (step 7) on the default choice', async () => {
    await mountAtHandoffStep();

    const primary = screen.getByRole('button', { name: 'Continue →' });
    fireEvent.click(primary);

    expect(useOnboardingStore.getState().step).toBe(7);
    expect(useOnboardingStore.getState().status).toBe('active');
  });

  it('relabels the primary and completes the tour on "Skip the set-up"', async () => {
    await mountAtHandoffStep();

    fireEvent.click(screen.getByRole('radio', { name: /Skip the set-up/ }));

    // The button's word is the only warning that this press ENDS the tour.
    const primary = await screen.findByRole('button', { name: 'Finish →' });
    expect(screen.queryByRole('button', { name: 'Continue →' })).not.toBeInTheDocument();

    fireEvent.click(primary);

    expect(useOnboardingStore.getState().status).toBe('completed');
    expect(useOnboardingStore.getState().step).toBe(6);
    // Finishing here is a tour exit too: the rail opens with the generic greeting.
    expect(peekAssistantGreeting()).toBe(
      "You're set up. If you need more help, ask me questions at any time.",
    );
    expect(localStorage.getItem('cyboflow.agentRail.collapsed')).toBe('false');
  });

  it('switching back to Continue restores the continuing label and transition', async () => {
    await mountAtHandoffStep();

    fireEvent.click(screen.getByRole('radio', { name: /Skip the set-up/ }));
    await screen.findByRole('button', { name: 'Finish →' });
    fireEvent.click(screen.getByRole('radio', { name: /Continue with onboarding/ }));

    fireEvent.click(await screen.findByRole('button', { name: 'Continue →' }));
    expect(useOnboardingStore.getState().step).toBe(7);
  });

  it('unmounts the card once the tour walks on to the guided screens', async () => {
    await mountAtHandoffStep();

    fireEvent.click(screen.getByRole('button', { name: 'Continue →' }));

    // Steps 7-8 are rendered by GuidedSetupSurface inside the shell row, not by
    // this portal — the gate stays mounted but must draw nothing.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByTestId('onboarding-skip')).not.toBeInTheDocument();
  });

  it('ignores ArrowRight/ArrowLeft once the tour is on a guided step', async () => {
    await mountAtHandoffStep();
    fireEvent.click(screen.getByRole('button', { name: 'Continue →' }));
    expect(useOnboardingStore.getState().step).toBe(7);

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });

    expect(useOnboardingStore.getState().step).toBe(7);
  });

  it('Back returns to Telemetry (5), and Skip leaves the tour resumable', async () => {
    await mountAtHandoffStep();

    fireEvent.click(screen.getByRole('button', { name: '← Back' }));
    expect(useOnboardingStore.getState().step).toBe(5);

    act(() => {
      useOnboardingStore.setState({ step: 6 });
    });
    fireEvent.click(await screen.findByTestId('onboarding-skip'));
    expect(useOnboardingStore.getState().status).toBe('skipped');
  });
});
