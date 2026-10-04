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
  devRenderer: { port: 4521, label: 'dev renderer', inUse: true },
  cdp: { port: 9223, label: 'CDP', inUse: false },
  orchSocket: { connectionCount: 3, runBindings: { 'run-a': 2, 'run-b': 1 } },
  ...over,
});

describe('SystemPortsSection', () => {
  it('renders a row per port/socket from the snapshot', () => {
    render(<SystemPortsSection ports={ports()} />);
    expect(screen.getByTestId('system-port-port-4521')).toHaveAttribute('data-bound', 'true');
    expect(screen.getByTestId('system-port-port-9223')).toHaveAttribute('data-bound', 'false');
    const sock = screen.getByTestId('system-port-orch-sock');
    expect(sock).toHaveTextContent('orch.sock');
    expect(sock).toHaveTextContent('3 clients · 2 runs bound');
    expect(sock).toHaveTextContent('run-a ×2');
    expect(screen.queryByTestId('system-ports-empty')).toBeNull();
  });

  it('never asserts an owner or conflict for a bound port (no authoritative mapping)', () => {
    render(<SystemPortsSection ports={ports()} />);
    expect(screen.getByTestId('system-port-port-4521-owner')).toHaveTextContent('owner not identified');
    expect(screen.queryByTestId('system-port-port-4521-conflict')).toBeNull();
    expect(screen.queryByTestId('system-port-port-9223-owner')).toBeNull();
  });

  it('does not report orch.sock as free when it has zero clients', () => {
    render(<SystemPortsSection ports={ports({ orchSocket: { connectionCount: 0, runBindings: {} } })} />);
    const sock = screen.getByTestId('system-port-orch-sock');
    expect(sock).toHaveAttribute('data-bound', 'unknown');
    expect(sock).toHaveTextContent('0 clients · 0 runs bound');
    expect(sock).toHaveTextContent('listening state not reported');
    expect(sock).not.toHaveTextContent('free');
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
    rerender(<SystemPortsSection ports={{ cdp: { port: 9223, label: 'CDP', inUse: true } }} />);
    expect(screen.getByTestId('system-port-port-9223')).toBeInTheDocument();
  });

  it('is read-only: no buttons in the section', () => {
    render(<SystemPortsSection ports={ports()} />);
    expect(screen.getByTestId('system-ports').querySelector('button')).toBeNull();
  });
});
