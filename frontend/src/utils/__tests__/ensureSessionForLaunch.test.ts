/**
 * Unit tests for ensureSessionForLaunch.
 *
 * API.sessions.createQuick, panelApi, and the cyboflow store are mocked so no
 * real Electron IPC is required.
 *
 * Behaviors verified:
 *   1. Returns the already-selected session id without creating anything when
 *      that session is FREE (no active run executing in it).
 *   1b. When the selected session is BUSY (an active run already executes in it),
 *      does NOT reuse it — creates a fresh session instead. Regression guard for
 *      "RunLauncher.launch: session <id> already has a running workflow".
 *   2. SDK response (no claudePanelId) → creates Claude + Terminal panels.
 *   3. Interactive response (claudePanelId present, e.g. under the global
 *      PTY-only lock) → SKIPS the manual Claude panel (the server eagerly
 *      created it) and creates ONLY the Terminal panel. This is the regression
 *      guard against the duplicate-Claude-panel bug the lock would otherwise
 *      activate for every workflow launch into a fresh session.
 *   4. Throws when createQuick fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useActiveRunsStore } from '../../stores/activeRunsStore';
import type { ActiveRunRow } from '../../stores/activeRunsStore';

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

/**
 * Minimal ActiveRunRow factory — only the `session_id` field is read by the
 * busy-session guard; the rest are filled with inert placeholders.
 */
function activeRunRow(sessionId: string): ActiveRunRow {
  return {
    id: `run-${sessionId}`,
    workflow_id: 'wf-7-planner',
    project_id: 7,
    status: 'running',
    session_id: sessionId,
    workflowName: 'planner',
  } as ActiveRunRow;
}

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
  // Default: no active runs anywhere (every session is free).
  useActiveRunsStore.setState({ runsByProject: {} });
});

describe('ensureSessionForLaunch', () => {
  it('returns the already-selected session id without creating anything when it is free', async () => {
    mockGetState.mockReturnValue({ selectedSessionId: 'sess-existing' });
    // Active run lives in a DIFFERENT session, so the selection stays free.
    useActiveRunsStore.setState({ runsByProject: { 7: [activeRunRow('sess-other')] } });

    const id = await ensureSessionForLaunch(7);

    expect(id).toBe('sess-existing');
    expect(mockCreateQuick).not.toHaveBeenCalled();
    expect(mockCreatePanel).not.toHaveBeenCalled();
  });

  it('forceNew: creates a fresh session even when the selected session is FREE', async () => {
    mockGetState.mockReturnValue({ selectedSessionId: 'sess-existing' });
    // Selection is free (no active run in it), so without forceNew it would be
    // reused — forceNew must override that and create a new session anyway. This
    // backs the PTY "Add a workflow" flow (a second workflow runs in its own session).
    useActiveRunsStore.setState({ runsByProject: {} });

    const id = await ensureSessionForLaunch(7, { forceNew: true });

    expect(id).toBe('sess-new');
    expect(mockCreateQuick).toHaveBeenCalledWith({ prompt: '', projectId: 7 });
    expect(mockCreatePanel).toHaveBeenCalled();
  });

  it('does NOT reuse a BUSY selected session — creates a fresh session instead', async () => {
    mockGetState.mockReturnValue({ selectedSessionId: 'sess-busy' });
    // An active run already executes in the selected session → it is busy.
    useActiveRunsStore.setState({ runsByProject: { 7: [activeRunRow('sess-busy')] } });

    const id = await ensureSessionForLaunch(7);

    // Fell through to the create-quick path rather than reusing the busy session.
    expect(id).toBe('sess-new');
    expect(mockCreateQuick).toHaveBeenCalledWith({ prompt: '', projectId: 7 });
    expect(mockCreatePanel).toHaveBeenCalled();
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
