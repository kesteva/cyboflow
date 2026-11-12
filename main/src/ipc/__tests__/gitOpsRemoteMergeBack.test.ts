/**
 * M2 merge-back wiring in the session git ops: a session on a remote environment merges, pushes and probes delivery
 * through the MergeBackService (a fake on the bridge here — its real-git behaviour is covered by
 * services/hosts/mergeBack/__tests__/mergeBackService.test.ts). The live agent is stopped BEFORE the import, the
 * unchanged WorktreeManager merge runs on the MIRROR path, and the remote worktree path never reaches local git.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('../../services/worktreeChangeNotifier', () => ({
  WorktreeChangeNotifier: vi.fn().mockImplementation(function () { return { subscribe: vi.fn() }; }),
}));
vi.mock('../../orchestrator/artifactRouter', () => ({
  ArtifactRouter: { getInstance: vi.fn(() => ({ reapForRun: vi.fn() })) },
}));
const closeOut = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../../orchestrator/runRecovery', () => ({
  stampSessionRunsOutcome: vi.fn(() => { closeOut.calls.push('stampMerged'); return 1; }),
  stampSessionRunsPrOpen: vi.fn(() => 0),
  stampSessionRunsCompleted: vi.fn(() => 0),
  stampSessionRunsLanded: vi.fn(() => { closeOut.calls.push('stampLanded'); return 1; }),
  sessionDeliveredWork: vi.fn(() => false),
  sessionCompletedNoCodeWork: vi.fn(() => false),
}));
vi.mock('../../utils/runGit', async () => {
  const actual = await vi.importActual<typeof import('../../utils/runGit')>('../../utils/runGit');
  return { ...actual, runGit: vi.fn(() => 'git@example.com:me/repo.git\n'), runGitAsync: vi.fn(async () => 'mainsha\n') };
});

import { createGitOps } from '../gitOps';
import type { AppServices } from '../types';
import type { Session } from '../../types/session';
import { runGit, runGitAsync } from '../../utils/runGit';
import { setMergeBackService } from '../../services/hosts/mergeBack/mergeBackBridge';
import type {
  MergeBackServiceLike,
  MergeSessionInput,
  MirrorHandle,
  RemoteMergeOutcome,
} from '../../services/hosts/mergeBack/mergeBackService';

const REMOTE = { id: 'r1', worktreePath: '/home/me/cf-remote/h/wt/k1', hostId: 'host-a', chatRunId: '__quick__r1', archived: false, projectId: 1 };
const MIRROR = '/tmp/project/.cyboflow/worktrees/remote-import/k1';

let order: string[];
let outcome: RemoteMergeOutcome;
let landing: { landed: boolean; ownCommits: number; proven: boolean };
let fake: MergeBackServiceLike & { recordLanded: ReturnType<typeof vi.fn> };

function makeOps(session: Partial<Session> = REMOTE) {
  const worktreeManager = {
    getProjectMainBranch: vi.fn(async () => 'main'),
    hasChangesToRebase: vi.fn(async (p: string) => { order.push(`guard:${p}`); return false; }),
    squashAndMergeWorktreeToMain: vi.fn(async (_proj: string, p: string) => { order.push(`squash:${p}`); }),
    mergeWorktreeToMain: vi.fn(async (_proj: string, p: string) => { order.push(`merge:${p}`); }),
    gitPush: vi.fn(async (p: string) => { order.push(`push:${p}`); return { output: 'pushed' }; }),
    getBranchLandingState: vi.fn(async () => ({ landed: false, ownCommits: 0 })),
    getHeadCommit: vi.fn(async () => 'mainsha'),
  };
  const endLiveSession = vi.fn(async () => { order.push('stop'); });
  const db = { prepare: vi.fn(() => ({ all: vi.fn(() => []), get: vi.fn(), run: vi.fn() })), transaction: vi.fn(), name: ':memory:' };
  const services = {
    sessionManager: {
      getSession: vi.fn(async () => session),
      getProjectForSession: vi.fn(() => ({ id: 1, path: '/tmp/project' })),
      addSessionOutput: vi.fn(),
      getAllSessions: vi.fn(async () => []),
    },
    gitDiffManager: {},
    worktreeManager,
    gitStatusManager: { refreshSessionGitStatus: vi.fn(), updateProjectGitStatusAfterMainUpdate: vi.fn() },
    databaseService: { getDb: vi.fn(() => db) },
    endLiveSession,
  } as unknown as AppServices;
  return { ops: createGitOps(services), worktreeManager, endLiveSession };
}

beforeEach(() => {
  order = [];
  closeOut.calls = [];
  outcome = { kind: 'merged' };
  landing = { landed: false, ownCommits: 2, proven: true };
  const mirror: MirrorHandle = { worktreePath: MIRROR, branch: 'k1', importSha: 'abc' };
  fake = {
    mergeSession: vi.fn(async (input: MergeSessionInput) => {
      await input.stopProcesses?.();
      order.push('import');
      if (await input.needsRebase?.(MIRROR)) return { kind: 'needs-rebase', message: 'refreshed' } as RemoteMergeOutcome;
      if (outcome.kind !== 'needs-rebase') await input.merge(MIRROR);
      return outcome;
    }),
    withMirror: vi.fn(async (input, fn) => {
      await input.stopProcesses?.();
      order.push('import');
      return fn(mirror);
    }) as MergeBackServiceLike['withMirror'],
    refreshBase: vi.fn(async () => 'refreshed'),
    probeLanding: vi.fn(async () => landing),
    recordLanded: vi.fn(async () => undefined),
    recordClosedOut: vi.fn(async () => undefined),
    mirrorBranch: vi.fn(async () => 'k1'),
    requestCheckpoint: vi.fn(async () => undefined),
    cleanup: vi.fn(async () => true),
    cleanupLocal: vi.fn(async () => true),
    resumeAll: vi.fn(async () => ({ resynced: 0, cleaned: 0, closedOut: 0, left: 0, errored: 0 })),
  };
  setMergeBackService(fake);
  vi.mocked(runGit).mockClear();
  vi.mocked(runGitAsync).mockClear();
});

afterEach(() => {
  setMergeBackService(null);
});

describe('gitOps remote merge-back', () => {
  it('squash: stops the agent, imports, guards and squashes the MIRROR, then closes out', async () => {
    const { ops, worktreeManager } = makeOps();
    const res = await ops.squashAndRebaseToMain({ sessionId: 'r1', commitMessage: 'msg' });
    expect(res.success).toBe(true);
    expect(order.slice(0, 4)).toEqual(['stop', 'import', `guard:${MIRROR}`, `squash:${MIRROR}`]);
    expect(worktreeManager.squashAndMergeWorktreeToMain).toHaveBeenCalledWith('/tmp/project', MIRROR, 'main', 'msg');
    expect(closeOut.calls).toContain('stampMerged');
    expect(fake.recordClosedOut).toHaveBeenCalledWith('r1'); // boot resume must not repeat this close-out
  });

  it('squash: main moved → needsRebase with the refresh-base message, nothing merged', async () => {
    const { ops, worktreeManager } = makeOps();
    worktreeManager.hasChangesToRebase.mockResolvedValueOnce(true);
    const res = await ops.squashAndRebaseToMain({ sessionId: 'r1', commitMessage: 'msg' });
    expect(res).toEqual({ success: false, needsRebase: true, error: 'refreshed' });
    expect(worktreeManager.squashAndMergeWorktreeToMain).not.toHaveBeenCalled();
    expect(closeOut.calls).toEqual([]);
  });

  it('squash: an already-landed outcome closes out like a merge', async () => {
    outcome = { kind: 'already-landed' };
    const { ops } = makeOps();
    const res = await ops.squashAndRebaseToMain({ sessionId: 'r1', commitMessage: 'msg' });
    expect(res.success).toBe(true);
    expect(closeOut.calls).toContain('stampMerged');
  });

  it('squash: a merge-back error is a readable failure', async () => {
    vi.mocked(fake.mergeSession).mockRejectedValueOnce(new Error('Uncommitted changes on Studio — ask the agent to commit them first.'));
    const { ops } = makeOps();
    const res = await ops.squashAndRebaseToMain({ sessionId: 'r1', commitMessage: 'msg' });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toMatch(/Uncommitted changes on Studio/);
  });

  it('squash: an agent stop that fails aborts the merge — nothing imported, merged or closed out', async () => {
    const { ops, worktreeManager, endLiveSession } = makeOps();
    endLiveSession.mockRejectedValueOnce(new Error('environment unreachable'));
    const res = await ops.squashAndRebaseToMain({ sessionId: 'r1', commitMessage: 'msg' });
    expect(res.success).toBe(false);
    expect(order).not.toContain('import');
    expect(worktreeManager.squashAndMergeWorktreeToMain).not.toHaveBeenCalled();
    expect(closeOut.calls).toEqual([]);
  });

  it('rebase-merge runs the unchanged mergeWorktreeToMain on the mirror', async () => {
    const { ops, worktreeManager } = makeOps();
    const res = await ops.rebaseToMain({ sessionId: 'r1' });
    expect(res.success).toBe(true);
    expect(worktreeManager.mergeWorktreeToMain).toHaveBeenCalledWith('/tmp/project', MIRROR, 'main');
    expect(order.slice(0, 2)).toEqual(['stop', 'import']);
  });

  it('push (Create PR) pushes from the mirror; getRemoteUrl answers the project origin + mirror branch', async () => {
    const { ops, worktreeManager } = makeOps();
    const res = await ops.push({ sessionId: 'r1' });
    expect(res.success).toBe(true);
    expect(worktreeManager.gitPush).toHaveBeenCalledWith(MIRROR);
    const url = await ops.getRemoteUrl({ sessionId: 'r1' });
    expect(url).toEqual({ success: true, data: { remoteUrl: 'git@example.com:me/repo.git', branchName: 'k1' } });
    expect(vi.mocked(runGit).mock.calls.every(([cwd]) => cwd === '/tmp/project')).toBe(true);
  });

  it('getDeliveryState probes through the service, never the remote path', async () => {
    const { ops, worktreeManager } = makeOps();
    landing = { landed: true, ownCommits: 0, proven: false };
    const res = await ops.getDeliveryState({ sessionId: 'r1' });
    expect(res).toMatchObject({ success: true, data: { landed: true, ownCommits: 0, completedNoCode: false } });
    expect(fake.probeLanding).toHaveBeenCalledWith('r1', '/tmp/project', 'main');
    expect(worktreeManager.getBranchLandingState).not.toHaveBeenCalled();
  });

  it('markComplete on a landed remote session closes out, reads main in the project, and records the landing', async () => {
    landing = { landed: true, ownCommits: 1, proven: true };
    const { ops } = makeOps();
    const res = await ops.markComplete({ sessionId: 'r1' });
    expect(res.success).toBe(true);
    expect(vi.mocked(runGitAsync)).toHaveBeenCalledWith('/tmp/project', ['rev-parse', 'main']);
    expect(closeOut.calls).toContain('stampLanded');
    expect(fake.recordLanded).toHaveBeenCalledWith('r1', 'main');
  });

  it('markComplete on an unproven remote probe (refresh failed) does no landed close-out', async () => {
    landing = { landed: false, ownCommits: 0, proven: false };
    const { ops } = makeOps();
    const res = await ops.markComplete({ sessionId: 'r1' });
    expect(res.success).toBe(true);
    expect(closeOut.calls).not.toContain('stampLanded');
    expect(fake.recordLanded).not.toHaveBeenCalled();
  });

  it('a local session never touches the merge-back service', async () => {
    const local = { id: 'l1', worktreePath: '/tmp/wt', hostId: null, chatRunId: null, archived: false, projectId: 1 };
    const { ops, worktreeManager } = makeOps(local as unknown as Session);
    await ops.squashAndRebaseToMain({ sessionId: 'l1', commitMessage: 'msg' });
    await ops.push({ sessionId: 'l1' });
    await ops.getDeliveryState({ sessionId: 'l1' });
    expect(worktreeManager.squashAndMergeWorktreeToMain).toHaveBeenCalledWith('/tmp/project', '/tmp/wt', 'main', 'msg');
    expect(worktreeManager.gitPush).toHaveBeenCalledWith('/tmp/wt');
    expect(fake.mergeSession).not.toHaveBeenCalled();
    expect(fake.withMirror).not.toHaveBeenCalled();
    expect(fake.probeLanding).not.toHaveBeenCalled();
  });
});
