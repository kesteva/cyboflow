import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { makeHost, makeHostsStatus, makeLocalHost } from './fixtures';
import type { ShellTerminalApi } from '../../cyboflow/RunShellTerminalView';

let terminalOpen: ReturnType<typeof vi.fn>;
let terminalClose: ReturnType<typeof vi.fn>;
let archiveMutate: ReturnType<typeof vi.fn>;
let runPreflightMutate: ReturnType<typeof vi.fn>;
let setUserCapMutate: ReturnType<typeof vi.fn>;
let listQuery: ReturnType<typeof vi.fn>;
let terminalExitSubscribe: ReturnType<typeof vi.fn>;
let capturedApi: ShellTerminalApi | undefined;

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      hosts: {
        list: { get query() { return listQuery; } },
        archive: { get mutate() { return archiveMutate; } },
        runPreflight: { get mutate() { return runPreflightMutate; } },
        setUserCap: { get mutate() { return setUserCapMutate; } },
        terminalOpen: { get mutate() { return terminalOpen; } },
        terminalClose: { get mutate() { return terminalClose; } },
        onTerminalExit: { get subscribe() { return terminalExitSubscribe; } },
        onPreflightProgress: { subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }) },
      },
    },
  },
}));
vi.mock('../../cyboflow/RunShellTerminalView', () => ({
  RunShellTerminalView: ({ terminalId, api }: {
    terminalId: string;
    api?: ShellTerminalApi;
  }) => {
    capturedApi = api;
    return <div data-testid="fake-terminal">{terminalId}</div>;
  },
}));

import { EnvironmentsTab } from '../EnvironmentsTab';
import { useHostsStore } from '../../../stores/hostsStore';

function seed(hosts = [makeHost(), makeLocalHost()], status = makeHostsStatus()): void {
  useHostsStore.setState({ featureStatus: status, hosts, hostsStatus: 'ready', preflightLive: {} });
}

beforeEach(() => {
  terminalOpen = vi.fn().mockResolvedValue({ ok: true, terminalId: 't1' });
  terminalClose = vi.fn().mockResolvedValue({ ok: true });
  archiveMutate = vi.fn().mockResolvedValue({ ok: true });
  runPreflightMutate = vi.fn().mockResolvedValue({ ok: true, result: {} });
  setUserCapMutate = vi.fn().mockResolvedValue({ ok: true });
  listQuery = vi.fn().mockResolvedValue([]);
  terminalExitSubscribe = vi.fn().mockReturnValue({ unsubscribe: vi.fn() });
  capturedApi = undefined;
  useHostsStore.setState({ featureStatus: null, hosts: [], hostsStatus: 'idle', hostsError: null, preflightLive: {} });
});

describe('EnvironmentsTab gating', () => {
  it('shows a loading state before the status is known', () => {
    render(<EnvironmentsTab />);
    expect(screen.getByTestId('environments-loading')).toBeInTheDocument();
  });

  it('off: tells the user where to turn it on', () => {
    seed([], makeHostsStatus({ running: false, enabled: false }));
    render(<EnvironmentsTab />);
    expect(screen.getByTestId('environments-off')).toHaveTextContent('Turn on Environments in Settings → Feature controls');
  });

  it('kill switch: shows the notice and disables the terminal button', () => {
    seed([makeHost(), makeLocalHost()], makeHostsStatus({ killed: true }));
    render(<EnvironmentsTab />);
    expect(screen.getByTestId('environments-killed')).toHaveTextContent('CYBOFLOW_DISABLE_REMOTE_HOSTS');
    expect(screen.getByTestId('environment-terminal-h2')).toBeDisabled();
    expect(screen.getByTestId('environment-card-local')).toBeInTheDocument();
  });

  it('lists This Mac first', () => {
    seed();
    render(<EnvironmentsTab />);
    const cards = screen.getAllByTestId(/^environment-card-/);
    expect(cards.map((c) => c.getAttribute('data-testid'))).toEqual(['environment-card-local', 'environment-card-h2']);
  });

  it('error with no rows offers Retry', async () => {
    useHostsStore.setState({ featureStatus: makeHostsStatus(), hostsStatus: 'error', hostsError: 'boom' });
    render(<EnvironmentsTab />);
    expect(screen.getByTestId('environments-error')).toHaveTextContent('boom');
    fireEvent.click(screen.getByTestId('environments-retry'));
    await waitFor(() => expect(listQuery).toHaveBeenCalled());
  });
});

describe('EnvironmentCard', () => {
  it('This Mac: fixed tier, no SSH-only controls', () => {
    seed();
    render(<EnvironmentsTab />);
    expect(screen.getByTestId('environment-tier-local')).toHaveTextContent('Fixed: Sessions + workflows');
    expect(screen.queryByTestId('environment-terminal-local')).toBeNull();
    expect(screen.queryByTestId('environment-remove-local')).toBeNull();
    expect(screen.queryByTestId('tier-control-local')).toBeNull();
  });

  it('SSH: detected tier, summary, runtimes and lifecycle', () => {
    seed();
    render(<EnvironmentsTab />);
    expect(screen.getByTestId('environment-tier-h2')).toHaveTextContent('Detected: CLI sessions');
    expect(screen.getByTestId('preflight-summary-h2')).toHaveTextContent('2 passed · 1 warning · 1 arrive later');
    expect(screen.getByTestId('environment-runtimes-h2')).toHaveTextContent('Claude CLI · no Codex');
    expect(screen.getByTestId('environment-dot-h2').querySelector('[data-dot]')).toHaveAttribute('data-dot', 'green');
  });

  it('never-probed host reads "Not checked yet" with a hollow dot', () => {
    seed([makeHost({ detectedTier: null, effectiveTier: null, lifecycleState: null, preflight: null, preflightAt: null })]);
    render(<EnvironmentsTab />);
    expect(screen.getByTestId('environment-tier-h2')).toHaveTextContent('Not checked yet');
    expect(screen.getByTestId('environment-dot-h2').querySelector('[data-dot]')).toHaveAttribute('data-dot', 'hollow');
  });

  it('unreachable: amber dot and last-successful-check notice', () => {
    seed([makeHost({ lifecycleState: 'unreachable' })]);
    render(<EnvironmentsTab />);
    expect(screen.getByTestId('environment-dot-h2').querySelector('[data-dot]')).toHaveAttribute('data-dot', 'amber');
    expect(screen.getByTestId('environment-stale-h2')).toHaveTextContent('Showing the last successful check from');
    expect(screen.getByTestId('environment-lifecycle-h2')).toHaveTextContent('Last seen');
  });

  it('Check again runs the preflight and shows a spinner state while running', async () => {
    seed();
    render(<EnvironmentsTab />);
    fireEvent.click(screen.getByTestId('environment-check-h2'));
    expect(runPreflightMutate).toHaveBeenCalledWith({ id: 'h2' });
    await waitFor(() => expect(screen.getByTestId('environment-check-h2')).not.toBeDisabled());
  });

  it('a preflight already running disables Check again', () => {
    seed([makeHost({ preflightRunning: true })]);
    render(<EnvironmentsTab />);
    expect(screen.getByTestId('environment-check-h2')).toBeDisabled();
  });

  it('Remove is disabled with a reason while work is running, otherwise confirms then archives', async () => {
    seed([makeHost({ runningRuns: 1 })]);
    const { unmount } = render(<EnvironmentsTab />);
    expect(screen.getByTestId('environment-remove-h2')).toBeDisabled();
    expect(screen.getByTestId('environment-remove-h2')).toHaveAttribute('title', expect.stringContaining('work running'));
    unmount();
    seed();
    render(<EnvironmentsTab />);
    fireEvent.click(screen.getByTestId('environment-remove-h2'));
    expect(archiveMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('environment-remove-confirm-h2'));
    await waitFor(() => expect(archiveMutate).toHaveBeenCalledWith({ id: 'h2' }));
  });

  it('shows a server failure message', async () => {
    runPreflightMutate.mockResolvedValue({ ok: false, error: 'remote_hosts_disabled', message: 'Turned off.' });
    seed();
    render(<EnvironmentsTab />);
    fireEvent.click(screen.getByTestId('environment-check-h2'));
    expect(await screen.findByTestId('environment-failure-h2')).toHaveTextContent('Turned off.');
  });

  it('Edit opens the dialog prefilled', async () => {
    seed();
    render(<EnvironmentsTab />);
    fireEvent.click(screen.getByTestId('environment-edit-h2'));
    expect(await screen.findByTestId('add-environment-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('add-environment-name')).toHaveValue('Build box');
    expect(screen.getByTestId('add-environment-target')).toHaveValue('build@10.0.0.5');
  });

  it('Open terminal opens a terminal and closing the modal closes it', async () => {
    seed();
    render(<EnvironmentsTab />);
    fireEvent.click(screen.getByTestId('environment-terminal-h2'));
    expect(await screen.findByTestId('fake-terminal')).toHaveTextContent('t1');
    expect(terminalOpen).toHaveBeenCalledWith({ hostId: 'h2' });
    fireEvent.click(screen.getByLabelText('Close modal'));
    await waitFor(() => expect(terminalClose).toHaveBeenCalledWith({ terminalId: 't1' }));
    expect(screen.queryByTestId('host-terminal-modal')).toBeNull();
  });

  it('the host terminal api subscribes to the exit push for its terminal and relays the exit code', async () => {
    const unsubscribe = vi.fn();
    terminalExitSubscribe.mockReturnValue({ unsubscribe });
    seed();
    render(<EnvironmentsTab />);
    fireEvent.click(screen.getByTestId('environment-terminal-h2'));
    await screen.findByTestId('fake-terminal');
    expect(capturedApi?.onExit).toBeDefined();
    const listener = vi.fn();
    const stop = capturedApi?.onExit?.(listener);
    expect(terminalExitSubscribe).toHaveBeenCalledWith({ terminalId: 't1' }, expect.any(Object));
    const handlers = terminalExitSubscribe.mock.calls[0][1] as { onData: (ev: { exitCode: number | null }) => void };
    handlers.onData({ exitCode: 255 });
    expect(listener).toHaveBeenCalledWith(255);
    stop?.();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('terminal open failure is shown', async () => {
    terminalOpen.mockResolvedValue({ ok: false, error: 'terminal_unavailable', message: 'No ssh binary.' });
    seed();
    render(<EnvironmentsTab />);
    fireEvent.click(screen.getByTestId('environment-terminal-h2'));
    expect(await screen.findByTestId('host-terminal-error')).toHaveTextContent('No ssh binary.');
  });
});

describe('TierControl', () => {
  it('is enabled when detection allows full, and sets the cap', async () => {
    seed([makeHost({ detectedTier: 'full', effectiveTier: 'full' })]);
    render(<EnvironmentsTab />);
    const box = screen.getByTestId('tier-control-h2');
    expect(box).not.toBeDisabled();
    fireEvent.click(box);
    await waitFor(() => expect(setUserCapMutate).toHaveBeenCalledWith({ id: 'h2', cap: 'cli' }));
  });

  it('is disabled when detected is cli or null, with a reason', () => {
    seed([makeHost()]);
    const { unmount } = render(<EnvironmentsTab />);
    expect(screen.getByTestId('tier-control-h2')).toBeDisabled();
    expect(screen.getByTestId('tier-control-h2').closest('label')).toHaveAttribute('title', 'Already limited by detection');
    unmount();
    seed([makeHost({ detectedTier: null, effectiveTier: null })]);
    render(<EnvironmentsTab />);
    expect(screen.getByTestId('tier-control-h2')).toBeDisabled();
  });

  it('an existing cap can be cleared', async () => {
    seed([makeHost({ detectedTier: 'full', userCapTier: 'cli', effectiveTier: 'cli' })]);
    render(<EnvironmentsTab />);
    const box = screen.getByTestId('tier-control-h2');
    expect(box).toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(setUserCapMutate).toHaveBeenCalledWith({ id: 'h2', cap: null }));
  });
});
