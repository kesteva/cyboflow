/**
 * SystemView shell — header + four stat tiles; the Disk-used tile renders
 * exactly one of measured / measuring / queued and never "0 MB" for an
 * unmeasured value.
 */
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SystemSnapshotData } from '../../../hooks/useSystemSnapshot';

const { snapshotRef, getAllMock } = vi.hoisted(() => ({
  snapshotRef: { current: null as unknown },
  getAllMock: vi.fn(),
}));

vi.mock('../../../hooks/useSystemSnapshot', () => ({
  useSystemSnapshot: () => ({ snapshot: snapshotRef.current, isLoading: false, error: null }),
}));
vi.mock('../../../utils/api', () => ({ API: { projects: { getAll: getAllMock } } }));

import { SystemView, summarizeDisk } from '../SystemView';
import { useNavigationStore } from '../../../stores/navigationStore';

type Usage =
  | { status: 'measured'; bytes: number }
  | { status: 'measuring' }
  | { status: 'queued' };

function snap(usages: Usage[]): SystemSnapshotData {
  return {
    status: 'ready',
    generatedAt: 1,
    capabilities: { diskSizing: { supported: true } },
    processes: [],
    worktrees: usages.map((usage, i) => ({ path: `/wt/${i}`, tag: 'session-owned', usage })),
    ports: {
      devRenderer: { port: 4521, label: 'dev renderer', inUse: false },
      cdp: { port: 9223, label: 'CDP', inUse: false },
      orchSocket: { connectionCount: 0, runBindings: {} },
    },
  } as unknown as SystemSnapshotData;
}

beforeEach(() => {
  getAllMock.mockReset();
  getAllMock.mockResolvedValue({ success: true, data: [{ id: 1, name: 'p' }] });
  useNavigationStore.setState({ activeProjectId: 1 });
});

describe('SystemView disk tile', () => {
  it('measured: shows the summed value, no spinner/skeleton', async () => {
    snapshotRef.current = snap([
      { status: 'measured', bytes: 1024 * 1024 * 3 },
      { status: 'measured', bytes: 1024 * 1024 * 2 },
    ]);
    render(<SystemView />);
    expect(screen.getByTestId('system-disk-measured')).toHaveTextContent('5.0 MB');
    expect(screen.queryByTestId('system-disk-measuring')).toBeNull();
    expect(screen.queryByTestId('system-disk-queued')).toBeNull();
  });

  it('measuring: spinner state, no total and no "0 MB"', () => {
    snapshotRef.current = snap([
      { status: 'measured', bytes: 1024 * 1024 },
      { status: 'measuring' },
      { status: 'queued' },
    ]);
    render(<SystemView />);
    const tile = screen.getByTestId('system-tile-disk');
    expect(screen.getByTestId('system-disk-measuring')).toHaveAttribute('data-state', 'measuring');
    expect(tile).toHaveTextContent('Disk · 1 of 3');
    expect(tile.textContent).not.toMatch(/0 MB/);
    expect(screen.queryByTestId('system-disk-measured')).toBeNull();
  });

  it('queued: skeleton state with status role, no "0 MB"', () => {
    snapshotRef.current = snap([{ status: 'queued' }, { status: 'queued' }]);
    render(<SystemView />);
    const sk = screen.getByTestId('system-disk-queued');
    expect(sk).toHaveAttribute('role', 'status');
    expect(sk.className).toContain('animate-pulse');
    expect(screen.getByTestId('system-tile-disk').textContent).not.toMatch(/0 ?(B|KB|MB|GB)/);
  });

  it('never folds unmeasured worktrees into a total (summarizeDisk)', () => {
    const s = summarizeDisk(snap([{ status: 'measured', bytes: 100 }, { status: 'queued' }]));
    expect(s.state).toBe('queued');
    expect('total' in s).toBe(false);
  });
});

describe('SystemView shell', () => {
  it('renders header and the four stat tiles', async () => {
    snapshotRef.current = snap([{ status: 'measured', bytes: 1024 }]);
    render(<SystemView />);
    await waitFor(() => expect(getAllMock).toHaveBeenCalled());
    expect(screen.getByText('System · live process & worktree monitor')).toBeInTheDocument();
    for (const id of ['worktrees', 'processes', 'disk', 'orphans']) {
      expect(screen.getByTestId(`system-tile-${id}`)).toBeInTheDocument();
    }
  });
});
