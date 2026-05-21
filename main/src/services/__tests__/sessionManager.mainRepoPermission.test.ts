/**
 * Regression guard: getOrCreateMainRepoSession must resolve permission_mode to
 * 'approve' when the parent project's default_permission_mode is NULL or undefined
 * (TASK-654 — completes the permissionMode='ignore' sweep).
 *
 * Mocks:
 *  - panelManager (module-level singleton import in sessionManager)
 *  - ../ipc/logs (addSessionLog, cleanupSessionLogs — no file I/O)
 *  - The DatabaseService injected into SessionManager constructor
 *
 * No initialize() call is made — no real DB or filesystem access occurs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ------------------------------------------------------------------
// Module mocks — must be declared before the SUT import so that
// vi.mock hoisting replaces the modules when sessionManager loads.
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

// scriptExecutionTracker imports ../index → electron chain; mock it to prevent that.
vi.mock('../scriptExecutionTracker', () => ({
  scriptExecutionTracker: {
    start: vi.fn(),
    stop: vi.fn(),
    markClosing: vi.fn(),
    isRunning: vi.fn().mockReturnValue(false),
  },
}));

// ------------------------------------------------------------------
// Import the SUT *after* the mocks are wired.
// ------------------------------------------------------------------
import { SessionManager } from '../sessionManager';
import type { Project, Session as DbSession } from '../../database/models';

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/** Minimal Project row with default_permission_mode optionally absent */
function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 1,
    name: 'Test Project',
    path: '/tmp/test-project',
    active: true,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Minimal Session DB row returned by the mocked createSession */
function makeDbSession(permissionMode: 'approve' | 'ignore'): DbSession {
  return {
    id: 'test-session-id',
    name: 'Test Project (Main)',
    initial_prompt: '',
    worktree_name: 'main',
    worktree_path: '/tmp/test-project',
    status: 'pending',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    project_id: 1,
    permission_mode: permissionMode,
    is_main_repo: true,
    display_order: 0,
    auto_commit: true,
  };
}

/** Build a minimal DatabaseService mock sufficient for getOrCreateMainRepoSession */
function makeDbMock(project: Project, permissionModeStoredByDb: 'approve' | 'ignore') {
  const dbSession = makeDbSession(permissionModeStoredByDb);
  return {
    getMainRepoSession: vi.fn().mockReturnValue(null), // no existing main-repo session
    getProject: vi.fn().mockReturnValue(project),
    getSession: vi.fn().mockReturnValue(null), // session does not exist yet
    createSession: vi.fn().mockImplementation((data: { permission_mode?: string }) => {
      // Return a DB row that mirrors whatever permission_mode was passed in.
      return { ...dbSession, permission_mode: data.permission_mode ?? 'approve' };
    }),
    transaction: vi.fn().mockImplementation((fn: () => unknown) => fn()),
    getAllSessions: vi.fn().mockReturnValue([]),
    getActiveSessions: vi.fn().mockReturnValue([]),
    getPanel: vi.fn().mockReturnValue(null),
  };
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe('SessionManager.getOrCreateMainRepoSession — permissionMode defaults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves permission_mode to "approve" when project.default_permission_mode is null', async () => {
    // Arrange: project has null default_permission_mode (common for legacy rows before migration 008)
    const project = makeProject({ default_permission_mode: undefined }); // undefined ≈ NULL from DB
    const db = makeDbMock(project, 'approve');
    const mgr = new SessionManager(db as unknown as Parameters<typeof SessionManager>[0]);

    // Act
    const session = await mgr.getOrCreateMainRepoSession(1);

    // Assert: createSession was called with permission_mode 'approve'
    expect(db.createSession).toHaveBeenCalledOnce();
    const callArg = db.createSession.mock.calls[0][0] as { permission_mode?: string };
    expect(callArg.permission_mode).toBe('approve');

    // Assert: the returned session surface also reflects 'approve'
    expect(session.permissionMode).toBe('approve');
  });

  it('resolves permission_mode to "approve" when project.default_permission_mode is explicitly undefined', async () => {
    // Arrange: project has no default_permission_mode field at all
    const projectWithoutField = makeProject();
    delete (projectWithoutField as Partial<Project>).default_permission_mode;
    const db = makeDbMock(projectWithoutField, 'approve');
    const mgr = new SessionManager(db as unknown as Parameters<typeof SessionManager>[0]);

    // Act
    const session = await mgr.getOrCreateMainRepoSession(1);

    // Assert: createSession was called with permission_mode 'approve'
    expect(db.createSession).toHaveBeenCalledOnce();
    const callArg = db.createSession.mock.calls[0][0] as { permission_mode?: string };
    expect(callArg.permission_mode).toBe('approve');

    // Assert: the returned session surface also reflects 'approve'
    expect(session.permissionMode).toBe('approve');
  });
});
