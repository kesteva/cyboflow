/**
 * panelApi.createPanel field-parity regression tests.
 *
 * WHY THIS FILE EXISTS. `useAddClaudePanel` builds a CreatePanelRequest carrying
 * the Add-chat picker's per-panel `substrate`, but panelApi used to re-spread the
 * request into FOUR positional args (sessionId/type/title/initialState) and the
 * preload rebuilt the request object from those four — so `substrate` (and
 * `metadata`) were silently dropped on the renderer→main hop. Every added PTY
 * chat therefore launched as an SDK chat. The hook's own tests missed it because
 * they mock panelApi, putting the drop BELOW the test seam.
 *
 * These tests pin the seam itself: the object handed to window.electronAPI must
 * be the request, field-complete.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { panelApi } from '../panelApi';
import type { ToolPanel } from '../../../../shared/types/panels';

const PANEL: ToolPanel = {
  id: 'panel-1',
  sessionId: 'session-1',
  type: 'claude',
  title: 'Chat',
  state: { isActive: true },
  metadata: { createdAt: 'now', lastActiveAt: 'now', position: 0 },
};

const createPanel = vi.fn();

beforeEach(() => {
  createPanel.mockReset();
  createPanel.mockResolvedValue({ success: true, data: PANEL });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    panels: { createPanel },
  };
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('panelApi.createPanel', () => {
  it('forwards the per-panel substrate override to the main process', async () => {
    await panelApi.createPanel({
      sessionId: 'session-1',
      type: 'claude',
      initialState: { cwd: '/tmp/wt' },
      substrate: 'interactive',
    });

    expect(createPanel).toHaveBeenCalledTimes(1);
    expect(createPanel).toHaveBeenCalledWith(
      expect.objectContaining({ substrate: 'interactive' }),
    );
  });

  it('forwards metadata overrides (the permanent-panel flag)', async () => {
    await panelApi.createPanel({
      sessionId: 'session-1',
      type: 'terminal',
      metadata: { permanent: true },
    });

    expect(createPanel).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { permanent: true } }),
    );
  });

  it('passes the request as ONE object, never as positional args', async () => {
    await panelApi.createPanel({ sessionId: 'session-1', type: 'claude' });

    // A second argument means someone re-introduced the positional form, which
    // is what dropped `substrate` in the first place.
    expect(createPanel.mock.calls[0]).toHaveLength(1);
  });

  it('omits substrate when the caller inherits the session', async () => {
    await panelApi.createPanel({ sessionId: 'session-1', type: 'claude' });

    expect(createPanel.mock.calls[0][0]).not.toHaveProperty('substrate');
  });

  it('throws with the backend error when creation fails', async () => {
    createPanel.mockResolvedValue({ success: false, error: 'nope' });
    await expect(
      panelApi.createPanel({ sessionId: 'session-1', type: 'claude' }),
    ).rejects.toThrow('nope');
  });
});
