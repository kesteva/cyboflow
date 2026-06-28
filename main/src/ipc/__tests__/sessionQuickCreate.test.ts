/**
 * Unit tests for the sessions:create-quick / sessions:input IPC handlers and
 * the pure generateQuickWorktreeBranchName helper exported from session.ts.
 *
 * Sections:
 *  A. generateQuickWorktreeBranchName -- pure UTC-timestamp helper (3 tests).
 *  B. sessions:create-quick handler -- workflow_runs pipeline integration,
 *     substrate threading, and the interactive eager PTY spawn.
 *  C. sessions:input handler -- interactive-substrate relay branch vs the
 *     byte-identical SDK path.
 *
 * For sections B/C the full handlers are exercised via a lightweight
 * handler-capture harness that replaces the Electron IPC stack.  All service
 * collaborators are stubbed at the object level; no real SQLite DB is used.
 *
 * Important: create-quick requests must include an explicit branchName so the
 * listener path-match check inside the handler resolves against a known value.
 * Without it the handler generates a timestamp-derived name that won't match
 * the stub's worktreePath and the 30-second timeout fires.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// panelManager uses IPC at module load time - stub it. createPanel /
// getPanelsForSession back the create-quick eager spawn and sessions:input
// panel resolution; tests override them per-case via vi.mocked().
vi.mock('../../services/panelManager', () => ({
  panelManager: {
    getPanel: vi.fn(),
    getAllPanels: vi.fn(() => []),
    getPanelsForSession: vi.fn(() => []),
    createPanel: vi.fn(async (req: { sessionId: string }) => ({
      id: 'panel-quick-1',
      sessionId: req.sessionId,
      type: 'claude',
      state: {},
    })),
  },
}));

// The databaseService SINGLETON (services/database) backs validateSessionIsActive
// inside sessions:input. Mocked so the module never opens a real sqlite file and
// the validation deterministically passes for the test session.
vi.mock('../../services/database', () => ({
  databaseService: {
    getSession: vi.fn(() => ({ id: 'sess-001', status: 'running', archived: false })),
  },
}));

import { generateQuickWorktreeBranchName, registerSessionHandlers } from '../session';
import { panelManager } from '../../services/panelManager';
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
  ...args: unknown[]
): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for channel: ${channel}`);
  return fn({} as unknown, ...args);
}

// Reset the shared module-level panelManager mocks between tests. createPanel
// keeps its factory default implementation (mockClear, not mockReset);
// getPanelsForSession is restored to the empty default.
beforeEach(() => {
  vi.mocked(panelManager.createPanel).mockClear();
  vi.mocked(panelManager.getPanelsForSession).mockReset();
  vi.mocked(panelManager.getPanelsForSession).mockReturnValue([]);
});

function makeServices(opts?: {
  /**
   * What the fake registry's resolution ladder yields when the REQUESTED
   * substrate is absent — models WorkflowRegistry.createRun resolving
   * 'interactive' via the global default / CYBOFLOW_SUBSTRATE even though the
   * request carried no substrate. Defaults to 'sdk' (the ladder floor).
   */
  resolvedSubstrateDefault?: 'sdk' | 'interactive';
}) {
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
  const createRunArgs: unknown[][] = [];
  const fakeWorkflowRegistry = {
    ensureQuickWorkflow: (projectId: number) => {
      ensureQuickWorkflowCalls.push(projectId);
      return `wf-${projectId}-__quick__`;
    },
    createRun: (...args: unknown[]) => {
      createRunArgs.push(args);
      createRunCalls.push(args[0] as string);
      // Mirror the real createRun resolution ladder shape: the explicit
      // REQUESTED substrate wins; an absent request falls through to the
      // configurable "global default" rung (resolvedSubstrateDefault), floor 'sdk'.
      const requested = args[1] as 'sdk' | 'interactive' | undefined;
      return {
        runId: 'test-run-id-abc',
        permissionMode: 'default' as const,
        substrate: requested ?? opts?.resolvedSubstrateDefault ?? ('sdk' as const),
      };
    },
  };

  // Fake session whose worktreePath ends with TEST_BRANCH so the handler's
  // path-match resolves successfully without waiting for the 30-second timeout.
  const fakeSession = {
    id: 'sess-001',
    worktreePath: `/tmp/project/${TEST_BRANCH}`,
    status: 'stopped',
    toolType: 'claude',
  };

  const fakeSessionManager = {
    on: (_event: string, cb: (s: unknown) => void) => {
      // Fire synchronously so the Promise inside the handler resolves immediately.
      cb(fakeSession);
    },
    removeListener: vi.fn(),
    getSession: vi.fn(() => fakeSession),
    updateSession: vi.fn(),
    addSessionOutput: vi.fn(),
  };

  const fakeTaskQueue = {
    createSession: vi.fn().mockResolvedValue({ id: 'job-001' }),
  };

  const fakeDatabaseService = {
    getProject: (_id: number) => ({ id: 42, name: 'TestProject', path: '/proj' }),
    getDb: () => fakeDb,
    // sessions:input reads the db row for commit-mode + substrate routing.
    getSession: vi.fn(() => ({ id: 'sess-001', commit_mode: undefined, substrate: undefined })),
    // sessions:input reads per-panel launch config (model + fast mode) to thread
    // into the respawn; create-quick (interactive) persists it. Empty by default.
    getPanelSettings: vi.fn(() => ({})),
    updatePanelSettings: vi.fn(),
  };

  // SDK manager — the interactive branch must NEVER touch it.
  const fakeClaudeCodeManager = {
    isPanelRunning: vi.fn(() => false),
    startPanel: vi.fn(),
    sendInput: vi.fn(),
  };

  // Interactive (PTY) manager. startPanel returns a NEVER-settling promise to
  // enforce the persistent-session contract: the handlers must fire-and-forget
  // it (an await would deadlock the test the same way it would the app).
  const fakeInteractiveCliManager = {
    isPanelRunning: vi.fn(() => false),
    relayUserTurn: vi.fn(),
    startPanel: vi.fn(() => new Promise<void>(() => {})),
  };

  // At-spawn runId→panelId seed (facade.registerInteractivePanel) — the spawn
  // sites must call it BEFORE the fire-and-forget startPanel.
  const fakeRegisterLivePanel = vi.fn();

  const services = {
    sessionManager: fakeSessionManager,
    databaseService: fakeDatabaseService,
    taskQueue: fakeTaskQueue,
    worktreeManager: {},
    cliManagerFactory: {},
    claudeCodeManager: fakeClaudeCodeManager,
    interactiveCliManager: fakeInteractiveCliManager,
    endLiveSession: vi.fn(async () => {}),
    killLiveSession: vi.fn(async () => {}),
    registerLivePanel: fakeRegisterLivePanel,
    gitStatusManager: {},
    archiveProgressManager: undefined,
    // Demo-mode probe used by the eager-spawn + sessions:input interactive
    // branches (gates the real PTY spawn/relay). Off in these tests so the live
    // interactive path runs as before.
    configManager: { isDemoMode: () => false },
    cyboflow: {
      workflowRegistry: fakeWorkflowRegistry,
      runLauncher: {},
    },
  } as unknown as AppServices;

  return {
    services,
    dbRunCalls,
    ensureQuickWorkflowCalls,
    createRunCalls,
    createRunArgs,
    fakeTaskQueue,
    fakeSessionManager,
    fakeDatabaseService,
    fakeClaudeCodeManager,
    fakeInteractiveCliManager,
    fakeRegisterLivePanel,
  };
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

// ---------------------------------------------------------------------------
// B (cont.) sessions:create-quick - substrate threading + eager PTY spawn
// ---------------------------------------------------------------------------

function registerWith(services: AppServices) {
  const { ipcMain, handlers } = makeHandlerCapture();
  registerSessionHandlers(
    ipcMain as unknown as Parameters<typeof registerSessionHandlers>[0],
    services,
  );
  return handlers;
}

describe('sessions:create-quick handler - substrate threading + eager PTY spawn', () => {
  it('threads a valid request.substrate into createRun as the 2nd arg', async () => {
    const { services, createRunArgs } = makeServices();
    const handlers = registerWith(services);

    await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      substrate: 'interactive',
    });

    expect(createRunArgs).toHaveLength(1);
    expect(createRunArgs[0][1]).toBe('interactive');
  });

  it('passes undefined substrate to createRun for an absent or invalid value', async () => {
    const { services, createRunArgs, dbRunCalls } = makeServices();
    const handlers = registerWith(services);

    await invoke(handlers, 'sessions:create-quick', { projectId: 42, branchName: TEST_BRANCH });
    await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      substrate: 'bogus',
    });

    expect(createRunArgs[0][1]).toBeUndefined();
    expect(createRunArgs[1][1]).toBeUndefined();
    // The invalid value is never persisted — sessions.substrate is ALWAYS
    // stamped with the RESOLVED value from createRun ('sdk' here), never the
    // raw request value.
    const stamps = dbRunCalls.filter((c) => c.sql.includes('UPDATE sessions SET substrate'));
    expect(stamps).toHaveLength(2);
    expect(stamps.map((c) => c.args)).toEqual([
      ['sdk', 'sess-001'],
      ['sdk', 'sess-001'],
    ]);
  });

  it('stamps the session worktree onto the sentinel run for EVERY quick session', async () => {
    const { services, dbRunCalls } = makeServices();
    const handlers = registerWith(services);

    await invoke(handlers, 'sessions:create-quick', { projectId: 42, branchName: TEST_BRANCH });

    const stamp = dbRunCalls.find((c) =>
      c.sql.includes('UPDATE workflow_runs SET worktree_path'),
    );
    expect(stamp).toBeDefined();
    expect(stamp?.args).toEqual([`/tmp/project/${TEST_BRANCH}`, 'test-run-id-abc']);
  });

  it('persists sessions.substrate when an interactive substrate is chosen', async () => {
    const { services, dbRunCalls } = makeServices();
    const handlers = registerWith(services);

    await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      substrate: 'interactive',
    });

    const stamp = dbRunCalls.find((c) => c.sql.includes('UPDATE sessions SET substrate'));
    expect(stamp).toBeDefined();
    expect(stamp?.args).toEqual(['interactive', 'sess-001']);
  });

  it('persists sessions.effort = ultracode when the Ultracode card is chosen (migration 029)', async () => {
    const { services, dbRunCalls } = makeServices();
    const handlers = registerWith(services);

    await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      substrate: 'interactive',
      effort: 'ultracode',
    });

    const stamp = dbRunCalls.find((c) => c.sql.includes('UPDATE sessions SET effort'));
    expect(stamp).toBeDefined();
    expect(stamp?.args).toEqual(['ultracode', 'sess-001']);
  });

  it('stamps sessions.effort = null for a non-ultracode (or invalid effort) quick session', async () => {
    const { services, dbRunCalls } = makeServices();
    const handlers = registerWith(services);

    await invoke(handlers, 'sessions:create-quick', { projectId: 42, branchName: TEST_BRANCH });
    await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      effort: 'bogus',
    });

    const stamps = dbRunCalls.filter((c) => c.sql.includes('UPDATE sessions SET effort'));
    expect(stamps).toHaveLength(2);
    expect(stamps.map((c) => c.args)).toEqual([
      [null, 'sess-001'],
      [null, 'sess-001'],
    ]);
  });

  it('eagerly spawns the interactive REPL (fire-and-forget) and returns claudePanelId', async () => {
    const { services, fakeInteractiveCliManager, fakeSessionManager, fakeRegisterLivePanel } =
      makeServices();
    const handlers = registerWith(services);

    // Resolves even though the stubbed startPanel NEVER settles — proof the
    // handler does not await the persistent spawn promise (the deadlock trap).
    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      substrate: 'interactive',
    })) as { success: boolean; data?: { claudePanelId?: string } };

    expect(result.success).toBe(true);
    expect(result.data?.claudePanelId).toBe('panel-quick-1');

    expect(vi.mocked(panelManager.createPanel)).toHaveBeenCalledWith({
      sessionId: 'sess-001',
      type: 'claude',
      title: 'Claude',
    });
    expect(fakeInteractiveCliManager.startPanel).toHaveBeenCalledTimes(1);
    const [panelId, sessionId, worktreePath, briefing] =
      fakeInteractiveCliManager.startPanel.mock.calls[0] as unknown as [string, string, string, string];
    expect(panelId).toBe('panel-quick-1');
    expect(sessionId).toBe('sess-001');
    expect(worktreePath).toBe(`/tmp/project/${TEST_BRANCH}`);
    expect(briefing).toContain('cyboflow');
    // That keyword is the USER's to type — never cyboflow-authored prompt text.
    expect(briefing).not.toMatch(/ultracode/i);

    expect(fakeSessionManager.updateSession).toHaveBeenCalledWith('sess-001', { status: 'running' });

    // At-spawn runId→panelId registration fires BEFORE the fire-and-forget
    // startPanel (deterministic facade translation — no first-PTY-byte race).
    expect(fakeRegisterLivePanel).toHaveBeenCalledWith('test-run-id-abc', 'panel-quick-1');
    expect(fakeRegisterLivePanel.mock.invocationCallOrder[0]).toBeLessThan(
      fakeInteractiveCliManager.startPanel.mock.invocationCallOrder[0],
    );
  });

  it("eager-spawns + stamps when the registry RESOLVES 'interactive' from the global default (no requested substrate)", async () => {
    // request.substrate is undefined, but createRun's resolution ladder
    // (global default / CYBOFLOW_SUBSTRATE) yields 'interactive' — the session
    // stamp and the eager-spawn gate must follow the RESOLVED value, or the
    // run row says interactive while the session behaves SDK.
    const { services, fakeInteractiveCliManager, dbRunCalls, fakeRegisterLivePanel } =
      makeServices({ resolvedSubstrateDefault: 'interactive' });
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
    })) as { success: boolean; data?: { claudePanelId?: string } };

    expect(result.success).toBe(true);
    expect(result.data?.claudePanelId).toBe('panel-quick-1');

    const stamp = dbRunCalls.find((c) => c.sql.includes('UPDATE sessions SET substrate'));
    expect(stamp?.args).toEqual(['interactive', 'sess-001']);

    expect(fakeInteractiveCliManager.startPanel).toHaveBeenCalledTimes(1);
    expect(fakeRegisterLivePanel).toHaveBeenCalledWith('test-run-id-abc', 'panel-quick-1');
  });

  it('does not create a panel or return claudePanelId on the SDK path', async () => {
    const { services, fakeInteractiveCliManager, fakeRegisterLivePanel } = makeServices();
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
    })) as { success: boolean; data?: Record<string, unknown> };

    expect(result.success).toBe(true);
    expect(vi.mocked(panelManager.createPanel)).not.toHaveBeenCalled();
    expect(fakeInteractiveCliManager.startPanel).not.toHaveBeenCalled();
    expect(fakeRegisterLivePanel).not.toHaveBeenCalled();
    expect(result.data ?? {}).not.toHaveProperty('claudePanelId');
  });
});

// ---------------------------------------------------------------------------
// C. sessions:input handler - interactive relay branch vs the SDK path
// ---------------------------------------------------------------------------

describe('sessions:input handler - substrate routing', () => {
  const SESSION_ID = 'sess-001';
  const PANEL = { id: 'panel-1', sessionId: SESSION_ID, type: 'claude', state: {} };

  function setupInput(opts: { substrate?: string; replRunning?: boolean; runId?: string }) {
    const made = makeServices();
    (made.fakeDatabaseService.getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: SESSION_ID,
      commit_mode: undefined,
      substrate: opts.substrate,
      run_id: opts.runId,
    });
    vi.mocked(panelManager.getPanelsForSession).mockReturnValue(
      [PANEL] as unknown as ReturnType<typeof panelManager.getPanelsForSession>,
    );
    made.fakeInteractiveCliManager.isPanelRunning.mockReturnValue(opts.replRunning ?? false);
    const handlers = registerWith(made.services);
    return { ...made, handlers };
  }

  it('relays an interactive session turn into the live REPL, never the SDK manager', async () => {
    const {
      handlers,
      fakeInteractiveCliManager,
      fakeClaudeCodeManager,
      fakeSessionManager,
      fakeRegisterLivePanel,
    } = setupInput({ substrate: 'interactive', replRunning: true });

    const result = (await invoke(handlers, 'sessions:input', SESSION_ID, 'hello repl')) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(fakeInteractiveCliManager.relayUserTurn).toHaveBeenCalledWith('panel-1', 'hello repl');
    expect(fakeInteractiveCliManager.startPanel).not.toHaveBeenCalled();
    // Only the SPAWN sites seed the facade mapping — a live-REPL relay doesn't.
    expect(fakeRegisterLivePanel).not.toHaveBeenCalled();
    // The SDK manager is byte-untouched on the interactive branch.
    expect(fakeClaudeCodeManager.isPanelRunning).not.toHaveBeenCalled();
    expect(fakeClaudeCodeManager.startPanel).not.toHaveBeenCalled();
    expect(fakeClaudeCodeManager.sendInput).not.toHaveBeenCalled();
    // The new turn re-enters 'running' so the turn-end rest has an edge to flip.
    expect(fakeSessionManager.updateSession).toHaveBeenCalledWith(SESSION_ID, { status: 'running' });
  });

  it('re-spawns a dead interactive REPL fire-and-forget with the input as first prompt', async () => {
    const {
      handlers,
      fakeInteractiveCliManager,
      fakeClaudeCodeManager,
      fakeSessionManager,
      fakeRegisterLivePanel,
    } = setupInput({ substrate: 'interactive', replRunning: false, runId: 'run-quick-001' });

    // Resolves even though the stubbed startPanel NEVER settles — the handler
    // must not await the persistent spawn promise.
    const result = (await invoke(handlers, 'sessions:input', SESSION_ID, 'wake up')) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(fakeInteractiveCliManager.relayUserTurn).not.toHaveBeenCalled();
    expect(fakeInteractiveCliManager.startPanel).toHaveBeenCalledWith(
      'panel-1',
      SESSION_ID,
      `/tmp/project/${TEST_BRANCH}`,
      'wake up',
      undefined, // permissionMode
      undefined, // model — no persisted panel settings in this test
      undefined, // effort — a respawn carries no ultracode card setting
      false, // fastMode — default off (no persisted opt-in)
      undefined, // resumeSessionId — fresh respawn (resume not armed for this session)
    );
    expect(fakeClaudeCodeManager.startPanel).not.toHaveBeenCalled();
    expect(fakeSessionManager.updateSession).toHaveBeenCalledWith(SESSION_ID, { status: 'running' });

    // At-spawn runId→panelId registration (mirrors create-quick) fires BEFORE
    // the fire-and-forget startPanel — no first-PTY-byte race.
    expect(fakeRegisterLivePanel).toHaveBeenCalledWith('run-quick-001', 'panel-1');
    expect(fakeRegisterLivePanel.mock.invocationCallOrder[0]).toBeLessThan(
      fakeInteractiveCliManager.startPanel.mock.invocationCallOrder[0],
    );
  });

  it('keeps the SDK path for sessions without an interactive substrate', async () => {
    const { handlers, fakeInteractiveCliManager, fakeClaudeCodeManager } = setupInput({
      substrate: undefined,
    });

    const result = (await invoke(handlers, 'sessions:input', SESSION_ID, 'sdk turn')) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(fakeClaudeCodeManager.isPanelRunning).toHaveBeenCalledWith('panel-1');
    expect(fakeClaudeCodeManager.startPanel).toHaveBeenCalled();
    expect(fakeInteractiveCliManager.relayUserTurn).not.toHaveBeenCalled();
    expect(fakeInteractiveCliManager.startPanel).not.toHaveBeenCalled();
  });
});
