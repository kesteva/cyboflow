import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderDetectionResult } from '../../../../shared/types/onboarding';
import type { AgentProviderAccess } from '../../../../shared/types/agentRuntime';
import { useConfigStore } from '../../stores/configStore';
import type { AppConfig } from '../../types/config';
import { IntegrationsSettings } from './IntegrationsSettings';

const detectClaude = vi.fn();
const detectCodex = vi.fn();
const detectOmp = vi.fn();
const { mockUseOmpAvailability } = vi.hoisted(() => ({ mockUseOmpAvailability: vi.fn() }));
vi.mock('../../hooks/useOmpAvailability', () => ({ useOmpAvailability: mockUseOmpAvailability }));

vi.mock('../../utils/api', () => ({
  API: {
    providers: {
      detect: (provider: string) =>
        provider === 'claude' ? detectClaude() : provider === 'codex' ? detectCodex() : detectOmp(),
    },
  },
}));

/** Seed the config store as the app's boot fetch would. */
function setProviderAccess(access: AgentProviderAccess | undefined): void {
  useConfigStore.setState({
    config: { gitRepoPath: '/repo', agentProviderAccess: access } as AppConfig,
  });
}

const CLAUDE_CONNECTED: ProviderDetectionResult<'claude'> = {
  state: 'detected',
  credentials: { found: true, source: 'keychain', account: 'claude@example.com' },
  binary: { found: true, path: '/usr/local/bin/claude', version: '1.2.3' },
};

const CODEX_CONNECTED: ProviderDetectionResult<'codex'> = {
  state: 'detected',
  runtime: { found: true, path: '/app/codex', version: '0.144.3' },
  account: { found: true, email: 'codex@example.com', planType: 'plus' },
};

const OMP_DETECTED: ProviderDetectionResult<'omp'> = {
  state: 'detected',
  binaryPath: '/usr/local/bin/omp',
  version: '17.3.3',
};

const OMP_MISSING: ProviderDetectionResult<'omp'> = {
  state: 'unavailable',
  binaryPath: null,
  version: null,
};

const OMP_UNSUPPORTED_VERSION: ProviderDetectionResult<'omp'> = {
  state: 'unavailable',
  binaryPath: '/usr/local/bin/omp',
  version: '3.0.0',
};

let updateConfig: ReturnType<typeof vi.fn>;

beforeEach(() => {
  detectClaude.mockReset().mockResolvedValue({ success: true, data: CLAUDE_CONNECTED });
  detectCodex.mockReset().mockResolvedValue({ success: true, data: CODEX_CONNECTED });
  detectOmp.mockReset().mockResolvedValue({ success: true, data: OMP_MISSING });
  updateConfig = vi.fn().mockResolvedValue(true);
  // Default install: OMP runs locally, so the row reports the local binary.
  mockUseOmpAvailability.mockReset().mockReturnValue({ launchable: false, ariaMode: false });
  useConfigStore.setState({ config: null, error: null, updateConfig });
});

describe('IntegrationsSettings', () => {
  it('shows Claude and Codex account status independently', async () => {
    render(<IntegrationsSettings />);

    expect(await screen.findByText('claude@example.com')).toBeInTheDocument();
    expect(await screen.findByText('codex@example.com')).toBeInTheDocument();
    expect(screen.getByText(/ChatGPT plus · Codex 0\.144\.3/)).toBeInTheDocument();
    expect(screen.getAllByText('Connected')).toHaveLength(2);
  });

  it('keeps a connected provider usable when its sibling needs sign-in', async () => {
    detectClaude.mockResolvedValue({
      success: true,
      data: {
        state: 'loggedOut',
        credentials: { found: false, source: null, account: null },
        binary: { found: true, path: '/usr/local/bin/claude', version: '1.2.3' },
      } satisfies ProviderDetectionResult<'claude'>,
    });

    render(<IntegrationsSettings />);

    expect(await screen.findByText('Sign-in required')).toBeInTheDocument();
    expect(await screen.findByText('codex@example.com')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('reports one failed probe without hiding the other provider and retries both', async () => {
    detectCodex.mockResolvedValueOnce({ success: false, error: 'Account probe timed out' });
    render(<IntegrationsSettings />);

    expect(await screen.findByText('Account probe timed out')).toBeInTheDocument();
    expect(await screen.findByText('claude@example.com')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(detectClaude).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(detectCodex).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('codex@example.com')).toBeInTheDocument();
  });
});

describe('IntegrationsSettings — provider access toggles', () => {
  it('shows both providers on when the setting has never been touched', async () => {
    setProviderAccess(undefined);
    render(<IntegrationsSettings />);

    expect(await screen.findByRole('switch', { name: 'Use Claude Code in Cyboflow' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Use Codex in Cyboflow' })).toBeChecked();
  });

  it('persists the FULL access object when a provider is switched off', async () => {
    setProviderAccess(undefined);
    render(<IntegrationsSettings />);

    fireEvent.click(await screen.findByRole('switch', { name: 'Use Codex in Cyboflow' }));

    // Full object, never a partial patch — the siblings must not be dropped.
    // OMP rides along at its untouched default (absent ⇒ off).
    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({
        agentProviderAccess: { claude: true, codex: false, omp: false },
      }),
    );
  });

  it('switches a provider back on from the off state', async () => {
    setProviderAccess({ claude: true, codex: false });
    render(<IntegrationsSettings />);

    const codexSwitch = await screen.findByRole('switch', { name: 'Use Codex in Cyboflow' });
    expect(codexSwitch).not.toBeChecked();

    fireEvent.click(codexSwitch);
    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({
        agentProviderAccess: { claude: true, codex: true, omp: false },
      }),
    );
  });

  it('locks the last enabled provider so the app can never end up with none', async () => {
    setProviderAccess({ claude: true, codex: false });
    render(<IntegrationsSettings />);

    const claudeSwitch = await screen.findByRole('switch', { name: 'Use Claude Code in Cyboflow' });
    expect(claudeSwitch).toBeDisabled();
    expect(claudeSwitch).toHaveAttribute('title', 'At least one provider must stay enabled.');

    fireEvent.click(claudeSwitch);
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('explains what a disabled provider means, and warns about the Claude-only surfaces', async () => {
    // omp: true so ONLY the Claude row is disabled here — otherwise OMP's
    // own (identical) "hidden from every runtime picker" hint would collide
    // with Claude's and make findByText ambiguous.
    setProviderAccess({ claude: false, codex: true, omp: true });
    render(<IntegrationsSettings />);

    expect(await screen.findByText(/hidden from every runtime picker/i)).toBeInTheDocument();
    expect(
      screen.getByText(/design sessions and visual verification, which always run on Claude/i),
    ).toBeInTheDocument();
  });

  it('surfaces a failed save instead of silently reverting', async () => {
    setProviderAccess(undefined);
    updateConfig.mockResolvedValue(false);
    useConfigStore.setState({ error: 'disk full' });
    render(<IntegrationsSettings />);

    fireEvent.click(await screen.findByRole('switch', { name: 'Use Codex in Cyboflow' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('disk full');
  });
});

describe('IntegrationsSettings — OMP card', () => {
  it('detects OMP is not gated by picker selectability — the card still shows and probes', async () => {
    detectOmp.mockResolvedValue({ success: true, data: OMP_DETECTED });
    render(<IntegrationsSettings />);

    expect(await screen.findByText('omp 17.3.3')).toBeInTheDocument();
    expect(screen.getByText('/usr/local/bin/omp')).toBeInTheDocument();
    expect(detectOmp).toHaveBeenCalled();
  });

  it('names an unsupported version explicitly rather than claiming omp is missing', async () => {
    detectOmp.mockResolvedValue({ success: true, data: OMP_UNSUPPORTED_VERSION });
    render(<IntegrationsSettings />);

    expect(await screen.findByText('Unsupported version')).toBeInTheDocument();
    expect(screen.getByText(/Found omp 3\.0\.0, but this version isn't supported/)).toBeInTheDocument();
  });

  it('shows an Install action only when the binary was not found at all', async () => {
    detectOmp.mockResolvedValue({ success: true, data: OMP_MISSING });
    render(<IntegrationsSettings />);

    await screen.findByText('Not available');
    expect(screen.getByRole('button', { name: 'Install' })).toBeInTheDocument();
  });

  it('does not offer Install for an unsupported-but-found version', async () => {
    detectOmp.mockResolvedValue({ success: true, data: OMP_UNSUPPORTED_VERSION });
    render(<IntegrationsSettings />);

    await screen.findByText('Unsupported version');
    // The Claude install button exists elsewhere in some states, so scope to
    // the absence of a SECOND Install action rather than absence entirely.
    expect(screen.queryAllByRole('button', { name: 'Install' })).toHaveLength(0);
  });

  it('defaults OFF (absent access key), unlike claude/codex which default on', async () => {
    setProviderAccess(undefined);
    render(<IntegrationsSettings />);

    expect(await screen.findByRole('switch', { name: 'Use Claude Code in Cyboflow' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Use Codex in Cyboflow' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Use OMP in Cyboflow' })).not.toBeChecked();
  });

  it('persists the FULL triple (including the untouched claude/codex members) when OMP is switched on', async () => {
    setProviderAccess(undefined);
    render(<IntegrationsSettings />);

    fireEvent.click(await screen.findByRole('switch', { name: 'Use OMP in Cyboflow' }));

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({
        agentProviderAccess: { claude: true, codex: true, omp: true },
      }),
    );
  });

  it('reflects a saved omp:true setting', async () => {
    setProviderAccess({ claude: true, codex: true, omp: true });
    render(<IntegrationsSettings />);

    expect(await screen.findByRole('switch', { name: 'Use OMP in Cyboflow' })).toBeChecked();
  });

  it('does not count OMP as the "last enabled provider" — turning it off never locks it when claude/codex are also on', async () => {
    setProviderAccess({ claude: true, codex: true, omp: true });
    render(<IntegrationsSettings />);

    const ompSwitch = await screen.findByRole('switch', { name: 'Use OMP in Cyboflow' });
    expect(ompSwitch).toBeEnabled();
    fireEvent.click(ompSwitch);

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({
        agentProviderAccess: { claude: true, codex: true, omp: false },
      }),
    );
  });

  it('locks OMP itself as the last enabled provider so the app can never end up with none', async () => {
    setProviderAccess({ claude: false, codex: false, omp: true });
    render(<IntegrationsSettings />);

    const ompSwitch = await screen.findByRole('switch', { name: 'Use OMP in Cyboflow' });
    expect(ompSwitch).toBeDisabled();
    fireEvent.click(ompSwitch);
    expect(updateConfig).not.toHaveBeenCalled();
  });
});

/**
 * Aria mode changes what the OMP row is even ABOUT: it supervises a remote
 * fleet and never launches the local binary, so reporting the binary there
 * answers the wrong question — and would report "Detected" for an install that
 * cannot launch anything.
 */
describe('IntegrationsSettings — OMP row under Aria mode', () => {
  it('reports the FLEET, not the local binary, when Aria mode is on', async () => {
    // A perfectly good local binary is present and must NOT be what the row claims.
    detectOmp.mockResolvedValue({ success: true, data: OMP_DETECTED });
    mockUseOmpAvailability.mockReturnValue({ launchable: true, ariaMode: true });

    render(<IntegrationsSettings />);

    expect(await screen.findByText('Fleet detected')).toBeInTheDocument();
    // OMP_DETECTED carries version 17.3.3 and a binaryPath; neither may surface.
    expect(screen.queryByText(/omp 17\.3\.3/i)).not.toBeInTheDocument();
    expect(screen.queryByText('/usr/local/bin/omp')).not.toBeInTheDocument();
    expect(screen.getByText(/the local omp binary is not used/i)).toBeInTheDocument();
  });

  it('says the fleet is missing, and how to fix it, when no bridge is configured', async () => {
    detectOmp.mockResolvedValue({ success: true, data: OMP_DETECTED });
    mockUseOmpAvailability.mockReturnValue({ launchable: false, ariaMode: true });

    render(<IntegrationsSettings />);

    expect(await screen.findByText('Fleet not detected')).toBeInTheDocument();
    // Naming the env vars is the point — this is the state that otherwise reads
    // as "OMP is broken" while the toggle still says it is on.
    expect(screen.getByText(/OMP_BRIDGE_TOKEN_FILE/)).toBeInTheDocument();
    expect(screen.getByText(/OMP_BRIDGE_SESSION_ID/)).toBeInTheDocument();
  });

  it('still reports the local binary when Aria mode is off', async () => {
    detectOmp.mockResolvedValue({ success: true, data: OMP_DETECTED });
    mockUseOmpAvailability.mockReturnValue({ launchable: false, ariaMode: false });

    render(<IntegrationsSettings />);

    expect(await screen.findByText('Detected')).toBeInTheDocument();
    expect(screen.queryByText(/Fleet (not )?detected/i)).not.toBeInTheDocument();
  });
});
