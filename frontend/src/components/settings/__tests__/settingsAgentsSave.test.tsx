/**
 * Settings save: the `agents` config block is sent ONLY when main says this is a dev build. A release build
 * rejects the key, which would fail the whole save.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Settings } from '../../Settings';
import type { AppConfig } from '../../../types/config';
import { usePersistentAgentsStore } from '../../../stores/persistentAgentsStore';
import { makeStatus } from '../../agentsEnv/__tests__/fixtures';

const configGet = vi.fn();
const configUpdate = vi.fn();
const getVersionInfo = vi.fn();
const projectsGetAll = vi.fn();

vi.mock('../../../utils/api', () => ({
  API: {
    config: {
      get: (...a: unknown[]) => configGet(...a),
      update: (...a: unknown[]) => configUpdate(...a),
    },
    projects: { getAll: (...a: unknown[]) => projectsGetAll(...a) },
    getVersionInfo: (...a: unknown[]) => getVersionInfo(...a),
  },
}));

vi.mock('../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'paper', setTheme: vi.fn() }),
}));

// Settings only READS the persistent-agents store; it must never call init() (which subscribes to the config
// store, and the wholesale mock below provides no subscribe).
vi.mock('../../../stores/configStore', () => ({
  useConfigStore: () => ({ fetchConfig: vi.fn().mockResolvedValue(undefined) }),
}));

function baseConfig(over: Partial<AppConfig> = {}): AppConfig {
  return { codeReviewEvalEnabled: true, computeCostFromRates: false, autoGradeVariantRuns: true, ...over };
}

beforeEach(() => {
  configGet.mockReset().mockResolvedValue({ success: true, data: baseConfig({ agents: { enabled: true } }) });
  configUpdate.mockReset().mockResolvedValue({ success: true });
  getVersionInfo.mockReset().mockResolvedValue({ success: true, data: { variant: 'dev' } });
  projectsGetAll.mockReset().mockResolvedValue({ success: true, data: [] });
});

async function saveFromAiTab(): Promise<Record<string, unknown>> {
  render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);
  await screen.findByLabelText('Auto-grade variant & experiment runs');
  fireEvent.click(screen.getByRole('button', { name: /save/i }));
  await waitFor(() => expect(configUpdate).toHaveBeenCalled());
  return configUpdate.mock.calls[0][0] as Record<string, unknown>;
}

describe('Settings: agents config save', () => {
  it('omits agents when the build is not a dev build', async () => {
    usePersistentAgentsStore.setState({ featureStatus: makeStatus({ devBuild: false, configEnabled: true, enabled: false, running: false }) });
    const sent = await saveFromAiTab();
    expect(sent).not.toHaveProperty('agents');
    expect(screen.queryByTestId('settings-agents-toggle')).not.toBeInTheDocument();
  });

  it('omits agents while the status is unknown', async () => {
    usePersistentAgentsStore.setState({ featureStatus: null });
    const sent = await saveFromAiTab();
    expect(sent).not.toHaveProperty('agents');
  });

  it('includes {agents:{enabled}} in a dev build, following the toggle', async () => {
    usePersistentAgentsStore.setState({ featureStatus: makeStatus({ devBuild: true }) });
    render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);
    const toggle = await screen.findByTestId('settings-agents-toggle');
    await waitFor(() => expect(toggle).toBeChecked());
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(configUpdate).toHaveBeenCalled());
    expect(configUpdate.mock.calls[0][0]).toEqual(expect.objectContaining({ agents: { enabled: false } }));
  });

  it('shows the kill-switch note from the status', async () => {
    usePersistentAgentsStore.setState({ featureStatus: makeStatus({ devBuild: true, killed: true, running: false }) });
    render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);
    expect(await screen.findByText(/CYBOFLOW_DISABLE_PERSISTENT_AGENTS/)).toBeInTheDocument();
  });
});
