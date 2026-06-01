/**
 * Unit tests for registerPanelHandlers — panels:initialize cwd routing.
 *
 * Behaviors covered (per TASK-657 acceptance criteria):
 *
 * Case A: panel.state.customState.cwd takes priority over options.cwd.
 * Case B: options.cwd is persisted into customState.cwd (via panelManager.updatePanel)
 *         BEFORE terminalPanelManager.initializeTerminal is invoked, when
 *         customState.cwd is initially unset.
 * Case C: process.cwd() is used as the last-resort fallback when neither
 *         customState.cwd nor options.cwd is present.
 * Case D: non-terminal panels (e.g. 'claude') do NOT invoke initializeTerminal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppServices } from '../types';
import type { ToolPanel } from '../../../../shared/types/panels';

// ---------------------------------------------------------------------------
// Module-level mocks
// vi.mock factories are hoisted to the top of the file by Vitest, so any
// variables they reference must also be hoisted via vi.hoisted().
// ---------------------------------------------------------------------------

const { mockPanelManager, mockTerminalPanelManager } = vi.hoisted(() => {
  const mockPanelManager = {
    getPanel: vi.fn(),
    updatePanel: vi.fn().mockResolvedValue(undefined),
    getPanelsForSession: vi.fn(() => []),
    setActivePanel: vi.fn(),
    createPanel: vi.fn(),
    deletePanel: vi.fn(),
    emitPanelEvent: vi.fn(),
  };

  const mockTerminalPanelManager = {
    initializeTerminal: vi.fn().mockResolvedValue(undefined),
    destroyTerminal: vi.fn(),
    isTerminalInitialized: vi.fn(() => false),
    resizeTerminal: vi.fn(),
    writeToTerminal: vi.fn(),
    getTerminalState: vi.fn(),
    saveTerminalState: vi.fn(),
  };

  return { mockPanelManager, mockTerminalPanelManager };
});

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
  panelManager: mockPanelManager,
}));

vi.mock('../../services/terminalPanelManager', () => ({
  terminalPanelManager: mockTerminalPanelManager,
}));

vi.mock('../../services/database', () => ({
  databaseService: { getActivePanel: vi.fn() },
}));

// Import registerPanelHandlers AFTER mocks are in place.
import { registerPanelHandlers } from '../panels';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Capture handlers registered via ipcMain.handle so they can be invoked
 * directly in tests, bypassing the real Electron IPC stack.
 * Mirrors the pattern in cyboflow.test.ts lines 51-61.
 */
function makeHandlerCapture() {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const ipcMain = {
    handle: vi.fn(
      (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
        handlers.set(channel, fn);
      },
    ),
  };
  return { ipcMain, handlers };
}

/** Invoke a captured handler with a fake IpcMainInvokeEvent + spread args. */
async function invoke(
  handlers: Map<string, (...args: unknown[]) => Promise<unknown>>,
  channel: string,
  ...args: unknown[]
): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for channel: ${channel}`);
  // ipcMain.handle callbacks receive (event, ...args).
  return fn({} as unknown, ...args);
}

/** Build a minimal terminal ToolPanel fixture. */
function makeTerminalPanel(customState: Record<string, unknown> = {}): ToolPanel {
  return {
    id: 'panel-terminal-1',
    sessionId: 'session-1',
    type: 'terminal',
    title: 'Terminal 1',
    state: {
      isActive: true,
      hasBeenViewed: true, // already viewed so updatePanel for hasBeenViewed is skipped
      customState,
    },
    metadata: {
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      position: 0,
    },
  };
}

/** Build a minimal claude ToolPanel fixture. */
function makeClaudePanel(): ToolPanel {
  return {
    id: 'panel-claude-1',
    sessionId: 'session-1',
    type: 'claude',
    title: 'Claude 1',
    state: {
      isActive: true,
      hasBeenViewed: true,
      customState: {},
    },
    metadata: {
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      position: 0,
    },
  };
}

/** Minimal AppServices stub — panels:initialize does not use services. */
const stubServices = {} as unknown as AppServices;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerPanelHandlers — panels:initialize cwd routing', () => {
  let handlers: Map<string, (...args: unknown[]) => Promise<unknown>>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-register handlers so mock call orders reset correctly per test.
    const capture = makeHandlerCapture();
    handlers = capture.handlers;
    registerPanelHandlers(
      capture.ipcMain as unknown as Parameters<typeof registerPanelHandlers>[0],
      stubServices,
    );
    // Reset mock resolved values after clearAllMocks wipes them.
    mockPanelManager.updatePanel.mockResolvedValue(undefined);
    mockTerminalPanelManager.initializeTerminal.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Case A: customState.cwd wins over options.cwd
  // -------------------------------------------------------------------------
  it('Case A: customState.cwd takes priority over options.cwd', async () => {
    const panel = makeTerminalPanel({ cwd: '/already/set' });
    mockPanelManager.getPanel.mockReturnValue(panel);

    await invoke(handlers, 'panels:initialize', 'panel-terminal-1', { cwd: '/from-options' });

    // initializeTerminal must be called with the persisted cwd
    expect(mockTerminalPanelManager.initializeTerminal).toHaveBeenCalledOnce();
    expect(mockTerminalPanelManager.initializeTerminal).toHaveBeenCalledWith(
      panel,
      '/already/set',
    );

    // updatePanel must NOT have been called with a cwd change to '/from-options'
    // (it may have been called zero times, or only for hasBeenViewed — but NOT
    // with a customState.cwd that overrides the existing '/already/set').
    const cwdOverrideCall = mockPanelManager.updatePanel.mock.calls.find(
      (call) => {
        const updates = call[1] as { state?: { customState?: { cwd?: string } } } | undefined;
        return updates?.state?.customState?.cwd === '/from-options';
      },
    );
    expect(cwdOverrideCall).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Case B: options.cwd is persisted before initializeTerminal when customState
  //         has no cwd
  // -------------------------------------------------------------------------
  it('Case B: options.cwd is persisted into customState.cwd before PTY spawn', async () => {
    const panel = makeTerminalPanel({}); // no cwd in customState
    mockPanelManager.getPanel.mockReturnValue(panel);

    await invoke(handlers, 'panels:initialize', 'panel-terminal-1', { cwd: '/from-options' });

    // initializeTerminal must be called with the options cwd
    expect(mockTerminalPanelManager.initializeTerminal).toHaveBeenCalledOnce();
    expect(mockTerminalPanelManager.initializeTerminal).toHaveBeenCalledWith(
      panel,
      '/from-options',
    );

    // updatePanel must have been called with state.customState.cwd === '/from-options'
    const updateCallWithCwd = mockPanelManager.updatePanel.mock.calls.find(
      (call) => {
        const updates = call[1] as { state?: { customState?: { cwd?: string } } } | undefined;
        return updates?.state?.customState?.cwd === '/from-options';
      },
    );
    expect(updateCallWithCwd).toBeDefined();

    // updatePanel (with the cwd) must happen BEFORE initializeTerminal.
    const updateCwdCallIndex = mockPanelManager.updatePanel.mock.calls.indexOf(updateCallWithCwd!);
    const updateCwdOrder =
      mockPanelManager.updatePanel.mock.invocationCallOrder[updateCwdCallIndex];
    const initOrder = mockTerminalPanelManager.initializeTerminal.mock.invocationCallOrder[0];
    expect(updateCwdOrder).toBeLessThan(initOrder);
  });

  // -------------------------------------------------------------------------
  // Case C: process.cwd() fallback when both customState.cwd and options.cwd
  //         are absent
  // -------------------------------------------------------------------------
  it('Case C: falls back to process.cwd() when neither customState.cwd nor options.cwd is set', async () => {
    const panel = makeTerminalPanel({}); // no cwd
    mockPanelManager.getPanel.mockReturnValue(panel);

    await invoke(handlers, 'panels:initialize', 'panel-terminal-1', undefined);

    const expectedCwd = process.cwd();

    expect(mockTerminalPanelManager.initializeTerminal).toHaveBeenCalledOnce();
    expect(mockTerminalPanelManager.initializeTerminal).toHaveBeenCalledWith(
      panel,
      expectedCwd,
    );

    // updatePanel must have been called persisting process.cwd()
    const updateCallWithCwd = mockPanelManager.updatePanel.mock.calls.find(
      (call) => {
        const updates = call[1] as { state?: { customState?: { cwd?: string } } } | undefined;
        return updates?.state?.customState?.cwd === expectedCwd;
      },
    );
    expect(updateCallWithCwd).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Case D: non-terminal panel does NOT trigger initializeTerminal
  // -------------------------------------------------------------------------
  it('Case D: non-terminal (claude) panel does not invoke initializeTerminal', async () => {
    const panel = makeClaudePanel();
    mockPanelManager.getPanel.mockReturnValue(panel);

    await invoke(handlers, 'panels:initialize', 'panel-claude-1', { cwd: '/foo' });

    expect(mockTerminalPanelManager.initializeTerminal).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Case E: customState.cwd === "" (empty string) is treated as unset —
  //         the hasCwdString guard requires length > 0, so empty string must
  //         fall through to options.cwd, not suppress it.
  // -------------------------------------------------------------------------
  it('Case E: empty-string customState.cwd is treated as unset and options.cwd is used instead', async () => {
    const panel = makeTerminalPanel({ cwd: '' }); // empty string — should NOT win
    mockPanelManager.getPanel.mockReturnValue(panel);

    await invoke(handlers, 'panels:initialize', 'panel-terminal-1', { cwd: '/from-options' });

    // initializeTerminal must receive options.cwd, not the empty string
    expect(mockTerminalPanelManager.initializeTerminal).toHaveBeenCalledOnce();
    expect(mockTerminalPanelManager.initializeTerminal).toHaveBeenCalledWith(
      panel,
      '/from-options',
    );

    // updatePanel must have been called to persist options.cwd (empty string is
    // not a valid cwd, so the guard must have treated it as absent)
    const updateCallWithCwd = mockPanelManager.updatePanel.mock.calls.find(
      (call) => {
        const updates = call[1] as { state?: { customState?: { cwd?: string } } } | undefined;
        return updates?.state?.customState?.cwd === '/from-options';
      },
    );
    expect(updateCallWithCwd).toBeDefined();
  });
});
