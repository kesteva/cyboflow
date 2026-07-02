/**
 * B6 — SessionManager.archiveSession teardown slice + addPanelOutput branches.
 *
 * archiveSession is the session-deletion chokepoint: it validates existence,
 * unregisters Claude panels, closes the terminal, drops the in-memory session, and
 * emits `session-deleted`. The contract under test:
 *   - a not-found id throws BEFORE any side effect (no terminal close, no emit);
 *   - a FAILURE in the Claude-panel teardown block is swallowed so terminal-close
 *     + activeSessions delete + `session-deleted` emit still run (fail-soft);
 *   - the `session-deleted` payload is `{ id }`.
 *
 * NOTE: archiveSession reaches the Claude-panel unregister via a dynamic
 * `require('../ipc/claudePanel')` that vitest's vi.mock does NOT intercept (same
 * limitation the sibling gitDestructiveHandlers.test.ts documents). We therefore
 * cannot assert `unregisterPanel(panelId)` was called; instead we assert the
 * fail-soft contract — that the (real, electron-importing) panel require throwing
 * does not abort the rest of teardown.
 *
 * addPanelOutput has two branches: the auto-context-capture buffer (no DB write)
 * vs the normal DB-persist path.
 *
 * Mocks mirror sessionManager.mainRepoPermission.test.ts, extended with the
 * terminalSessionManager seam archiveSession constructs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ------------------------------------------------------------------
// Hoisted spies (referenced inside vi.mock factories).
// ------------------------------------------------------------------
const { getPanelsForSessionMock, closeTerminalSessionMock } = vi.hoisted(() => ({
  getPanelsForSessionMock: vi.fn(),
  closeTerminalSessionMock: vi.fn(),
}));

vi.mock('../panelManager', () => ({
  panelManager: {
    ensureDiffPanel: vi.fn().mockResolvedValue(undefined),
    getPanelsForSession: getPanelsForSessionMock,
  },
}));

vi.mock('../terminalSessionManager', () => ({
  TerminalSessionManager: class {
    on = vi.fn();
    closeTerminalSession = closeTerminalSessionMock;
  },
}));

vi.mock('../../ipc/logs', () => ({
  addSessionLog: vi.fn(),
  cleanupSessionLogs: vi.fn(),
}));

vi.mock('../scriptExecutionTracker', () => ({
  scriptExecutionTracker: {
    start: vi.fn(),
    stop: vi.fn(),
    markClosing: vi.fn(),
    isRunning: vi.fn().mockReturnValue(false),
  },
}));

// ------------------------------------------------------------------
// SUT import after mocks.
// ------------------------------------------------------------------
import { SessionManager } from '../sessionManager';

interface SessionManagerPrivate {
  activeSessions: Map<string, unknown>;
}

type DbCtorArg = ConstructorParameters<typeof SessionManager>[0];

/** Minimal DatabaseService mock covering only what archiveSession/addPanelOutput touch. */
function makeDbMock(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    archiveSession: vi.fn().mockReturnValue(true),
    getPanel: vi.fn().mockReturnValue({ sessionId: 's1' }),
    getPanelOutputs: vi.fn().mockReturnValue([]),
    addPanelOutput: vi.fn(),
    updateSession: vi.fn(),
    updatePanelPromptMarkerCompletion: vi.fn(),
    getActiveProject: vi.fn().mockReturnValue(null),
    ...overrides,
  };
}

function makeManager(db: ReturnType<typeof makeDbMock>): SessionManager {
  return new SessionManager(db as unknown as DbCtorArg);
}

beforeEach(() => {
  vi.clearAllMocks();
  getPanelsForSessionMock.mockReturnValue([]);
  closeTerminalSessionMock.mockResolvedValue(undefined);
});

describe('SessionManager.archiveSession', () => {
  it('throws before any side effect when the session is not found', async () => {
    const db = makeDbMock({ archiveSession: vi.fn().mockReturnValue(false) });
    const mgr = makeManager(db);
    const deleted = vi.fn();
    mgr.on('session-deleted', deleted);

    await expect(mgr.archiveSession('ghost')).rejects.toThrow('Session ghost not found');

    // No teardown ran.
    expect(getPanelsForSessionMock).not.toHaveBeenCalled();
    expect(closeTerminalSessionMock).not.toHaveBeenCalled();
    expect(deleted).not.toHaveBeenCalled();
  });

  it('swallows a Claude-panel teardown failure and still closes the terminal, deletes, and emits', async () => {
    // A session WITH a claude panel drives archiveSession into the panel-teardown
    // block, whose dynamic require('../ipc/claudePanel') throws under vitest (it
    // imports electron). The production inner try/catch must swallow it so the rest
    // of teardown runs.
    getPanelsForSessionMock.mockReturnValue([{ id: 'panel-claude-1', type: 'claude' }]);
    const mgr = makeManager(makeDbMock());
    // Seed the in-memory session so we can assert it is removed.
    (mgr as unknown as SessionManagerPrivate).activeSessions.set('sess-1', {});
    const deleted = vi.fn();
    mgr.on('session-deleted', deleted);

    await expect(mgr.archiveSession('sess-1')).resolves.toBeUndefined();

    expect(closeTerminalSessionMock).toHaveBeenCalledWith('sess-1');
    expect((mgr as unknown as SessionManagerPrivate).activeSessions.has('sess-1')).toBe(false);
    expect(deleted).toHaveBeenCalledTimes(1);
  });

  it('emits session-deleted with an { id } payload', async () => {
    const mgr = makeManager(makeDbMock());
    const deleted = vi.fn();
    mgr.on('session-deleted', deleted);

    await mgr.archiveSession('sess-42');

    expect(deleted).toHaveBeenCalledWith({ id: 'sess-42' });
  });
});

describe('SessionManager.addPanelOutput', () => {
  it('buffers into the auto-context capture (no DB write) when capture is active', () => {
    const db = makeDbMock();
    const mgr = makeManager(db);
    mgr.beginAutoContextCapture('panel-ac');

    mgr.addPanelOutput('panel-ac', { type: 'stdout', data: 'captured', timestamp: new Date() });

    expect(db.addPanelOutput).not.toHaveBeenCalled();
    const buffered = mgr.consumeAutoContextCapture('panel-ac');
    expect(buffered).toHaveLength(1);
    expect(buffered[0].data).toBe('captured');
  });

  it('persists to the DB on the normal path (no active capture)', () => {
    const db = makeDbMock();
    const mgr = makeManager(db);

    mgr.addPanelOutput('panel-db', { type: 'stdout', data: 'hello', timestamp: new Date() });

    expect(db.addPanelOutput).toHaveBeenCalledWith('panel-db', 'stdout', 'hello');
  });
});
