/**
 * SystemPortsSection tests — rows from a fixture snapshot, the empty state, and
 * tolerance for a missing/partial `ports` payload. The section is read-only: no
 * button exists anywhere in its DOM.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import type { SystemSnapshotData } from '../../../hooks/useSystemSnapshot';
import { SystemPortsSection } from '../SystemPortsSection';

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

  it('is read-only: no buttons in the section', () => {
    render(<SystemPortsSection ports={ports()} />);
    expect(screen.getByTestId('system-ports').querySelector('button')).toBeNull();
  });
});
