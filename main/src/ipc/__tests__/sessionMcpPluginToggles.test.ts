/**
 * Unit tests for the sessions:update-session-mcps / sessions:update-session-plugins
 * IPC handlers (Slice 5 of the per-session MCP/plugin toggle work).
 *
 * Each handler clones the sessions:update-agent-permission-mode shape: validate
 * the string[] payload, persist the JSON column via databaseService.updateSession
 * (disabled_mcp_servers_json = the DENY set / enabled_plugins_json = the ALLOW
 * set), mirror the parsed array onto the runtime session, and emit
 * 'session-updated'. The handlers are exercised via the same lightweight
 * handler-capture harness used by sessionQuickCreate.test.ts; all collaborators
 * are stubbed at the object level (no real SQLite).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Electron is imported transitively via session.ts -> panelManager etc.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'Cyboflow'),
    getVersion: vi.fn(() => '0.1.0'),
  },
}));

// panelManager uses IPC at module load time - stub it.
vi.mock('../../services/panelManager', () => ({
  panelManager: {
    getPanel: vi.fn(),
    getAllPanels: vi.fn(() => []),
    getPanelsForSession: vi.fn(() => []),
    createPanel: vi.fn(),
  },
}));

// The databaseService SINGLETON (services/database) is referenced by other
// handlers at registration; stub it so the module never opens a real sqlite file.
vi.mock('../../services/database', () => ({
  databaseService: {
    getSession: vi.fn(() => ({ id: 'sess-001', status: 'running', archived: false })),
  },
}));

import { registerSessionHandlers } from '../session';
import type { AppServices } from '../types';

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

interface FakeSession {
  id: string;
  disabledMcpServers?: string[];
  enabledPlugins?: string[];
}

function makeServices() {
  const fakeSession: FakeSession = { id: 'sess-001' };
  const updateSession = vi.fn(() => fakeSession);
  const getSession = vi.fn(() => fakeSession);
  const emit = vi.fn();

  const services = {
    sessionManager: { getSession, emit },
    databaseService: { updateSession },
    taskQueue: {},
    worktreeManager: {},
    cliManagerFactory: {},
    claudeCodeManager: {},
    interactiveCliManager: {},
    killLiveSession: vi.fn(),
    registerLivePanel: vi.fn(),
    gitStatusManager: {},
    archiveProgressManager: undefined,
    configManager: { isDemoMode: () => false },
    cyboflow: { workflowRegistry: {}, runLauncher: {} },
  } as unknown as AppServices;

  return { services, fakeSession, updateSession, getSession, emit };
}

function register(services: AppServices) {
  const { ipcMain, handlers } = makeHandlerCapture();
  registerSessionHandlers(
    ipcMain as unknown as Parameters<typeof registerSessionHandlers>[0],
    services,
  );
  return handlers;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sessions:update-session-mcps (DENY list)', () => {
  it('persists the deny set as JSON, mirrors it, and emits session-updated', async () => {
    const { services, fakeSession, updateSession, emit } = makeServices();
    const handlers = register(services);

    const res = (await invoke(handlers, 'sessions:update-session-mcps', 'sess-001', [
      'peekaboo',
      'playwright',
    ])) as { success: boolean };

    expect(res.success).toBe(true);
    expect(updateSession).toHaveBeenCalledWith('sess-001', {
      disabled_mcp_servers_json: JSON.stringify(['peekaboo', 'playwright']),
    });
    expect(fakeSession.disabledMcpServers).toEqual(['peekaboo', 'playwright']);
    expect(emit).toHaveBeenCalledWith('session-updated', fakeSession);
  });

  it('persists an empty deny set byte-identically ("[]")', async () => {
    const { services, updateSession } = makeServices();
    const handlers = register(services);

    await invoke(handlers, 'sessions:update-session-mcps', 'sess-001', []);

    expect(updateSession).toHaveBeenCalledWith('sess-001', { disabled_mcp_servers_json: '[]' });
  });

  it('rejects a non-string-array payload without touching the DB', async () => {
    const { services, updateSession } = makeServices();
    const handlers = register(services);

    const res = (await invoke(handlers, 'sessions:update-session-mcps', 'sess-001', [
      'ok',
      42,
    ])) as { success: boolean; error?: string };

    expect(res.success).toBe(false);
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('returns "Session not found" when the row does not update', async () => {
    const { services, updateSession, emit } = makeServices();
    updateSession.mockReturnValueOnce(undefined as unknown as FakeSession);
    const handlers = register(services);

    const res = (await invoke(handlers, 'sessions:update-session-mcps', 'missing', [])) as {
      success: boolean;
      error?: string;
    };

    expect(res.success).toBe(false);
    expect(res.error).toBe('Session not found');
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('sessions:update-session-plugins (ALLOW list)', () => {
  it('persists the allow set as JSON, mirrors it, and emits session-updated', async () => {
    const { services, fakeSession, updateSession, emit } = makeServices();
    const handlers = register(services);

    const res = (await invoke(handlers, 'sessions:update-session-plugins', 'sess-001', [
      'formatter@acme',
    ])) as { success: boolean };

    expect(res.success).toBe(true);
    expect(updateSession).toHaveBeenCalledWith('sess-001', {
      enabled_plugins_json: JSON.stringify(['formatter@acme']),
    });
    expect(fakeSession.enabledPlugins).toEqual(['formatter@acme']);
    expect(emit).toHaveBeenCalledWith('session-updated', fakeSession);
  });

  it('rejects a non-string-array payload without touching the DB', async () => {
    const { services, updateSession } = makeServices();
    const handlers = register(services);

    const res = (await invoke(handlers, 'sessions:update-session-plugins', 'sess-001', 'nope')) as {
      success: boolean;
    };

    expect(res.success).toBe(false);
    expect(updateSession).not.toHaveBeenCalled();
  });
});
