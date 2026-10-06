/**
 * Unit tests for the branch resolution in `getStatistics`
 * (main/src/ipc/sessionOps.ts) — the ops implementation behind the
 * `cyboflow.sessions.getStatistics` tRPC procedure, formerly the
 * `sessions:get-statistics` IPC handler (TASK-085).
 *
 * The running-session card previously showed the literal 'HEAD' / a 'main'
 * fallback because it returned `session.baseBranch || 'main'`
 * verbatim instead of resolving the LIVE worktree branch. The fix calls
 * `getCurrentBranch(session.worktreePath)` ONCE per session (not per-panel)
 * and only falls back to `baseBranch || 'main'` when that resolves to null
 * (unreadable worktree / detached HEAD with no resolvable ref).
 *
 * `baseBranch` semantics are otherwise untouched, so this suite only locks
 * the new `statistics.session.branch` fallback chain — it does not
 * re-assert every other field the payload carries.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'Cyboflow'),
    getVersion: vi.fn(() => '0.1.0'),
  },
}));

const { mockGetPanelsForSession } = vi.hoisted(() => ({
  mockGetPanelsForSession: vi.fn(() => [] as Array<{ id: string; type: string }>),
}));

vi.mock('../../services/panelManager', () => ({
  panelManager: {
    getPanel: vi.fn(),
    getAllPanels: vi.fn(() => []),
    getPanelsForSession: mockGetPanelsForSession,
    createPanel: vi.fn(),
  },
}));

vi.mock('../../services/database', () => ({
  databaseService: {
    getSession: vi.fn(() => ({ id: 'sess-001', status: 'running', archived: false })),
  },
}));

const { mockGetCurrentBranch } = vi.hoisted(() => ({
  mockGetCurrentBranch: vi.fn<(cwd: string) => string | null>(),
}));

vi.mock('../../services/gitPlumbingCommands', () => ({
  getCurrentBranch: mockGetCurrentBranch,
}));

import { createSessionOps } from '../sessionOps';
import type { AppServices } from '../types';

const SESSION_ID = 'sess-001';
const WORKTREE = '/tmp/project/quick-test';

function makeServices(opts: { baseBranch?: string; worktreePath?: string }) {
  const fakeDb = {
    // Backs selectSessionRunTokenTotals(db, sessionId) — no matching runs.
    prepare: vi.fn(() => ({ all: vi.fn(() => []) })),
  };

  const fakeSessionManager = {
    getSession: vi.fn(() => ({
      id: SESSION_ID,
      name: 'Test Session',
      status: 'running',
      createdAt: new Date('2026-07-01T00:00:00Z'),
      lastActivity: new Date('2026-07-01T00:05:00Z'),
      worktreePath: opts.worktreePath ?? WORKTREE,
      baseBranch: opts.baseBranch,
    })),
  };

  const fakeDatabaseService = {
    getSessionTokenUsage: vi.fn(() => ({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      messageCount: 0,
    })),
    getExecutionDiffStats: vi.fn(() => []),
    getSessionOutputCounts: vi.fn(() => ({ json: 0, stdout: 0, stderr: 0 })),
    getSessionToolUsage: vi.fn(() => ({ tools: [], totalToolCalls: 0 })),
    getPromptMarkers: vi.fn(() => []),
    getConversationMessageCount: vi.fn(() => 0),
    getPanelPromptMarkers: vi.fn(() => []),
    getPanelConversationMessageCount: vi.fn(() => 0),
    getPanelSettings: vi.fn(() => ({})),
    getDb: vi.fn(() => fakeDb),
  };

  const services = {
    sessionManager: fakeSessionManager,
    databaseService: fakeDatabaseService,
    taskQueue: {},
    worktreeManager: {},
    cliManagerFactory: {},
    claudeCodeManager: { isPanelRunning: vi.fn(() => false) },
    interactiveCliManager: { isPanelRunning: vi.fn(() => false) },
    killLiveSession: vi.fn(),
    registerLivePanel: vi.fn(),
    gitStatusManager: {},
    archiveProgressManager: undefined,
    configManager: { isDemoMode: () => false },
    cyboflow: { workflowRegistry: {}, runLauncher: {} },
  } as unknown as AppServices;

  return { services, fakeSessionManager };
}

describe('sessionOps.getStatistics — branch resolution', () => {
  beforeEach(() => {
    mockGetCurrentBranch.mockReset();
    mockGetPanelsForSession.mockReset();
    mockGetPanelsForSession.mockReturnValue([]);
  });

  it('uses the live worktree branch when getCurrentBranch resolves one', async () => {
    mockGetCurrentBranch.mockReturnValue('feature/live-branch');
    const { services } = makeServices({ baseBranch: 'main', worktreePath: WORKTREE });
    const ops = createSessionOps(services);

    const result = (await ops.getStatistics({ sessionId: SESSION_ID })) as {
      success: boolean;
      data: { session: { branch: string } };
    };

    expect(result.success).toBe(true);
    expect(result.data.session.branch).toBe('feature/live-branch');
    expect(mockGetCurrentBranch).toHaveBeenCalledWith(WORKTREE);
    // Resolved once per session, not once per panel.
    expect(mockGetCurrentBranch).toHaveBeenCalledTimes(1);
  });

  it('falls back to baseBranch when getCurrentBranch returns null (detached HEAD / unreadable worktree)', async () => {
    mockGetCurrentBranch.mockReturnValue(null);
    const { services } = makeServices({ baseBranch: 'develop', worktreePath: WORKTREE });
    const ops = createSessionOps(services);

    const result = (await ops.getStatistics({ sessionId: SESSION_ID })) as {
      success: boolean;
      data: { session: { branch: string } };
    };

    expect(result.success).toBe(true);
    expect(result.data.session.branch).toBe('develop');
  });

  it('falls back to "main" when getCurrentBranch returns null and there is no baseBranch', async () => {
    mockGetCurrentBranch.mockReturnValue(null);
    const { services } = makeServices({ baseBranch: undefined, worktreePath: WORKTREE });
    const ops = createSessionOps(services);

    const result = (await ops.getStatistics({ sessionId: SESSION_ID })) as {
      success: boolean;
      data: { session: { branch: string } };
    };

    expect(result.success).toBe(true);
    expect(result.data.session.branch).toBe('main');
  });

  it('resolves the branch once per session even when the session hosts multiple panels', async () => {
    // Regression guard for the "worktree-level, not per-panel" resolution
    // claim: simulate a session with several Claude panels (the loop the
    // handler runs over for prompt/message counts and model resolution) and
    // confirm getCurrentBranch is still invoked exactly once, not once per
    // panel found via panelManager.getPanelsForSession.
    mockGetPanelsForSession.mockReturnValue([
      { id: 'panel-1', type: 'claude' },
      { id: 'panel-2', type: 'claude' },
      { id: 'panel-3', type: 'claude' },
    ]);
    mockGetCurrentBranch.mockReturnValue('feature/multi-panel');
    const { services } = makeServices({ baseBranch: 'main', worktreePath: WORKTREE });
    const ops = createSessionOps(services);

    const result = (await ops.getStatistics({ sessionId: SESSION_ID })) as {
      success: boolean;
      data: { session: { branch: string } };
    };

    expect(result.success).toBe(true);
    expect(result.data.session.branch).toBe('feature/multi-panel');
    expect(mockGetCurrentBranch).toHaveBeenCalledTimes(1);
  });
});
