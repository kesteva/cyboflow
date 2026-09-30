/**
 * SystemOrphansSection — the read-only orphan inventory: both subgroups render
 * from a fixture snapshot, suspected rows sit in their own tier, and no control
 * of any kind (kill / reclaim / delete) exists in the section's DOM subtree.
 */
import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import type { SystemSnapshotData } from '../../../hooks/useSystemSnapshot';
import { SystemOrphansSection } from '../SystemOrphansSection';
import type { SystemProcess, SystemWorktree } from '../SystemGroupedBody';

const MB = 1024 * 1024;

function wt(path: string, over: Partial<SystemWorktree> = {}): SystemWorktree {
  return {
    path,
    branch: `b-${path}`,
    tag: 'session-owned',
    prunable: true,
    usage: { status: 'measured', bytes: 10 * MB, measuredAt: 1 },
    ...over,
  } as SystemWorktree;
}

function proc(pid: number, over: Record<string, unknown> = {}): SystemProcess {
  return {
    bucket: 'orphan',
    sweepEligible: true,
    instanceId: 'dead',
    processType: 'codex-broker',
    command: `codex app-server ${pid}`,
    worktreePath: null,
    pid,
    ppid: 1,
    pcpu: 2,
    pmem: 1,
    etimeSeconds: 3600,
    owner: null,
    ...over,
  } as SystemProcess;
}

function snap(worktrees: SystemWorktree[], processes: SystemProcess[]): SystemSnapshotData {
  return {
    status: 'ready',
    generatedAt: 1,
    capabilities: { diskSizing: { supported: true } },
    processes,
    worktrees,
    ports: {
      devRenderer: { port: 4521, label: 'dev renderer', inUse: false },
      cdp: { port: 9223, label: 'CDP', inUse: false },
      orchSocket: { connectionCount: 0, runBindings: {} },
    },
  };
}

const fixture = snap(
  [
    wt('/wt/live'),
    wt('/wt/stale-a', { tag: 'orphan', usage: { status: 'measured', bytes: 300 * MB, measuredAt: 1 } }),
    wt('/wt/stale-b', { tag: 'orphan', usage: { status: 'queued' } }),
  ],
  [
    proc(11),
    proc(12, { processType: 'claude-cli', command: 'claude --resume x' }),
    proc(13, { bucket: 'suspected', sweepEligible: undefined, instanceId: undefined, command: 'claude --mystery' }),
    proc(14, { bucket: 'owned', worktreePath: '/wt/live', command: 'claude live' }),
  ],
);

/** The "no destructive control" check the acceptance criterion names. */
function controlsIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('button, [role="button"], input, select, a[href]'));
}

describe('SystemOrphansSection', () => {
  it('renders both subgroups with worktree and process rows tagged by kind', () => {
    render(<SystemOrphansSection snapshot={fixture} />);
    const wtGroup = screen.getByTestId('orphan-group-worktrees');
    const procGroup = screen.getByTestId('orphan-group-processes');
    expect(within(wtGroup).getByText('Stale worktrees')).toBeInTheDocument();
    expect(within(procGroup).getByText('Orphaned processes')).toBeInTheDocument();

    const wtRows = within(wtGroup).getAllByTestId('orphan-wt-row');
    expect(wtRows.map((r) => r.getAttribute('data-worktree'))).toEqual(['/wt/stale-a', '/wt/stale-b']);
    expect(within(wtRows[0]).getByTestId('kind-badge-worktree')).toBeInTheDocument();

    const confirmed = within(procGroup)
      .getAllByTestId('orphan-proc-row')
      .filter((r) => r.getAttribute('data-bucket') === 'orphan');
    expect(confirmed).toHaveLength(2);
    expect(within(confirmed[0]).getByTestId('kind-badge-process')).toBeInTheDocument();

    expect(screen.getByTestId('orphans-count')).toHaveTextContent('2 wt · 2 proc');
    // A live-owned process is not an orphan.
    expect(screen.queryByText('live')).not.toBeInTheDocument();
  });

  it('labels a partial disk total and never renders an unmeasured worktree as 0 MB', () => {
    render(<SystemOrphansSection snapshot={fixture} />);
    expect(screen.getByTestId('orphan-worktrees-summary')).toHaveTextContent('2 stale · 300 MB on disk (1 of 2 measured)');
    const queuedRow = screen.getAllByTestId('orphan-wt-row')[1];
    expect(within(queuedRow).getByTestId('wt-disk')).toHaveAttribute('data-state', 'queued');
    expect(queuedRow).not.toHaveTextContent(/0 MB/);
  });

  it('puts suspected processes in their own tier, apart from confirmed orphans', () => {
    render(<SystemOrphansSection snapshot={fixture} />);
    const tier = screen.getByTestId('suspected-tier');
    const rows = within(tier).getAllByTestId('orphan-proc-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute('data-bucket', 'suspected');
    expect(screen.getByTestId('orphan-processes-summary')).toHaveTextContent('2 orphaned');
  });

  it('renders no control of any kind inside the section', () => {
    const { container } = render(<SystemOrphansSection snapshot={fixture} />);
    expect(controlsIn(container)).toEqual([]);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(container.textContent ?? '').not.toMatch(/kill tree|prune|reap all|delete/i);
  });

  it('control check can fail: it detects a button injected into the subtree', () => {
    const { container } = render(<SystemOrphansSection snapshot={fixture} />);
    const stray = document.createElement('button');
    stray.textContent = 'Kill tree';
    container.querySelector('[data-testid="orphan-group-processes"]')?.appendChild(stray);
    expect(controlsIn(container)).toHaveLength(1);
  });

  it('renders empty states when there is nothing to reclaim', () => {
    render(<SystemOrphansSection snapshot={snap([wt('/wt/live')], [])} />);
    expect(screen.getByTestId('orphan-worktrees-empty')).toBeInTheDocument();
    expect(screen.getByTestId('orphan-processes-empty')).toBeInTheDocument();
    expect(screen.getByTestId('orphans-count')).toHaveTextContent('0 wt · 0 proc');
  });
});
