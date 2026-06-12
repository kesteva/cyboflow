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
 *
 * The 'DB round-trip' describe block adds fixtures-DB integration cases that
 * exercise the real SQLite INSERT/SELECT path — the original three mapper cases
 * use mocks and could not catch a missing INSERT column (FIND-SPRINT-038-4 root cause).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

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
import { DatabaseService } from '../../database/database';

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

  it("copies substrate='interactive' to substrate; legacy row maps to undefined (migration 027)", () => {
    // Stamped row (sessions:create-quick with the interactive PTY substrate).
    const stamped = makeDbSession({ substrate: 'interactive' });
    const mgr = new SessionManager(
      makeDbMock(stamped) as unknown as ConstructorParameters<typeof SessionManager>[0]
    );
    const session = (mgr as unknown as SessionManagerWithPrivate).convertDbSessionToSession(stamped);
    expect(session.substrate).toBe('interactive');

    // Legacy row without the column → undefined (renderer treats as sdk).
    const legacy = makeDbSession();
    const legacySession = (mgr as unknown as SessionManagerWithPrivate).convertDbSessionToSession(legacy);
    expect(legacySession.substrate).toBeUndefined();
  });
});

// ------------------------------------------------------------------
// DB round-trip tests — exercise the real SQLite INSERT/SELECT path.
// These catch missing INSERT columns that mock-based tests cannot detect.
// ------------------------------------------------------------------

describe('DB round-trip — run_id INSERT persistence', () => {
  let tmpDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedProject(dbPath: string): { id: number } {
    const rawDb = new Database(dbPath);
    rawDb.prepare(
      "INSERT INTO projects (name, path, active) VALUES ('test-project', '/tmp/test-project', 1)"
    ).run();
    const project = rawDb.prepare('SELECT id FROM projects LIMIT 1').get() as { id: number };
    rawDb.close();
    return project;
  }

  it('Case A: INSERT with run_id="flow-001" round-trips to runId="flow-001"', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-task754-a-'));
    const dbPath = join(tmpDir, 'test.db');
    const realMigrationsDir = join(__dirname, '../../database/migrations');

    const svc = new DatabaseService(dbPath);
    svc.setMigrationsDirForTesting(realMigrationsDir);
    svc.initialize();

    const project = seedProject(dbPath);

    // Insert via the real DatabaseService.createSession.
    const dbSession = svc.createSession({
      id: 'sess-flow-1',
      name: 'Flow Session',
      initial_prompt: 'do work',
      worktree_name: 'flow-1',
      worktree_path: '/tmp/flow-1',
      project_id: project.id,
      run_id: 'flow-001',
    });

    // Assert raw DB column persisted.
    expect(dbSession.run_id).toBe('flow-001');

    // Assert the mapper produces runId on a freshly-read row.
    const readBack = svc.getSession('sess-flow-1');
    expect(readBack).toBeDefined();
    expect(readBack!.run_id).toBe('flow-001');

    // Construct a minimal SessionManager via the mock pattern and assert the
    // convertDbSessionToSession mapper correctly copies run_id → runId.
    const dbMock = makeDbMock(readBack!);
    const mgr = new SessionManager(dbMock as unknown as ConstructorParameters<typeof SessionManager>[0]);
    const session = (mgr as unknown as SessionManagerWithPrivate).convertDbSessionToSession(readBack!);
    expect(session.runId).toBe('flow-001');
  });

  it('Case B: INSERT WITHOUT run_id round-trips to runId=null (default-NULL path)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-task754-b-'));
    const dbPath = join(tmpDir, 'test.db');
    const realMigrationsDir = join(__dirname, '../../database/migrations');

    const svc = new DatabaseService(dbPath);
    svc.setMigrationsDirForTesting(realMigrationsDir);
    svc.initialize();

    const project = seedProject(dbPath);

    // Insert WITHOUT supplying run_id — the ?? null coalesce yields NULL.
    const dbSession = svc.createSession({
      id: 'sess-quick-1',
      name: 'Quick Session',
      initial_prompt: 'ask something',
      worktree_name: 'quick-1',
      worktree_path: '/tmp/quick-1',
      project_id: project.id,
      // run_id intentionally absent — same as every current caller
    });

    // Assert raw DB column is null/undefined (SQLite returns null).
    expect(dbSession.run_id == null).toBe(true);

    // Assert the mapper produces runId=null.
    const readBack = svc.getSession('sess-quick-1');
    expect(readBack).toBeDefined();

    const dbMock = makeDbMock(readBack!);
    const mgr = new SessionManager(dbMock as unknown as ConstructorParameters<typeof SessionManager>[0]);
    const session = (mgr as unknown as SessionManagerWithPrivate).convertDbSessionToSession(readBack!);
    expect(session.runId).toBeNull();
  });
});
