/**
 * Worktree destructive actions wired to the monitorReap manifest contract:
 * per-card Prune, the ⋯ menu's Prune, and Reap-all-stale each resolve a manifest,
 * open ManifestConfirmDialog on it, and execute by manifest id. trpc is faked at
 * the client boundary so the calls (and their arguments) are observable.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
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
  return (
    <div>
      {reap.error !== null && <WorktreeReapError error={reap.error} onDismiss={reap.clearError} />}
      {reap.dialog}
      <button type="button" data-testid="reap-all" onClick={() => reap.reapAllStale()}>
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

  it('checked: re-resolves with alsoDeleteBranch true, shows the new manifest, and executes it only after a second confirm', async () => {
    const first = manifest('reap_first', ['/wt/a']);
    const second = manifest('reap_second', ['/wt/a'], { alsoDeleteBranch: true });
    resolveMutate.mockResolvedValueOnce({ manifest: first }).mockResolvedValueOnce({ manifest: second });
    executeMutate.mockResolvedValue(okExecute(second));
    render(<Harness worktrees={[wt('/wt/a')]} />);
    fireEvent.click(screen.getByTestId('wt-prune'));
    await screen.findByTestId('manifest-confirm-dialog');
    fireEvent.click(screen.getByTestId('manifest-delete-branch'));
    fireEvent.click(screen.getByRole('button', { name: 'Prune' }));

    expect(await screen.findByTestId('prune-refreshed-notice')).toBeInTheDocument();
    expect(resolveMutate).toHaveBeenNthCalledWith(2, {
      projectId: 7,
      selection: { kind: 'card', worktreePath: '/wt/a' },
      alsoDeleteBranch: true,
    });
    expect(executeMutate).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('manifest-delete-branch')).toBeChecked());

    fireEvent.click(screen.getByRole('button', { name: 'Prune' }));
    await waitFor(() => expect(executeMutate).toHaveBeenCalledTimes(1));
    expect(executeMutate).toHaveBeenCalledWith({ manifestId: 'reap_second' });
    expect(resolveMutate).toHaveBeenCalledTimes(2);
  });

  it('checked and the targets are unchanged but a shown value moved: the new value is displayed and nothing executes until re-confirmed', async () => {
    const first = manifest('reap_a', ['/wt/a']);
    const second = manifest('reap_b', ['/wt/a'], { alsoDeleteBranch: true });
    second.targets = second.targets.map((t) => (t.kind === 'worktree' ? { ...t, dirty: true, dirtyFileCount: 4 } : t));
    second.dirtyFileCount = 4;
    resolveMutate.mockResolvedValueOnce({ manifest: first }).mockResolvedValueOnce({ manifest: second });
    executeMutate.mockResolvedValue(okExecute(second));
    render(<Harness worktrees={[wt('/wt/a')]} />);
    fireEvent.click(screen.getByTestId('wt-prune'));
    await screen.findByTestId('manifest-confirm-dialog');
    expect(screen.queryByTestId('manifest-dirty-warning')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('manifest-delete-branch'));
    fireEvent.click(screen.getByRole('button', { name: 'Prune' }));

    expect(await screen.findByTestId('manifest-dirty-warning')).toBeInTheDocument();
    expect(executeMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Prune' }));
    await waitFor(() => expect(executeMutate).toHaveBeenCalledWith({ manifestId: 'reap_b' }));
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

    expect(await screen.findByTestId('manifest-target-worktree:/wt/extra')).toBeInTheDocument();
    expect(screen.getByTestId('prune-refreshed-notice')).toBeInTheDocument();
    expect(executeMutate).not.toHaveBeenCalled();
  });
});

describe('Reap all stale', () => {
  it('resolves ONE server reap-all-stale manifest and executes it in one call', async () => {
    const m = manifest('reap_all', ['/wt/s1', '/wt/s2'], { kind: 'reap-all-stale' });
    resolveMutate.mockResolvedValue({ manifest: m });
    executeMutate.mockResolvedValue(okExecute(m));
    render(<Harness worktrees={[wt('/wt/a'), wt('/wt/s1', { tag: 'orphan' }), wt('/wt/s2', { tag: 'orphan' })]} />);

    fireEvent.click(screen.getByTestId('reap-all'));
    await screen.findByTestId('manifest-confirm-dialog');
    expect(resolveMutate).toHaveBeenCalledTimes(1);
    expect(resolveMutate).toHaveBeenCalledWith({ projectId: 7, selection: { kind: 'reap-all-stale' } });
    expect(screen.getByText('Reap 2 stale targets?')).toBeInTheDocument();
    const list = screen.getByTestId('manifest-targets');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);

    fireEvent.click(within(screen.getByTestId('manifest-confirm-dialog')).getByRole('button', { name: 'Reap all stale' }));
    await waitFor(() => expect(executeMutate).toHaveBeenCalledTimes(1));
    expect(executeMutate).toHaveBeenCalledWith({ manifestId: 'reap_all' });
  });

  it('shows a nothing-to-reap error when the server manifest is empty', async () => {
    resolveMutate.mockResolvedValue({ manifest: manifest('reap_none', []) });
    render(<Harness worktrees={[wt('/wt/a')]} />);
    fireEvent.click(screen.getByTestId('reap-all'));
    expect(await screen.findByTestId('system-reap-error-message')).toHaveTextContent('Nothing to remove');
    expect(screen.queryByTestId('manifest-confirm-dialog')).toBeNull();
    expect(executeMutate).not.toHaveBeenCalled();
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

describe('double-submit guard', () => {
  function deferred<T>() {
    let resolveFn!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolveFn = r;
    });
    return { promise, resolve: resolveFn };
  }

  it('two Confirm clicks in the same tick execute the single-use manifest once, with no stale error', async () => {
    const m = manifest('reap_dbl', ['/wt/a']);
    const gate = deferred<ReturnType<typeof okExecute>>();
    resolveMutate.mockResolvedValue({ manifest: m });
    executeMutate.mockReturnValue(gate.promise);
    render(<Harness worktrees={[wt('/wt/a')]} />);
    fireEvent.click(screen.getByTestId('wt-prune'));
    await screen.findByTestId('manifest-confirm-dialog');

    const confirmBtn = screen.getByRole('button', { name: 'Prune' });
    // One act(): no re-render between the clicks, so only the synchronous guard can stop the second.
    act(() => {
      confirmBtn.click();
      confirmBtn.click();
    });
    expect(executeMutate).toHaveBeenCalledTimes(1);
    // While in flight the dialog reflects it and refuses further input.
    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled();
    expect(screen.getByTestId('manifest-delete-branch')).toBeDisabled();

    await act(async () => {
      gate.resolve(okExecute(m));
    });
    await waitFor(() => expect(screen.queryByTestId('manifest-confirm-dialog')).not.toBeInTheDocument());
    expect(executeMutate).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('system-reap-error')).not.toBeInTheDocument();
  });

  it('two Confirm clicks during the deleteBranch re-resolve resolve once and execute nothing', async () => {
    const first = manifest('reap_r1', ['/wt/a']);
    const second = manifest('reap_r2', ['/wt/a'], { alsoDeleteBranch: true });
    const gate = deferred<{ manifest: ReapManifestData }>();
    resolveMutate.mockResolvedValueOnce({ manifest: first }).mockReturnValueOnce(gate.promise);
    render(<Harness worktrees={[wt('/wt/a')]} />);
    fireEvent.click(screen.getByTestId('wt-prune'));
    await screen.findByTestId('manifest-confirm-dialog');
    fireEvent.click(screen.getByTestId('manifest-delete-branch'));

    const confirmBtn = screen.getByRole('button', { name: 'Prune' });
    act(() => {
      confirmBtn.click();
      confirmBtn.click();
    });
    expect(resolveMutate).toHaveBeenCalledTimes(2); // initial + ONE re-resolve
    await act(async () => {
      gate.resolve({ manifest: second });
    });
    expect(await screen.findByTestId('prune-refreshed-notice')).toBeInTheDocument();
    expect(executeMutate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('system-reap-error')).not.toBeInTheDocument();
  });

  it('two toolbar clicks in the same tick resolve once', async () => {
    const m = manifest('reap_tb', ['/wt/a'], { kind: 'reap-all-stale' });
    const gate = deferred<{ manifest: ReapManifestData }>();
    resolveMutate.mockReturnValue(gate.promise);
    render(<Harness worktrees={[wt('/wt/a')]} />);
    const btn = screen.getByTestId('reap-all');
    act(() => {
      btn.click();
      btn.click();
    });
    expect(resolveMutate).toHaveBeenCalledTimes(1);
    await act(async () => {
      gate.resolve({ manifest: m });
    });
    await screen.findByTestId('manifest-confirm-dialog');
  });
});
