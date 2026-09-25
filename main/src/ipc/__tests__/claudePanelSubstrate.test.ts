/**
 * Payload-shape coverage for claude-panels:get-substrate / set-substrate
 * (main/src/ipc/claudePanel.ts). Locks the {success,data}/{success,error}
 * runtime contract, including the invalid-substrate rejection branch and the
 * panel.type !== 'claude' guard — claudePanelContinue.test.ts only covers the
 * continue seam, so this was previously untested.
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

const claudePanel = {
  id: 'panel-claude',
  sessionId: 'session-1',
  type: 'claude' as const,
  title: 'Chat',
  substrate: 'interactive' as const,
  state: { isActive: true, customState: {} },
  metadata: { createdAt: '', lastActiveAt: '', position: 1 },
};

const terminalPanel = {
  id: 'panel-terminal',
  sessionId: 'session-1',
  type: 'terminal' as const,
  title: 'Terminal',
  state: { isActive: true, customState: {} },
  metadata: { createdAt: '', lastActiveAt: '', position: 2 },
};

vi.mock('../../services/panelManager', () => ({
  panelManager: {
    getPanel: vi.fn(),
    getAllPanels: vi.fn(() => []),
    getPanelsForSession: vi.fn(() => []),
    updatePanel: vi.fn(async () => {}),
  },
}));

import { registerClaudePanelHandlers } from '../claudePanel';
import type { AppServices } from '../types';
import { panelManager } from '../../services/panelManager';

type Handler = (...args: unknown[]) => Promise<unknown>;

function makeHandlerCapture() {
  const handlers = new Map<string, Handler>();
  const ipcMain = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) };
  return { ipcMain, handlers };
}

function invoke(handlers: Map<string, Handler>, channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return handler({} as unknown, ...args);
}

function makeServices(): AppServices {
  return {
    sessionManager: {
      getSession: vi.fn(() => ({ id: 'session-1', worktreePath: '/tmp/session-1' })),
      getDbSession: vi.fn(() => ({ substrate: 'sdk' })),
      getPanelConversationMessages: vi.fn(() => []),
      addPanelConversationMessage: vi.fn(),
      getPanelOutputs: vi.fn(() => []),
    },
    databaseService: {
      getActivePanels: vi.fn(() => []),
      getPanelSettings: vi.fn(() => ({})),
      updatePanelSettings: vi.fn(),
    },
    configManager: { getDefaultModel: vi.fn(() => 'sonnet') },
    claudeCodeManager: { on: vi.fn() },
    interactiveCliManager: { on: vi.fn() },
  } as unknown as AppServices;
}

function register() {
  const { ipcMain, handlers } = makeHandlerCapture();
  registerClaudePanelHandlers(ipcMain as unknown as Parameters<typeof registerClaudePanelHandlers>[0], makeServices());
  return handlers;
}

describe('claude-panels:get-substrate / set-substrate — payload shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('get-substrate returns {success:true,data} with the panel substrate', async () => {
    vi.mocked(panelManager.getPanel).mockReturnValue(claudePanel);
    const handlers = register();

    const result = await invoke(handlers, 'claude-panels:get-substrate', 'panel-claude');
    expect(result).toEqual({ success: true, data: 'interactive' });
  });

  it('get-substrate returns {success:true,data:null} when the panel is not found', async () => {
    vi.mocked(panelManager.getPanel).mockReturnValue(undefined);
    const handlers = register();

    const result = await invoke(handlers, 'claude-panels:get-substrate', 'nope');
    expect(result).toEqual({ success: true, data: null });
  });

  it('set-substrate rejects a value outside the CliSubstrate union with {success:false,error}', async () => {
    vi.mocked(panelManager.getPanel).mockReturnValue(claudePanel);
    const handlers = register();

    const result = await invoke(handlers, 'claude-panels:set-substrate', 'panel-claude', 'bogus');
    expect(result).toEqual({ success: false, error: 'Invalid panel substrate' });
    expect(panelManager.updatePanel).not.toHaveBeenCalled();
  });

  it('set-substrate rejects a non-claude panel with {success:false,error} (panel.type !== "claude" guard)', async () => {
    vi.mocked(panelManager.getPanel).mockReturnValue(terminalPanel);
    const handlers = register();

    const result = await invoke(handlers, 'claude-panels:set-substrate', 'panel-terminal', 'sdk');
    expect(result).toEqual({ success: false, error: 'Claude panel not found' });
    expect(panelManager.updatePanel).not.toHaveBeenCalled();
  });

  it('set-substrate rejects an unknown panel id with {success:false,error}', async () => {
    vi.mocked(panelManager.getPanel).mockReturnValue(undefined);
    const handlers = register();

    const result = await invoke(handlers, 'claude-panels:set-substrate', 'nope', 'sdk');
    expect(result).toEqual({ success: false, error: 'Claude panel not found' });
    expect(panelManager.updatePanel).not.toHaveBeenCalled();
  });

  it('set-substrate accepts a valid substrate on a claude panel and returns {success:true}', async () => {
    vi.mocked(panelManager.getPanel).mockReturnValue(claudePanel);
    const handlers = register();

    const result = await invoke(handlers, 'claude-panels:set-substrate', 'panel-claude', 'sdk');
    expect(result).toEqual({ success: true });
    expect(panelManager.updatePanel).toHaveBeenCalledWith('panel-claude', { substrate: 'sdk' });
  });

  it('set-substrate accepts null (clear the per-panel override) and returns {success:true}', async () => {
    vi.mocked(panelManager.getPanel).mockReturnValue(claudePanel);
    const handlers = register();

    const result = await invoke(handlers, 'claude-panels:set-substrate', 'panel-claude', null);
    expect(result).toEqual({ success: true });
    expect(panelManager.updatePanel).toHaveBeenCalledWith('panel-claude', { substrate: null });
  });
});
