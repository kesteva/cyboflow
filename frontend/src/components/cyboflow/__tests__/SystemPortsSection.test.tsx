/**
 * SystemPortsSection tests — rows from a fixture snapshot, the empty state,
 * tolerance for a missing/partial `ports` payload, and the gear's inline
 * watched-ports editor (the section's only control).
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { SystemSnapshotData } from '../../../hooks/useSystemSnapshot';
import { SystemPortsSection } from '../SystemPortsSection';

const { getSpy, updateSpy, fetchConfigSpy } = vi.hoisted(() => ({
  getSpy: vi.fn(),
  updateSpy: vi.fn(),
  fetchConfigSpy: vi.fn(),
}));
vi.mock('../../../utils/api', () => ({ API: { config: { get: getSpy, update: updateSpy } } }));
vi.mock('../../../stores/configStore', () => ({
  useConfigStore: { getState: () => ({ fetchConfig: fetchConfigSpy }) },
}));

beforeEach(() => {
  getSpy.mockReset().mockResolvedValue({ success: true, data: {} });
  updateSpy.mockReset().mockResolvedValue({ success: true });
  fetchConfigSpy.mockReset();
});

type Ports = SystemSnapshotData['ports'];

const ports = (over: Partial<Ports> = {}): Ports => ({
  tcp: [
    { port: 3000, label: 'watched', inUse: true },
    { port: 8080, label: 'watched', inUse: false },
  ],
  orchSocket: { connectionCount: 3, runBindings: { 'run-a': 2, 'run-b': 1 } },
  ...over,
});

describe('SystemPortsSection', () => {
  it('renders a row per port/socket from the snapshot', () => {
    render(<SystemPortsSection ports={ports()} />);
    expect(screen.getByTestId('system-port-port-3000')).toHaveAttribute('data-bound', 'true');
    expect(screen.getByTestId('system-port-port-8080')).toHaveAttribute('data-bound', 'false');
    const sock = screen.getByTestId('system-port-orch-sock');
    expect(sock).toHaveTextContent('orch.sock');
    expect(sock).toHaveTextContent('3 clients · 2 runs bound');
    expect(sock).toHaveTextContent('run-a ×2');
    expect(screen.queryByTestId('system-ports-empty')).toBeNull();
  });

  it('never asserts an owner or conflict for a bound port (no authoritative mapping)', () => {
    render(<SystemPortsSection ports={ports()} />);
    expect(screen.getByTestId('system-port-port-3000-owner')).toHaveTextContent('owner not identified');
    expect(screen.queryByTestId('system-port-port-3000-conflict')).toBeNull();
    expect(screen.queryByTestId('system-port-port-8080-owner')).toBeNull();
  });

  it('does not report orch.sock as free when it has zero clients', () => {
    render(<SystemPortsSection ports={ports({ orchSocket: { connectionCount: 0, runBindings: {} } })} />);
    const sock = screen.getByTestId('system-port-orch-sock');
    expect(sock).toHaveAttribute('data-bound', 'unknown');
    expect(sock).toHaveTextContent('0 clients · 0 runs bound');
    expect(sock).toHaveTextContent('listening state not reported');
    expect(sock).not.toHaveTextContent('free');
  });

  it('renders every watched port in order, with its label', () => {
    render(
      <SystemPortsSection
        ports={ports({
          tcp: [
            { port: 5000, label: 'watched', inUse: false },
            { port: 4521, label: 'cyboflow dev renderer', inUse: true },
          ],
        })}
      />,
    );
    const rows = screen.getAllByTestId(/^system-port-port-\d+$/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['system-port-port-5000', 'system-port-port-4521']);
    expect(rows[1]).toHaveTextContent('cyboflow dev renderer');
  });

  it('renders the empty state when the snapshot reports no ports or sockets', () => {
    render(<SystemPortsSection ports={{}} />);
    expect(screen.getByTestId('system-ports-empty')).toBeInTheDocument();
  });

  it('does not crash when ports/processes are undefined or null', () => {
    const { rerender } = render(<SystemPortsSection />);
    expect(screen.getByTestId('system-ports-empty')).toBeInTheDocument();
    rerender(<SystemPortsSection ports={null} />);
    expect(screen.getByTestId('system-ports-empty')).toBeInTheDocument();
    rerender(<SystemPortsSection ports={{ tcp: [{ port: 5000, label: 'watched', inUse: true }] }} />);
    expect(screen.getByTestId('system-port-port-5000')).toBeInTheDocument();
  });

  it('has no control besides the watched-ports gear', () => {
    render(<SystemPortsSection ports={ports()} />);
    const buttons = screen.getByTestId('system-ports').querySelectorAll('button');
    expect(Array.from(buttons).map((b) => b.getAttribute('data-testid'))).toEqual(['system-ports-configure']);
  });

  it('the gear opens an editor prefilled with the defaults when nothing is stored', async () => {
    render(<SystemPortsSection ports={ports()} />);
    expect(screen.queryByTestId('system-ports-editor')).toBeNull();
    fireEvent.click(screen.getByTestId('system-ports-configure'));
    await waitFor(() => expect(screen.getByTestId('system-ports-editor-input')).toHaveValue('3000, 5000, 8080'));
  });

  it('prefills the stored list, saves the parsed ports, and re-probes', async () => {
    getSpy.mockResolvedValue({ success: true, data: { systemWatchedPorts: [4000] } });
    const onSaved = vi.fn();
    render(<SystemPortsSection ports={ports()} onWatchedPortsSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('system-ports-configure'));
    const input = await screen.findByDisplayValue('4000');
    fireEvent.change(input, { target: { value: '4000 6006, 4000' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(updateSpy).toHaveBeenCalledWith({ systemWatchedPorts: [4000, 6006] });
    expect(fetchConfigSpy).toHaveBeenCalled();
    expect(screen.queryByTestId('system-ports-editor')).toBeNull();
  });

  it('names invalid tokens and saves nothing', async () => {
    render(<SystemPortsSection ports={ports()} />);
    fireEvent.click(screen.getByTestId('system-ports-configure'));
    const input = await screen.findByDisplayValue('3000, 5000, 8080');
    fireEvent.change(input, { target: { value: '3000, abc, 70000' } });
    fireEvent.click(screen.getByTestId('system-ports-editor-save'));

    expect(screen.getByTestId('system-ports-editor-error')).toHaveTextContent('abc, 70000');
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('surfaces a rejected save and keeps the editor open', async () => {
    updateSpy.mockResolvedValue({ success: false, error: 'Invalid systemWatchedPorts' });
    render(<SystemPortsSection ports={ports()} />);
    fireEvent.click(screen.getByTestId('system-ports-configure'));
    await screen.findByDisplayValue('3000, 5000, 8080');
    fireEvent.click(screen.getByTestId('system-ports-editor-save'));

    expect(await screen.findByTestId('system-ports-editor-error')).toHaveTextContent('Invalid systemWatchedPorts');
    expect(screen.getByTestId('system-ports-editor')).toBeInTheDocument();
  });

  it('Escape and Cancel close the editor without saving', async () => {
    render(<SystemPortsSection ports={ports()} />);
    fireEvent.click(screen.getByTestId('system-ports-configure'));
    const input = await screen.findByDisplayValue('3000, 5000, 8080');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('system-ports-editor')).toBeNull();

    fireEvent.click(screen.getByTestId('system-ports-configure'));
    await screen.findByDisplayValue('3000, 5000, 8080');
    fireEvent.click(screen.getByTestId('system-ports-editor-cancel'));
    expect(screen.queryByTestId('system-ports-editor')).toBeNull();
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
