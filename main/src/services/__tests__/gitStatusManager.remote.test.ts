/**
 * M2 remote guard: a session whose worktree lives on a remote environment gets a cached neutral status and never
 * reaches local git (no plumbing command, no main-branch lookup), however it is asked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session } from '../../types/session';
import type { SessionManager } from '../sessionManager';
import type { WorktreeManager } from '../worktreeManager';
import type { GitDiffManager } from '../gitDiffManager';

vi.mock('../gitPlumbingCommands', async () => {
  const actual = await vi.importActual<typeof import('../gitPlumbingCommands')>('../gitPlumbingCommands');
  return {
    ...actual,
    fastCheckWorkingDirectory: vi.fn(async () => ({ hasModified: false, hasStaged: false, hasUntracked: false, hasConflicts: false })),
    fastGetAheadBehind: vi.fn(async () => ({ ahead: 0, behind: 0 })),
    fastGetDiffStats: vi.fn(async () => ({ additions: 0, deletions: 0, filesChanged: 0 })),
  };
});
vi.mock('../../utils/runGit', () => ({ runGitAsync: vi.fn(async () => '') }));

import { fastCheckWorkingDirectory, fastGetAheadBehind } from '../gitPlumbingCommands';
import { runGitAsync } from '../../utils/runGit';
import { GitStatusManager } from '../gitStatusManager';

function session(id: string, hostId: string | null): Session {
  return {
    id,
    name: id,
    worktreePath: hostId ? `/home/me/cf-remote/${hostId}/worktrees/${id}` : `/fake/${id}`,
    prompt: '',
    status: 'ready',
    output: [],
    jsonMessages: [],
    createdAt: new Date(),
    projectId: 1,
    hostId,
  };
}

function makeManager(sessions: Session[]) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const getSession = vi.fn(async (id: string) => byId.get(id));
  const getProjectMainBranch = vi.fn(async () => 'main');
  const sessionManager = {
    getSession,
    getProjectForSession: vi.fn(() => ({ id: 1, path: '/fake/project' })),
    getAllSessions: vi.fn(async () => sessions),
  } as unknown as SessionManager;
  const worktreeManager = { getProjectMainBranch } as unknown as WorktreeManager;
  const manager = new GitStatusManager(sessionManager, worktreeManager, {} as unknown as GitDiffManager);
  return { manager, getSession, getProjectMainBranch };
}

beforeEach(() => {
  vi.mocked(fastCheckWorkingDirectory).mockClear();
  vi.mocked(fastGetAheadBehind).mockClear();
  vi.mocked(runGitAsync).mockClear();
});

describe('GitStatusManager — remote sessions', () => {
  it('getGitStatus returns a neutral unknown status for a remote session without running git', async () => {
    const { manager, getProjectMainBranch } = makeManager([session('r1', 'host-a')]);
    const status = await manager.getGitStatus('r1');
    expect(status?.state).toBe('unknown');
    expect(fastCheckWorkingDirectory).not.toHaveBeenCalled();
    expect(fastGetAheadBehind).not.toHaveBeenCalled();
    expect(runGitAsync).not.toHaveBeenCalled();
    expect(getProjectMainBranch).not.toHaveBeenCalled();
    expect(manager.peekCachedStatus('r1')?.status.state).toBe('unknown');
  });

  it('caches the remote status for good: later calls never re-read the session (no polling)', async () => {
    const { manager, getSession } = makeManager([session('r1', 'host-a')]);
    await manager.getGitStatus('r1');
    const reads = getSession.mock.calls.length;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 60_000); // far past the 5 s TTL
      expect((await manager.getGitStatus('r1'))?.state).toBe('unknown');
      expect((await manager.refreshSessionGitStatus('r1'))?.state).toBe('unknown');
      expect((await manager.queueInitialLoad('r1'))?.state).toBe('unknown');
    } finally {
      vi.useRealTimers();
    }
    expect(getSession.mock.calls.length).toBe(reads);
    expect(fastCheckWorkingDirectory).not.toHaveBeenCalled();
  });

  it('a first refresh of an unseen remote session resolves to the neutral status without the quick git check', async () => {
    vi.useFakeTimers();
    try {
      const { manager } = makeManager([session('r1', 'host-a')]);
      const p = manager.refreshSessionGitStatus('r1');
      await vi.advanceTimersByTimeAsync(2_500);
      expect((await p)?.state).toBe('unknown');
    } finally {
      vi.useRealTimers();
    }
    expect(fastCheckWorkingDirectory).not.toHaveBeenCalled();
  });

  it('main-branch updates and rebase updates skip remote sessions but still refresh local ones', async () => {
    const { manager, getProjectMainBranch } = makeManager([session('r1', 'host-a'), session('l1', null)]);
    // Seed a local cache entry so the local session takes the cheap ahead/behind path.
    await manager.getGitStatus('l1');
    vi.mocked(fastGetAheadBehind).mockClear();
    getProjectMainBranch.mockClear();

    await manager.updateProjectGitStatusAfterMainUpdate(1);
    await manager.updateGitStatusAfterRebase('r1', 'from_main');

    expect(fastGetAheadBehind).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fastGetAheadBehind).mock.calls[0][0]).toBe('/fake/l1');
    expect(manager.peekCachedStatus('r1')?.status.state).toBe('unknown');
  });

  it("'local' and null host ids keep the local git path", async () => {
    const { manager } = makeManager([session('l1', null), { ...session('l2', null), hostId: 'local' }]);
    expect((await manager.getGitStatus('l1'))?.state).toBe('clean');
    expect((await manager.getGitStatus('l2'))?.state).toBe('clean');
    expect(fastCheckWorkingDirectory).toHaveBeenCalledTimes(2);
  });
});
