import '@testing-library/jest-dom';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSetDefault } = vi.hoisted(() => ({ mockSetDefault: vi.fn() }));
vi.mock('../../../trpc/client', () => ({
  trpc: { cyboflow: { hosts: { setProjectDefault: { mutate: mockSetDefault } } } },
}));

import { EnvironmentPicker, useEnvironmentSelection } from '../EnvironmentPicker';
import { useHostsStore } from '../../../stores/hostsStore';
import { makeHost, makeHostsStatus, makeLocalHost, makePreflight } from '../../agentsEnv/__tests__/fixtures';

const full = (over = {}) =>
  makeHost({
    id: 'h2', label: 'm2-studio', effectiveTier: 'full', detectedTier: 'full', remoteReady: true,
    preflight: makePreflight({ runtimes: { claudeSdk: true, codexSdk: true, claudeCli: true, codexCli: true } }),
    ...over,
  });

function seed(hosts = [makeLocalHost(), full()], status = makeHostsStatus()) {
  act(() => useHostsStore.setState({ hosts, featureStatus: status }));
}

function Harness(props: { defaultHostId?: string | null; runtime?: string }) {
  const sel = useEnvironmentSelection({
    projectId: 7, projectDefaultHostId: props.defaultHostId, runtime: props.runtime ?? 'claude-sdk', kind: 'workflow',
  });
  return (
    <>
      <EnvironmentPicker selection={sel} projectId={7} kind="workflow" runtime={props.runtime ?? 'claude-sdk'} />
      <span data-testid="remote">{sel.remoteHostId ?? 'none'}</span>
      <span data-testid="request">{sel.requestHostId === undefined ? 'omit' : String(sel.requestHostId)}</span>
    </>
  );
}

beforeEach(() => mockSetDefault.mockReset());
afterEach(() => act(() => useHostsStore.setState({ hosts: [], featureStatus: null })));

describe('EnvironmentPicker', () => {
  it('is hidden when environments are off or only This Mac exists', () => {
    seed([makeLocalHost(), full()], makeHostsStatus({ running: false }));
    const { container, rerender } = render(<Harness />);
    expect(container.querySelector('[data-testid="environment-picker"]')).toBeNull();
    seed([makeLocalHost()]);
    rerender(<Harness />);
    expect(container.querySelector('[data-testid="environment-picker"]')).toBeNull();
    seed([makeLocalHost(), full({ archivedAt: '2026-10-01T00:00:00Z' })]);
    rerender(<Harness />);
    expect(container.querySelector('[data-testid="environment-picker"]')).toBeNull();
  });

  it('lists This Mac first and disables unlaunchable hosts with their reason', () => {
    seed([makeLocalHost(), full(), makeHost({ id: 'h3', label: 'old-box', effectiveTier: 'cli' })]);
    render(<Harness />);
    const radios = screen.getAllByRole('radio');
    expect(radios[0]).toHaveTextContent('This Mac');
    expect(screen.getByTestId('environment-picker-option-h2')).toBeEnabled();
    expect(screen.getByTestId('environment-picker-option-h3')).toBeDisabled();
    expect(screen.getByTestId('environment-picker-reason-h3')).toHaveTextContent('Terminal only');
    expect(screen.getByTestId('environment-picker-option-h2')).toHaveTextContent('Claude CLI');
  });

  it('defaults to This Mac, and to the project default when launchable', () => {
    seed();
    const { rerender } = render(<Harness />);
    expect(screen.getByTestId('remote')).toHaveTextContent('none');
    rerender(<Harness defaultHostId="h2" />);
    expect(screen.getByTestId('remote')).toHaveTextContent('h2');
    expect(screen.getByTestId('environment-picker-option-h2')).toHaveAttribute('aria-checked', 'true');
  });

  it('falls back to This Mac when the default is archived, missing or not launchable', () => {
    seed([makeLocalHost(), full({ archivedAt: '2026-10-01T00:00:00Z' }), full({ id: 'h4', label: 'other' })]);
    const { rerender } = render(<Harness defaultHostId="h2" />);
    expect(screen.getByTestId('remote')).toHaveTextContent('none');
    rerender(<Harness defaultHostId="gone" />);
    expect(screen.getByTestId('remote')).toHaveTextContent('none');
    seed([makeLocalHost(), full({ lifecycleState: 'unreachable' }), full({ id: 'h4', label: 'other' })]);
    rerender(<Harness defaultHostId="h2" />);
    expect(screen.getByTestId('remote')).toHaveTextContent('none');
  });

  it('picking a remote host yields its id; picking This Mac clears it', () => {
    seed();
    render(<Harness />);
    fireEvent.click(screen.getByTestId('environment-picker-option-h2'));
    expect(screen.getByTestId('remote')).toHaveTextContent('h2');
    fireEvent.click(screen.getByTestId('environment-picker-option-local'));
    expect(screen.getByTestId('remote')).toHaveTextContent('none');
  });

  it('an explicit This Mac pick over a remote project default yields requestHostId null, not omitted (LC-1)', () => {
    seed();
    render(<Harness defaultHostId="h2" />);
    expect(screen.getByTestId('request')).toHaveTextContent('h2');
    fireEvent.click(screen.getByTestId('environment-picker-option-local'));
    expect(screen.getByTestId('remote')).toHaveTextContent('none');
    expect(screen.getByTestId('request')).toHaveTextContent('null');
  });

  it('a hidden picker omits the request hostId (requestHostId undefined)', () => {
    seed([makeLocalHost(), full()], makeHostsStatus({ running: false }));
    render(<Harness defaultHostId="h2" />);
    expect(screen.getByTestId('request')).toHaveTextContent('omit');
  });

  it('does not let a non-SDK runtime disable rows, but a signed-out SDK runtime does', () => {
    seed([makeLocalHost(), full({ preflight: makePreflight({ runtimes: { claudeSdk: false, codexSdk: true, claudeCli: true, codexCli: true } }) })]);
    const { rerender } = render(<Harness runtime="claude-interactive" />);
    expect(screen.getByTestId('environment-picker-option-h2')).toBeEnabled();
    rerender(<Harness runtime="claude-sdk" />);
    expect(screen.getByTestId('environment-picker-option-h2')).toBeDisabled();
    expect(screen.getByTestId('environment-picker-reason-h2')).toHaveTextContent('Claude is not signed in there');
  });

  it('shows the killed-switch reason on remote rows', () => {
    seed(undefined, makeHostsStatus({ killed: true }));
    render(<Harness />);
    expect(screen.getByTestId('environment-picker-reason-h2')).toHaveTextContent('Remote environments are turned off');
  });

  it('"Make default for this project" calls hosts.setProjectDefault', async () => {
    mockSetDefault.mockResolvedValue({ ok: true });
    seed();
    render(<Harness />);
    fireEvent.click(screen.getByTestId('environment-picker-option-h2'));
    fireEvent.click(screen.getByTestId('environment-picker-make-default'));
    await waitFor(() => expect(mockSetDefault).toHaveBeenCalledWith({ projectId: 7, hostId: 'h2' }));
    await waitFor(() => expect(screen.getByTestId('environment-picker-make-default')).toBeChecked());
  });

  it('surfaces a refused default save', async () => {
    mockSetDefault.mockResolvedValue({ ok: false, error: 'unknown', message: 'nope' });
    seed();
    render(<Harness />);
    fireEvent.click(screen.getByTestId('environment-picker-option-h2'));
    fireEvent.click(screen.getByTestId('environment-picker-make-default'));
    expect(await screen.findByTestId('environment-picker-error')).toHaveTextContent('nope');
  });
});

describe('useEnvironmentSelection', () => {
  it('is invisible with no hosts and resolves to This Mac', () => {
    const { result } = renderHook(() => useEnvironmentSelection({ projectId: 1, projectDefaultHostId: 'h2', kind: 'session' }));
    expect(result.current.visible).toBe(false);
    expect(result.current.remoteHostId).toBeNull();
    expect(result.current.requestHostId).toBeUndefined();
  });
});
