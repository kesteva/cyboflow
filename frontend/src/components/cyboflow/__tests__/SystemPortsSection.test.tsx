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
type Proc = SystemSnapshotData['processes'][number];

const ports = (over: Partial<Ports> = {}): Ports => ({
  devRenderer: { port: 4521, label: 'dev renderer', inUse: true },
  cdp: { port: 9223, label: 'CDP', inUse: false },
  orchSocket: { connectionCount: 3, runBindings: { 'run-a': 2, 'run-b': 1 } },
  ...over,
});

const ownedProc = (command: string, worktreePath: string | null): Proc =>
  ({
    bucket: 'owned',
    processType: 'unknown',
    command,
    worktreePath,
    pid: 4242,
    ppid: 1,
    pcpu: 0,
    pmem: 0,
    etimeSeconds: 10,
    owner: null,
  }) as Proc;

const foreignProc = (command: string): Proc =>
  ({
    bucket: 'foreign',
    readOnly: true,
    processType: 'unknown',
    command,
    worktreePath: null,
    pidLabel: 'pid 777',
    display: { cpu: null, mem: null, elapsed: null },
    foreignInstanceId: 'other',
  }) as Proc;

describe('SystemPortsSection', () => {
  it('renders a row per port/socket from the snapshot', () => {
    render(<SystemPortsSection ports={ports()} processes={[]} />);
    expect(screen.getByTestId('system-port-port-4521')).toHaveAttribute('data-bound', 'true');
    expect(screen.getByTestId('system-port-port-9223')).toHaveAttribute('data-bound', 'false');
    const sock = screen.getByTestId('system-port-orch-sock');
    expect(sock).toHaveTextContent('orch.sock');
    expect(sock).toHaveTextContent('3 clients · 2 runs bound');
    expect(sock).toHaveTextContent('run-a ×2');
    expect(screen.queryByTestId('system-ports-empty')).toBeNull();
  });

  it('shows the owning process and worktree with KindTags when the command names the port', () => {
    render(
      <SystemPortsSection
        ports={ports()}
        processes={[ownedProc('node vite --port 4521', '/repo/wt-a')]}
      />,
    );
    const owner = screen.getByTestId('system-port-port-4521-owner');
    expect(owner).toHaveTextContent('pid 4242');
    expect(owner).toHaveTextContent('/repo/wt-a');
    expect(owner.querySelector('[data-kind="process"]')).not.toBeNull();
    expect(owner.querySelector('[data-kind="worktree"]')).not.toBeNull();
  });

  it('flags a conflict when a foreign process holds the port', () => {
    render(<SystemPortsSection ports={ports()} processes={[foreignProc('Electron --remote-debugging-port=4521')]} />);
    expect(screen.getByTestId('system-port-port-4521')).toHaveAttribute('data-conflict', 'true');
    expect(screen.getByTestId('system-port-port-4521-conflict')).toBeInTheDocument();
  });

  it('does not match a port number embedded in a longer number', () => {
    render(<SystemPortsSection ports={ports()} processes={[ownedProc('node --port 45210', null)]} />);
    expect(screen.getByTestId('system-port-port-4521-owner')).toHaveTextContent('no owner identified');
  });

  it('renders the empty state when the snapshot reports no ports or sockets', () => {
    render(<SystemPortsSection ports={{}} processes={[]} />);
    expect(screen.getByTestId('system-ports-empty')).toBeInTheDocument();
  });

  it('does not crash when ports/processes are undefined or null', () => {
    const { rerender } = render(<SystemPortsSection />);
    expect(screen.getByTestId('system-ports-empty')).toBeInTheDocument();
    rerender(<SystemPortsSection ports={null} processes={null} />);
    expect(screen.getByTestId('system-ports-empty')).toBeInTheDocument();
    rerender(<SystemPortsSection ports={{ cdp: { port: 9223, label: 'CDP', inUse: true } }} />);
    expect(screen.getByTestId('system-port-port-9223')).toBeInTheDocument();
  });

  it('is read-only: no buttons in the section', () => {
    render(<SystemPortsSection ports={ports()} processes={[ownedProc('x --port 4521', null)]} />);
    expect(screen.getByTestId('system-ports').querySelector('button')).toBeNull();
  });
});
