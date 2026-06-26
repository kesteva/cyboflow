/**
 * Unit tests for the sessions:update-agent-permission-mode IPC handler (Issue #1).
 *
 * The handler persists sessions.agent_permission_mode (next-turn re-read for the
 * SDK substrate) AND, for the INTERACTIVE substrate, primes the worktree's
 * .claude/settings.json so the NEXT PTY spawn picks up the new gating
 * (relayUserTurn never re-reads the hook). default/acceptEdits keep the wildcard
 * PreToolUse hook (writer.write); auto/dontAsk strip it (writer.remove). The
 * rewrite is demo-gated, worktree-existence-guarded, and fully fail-soft.
 *
 * The InteractiveSettingsWriter and fs.existsSync are mocked so no real worktree
 * is touched; the handler is exercised via the same handler-capture harness as
 * sessionQuickCreate.test.ts.
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

// fs.existsSync gates the rewrite against a torn-down worktree. Default: present.
const mockExistsSync = vi.fn((_p: string) => true);
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: (p: string) => mockExistsSync(p) };
});

// The settings writer is the unit under contract here — stub write/remove.
const mockWrite = vi.fn();
const mockRemove = vi.fn();
vi.mock('../../services/panels/claude/interactiveSettingsWriter', () => ({
  InteractiveSettingsWriter: vi.fn().mockImplementation(() => ({
    write: (worktreePath: string, opts?: { permissionMode?: string }) =>
      mockWrite(worktreePath, opts),
    remove: (worktreePath: string) => mockRemove(worktreePath),
  })),
}));

import { registerSessionHandlers } from '../session';
import type { AppServices } from '../types';

const CHANNEL = 'sessions:update-agent-permission-mode';
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

function makeServices(opts: {
  substrate?: string;
  isDemoMode?: boolean;
  updateReturns?: boolean;
  worktreePath?: string | undefined;
}) {
  const dbSession = {
    id: SESSION_ID,
    substrate: opts.substrate,
    worktree_path: opts.worktreePath === undefined ? WORKTREE : opts.worktreePath,
  };
  const fakeDatabaseService = {
    updateSession: vi.fn(() => (opts.updateReturns === false ? undefined : dbSession)),
    getSession: vi.fn(() => dbSession),
  };
  const fakeSessionManager = {
    getSession: vi.fn(() => ({ id: SESSION_ID, agentPermissionMode: 'default' })),
    emit: vi.fn(),
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
    configManager: { isDemoMode: () => opts.isDemoMode ?? false },
    cyboflow: { workflowRegistry: {}, runLauncher: {} },
  } as unknown as AppServices;

  return { services, fakeDatabaseService, fakeSessionManager };
}

function registerWith(services: AppServices) {
  const { ipcMain, handlers } = makeHandlerCapture();
  registerSessionHandlers(
    ipcMain as unknown as Parameters<typeof registerSessionHandlers>[0],
    services,
  );
  return handlers;
}

beforeEach(() => {
  mockExistsSync.mockReset().mockReturnValue(true);
  mockWrite.mockReset();
  mockRemove.mockReset();
});

describe('sessions:update-agent-permission-mode — persist + emit', () => {
  it('rejects an invalid mode without persisting', async () => {
    const { services, fakeDatabaseService } = makeServices({ substrate: 'sdk' });
    const handlers = registerWith(services);
    const result = (await invoke(handlers, CHANNEL, SESSION_ID, 'bogus')) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(fakeDatabaseService.updateSession).not.toHaveBeenCalled();
  });

  it('persists the mode and emits session-updated for an SDK session', async () => {
    const { services, fakeDatabaseService, fakeSessionManager } = makeServices({ substrate: 'sdk' });
    const handlers = registerWith(services);
    const result = (await invoke(handlers, CHANNEL, SESSION_ID, 'acceptEdits')) as {
      success: boolean;
    };
    expect(result.success).toBe(true);
    expect(fakeDatabaseService.updateSession).toHaveBeenCalledWith(SESSION_ID, {
      agent_permission_mode: 'acceptEdits',
    });
    expect(fakeSessionManager.emit).toHaveBeenCalledWith('session-updated', expect.anything());
  });

  it('returns Session not found when the row does not update', async () => {
    const { services } = makeServices({ substrate: 'sdk', updateReturns: false });
    const handlers = registerWith(services);
    const result = (await invoke(handlers, CHANNEL, SESSION_ID, 'auto')) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe('Session not found');
  });
});

describe('sessions:update-agent-permission-mode — interactive settings rewrite', () => {
  it('installs the wildcard hook (writer.write) for default on an interactive session', async () => {
    const { services } = makeServices({ substrate: 'interactive' });
    const handlers = registerWith(services);
    await invoke(handlers, CHANNEL, SESSION_ID, 'default');
    expect(mockWrite).toHaveBeenCalledWith(WORKTREE, { permissionMode: 'default' });
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('installs the wildcard hook for acceptEdits on an interactive session', async () => {
    const { services } = makeServices({ substrate: 'interactive' });
    const handlers = registerWith(services);
    await invoke(handlers, CHANNEL, SESSION_ID, 'acceptEdits');
    expect(mockWrite).toHaveBeenCalledWith(WORKTREE, { permissionMode: 'acceptEdits' });
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('removes the hook (writer.remove) for auto on an interactive session', async () => {
    const { services } = makeServices({ substrate: 'interactive' });
    const handlers = registerWith(services);
    await invoke(handlers, CHANNEL, SESSION_ID, 'auto');
    expect(mockRemove).toHaveBeenCalledWith(WORKTREE);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('removes the hook for dontAsk on an interactive session', async () => {
    const { services } = makeServices({ substrate: 'interactive' });
    const handlers = registerWith(services);
    await invoke(handlers, CHANNEL, SESSION_ID, 'dontAsk');
    expect(mockRemove).toHaveBeenCalledWith(WORKTREE);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('does NOT touch the settings file for an SDK session', async () => {
    const { services } = makeServices({ substrate: 'sdk' });
    const handlers = registerWith(services);
    await invoke(handlers, CHANNEL, SESSION_ID, 'default');
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('skips the rewrite in demo mode', async () => {
    const { services } = makeServices({ substrate: 'interactive', isDemoMode: true });
    const handlers = registerWith(services);
    await invoke(handlers, CHANNEL, SESSION_ID, 'default');
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('skips the rewrite (fail-soft) when the worktree no longer exists', async () => {
    mockExistsSync.mockReturnValue(false);
    const { services } = makeServices({ substrate: 'interactive' });
    const handlers = registerWith(services);
    const result = (await invoke(handlers, CHANNEL, SESSION_ID, 'default')) as { success: boolean };
    expect(result.success).toBe(true);
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('still succeeds when the writer throws (never throws across the boundary)', async () => {
    mockWrite.mockImplementation(() => {
      throw new Error('disk full');
    });
    const { services } = makeServices({ substrate: 'interactive' });
    const handlers = registerWith(services);
    const result = (await invoke(handlers, CHANNEL, SESSION_ID, 'default')) as { success: boolean };
    expect(result.success).toBe(true);
  });
});
