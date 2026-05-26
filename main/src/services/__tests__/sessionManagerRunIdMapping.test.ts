/**
 * Regression guard: convertDbSessionToSession must copy the DbSession.run_id column
 * onto the returned Session.runId field, coalescing undefined to null.
 *
 * FIND-SPRINT-037-1 documents the silent inversion: SessionListItem.tsx:431 reads
 * session.runId (== null → Quick badge), but the mapper never copied run_id, so
 * runId was always undefined and the badge fired for every session including
 * flow-owned ones.
 *
 * Mocks match the pattern in sessionManager.mainRepoPermission.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';

// ------------------------------------------------------------------
// Module mocks — hoisted before SUT import.
// ------------------------------------------------------------------
vi.mock('../panelManager', () => ({
  panelManager: {
    ensureDiffPanel: vi.fn().mockResolvedValue(undefined),
    getPanelsForSession: vi.fn().mockReturnValue([]),
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
// Import SUT after mocks.
// ------------------------------------------------------------------
import { SessionManager } from '../sessionManager';
import type { Session as DbSession } from '../../database/models';

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/** Minimal DbSession row with an optional run_id override. */
function makeDbSession(overrides: Partial<DbSession> = {}): DbSession {
  return {
    id: 'test-session-id',
    name: 'Test Session',
    initial_prompt: '',
    worktree_name: 'worktree-abc',
    worktree_path: '/tmp/worktree-abc',
    status: 'completed',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    project_id: 1,
    permission_mode: 'approve',
    is_main_repo: false,
    display_order: 0,
    auto_commit: false,
    ...overrides,
  };
}

/** Minimal DatabaseService mock sufficient to construct SessionManager without init. */
function makeDbMock(dbSession: DbSession) {
  return {
    getMainRepoSession: vi.fn().mockReturnValue(null),
    getProject: vi.fn().mockReturnValue(null),
    getSession: vi.fn().mockReturnValue(dbSession),
    createSession: vi.fn().mockReturnValue(dbSession),
    transaction: vi.fn().mockImplementation((fn: () => unknown) => fn()),
    getAllSessions: vi.fn().mockReturnValue([dbSession]),
    getActiveSessions: vi.fn().mockReturnValue([]),
    getPanel: vi.fn().mockReturnValue(null),
  };
}

// ------------------------------------------------------------------
// Access the private method via type cast.
// ------------------------------------------------------------------
import type { Session } from '../../types/session';

interface SessionManagerWithPrivate {
  convertDbSessionToSession(dbSession: DbSession): Session;
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe('convertDbSessionToSession — run_id → runId mapping', () => {
  it('copies run_id="flow-001" to runId="flow-001" (flow-owned session)', () => {
    const dbSession = makeDbSession({ run_id: 'flow-001' });
    const db = makeDbMock(dbSession);
    const mgr = new SessionManager(db as unknown as ConstructorParameters<typeof SessionManager>[0]);

    const session = (mgr as unknown as SessionManagerWithPrivate).convertDbSessionToSession(dbSession);

    expect(session.runId).toBe('flow-001');
  });

  it('copies run_id=null to runId=null (quick session — expects Quick badge)', () => {
    const dbSession = makeDbSession({ run_id: null });
    const db = makeDbMock(dbSession);
    const mgr = new SessionManager(db as unknown as ConstructorParameters<typeof SessionManager>[0]);

    const session = (mgr as unknown as SessionManagerWithPrivate).convertDbSessionToSession(dbSession);

    expect(session.runId).toBeNull();
  });

  it('coalesces run_id=undefined (legacy row missing column) to runId=null', () => {
    // Omit run_id entirely to simulate a legacy DB row without the column.
    const dbSession = makeDbSession();
    // Ensure run_id is not set at all (makeDbSession spreads no run_id by default).
    const db = makeDbMock(dbSession);
    const mgr = new SessionManager(db as unknown as ConstructorParameters<typeof SessionManager>[0]);

    const session = (mgr as unknown as SessionManagerWithPrivate).convertDbSessionToSession(dbSession);

    expect(session.runId).toBeNull();
  });
});
