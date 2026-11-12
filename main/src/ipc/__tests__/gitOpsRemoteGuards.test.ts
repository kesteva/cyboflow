/**
 * M2 guards on the session-git status/diff/watch entry points: a session on a remote environment never reaches
 * local git or the worktree watcher; each call answers with a readable "not available on remote environments"
 * reason (or the documented neutral value) instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { isPackaged: false, getPath: vi.fn(() => '/mock/path') },
}));
vi.mock('../../index', () => ({ mainWindow: null }));
vi.mock('../../services/panelManager', () => ({
  panelManager: { createPanel: vi.fn(), getPanel: vi.fn(), getAllPanels: vi.fn(() => []) },
}));
vi.mock('../../services/panelEventBus', () => ({
  panelEventBus: { emitPanelEvent: vi.fn(), on: vi.fn(), off: vi.fn() },
}));
vi.mock('../../orchestrator/dynamicWorkflows', () => ({
  DynamicWorkflowTracker: { tryGetInstance: vi.fn(() => undefined) },
}));
vi.mock('../../services/telemetry', () => ({ trackUsage: vi.fn() }));

const subscribe = vi.fn((..._args: unknown[]) => () => {});
vi.mock('../../services/worktreeChangeNotifier', () => ({
  WorktreeChangeNotifier: vi.fn().mockImplementation(function () { return { subscribe }; }),
}));
vi.mock('../../utils/runGit', async () => {
  const actual = await vi.importActual<typeof import('../../utils/runGit')>('../../utils/runGit');
  return { ...actual, runGit: vi.fn(() => ''), runGitAsync: vi.fn(async () => '') };
});
vi.mock('../../services/gitPlumbingCommands', async () => {
  const actual = await vi.importActual<typeof import('../../services/gitPlumbingCommands')>('../../services/gitPlumbingCommands');
  return { ...actual, getCurrentBranch: vi.fn(() => 'feature') };
});

import { createGitOps } from '../gitOps';
import type { AppServices } from '../types';
import { runGit, runGitAsync } from '../../utils/runGit';
import { getCurrentBranch } from '../../services/gitPlumbingCommands';
import { REMOTE_UNAVAILABLE_MESSAGE } from '../../../../shared/types/remoteEnvironment';

const REMOTE = {
  id: 'r1',
  worktreePath: '/home/me/cf-remote/host-a/worktrees/r1',
  hostId: 'host-a',
  archived: false,
};

function makeOps() {
  const gitDiffManager = {
    getWorktreeStatus: vi.fn(),
    getDiffGroups: vi.fn(),
    captureWorkingDirectoryDiff: vi.fn(),
    getCommitHistory: vi.fn(),
  };
  const services = {
    sessionManager: {
      getSession: vi.fn(() => REMOTE),
      getProjectForSession: vi.fn(() => ({ id: 1, path: '/tmp/project' })),
    },
    gitDiffManager,
    worktreeManager: { getProjectMainBranch: vi.fn(async () => 'main') },
    gitStatusManager: { refreshSessionGitStatus: vi.fn() },
    databaseService: {},
    endLiveSession: vi.fn(),
  } as unknown as AppServices;
  return { ops: createGitOps(services), gitDiffManager };
}

beforeEach(() => {
  vi.mocked(runGit).mockClear();
  vi.mocked(runGitAsync).mockClear();
  vi.mocked(getCurrentBranch).mockClear();
  subscribe.mockClear();
});

describe('gitOps remote-session guards', () => {
  it('getCombinedDiff refuses with a readable reason and runs no git', async () => {
    const { ops, gitDiffManager } = makeOps();
    const res = await ops.getCombinedDiff({ sessionId: 'r1' });
    expect(res).toEqual({ success: false, error: 'The diff is not available on remote environments.' });
    expect(gitDiffManager.getWorktreeStatus).not.toHaveBeenCalled();
    expect(gitDiffManager.captureWorkingDirectoryDiff).not.toHaveBeenCalled();
    expect(runGitAsync).not.toHaveBeenCalled();
  });

  it('getCombinedDiff with a scope is refused the same way', async () => {
    const { ops } = makeOps();
    const res = await ops.getCombinedDiff({ sessionId: 'r1', scope: 'unstaged' });
    expect(res.success).toBe(false);
    expect(runGitAsync).not.toHaveBeenCalled();
  });

  it('getComparisonBases refuses without git', async () => {
    const { ops } = makeOps();
    const res = await ops.getComparisonBases({ sessionId: 'r1' });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toContain('not available on remote environments');
    expect(runGitAsync).not.toHaveBeenCalled();
  });

  it('commit refuses before any git status / add / commit', async () => {
    const { ops } = makeOps();
    const res = await ops.commit({ sessionId: 'r1', message: 'x' });
    expect(res).toEqual({ success: false, error: 'Committing is not available on remote environments.' });
    expect(runGit).not.toHaveBeenCalled();
  });

  it('getCurrentBranch reports no branch without reading local git', async () => {
    const { ops } = makeOps();
    expect(await ops.getCurrentBranch({ sessionId: 'r1' })).toEqual({ success: true, data: { branch: null } });
    expect(getCurrentBranch).not.toHaveBeenCalled();
  });

  it('subscribeWorktreeChanges hands the host id to the notifier (which returns a no-op unsubscribe)', async () => {
    const { ops } = makeOps();
    const res = await ops.subscribeWorktreeChanges({ sessionId: 'r1' }, () => {});
    expect(res.success).toBe(true);
    expect(subscribe).toHaveBeenCalledWith('r1', REMOTE.worktreePath, expect.any(Function), 'host-a');
  });

  it('the renderer empty-state line is the shared constant', () => {
    expect(REMOTE_UNAVAILABLE_MESSAGE).toBe('Not available on remote environments');
  });
});
