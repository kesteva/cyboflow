/**
 * Unit tests for the sessions:create-quick IPC handler and the pure
 * generateQuickWorktreeBranchName helper exported from session.ts.
 *
 * Sections:
 *  A. generateQuickWorktreeBranchName -- pure UTC-timestamp helper (3 tests).
 *  B. sessions:create-quick handler -- workflow_runs pipeline integration (4 tests).
 *
 * For section B the full handler is exercised via a lightweight handler-capture
 * harness that replaces the Electron IPC stack.  All service collaborators are
 * stubbed at the object level; no real SQLite DB is used.
 *
 * Important: requests must include an explicit branchName so the listener
 * path-match check inside the handler resolves against a known value.  Without
 * it the handler generates a timestamp-derived name that won't match the
 * stub's worktreePath and the 30-second timeout fires.
 */

import { describe, it, expect, vi } from 'vitest';

// Electron is imported transitively via session.ts -> panelManager etc.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'Cyboflow'),
    getVersion: vi.fn(() => '0.1.0'),
  },
}));

// panelManager uses IPC at module load time - stub it.
vi.mock('../../services/panelManager', () => ({
  panelManager: {
    getPanel: vi.fn(),
    getAllPanels: vi.fn(() => []),
  },
}));

import { generateQuickWorktreeBranchName, registerSessionHandlers } from '../session';
import type { AppServices } from '../types';

// ---------------------------------------------------------------------------
// A. generateQuickWorktreeBranchName
// ---------------------------------------------------------------------------

describe('generateQuickWorktreeBranchName', () => {
  it('returns quick-YYYYMMDD-HHmmss for a fixed UTC date', () => {
    // Date.UTC(2026, 4, 23, 15, 27, 58) -> 2026-05-23T15:27:58Z (month is 0-indexed)
    const result = generateQuickWorktreeBranchName(new Date(Date.UTC(2026, 4, 23, 15, 27, 58)));
    expect(result).toBe('quick-20260523-152758');
  });

  it('matches the /^quick-\d{8}-\d{6}$/ pattern for a default (now) call', () => {
    const result = generateQuickWorktreeBranchName();
    expect(result).toMatch(/^quick-\d{8}-\d{6}$/);
  });

  it('zero-pads month, day, hour, minute, and second to two digits', () => {
    // Date.UTC(2026, 0, 5, 3, 4, 5) -> 2026-01-05T03:04:05Z
    const result = generateQuickWorktreeBranchName(new Date(Date.UTC(2026, 0, 5, 3, 4, 5)));
    expect(result).toBe('quick-20260105-030405');
  });
});

// ---------------------------------------------------------------------------
// B. sessions:create-quick handler - workflow_runs pipeline
// ---------------------------------------------------------------------------

// Fixed branch name used across handler tests so the path-match check resolves.
const TEST_BRANCH = 'quick-test-branch';

function makeHandlerCapture() {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const ipcMain = {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, fn);
    },
  };
  return { ipcMain, handlers };
}

async function invoke(
  handlers: Map<string, (...args: unknown[]) => Promise<unknown>>,
  channel: string,
  arg: unknown,
): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for channel: ${channel}`);
  return fn({} as unknown, arg);
}

function makeServices() {
  const dbRunCalls: Array<{ sql: string; args: unknown[] }> = [];
  let lastPreparedSql = '';
  const fakeStmt = {
    run: (...args: unknown[]) => {
      dbRunCalls.push({ sql: lastPreparedSql, args });
      return { changes: 1, lastInsertRowid: 1 };
    },
    get: () => undefined,
    all: () => [],
  };
  const fakeDb = {
    prepare: (sql: string) => {
      lastPreparedSql = sql;
      return fakeStmt;
    },
    transaction: <T>(fn: (...fnArgs: unknown[]) => T) => fn,
  };

  const ensureQuickWorkflowCalls: number[] = [];
  const createRunCalls: string[] = [];
  const fakeWorkflowRegistry = {
    ensureQuickWorkflow: (projectId: number) => {
      ensureQuickWorkflowCalls.push(projectId);
      return `wf-${projectId}-__quick__`;
    },
    createRun: (workflowId: string) => {
      createRunCalls.push(workflowId);
      return { runId: 'test-run-id-abc', permissionMode: 'default' as const };
    },
  };

  // Fake session whose worktreePath ends with TEST_BRANCH so the handler's
  // path-match resolves successfully without waiting for the 30-second timeout.
  const fakeSession = {
    id: 'sess-001',
    worktreePath: `/tmp/project/${TEST_BRANCH}`,
  };

  const fakeSessionManager = {
    on: (_event: string, cb: (s: unknown) => void) => {
      // Fire synchronously so the Promise inside the handler resolves immediately.
      cb(fakeSession);
    },
    removeListener: vi.fn(),
  };

  const fakeTaskQueue = {
    createSession: vi.fn().mockResolvedValue({ id: 'job-001' }),
  };

  const fakeDatabaseService = {
    getProject: (_id: number) => ({ id: 42, name: 'TestProject', path: '/proj' }),
    getDb: () => fakeDb,
  };

  const services = {
    sessionManager: fakeSessionManager,
    databaseService: fakeDatabaseService,
    taskQueue: fakeTaskQueue,
    worktreeManager: {},
    cliManagerFactory: {},
    claudeCodeManager: {},
    gitStatusManager: {},
    archiveProgressManager: undefined,
    cyboflow: {
      workflowRegistry: fakeWorkflowRegistry,
      runLauncher: {},
    },
  } as unknown as AppServices;

  return { services, dbRunCalls, ensureQuickWorkflowCalls, createRunCalls, fakeTaskQueue };
}

describe('sessions:create-quick handler - workflow_runs pipeline', () => {
  it('calls ensureQuickWorkflow with the project id', async () => {
    const { services, ensureQuickWorkflowCalls } = makeServices();
    const { ipcMain, handlers } = makeHandlerCapture();
    registerSessionHandlers(
      ipcMain as unknown as Parameters<typeof registerSessionHandlers>[0],
      services,
    );

    await invoke(handlers, 'sessions:create-quick', { projectId: 42, branchName: TEST_BRANCH });

    expect(ensureQuickWorkflowCalls).toContain(42);
  });

  it('calls createRun with the sentinel workflow id', async () => {
    const { services, createRunCalls } = makeServices();
    const { ipcMain, handlers } = makeHandlerCapture();
    registerSessionHandlers(
      ipcMain as unknown as Parameters<typeof registerSessionHandlers>[0],
      services,
    );

    await invoke(handlers, 'sessions:create-quick', { projectId: 42, branchName: TEST_BRANCH });

    expect(createRunCalls).toContain('wf-42-__quick__');
  });

  it('does NOT forward permissionMode to taskQueue.createSession', async () => {
    const { services, fakeTaskQueue } = makeServices();
    const { ipcMain, handlers } = makeHandlerCapture();
    registerSessionHandlers(
      ipcMain as unknown as Parameters<typeof registerSessionHandlers>[0],
      services,
    );

    await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      permissionMode: 'approve',
    });

    const callArg = (fakeTaskQueue.createSession as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Record<string, unknown>;
    expect(callArg).not.toHaveProperty('permissionMode');
  });

  it('returns runId in the response data', async () => {
    const { services } = makeServices();
    const { ipcMain, handlers } = makeHandlerCapture();
    registerSessionHandlers(
      ipcMain as unknown as Parameters<typeof registerSessionHandlers>[0],
      services,
    );

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
    })) as { success: boolean; data?: { runId?: string; sessionId?: string } };

    expect(result.success).toBe(true);
    expect(result.data?.runId).toBe('test-run-id-abc');
  });
});
