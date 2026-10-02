/**
 * useIPCEvents — renderer ingestion handlers beyond panel:updated.
 *
 * The hook is the single funnel from Electron IPC into the renderer stores.
 * A dropped/misrouted event here silently corrupts every downstream store, so
 * these pin: onSessionUpdated validation + active-status dispatch, the three
 * onSessionDeleted payload shapes, onSessionsLoaded, the validateEventSession
 * missing-sessionId drop on the output handlers, and clean unsubscribe on
 * unmount.
 *
 * Real sessionStore + panelStore are used (assert real writes); API is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSessionStore } from '../../stores/sessionStore';
import { usePanelLiveEventsStore } from '../../stores/panelLiveEventsStore';
import type { StreamEvent } from '../../utils/cyboflowApi';
import type { Session, SessionOutput } from '../../types/session';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
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
    onSessionOutputAvailable: make('onSessionOutputAvailable'),
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

function collectEvents(type: string): CustomEvent[] {
  const events: CustomEvent[] = [];
  window.addEventListener(type, (e) => events.push(e as CustomEvent));
  return events;
}

beforeEach(() => {
  useSessionStore.setState({
    sessions: [],
    activeSessionId: null,
    activeMainRepoSession: null,
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

describe('onSessionsLoaded', () => {
  it('loads the list into the store, archived sessions included', () => {
    renderHook(() => useIPCEvents());
    fire('onSessionsLoaded', [makeSession('live'), makeSession('archived', { archived: true })]);
    const state = useSessionStore.getState();
    expect(state.isLoaded).toBe(true);
    expect(state.sessions.map((s) => s.id)).toEqual(['live', 'archived']);
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

  it('onSessionOutput feeds a stream_event into the live-tail buffer, then clears it on cancel', () => {
    usePanelLiveEventsStore.getState().clearAll();
    renderHook(() => useIPCEvents());

    // A streaming delta buffers → isGenerating would be true.
    fire('onSessionOutput', {
      sessionId: 's1',
      panelId: 'p1',
      type: 'json',
      data: {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      },
      timestamp: '2026-07-23T00:00:00.000Z',
    } as unknown as SessionOutput);
    expect(usePanelLiveEventsStore.getState().byPanel['p1']).toHaveLength(1);

    // The user-cancel message ({type:'session', status:'cancelled'}) is NOT a
    // result/stream_event envelope, but must still reset the buffer so the Stop
    // button + working spinner clear.
    fire('onSessionOutput', {
      sessionId: 's1',
      panelId: 'p1',
      type: 'json',
      data: { type: 'session', data: { status: 'cancelled', message: 'Cancelled by user', source: 'user' } },
      timestamp: '2026-07-23T00:00:01.000Z',
    } as unknown as SessionOutput);
    expect(usePanelLiveEventsStore.getState().byPanel['p1']).toEqual([]);
  });

  it('onSessionOutput ignores a non-cancel session message (leaves the buffer intact)', () => {
    usePanelLiveEventsStore.getState().clearAll();
    usePanelLiveEventsStore.getState().appendEvent('p1', {
      type: 'stream_event',
      payload: { event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } },
    } as unknown as StreamEvent);
    renderHook(() => useIPCEvents());

    fire('onSessionOutput', {
      sessionId: 's1',
      panelId: 'p1',
      type: 'json',
      data: { type: 'session', data: { status: 'running' } },
      timestamp: '2026-07-23T00:00:02.000Z',
    } as unknown as SessionOutput);
    expect(usePanelLiveEventsStore.getState().byPanel['p1']).toHaveLength(1);
  });

  it('onSessionOutputAvailable preserves panel identity for transcript refetches', () => {
    const events = collectEvents('session-output-available');
    renderHook(() => useIPCEvents());
    fire('onSessionOutputAvailable', {} as unknown as { sessionId: string });
    expect(events).toHaveLength(0);
    fire('onSessionOutputAvailable', { sessionId: 's2' });
    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({ sessionId: 's2' });
    fire('onSessionOutputAvailable', { sessionId: 's2', panelId: 'p2' });
    expect(events).toHaveLength(2);
    expect(events[1].detail).toEqual({ sessionId: 's2', panelId: 'p2' });
  });
});

describe('unmount teardown', () => {
  it('calls every registered unsubscribe exactly once', () => {
    const { unmount } = renderHook(() => useIPCEvents());
    const unsubs = captured.unsubs;
    expect(unsubs.length).toBeGreaterThanOrEqual(7);
    unmount();
    for (const u of unsubs) expect(u).toHaveBeenCalledTimes(1);
  });
});
