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
 *   (a) autoCreatePermanentPanels: false — does NOT call panelApi.createPanel for dashboard/setup-tasks.
 *   (b) autoCreatePermanentPanels: true  — creates both permanent panels when absent, then reloads.
 *   (c) autoCreatePermanentPanels: true  — short-circuits handlePanelClose for a dashboard panel.
 *   (d) autoCreatePermanentPanels: false — allows handlePanelClose to delete any panel.
 *   (e) onPanelCreated event with matching sessionId → addPanel called; non-matching → ignored.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { usePanelSurface } from '../usePanelSurface';
import type { ToolPanel } from '../../../../shared/types/panels';

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
  mockCreatePanel,
  mockSetActivePanel,
  mockLoadPanelsForSession,
  mockGetActivePanel,
  mockDeletePanel,
  mockGetOrCreateMainRepoSession,
  mockSetActiveSessionStore,
  mockSessionStoreSubscribe,
} = vi.hoisted(() => ({
  mockAddPanel: vi.fn(),
  mockSetActivePanelInStore: vi.fn(),
  mockRemovePanel: vi.fn(),
  mockSetPanels: vi.fn(),
  mockGetState: vi.fn(),
  mockCreatePanel: vi.fn(),
  mockSetActivePanel: vi.fn(),
  mockLoadPanelsForSession: vi.fn(),
  mockGetActivePanel: vi.fn(),
  mockDeletePanel: vi.fn(),
  mockGetOrCreateMainRepoSession: vi.fn(),
  mockSetActiveSessionStore: vi.fn(),
  // Mutable subscribe spy — tests that need to capture the subscriber can
  // configure this via mockSessionStoreSubscribe.mockImplementation(...).
  mockSessionStoreSubscribe: vi.fn((_cb: (state: unknown) => void) => () => undefined),
}));

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
    createPanel: mockCreatePanel,
    setActivePanel: mockSetActivePanel,
    loadPanelsForSession: mockLoadPanelsForSession,
    getActivePanel: mockGetActivePanel,
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

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      setActiveSession: mockSetActiveSessionStore,
      sessions: [],
    }),
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

const DASHBOARD_PANEL: ToolPanel = {
  id: 'panel-dash',
  sessionId: MOCK_SESSION_ID,
  type: 'dashboard',
  title: 'Dashboard',
  state: { isActive: true },
  metadata: { ...MOCK_METADATA, permanent: true },
};

const SETUP_PANEL: ToolPanel = {
  id: 'panel-setup',
  sessionId: MOCK_SESSION_ID,
  type: 'setup-tasks',
  title: 'Setup',
  state: { isActive: false },
  metadata: { ...MOCK_METADATA, permanent: true },
};

const TERMINAL_PANEL: ToolPanel = {
  id: 'panel-terminal',
  sessionId: MOCK_SESSION_ID,
  type: 'terminal',
  title: 'Terminal',
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
// (a) autoCreatePermanentPanels: false — no dashboard/setup-tasks creation
// ---------------------------------------------------------------------------

describe('usePanelSurface — autoCreatePermanentPanels: false', () => {
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

  it('(a) does NOT call panelApi.createPanel for dashboard or setup-tasks', async () => {
    renderHook(() => usePanelSurface(1, { autoCreatePermanentPanels: false }));
    await flushAsync();

    expect(mockCreatePanel).not.toHaveBeenCalled();
  });

  it('calls panelApi.loadPanelsForSession once (no reload)', async () => {
    renderHook(() => usePanelSurface(1, { autoCreatePermanentPanels: false }));
    await flushAsync();

    expect(mockLoadPanelsForSession).toHaveBeenCalledTimes(1);
    expect(mockLoadPanelsForSession).toHaveBeenCalledWith(MOCK_SESSION_ID);
  });

  it('calls setPanels with the loaded panels', async () => {
    renderHook(() => usePanelSurface(1, { autoCreatePermanentPanels: false }));
    await flushAsync();

    expect(mockSetPanels).toHaveBeenCalledWith(MOCK_SESSION_ID, [TERMINAL_PANEL]);
  });
});

// ---------------------------------------------------------------------------
// (b) autoCreatePermanentPanels: true — creates both permanent panels when absent
// ---------------------------------------------------------------------------

describe('usePanelSurface — autoCreatePermanentPanels: true — panels absent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrCreateMainRepoSession.mockResolvedValue({
      success: true,
      data: MOCK_SESSION,
    });
    mockSetActiveSessionStore.mockResolvedValue(undefined);
    // First load returns no panels (absent); second load (after creation) returns both.
    mockLoadPanelsForSession
      .mockResolvedValueOnce([])                              // initial load
      .mockResolvedValueOnce([DASHBOARD_PANEL, SETUP_PANEL]); // reload after creation
    mockCreatePanel.mockResolvedValue(DASHBOARD_PANEL);
    mockGetActivePanel.mockResolvedValue(null); // no active panel initially
    mockSetActivePanel.mockResolvedValue(undefined);
    mockSetPanels.mockReturnValue(undefined);
    mockSetActivePanelInStore.mockReturnValue(undefined);
  });

  it('(b) calls panelApi.createPanel for both dashboard and setup-tasks', async () => {
    renderHook(() => usePanelSurface(1, { autoCreatePermanentPanels: true }));
    await flushAsync();

    const createCalls = mockCreatePanel.mock.calls;
    const types = createCalls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain('dashboard');
    expect(types).toContain('setup-tasks');
  });

  it('(b) reloads panels after creation', async () => {
    renderHook(() => usePanelSurface(1, { autoCreatePermanentPanels: true }));
    await flushAsync();

    // loadPanelsForSession called twice: initial + reload after creation.
    expect(mockLoadPanelsForSession).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// (b) autoCreatePermanentPanels: true — panels already present (no creation)
// ---------------------------------------------------------------------------

describe('usePanelSurface — autoCreatePermanentPanels: true — panels present', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrCreateMainRepoSession.mockResolvedValue({
      success: true,
      data: MOCK_SESSION,
    });
    mockSetActiveSessionStore.mockResolvedValue(undefined);
    // Both panels already exist — no reload needed.
    mockLoadPanelsForSession.mockResolvedValue([DASHBOARD_PANEL, SETUP_PANEL]);
    mockGetActivePanel.mockResolvedValue(DASHBOARD_PANEL);
    mockSetPanels.mockReturnValue(undefined);
    mockSetActivePanelInStore.mockReturnValue(undefined);
  });

  it('does NOT call panelApi.createPanel when both permanent panels exist', async () => {
    renderHook(() => usePanelSurface(1, { autoCreatePermanentPanels: true }));
    await flushAsync();

    expect(mockCreatePanel).not.toHaveBeenCalled();
  });

  it('loads panels exactly once when no creation is needed', async () => {
    renderHook(() => usePanelSurface(1, { autoCreatePermanentPanels: true }));
    await flushAsync();

    expect(mockLoadPanelsForSession).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// (c) handlePanelClose — permanent panel guard (autoCreatePermanentPanels: true)
// ---------------------------------------------------------------------------

describe('usePanelSurface — handlePanelClose — permanent panel guard', () => {
  const panelsMap = { [MOCK_SESSION_ID]: [DASHBOARD_PANEL, SETUP_PANEL, TERMINAL_PANEL] };
  const activePanelsMap = { [MOCK_SESSION_ID]: DASHBOARD_PANEL.id };

  function makePanelStoreMock(panelsOverride = panelsMap, activePanelsOverride = activePanelsMap) {
    return Object.assign(
      () => ({
        panels: panelsOverride,
        activePanels: activePanelsOverride,
        setPanels: mockSetPanels,
        setActivePanel: mockSetActivePanelInStore,
        addPanel: mockAddPanel,
        removePanel: mockRemovePanel,
      }),
      { getState: mockGetState },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrCreateMainRepoSession.mockResolvedValue({
      success: true,
      data: MOCK_SESSION,
    });
    mockSetActiveSessionStore.mockResolvedValue(undefined);
    mockLoadPanelsForSession.mockResolvedValue([DASHBOARD_PANEL, SETUP_PANEL, TERMINAL_PANEL]);
    mockGetActivePanel.mockResolvedValue(DASHBOARD_PANEL);
    mockSetPanels.mockReturnValue(undefined);
    mockSetActivePanelInStore.mockReturnValue(undefined);
    mockDeletePanel.mockResolvedValue(undefined);
    mockSetActivePanel.mockResolvedValue(undefined);
    mockRemovePanel.mockReturnValue(undefined);
  });

  it('(c) short-circuits when trying to close a dashboard panel', async () => {
    vi.doMock('../../stores/panelStore', () => ({
      usePanelStore: makePanelStoreMock(),
    }));

    const { usePanelSurface: surf } = await import('../usePanelSurface');
    const { result } = renderHook(() => surf(1, { autoCreatePermanentPanels: true }));
    await flushAsync();

    await act(async () => { await result.current.handlePanelClose(DASHBOARD_PANEL); });

    expect(mockDeletePanel).not.toHaveBeenCalled();
    expect(mockRemovePanel).not.toHaveBeenCalled();

    vi.doUnmock('../../stores/panelStore');
  });

  it('(c) short-circuits when trying to close a setup-tasks panel', async () => {
    vi.doMock('../../stores/panelStore', () => ({
      usePanelStore: makePanelStoreMock(),
    }));

    const { usePanelSurface: surf } = await import('../usePanelSurface');
    const { result } = renderHook(() => surf(1, { autoCreatePermanentPanels: true }));
    await flushAsync();

    await act(async () => { await result.current.handlePanelClose(SETUP_PANEL); });

    expect(mockDeletePanel).not.toHaveBeenCalled();
    expect(mockRemovePanel).not.toHaveBeenCalled();

    vi.doUnmock('../../stores/panelStore');
  });
});

// ---------------------------------------------------------------------------
// (d) handlePanelClose — no guard (autoCreatePermanentPanels: false)
// ---------------------------------------------------------------------------

describe('usePanelSurface — handlePanelClose — no permanence guard', () => {
  const panelsMap = { [MOCK_SESSION_ID]: [DASHBOARD_PANEL] };
  const activePanelsMap = { [MOCK_SESSION_ID]: DASHBOARD_PANEL.id };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrCreateMainRepoSession.mockResolvedValue({
      success: true,
      data: MOCK_SESSION,
    });
    mockSetActiveSessionStore.mockResolvedValue(undefined);
    mockLoadPanelsForSession.mockResolvedValue([DASHBOARD_PANEL]);
    mockSetPanels.mockReturnValue(undefined);
    mockDeletePanel.mockResolvedValue(undefined);
    mockRemovePanel.mockReturnValue(undefined);
    mockSetActivePanel.mockResolvedValue(undefined);
    mockSetActivePanelInStore.mockReturnValue(undefined);
  });

  it('(d) allows closing a dashboard panel (no guard) and calls deletePanel', async () => {
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
    const { result } = renderHook(() => surf(1, { autoCreatePermanentPanels: false }));
    await flushAsync();

    await act(async () => { await result.current.handlePanelClose(DASHBOARD_PANEL); });

    // No guard in false mode — deletePanel MUST be called.
    expect(mockDeletePanel).toHaveBeenCalledWith(DASHBOARD_PANEL.id);
    expect(mockRemovePanel).toHaveBeenCalledWith(MOCK_SESSION_ID, DASHBOARD_PANEL.id);

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
    renderHook(() => usePanelSurface(1, { autoCreatePermanentPanels: false }));
    await flushAsync();

    expect(capturedHandler).not.toBeNull();

    act(() => { capturedHandler!(TERMINAL_PANEL); });

    expect(mockAddPanel).toHaveBeenCalledWith(TERMINAL_PANEL);
  });

  it('(e) does NOT call addPanel when a panel:created event is for a different session', async () => {
    renderHook(() => usePanelSurface(1, { autoCreatePermanentPanels: false }));
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
    const { unmount } = renderHook(() =>
      usePanelSurface(1, { autoCreatePermanentPanels: false }),
    );
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
    const { result } = renderHook(() =>
      usePanelSurface(1, { autoCreatePermanentPanels: false }),
    );
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
    const { result } = renderHook(() =>
      usePanelSurface(1, { autoCreatePermanentPanels: false }),
    );
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
    const { unmount } = renderHook(() =>
      usePanelSurface(1, { autoCreatePermanentPanels: false }),
    );
    await flushAsync();

    unmount();

    expect(mockStoreUnsubscribe).toHaveBeenCalled();
  });
});
