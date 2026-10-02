/**
 * Behavioral tests for the destructive git ops in main/src/ipc/gitOps.ts — the
 * implementations behind the `cyboflow.sessionGit` tRPC router.
 *
 * Covered:
 *  - push surfaces a push failure as success:false + gitError, and returns the
 *    worktreeManager result on success.
 *  - the 30s Promise.race timeout on getProjectMainBranch REJECTS+reports instead
 *    of hanging.
 *  - squashAndRebaseToMain / rebaseToMain end the session's live processes.
 *
 * The ops are built directly from a stubbed AppServices; all service
 * collaborators are object-stubbed. The `../index` (mainWindow) singleton is
 * module-mocked; the DB-backed close-out helpers are neutralized with a fake db
 * whose statements are inert.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { isPackaged: false, getPath: vi.fn(() => '/mock'), getName: vi.fn(() => 'Cyboflow'), getVersion: vi.fn(() => '0.1.0') },
}));

// gitOps.ts imports `mainWindow` from '../index' == src/index.ts (the app entry).
// From this test file that resolves to '../../index'; stub it so the real app
// entry (and its electron-coupled trpc adapter) is never loaded.
vi.mock('../../index', () => ({ mainWindow: null }));

import { createGitOps } from '../gitOps';
import type { AppServices } from '../types';

// Inert DB: every statement runs to zero changes / empty rows so the fail-soft
// close-out helpers (finalizeSprintLanesOnSessionMerge, stampSessionRunsPrOpen)
// become no-ops without a real sqlite file.
function inertDb() {
  const stmt = { run: () => ({ changes: 0 }), get: () => undefined, all: () => [] };
  return { prepare: () => stmt, transaction: <T>(fn: (...a: unknown[]) => T) => fn };
}

interface WtOverrides {
  getProjectMainBranch?: ReturnType<typeof vi.fn>;
  gitPush?: ReturnType<typeof vi.fn>;
  hasChangesToRebase?: ReturnType<typeof vi.fn>;
  squashAndMergeWorktreeToMain?: ReturnType<typeof vi.fn>;
  mergeWorktreeToMain?: ReturnType<typeof vi.fn>;
  getHeadCommit?: ReturnType<typeof vi.fn>;
}

function makeServices(session: Record<string, unknown> | undefined, wt: WtOverrides = {}, endLiveSession = vi.fn(async () => {})) {
  const worktreeManager = {
    getProjectMainBranch: wt.getProjectMainBranch ?? vi.fn(async () => 'main'),
    gitPush: wt.gitPush ?? vi.fn(async () => ({ output: 'pushed' })),
    hasChangesToRebase: wt.hasChangesToRebase ?? vi.fn(async () => false),
    squashAndMergeWorktreeToMain: wt.squashAndMergeWorktreeToMain ?? vi.fn(async () => {}),
    mergeWorktreeToMain: wt.mergeWorktreeToMain ?? vi.fn(async () => {}),
    getHeadCommit: wt.getHeadCommit ?? vi.fn(async () => 'abc123'),
  };
  const services = {
    sessionManager: {
      getSession: vi.fn(() => session),
      getProjectForSession: vi.fn(() => ({ id: 7, name: 'Proj', path: '/proj' })),
      addSessionOutput: vi.fn(),
      getAllSessions: vi.fn(async () => []),
    },
    gitDiffManager: {},
    worktreeManager,
    claudeCodeManager: {},
    gitStatusManager: {
      updateGitStatusAfterRebase: vi.fn(async () => {}),
      updateProjectGitStatusAfterMainUpdate: vi.fn(async () => {}),
      refreshSessionGitStatus: vi.fn(async () => {}),
    },
    databaseService: { getDb: () => inertDb() },
    configManager: { isDemoMode: () => false, getConfig: () => ({}) },
    endLiveSession,
  } as unknown as AppServices;
  return { services, worktreeManager };
}

const SESSION = { id: 's1', worktreePath: '/proj/wt', projectId: 7, name: 'sess' };

describe('push — failure surfacing + success passthrough', () => {
  it('surfaces a push failure as success:false with the git output', async () => {
    const pushErr = Object.assign(new Error('push rejected'), {
      gitOutput: '! [rejected] main -> main (non-fast-forward)',
    });
    const { services, worktreeManager } = makeServices(SESSION, {
      gitPush: vi.fn(async () => {
        throw pushErr;
      }),
    });
    const ops = createGitOps(services);

    const result = (await ops.push({ sessionId: 's1' })) as {
      success: boolean;
      error?: string;
      gitError?: { output?: string };
    };

    expect(worktreeManager.gitPush).toHaveBeenCalledWith('/proj/wt');
    expect(result.success).toBe(false);
    expect(result.error).toBe('push rejected');
    expect(result.gitError?.output).toContain('non-fast-forward');
  });

  it('returns the worktreeManager push result on success', async () => {
    const { services } = makeServices(SESSION, {
      gitPush: vi.fn(async () => ({ output: 'Everything up-to-date' })),
    });
    const ops = createGitOps(services);

    const result = (await ops.push({ sessionId: 's1' })) as {
      success: boolean;
      data?: { output?: string };
    };

    expect(result.success).toBe(true);
    expect(result.data?.output).toBe('Everything up-to-date');
  });
});

describe('squashAndRebaseToMain — Promise.race timeout', () => {
  it('rejects and reports instead of hanging when getProjectMainBranch never resolves', async () => {
    vi.useFakeTimers();
    try {
      const { services, worktreeManager } = makeServices(SESSION, {
        // Never settles — only the 30s race timer can resolve the outer await.
        getProjectMainBranch: vi.fn(() => new Promise<string>(() => {})),
      });
      const ops = createGitOps(services);

      const pending = ops.squashAndRebaseToMain({ sessionId: 's1', commitMessage: 'msg' }) as Promise<{
        success: boolean;
        error?: string;
      }>;
      await vi.advanceTimersByTimeAsync(30000);
      const result = await pending;

      expect(result.success).toBe(false);
      expect(result.error).toContain('timeout');
      // The timeout fired before the rebase guard or the merge was reached.
      expect(worktreeManager.hasChangesToRebase).not.toHaveBeenCalled();
      expect(worktreeManager.squashAndMergeWorktreeToMain).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// endLiveSessionProcesses close-out (SDK-aware teardown gap fix): both
// squashAndRebaseToMain AND rebaseToMain must reach services.endLiveSession
// (the SubstrateDispatchFacade.endSession seam) for a session with a chatRunId,
// on EITHER substrate — not just 'interactive'. Prior behavior gated the call
// on `session.substrate === 'interactive'`, silently orphaning a warm SDK
// process across close-out.
// ---------------------------------------------------------------------------

describe('squashAndRebaseToMain — endLiveSessionProcesses close-out', () => {
  it('calls endLiveSession with the chatRunId for an interactive-substrate session', async () => {
    const session = { ...SESSION, substrate: 'interactive', chatRunId: 'chat-run-1' };
    const endLiveSession = vi.fn(async () => {});
    const { services } = makeServices(session, {}, endLiveSession);
    const ops = createGitOps(services);

    const result = (await ops.squashAndRebaseToMain({ sessionId: 's1', commitMessage: 'commit msg' })) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(endLiveSession).toHaveBeenCalledOnce();
    expect(endLiveSession).toHaveBeenCalledWith('chat-run-1');
  });

  it('calls endLiveSession with the chatRunId for an SDK-substrate session (the fixed gap)', async () => {
    const session = { ...SESSION, substrate: 'sdk', chatRunId: 'chat-run-2' };
    const endLiveSession = vi.fn(async () => {});
    const { services } = makeServices(session, {}, endLiveSession);
    const ops = createGitOps(services);

    const result = (await ops.squashAndRebaseToMain({ sessionId: 's1', commitMessage: 'commit msg' })) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(endLiveSession).toHaveBeenCalledOnce();
    expect(endLiveSession).toHaveBeenCalledWith('chat-run-2');
  });

  it('does NOT call endLiveSession when the session has no chatRunId', async () => {
    const session = { ...SESSION, substrate: 'sdk', chatRunId: null };
    const endLiveSession = vi.fn(async () => {});
    const { services } = makeServices(session, {}, endLiveSession);
    const ops = createGitOps(services);

    await ops.squashAndRebaseToMain({ sessionId: 's1', commitMessage: 'commit msg' });

    expect(endLiveSession).not.toHaveBeenCalled();
  });
});

describe('rebaseToMain — endLiveSessionProcesses close-out', () => {
  it('calls endLiveSession with the chatRunId for an SDK-substrate session (the fixed gap)', async () => {
    const session = { ...SESSION, substrate: 'sdk', chatRunId: 'chat-run-3' };
    const endLiveSession = vi.fn(async () => {});
    const { services } = makeServices(session, {}, endLiveSession);
    const ops = createGitOps(services);

    const result = (await ops.rebaseToMain({ sessionId: 's1' })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(endLiveSession).toHaveBeenCalledOnce();
    expect(endLiveSession).toHaveBeenCalledWith('chat-run-3');
  });

  it('calls endLiveSession with the chatRunId for an interactive-substrate session', async () => {
    const session = { ...SESSION, substrate: 'interactive', chatRunId: 'chat-run-4' };
    const endLiveSession = vi.fn(async () => {});
    const { services } = makeServices(session, {}, endLiveSession);
    const ops = createGitOps(services);

    const result = (await ops.rebaseToMain({ sessionId: 's1' })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(endLiveSession).toHaveBeenCalledOnce();
    expect(endLiveSession).toHaveBeenCalledWith('chat-run-4');
  });
});
