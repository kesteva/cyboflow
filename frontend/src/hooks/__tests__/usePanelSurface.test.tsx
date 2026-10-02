/**
 * Unit tests for usePanelSurface.
 *
 * Uses @testing-library/react's renderHook + act to exercise the hook
 * in a jsdom environment. panelApi, usePanelStore, and API are mocked so
 * no real Electron IPC or Zustand state is required.
 *
 * Environment: jsdom (via vitest.config.ts).
 *
 * Coverage:
 *   (a) loads the main-repo session's panels once and hands them to setPanels.
 *   (d) handlePanelClose removes and deletes the panel.
 *   (e) onPanelCreated event with matching sessionId → addPanel called; non-matching → ignored.
 *   (f) handlePanelClose on a claude panel evicts the keep-alive xterm cache by
 *       BOTH the closing panel's own id (the cache key for a Claude 'interactive'
 *       substrate panel, TASK-103 Add-chat) and the session's chatRunId (the
 *       cache key for a codex-pty panel) — not the session's flow runId, which
 *       was never the cache key for either (a pre-existing bug this locks in
 *       the fix for).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { usePanelSurface } from '../usePanelSurface';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { Session } from '../../types/session';

// ---------------------------------------------------------------------------
// Mocks
// vi.mock is hoisted to the top — use vi.hoisted() to lift mutable refs safely.
// ---------------------------------------------------------------------------

const {
  mockAddPanel,
  mockSetActivePanelInStore,
  mockRemovePanel,
  mockSetPanels,
  mockGetState,
  mockSetActivePanel,
  mockLoadPanelsForSession,
  mockDeletePanel,
  mockGetOrCreateMainRepoSession,
  mockSetActiveSessionStore,
  mockSessionStoreSubscribe,
  mockDisposeInteractiveTerminal,
  mockSessionStoreGetState,
} = vi.hoisted(() => {
  const setActiveSessionStore = vi.fn();
  return {
    mockAddPanel: vi.fn(),
    mockSetActivePanelInStore: vi.fn(),
    mockRemovePanel: vi.fn(),
    mockSetPanels: vi.fn(),
    mockGetState: vi.fn(),
    mockSetActivePanel: vi.fn(),
    mockLoadPanelsForSession: vi.fn(),
    mockDeletePanel: vi.fn(),
    mockGetOrCreateMainRepoSession: vi.fn(),
    mockSetActiveSessionStore: setActiveSessionStore,
    mockDisposeInteractiveTerminal: vi.fn(),
    // Mutable subscribe spy — tests that need to capture the subscriber can
    // configure this via mockSessionStoreSubscribe.mockImplementation(...).
    mockSessionStoreSubscribe: vi.fn((_cb: (state: unknown) => void) => () => undefined),
    // A hoisted spy (not a fixed closure) so a single test can override the
    // returned `sessions` array via mockReturnValueOnce — usePanelSurface.ts is
    // imported statically at this file's top, so a later vi.doMock() of this
    // module does NOT re-link that already-loaded module's binding (verified:
    // it silently no-ops, unlike vi.doMock('../../stores/panelStore', ...)
    // elsewhere in this file, which only "works" because its overridden
    // closures happen to funnel through the SAME vi.hoisted() spies either way).
    mockSessionStoreGetState: vi.fn(() => ({ setActiveSession: setActiveSessionStore, sessions: [] as Session[] })),
  };
});

// Mock usePanelStore — needs both hook form and .getState static on the export.
vi.mock('../../stores/panelStore', () => ({
  usePanelStore: Object.assign(
    () => ({
      panels: {},
      activePanels: {},
      setPanels: mockSetPanels,
      setActivePanel: mockSetActivePanelInStore,
      addPanel: mockAddPanel,
      removePanel: mockRemovePanel,
    }),
    { getState: mockGetState },
  ),
}));

vi.mock('../../services/panelApi', () => ({
  panelApi: {
    setActivePanel: mockSetActivePanel,
    loadPanelsForSession: mockLoadPanelsForSession,
    deletePanel: mockDeletePanel,
  },
}));

vi.mock('../../utils/api', () => ({
  API: {
    sessions: {
      getOrCreateMainRepoSession: mockGetOrCreateMainRepoSession,
    },
  },
}));

vi.mock('../../components/cyboflow/InteractiveTerminalView', () => ({
  disposeInteractiveTerminal: mockDisposeInteractiveTerminal,
}));

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: {
    getState: mockSessionStoreGetState,
    subscribe: mockSessionStoreSubscribe,
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_SESSION_ID = 'session-abc';
const MOCK_SESSION = {
  id: MOCK_SESSION_ID,
  name: 'main-repo',
  isMainRepo: true,
  worktreePath: '/path/to/project',
  prompt: '',
  status: 'ready' as const,
  createdAt: '2026-01-01T00:00:00Z',
  output: [],
  jsonMessages: [],
};

const MOCK_METADATA = {
  createdAt: '2026-01-01T00:00:00Z',
  lastActiveAt: '2026-01-01T00:00:00Z',
  position: 0,
};

const TERMINAL_PANEL: ToolPanel = {
  id: 'panel-terminal',
  sessionId: MOCK_SESSION_ID,
  type: 'terminal',
  title: 'Terminal',
  state: { isActive: false },
  metadata: { ...MOCK_METADATA },
};

const CLAUDE_PANEL: ToolPanel = {
  id: 'panel-claude-added',
  sessionId: MOCK_SESSION_ID,
  type: 'claude',
  title: 'Chat 2',
  state: { isActive: false },
  metadata: { ...MOCK_METADATA },
};

// Helper: wait for multiple microtask ticks.
async function flushAsync(ticks = 10) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => { await Promise.resolve(); });
  }
}

// ---------------------------------------------------------------------------
// (a) panel loading
// ---------------------------------------------------------------------------

describe('usePanelSurface — panel loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrCreateMainRepoSession.mockResolvedValue({
      success: true,
      data: MOCK_SESSION,
    });
    mockSetActiveSessionStore.mockResolvedValue(undefined);
    mockLoadPanelsForSession.mockResolvedValue([TERMINAL_PANEL]);
    mockSetPanels.mockReturnValue(undefined);
  });

  it('calls panelApi.loadPanelsForSession once (no reload)', async () => {
    renderHook(() => usePanelSurface(1));
    await flushAsync();

    expect(mockLoadPanelsForSession).toHaveBeenCalledTimes(1);
    expect(mockLoadPanelsForSession).toHaveBeenCalledWith(MOCK_SESSION_ID);
  });

  it('calls setPanels with the loaded panels', async () => {
    renderHook(() => usePanelSurface(1));
    await flushAsync();

    expect(mockSetPanels).toHaveBeenCalledWith(MOCK_SESSION_ID, [TERMINAL_PANEL]);
  });
});

// ---------------------------------------------------------------------------
// (d) handlePanelClose — deletes the panel
// ---------------------------------------------------------------------------

describe('usePanelSurface — handlePanelClose', () => {
  const panelsMap = { [MOCK_SESSION_ID]: [TERMINAL_PANEL] };
  const activePanelsMap = { [MOCK_SESSION_ID]: TERMINAL_PANEL.id };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrCreateMainRepoSession.mockResolvedValue({
      success: true,
      data: MOCK_SESSION,
    });
    mockSetActiveSessionStore.mockResolvedValue(undefined);
    mockLoadPanelsForSession.mockResolvedValue([TERMINAL_PANEL]);
    mockSetPanels.mockReturnValue(undefined);
    mockDeletePanel.mockResolvedValue(undefined);
    mockRemovePanel.mockReturnValue(undefined);
    mockSetActivePanel.mockResolvedValue(undefined);
    mockSetActivePanelInStore.mockReturnValue(undefined);
  });

  it('(d) removes the panel from the store and calls deletePanel', async () => {
    vi.doMock('../../stores/panelStore', () => ({
      usePanelStore: Object.assign(
        () => ({
          panels: panelsMap,
          activePanels: activePanelsMap,
          setPanels: mockSetPanels,
          setActivePanel: mockSetActivePanelInStore,
          addPanel: mockAddPanel,
          removePanel: mockRemovePanel,
        }),
        { getState: mockGetState },
      ),
    }));

    const { usePanelSurface: surf } = await import('../usePanelSurface');
    const { result } = renderHook(() => surf(1));
    await flushAsync();

    await act(async () => { await result.current.handlePanelClose(TERMINAL_PANEL); });

    expect(mockDeletePanel).toHaveBeenCalledWith(TERMINAL_PANEL.id);
    expect(mockRemovePanel).toHaveBeenCalledWith(MOCK_SESSION_ID, TERMINAL_PANEL.id);

    vi.doUnmock('../../stores/panelStore');
  });
});

// ---------------------------------------------------------------------------
// (f) handlePanelClose — claude panel evicts the keep-alive xterm cache
// ---------------------------------------------------------------------------

describe('usePanelSurface — handlePanelClose — claude panel xterm cache eviction', () => {
  const panelsMap = { [MOCK_SESSION_ID]: [CLAUDE_PANEL] };
  const activePanelsMap = { [MOCK_SESSION_ID]: CLAUDE_PANEL.id };
  const SESSION_WITH_CHAT_RUN_ID = { ...MOCK_SESSION, runId: 'flow-run-xyz', chatRunId: 'chat-run-abc' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrCreateMainRepoSession.mockResolvedValue({
      success: true,
      data: MOCK_SESSION,
    });
    mockSetActiveSessionStore.mockResolvedValue(undefined);
    mockLoadPanelsForSession.mockResolvedValue([CLAUDE_PANEL]);
    mockSetPanels.mockReturnValue(undefined);
    mockDeletePanel.mockResolvedValue(undefined);
    mockRemovePanel.mockReturnValue(undefined);
    mockSetActivePanel.mockResolvedValue(undefined);
    mockSetActivePanelInStore.mockReturnValue(undefined);
  });

  it("(f) disposes by the panel's OWN id and the session's chatRunId — NEVER the session's (distinct) flow runId", async () => {
    vi.doMock('../../stores/panelStore', () => ({
      usePanelStore: Object.assign(
        () => ({
          panels: panelsMap,
          activePanels: activePanelsMap,
          setPanels: mockSetPanels,
          setActivePanel: mockSetActivePanelInStore,
          addPanel: mockAddPanel,
          removePanel: mockRemovePanel,
        }),
        { getState: mockGetState },
      ),
    }));
    // usePanelSurface.ts is statically imported at this file's top, so this
    // module's sessionStore binding is already linked — override the SPY's
    // return value (persists across every getState() call in this test)
    // rather than vi.doMock()'ing the module, which does not re-link an
    // already-loaded module (see the mockSessionStoreGetState hoisted comment).
    mockSessionStoreGetState.mockReturnValue({
      setActiveSession: mockSetActiveSessionStore,
      sessions: [SESSION_WITH_CHAT_RUN_ID],
    });

    const { usePanelSurface: surf } = await import('../usePanelSurface');
    const { result } = renderHook(() => surf(1));
    await flushAsync();

    await act(async () => { await result.current.handlePanelClose(CLAUDE_PANEL); });

    expect(mockDisposeInteractiveTerminal).toHaveBeenCalledWith(CLAUDE_PANEL.id);
    expect(mockDisposeInteractiveTerminal).toHaveBeenCalledWith(SESSION_WITH_CHAT_RUN_ID.chatRunId);
    expect(mockDisposeInteractiveTerminal).not.toHaveBeenCalledWith(SESSION_WITH_CHAT_RUN_ID.runId);

    vi.doUnmock('../../stores/panelStore');
  });

  it('(f) does not dispose anything for a non-claude panel close', async () => {
    const terminalPanelsMap = { [MOCK_SESSION_ID]: [TERMINAL_PANEL] };
    vi.doMock('../../stores/panelStore', () => ({
      usePanelStore: Object.assign(
        () => ({
          panels: terminalPanelsMap,
          activePanels: { [MOCK_SESSION_ID]: TERMINAL_PANEL.id },
          setPanels: mockSetPanels,
          setActivePanel: mockSetActivePanelInStore,
          addPanel: mockAddPanel,
          removePanel: mockRemovePanel,
        }),
        { getState: mockGetState },
      ),
    }));

    const { usePanelSurface: surf } = await import('../usePanelSurface');
    const { result } = renderHook(() => surf(1));
    await flushAsync();

    await act(async () => { await result.current.handlePanelClose(TERMINAL_PANEL); });

    expect(mockDisposeInteractiveTerminal).not.toHaveBeenCalled();

    vi.doUnmock('../../stores/panelStore');
  });
});

// ---------------------------------------------------------------------------
// (e) onPanelCreated subscription
// ---------------------------------------------------------------------------

describe('usePanelSurface — onPanelCreated subscription', () => {
  let capturedHandler: ((panel: ToolPanel) => void) | null = null;
  const mockUnsubscribe = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandler = null;

    mockGetOrCreateMainRepoSession.mockResolvedValue({
      success: true,
      data: MOCK_SESSION,
    });
    mockSetActiveSessionStore.mockResolvedValue(undefined);
    mockLoadPanelsForSession.mockResolvedValue([]);
    mockSetPanels.mockReturnValue(undefined);
    mockAddPanel.mockReturnValue(undefined);

    // Set up window.electronAPI.events.onPanelCreated to capture the handler.
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: {
        events: {
          onPanelCreated: (handler: (panel: ToolPanel) => void) => {
            capturedHandler = handler;
            return mockUnsubscribe;
          },
        },
      },
    });
  });

  it('(e) calls addPanel when a panel:created event matches the session', async () => {
    renderHook(() => usePanelSurface(1));
    await flushAsync();

    expect(capturedHandler).not.toBeNull();

    act(() => { capturedHandler!(TERMINAL_PANEL); });

    expect(mockAddPanel).toHaveBeenCalledWith(TERMINAL_PANEL);
  });

  it('(e) does NOT call addPanel when a panel:created event is for a different session', async () => {
    renderHook(() => usePanelSurface(1));
    await flushAsync();

    expect(capturedHandler).not.toBeNull();

    const otherSessionPanel: ToolPanel = {
      ...TERMINAL_PANEL,
      sessionId: 'other-session-xyz',
    };

    act(() => { capturedHandler!(otherSessionPanel); });

    expect(mockAddPanel).not.toHaveBeenCalled();
  });

  it('(e) calls the unsubscribe function returned by onPanelCreated on cleanup', async () => {
    const { unmount } = renderHook(() => usePanelSurface(1));
    await flushAsync();

    unmount();

    expect(mockUnsubscribe).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// useSessionStore.subscribe — in-hook subscriber keeps mainRepoSession in sync
// with IPC-driven session updates (e.g. session-updated event from backend).
// ---------------------------------------------------------------------------

describe('usePanelSurface — useSessionStore.subscribe syncs mainRepoSession', () => {
  // We'll capture the subscriber the hook registers so we can fire it manually.
  type StoreState = { sessions: typeof MOCK_SESSION[] };
  let capturedSubscriber: ((state: StoreState) => void) | null = null;
  const mockStoreUnsubscribe = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    capturedSubscriber = null;

    // Configure subscribe to capture the callback and return an unsubscribe spy.
    mockSessionStoreSubscribe.mockImplementation(
      (cb: (state: StoreState) => void) => {
        capturedSubscriber = cb;
        return mockStoreUnsubscribe;
      },
    );

    mockGetOrCreateMainRepoSession.mockResolvedValue({
      success: true,
      data: MOCK_SESSION,
    });
    mockSetActiveSessionStore.mockResolvedValue(undefined);
    mockLoadPanelsForSession.mockResolvedValue([]);
    mockSetPanels.mockReturnValue(undefined);
  });

  it('updates mainRepoSession when the subscriber fires with an updated session', async () => {
    const { result } = renderHook(() => usePanelSurface(1));
    await flushAsync();

    // Confirm the hook resolved its initial session.
    expect(result.current.mainRepoSession).toEqual(MOCK_SESSION);
    // Confirm the hook registered a subscriber.
    expect(capturedSubscriber).not.toBeNull();

    // Simulate a backend-driven session update (e.g. name changed).
    const UPDATED_SESSION = { ...MOCK_SESSION, name: 'main-repo-updated' };
    act(() => {
      capturedSubscriber!({ sessions: [UPDATED_SESSION] });
    });

    // The hook should reflect the updated session.
    expect(result.current.mainRepoSession).toEqual(UPDATED_SESSION);
  });

  it('does NOT update mainRepoSession when the subscriber fires for a different session', async () => {
    const { result } = renderHook(() => usePanelSurface(1));
    await flushAsync();

    expect(capturedSubscriber).not.toBeNull();

    const OTHER_SESSION = { ...MOCK_SESSION, id: 'other-session-xyz', name: 'other' };
    act(() => {
      capturedSubscriber!({ sessions: [OTHER_SESSION] });
    });

    // The hook's mainRepoSession should remain the original.
    expect(result.current.mainRepoSession).toEqual(MOCK_SESSION);
  });

  it('unsubscribes from sessionStore when the hook unmounts', async () => {
    const { unmount } = renderHook(() => usePanelSurface(1));
    await flushAsync();

    unmount();

    expect(mockStoreUnsubscribe).toHaveBeenCalled();
  });

  it('does NOT call getOrCreateMainRepoSession when projectId is null', async () => {
    renderHook(() => usePanelSurface(null));
    await flushAsync();

    expect(mockGetOrCreateMainRepoSession).not.toHaveBeenCalled();
  });
});
