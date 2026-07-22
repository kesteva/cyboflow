/**
 * Unit tests for the sessions:get-statistics IPC handler's branch resolution
 * (TASK-085).
 *
 * The running-session card previously showed the literal 'HEAD' / a 'main'
 * fallback because the handler returned `session.baseBranch || 'main'`
 * verbatim instead of resolving the LIVE worktree branch. The fix calls
 * `getCurrentBranch(session.worktreePath)` ONCE per session (not per-panel)
 * and only falls back to `baseBranch || 'main'` when that resolves to null
 * (unreadable worktree / detached HEAD with no resolvable ref).
 *
 * `baseBranch` semantics are otherwise untouched, so this suite only locks
 * the new `statistics.session.branch` fallback chain — it does not
 * re-assert every other field the handler returns.
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

vi.mock('../../services/panelManager', () => ({
  panelManager: {
    getPanel: vi.fn(),
    getAllPanels: vi.fn(() => []),
    getPanelsForSession: vi.fn(() => []),
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

import { registerSessionHandlers } from '../session';
import type { AppServices } from '../types';

const CHANNEL = 'sessions:get-statistics';
const SESSION_ID = 'sess-001';
const WORKTREE = '/tmp/project/quick-test';

function makeHandlerCapture() {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const ipcMain = {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, fn);
    },
  };
  return { ipcMain, handlers };
}

async function invoke(
  handlers: Map<string, (...args: unknown[]) => Promise<unknown>>,
  channel: string,
  ...args: unknown[]
): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for channel: ${channel}`);
  return fn({} as unknown, ...args);
}

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

function registerWith(services: AppServices) {
  const { ipcMain, handlers } = makeHandlerCapture();
  registerSessionHandlers(
    ipcMain as unknown as Parameters<typeof registerSessionHandlers>[0],
    services,
  );
  return handlers;
}

describe('sessions:get-statistics — branch resolution', () => {
  beforeEach(() => {
    mockGetCurrentBranch.mockReset();
  });

  it('uses the live worktree branch when getCurrentBranch resolves one', async () => {
    mockGetCurrentBranch.mockReturnValue('feature/live-branch');
    const { services } = makeServices({ baseBranch: 'main', worktreePath: WORKTREE });
    const handlers = registerWith(services);

    const result = (await invoke(handlers, CHANNEL, SESSION_ID)) as {
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
    const handlers = registerWith(services);

    const result = (await invoke(handlers, CHANNEL, SESSION_ID)) as {
      success: boolean;
      data: { session: { branch: string } };
    };

    expect(result.success).toBe(true);
    expect(result.data.session.branch).toBe('develop');
  });

  it('falls back to "main" when getCurrentBranch returns null and there is no baseBranch', async () => {
    mockGetCurrentBranch.mockReturnValue(null);
    const { services } = makeServices({ baseBranch: undefined, worktreePath: WORKTREE });
    const handlers = registerWith(services);

    const result = (await invoke(handlers, CHANNEL, SESSION_ID)) as {
      success: boolean;
      data: { session: { branch: string } };
    };

    expect(result.success).toBe(true);
    expect(result.data.session.branch).toBe('main');
  });
});
