/**
 * useIPCEvents — renderer ingestion handlers beyond panel:updated.
 *
 * The hook is the single funnel from Electron IPC into the renderer stores.
 * A dropped/misrouted event here silently corrupts every downstream store, so
 * these pin: onSessionUpdated validation + active-status dispatch, the three
 * onSessionDeleted payload shapes, onSessionsLoaded archived skip, the
 * validateEventSession missing-sessionId drop on the output handlers, the zombie
 * pid-join, the batch git-status setters + per-session CustomEvents, the throttle
 * immediate/coalesce behavior, and clean unsubscribe on unmount.
 *
 * Real sessionStore + panelStore are used (assert real writes); errorStore + API
 * are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSessionStore } from '../../stores/sessionStore';
import type { Session, SessionOutput, GitStatus } from '../../types/session';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const { showError } = vi.hoisted(() => ({ showError: vi.fn() }));

vi.mock('../../stores/errorStore', () => ({
  useErrorStore: () => ({ showError }),
}));

vi.mock('../../utils/api', () => ({
  API: { sessions: { getAll: vi.fn().mockResolvedValue({ success: true, data: [] }) } },
}));

import { useIPCEvents } from '../useIPCEvents';

// ---------------------------------------------------------------------------
// Fake window.electronAPI.events — capture each callback + a unique unsub spy.
// ---------------------------------------------------------------------------
type AnyCb = (...args: never[]) => void;
interface Captured {
  cbs: Record<string, AnyCb>;
  unsubs: ReturnType<typeof vi.fn>[];
}

let captured: Captured;

function makeEvents() {
  captured = { cbs: {}, unsubs: [] };
  const make = (name: string) =>
    vi.fn((cb: AnyCb) => {
      captured.cbs[name] = cb;
      const unsub = vi.fn();
      captured.unsubs.push(unsub);
      return unsub;
    });
  return {
    onSessionCreated: make('onSessionCreated'),
    onSessionUpdated: make('onSessionUpdated'),
    onSessionDeleted: make('onSessionDeleted'),
    onSessionsLoaded: make('onSessionsLoaded'),
    onPanelUpdated: make('onPanelUpdated'),
    onSessionOutput: make('onSessionOutput'),
    onTerminalOutput: make('onTerminalOutput'),
    onSessionOutputAvailable: make('onSessionOutputAvailable'),
    onZombieProcessesDetected: make('onZombieProcessesDetected'),
    onGitStatusUpdated: make('onGitStatusUpdated'),
    onGitStatusLoading: make('onGitStatusLoading'),
    onGitStatusLoadingBatch: make('onGitStatusLoadingBatch'),
    onGitStatusUpdatedBatch: make('onGitStatusUpdatedBatch'),
  };
}

function fire<T extends unknown[]>(name: string, ...args: T): void {
  (captured.cbs[name] as unknown as (...a: T) => void)(...args);
}

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

const GIT_STATUS: GitStatus = { state: 'modified' } as GitStatus;

function collectEvents(type: string): CustomEvent[] {
  const events: CustomEvent[] = [];
  window.addEventListener(type, (e) => events.push(e as CustomEvent));
  return events;
}

beforeEach(() => {
  showError.mockReset();
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
  (window as unknown as { electronAPI: { events: ReturnType<typeof makeEvents>; invoke: ReturnType<typeof vi.fn> } }).electronAPI = {
    events: makeEvents(),
    invoke: vi.fn().mockResolvedValue(undefined),
  };
});

describe('onSessionUpdated', () => {
  it('rejects a payload with no id (no store write)', () => {
    renderHook(() => useIPCEvents());
    useSessionStore.setState({ sessions: [makeSession('s1', { status: 'ready' })] });
    fire('onSessionUpdated', { status: 'stopped' } as unknown as Session);
    // Unchanged — the invalid payload short-circuited.
    expect(useSessionStore.getState().sessions[0].status).toBe('ready');
  });

  it('dispatches session-status-changed when the ACTIVE session goes to stopped', () => {
    const events = collectEvents('session-status-changed');
    useSessionStore.setState({ sessions: [makeSession('s1')], activeSessionId: 's1' });
    renderHook(() => useIPCEvents());
    fire('onSessionUpdated', makeSession('s1', { status: 'stopped' }));
    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({ sessionId: 's1', status: 'stopped' });
  });

  it('does NOT dispatch when the updated session is not the active one', () => {
    const events = collectEvents('session-status-changed');
    useSessionStore.setState({ sessions: [makeSession('s1'), makeSession('s2')], activeSessionId: 's1' });
    renderHook(() => useIPCEvents());
    fire('onSessionUpdated', makeSession('s2', { status: 'stopped' }));
    expect(events).toHaveLength(0);
  });

  it('does NOT dispatch for a non-terminal status on the active session', () => {
    const events = collectEvents('session-status-changed');
    useSessionStore.setState({ sessions: [makeSession('s1')], activeSessionId: 's1' });
    renderHook(() => useIPCEvents());
    fire('onSessionUpdated', makeSession('s1', { status: 'running' }));
    expect(events).toHaveLength(0);
  });
});

describe('onSessionDeleted — payload shapes', () => {
  it('accepts a bare string id', () => {
    const events = collectEvents('session-deleted');
    useSessionStore.setState({ sessions: [makeSession('s1')] });
    renderHook(() => useIPCEvents());
    fire('onSessionDeleted', 's1');
    expect(useSessionStore.getState().sessions.some((s) => s.id === 's1')).toBe(false);
    expect(events[0].detail).toEqual({ id: 's1' });
  });

  it('accepts an { id } object', () => {
    useSessionStore.setState({ sessions: [makeSession('s1')] });
    renderHook(() => useIPCEvents());
    fire('onSessionDeleted', { id: 's1' });
    expect(useSessionStore.getState().sessions.some((s) => s.id === 's1')).toBe(false);
  });

  it('accepts a { sessionId } object (falls back to sessionId when no id)', () => {
    const events = collectEvents('session-deleted');
    useSessionStore.setState({ sessions: [makeSession('s1')] });
    renderHook(() => useIPCEvents());
    fire('onSessionDeleted', { sessionId: 's1' });
    expect(events[events.length - 1].detail).toEqual({ id: 's1' });
    expect(useSessionStore.getState().sessions.some((s) => s.id === 's1')).toBe(false);
  });
});

describe('onSessionsLoaded — git-status loading seed', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('marks non-archived sessions without gitStatus as loading, skips archived', () => {
    renderHook(() => useIPCEvents());
    fire('onSessionsLoaded', [
      makeSession('needs'), // no gitStatus, not archived → loading
      makeSession('archived', { archived: true }), // skipped
      makeSession('hasStatus', { gitStatus: GIT_STATUS }), // has status → skipped
    ]);
    // setGitStatusLoading batches on a 50ms timer — flush it.
    vi.advanceTimersByTime(50);
    const loading = useSessionStore.getState().gitStatusLoading;
    expect(loading.has('needs')).toBe(true);
    expect(loading.has('archived')).toBe(false);
    expect(loading.has('hasStatus')).toBe(false);
    // The list is still loaded into the store.
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toContain('needs');
  });
});

describe('output handlers — validateEventSession missing-sessionId drop', () => {
  it('onSessionOutput drops a payload with no sessionId, dispatches for a valid one', () => {
    const events = collectEvents('session-output-available');
    renderHook(() => useIPCEvents());
    fire('onSessionOutput', { type: 'stdout', data: 'x' } as unknown as SessionOutput);
    expect(events).toHaveLength(0);
    fire('onSessionOutput', { sessionId: 's1', type: 'stdout', data: 'x', panelId: 'p1' } as SessionOutput);
    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({ sessionId: 's1', panelId: 'p1' });
  });

  it('onTerminalOutput drops a missing-sessionId payload, stores a valid one', () => {
    renderHook(() => useIPCEvents());
    fire('onTerminalOutput', { type: 'stdout', data: 'x' } as unknown as { sessionId: string; type: 'stdout'; data: string });
    expect(useSessionStore.getState().getTerminalOutput('s1')).toEqual([]);
    fire('onTerminalOutput', { sessionId: 's1', type: 'stdout', data: 'hello' });
    expect(useSessionStore.getState().getTerminalOutput('s1')).toEqual(['hello']);
  });

  it('onSessionOutputAvailable dispatches only for a valid sessionId', () => {
    const events = collectEvents('session-output-available');
    renderHook(() => useIPCEvents());
    fire('onSessionOutputAvailable', {} as unknown as { sessionId: string });
    expect(events).toHaveLength(0);
    fire('onSessionOutputAvailable', { sessionId: 's2' });
    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({ sessionId: 's2' });
  });
});

describe('onZombieProcessesDetected', () => {
  it('joins pids into the details string and surfaces an error', () => {
    renderHook(() => useIPCEvents());
    fire('onZombieProcessesDetected', { pids: [111, 222], message: 'stuck' });
    expect(showError).toHaveBeenCalledTimes(1);
    const arg = showError.mock.calls[0][0] as { title: string; error: string; details?: string };
    expect(arg.title).toBe('Zombie Processes Detected');
    expect(arg.error).toBe('stuck');
    expect(arg.details).toContain('111, 222');
  });

  it('omits details when there are no pids', () => {
    renderHook(() => useIPCEvents());
    fire('onZombieProcessesDetected', { message: 'generic' });
    const arg = showError.mock.calls[0][0] as { details?: string };
    expect(arg.details).toBeUndefined();
  });
});

describe('batch git-status handlers', () => {
  it('onGitStatusLoadingBatch sets loading once + dispatches one CustomEvent per session', () => {
    const events = collectEvents('git-status-loading');
    renderHook(() => useIPCEvents());
    fire('onGitStatusLoadingBatch', ['a', 'b', 'c']);
    const loading = useSessionStore.getState().gitStatusLoading;
    expect(loading.has('a') && loading.has('b') && loading.has('c')).toBe(true);
    expect(events.map((e) => (e.detail as { sessionId: string }).sessionId)).toEqual(['a', 'b', 'c']);
  });

  it('onGitStatusUpdatedBatch applies statuses + dispatches one CustomEvent per session', () => {
    const events = collectEvents('git-status-updated');
    useSessionStore.setState({ sessions: [makeSession('a'), makeSession('b')] });
    renderHook(() => useIPCEvents());
    fire('onGitStatusUpdatedBatch', [
      { sessionId: 'a', status: GIT_STATUS },
      { sessionId: 'b', status: GIT_STATUS },
    ]);
    const byId = Object.fromEntries(useSessionStore.getState().sessions.map((s) => [s.id, s]));
    expect(byId['a'].gitStatus).toEqual(GIT_STATUS);
    expect(byId['b'].gitStatus).toEqual(GIT_STATUS);
    expect(events).toHaveLength(2);
  });
});

describe('throttled onGitStatusUpdated', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires immediately on the first call, coalesces rapid calls into one trailing fire', () => {
    const events = collectEvents('git-status-updated');
    renderHook(() => useIPCEvents());
    // Call 1 — immediate.
    fire('onGitStatusUpdated', { sessionId: 's1', gitStatus: GIT_STATUS });
    expect(events).toHaveLength(1);
    // Calls 2 & 3 within the 100ms window for the SAME session — coalesced to one.
    fire('onGitStatusUpdated', { sessionId: 's1', gitStatus: GIT_STATUS });
    fire('onGitStatusUpdated', { sessionId: 's1', gitStatus: GIT_STATUS });
    expect(events).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(events).toHaveLength(2); // one trailing fire, not two
  });

  it('drops a throttled event with no sessionId', () => {
    const events = collectEvents('git-status-updated');
    renderHook(() => useIPCEvents());
    fire('onGitStatusUpdated', { gitStatus: GIT_STATUS } as unknown as { sessionId: string; gitStatus: GitStatus });
    expect(events).toHaveLength(0);
  });
});

describe('unmount teardown', () => {
  it('calls every registered unsubscribe exactly once', () => {
    const { unmount } = renderHook(() => useIPCEvents());
    const unsubs = captured.unsubs;
    expect(unsubs.length).toBeGreaterThanOrEqual(13);
    unmount();
    for (const u of unsubs) expect(u).toHaveBeenCalledTimes(1);
  });
});
