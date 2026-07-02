/**
 * Behavioral tests for the sessions:delete IPC handler (main/src/ipc/session.ts)
 * — the ~175-line archive/dismiss chokepoint.
 *
 * Covered:
 *  - an already-archived session returns success:false with NO side effects
 *    (no cancelHostedRuns, no killLiveSession, no archiveSession).
 *  - an interactive session with a chat_run_id HARD-kills the live REPL
 *    (killLiveSession) BEFORE the worktree is removed.
 *  - a cancelHostedRuns() throw is fail-soft: archive + the dismissed-outcome
 *    stamp still proceed.
 *  - the dismissed-outcome stamp runs the guarded `outcome IS NULL` UPDATE
 *    (idempotent — never clobbers a run that already recorded its own outcome).
 *
 * Follows the sessionQuickCreate harness: electron/panelManager/database
 * singletons are module-mocked; a fake db records prepared SQL so the stamp
 * statement can be inspected without a real sqlite file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'Cyboflow'),
    getVersion: vi.fn(() => '0.1.0'),
  },
}));

vi.mock('../../services/panelManager', () => ({
  panelManager: {
    getPanel: vi.fn(),
    getAllPanels: vi.fn(() => []),
    getPanelsForSession: vi.fn(() => []),
  },
}));

vi.mock('../../services/database', () => ({
  databaseService: { getSession: vi.fn(() => undefined) },
}));

import { registerSessionHandlers } from '../session';
import type { AppServices } from '../types';

type Handler = (...args: unknown[]) => Promise<unknown>;

function makeHandlerCapture() {
  const handlers = new Map<string, Handler>();
  const ipcMain = { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) };
  return { ipcMain, handlers };
}

function invoke(handlers: Map<string, Handler>, channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler for channel: ${channel}`);
  return fn({} as unknown, ...args);
}

interface DbRow {
  id: string;
  archived?: boolean;
  substrate?: string;
  chat_run_id?: string;
  worktree_name?: string;
  project_id?: number;
  is_main_repo?: boolean;
  name?: string;
}

function makeServices(dbSession: DbRow | undefined, opts?: { cancelThrows?: boolean }) {
  const preparedSql: string[] = [];
  const runCalls: Array<{ sql: string; args: unknown[] }> = [];
  let lastSql = '';
  const stmt = {
    run: (...args: unknown[]) => {
      runCalls.push({ sql: lastSql, args });
      return { changes: 1 };
    },
    get: () => undefined,
    all: () => [],
  };
  const fakeDb = {
    prepare: (sql: string) => {
      lastSql = sql;
      preparedSql.push(sql);
      return stmt;
    },
    transaction: <T>(fn: (...a: unknown[]) => T) => fn,
  };

  // archiveProgressManager.addTask receives the cleanup callback and runs it —
  // this is what actually invokes worktreeManager.removeWorktree, so ordering
  // relative to killLiveSession is observable.
  const removeWorktree = vi.fn(async () => {});
  const archiveProgressManager = {
    addTask: vi.fn((_sessionId: string, _name: string, _wt: string, _proj: string, cb: () => Promise<void>) => {
      void cb();
    }),
    updateTaskStatus: vi.fn(),
  };

  const killLiveSession = vi.fn(async () => {});
  const archiveSession = vi.fn(async () => {});
  const cancelHostedRuns = vi.fn(async () => {
    if (opts?.cancelThrows) throw new Error('cancel failed');
  });

  const services = {
    sessionManager: {
      archiveSession,
      addSessionOutput: vi.fn(),
    },
    databaseService: {
      getSession: vi.fn(() => dbSession),
      getProject: vi.fn(() => ({ id: dbSession?.project_id ?? 1, name: 'Proj', path: '/proj', worktree_folder: null })),
      getDb: () => fakeDb,
    },
    worktreeManager: { removeWorktree },
    killLiveSession,
    archiveProgressManager,
    cyboflow: { cancelHostedRuns },
    configManager: { isDemoMode: () => false },
  } as unknown as AppServices;

  return { services, killLiveSession, archiveSession, cancelHostedRuns, removeWorktree, runCalls, preparedSql };
}

function register(services: AppServices) {
  const { ipcMain, handlers } = makeHandlerCapture();
  registerSessionHandlers(ipcMain as unknown as Parameters<typeof registerSessionHandlers>[0], services);
  return handlers;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sessions:delete — guard rails', () => {
  it('returns success:false with no side effects when the session is missing', async () => {
    const made = makeServices(undefined);
    const handlers = register(made.services);

    const result = (await invoke(handlers, 'sessions:delete', 'ghost')) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe('Session not found');
    expect(made.cancelHostedRuns).not.toHaveBeenCalled();
    expect(made.archiveSession).not.toHaveBeenCalled();
  });

  it('returns success:false with no side effects when already archived', async () => {
    const made = makeServices({ id: 's1', archived: true });
    const handlers = register(made.services);

    const result = (await invoke(handlers, 'sessions:delete', 's1')) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe('Session is already archived');
    // None of the destructive/close-out steps run for an already-archived session.
    expect(made.cancelHostedRuns).not.toHaveBeenCalled();
    expect(made.killLiveSession).not.toHaveBeenCalled();
    expect(made.archiveSession).not.toHaveBeenCalled();
  });
});

describe('sessions:delete — interactive REPL kill ordering', () => {
  it('hard-kills the live REPL (by chat_run_id) BEFORE removing the worktree', async () => {
    const made = makeServices({
      id: 's1',
      substrate: 'interactive',
      chat_run_id: 'chat-run-9',
      worktree_name: 'wt-s1',
      project_id: 7,
      is_main_repo: false,
      name: 'sess',
    });
    const handlers = register(made.services);

    const result = (await invoke(handlers, 'sessions:delete', 's1')) as { success: boolean };
    expect(result.success).toBe(true);

    expect(made.killLiveSession).toHaveBeenCalledWith('chat-run-9');
    expect(made.removeWorktree).toHaveBeenCalledTimes(1);
    // Kill must precede the worktree teardown so the REPL's cwd isn't yanked mid-turn.
    expect(made.killLiveSession.mock.invocationCallOrder[0]).toBeLessThan(
      made.removeWorktree.mock.invocationCallOrder[0],
    );
  });

  it('does NOT kill a live REPL for an SDK-substrate session', async () => {
    const made = makeServices({
      id: 's1',
      substrate: 'sdk',
      chat_run_id: 'chat-run-9',
      is_main_repo: true, // main repo -> no worktree removal either
    });
    const handlers = register(made.services);

    await invoke(handlers, 'sessions:delete', 's1');
    expect(made.killLiveSession).not.toHaveBeenCalled();
  });
});

describe('sessions:delete — fail-soft close-out', () => {
  it('proceeds with archive + dismissed stamp even when cancelHostedRuns throws', async () => {
    const made = makeServices(
      { id: 's1', substrate: 'sdk', is_main_repo: true },
      { cancelThrows: true },
    );
    const handlers = register(made.services);

    const result = (await invoke(handlers, 'sessions:delete', 's1')) as { success: boolean };

    expect(made.cancelHostedRuns).toHaveBeenCalled();
    // A cancel failure is swallowed — the archive still happens...
    expect(made.archiveSession).toHaveBeenCalledWith('s1');
    // ...and the dismissed-outcome stamp still runs.
    const stamp = made.runCalls.find((c) => c.sql.includes('SET outcome') && c.args.includes('dismissed'));
    expect(stamp).toBeDefined();
    expect(result.success).toBe(true);
  });

  it('stamps outcome=dismissed via the guarded `outcome IS NULL` UPDATE (idempotent)', async () => {
    const made = makeServices({ id: 's1', substrate: 'sdk', is_main_repo: true });
    const handlers = register(made.services);

    await invoke(handlers, 'sessions:delete', 's1');

    const stamp = made.runCalls.find((c) => c.args.includes('dismissed'));
    expect(stamp).toBeDefined();
    // The WHERE guard is what makes a second dismiss a no-op — locking it here
    // prevents a regression that would clobber a run's own recorded outcome.
    expect(stamp?.sql).toContain('outcome IS NULL');
    expect(stamp?.args).toEqual(['dismissed', 's1']);
  });
});
