/**
 * Regression coverage for the substrate lookup registerClaudePanelHandlers
 * wires into the ClaudePanelManager it builds.
 *
 * The panel override is deliberately different from the session substrate so
 * this test proves the exported claudePanelManager resolves the panel's own
 * substrate (via panelManager) before dispatching the continuation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'Cyboflow'),
    getVersion: vi.fn(() => '0.1.0'),
  },
}));

const panel = {
  id: 'panel-added',
  sessionId: 'session-1',
  type: 'claude' as const,
  title: 'Chat 2',
  substrate: 'interactive' as const,
  state: { isActive: true, customState: {} },
  metadata: { createdAt: '', lastActiveAt: '', position: 1 },
};

vi.mock('../../services/panelManager', () => ({
  panelManager: {
    getPanel: vi.fn(() => panel),
    getAllPanels: vi.fn(() => []),
    getPanelsForSession: vi.fn(() => [panel]),
    updatePanel: vi.fn(async () => {}),
  },
}));

import { claudePanelManager, registerClaudePanelHandlers } from '../claudePanel';
import type { AppServices } from '../types';
import { panelManager } from '../../services/panelManager';

type Handler = (...args: unknown[]) => Promise<unknown>;

function makeIpcMain() {
  return { handle: (_channel: string, _handler: Handler) => undefined };
}

function makeCliManager() {
  return Object.assign(new EventEmitter(), {
    startPanel: vi.fn(async () => {}),
    continuePanel: vi.fn(async () => {}),
    stopPanel: vi.fn(async () => {}),
  });
}

function makeServices(sdkManager: ReturnType<typeof makeCliManager>, interactiveManager: ReturnType<typeof makeCliManager>): AppServices {
  const conversationHistory = [
    { id: 1, session_id: 'session-1', message_type: 'user' as const, content: 'earlier turn', timestamp: '2026-07-23' },
  ];

  return {
    sessionManager: {
      getSession: vi.fn(() => ({ id: 'session-1', worktreePath: '/tmp/session-1' })),
      getDbSession: vi.fn(() => ({ substrate: 'sdk' })),
      getPanelConversationMessages: vi.fn(() => conversationHistory),
      addPanelConversationMessage: vi.fn(),
      getPanelOutputs: vi.fn(() => []),
    },
    databaseService: {
      getActivePanels: vi.fn(() => []),
      getPanelSettings: vi.fn(() => ({})),
      updatePanelSettings: vi.fn(),
    },
    configManager: { getDefaultModel: vi.fn(() => 'sonnet') },
    claudeCodeManager: sdkManager,
    interactiveCliManager: interactiveManager,
  } as unknown as AppServices;
}

describe('claudePanelManager.continuePanel — per-panel substrate override', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(panelManager.getPanel).mockReturnValue(panel);
  });

  it('routes a continuation through the panel override even when the session inherits SDK', async () => {
    const sdkManager = makeCliManager();
    const interactiveManager = makeCliManager();
    const services = makeServices(sdkManager, interactiveManager);
    const ipcMain = makeIpcMain();

    registerClaudePanelHandlers(
      ipcMain as unknown as Parameters<typeof registerClaudePanelHandlers>[0],
      services,
    );
    claudePanelManager.registerPanel('panel-added', 'session-1');

    await claudePanelManager.continuePanel(
      'panel-added',
      '/tmp/session-1',
      'first turn in the added chat',
      services.sessionManager.getPanelConversationMessages('panel-added'),
      'opus',
    );

    expect(interactiveManager.continuePanel).toHaveBeenCalledWith(
      'panel-added',
      'session-1',
      '/tmp/session-1',
      'first turn in the added chat',
      [expect.objectContaining({ message_type: 'user', content: 'earlier turn' })],
      undefined,
      'opus',
    );
    expect(sdkManager.continuePanel).not.toHaveBeenCalled();
  });
});
