/**
 * sessionStore tests — focused on resource reclamation on session delete.
 *
 * deleteSession must drop the deleted session's per-session in-memory state in
 * sibling stores so they don't grow unbounded across the app's lifetime:
 *   - terminalOutput (already covered by the existing cleanup) and
 *   - centerPaneStore.bySession (the tabbed center-pane tab state) — clearSession
 *     was defined + tested but never wired into production until this fix.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from '../sessionStore';
import { useCenterPaneStore } from '../centerPaneStore';
import type { Session } from '../../types/session';

function makeSession(id: string): Session {
  return {
    id,
    name: id,
    worktreePath: `/wt/${id}`,
    prompt: '',
    status: 'ready',
    createdAt: '',
    output: [],
    jsonMessages: [],
  };
}

describe('sessionStore.deleteSession — resource reclamation', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [], terminalOutput: {}, activeSessionId: null });
    useCenterPaneStore.setState({ bySession: {} });
  });

  it('reclaims the deleted session centerPaneStore entry (clearSession is wired)', () => {
    const session = makeSession('sess-1');
    useSessionStore.setState({ sessions: [session] });
    // Seed center-pane tab state for that session key.
    useCenterPaneStore.getState().ensureSession('sess-1');
    expect(useCenterPaneStore.getState().bySession['sess-1']).toBeDefined();

    useSessionStore.getState().deleteSession(session);

    // The center-pane entry is reclaimed alongside the session row.
    expect(useCenterPaneStore.getState().bySession['sess-1']).toBeUndefined();
    expect(useSessionStore.getState().sessions.some((s) => s.id === 'sess-1')).toBe(false);
  });

  it('leaves OTHER sessions center-pane state intact', () => {
    const a = makeSession('sess-a');
    const b = makeSession('sess-b');
    useSessionStore.setState({ sessions: [a, b] });
    useCenterPaneStore.getState().ensureSession('sess-a');
    useCenterPaneStore.getState().ensureSession('sess-b');

    useSessionStore.getState().deleteSession(a);

    expect(useCenterPaneStore.getState().bySession['sess-a']).toBeUndefined();
    expect(useCenterPaneStore.getState().bySession['sess-b']).toBeDefined();
  });

  it('still clears the deleted session terminal output (existing behavior preserved)', () => {
    const session = makeSession('sess-1');
    useSessionStore.setState({
      sessions: [session],
      terminalOutput: { 'sess-1': ['line'], 'sess-2': ['keep'] },
    });

    useSessionStore.getState().deleteSession(session);

    const out = useSessionStore.getState().terminalOutput;
    expect(out['sess-1']).toBeUndefined();
    expect(out['sess-2']).toEqual(['keep']);
  });
});
