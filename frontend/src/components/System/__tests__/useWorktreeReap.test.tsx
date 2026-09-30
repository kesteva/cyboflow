/**
 * Worktree destructive actions wired to the monitorReap manifest contract:
 * per-card Prune, the ⋯ menu's Prune, and Reap-all-stale each resolve a manifest,
 * open ManifestConfirmDialog on it, and execute by manifest id. trpc is faked at
 * the client boundary so the calls (and their arguments) are observable.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SystemSnapshotData } from '../../../hooks/useSystemSnapshot';
import type { ReapManifestData } from '../reapManifestAdapter';

const { resolveMutate, executeMutate } = vi.hoisted(() => ({ resolveMutate: vi.fn(), executeMutate: vi.fn() }));

vi.mock('../../../trpc/client', () => ({
  trpc: { cyboflow: { monitorReap: { resolve: { mutate: resolveMutate }, execute: { mutate: executeMutate } } } },
}));
vi.mock('../../../stores/cyboflowStore', () => ({ useCyboflowStore: { getState: () => ({}) } }));
vi.mock('../../../stores/navigationStore', () => ({ useNavigationStore: { getState: () => ({}) } }));

import { SystemGroupedBody, PRUNE_BLOCKED_REASON } from '../SystemGroupedBody';
import type { SystemWorktree } from '../SystemGroupedBody';
import { useWorktreeReap, WorktreeReapError } from '../useWorktreeReap';

const MB = 1024 * 1024;

function wt(path: string, over: Partial<SystemWorktree> = {}): SystemWorktree {
  return {
    path,
    branch: `b-${path}`,
    tag: 'session-owned',
    prunable: true,
    sessionId: `s-${path}`,
    usage: { status: 'measured', bytes: 10 * MB, measuredAt: 1 },
    ...over,
  } as SystemWorktree;
}

function snap(worktrees: SystemWorktree[]): SystemSnapshotData {
  return {
    status: 'ready',
    generatedAt: 1,
    capabilities: { diskSizing: { supported: true } },
    processes: [],
    worktrees,
    ports: {
      devRenderer: { port: 4521, label: 'dev renderer', inUse: false },
      cdp: { port: 9223, label: 'CDP', inUse: false },
      orchSocket: { connectionCount: 0, runBindings: {} },
    },
  };
}

function manifest(id: string, paths: string[], over: Partial<ReapManifestData> = {}): ReapManifestData {
  return {
    id,
    kind: 'card',
    snapshotGeneratedAt: 1,
    builtAt: 2,
    targets: paths.map((path) => ({
      kind: 'worktree' as const,
      path,
      branch: `b-${path}`,
      tag: 'session-owned' as const,
      sessionId: 's',
      runId: null,
      reclaimableBytes: 5 * MB,
      dirty: false,
      dirtyFileCount: 0,
      aheadOfMain: 0,
    })),
    reclaimableBytes: 5 * MB * paths.length,
    unmeasuredTargetCount: 0,
    dirtyFileCount: 0,
    dirtyCountUnknownTargetCount: 0,
    aheadOfMainCount: 0,
    descendantPidCount: 0,
    alsoDeleteBranch: false,
    ...over,
  };
}

function okExecute(m: ReapManifestData) {
  return {
    manifestId: m.id,
    alsoDeleteBranch: m.alsoDeleteBranch,
    results: m.targets.map((t) => ({ targetId: t.kind === 'worktree' ? `worktree:${t.path}` : `process:${t.pid}`, kind: 'pruned' as const })),
    errors: [],
  };
}

const onSettled = vi.fn();

function Harness({ worktrees }: { worktrees: SystemWorktree[] }) {
  const reap = useWorktreeReap({ projectId: 7, onSettled });
  const stale = worktrees.filter((w) => w.tag === 'orphan' && w.prunable);
  return (
    <div>
      {reap.error !== null && <WorktreeReapError error={reap.error} onDismiss={reap.clearError} />}
      {reap.dialog}
      <button type="button" data-testid="reap-all" onClick={() => reap.reapAllStale(stale)}>
        Reap all stale
      </button>
      <SystemGroupedBody snapshot={snap(worktrees)} projectId={7} groupBy="worktree" sortBy="disk" onPruneWorktree={reap.prune} />
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('per-card Prune', () => {
  it('opens the dialog from a live manifest fetch and executes exactly the manifest it rendered', async () => {
    const m = manifest('reap_1', ['/wt/a'], {
      targets: [
        {
          kind: 'worktree', path: '/wt/a', branch: 'b', tag: 'session-owned', sessionId: 's', runId: null,
          reclaimableBytes: 5 * MB, dirty: true, dirtyFileCount: 3, aheadOfMain: 2,
        },
      ],
      reclaimableBytes: 5 * MB,
    });
    resolveMutate.mockResolvedValue({ manifest: m });
    executeMutate.mockResolvedValue(okExecute(m));
    render(<Harness worktrees={[wt('/wt/a')]} />);

    fireEvent.click(screen.getByTestId('wt-prune'));
    await screen.findByTestId('manifest-confirm-dialog');
    expect(resolveMutate).toHaveBeenCalledWith({ projectId: 7, selection: { kind: 'card', worktreePath: '/wt/a' } });
    // Populated from the live manifest, not placeholders.
    expect(screen.getByTestId('manifest-target-worktree:/wt/a')).toHaveTextContent('3 dirty files');
    expect(screen.getByTestId('manifest-dirty-warning')).toBeInTheDocument();
    expect(screen.getByTestId('manifest-confirm-subtitle')).toHaveTextContent('5 MB disk');

    fireEvent.click(screen.getByRole('button', { name: 'Prune' }));
    await waitFor(() => expect(executeMutate).toHaveBeenCalledTimes(1));
    // Branch kept: the SAME manifest id the dialog showed, no second resolve.
    expect(executeMutate).toHaveBeenCalledWith({ manifestId: 'reap_1' });
    expect(resolveMutate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('manifest-confirm-dialog')).not.toBeInTheDocument());
    expect(onSettled).toHaveBeenCalled();
    expect(screen.queryByTestId('system-reap-error')).not.toBeInTheDocument();
  });

  it('opens the same dialog from the ⋯ menu Prune entry', async () => {
    const m = manifest('reap_menu', ['/wt/a']);
    resolveMutate.mockResolvedValue({ manifest: m });
    executeMutate.mockResolvedValue(okExecute(m));
    render(<Harness worktrees={[wt('/wt/a')]} />);

    fireEvent.click(screen.getByTestId('wt-menu'));
    fireEvent.click(await screen.findByTestId('wt-menu-prune'));
    await screen.findByTestId('manifest-confirm-dialog');
    expect(resolveMutate).toHaveBeenCalledWith({ projectId: 7, selection: { kind: 'card', worktreePath: '/wt/a' } });

    fireEvent.click(screen.getByRole('button', { name: 'Prune' }));
    await waitFor(() => expect(executeMutate).toHaveBeenCalledWith({ manifestId: 'reap_menu' }));
  });

  it('cancel executes nothing', async () => {
    resolveMutate.mockResolvedValue({ manifest: manifest('reap_c', ['/wt/a']) });
    render(<Harness worktrees={[wt('/wt/a')]} />);
    fireEvent.click(screen.getByTestId('wt-prune'));
    await screen.findByTestId('manifest-confirm-dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('manifest-confirm-dialog')).not.toBeInTheDocument();
    expect(executeMutate).not.toHaveBeenCalled();
  });
});

describe('deleteBranch', () => {
  it('unchecked: executes the rendered manifest and never re-resolves', async () => {
    const m = manifest('reap_off', ['/wt/a']);
    resolveMutate.mockResolvedValue({ manifest: m });
    executeMutate.mockResolvedValue(okExecute(m));
    render(<Harness worktrees={[wt('/wt/a')]} />);
    fireEvent.click(screen.getByTestId('wt-prune'));
    await screen.findByTestId('manifest-confirm-dialog');
    expect(screen.getByTestId('manifest-delete-branch')).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Prune' }));
    await waitFor(() => expect(executeMutate).toHaveBeenCalledWith({ manifestId: 'reap_off' }));
    expect(resolveMutate).toHaveBeenCalledTimes(1);
  });

  it('checked: re-resolves with alsoDeleteBranch true and executes that manifest', async () => {
    const first = manifest('reap_first', ['/wt/a']);
    const second = manifest('reap_second', ['/wt/a'], { alsoDeleteBranch: true });
    resolveMutate.mockResolvedValueOnce({ manifest: first }).mockResolvedValueOnce({ manifest: second });
    executeMutate.mockResolvedValue(okExecute(second));
    render(<Harness worktrees={[wt('/wt/a')]} />);
    fireEvent.click(screen.getByTestId('wt-prune'));
    await screen.findByTestId('manifest-confirm-dialog');
    fireEvent.click(screen.getByTestId('manifest-delete-branch'));
    fireEvent.click(screen.getByRole('button', { name: 'Prune' }));

    await waitFor(() => expect(executeMutate).toHaveBeenCalledTimes(1));
    expect(resolveMutate).toHaveBeenNthCalledWith(2, {
      projectId: 7,
      selection: { kind: 'card', worktreePath: '/wt/a' },
      alsoDeleteBranch: true,
    });
    expect(executeMutate).toHaveBeenCalledWith({ manifestId: 'reap_second' });
  });

  it('checked but the targets changed on re-resolve: nothing executes and the updated list is shown', async () => {
    resolveMutate
      .mockResolvedValueOnce({ manifest: manifest('reap_a', ['/wt/a']) })
      .mockResolvedValueOnce({ manifest: manifest('reap_b', ['/wt/a', '/wt/extra'], { alsoDeleteBranch: true }) });
    render(<Harness worktrees={[wt('/wt/a')]} />);
    fireEvent.click(screen.getByTestId('wt-prune'));
    await screen.findByTestId('manifest-confirm-dialog');
    fireEvent.click(screen.getByTestId('manifest-delete-branch'));
    fireEvent.click(screen.getByRole('button', { name: 'Prune' }));

    expect(await screen.findByTestId('system-reap-error-message')).toHaveTextContent('targets changed');
    expect(executeMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('manifest-target-worktree:/wt/extra')).toBeInTheDocument();
  });
});

describe('Reap all stale (worktree half)', () => {
  it('opens ONE dialog over every stale worktree target and executes them in one call', async () => {
    const m = manifest('reap_all', ['/wt/s1', '/wt/s2'], { kind: 'row' });
    resolveMutate.mockResolvedValue({ manifest: m });
    executeMutate.mockResolvedValue(okExecute(m));
    render(
      <Harness worktrees={[wt('/wt/a'), wt('/wt/s1', { tag: 'orphan' }), wt('/wt/s2', { tag: 'orphan' })]} />,
    );

    fireEvent.click(screen.getByTestId('reap-all'));
    await screen.findByTestId('manifest-confirm-dialog');
    expect(resolveMutate).toHaveBeenCalledWith({
      projectId: 7,
      selection: { kind: 'row', worktreePaths: ['/wt/s1', '/wt/s2'] },
    });
    expect(screen.getByText('Reap 2 stale worktrees?')).toBeInTheDocument();
    const list = screen.getByTestId('manifest-targets');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Prune' }));
    await waitFor(() => expect(executeMutate).toHaveBeenCalledTimes(1));
    expect(executeMutate).toHaveBeenCalledWith({ manifestId: 'reap_all' });
  });

  it('never resolves anything when no worktree is stale', () => {
    render(<Harness worktrees={[wt('/wt/a')]} />);
    fireEvent.click(screen.getByTestId('reap-all'));
    expect(resolveMutate).not.toHaveBeenCalled();
  });
});

describe('in_place / is_main_repo guard', () => {
  it('disables Prune in the footer and the menu with a visible reason', async () => {
    render(<Harness worktrees={[wt('/repo', { tag: 'is_main_repo', prunable: false })]} />);
    expect(screen.getByTestId('wt-prune')).toBeDisabled();
    expect(screen.getByTestId('wt-prune-reason')).toHaveTextContent(PRUNE_BLOCKED_REASON);

    fireEvent.click(screen.getByTestId('wt-menu'));
    const item = (await screen.findByTestId('wt-menu-prune')).closest('button');
    expect(item).toBeDisabled();
    expect(screen.getAllByText(PRUNE_BLOCKED_REASON).length).toBeGreaterThan(1);

    fireEvent.click(screen.getByTestId('wt-prune'));
    fireEvent.click(item as HTMLElement);
    expect(resolveMutate).not.toHaveBeenCalled();
  });
});

describe('error surfacing', () => {
  it('renders a visible per-target error for a partial / failed prune', async () => {
    const m = manifest('reap_p', ['/wt/a', '/wt/b']);
    resolveMutate.mockResolvedValue({ manifest: m });
    executeMutate.mockResolvedValue({
      manifestId: 'reap_p',
      alsoDeleteBranch: false,
      results: [
        { targetId: 'worktree:/wt/a', kind: 'pruned' },
        { targetId: 'worktree:/wt/b', kind: 'failed', error: 'EBUSY: directory in use' },
      ],
      errors: [{ targetId: 'worktree:/wt/b', message: 'EBUSY: directory in use' }],
    });
    render(<Harness worktrees={[wt('/wt/a'), wt('/wt/b')]} />);
    fireEvent.click(screen.getAllByTestId('wt-prune')[0]);
    await screen.findByTestId('manifest-confirm-dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Prune' }));

    const alert = await screen.findByTestId('system-reap-error');
    expect(alert).toHaveTextContent('1 target could not be removed');
    expect(screen.getByTestId('system-reap-error-detail')).toHaveTextContent('b: EBUSY: directory in use');
    expect(screen.queryByTestId('manifest-confirm-dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('system-reap-error-dismiss'));
    expect(screen.queryByTestId('system-reap-error')).not.toBeInTheDocument();
  });

  it('surfaces a stale-manifest rejection as a visible error', async () => {
    resolveMutate.mockResolvedValue({ manifest: manifest('reap_s', ['/wt/a']) });
    executeMutate.mockRejectedValue(new Error('MANIFEST_STALE: expired'));
    render(<Harness worktrees={[wt('/wt/a')]} />);
    fireEvent.click(screen.getByTestId('wt-prune'));
    await screen.findByTestId('manifest-confirm-dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Prune' }));
    expect(await screen.findByTestId('system-reap-error-message')).toHaveTextContent('nothing was removed');
  });

  it('surfaces a failed resolve (e.g. not prunable server-side) as a visible error', async () => {
    resolveMutate.mockRejectedValue(new Error('is the main repo and can never be pruned'));
    render(<Harness worktrees={[wt('/wt/a')]} />);
    fireEvent.click(screen.getByTestId('wt-prune'));
    expect(await screen.findByTestId('system-reap-error-message')).toHaveTextContent('can never be pruned');
    expect(screen.queryByTestId('manifest-confirm-dialog')).not.toBeInTheDocument();
  });

  it('flags a target the executor reported nothing about', async () => {
    const m = manifest('reap_m', ['/wt/a']);
    resolveMutate.mockResolvedValue({ manifest: m });
    executeMutate.mockResolvedValue({ manifestId: 'reap_m', alsoDeleteBranch: false, results: [], errors: [] });
    render(<Harness worktrees={[wt('/wt/a')]} />);
    fireEvent.click(screen.getByTestId('wt-prune'));
    await screen.findByTestId('manifest-confirm-dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Prune' }));
    expect(await screen.findByTestId('system-reap-error-detail')).toHaveTextContent('no result was reported');
  });
});
