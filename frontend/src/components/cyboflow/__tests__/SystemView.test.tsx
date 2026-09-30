/**
 * SystemView shell tests.
 *
 * The Disk-used tile renders exactly one of measured / measuring / queued, and
 * never a "0 MB" text node for an unmeasured value. The snapshot hook, the
 * projects API and the navigation store are mocked so the view's rendering
 * contract is exercised in isolation.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SystemSnapshotData } from '../../../hooks/useSystemSnapshot';

const { useSystemSnapshotSpy, getAllSpy, navState, resolveSpy, executeSpy } = vi.hoisted(() => ({
  useSystemSnapshotSpy: vi.fn(),
  getAllSpy: vi.fn(),
  navState: { activeProjectId: 1 as number | null },
  resolveSpy: vi.fn(),
  executeSpy: vi.fn(),
}));

vi.mock('../../../trpc/client', () => ({
  trpc: { cyboflow: { monitorReap: { resolve: { mutate: resolveSpy }, execute: { mutate: executeSpy } } } },
}));
vi.mock('../../../hooks/useOcclusion', () => ({ useOcclusion: () => undefined }));
vi.mock('../../../utils/systemNavigation', () => ({ openSystemRun: vi.fn(), openSystemSession: vi.fn() }));

vi.mock('../../../hooks/useSystemSnapshot', () => ({ useSystemSnapshot: useSystemSnapshotSpy }));
vi.mock('../../../utils/api', () => ({ API: { projects: { getAll: getAllSpy } } }));
vi.mock('../../../stores/navigationStore', () => ({
  useNavigationStore: (sel: (s: { activeProjectId: number | null }) => unknown) => sel({ activeProjectId: navState.activeProjectId }),
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

const refetchSpy = vi.fn();

function mockSnapshot(
  snapshot: SystemSnapshotData | null,
  extra: { isLoading?: boolean; error?: Error | null; lastUpdatedAt?: number | null } = {},
) {
  useSystemSnapshotSpy.mockReturnValue({
    snapshot,
    isLoading: extra.isLoading ?? false,
    error: extra.error ?? null,
    refetch: refetchSpy,
    lastUpdatedAt: extra.lastUpdatedAt === undefined ? Date.now() : extra.lastUpdatedAt,
  });
}

beforeEach(() => {
  useSystemSnapshotSpy.mockReset();
  getAllSpy.mockReset();
  refetchSpy.mockReset();
  resolveSpy.mockReset();
  executeSpy.mockReset();
  navState.activeProjectId = 1;
  getAllSpy.mockResolvedValue({ success: true, data: [{ id: 1, name: 'proj' }] });
});

describe('SystemView', () => {
  it('mounts the Orphans section above the grouped body', () => {
    mockSnapshot(snap([wt('/a', measured(MB)), wt('/stale', measured(MB), 'orphan')]));
    render(<SystemView />);
    const orphans = screen.getByTestId('system-orphans');
    expect(orphans).toBeInTheDocument();
    expect(orphans.compareDocumentPosition(screen.getByTestId('system-by-worktree'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('mounts the Ports & sockets section from the snapshot', () => {
    mockSnapshot(snap([wt('/a', measured(MB))]));
    render(<SystemView />);
    expect(screen.getByTestId('system-ports')).toBeInTheDocument();
    expect(screen.getByTestId('system-port-orch-sock')).toBeInTheDocument();
  });

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
    const orphanProc = {
      bucket: 'orphan',
      processType: 'codex-broker',
      worktreePath: null,
      pid: 1,
      command: 'codex app-server',
      pcpu: 0,
      pmem: 0,
      etimeSeconds: 1,
    } as SystemSnapshotData['processes'][number];
    mockSnapshot(snap([wt('/a', measured(MB), 'orphan')], { processes: [orphanProc] }));
    render(<SystemView />);
    expect(screen.getByTestId('system-tile-orphans')).toHaveTextContent('1 wt · 1 proc');
  });

  describe('header freshness + Refresh', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows "Updated Ns ago" that advances with time', () => {
      mockSnapshot(snap([]));
      render(<SystemView />);
      expect(screen.getByTestId('system-updated')).toHaveTextContent('Updated 0s ago');
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(screen.getByTestId('system-updated')).toHaveTextContent('Updated 3s ago');
    });

    it('omits the updated label before the first successful fetch', () => {
      mockSnapshot(null, { lastUpdatedAt: null });
      render(<SystemView />);
      expect(screen.queryByTestId('system-updated')).not.toBeInTheDocument();
    });

    it('Refresh calls the hook refetch once per click', () => {
      mockSnapshot(snap([]));
      render(<SystemView />);
      const button = screen.getByTestId('system-refresh');
      expect(button).toHaveAttribute('aria-label', 'Refresh system snapshot');
      expect(button).toBeEnabled();
      fireEvent.click(button);
      expect(refetchSpy).toHaveBeenCalledTimes(1);
    });

    it('Refresh is disabled when no project is selected', () => {
      navState.activeProjectId = null;
      getAllSpy.mockResolvedValue({ success: true, data: [] });
      mockSnapshot(null, { lastUpdatedAt: null });
      render(<SystemView />);
      expect(screen.getByTestId('system-refresh')).toBeDisabled();
    });
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

describe('SystemView group-by control', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to By worktree and persists the toggle across remount', () => {
    mockSnapshot(snap([wt('/a', measured(MB))]));
    const first = render(<SystemView />);
    expect(screen.getByTestId('system-groupby-worktree')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('system-by-worktree')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('system-groupby-process-type'));
    expect(screen.getByTestId('system-groupby-process-type')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('system-by-process-type')).toBeInTheDocument();
    first.unmount();

    render(<SystemView />);
    expect(screen.getByTestId('system-groupby-process-type')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('system-by-process-type')).toBeInTheDocument();
  });
});

describe('SystemView process destructive wiring', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  const owned = {
    bucket: 'owned',
    processType: 'claude-cli',
    command: 'claude --resume 11',
    worktreePath: '/a',
    pid: 11,
    ppid: 1,
    pcpu: 1,
    pmem: 1,
    etimeSeconds: 60,
    owner: { kind: 'cli', panelId: 'p', sessionId: 's-11' },
  } as SystemSnapshotData['processes'][number];
  const orphan = {
    ...owned,
    bucket: 'orphan',
    pid: 12,
    command: 'claude --resume 12',
    worktreePath: null,
    owner: null,
    instanceId: 'dead',
  } as unknown as SystemSnapshotData['processes'][number];

  it('offers Kill tree / Kill all on live rows and enables Reap all stale for an orphan process', () => {
    mockSnapshot(snap([wt('/a', measured(MB))], { processes: [owned, orphan] }));
    render(<SystemView />);
    expect(screen.getByTestId('kill-tree-11')).toBeInTheDocument();
    expect(screen.getByTestId('wt-kill-all')).toBeEnabled();
    expect(screen.getByTestId('system-reap-all-stale')).toBeEnabled();
    fireEvent.click(screen.getByTestId('system-groupby-process-type'));
    expect(screen.getByTestId('type-kill-all-claude-cli')).toBeInTheDocument();
  });

  it('keeps Reap all stale disabled when nothing is stale', () => {
    mockSnapshot(snap([wt('/a', measured(MB))], { processes: [owned] }));
    render(<SystemView />);
    expect(screen.getByTestId('system-reap-all-stale')).toBeDisabled();
  });
});

describe('SystemView orphan reaping (actual view)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  const orphanProc = {
    bucket: 'orphan',
    processType: 'claude-cli',
    command: 'claude --resume 12',
    worktreePath: null,
    pid: 12,
    ppid: 1,
    pcpu: 1,
    pmem: 1,
    etimeSeconds: 60,
    owner: null,
    instanceId: 'dead',
  } as unknown as SystemSnapshotData['processes'][number];

  const procTarget = {
    kind: 'process' as const,
    pid: 12,
    processType: 'claude-cli' as const,
    bucket: 'orphan' as const,
    command: 'claude --resume 12',
    worktreePath: null,
    sessionId: null,
    runId: null,
    taggedAsCyboflow: true,
    descendantPidCount: 1,
  };
  const wtTarget = {
    kind: 'worktree' as const,
    path: '/stale',
    branch: 'b',
    tag: 'orphan' as const,
    sessionId: null,
    runId: null,
    reclaimableBytes: MB,
    dirty: false,
    dirtyFileCount: 0,
    aheadOfMain: 0,
  };
  const manifestOf = (id: string, targets: unknown[]) => ({
    id,
    kind: 'row',
    snapshotGeneratedAt: 1,
    builtAt: 1,
    targets,
    reclaimableBytes: MB,
    unmeasuredTargetCount: 0,
    dirtyFileCount: 0,
    dirtyCountUnknownTargetCount: 0,
    aheadOfMainCount: 0,
    descendantPidCount: 1,
    alsoDeleteBranch: false,
  });

  it('an orphan process row in the Orphans section has a Kill tree that opens the kill confirm and executes its manifest', async () => {
    mockSnapshot(snap([wt('/a', measured(MB))], { processes: [orphanProc] }));
    resolveSpy.mockResolvedValue({ manifest: manifestOf('reap_kill', [procTarget]) });
    executeSpy.mockResolvedValue({
      manifestId: 'reap_kill',
      alsoDeleteBranch: false,
      results: [{ targetId: 'process:12', kind: 'killed' }],
      errors: [],
    });
    render(<SystemView />);

    const orphans = screen.getByTestId('system-orphans');
    fireEvent.click(within(orphans).getByTestId('orphan-kill-tree-12'));
    await screen.findByTestId('manifest-confirm-dialog');
    expect(resolveSpy).toHaveBeenCalledWith({ projectId: 1, selection: { kind: 'row', pids: [12] } });

    fireEvent.click(within(screen.getByTestId('manifest-confirm-dialog')).getByRole('button', { name: 'Kill tree' }));
    await waitFor(() => expect(executeSpy).toHaveBeenCalledWith({ manifestId: 'reap_kill' }));
  });

  it('Reap all stale with orphan worktrees AND processes opens exactly one dialog over one reap-all-stale manifest', async () => {
    mockSnapshot(snap([wt('/a', measured(MB)), wt('/stale', measured(MB), 'orphan')], { processes: [orphanProc] }));
    resolveSpy.mockResolvedValue({ manifest: manifestOf('reap_all', [wtTarget, procTarget]) });
    executeSpy.mockResolvedValue({
      manifestId: 'reap_all',
      alsoDeleteBranch: false,
      results: [
        { targetId: 'worktree:/stale', kind: 'pruned' },
        { targetId: 'process:12', kind: 'killed' },
      ],
      errors: [],
    });
    render(<SystemView />);

    fireEvent.click(screen.getByTestId('system-reap-all-stale'));
    await screen.findByTestId('manifest-confirm-dialog');
    // One click → one resolve of the server's own selection, one dialog holding both kinds.
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy).toHaveBeenCalledWith({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    expect(screen.getAllByTestId('manifest-confirm-dialog')).toHaveLength(1);
    expect(within(screen.getByTestId('manifest-targets')).getAllByRole('listitem')).toHaveLength(2);

    fireEvent.click(within(screen.getByTestId('manifest-confirm-dialog')).getByRole('button', { name: 'Reap all stale' }));
    await waitFor(() => expect(executeSpy).toHaveBeenCalledTimes(1));
    expect(executeSpy).toHaveBeenCalledWith({ manifestId: 'reap_all' });
  });
  it('a later worktree reap clears the previous process reap\'s "Reaped N target" strip', async () => {
    mockSnapshot(snap([wt('/a', measured(MB)), wt('/stale', measured(MB), 'orphan')], { processes: [orphanProc] }));
    resolveSpy
      .mockResolvedValueOnce({ manifest: manifestOf('reap_kill', [procTarget]) })
      .mockResolvedValueOnce({ manifest: manifestOf('reap_wt', [wtTarget]) });
    executeSpy
      .mockResolvedValueOnce({
        manifestId: 'reap_kill',
        alsoDeleteBranch: false,
        results: [{ targetId: 'process:12', kind: 'killed' }],
        errors: [],
      })
      .mockResolvedValueOnce({
        manifestId: 'reap_wt',
        alsoDeleteBranch: false,
        results: [{ targetId: 'worktree:/stale', kind: 'failed', message: 'locked' }],
        errors: [{ targetId: 'worktree:/stale', message: 'locked' }],
      });
    render(<SystemView />);

    fireEvent.click(within(screen.getByTestId('system-orphans')).getByTestId('orphan-kill-tree-12'));
    await screen.findByTestId('manifest-confirm-dialog');
    fireEvent.click(within(screen.getByTestId('manifest-confirm-dialog')).getByRole('button', { name: 'Kill tree' }));
    expect(await screen.findByTestId('reap-summary')).toHaveTextContent('Reaped 1 target');

    fireEvent.click(screen.getByTestId('system-reap-all-stale'));
    await screen.findByTestId('manifest-confirm-dialog');
    // The prior success strip must not linger next to the new attempt's outcome.
    await waitFor(() => expect(screen.queryByTestId('reap-summary')).not.toBeInTheDocument());
  });
});
