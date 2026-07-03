/**
 * sessionStore ingestion tests — the renderer output/git-status ingestion core.
 *
 * These pin the memory-safety caps + merge-order the IPC ingestion relies on:
 *   - addSessionOutput caps output at 300 / jsonMessages at 100 + mirrors into
 *     activeMainRepoSession,
 *   - setSessionOutputs returns the LAST N (tail) of a >500-item input,
 *   - setActiveSession's five branches (null-clear / in-store / main-repo /
 *     fetch-fallback / error),
 *   - updateSession preserves pre-existing output/jsonMessages (silent-drop guard),
 *   - the 50ms git-status batch coalesce,
 *   - cleanupInactiveSessions spares the active session + short arrays.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useSessionStore } from '../sessionStore';
import { useCenterPaneStore } from '../centerPaneStore';
import type { Session, SessionOutput } from '../../types/session';

// ---------------------------------------------------------------------------
// API mock — setActiveSession/createSession call into it.
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

function stdout(sessionId: string, data: string): SessionOutput {
  return { sessionId, type: 'stdout', data, timestamp: '2026-01-01T00:00:00Z' } as SessionOutput;
}

function jsonMsg(sessionId: string, i: number): SessionOutput {
  return { sessionId, type: 'json', data: { i } as unknown, timestamp: String(i) } as SessionOutput;
}

function resetStore() {
  useSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    activeMainRepoSession: null,
    terminalOutput: {},
    gitStatusLoading: new Set(),
    gitStatusBatchTimer: null,
    pendingGitStatusLoading: new Map(),
    pendingGitStatusUpdates: new Map(),
  });
  useCenterPaneStore.setState({ bySession: {} });
}

beforeEach(() => {
  resetStore();
  apiGet.mockReset();
  apiMarkViewed.mockReset().mockResolvedValue({ success: true });
  (window as unknown as { electronAPI: { invoke: ReturnType<typeof vi.fn> } }).electronAPI = {
    invoke: vi.fn().mockResolvedValue(undefined),
  };
});

describe('addSessionOutput — caps + main-repo mirror', () => {
  it('caps stdout output at 300 lines (drops oldest)', () => {
    useSessionStore.setState({ sessions: [makeSession('s1')] });
    const { addSessionOutput } = useSessionStore.getState();
    for (let i = 0; i < 350; i++) addSessionOutput(stdout('s1', `line-${i}`));
    const out = useSessionStore.getState().sessions[0].output!;
    expect(out).toHaveLength(300);
    expect(out[0]).toBe('line-50'); // oldest 50 dropped
    expect(out[299]).toBe('line-349');
  });

  it('caps jsonMessages at 100 (drops oldest)', () => {
    useSessionStore.setState({ sessions: [makeSession('s1')] });
    const { addSessionOutput } = useSessionStore.getState();
    for (let i = 0; i < 130; i++) addSessionOutput(jsonMsg('s1', i));
    const msgs = useSessionStore.getState().sessions[0].jsonMessages!;
    expect(msgs).toHaveLength(100);
    expect((msgs[0] as unknown as { i: number }).i).toBe(30);
  });

  it('mirrors the output into activeMainRepoSession when it matches', () => {
    const main = makeSession('main', { isMainRepo: true });
    useSessionStore.setState({ sessions: [main], activeMainRepoSession: main, activeSessionId: 'main' });
    useSessionStore.getState().addSessionOutput(stdout('main', 'hello'));
    expect(useSessionStore.getState().activeMainRepoSession?.output).toEqual(['hello']);
  });

  it('is a no-op for an unknown sessionId', () => {
    useSessionStore.setState({ sessions: [makeSession('s1')] });
    useSessionStore.getState().addSessionOutput(stdout('ghost', 'x'));
    expect(useSessionStore.getState().sessions[0].output).toEqual([]);
  });
});

describe('setSessionOutputs — tail truncation', () => {
  it('keeps the LAST 300 stdout lines of a 450-item input (true tail)', () => {
    useSessionStore.setState({ sessions: [makeSession('s1')] });
    const outputs: SessionOutput[] = [];
    for (let i = 0; i < 450; i++) outputs.push(stdout('s1', `l-${i}`));
    useSessionStore.getState().setSessionOutputs('s1', outputs);
    const out = useSessionStore.getState().sessions[0].output!;
    expect(out).toHaveLength(300);
    expect(out[out.length - 1]).toBe('l-449'); // newest present
    expect(out[0]).toBe('l-150'); // oldest 150 dropped
    expect(out).not.toContain('l-0');
  });

  it('keeps the true tail for a >500-item input (newest present, oldest dropped)', () => {
    // Regression: the old forward batching early-break stopped after ~400 items
    // and slice(-300) then kept a stale MIDDLE window (l-100..l-399), silently
    // dropping the NEWEST ~200 lines. The tail walk must keep l-300..l-599.
    useSessionStore.setState({ sessions: [makeSession('s1')] });
    const outputs: SessionOutput[] = [];
    for (let i = 0; i < 600; i++) outputs.push(stdout('s1', `l-${i}`));
    useSessionStore.getState().setSessionOutputs('s1', outputs);
    const out = useSessionStore.getState().sessions[0].output!;
    expect(out).toHaveLength(300);
    expect(out[out.length - 1]).toBe('l-599'); // newest present
    expect(out[0]).toBe('l-300'); // oldest 300 dropped
    expect(out).not.toContain('l-299');
    expect(out).toContain('l-400'); // the previously-lost newest window is now retained
  });

  it('splits mixed stdout/json outputs and caps each independently', () => {
    useSessionStore.setState({ sessions: [makeSession('s1')] });
    const outputs: SessionOutput[] = [stdout('s1', 'a'), jsonMsg('s1', 1), stdout('s1', 'b')];
    useSessionStore.getState().setSessionOutputs('s1', outputs);
    const s = useSessionStore.getState().sessions[0];
    expect(s.output).toEqual(['a', 'b']);
    expect(s.jsonMessages).toHaveLength(1);
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
  it('null clears active ids and notifies the backend', async () => {
    useSessionStore.setState({ activeSessionId: 's1', activeMainRepoSession: makeSession('s1') });
    await useSessionStore.getState().setActiveSession(null);
    const state = useSessionStore.getState();
    expect(state.activeSessionId).toBeNull();
    expect(state.activeMainRepoSession).toBeNull();
    const invoke = (window as unknown as { electronAPI: { invoke: ReturnType<typeof vi.fn> } }).electronAPI.invoke;
    expect(invoke).toHaveBeenCalledWith('sessions:set-active-session', null);
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

describe('git-status batch coalesce (50ms window)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces multiple setGitStatusLoading calls into one batch after 50ms', () => {
    const { setGitStatusLoading } = useSessionStore.getState();
    setGitStatusLoading('s1', true);
    setGitStatusLoading('s2', true);
    // Not applied yet (still within the batch window).
    expect(useSessionStore.getState().gitStatusLoading.size).toBe(0);
    vi.advanceTimersByTime(50);
    const loading = useSessionStore.getState().gitStatusLoading;
    expect(loading.has('s1')).toBe(true);
    expect(loading.has('s2')).toBe(true);
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
