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
import { _resetClaimedQuickSessionIdsForTesting } from '../../services/createQuickSessionCore';

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

import {
  generateQuickWorktreeBranchName,
  registerSessionHandlers,
  QUICK_NAME_ADJECTIVES,
  QUICK_NAME_NOUNS,
} from '../session';
import { panelManager } from '../../services/panelManager';
import type { AppServices } from '../types';

// ---------------------------------------------------------------------------
// A. generateQuickWorktreeBranchName
// ---------------------------------------------------------------------------

describe('generateQuickWorktreeBranchName', () => {
  it('returns a deterministic adjective-noun-YYYYMMDD name for an injected rng + date', () => {
    // rng() is called twice: once for the adjective index, once for the noun
    // index. A constant 0 always selects the first entry of each list; the
    // date suffix uses UTC components of the injected instant.
    const result = generateQuickWorktreeBranchName(() => 0, new Date('2026-07-15T03:04:05Z'));
    expect(result).toBe('amber-alpaca-20260715');
  });

  it('matches the /^(quick-)?[a-z]+-[a-z]+-\\d{8}$/ shape for a default (Math.random / now) call', () => {
    const result = generateQuickWorktreeBranchName();
    expect(result).toMatch(/^(quick-)?[a-z]+-[a-z]+-\d{8}$/);
  });

  it('selects different words for different rng values', () => {
    const first = generateQuickWorktreeBranchName(() => 0);
    const second = generateQuickWorktreeBranchName(() => 0.999999);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^(quick-)?[a-z]+-[a-z]+-\d{8}$/);
    expect(second).toMatch(/^(quick-)?[a-z]+-[a-z]+-\d{8}$/);
  });

  it('word lists are large enough, lowercase-ascii-only, and duplicate-free', () => {
    expect(QUICK_NAME_ADJECTIVES.length).toBeGreaterThanOrEqual(40);
    expect(QUICK_NAME_NOUNS.length).toBeGreaterThanOrEqual(60);

    for (const word of [...QUICK_NAME_ADJECTIVES, ...QUICK_NAME_NOUNS]) {
      expect(word).toMatch(/^[a-z]+$/);
    }

    expect(new Set(QUICK_NAME_ADJECTIVES).size).toBe(QUICK_NAME_ADJECTIVES.length);
    expect(new Set(QUICK_NAME_NOUNS).size).toBe(QUICK_NAME_NOUNS.length);
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
  // The core's claim set spans the module lifetime; fixtures here reuse the
  // constant 'sess-001' id, so a stale claim would time out every later await.
  _resetClaimedQuickSessionIdsForTesting();
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

  // Each subscription emits a session with a UNIQUE id (sess-001, sess-002, …),
  // mirroring production where every create yields a distinct row — the handler's
  // claimed-session set (same-second dedup) would otherwise starve the second
  // invoke in double-invoke tests. The first emission keeps 'sess-001', which the
  // single-invoke assertions reference.
  let emitCount = 0;
  const fakeSessionManager = {
    on: (_event: string, cb: (s: unknown) => void) => {
      // Fire synchronously so the Promise inside the handler resolves immediately.
      emitCount += 1;
      cb(emitCount === 1 ? fakeSession : { ...fakeSession, id: `sess-${String(emitCount).padStart(3, '0')}` });
    },
    removeListener: vi.fn(),
    getSession: vi.fn(() => fakeSession),
    refreshSessionFromDatabase: vi.fn(() => fakeSession),
    updateSession: vi.fn(),
    addSessionOutput: vi.fn(),
    addPanelConversationMessage: vi.fn(),
    addPanelOutput: vi.fn(),
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

  const fakeCodexPtyManager = {
    isPanelRunning: vi.fn(() => false),
    relayUserTurn: vi.fn(),
    startPanel: vi.fn(() => new Promise<void>(() => {})),
    stopPanel: vi.fn(),
  };

  const fakeCodexSdkManager = {
    on: vi.fn(),
    isPanelRunning: vi.fn(() => false),
    spawnCliProcess: vi.fn(async () => undefined),
  };

  // At-spawn runId→panelId seed (facade.registerInteractivePanel) — the spawn
  // sites must call it BEFORE the fire-and-forget startPanel.
  const fakeRegisterLivePanel = vi.fn();
  const fakeRegisterCodexPtyPanel = vi.fn();

  const services = {
    sessionManager: fakeSessionManager,
    databaseService: fakeDatabaseService,
    taskQueue: fakeTaskQueue,
    worktreeManager: {},
    cliManagerFactory: {},
    claudeCodeManager: fakeClaudeCodeManager,
    interactiveCliManager: fakeInteractiveCliManager,
    codexSdkManager: fakeCodexSdkManager,
    codexPtyManager: fakeCodexPtyManager,
    endLiveSession: vi.fn(async () => {}),
    killLiveSession: vi.fn(async () => {}),
    registerLivePanel: fakeRegisterLivePanel,
    registerCodexPtyPanel: fakeRegisterCodexPtyPanel,
    gitStatusManager: {},
    archiveProgressManager: undefined,
    // Demo-mode probe used by the eager-spawn + sessions:input interactive
    // branches (gates the real PTY spawn/relay). Off in these tests so the live
    // interactive path runs as before. getQuickSessionWorktreeMode (migration 047)
    // is read by create-quick to decide worktree vs in-place — floored to 'worktree'
    // here so these tests exercise the ordinary worktree-backed path.
    configManager: { isDemoMode: () => false, getQuickSessionWorktreeMode: () => 'worktree' },
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
    fakeCodexSdkManager,
    fakeCodexPtyManager,
    fakeRegisterLivePanel,
    fakeRegisterCodexPtyPanel,
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

  it("threads the resolved host session id as createRun's 3rd (sessionId) arg", async () => {
    const { services, createRunArgs } = makeServices();
    const { ipcMain, handlers } = makeHandlerCapture();
    registerSessionHandlers(
      ipcMain as unknown as Parameters<typeof registerSessionHandlers>[0],
      services,
    );

    await invoke(handlers, 'sessions:create-quick', { projectId: 42, branchName: TEST_BRANCH });

    // Permission-mode redesign slice 1a: the sentinel run is now session-owned —
    // createRun receives session.id (was `undefined`) so it stamps
    // workflow_runs.session_id. fakeSession.id === 'sess-001'.
    expect(createRunArgs).toHaveLength(1);
    expect(createRunArgs[0][2]).toBe('sess-001');
  });

  it('no longer emits a standalone UPDATE workflow_runs SET session_id stamp (createRun owns it)', async () => {
    // The interactive-only conditional `UPDATE workflow_runs SET session_id` was
    // removed in slice 1a — createRun stamps session_id from the threaded
    // session.id for BOTH substrates, so neither path re-stamps it directly here.
    const sdk = makeServices();
    const interactive = makeServices({ resolvedSubstrateDefault: 'interactive' });

    for (const made of [sdk, interactive]) {
      const { ipcMain, handlers } = makeHandlerCapture();
      registerSessionHandlers(
        ipcMain as unknown as Parameters<typeof registerSessionHandlers>[0],
        made.services,
      );

      // Both iterations resolve the same constant 'sess-001' fixture id — clear
      // the core's claim set so the second create-quick await can resolve too.
      _resetClaimedQuickSessionIdsForTesting();
      await invoke(handlers, 'sessions:create-quick', { projectId: 42, branchName: TEST_BRANCH });

      const sessionIdStamps = made.dbRunCalls.filter((c) =>
        c.sql.includes('UPDATE workflow_runs SET session_id'),
      );
      expect(sessionIdStamps).toHaveLength(0);
    }
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
    const stamps = dbRunCalls.filter((c) => /UPDATE\s+sessions\s+SET\s+substrate/.test(c.sql));
    expect(stamps).toHaveLength(2);
    // The second invoke resolves the SECOND emitted session (the claimed-session
    // set hands each create-quick caller a distinct session).
    expect(stamps.map((c) => c.args)).toEqual([
      ['sdk', 'claude', 'claude-sdk', null, 'sess-001'],
      ['sdk', 'claude', 'claude-sdk', null, 'sess-002'],
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

    const stamp = dbRunCalls.find((c) => /UPDATE\s+sessions\s+SET\s+substrate/.test(c.sql));
    expect(stamp).toBeDefined();
    expect(stamp?.args).toEqual(['interactive', 'claude', 'claude-interactive', null, 'sess-001']);
  });

  it('drops stale Codex model values from Claude quick sessions and falls back to claudeConfig', async () => {
    const {
      services,
      dbRunCalls,
      fakeDatabaseService,
      fakeInteractiveCliManager,
    } = makeServices();
    const handlers = registerWith(services);

    await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      substrate: 'interactive',
      agentModel: 'gpt-5.5',
      claudeConfig: { model: 'sonnet', fastMode: true },
    });

    const stamp = dbRunCalls.find((c) => /UPDATE\s+sessions\s+SET\s+substrate/.test(c.sql));
    expect(stamp?.args).toEqual(['interactive', 'claude', 'claude-interactive', 'sonnet', 'sess-001']);
    expect(fakeDatabaseService.updatePanelSettings).toHaveBeenCalledWith('panel-quick-1', {
      model: 'sonnet',
      fastMode: true,
    });
    expect(fakeInteractiveCliManager.startPanel).toHaveBeenCalledWith(
      'panel-quick-1',
      'sess-001',
      `/tmp/project/${TEST_BRANCH}`,
      expect.stringContaining('cyboflow'),
      undefined,
      'sonnet',
      undefined,
      true,
    );
  });

  it('refreshes the session read model after stamping default agent fields', async () => {
    const { services, fakeSessionManager } = makeServices();
    const handlers = registerWith(services);

    await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      agentProvider: 'codex',
      agentRuntime: 'codex-pty',
      agentModel: 'gpt-5.5',
    });

    expect(fakeSessionManager.refreshSessionFromDatabase).toHaveBeenCalledWith('sess-001');
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
    // Second invoke → second emitted session (claimed-session set dedup).
    expect(stamps.map((c) => c.args)).toEqual([
      [null, 'sess-001'],
      [null, 'sess-002'],
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

    const stamp = dbRunCalls.find((c) => /UPDATE\s+sessions\s+SET\s+substrate/.test(c.sql));
    expect(stamp?.args).toEqual(['interactive', 'claude', 'claude-interactive', null, 'sess-001']);

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

  it('accepts codex-pty for quick sessions, stamps the session runtime, and eager-spawns Codex PTY', async () => {
    const {
      services,
      dbRunCalls,
      fakeCodexPtyManager,
      fakeInteractiveCliManager,
      fakeRegisterLivePanel,
      fakeRegisterCodexPtyPanel,
    } =
      makeServices();
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      agentProvider: 'codex',
      agentRuntime: 'codex-pty',
      agentModel: 'gpt-5.5',
    })) as { success: boolean; data?: { claudePanelId?: string } };

    expect(result.success).toBe(true);
    expect(result.data?.claudePanelId).toBe('panel-quick-1');

    const stamp = dbRunCalls.find((c) => /UPDATE\s+sessions\s+SET\s+substrate/.test(c.sql));
    expect(stamp?.args).toEqual(['interactive', 'codex', 'codex-pty', 'gpt-5.5', 'sess-001']);

    expect(vi.mocked(panelManager.createPanel)).toHaveBeenCalledWith({
      sessionId: 'sess-001',
      type: 'claude',
      title: 'Codex',
    });
    expect(fakeCodexPtyManager.startPanel).toHaveBeenCalledTimes(1);
    expect(fakeCodexPtyManager.startPanel).toHaveBeenCalledWith(
      'panel-quick-1',
      'sess-001',
      `/tmp/project/${TEST_BRANCH}`,
      expect.stringContaining('cyboflow'),
      undefined,
      'gpt-5.5',
      'test-run-id-abc',
    );
    expect(fakeInteractiveCliManager.startPanel).not.toHaveBeenCalled();
    expect(fakeRegisterLivePanel).not.toHaveBeenCalled();
    expect(fakeRegisterCodexPtyPanel).toHaveBeenCalledWith('test-run-id-abc', 'panel-quick-1');
    expect(fakeRegisterCodexPtyPanel.mock.invocationCallOrder[0]).toBeLessThan(
      fakeCodexPtyManager.startPanel.mock.invocationCallOrder[0],
    );
  });

  it('drops stale Claude model values from Codex PTY quick sessions', async () => {
    const {
      services,
      dbRunCalls,
      fakeCodexPtyManager,
      fakeDatabaseService,
    } = makeServices();
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      agentProvider: 'codex',
      agentRuntime: 'codex-pty',
      agentModel: 'opus',
    })) as { success: boolean; data?: { claudePanelId?: string } };

    expect(result.success).toBe(true);

    const stamp = dbRunCalls.find((c) => /UPDATE\s+sessions\s+SET\s+substrate/.test(c.sql));
    expect(stamp?.args).toEqual(['interactive', 'codex', 'codex-pty', null, 'sess-001']);
    expect(fakeDatabaseService.updatePanelSettings).not.toHaveBeenCalled();
    expect(fakeCodexPtyManager.startPanel).toHaveBeenCalledWith(
      'panel-quick-1',
      'sess-001',
      `/tmp/project/${TEST_BRANCH}`,
      expect.stringContaining('cyboflow'),
      undefined,
      undefined,
      'test-run-id-abc',
    );
  });

  it('accepts codex-sdk for quick sessions, stamps the session and sentinel, and waits for first input', async () => {
    const {
      services,
      dbRunCalls,
      fakeCodexPtyManager,
      fakeCodexSdkManager,
      fakeInteractiveCliManager,
    } = makeServices();
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      agentProvider: 'codex',
      agentRuntime: 'codex-sdk',
      agentModel: 'gpt-5.5',
    })) as { success: boolean; data?: { claudePanelId?: string } };

    expect(result.success).toBe(true);
    expect(result.data ?? {}).not.toHaveProperty('claudePanelId');
    const sessionStamp = dbRunCalls.find((c) => /UPDATE\s+sessions\s+SET\s+substrate/.test(c.sql));
    expect(sessionStamp?.args).toEqual(['sdk', 'codex', 'codex-sdk', 'gpt-5.5', 'sess-001']);
    const runStamp = dbRunCalls.find((c) => /UPDATE\s+workflow_runs\s+SET\s+agent_provider = 'codex'/.test(c.sql));
    expect(runStamp?.args).toEqual(['gpt-5.5', 'test-run-id-abc']);
    expect(fakeCodexSdkManager.spawnCliProcess).not.toHaveBeenCalled();
    expect(fakeCodexPtyManager.startPanel).not.toHaveBeenCalled();
    expect(fakeInteractiveCliManager.startPanel).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// B2. sessions:create-quick handler - worktree mode (migration 047)
// ---------------------------------------------------------------------------

describe('sessions:create-quick handler - worktree mode (migration 047)', () => {
  /** Swap the harness configManager for worktree-mode-specific fakes. */
  function swapConfigManager(services: AppServices, configManager: Record<string, unknown>): void {
    (services as unknown as { configManager: Record<string, unknown> }).configManager = configManager;
  }

  it('creates an IN-PLACE session for an explicit in-place request under the interactive substrate (inline --settings gate — no checkout writes)', async () => {
    const { services, fakeTaskQueue } = makeServices();
    swapConfigManager(services, {
      isDemoMode: () => false,
      getQuickSessionWorktreeMode: () => 'worktree',
      getDefaultSubstrate: () => undefined,
    });
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      worktreeMode: 'in-place',
      substrate: 'interactive',
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(true);
    const callArg = (fakeTaskQueue.createSession as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Record<string, unknown>;
    expect(callArg.inPlace).toBe(true);
    // Commit modes stay forced off regardless of substrate.
    expect(callArg.autoCommit).toBe(false);
    expect(callArg.commitMode).toBe('disabled');
  });

  it("honors an INHERITED in-place global default under the interactive substrate (no worktree fallback needed anymore)", async () => {
    const { services, fakeTaskQueue } = makeServices();
    swapConfigManager(services, {
      isDemoMode: () => false,
      getQuickSessionWorktreeMode: () => 'in-place',
      getDefaultSubstrate: () => undefined,
    });
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      substrate: 'interactive',
    })) as { success: boolean };

    expect(result.success).toBe(true);
    const callArg = (fakeTaskQueue.createSession as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Record<string, unknown>;
    expect(callArg.inPlace).toBe(true);
  });

  it('threads inPlace + forces commit modes off for an inherited in-place SDK create', async () => {
    const { services, fakeTaskQueue } = makeServices();
    swapConfigManager(services, {
      isDemoMode: () => false,
      getQuickSessionWorktreeMode: () => 'in-place',
      getDefaultSubstrate: () => undefined,
    });
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      autoCommit: true,
      commitMode: 'checkpoint',
    })) as { success: boolean };

    expect(result.success).toBe(true);
    const callArg = (fakeTaskQueue.createSession as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Record<string, unknown>;
    // In-place sessions share the user's real checkout: checkpoint auto-commit
    // must be forced off no matter what the request asked for.
    expect(callArg.inPlace).toBe(true);
    expect(callArg.autoCommit).toBe(false);
    expect(callArg.commitMode).toBe('disabled');
  });
});

// ---------------------------------------------------------------------------
// C. sessions:input handler - interactive relay branch vs the SDK path
// ---------------------------------------------------------------------------

describe('sessions:input handler - substrate routing', () => {
  const SESSION_ID = 'sess-001';
  const PANEL = { id: 'panel-1', sessionId: SESSION_ID, type: 'claude', state: {} };

  function setupInput(opts: { substrate?: string; agentRuntime?: string; replRunning?: boolean; codexRunning?: boolean; runId?: string }) {
    const made = makeServices();
    (made.fakeDatabaseService.getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: SESSION_ID,
      commit_mode: undefined,
      substrate: opts.substrate,
      agent_runtime: opts.agentRuntime,
      run_id: opts.runId,
      // For a quick session the chat-gate sentinel coincides with run_id (migration
      // 038 / §6). The interactive re-spawn now registers the chat_run_id sentinel
      // (Role-G), so the fixture carries it alongside run_id.
      chat_run_id: opts.runId,
    });
    vi.mocked(panelManager.getPanelsForSession).mockReturnValue(
      [PANEL] as unknown as ReturnType<typeof panelManager.getPanelsForSession>,
    );
    made.fakeInteractiveCliManager.isPanelRunning.mockReturnValue(opts.replRunning ?? false);
    made.fakeCodexPtyManager.isPanelRunning.mockReturnValue(opts.codexRunning ?? false);
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

  it('relays a codex-pty session turn into the live Codex PTY, never Claude managers', async () => {
    const {
      handlers,
      fakeCodexPtyManager,
      fakeInteractiveCliManager,
      fakeClaudeCodeManager,
      fakeSessionManager,
    } = setupInput({ agentRuntime: 'codex-pty', codexRunning: true });

    const result = (await invoke(handlers, 'sessions:input', SESSION_ID, 'hello codex')) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(fakeCodexPtyManager.relayUserTurn).toHaveBeenCalledWith('panel-1', 'hello codex');
    expect(fakeCodexPtyManager.startPanel).not.toHaveBeenCalled();
    expect(fakeInteractiveCliManager.relayUserTurn).not.toHaveBeenCalled();
    expect(fakeClaudeCodeManager.startPanel).not.toHaveBeenCalled();
    expect(fakeSessionManager.updateSession).toHaveBeenCalledWith(SESSION_ID, { status: 'running' });
  });

  it('re-spawns a dead codex-pty session fire-and-forget with the input as first prompt', async () => {
    const {
      handlers,
      fakeCodexPtyManager,
      fakeInteractiveCliManager,
      fakeClaudeCodeManager,
      fakeSessionManager,
    } = setupInput({ agentRuntime: 'codex-pty', codexRunning: false });

    const result = (await invoke(handlers, 'sessions:input', SESSION_ID, 'wake codex')) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(fakeCodexPtyManager.startPanel).toHaveBeenCalledWith(
      'panel-1',
      SESSION_ID,
      `/tmp/project/${TEST_BRANCH}`,
      'wake codex',
      undefined,
      undefined,
      undefined,
    );
    expect(fakeInteractiveCliManager.startPanel).not.toHaveBeenCalled();
    expect(fakeClaudeCodeManager.startPanel).not.toHaveBeenCalled();
    expect(fakeSessionManager.updateSession).toHaveBeenCalledWith(SESSION_ID, { status: 'running' });
  });

  it('routes a codex-sdk session turn through the structured Codex manager', async () => {
    const {
      handlers,
      fakeCodexSdkManager,
      fakeCodexPtyManager,
      fakeInteractiveCliManager,
      fakeClaudeCodeManager,
      fakeSessionManager,
      fakeDatabaseService,
    } = setupInput({ agentRuntime: 'codex-sdk', runId: 'run-quick-001' });
    fakeDatabaseService.getPanelSettings.mockReturnValue({ model: 'gpt-5.5' });

    const result = (await invoke(handlers, 'sessions:input', SESSION_ID, 'hello sdk')) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(fakeCodexSdkManager.spawnCliProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        panelId: 'panel-1',
        sessionId: SESSION_ID,
        runId: 'run-quick-001',
        worktreePath: `/tmp/project/${TEST_BRANCH}`,
        prompt: 'hello sdk',
        model: 'gpt-5.5',
        systemPromptAppend: expect.stringContaining('cyboflow'),
      }),
    );
    expect(fakeSessionManager.addPanelConversationMessage).toHaveBeenCalledWith('panel-1', 'user', 'hello sdk');
    expect(fakeSessionManager.updateSession).toHaveBeenCalledWith(SESSION_ID, { status: 'running' });
    expect(fakeCodexPtyManager.startPanel).not.toHaveBeenCalled();
    expect(fakeInteractiveCliManager.startPanel).not.toHaveBeenCalled();
    expect(fakeClaudeCodeManager.startPanel).not.toHaveBeenCalled();
  });
});
