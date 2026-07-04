/**
 * Unit tests for bootstrapArmSessionPanels.
 *
 * API.sessions.get and panelApi are mocked so no real Electron IPC is required.
 *
 * Behaviors verified:
 *   1. No existing claude panel: creates Claude then Terminal (cwd = worktreePath).
 *   2. An existing claude panel (server-created, e.g. interactive substrate's
 *      eager PTY REPL): SKIPS the manual Claude panel, creates ONLY Terminal.
 *   3. Throws when API.sessions.get fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGet, mockLoadPanelsForSession, mockCreatePanel } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockLoadPanelsForSession: vi.fn(),
  mockCreatePanel: vi.fn(),
}));

vi.mock('../api', () => ({
  API: { sessions: { get: mockGet } },
}));

vi.mock('../../services/panelApi', () => ({
  panelApi: {
    loadPanelsForSession: mockLoadPanelsForSession,
    createPanel: mockCreatePanel,
  },
}));

import { bootstrapArmSessionPanels } from '../bootstrapArmSessionPanels';

beforeEach(() => {
  mockGet.mockReset();
  mockLoadPanelsForSession.mockReset();
  mockCreatePanel.mockReset();

  mockGet.mockResolvedValue({ success: true, data: { worktreePath: '/tmp/arm-a' } });
  mockLoadPanelsForSession.mockResolvedValue([]);
  mockCreatePanel.mockResolvedValue({ id: 'panel-001' });
});

describe('bootstrapArmSessionPanels', () => {
  it('no existing claude panel: creates Claude then Terminal (cwd = worktreePath)', async () => {
    await bootstrapArmSessionPanels('sess-arm-a');

    expect(mockGet).toHaveBeenCalledWith('sess-arm-a');
    expect(mockLoadPanelsForSession).toHaveBeenCalledWith('sess-arm-a');
    expect(mockCreatePanel).toHaveBeenCalledTimes(2);
    expect(mockCreatePanel).toHaveBeenNthCalledWith(1, { sessionId: 'sess-arm-a', type: 'claude' });
    expect(mockCreatePanel).toHaveBeenNthCalledWith(2, {
      sessionId: 'sess-arm-a',
      type: 'terminal',
      title: 'Terminal',
      initialState: { cwd: '/tmp/arm-a' },
    });
  });

  it('existing claude panel (server-created): skips the manual Claude panel, creates only Terminal', async () => {
    mockLoadPanelsForSession.mockResolvedValue([
      { id: 'panel-claude-srv', type: 'claude' },
    ]);

    await bootstrapArmSessionPanels('sess-arm-a');

    expect(mockCreatePanel).toHaveBeenCalledTimes(1);
    expect(mockCreatePanel).toHaveBeenCalledWith({
      sessionId: 'sess-arm-a',
      type: 'terminal',
      title: 'Terminal',
      initialState: { cwd: '/tmp/arm-a' },
    });
    expect(mockCreatePanel).not.toHaveBeenCalledWith({ sessionId: 'sess-arm-a', type: 'claude' });
  });

  it('throws when API.sessions.get fails', async () => {
    mockGet.mockResolvedValue({ success: false, error: 'session vanished' });

    await expect(bootstrapArmSessionPanels('sess-arm-a')).rejects.toThrow('session vanished');
    expect(mockCreatePanel).not.toHaveBeenCalled();
  });
});
