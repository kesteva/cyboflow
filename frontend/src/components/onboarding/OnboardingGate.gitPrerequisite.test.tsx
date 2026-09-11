/**
 * OnboardingGate — the git prerequisite card. Not a tour step: the gate probes
 * `API.git.detect` once per active tour and, while the result is not 'ready',
 * renders the card IN FRONT of whichever modal step the tour is on
 * (shared/types/gitPrerequisite.ts). Drives the real onboardingStore with the
 * API layer mocked, covering: the no-flash hold until the probe resolves, the
 * 'missing' body + "Check again" (refresh: true), the 'identity' form writing
 * through `API.git.setIdentity`, the "continue anyway" dismissal, the
 * fail-open path when the bridge is absent, and the arrow-key guard.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OnboardingGate } from './OnboardingGate';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { useConfigStore } from '../../stores/configStore';
import type { GitPrerequisiteResult } from '../../../../shared/types/gitPrerequisite';

const projectsGetAll = vi.fn();
const configGet = vi.fn();
const configUpdate = vi.fn();
const gitDetect = vi.fn();
const gitSetIdentity = vi.fn();
const trackEvent = vi.fn();

vi.mock('../../utils/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/telemetry')>();
  return { ...actual, trackEvent: (...a: unknown[]) => trackEvent(...a) };
});

vi.mock('../../utils/api', () => ({
  API: {
    projects: { getAll: (...a: unknown[]) => projectsGetAll(...a) },
    config: {
      get: (...a: unknown[]) => configGet(...a),
      update: (...a: unknown[]) => configUpdate(...a),
    },
    git: {
      detect: (...a: unknown[]) => gitDetect(...a),
      setIdentity: (...a: unknown[]) => gitSetIdentity(...a),
    },
    dialog: { openFile: vi.fn(), openDirectory: vi.fn() },
  },
}));

const MISSING: GitPrerequisiteResult = {
  platform: 'win32',
  binary: { found: false, path: null, version: null },
  identity: { name: null, email: null },
  state: 'missing',
};

const IDENTITY: GitPrerequisiteResult = {
  platform: 'darwin',
  binary: { found: true, path: '/usr/bin/git', version: '2.45.2' },
  identity: { name: 'Ada', email: null },
  state: 'identity',
};

const READY: GitPrerequisiteResult = {
  ...IDENTITY,
  identity: { name: 'Ada', email: 'ada@example.com' },
  state: 'ready',
};

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

const openExternal = vi.fn();

beforeEach(() => {
  projectsGetAll.mockReset().mockResolvedValue({ success: true, data: [] });
  configGet.mockReset().mockResolvedValue({ success: true, data: { gitRepoPath: '/repo' } });
  configUpdate.mockReset().mockResolvedValue({ success: true });
  gitDetect.mockReset();
  gitSetIdentity.mockReset();
  trackEvent.mockReset();
  openExternal.mockReset();
  (window as unknown as { electronAPI: { openExternal: typeof openExternal } }).electronAPI = { openExternal };
  useOnboardingStore.setState(INITIAL_ONBOARDING_STATE);
  useConfigStore.setState({ config: null, isLoading: false, error: null });
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

/** Renders the gate, waits for boot hydration, then activates the tour on step 0. */
async function mountActive(): Promise<void> {
  render(<OnboardingGate />);
  await waitFor(() => expect(useOnboardingStore.getState().hydrated).toBe(true));
  act(() => {
    useOnboardingStore.setState({ status: 'active', step: 0, maxVisitedStep: 0 });
  });
}

describe('OnboardingGate — git prerequisite card', () => {
  it('holds the tour until the probe resolves, then shows the Welcome card when git is ready', async () => {
    let resolveProbe: (r: { success: boolean; data: GitPrerequisiteResult }) => void = () => {};
    gitDetect.mockReturnValue(new Promise((r) => (resolveProbe = r)));
    await mountActive();

    // Probe in flight: nothing rendered (no Welcome flash on a git-less machine).
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(gitDetect).toHaveBeenCalledWith({ refresh: false });

    await act(async () => resolveProbe({ success: true, data: READY }));
    expect(await screen.findByRole('dialog', { name: 'Welcome to Cyboflow' })).toBeInTheDocument();
    expect(trackEvent).not.toHaveBeenCalledWith('onboarding_prerequisite_blocked', expect.anything());
  });

  it("renders the 'missing' card with the host's install line and re-probes with refresh on Check again", async () => {
    gitDetect.mockResolvedValueOnce({ success: true, data: MISSING }).mockResolvedValueOnce({ success: true, data: READY });
    await mountActive();

    const dialog = await screen.findByRole('dialog', { name: 'Git is required' });
    expect(dialog).toHaveTextContent('winget install --id Git.Git -e --source winget');
    expect(dialog).not.toHaveTextContent('brew install git');
    // No tour chrome: no step counter, no Back.
    expect(dialog).not.toHaveTextContent(/STEP \d/);
    expect(screen.queryByRole('button', { name: /Back/ })).not.toBeInTheDocument();
    expect(trackEvent).toHaveBeenCalledWith('onboarding_prerequisite_blocked', { prerequisite: 'git_missing' });

    fireEvent.click(screen.getByRole('button', { name: 'Download git' }));
    expect(openExternal).toHaveBeenCalledWith('https://git-scm.com/downloads');

    fireEvent.click(screen.getByRole('button', { name: /Check again/ }));
    await waitFor(() => expect(gitDetect).toHaveBeenLastCalledWith({ refresh: true }));
    expect(await screen.findByRole('dialog', { name: 'Welcome to Cyboflow' })).toBeInTheDocument();
    expect(useOnboardingStore.getState().step).toBe(0);
  });

  it("renders the 'identity' form seeded from git's half-set identity and saves through the bridge", async () => {
    gitDetect.mockResolvedValue({ success: true, data: IDENTITY });
    gitSetIdentity.mockResolvedValue({ success: true, data: READY });
    await mountActive();

    await screen.findByRole('dialog', { name: 'Tell git who you are' });
    const name = screen.getByLabelText('NAME');
    const email = screen.getByLabelText('EMAIL');
    expect(name).toHaveValue('Ada');
    expect(email).toHaveValue('');
    const save = screen.getByRole('button', { name: 'Save & continue' });
    expect(save).toBeDisabled();

    fireEvent.change(email, { target: { value: 'ada@example.com' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(gitSetIdentity).toHaveBeenCalledWith({ name: 'Ada', email: 'ada@example.com' }));
    expect(await screen.findByRole('dialog', { name: 'Welcome to Cyboflow' })).toBeInTheDocument();
    expect(trackEvent).toHaveBeenCalledWith('onboarding_prerequisite_blocked', { prerequisite: 'git_identity' });
  });

  it('shows a save failure inline and keeps the form up', async () => {
    gitDetect.mockResolvedValue({ success: true, data: IDENTITY });
    gitSetIdentity.mockResolvedValue({ success: false, error: 'Enter a valid email address.' });
    await mountActive();

    await screen.findByRole('dialog', { name: 'Tell git who you are' });
    fireEvent.change(screen.getByLabelText('EMAIL'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save & continue' }));

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Tell git who you are' })).toBeInTheDocument();
  });

  it('lets the user continue without git for this boot, without advancing the tour', async () => {
    gitDetect.mockResolvedValue({ success: true, data: MISSING });
    await mountActive();

    await screen.findByRole('dialog', { name: 'Git is required' });
    fireEvent.click(screen.getByRole('button', { name: 'Continue without git' }));

    expect(await screen.findByRole('dialog', { name: 'Welcome to Cyboflow' })).toBeInTheDocument();
    expect(useOnboardingStore.getState().step).toBe(0);
    expect(useOnboardingStore.getState().status).toBe('active');
  });

  it('keeps ArrowRight/ArrowLeft from driving the tour behind the card', async () => {
    gitDetect.mockResolvedValue({ success: true, data: MISSING });
    await mountActive();
    await screen.findByRole('dialog', { name: 'Git is required' });

    // ArrowRight fires the card's own primary (a re-probe), not the tour's "Let's go".
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(gitDetect).toHaveBeenLastCalledWith({ refresh: true }));
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(useOnboardingStore.getState().step).toBe(0);
  });

  it('fails open when the bridge throws (never walls the tour off on a broken probe)', async () => {
    gitDetect.mockRejectedValue(new Error('Electron API not available'));
    await mountActive();

    expect(await screen.findByRole('dialog', { name: 'Welcome to Cyboflow' })).toBeInTheDocument();
  });

  it('does not probe when the tour is not active (an install upgrading in with projects)', async () => {
    gitDetect.mockResolvedValue({ success: true, data: MISSING });
    projectsGetAll.mockResolvedValue({ success: true, data: [{ id: 1 }] });
    render(<OnboardingGate />);
    await waitFor(() => expect(useOnboardingStore.getState().hydrated).toBe(true));
    expect(useOnboardingStore.getState().status).toBe('completed');
    expect(gitDetect).not.toHaveBeenCalled();
  });
});
