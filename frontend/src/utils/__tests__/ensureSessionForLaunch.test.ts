/**
 * Unit tests for ensureSessionForLaunch.
 *
 * API.sessions.createQuick, panelApi, and the cyboflow store are mocked so no
 * real Electron IPC is required.
 *
 * Behaviors verified:
 *   1. Returns the already-selected session id without creating anything.
 *   2. SDK response (no claudePanelId) → creates Claude + Terminal panels.
 *   3. Interactive response (claudePanelId present, e.g. under the global
 *      PTY-only lock) → SKIPS the manual Claude panel (the server eagerly
 *      created it) and creates ONLY the Terminal panel. This is the regression
 *      guard against the duplicate-Claude-panel bug the lock would otherwise
 *      activate for every workflow launch into a fresh session.
 *   4. Throws when createQuick fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCreateQuick, mockCreatePanel, mockGetState } = vi.hoisted(() => ({
  mockCreateQuick: vi.fn(),
  mockCreatePanel: vi.fn(),
  mockGetState: vi.fn<() => { selectedSessionId: string | null }>(() => ({ selectedSessionId: null })),
}));

vi.mock('../api', () => ({
  API: { sessions: { createQuick: mockCreateQuick } },
}));

vi.mock('../../services/panelApi', () => ({
  panelApi: { createPanel: mockCreatePanel },
}));

vi.mock('../../stores/cyboflowStore', () => ({
  useCyboflowStore: { getState: mockGetState },
}));

import { ensureSessionForLaunch } from '../ensureSessionForLaunch';

beforeEach(() => {
  mockCreateQuick.mockReset();
  mockCreatePanel.mockReset();
  mockGetState.mockReset();

  mockGetState.mockReturnValue({ selectedSessionId: null });
  mockCreatePanel.mockResolvedValue({ id: 'panel-001' });
  // Default: SDK quick session (no eager claude panel).
  mockCreateQuick.mockResolvedValue({
    success: true,
    data: { sessionId: 'sess-new', worktreePath: '/tmp/wt-new' },
  });
});

describe('ensureSessionForLaunch', () => {
  it('returns the already-selected session id without creating anything', async () => {
    mockGetState.mockReturnValue({ selectedSessionId: 'sess-existing' });

    const id = await ensureSessionForLaunch(7);

    expect(id).toBe('sess-existing');
    expect(mockCreateQuick).not.toHaveBeenCalled();
    expect(mockCreatePanel).not.toHaveBeenCalled();
  });

  it('SDK response (no claudePanelId): creates Claude then Terminal panels', async () => {
    const id = await ensureSessionForLaunch(7);

    expect(id).toBe('sess-new');
    expect(mockCreateQuick).toHaveBeenCalledWith({ prompt: '', projectId: 7 });
    expect(mockCreatePanel).toHaveBeenCalledTimes(2);
    expect(mockCreatePanel).toHaveBeenNthCalledWith(1, { sessionId: 'sess-new', type: 'claude' });
    expect(mockCreatePanel).toHaveBeenNthCalledWith(2, {
      sessionId: 'sess-new',
      type: 'terminal',
      title: 'Terminal',
      initialState: { cwd: '/tmp/wt-new' },
    });
  });

  it('interactive response (claudePanelId present): skips the manual Claude panel, creates only Terminal', async () => {
    mockCreateQuick.mockResolvedValue({
      success: true,
      data: { sessionId: 'sess-int', worktreePath: '/tmp/wt-int', claudePanelId: 'panel-claude-srv' },
    });

    const id = await ensureSessionForLaunch(7);

    expect(id).toBe('sess-int');
    expect(mockCreatePanel).toHaveBeenCalledTimes(1);
    expect(mockCreatePanel).toHaveBeenCalledWith({
      sessionId: 'sess-int',
      type: 'terminal',
      title: 'Terminal',
      initialState: { cwd: '/tmp/wt-int' },
    });
    // No second Claude panel — would orphan a process-less Claude tab.
    expect(mockCreatePanel).not.toHaveBeenCalledWith({ sessionId: 'sess-int', type: 'claude' });
  });

  it('throws when createQuick fails', async () => {
    mockCreateQuick.mockResolvedValue({ success: false, error: 'quota exceeded' });

    await expect(ensureSessionForLaunch(7)).rejects.toThrow('quota exceeded');
    expect(mockCreatePanel).not.toHaveBeenCalled();
  });
});
