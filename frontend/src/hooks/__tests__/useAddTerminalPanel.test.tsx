/**
 * Unit tests for useAddTerminalPanel.
 *
 * Uses @testing-library/react's renderHook + act to exercise the hook
 * in a jsdom environment. panelApi and usePanelStore are mocked so
 * no real Electron IPC or Zustand state is required.
 *
 * Environment: jsdom (via vitest.config.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useAddTerminalPanel } from '../useAddTerminalPanel';

// ---------------------------------------------------------------------------
// Mocks
// vi.mock is hoisted to the top — use vi.hoisted() to lift mutable refs safely.
// ---------------------------------------------------------------------------

const { mockAddPanel, mockSetActivePanelInStore, mockCreatePanel, mockSetActivePanel } = vi.hoisted(() => ({
  mockAddPanel: vi.fn(),
  mockSetActivePanelInStore: vi.fn(),
  mockCreatePanel: vi.fn(),
  mockSetActivePanel: vi.fn(),
}));

vi.mock('../../stores/panelStore', () => ({
  usePanelStore: () => ({
    addPanel: mockAddPanel,
    setActivePanel: mockSetActivePanelInStore,
  }),
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
  type: 'terminal' as const,
  title: 'Terminal',
  state: { isActive: true },
};

const MOCK_SESSION = {
  id: 's1',
  worktreePath: '/path/to/worktree',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAddTerminalPanel — happy path with onAfterActivate (RunView pattern)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreatePanel.mockResolvedValue(MOCK_PANEL);
    mockSetActivePanel.mockResolvedValue(undefined);
  });

  it('calls panelApi.createPanel with the correct shape', async () => {
    const { result } = renderHook(() =>
      useAddTerminalPanel(MOCK_SESSION, { logTag: 'RunView' })
    );
    await act(async () => { await result.current(); });

    expect(mockCreatePanel).toHaveBeenCalledTimes(1);
    expect(mockCreatePanel).toHaveBeenCalledWith({
      sessionId: 's1',
      type: 'terminal',
      title: 'Terminal',
      initialState: { cwd: '/path/to/worktree' },
    });
  });

  it('calls addPanel with the returned panel', async () => {
    const { result } = renderHook(() =>
      useAddTerminalPanel(MOCK_SESSION, { logTag: 'RunView' })
    );
    await act(async () => { await result.current(); });

    expect(mockAddPanel).toHaveBeenCalledTimes(1);
    expect(mockAddPanel).toHaveBeenCalledWith(MOCK_PANEL);
  });

  it('calls setActivePanelInStore with sessionId and panelId', async () => {
    const { result } = renderHook(() =>
      useAddTerminalPanel(MOCK_SESSION, { logTag: 'RunView' })
    );
    await act(async () => { await result.current(); });

    expect(mockSetActivePanelInStore).toHaveBeenCalledTimes(1);
    expect(mockSetActivePanelInStore).toHaveBeenCalledWith('s1', 'panel-1');
  });

  it('calls panelApi.setActivePanel with sessionId and panelId', async () => {
    const { result } = renderHook(() =>
      useAddTerminalPanel(MOCK_SESSION, { logTag: 'RunView' })
    );
    await act(async () => { await result.current(); });

    expect(mockSetActivePanel).toHaveBeenCalledTimes(1);
    expect(mockSetActivePanel).toHaveBeenCalledWith('s1', 'panel-1');
  });

  it('invokes onAfterActivate with sessionId and panelId when provided', async () => {
    const onAfterActivate = vi.fn();
    const { result } = renderHook(() =>
      useAddTerminalPanel(MOCK_SESSION, { onAfterActivate, logTag: 'RunView' })
    );
    await act(async () => { await result.current(); });

    expect(onAfterActivate).toHaveBeenCalledTimes(1);
    expect(onAfterActivate).toHaveBeenCalledWith('s1', 'panel-1');
  });
});

describe('useAddTerminalPanel — happy path without onAfterActivate (ProjectView pattern)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreatePanel.mockResolvedValue(MOCK_PANEL);
    mockSetActivePanel.mockResolvedValue(undefined);
  });

  it('completes without error when onAfterActivate is omitted', async () => {
    const { result } = renderHook(() =>
      useAddTerminalPanel(MOCK_SESSION, { logTag: 'ProjectView' })
    );
    await expect(act(async () => { await result.current(); })).resolves.toBeUndefined();
  });

  it('still calls createPanel, addPanel, setActivePanelInStore, and setActivePanel', async () => {
    const { result } = renderHook(() =>
      useAddTerminalPanel(MOCK_SESSION, { logTag: 'ProjectView' })
    );
    await act(async () => { await result.current(); });

    expect(mockCreatePanel).toHaveBeenCalledTimes(1);
    expect(mockAddPanel).toHaveBeenCalledTimes(1);
    expect(mockSetActivePanelInStore).toHaveBeenCalledTimes(1);
    expect(mockSetActivePanel).toHaveBeenCalledTimes(1);
  });
});

describe('useAddTerminalPanel — no session guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs a console.warn when session is null and does NOT call panelApi.createPanel', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() =>
      useAddTerminalPanel(null)
    );
    await act(async () => { await result.current(); });

    expect(mockCreatePanel).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('logs a console.warn when session is undefined and does NOT call panelApi.createPanel', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() =>
      useAddTerminalPanel(undefined)
    );
    await act(async () => { await result.current(); });

    expect(mockCreatePanel).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('includes the default logTag in the warning message', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() =>
      useAddTerminalPanel(null)
    );
    await act(async () => { await result.current(); });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[useAddTerminalPanel]')
    );
    warnSpy.mockRestore();
  });

  it('includes the custom logTag in the warning message', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() =>
      useAddTerminalPanel(null, { logTag: 'CustomTag' })
    );
    await act(async () => { await result.current(); });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[CustomTag]')
    );
    warnSpy.mockRestore();
  });
});
