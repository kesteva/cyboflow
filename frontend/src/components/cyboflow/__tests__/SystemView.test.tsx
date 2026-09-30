/**
 * SystemView shell tests.
 *
 * The Disk-used tile renders exactly one of measured / measuring / queued, and
 * never a "0 MB" text node for an unmeasured value. The snapshot hook, the
 * projects API and the navigation store are mocked so the view's rendering
 * contract is exercised in isolation.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SystemSnapshotData } from '../../../hooks/useSystemSnapshot';

const { useSystemSnapshotSpy, getAllSpy } = vi.hoisted(() => ({
  useSystemSnapshotSpy: vi.fn(),
  getAllSpy: vi.fn(),
}));

vi.mock('../../../hooks/useSystemSnapshot', () => ({ useSystemSnapshot: useSystemSnapshotSpy }));
vi.mock('../../../utils/api', () => ({ API: { projects: { getAll: getAllSpy } } }));
vi.mock('../../../stores/navigationStore', () => ({
  useNavigationStore: (sel: (s: { activeProjectId: number | null }) => unknown) => sel({ activeProjectId: 1 }),
}));

import { SystemView, formatDiskBytes, summarizeDisk } from '../SystemView';

type Worktree = SystemSnapshotData['worktrees'][number];
type Usage = Worktree['usage'];

function wt(path: string, usage: Usage, tag: 'session-owned' | 'orphan' = 'session-owned'): Worktree {
  return { path, branch: 'b', tag, prunable: true, usage } as Worktree;
}

function snap(worktrees: Worktree[], overrides: Partial<SystemSnapshotData> = {}): SystemSnapshotData {
  return {
    status: 'ready',
    generatedAt: 1_700_000_000_000,
    capabilities: { diskSizing: { supported: true } },
    processes: [],
    worktrees,
    ports: {
      devRenderer: { port: 4521, label: 'dev renderer', inUse: false },
      cdp: { port: 9223, label: 'CDP', inUse: false },
      orchSocket: { connectionCount: 0, runBindings: {} },
    },
    ...overrides,
  };
}

const MB = 1024 * 1024;
const measured = (bytes: number): Usage => ({ status: 'measured', bytes, measuredAt: 1 });

function mockSnapshot(snapshot: SystemSnapshotData | null, extra: { isLoading?: boolean; error?: Error | null } = {}) {
  useSystemSnapshotSpy.mockReturnValue({ snapshot, isLoading: extra.isLoading ?? false, error: extra.error ?? null });
}

beforeEach(() => {
  useSystemSnapshotSpy.mockReset();
  getAllSpy.mockReset();
  getAllSpy.mockResolvedValue({ success: true, data: [{ id: 1, name: 'proj' }] });
});

describe('SystemView', () => {
  it('renders the header eyebrow and the four stat tiles', () => {
    mockSnapshot(snap([wt('/a', measured(5 * MB)), wt('/b', measured(MB), 'orphan')]));
    render(<SystemView />);
    expect(screen.getByText('System · live process & worktree monitor')).toBeInTheDocument();
    expect(screen.getByTestId('system-tile-worktrees')).toHaveTextContent('2');
    expect(screen.getByTestId('system-tile-processes')).toBeInTheDocument();
    expect(screen.getByTestId('system-tile-disk')).toBeInTheDocument();
    expect(screen.getByTestId('system-tile-orphans')).toHaveTextContent('1 wt · 0 proc');
  });

  it('measured: shows the summed value', () => {
    mockSnapshot(snap([wt('/a', measured(5 * MB)), wt('/b', measured(MB))]));
    render(<SystemView />);
    expect(screen.getByTestId('system-disk-measured')).toHaveTextContent('6.0 MB');
  });

  it('measuring: shows a spinner, no value, and never "0 MB"', () => {
    mockSnapshot(snap([wt('/a', measured(5 * MB)), wt('/b', { status: 'measuring' }), wt('/c', { status: 'queued' })]));
    const { container } = render(<SystemView />);
    const tile = screen.getByTestId('system-tile-disk');
    expect(screen.getByTestId('system-disk-measuring')).toHaveAttribute('data-state', 'measuring');
    expect(tile).toHaveTextContent('Disk · 1 of 3');
    expect(screen.queryByTestId('system-disk-measured')).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/0 MB/);
  });

  it('queued: shows a skeleton with role=status, no value, and never "0 MB"', () => {
    mockSnapshot(snap([wt('/a', { status: 'queued' }), wt('/b', { status: 'queued' })]));
    const { container } = render(<SystemView />);
    const skeleton = screen.getByTestId('system-disk-queued');
    expect(skeleton).toHaveAttribute('role', 'status');
    expect(skeleton).toHaveAttribute('aria-label');
    expect(screen.getByTestId('system-tile-disk')).toHaveTextContent('Disk · 0 of 2');
    expect(screen.queryByTestId('system-disk-measured')).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/0 MB/);
  });

  it('counts orphan worktrees and orphan processes in the Orphans tile', () => {
    const orphanProc = { bucket: 'orphan', pid: 1 } as SystemSnapshotData['processes'][number];
    mockSnapshot(snap([wt('/a', measured(MB), 'orphan')], { processes: [orphanProc] }));
    render(<SystemView />);
    expect(screen.getByTestId('system-tile-orphans')).toHaveTextContent('1 wt · 1 proc');
  });

  it('shows a non-fatal error banner', () => {
    mockSnapshot(snap([]), { error: new Error('boom') });
    render(<SystemView />);
    expect(screen.getByTestId('system-error')).toHaveTextContent('boom');
  });
});

describe('summarizeDisk / formatDiskBytes', () => {
  it('folds the tri-state: any measuring → measuring; else any queued → queued; all measured → measured', () => {
    expect(summarizeDisk(snap([wt('/a', { status: 'measuring' }), wt('/b', { status: 'queued' })])).state).toBe('measuring');
    expect(summarizeDisk(snap([wt('/a', measured(1)), wt('/b', { status: 'queued' })])).state).toBe('queued');
    expect(summarizeDisk(snap([wt('/a', measured(1))])).state).toBe('measured');
  });

  it('never sums an unmeasured worktree into a total', () => {
    const d = summarizeDisk(snap([wt('/a', measured(MB)), wt('/b', { status: 'queued' })]));
    expect(d).not.toHaveProperty('total');
  });

  it('flags win32-style unsupported sizing explicitly', () => {
    const d = summarizeDisk(snap([], { capabilities: { diskSizing: { supported: false, reason: 'no du' } } }));
    expect(d).toEqual({ state: 'unsupported', reason: 'no du' });
  });

  it('formats sizes', () => {
    expect(formatDiskBytes(512)).toBe('512 B');
    expect(formatDiskBytes(312 * MB)).toBe('312 MB');
    expect(formatDiskBytes(2.2 * 1024 * MB)).toBe('2.2 GB');
  });
});
