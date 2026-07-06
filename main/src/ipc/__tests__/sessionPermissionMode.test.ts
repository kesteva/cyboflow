/**
 * Unit tests for the sessions:update-agent-permission-mode IPC handler (Issue #1).
 *
 * The handler persists sessions.agent_permission_mode (next-turn re-read for the
 * SDK substrate) and fires session-updated. No settings-file side effect exists
 * anymore: the interactive PTY gating hook rides the inline `--settings` flag
 * and is recomputed from the persisted mode at every spawn
 * (interactiveClaudeManager buildCommandArgs -> resolveInlineGatingHooks), so the
 * former .claude/settings.json re-prime (and its demo/existence/fail-soft
 * guards) is gone. Exercised via the same handler-capture harness as
 * sessionQuickCreate.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';

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
