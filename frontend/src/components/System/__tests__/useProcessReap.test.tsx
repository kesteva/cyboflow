/**
 * useProcessReap — process destructive actions wired to the monitorReap manifest
 * contract (resolve → confirm → execute). The tRPC client is mocked; the real
 * SystemGroupedBody and confirm dialogs render, so each test drives the same buttons
 * a user clicks and asserts what the server was asked to resolve/execute.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SystemSnapshotData } from '../../../hooks/useSystemSnapshot';

const { resolveSpy, executeSpy } = vi.hoisted(() => ({ resolveSpy: vi.fn(), executeSpy: vi.fn() }));

vi.mock('../../../trpc/client', () => ({
  trpc: { cyboflow: { monitorReap: { resolve: { mutate: resolveSpy }, execute: { mutate: executeSpy } } } },
}));
vi.mock('../../../hooks/useOcclusion', () => ({ useOcclusion: () => undefined }));
vi.mock('../../../utils/systemNavigation', () => ({ openSystemRun: vi.fn(), openSystemSession: vi.fn() }));

import { SystemGroupedBody, type SystemProcess } from '../SystemGroupedBody';
import { useProcessReap } from '../useProcessReap';
import type { ReapManifestData } from '../reapManifestAdapter';

function proc(pid: number, over: Record<string, unknown> = {}): SystemProcess {
  return {
    bucket: 'owned',
    processType: 'claude-cli',
    command: `claude --resume ${pid}`,
    worktreePath: '/wt/a',
    pid,
    ppid: 1,
    pcpu: 1,
    pmem: 1,
    etimeSeconds: 60,
    owner: { kind: 'cli', panelId: 'p', sessionId: `s-${pid}` },
    ...over,
  } as SystemProcess;
}

function snap(processes: SystemProcess[]): SystemSnapshotData {
  return {
    status: 'ready',
    generatedAt: 1,
    capabilities: { diskSizing: { supported: true } },
    processes,
    worktrees: [
      { path: '/wt/a', branch: 'a', tag: 'session-owned', prunable: true, usage: { status: 'queued' } },
    ] as SystemSnapshotData['worktrees'],
    ports: {
      devRenderer: { port: 4521, label: 'dev renderer', inUse: false },
      cdp: { port: 9223, label: 'CDP', inUse: false },
      orchSocket: { connectionCount: 0, runBindings: {} },
    },
  };
}

function procTarget(
  pid: number,
  tagged = true,
  descendants = 2,
  bucket: 'owned' | 'orphan' | 'suspected' = tagged ? 'owned' : 'suspected',
): ReapManifestData['targets'][number] {
  return {
    kind: 'process',
    pid,
    processType: 'claude-cli',
    bucket,
    command: `claude --resume ${pid}`,
    worktreePath: '/wt/a',
    sessionId: null,
    runId: null,
    taggedAsCyboflow: tagged,
    descendantPidCount: descendants,
  };
}

function manifest(id: string, targets: ReapManifestData['targets']): ReapManifestData {
  return {
    id,
    kind: 'row',
    snapshotGeneratedAt: 1,
    builtAt: 1,
    targets,
    reclaimableBytes: 0,
    unmeasuredTargetCount: 0,
    dirtyFileCount: 0,
    dirtyCountUnknownTargetCount: 0,
    aheadOfMainCount: 0,
    descendantPidCount: targets.length * 2,
    alsoDeleteBranch: false,
  };
}

const onSettled = vi.fn();

/** A button inside the confirm dialog (the row/card buttons share names like "Kill tree"). */
function dialogButton(name: string): HTMLElement {
  return within(screen.getByTestId('manifest-confirm-dialog')).getByRole('button', { name });
}

function Harness({ snapshot, groupBy }: { snapshot: SystemSnapshotData; groupBy: 'worktree' | 'process-type' }) {
  const reap = useProcessReap({ projectId: 7, onSettled });
  return (
    <div>
      {reap.overlay}
      <SystemGroupedBody
        snapshot={snapshot}
        projectId={7}
        groupBy={groupBy}
        sortBy="cpu"
        onKillTree={reap.handlers.onKillTree}
        onKillAll={reap.handlers.onKillAll}
      />
    </div>
  );
}

beforeEach(() => {
  resolveSpy.mockReset();
  executeSpy.mockReset();
  onSettled.mockReset();
});

describe('Kill tree (row, both groupings)', () => {
  for (const groupBy of ['worktree', 'process-type'] as const) {
    it(`resolves a row manifest for that pid and confirms in KillProcessConfirmDialog (${groupBy})`, async () => {
      resolveSpy.mockResolvedValue({ manifest: manifest('reap_1', [procTarget(11)]) });
      render(<Harness snapshot={snap([proc(11), proc(12)])} groupBy={groupBy} />);
      fireEvent.click(screen.getByTestId('kill-tree-11'));
      await screen.findByTestId('manifest-confirm-dialog');
      expect(resolveSpy).toHaveBeenCalledWith({ projectId: 7, selection: { kind: 'row', pids: [11] } });
      // Tagged process: hard dialog, but no untagged warning and the plain confirm label.
      expect(screen.queryByTestId('untagged-process-warning')).toBeNull();
      expect(dialogButton('Kill tree')).toBeInTheDocument();
      expect(screen.getByText('2 descendant PIDs')).toBeInTheDocument();
      expect(executeSpy).not.toHaveBeenCalled();
    });
  }

  it('shows the "not tagged" banner and "Kill anyway" exactly for an untagged target', async () => {
    resolveSpy.mockResolvedValue({ manifest: manifest('reap_2', [procTarget(21, false)]) });
    render(<Harness snapshot={snap([proc(21, { bucket: 'suspected', owner: null })])} groupBy="worktree" />);
    fireEvent.click(screen.getByTestId('kill-tree-21'));
    await screen.findByTestId('untagged-process-warning');
    expect(dialogButton('Kill anyway')).toBeInTheDocument();
  });

  it('executes the exact manifest id the dialog rendered, then refreshes', async () => {
    resolveSpy.mockResolvedValue({ manifest: manifest('reap_exact', [procTarget(11)]) });
    executeSpy.mockResolvedValue({
      manifestId: 'reap_exact',
      alsoDeleteBranch: false,
      results: [{ targetId: 'process:11', kind: 'killed' }],
      errors: [],
    });
    render(<Harness snapshot={snap([proc(11)])} groupBy="worktree" />);
    fireEvent.click(screen.getByTestId('kill-tree-11'));
    await screen.findByTestId('manifest-confirm-dialog');
    fireEvent.click(dialogButton('Kill tree'));
    await screen.findByTestId('reap-summary');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith({ manifestId: 'reap_exact' });
    expect(onSettled).toHaveBeenCalled();
    expect(screen.queryByTestId('manifest-confirm-dialog')).toBeNull();
  });

  it('Cancel never executes', async () => {
    resolveSpy.mockResolvedValue({ manifest: manifest('reap_c', [procTarget(11)]) });
    render(<Harness snapshot={snap([proc(11)])} groupBy="worktree" />);
    fireEvent.click(screen.getByTestId('kill-tree-11'));
    await screen.findByTestId('manifest-confirm-dialog');
    fireEvent.click(dialogButton('Cancel'));
    expect(screen.queryByTestId('manifest-confirm-dialog')).toBeNull();
    expect(executeSpy).not.toHaveBeenCalled();
  });
});

describe('Kill all', () => {
  it('per-type "Kill all (N)" resolves kill-all-of-type and executes the returned manifest', async () => {
    resolveSpy.mockResolvedValue({
      manifest: { ...manifest('reap_type', [procTarget(11), procTarget(12)]), kind: 'kill-all-of-type' },
    });
    executeSpy.mockResolvedValue({
      manifestId: 'reap_type',
      alsoDeleteBranch: false,
      results: [
        { targetId: 'process:11', kind: 'killed' },
        { targetId: 'process:12', kind: 'killed' },
      ],
      errors: [],
    });
    render(<Harness snapshot={snap([proc(11), proc(12)])} groupBy="process-type" />);
    fireEvent.click(screen.getByTestId('type-kill-all-claude-cli'));
    await screen.findByTestId('manifest-confirm-dialog');
    expect(resolveSpy).toHaveBeenCalledWith({
      projectId: 7,
      selection: { kind: 'kill-all-of-type', processType: 'claude-cli' },
    });
    // Tagged batch → plain dialog: no untagged warning.
    expect(screen.queryByTestId('untagged-process-warning')).toBeNull();
    expect(screen.getByTestId('manifest-target-process:11')).toBeInTheDocument();
    expect(screen.getByTestId('manifest-target-process:12')).toBeInTheDocument();
    fireEvent.click(dialogButton('Kill all'));
    await screen.findByTestId('reap-summary');
    expect(executeSpy).toHaveBeenCalledWith({ manifestId: 'reap_type' });
  });

  it('per-card "Kill all processes" resolves a row manifest of the card\'s pids', async () => {
    resolveSpy.mockResolvedValue({ manifest: manifest('reap_card', [procTarget(11), procTarget(12)]) });
    render(<Harness snapshot={snap([proc(11), proc(12)])} groupBy="worktree" />);
    fireEvent.click(screen.getByTestId('wt-kill-all'));
    await screen.findByTestId('manifest-confirm-dialog');
    expect(resolveSpy).toHaveBeenCalledWith({ projectId: 7, selection: { kind: 'row', pids: [11, 12] } });
  });

  it('a mixed batch keeps the plain dialog but names how many are untagged', async () => {
    resolveSpy.mockResolvedValue({ manifest: manifest('reap_mixed', [procTarget(11), procTarget(12, false)]) });
    render(<Harness snapshot={snap([proc(11), proc(12)])} groupBy="process-type" />);
    fireEvent.click(screen.getByTestId('type-kill-all-claude-cli'));
    await screen.findByTestId('untagged-batch-note');
    expect(screen.queryByTestId('untagged-process-warning')).toBeNull();
    expect(dialogButton('Kill all')).toBeInTheDocument();
  });

  it('a batch where EVERY target is untagged uses the harder dialog', async () => {
    resolveSpy.mockResolvedValue({ manifest: manifest('reap_untagged', [procTarget(11, false), procTarget(12, false)]) });
    render(<Harness snapshot={snap([proc(11), proc(12)])} groupBy="process-type" />);
    fireEvent.click(screen.getByTestId('type-kill-all-claude-cli'));
    await screen.findByTestId('untagged-process-warning');
    expect(dialogButton('Kill anyway')).toBeInTheDocument();
  });
});

describe('failures are visible, per target', () => {
  it('renders a survivor PID error and no success summary', async () => {
    resolveSpy.mockResolvedValue({ manifest: manifest('reap_surv', [procTarget(11), procTarget(12)]) });
    executeSpy.mockResolvedValue({
      manifestId: 'reap_surv',
      alsoDeleteBranch: false,
      results: [
        { targetId: 'process:11', kind: 'killed' },
        { targetId: 'process:12', kind: 'survived', survivorPids: [12, 99] },
      ],
      errors: [{ targetId: 'process:12', message: 'Process(es) survived SIGKILL: 12, 99', survivorPids: [12, 99] }],
    });
    render(<Harness snapshot={snap([proc(11), proc(12)])} groupBy="worktree" />);
    fireEvent.click(screen.getByTestId('wt-kill-all'));
    await screen.findByTestId('manifest-confirm-dialog');
    fireEvent.click(dialogButton('Kill all'));
    const row = await screen.findByTestId('reap-error-process:12');
    expect(row).toHaveTextContent('survived SIGKILL');
    expect(screen.getByTestId('reap-survivors-process:12')).toHaveTextContent('12, 99');
    expect(screen.queryByTestId('reap-error-process:11')).toBeNull();
    expect(screen.queryByTestId('reap-summary')).toBeNull();
  });

  it('a target with a failed result is shown as an error even without an errors entry', async () => {
    resolveSpy.mockResolvedValue({ manifest: manifest('reap_fail', [procTarget(11)]) });
    executeSpy.mockResolvedValue({
      manifestId: 'reap_fail',
      alsoDeleteBranch: false,
      results: [{ targetId: 'process:11', kind: 'failed', error: 'Refusing to kill protected pid 11' }],
      errors: [],
    });
    render(<Harness snapshot={snap([proc(11)])} groupBy="worktree" />);
    fireEvent.click(screen.getByTestId('kill-tree-11'));
    await screen.findByTestId('manifest-confirm-dialog');
    fireEvent.click(dialogButton('Kill tree'));
    expect(await screen.findByTestId('reap-error-process:11')).toHaveTextContent('protected pid');
    expect(screen.queryByTestId('reap-summary')).toBeNull();
  });

  it('a stale-manifest rejection is surfaced and nothing is reported as reaped', async () => {
    resolveSpy.mockResolvedValue({ manifest: manifest('reap_old', [procTarget(11)]) });
    executeSpy.mockRejectedValue(new Error('MANIFEST_STALE: target set changed'));
    render(<Harness snapshot={snap([proc(11)])} groupBy="worktree" />);
    fireEvent.click(screen.getByTestId('kill-tree-11'));
    await screen.findByTestId('manifest-confirm-dialog');
    fireEvent.click(dialogButton('Kill tree'));
    expect(await screen.findByTestId('reap-error')).toHaveTextContent('nothing was killed');
    expect(screen.queryByTestId('reap-summary')).toBeNull();
    await waitFor(() => expect(onSettled).toHaveBeenCalled());
  });

  it('a rejected resolve shows an error and opens no dialog', async () => {
    resolveSpy.mockRejectedValue(new Error('No killable process 11 in the snapshot'));
    render(<Harness snapshot={snap([proc(11)])} groupBy="worktree" />);
    fireEvent.click(screen.getByTestId('kill-tree-11'));
    expect(await screen.findByTestId('reap-error')).toHaveTextContent('No killable process 11');
    expect(screen.queryByTestId('manifest-confirm-dialog')).toBeNull();
    expect(executeSpy).not.toHaveBeenCalled();
  });
});

describe('negative control', () => {
  it('without the hook\'s handlers no process kill control exists — the tests above depend on the wiring', () => {
    render(<SystemGroupedBody snapshot={snap([proc(11)])} projectId={7} groupBy="worktree" sortBy="cpu" />);
    expect(screen.queryByTestId('kill-tree-11')).toBeNull();
    expect(screen.queryByTestId('wt-kill-all')).toBeNull();
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});
