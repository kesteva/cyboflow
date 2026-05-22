/**
 * Unit tests for useEnsureClaudePanel.
 *
 * Uses @testing-library/react's renderHook + act to exercise the hook
 * in a jsdom environment. panelApi and usePanelStore are mocked so
 * no real Electron IPC or Zustand state is required.
 *
 * Environment: jsdom (via vitest.config.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useEnsureClaudePanel } from '../useEnsureClaudePanel';

// ---------------------------------------------------------------------------
// Mocks
// vi.mock is hoisted to the top — use vi.hoisted() to lift mutable refs safely.
// ---------------------------------------------------------------------------

const { mockAddPanel, mockSetActivePanelInStore, mockCreatePanel, mockSetActivePanel, mockGetState } = vi.hoisted(() => ({
  mockAddPanel: vi.fn(),
  mockSetActivePanelInStore: vi.fn(),
  mockCreatePanel: vi.fn(),
  mockSetActivePanel: vi.fn(),
  mockGetState: vi.fn(),
}));

vi.mock('../../stores/panelStore', () => ({
  usePanelStore: Object.assign(
    () => ({
      addPanel: mockAddPanel,
      setActivePanel: mockSetActivePanelInStore,
    }),
    {
      getState: mockGetState,
    },
  ),
}));

vi.mock('../../services/panelApi', () => ({
  panelApi: {
    createPanel: mockCreatePanel,
    setActivePanel: mockSetActivePanel,
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_PANEL = {
  id: 'panel-1',
  sessionId: 's1',
  type: 'claude' as const,
  title: 'Claude',
  state: { isActive: true },
};

const MOCK_SESSION = { id: 's1' };

const EXISTING_CLAUDE_PANEL = {
  id: 'existing-1',
  type: 'claude' as const,
  sessionId: 's1',
  title: 'Claude',
  state: { isActive: false },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useEnsureClaudePanel — happy path — no existing Claude panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No panels in the store for this session
    mockGetState.mockReturnValue({ panels: { s1: [] } });
    mockCreatePanel.mockResolvedValue(MOCK_PANEL);
    mockSetActivePanel.mockResolvedValue(undefined);
  });

  it('calls panelApi.createPanel with { sessionId, type: "claude" }', async () => {
    const { result } = renderHook(() =>
      useEnsureClaudePanel(MOCK_SESSION, { logTag: 'TestHook' }),
    );
    await act(async () => {
      await result.current();
    });

    expect(mockCreatePanel).toHaveBeenCalledTimes(1);
    expect(mockCreatePanel).toHaveBeenCalledWith({
      sessionId: 's1',
      type: 'claude',
    });
  });

  it('calls addPanel with the returned panel exactly once', async () => {
    const { result } = renderHook(() =>
      useEnsureClaudePanel(MOCK_SESSION, { logTag: 'TestHook' }),
    );
    await act(async () => {
      await result.current();
    });

    expect(mockAddPanel).toHaveBeenCalledTimes(1);
    expect(mockAddPanel).toHaveBeenCalledWith(MOCK_PANEL);
  });

  it('calls setActivePanelInStore with sessionId and new panelId', async () => {
    const { result } = renderHook(() =>
      useEnsureClaudePanel(MOCK_SESSION, { logTag: 'TestHook' }),
    );
    await act(async () => {
      await result.current();
    });

    expect(mockSetActivePanelInStore).toHaveBeenCalledTimes(1);
    expect(mockSetActivePanelInStore).toHaveBeenCalledWith('s1', 'panel-1');
  });

  it('does NOT call panelApi.setActivePanel in the create branch (backend activation via panel:created event)', async () => {
    const { result } = renderHook(() =>
      useEnsureClaudePanel(MOCK_SESSION, { logTag: 'TestHook' }),
    );
    await act(async () => {
      await result.current();
    });

    expect(mockSetActivePanel).not.toHaveBeenCalled();
  });
});

describe('useEnsureClaudePanel — happy path — existing Claude panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Pre-populate the store with an existing Claude panel
    mockGetState.mockReturnValue({ panels: { s1: [EXISTING_CLAUDE_PANEL] } });
    mockSetActivePanel.mockResolvedValue(undefined);
  });

  it('does NOT call panelApi.createPanel when a Claude panel already exists', async () => {
    const { result } = renderHook(() =>
      useEnsureClaudePanel(MOCK_SESSION),
    );
    await act(async () => {
      await result.current();
    });

    expect(mockCreatePanel).not.toHaveBeenCalled();
  });

  it('calls setActivePanelInStore with the existing panel id', async () => {
    const { result } = renderHook(() =>
      useEnsureClaudePanel(MOCK_SESSION),
    );
    await act(async () => {
      await result.current();
    });

    expect(mockSetActivePanelInStore).toHaveBeenCalledTimes(1);
    expect(mockSetActivePanelInStore).toHaveBeenCalledWith('s1', 'existing-1');
  });

  it('calls panelApi.setActivePanel with the existing panel id', async () => {
    const { result } = renderHook(() =>
      useEnsureClaudePanel(MOCK_SESSION),
    );
    await act(async () => {
      await result.current();
    });

    expect(mockSetActivePanel).toHaveBeenCalledTimes(1);
    expect(mockSetActivePanel).toHaveBeenCalledWith('s1', 'existing-1');
  });

  it('does NOT call addPanel when activating an existing panel', async () => {
    const { result } = renderHook(() =>
      useEnsureClaudePanel(MOCK_SESSION),
    );
    await act(async () => {
      await result.current();
    });

    expect(mockAddPanel).not.toHaveBeenCalled();
  });
});

describe('useEnsureClaudePanel — no-session guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs a console.warn when session is null and does NOT call panelApi.createPanel', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useEnsureClaudePanel(null));
    await act(async () => {
      await result.current();
    });

    expect(mockCreatePanel).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('logs a console.warn when session is undefined and does NOT call panelApi.createPanel', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useEnsureClaudePanel(undefined));
    await act(async () => {
      await result.current();
    });

    expect(mockCreatePanel).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('includes the default [useEnsureClaudePanel] logTag in the warning message', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useEnsureClaudePanel(null));
    await act(async () => {
      await result.current();
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[useEnsureClaudePanel]'),
    );
    warnSpy.mockRestore();
  });

  it('includes a custom logTag in the warning message when provided', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() =>
      useEnsureClaudePanel(null, { logTag: 'CustomTag' }),
    );
    await act(async () => {
      await result.current();
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[CustomTag]'),
    );
    warnSpy.mockRestore();
  });
});
