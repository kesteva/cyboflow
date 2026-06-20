/**
 * Regression test for the useIPCEvents → panel:updated wiring.
 *
 * Guards a silent-drop fix: the backend emits `panel:updated` whenever a panel's
 * customState changes (e.g. the SDK context-% meter, refreshed per completed turn
 * via updateClaudePanelCustomState). For a long time this event had NO renderer
 * consumer, so ClaudePanel only re-read panel.state.customState on a panel
 * re-open and the live context meter never ticked. useIPCEvents now forwards the
 * panel to usePanelStore.updatePanelState. If that handler is removed, the live
 * meter silently stops updating again — exactly the regression this test pins.
 *
 * Environment: jsdom (via vitest.config.ts). Stores + API are mocked so no real
 * Electron IPC or Zustand state is required; window.electronAPI.events is faked
 * to capture the registered onPanelUpdated callback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ToolPanel } from '../../../../shared/types/panels';

// ---------------------------------------------------------------------------
// Mocks — vi.mock is hoisted; lift the spies we assert on via vi.hoisted().
// ---------------------------------------------------------------------------
const { mockUpdatePanelState } = vi.hoisted(() => ({
  mockUpdatePanelState: vi.fn(),
}));

vi.mock('../../stores/panelStore', () => ({
  usePanelStore: { getState: () => ({ updatePanelState: mockUpdatePanelState }) },
}));

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    () => ({
      setSessions: vi.fn(),
      loadSessions: vi.fn(),
      addSession: vi.fn(),
      updateSession: vi.fn(),
      deleteSession: vi.fn(),
    }),
    { getState: () => ({ setGitStatusLoading: vi.fn() }) },
  ),
}));

vi.mock('../../stores/errorStore', () => ({
  useErrorStore: () => ({ showError: vi.fn() }),
}));

vi.mock('../../utils/api', () => ({
  API: { sessions: { getAll: vi.fn().mockResolvedValue({ success: true, data: [] }) } },
}));

import { useIPCEvents } from '../useIPCEvents';

// ---------------------------------------------------------------------------
// Fake window.electronAPI.events — every onX returns a noop unsubscribe;
// onPanelUpdated captures its callback so the test can fire it directly.
// ---------------------------------------------------------------------------
let panelUpdatedCb: ((panel: ToolPanel) => void) | undefined;

function makeEvents() {
  const noop = () => () => undefined;
  return {
    onSessionCreated: vi.fn(noop),
    onSessionUpdated: vi.fn(noop),
    onSessionDeleted: vi.fn(noop),
    onSessionsLoaded: vi.fn(noop),
    onPanelUpdated: vi.fn((cb: (panel: ToolPanel) => void) => {
      panelUpdatedCb = cb;
      return () => undefined;
    }),
    onSessionOutput: vi.fn(noop),
    onTerminalOutput: vi.fn(noop),
    onSessionOutputAvailable: vi.fn(noop),
    onZombieProcessesDetected: vi.fn(noop),
    onGitStatusUpdated: vi.fn(noop),
    onGitStatusLoading: vi.fn(noop),
    onGitStatusLoadingBatch: vi.fn(noop),
    onGitStatusUpdatedBatch: vi.fn(noop),
  };
}

const PANEL: ToolPanel = {
  id: 'panel-1',
  sessionId: 's1',
  type: 'claude',
  title: 'Claude',
  state: {
    isActive: true,
    customState: { contextUsage: '128k/200k tokens (64%)' },
  },
  metadata: {
    createdAt: '2026-01-01T00:00:00Z',
    lastActiveAt: '2026-01-01T00:00:00Z',
    position: 0,
  },
};

describe('useIPCEvents — panel:updated → updatePanelState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    panelUpdatedCb = undefined;
    (window as unknown as { electronAPI: { events: ReturnType<typeof makeEvents> } }).electronAPI = {
      events: makeEvents(),
    };
  });

  it('subscribes to panel:updated on mount', () => {
    renderHook(() => useIPCEvents());
    expect(panelUpdatedCb).toBeTypeOf('function');
  });

  it('forwards a panel:updated event to usePanelStore.updatePanelState', () => {
    renderHook(() => useIPCEvents());
    panelUpdatedCb?.(PANEL);
    expect(mockUpdatePanelState).toHaveBeenCalledTimes(1);
    expect(mockUpdatePanelState).toHaveBeenCalledWith(PANEL);
  });

  it('ignores a malformed payload missing id/sessionId (no store write)', () => {
    renderHook(() => useIPCEvents());
    panelUpdatedCb?.({} as unknown as ToolPanel);
    panelUpdatedCb?.({ id: 'x' } as unknown as ToolPanel);
    expect(mockUpdatePanelState).not.toHaveBeenCalled();
  });
});
