/**
 * Behavioral tests for the destructive git ops in main/src/ipc/gitOps.ts — the
 * implementations behind the `cyboflow.sessionGit` tRPC router.
 *
 * Covered:
 *  - rebaseMainIntoWorktree short-circuits on a detected conflict WITHOUT
 *    mutating the worktree (worktreeManager.rebaseMainIntoWorktree is never
 *    invoked), and performs the rebase on the clean path.
 *  - push surfaces a push failure as success:false + gitError, and returns the
 *    worktreeManager result on success.
 *  - abortRebaseAndUseClaude is a no-op (does NOT call abortRebase, does NOT
 *    throw) when the worktree is NOT mid-rebase.
 *  - the 30s Promise.race timeout on getProjectMainBranch REJECTS+reports instead
 *    of hanging.
 *
 * The ops are built directly from a stubbed AppServices; all service
 * collaborators are object-stubbed. The `../index` (mainWindow) and panelManager
 * singletons are module-mocked; the DB-backed close-out helpers are neutralized
 * with a fake db whose statements are inert.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { isPackaged: false, getPath: vi.fn(() => '/mock'), getName: vi.fn(() => 'Cyboflow'), getVersion: vi.fn(() => '0.1.0') },
}));

// gitOps.ts imports `mainWindow` from '../index' == src/index.ts (the app entry).
// From this test file that resolves to '../../index'; stub it so the real app
// entry (and its electron-coupled trpc adapter) is never loaded.
vi.mock('../../index', () => ({ mainWindow: null }));

// gitOps.ts imports '../services/panelManager' == src/services/panelManager; from
// this test file that is '../../services/panelManager'.
vi.mock('../../services/panelManager', () => ({
  panelManager: {
    createPanel: vi.fn(async () => ({ id: 'panel-git-1', state: { customState: {} } })),
    getPanelsForSession: vi.fn(() => []),
  },
}));

// abortRebaseAndUseClaude does `require('./claudePanel')` (src/ipc/claudePanel).
vi.mock('../claudePanel', () => ({
  claudePanelManager: { registerPanel: vi.fn(), startPanel: vi.fn(async () => {}) },
}));

// The sync runGit (src/utils/runGit) is only reached by abortRebaseAndUseClaude's status probe.
const runGitMock = vi.fn((..._args: unknown[]): string => '');
vi.mock('../../utils/runGit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/runGit')>()),
  runGit: (...args: unknown[]) => runGitMock(...args),
}));

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
  checkForRebaseConflicts?: ReturnType<typeof vi.fn>;
  rebaseMainIntoWorktree?: ReturnType<typeof vi.fn>;
  getProjectMainBranch?: ReturnType<typeof vi.fn>;
  gitPush?: ReturnType<typeof vi.fn>;
  abortRebase?: ReturnType<typeof vi.fn>;
  hasChangesToRebase?: ReturnType<typeof vi.fn>;
  squashAndMergeWorktreeToMain?: ReturnType<typeof vi.fn>;
  mergeWorktreeToMain?: ReturnType<typeof vi.fn>;
  getHeadCommit?: ReturnType<typeof vi.fn>;
}

function makeServices(session: Record<string, unknown> | undefined, wt: WtOverrides = {}, endLiveSession = vi.fn(async () => {})) {
  const worktreeManager = {
    getProjectMainBranch: wt.getProjectMainBranch ?? vi.fn(async () => 'main'),
    checkForRebaseConflicts: wt.checkForRebaseConflicts ?? vi.fn(async () => ({ hasConflicts: false })),
    rebaseMainIntoWorktree: wt.rebaseMainIntoWorktree ?? vi.fn(async () => {}),
    gitPush: wt.gitPush ?? vi.fn(async () => ({ output: 'pushed' })),
    abortRebase: wt.abortRebase ?? vi.fn(async () => {}),
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

beforeEach(() => {
  runGitMock.mockReset();
  runGitMock.mockReturnValue('');
});

describe('rebaseMainIntoWorktree — conflict short-circuit', () => {
  it('returns a conflict error WITHOUT mutating the worktree when conflicts are detected', async () => {
    const { services, worktreeManager } = makeServices(SESSION, {
      checkForRebaseConflicts: vi.fn(async () => ({
        hasConflicts: true,
        conflictingFiles: ['src/a.ts'],
        conflictingCommits: { ours: ['abc our'], theirs: ['def their'] },
      })),
    });
    const ops = createGitOps(services);

    const result = (await ops.rebaseMainIntoWorktree({ sessionId: 's1' })) as {
      success: boolean;
      error?: string;
      gitError?: { hasConflicts?: boolean; conflictingFiles?: string[] };
    };

    expect(result.success).toBe(false);
    expect(result.error).toBe('Rebase would result in conflicts');
    expect(result.gitError?.hasConflicts).toBe(true);
    expect(result.gitError?.conflictingFiles).toEqual(['src/a.ts']);
    // The mutating rebase is never attempted — the short-circuit protects the tree.
    expect(worktreeManager.rebaseMainIntoWorktree).not.toHaveBeenCalled();
  });

  it('performs the rebase on the clean path (no conflicts)', async () => {
    const { services, worktreeManager } = makeServices(SESSION, {
      checkForRebaseConflicts: vi.fn(async () => ({ hasConflicts: false })),
    });
    const ops = createGitOps(services);

    const result = (await ops.rebaseMainIntoWorktree({ sessionId: 's1' })) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(worktreeManager.rebaseMainIntoWorktree).toHaveBeenCalledWith('/proj/wt', 'main');
  });
});

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

describe('abortRebaseAndUseClaude — no-op when not mid-rebase', () => {
  it('does NOT call abortRebase and does not throw when git status shows no rebase', async () => {
    // Status probe with no "rebase" token -> the abort branch is skipped.
    runGitMock.mockReturnValue('?? untracked.txt\n');
    const { services, worktreeManager } = makeServices(SESSION);
    const ops = createGitOps(services);

    // The op must RESOLVE (the absent rebase is a no-op, not an error).
    // NOTE: the downstream Claude-panel spin-up goes through a dynamic
    // require('./claudePanel') that vitest's vi.mock does NOT intercept, so the
    // final success value depends on the real panel module and is not asserted
    // here — the no-op-on-abort behavior is the point.
    const result = (await ops.abortRebaseAndUseClaude({ sessionId: 's1' })) as {
      success: boolean;
    };

    // The destructive abortRebase is NOT invoked — nothing to abort.
    expect(worktreeManager.abortRebase).not.toHaveBeenCalled();
    // A status probe ran to decide there was no rebase to abort.
    expect(runGitMock).toHaveBeenCalled();
    // Resolved to a well-formed response object rather than throwing.
    expect(typeof result.success).toBe('boolean');
  });
});

describe('rebaseMainIntoWorktree — Promise.race timeout', () => {
  it('rejects and reports instead of hanging when getProjectMainBranch never resolves', async () => {
    vi.useFakeTimers();
    try {
      const { services, worktreeManager } = makeServices(SESSION, {
        // Never settles — only the 30s race timer can resolve the outer await.
        getProjectMainBranch: vi.fn(() => new Promise<string>(() => {})),
      });
      const ops = createGitOps(services);

      const pending = ops.rebaseMainIntoWorktree({ sessionId: 's1' }) as Promise<{
        success: boolean;
        error?: string;
      }>;
      await vi.advanceTimersByTimeAsync(30000);
      const result = await pending;

      expect(result.success).toBe(false);
      expect(result.error).toContain('timeout');
      // The timeout fired before any conflict check / mutation was reached.
      expect(worktreeManager.rebaseMainIntoWorktree).not.toHaveBeenCalled();
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
