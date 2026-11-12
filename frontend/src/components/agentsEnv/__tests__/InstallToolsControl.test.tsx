import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { makeCheck, makeHost, makeHostsStatus, makeLocalHost, makePreflight } from './fixtures';
import type { HostView } from '../../../../../shared/types/hosts';

let installMutate: ReturnType<typeof vi.fn>;

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      hosts: {
        list: { query: vi.fn().mockResolvedValue([]) },
        installToolchain: { get mutate() { return installMutate; } },
        onPreflightProgress: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
        onToolchainProgress: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
      },
    },
  },
}));

import { EnvironmentCard } from '../EnvironmentCard';
import { toolchainPhaseText } from '../InstallToolsControl';
import { useHostsStore } from '../../../stores/hostsStore';

const hashCheck = (status: 'pass' | 'warn') =>
  makeCheck({ id: 'sdk-binary-hash', label: 'Agent toolchain', status, detail: 'x' });

function card(host: HostView): void {
  render(<EnvironmentCard host={host} onEdit={vi.fn()} onOpenTerminal={vi.fn()} />);
}

beforeEach(() => {
  installMutate = vi.fn().mockResolvedValue({ ok: true });
  useHostsStore.setState({
    featureStatus: makeHostsStatus(), hosts: [], hostsStatus: 'ready', preflightLive: {}, toolchainLive: {},
  });
});

describe('InstallToolsControl', () => {
  it('shows the button when the toolchain check is not pass', () => {
    card(makeHost({ preflight: makePreflight({ results: [hashCheck('warn')] }) }));
    expect(screen.getByTestId('install-tools-button-h2')).toHaveTextContent('Install cyboflow tools (about 550 MB)');
  });

  it('hides the button when the machine is ready', () => {
    card(makeHost({ remoteReady: true, preflight: makePreflight({ results: [hashCheck('pass')] }) }));
    expect(screen.queryByTestId('install-tools-h2')).toBeNull();
  });

  it('hides the button for an incomplete preflight and for This Mac', () => {
    card(makeHost({ preflight: makePreflight({ probeComplete: false }) }));
    expect(screen.queryByTestId('install-tools-h2')).toBeNull();
  });

  it('never shows for This Mac', () => {
    card(makeLocalHost());
    expect(screen.queryByTestId('install-tools-local')).toBeNull();
  });

  it('disables the button and shows each phase while installing', () => {
    useHostsStore.setState({
      toolchainLive: { h2: { hostId: 'h2', phase: 'uploading', bytesSent: 100 * 1048576, bytesTotal: 550 * 1048576, message: null } },
    });
    card(makeHost({ installRunning: true, preflight: makePreflight({ results: [hashCheck('warn')] }) }));
    expect(screen.getByTestId('install-tools-button-h2')).toBeDisabled();
    expect(screen.getByTestId('install-tools-phase-h2')).toHaveTextContent('Uploading 100 of 550 MB');
    expect(toolchainPhaseText(undefined)).toBe('Hashing…');
    expect(toolchainPhaseText({ hostId: 'h2', phase: 'verifying', bytesSent: 1, bytesTotal: 1, message: null })).toBe('Verifying…');
  });

  it('shows the failure message', async () => {
    installMutate.mockResolvedValue({ ok: false, error: 'toolchain_push_failed', message: 'Upload failed: disk full' });
    card(makeHost({ preflight: makePreflight({ results: [hashCheck('warn')] }) }));
    fireEvent.click(screen.getByTestId('install-tools-button-h2'));
    await waitFor(() => expect(screen.getByTestId('install-tools-failure-h2')).toHaveTextContent('disk full'));
    expect(installMutate).toHaveBeenCalledWith({ id: 'h2' });
  });

  it('shows the link-down note only when down', () => {
    card(makeHost({ linkState: 'down' }));
    expect(screen.getByTestId('environment-link-down-h2')).toHaveTextContent('Orchestrator link down');
  });
});
