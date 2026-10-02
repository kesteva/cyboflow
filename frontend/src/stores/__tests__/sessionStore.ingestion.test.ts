/**
 * sessionStore ingestion tests — the renderer output ingestion core.
 *
 * These pin the memory-safety caps + merge-order the IPC ingestion relies on:
 *   - setActiveSession's five branches (null-clear / in-store / main-repo /
 *     fetch-fallback / error),
 *   - updateSession preserves pre-existing output/jsonMessages (silent-drop guard),
 *   - cleanupInactiveSessions spares the active session + short arrays.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSessionStore } from '../sessionStore';
import { useCenterPaneStore } from '../centerPaneStore';
import type { Session } from '../../types/session';

// ---------------------------------------------------------------------------
// API mock — setActiveSession calls into it.
// ---------------------------------------------------------------------------
const { apiGet, apiMarkViewed } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiMarkViewed: vi.fn(),
}));

vi.mock('../../utils/api', () => ({
  API: {
    sessions: {
      get: apiGet,
      markViewed: apiMarkViewed,
    },
  },
}));

function makeSession(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    name: id,
    worktreePath: `/wt/${id}`,
    prompt: '',
    status: 'ready',
    createdAt: '',
    output: [],
    jsonMessages: [],
    ...over,
  };
}

function resetStore() {
  useSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    activeMainRepoSession: null,
  });
  useCenterPaneStore.setState({ bySession: {} });
}

beforeEach(() => {
  resetStore();
  apiGet.mockReset();
  apiMarkViewed.mockReset().mockResolvedValue({ success: true });
});

describe('addSession — display order', () => {
  it('appends a newly created highest-display-order session in memory', () => {
    useSessionStore.setState({
      sessions: [makeSession('s1', { displayOrder: 0 }), makeSession('s2', { displayOrder: 1 })],
    });

    useSessionStore.getState().addSession(makeSession('s3', { displayOrder: 2 }));

    expect(useSessionStore.getState().sessions.map((session) => session.id)).toEqual(['s1', 's2', 's3']);
  });
});

describe('updateSession — preserves output/jsonMessages (silent-drop guard)', () => {
  it('keeps pre-existing output arrays when the update omits them', () => {
    const existing = makeSession('s1', { output: ['keep'], jsonMessages: [{ a: 1 } as never] });
    useSessionStore.setState({ sessions: [existing] });
    // Update carries a status change but fresh empty arrays.
    useSessionStore.getState().updateSession(makeSession('s1', { status: 'stopped' }));
    const s = useSessionStore.getState().sessions[0];
    expect(s.status).toBe('stopped');
    expect(s.output).toEqual(['keep']);
    expect(s.jsonMessages).toEqual([{ a: 1 }]);
  });

  it('preserves arrays on the activeMainRepoSession branch', () => {
    const main = makeSession('main', { isMainRepo: true, output: ['keep'] });
    useSessionStore.setState({ sessions: [main], activeMainRepoSession: main });
    useSessionStore.getState().updateSession(makeSession('main', { status: 'stopped' }));
    expect(useSessionStore.getState().activeMainRepoSession?.output).toEqual(['keep']);
    expect(useSessionStore.getState().activeMainRepoSession?.status).toBe('stopped');
  });
});

describe('setActiveSession — branches', () => {
  it('null clears active ids', async () => {
    useSessionStore.setState({ activeSessionId: 's1', activeMainRepoSession: makeSession('s1') });
    await useSessionStore.getState().setActiveSession(null);
    const state = useSessionStore.getState();
    expect(state.activeSessionId).toBeNull();
    expect(state.activeMainRepoSession).toBeNull();
  });

  it('uses the in-store regular session without fetching', async () => {
    useSessionStore.setState({ sessions: [makeSession('s1')] });
    await useSessionStore.getState().setActiveSession('s1');
    const state = useSessionStore.getState();
    expect(state.activeSessionId).toBe('s1');
    expect(state.activeMainRepoSession).toBeNull();
    expect(apiGet).not.toHaveBeenCalled();
    expect(apiMarkViewed).toHaveBeenCalledWith('s1');
  });

  it('stores a main-repo session in activeMainRepoSession', async () => {
    useSessionStore.setState({ sessions: [makeSession('m1', { isMainRepo: true })] });
    await useSessionStore.getState().setActiveSession('m1');
    expect(useSessionStore.getState().activeMainRepoSession?.id).toBe('m1');
  });

  it('fetches from the backend when the session is not in the store', async () => {
    apiGet.mockResolvedValue({ success: true, data: makeSession('remote') });
    await useSessionStore.getState().setActiveSession('remote');
    const state = useSessionStore.getState();
    expect(apiGet).toHaveBeenCalledWith('remote');
    expect(state.activeSessionId).toBe('remote');
    expect(state.sessions.some((s) => s.id === 'remote')).toBe(true);
  });

  it('falls back to setting the id when the fetch throws', async () => {
    apiGet.mockRejectedValue(new Error('offline'));
    await useSessionStore.getState().setActiveSession('remote');
    const state = useSessionStore.getState();
    expect(state.activeSessionId).toBe('remote');
    expect(state.activeMainRepoSession).toBeNull();
  });
});

describe('cleanupInactiveSessions', () => {
  it('trims long inactive outputs but spares the active session and short arrays', () => {
    const active = makeSession('active', { output: Array.from({ length: 200 }, (_, i) => `a-${i}`) });
    const inactiveLong = makeSession('long', { output: Array.from({ length: 200 }, (_, i) => `l-${i}`) });
    const inactiveShort = makeSession('short', { output: ['x', 'y'] });
    useSessionStore.setState({
      sessions: [active, inactiveLong, inactiveShort],
      activeSessionId: 'active',
    });
    useSessionStore.getState().cleanupInactiveSessions();
    const byId = Object.fromEntries(useSessionStore.getState().sessions.map((s) => [s.id, s]));
    expect(byId['active'].output).toHaveLength(200); // untouched
    expect(byId['long'].output).toHaveLength(50); // trimmed to last 50
    expect(byId['long'].output![49]).toBe('l-199');
    expect(byId['short'].output).toHaveLength(2); // short arrays spared
  });
});
