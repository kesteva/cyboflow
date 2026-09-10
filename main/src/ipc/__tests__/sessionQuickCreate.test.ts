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

// Design Mode's Claude/SDK availability pre-flight (design-mode.md "Session
// plumbing — SDK-pinned, fail-closed") calls these directly (they are not
// service-injected). Mocked to a deterministic "available" default so the
// design-branch happy-path tests below never touch the real Keychain/`claude`
// binary; individual tests override via mockResolvedValueOnce for the
// unavailable-Claude negative case.
vi.mock('../../utils/claudeCredentials', () => ({
  detectClaudeCredentials: vi.fn(async () => ({ found: true, source: 'keychain', account: null })),
}));
vi.mock('../../utils/claudeCodeTest', () => ({
  detectClaudeBinary: vi.fn(async () => ({ found: true, path: '/usr/local/bin/claude', version: '1.0.0' })),
}));
// Design-mode v0.5 re-entry stub: the design branch mints a bytes-less
// ui-prototype artifact through the real ArtifactRouter singleton — mock the
// singleton so the create is assertable (and so the fail-soft catch is not
// exercised by an uninitialized-singleton throw on every design test).
const artifactApplyMock = vi.fn(async () => ({ artifactId: 'art-stub-1' }));
vi.mock('../../orchestrator/artifactRouter', () => ({
  ArtifactRouter: { getInstance: () => ({ apply: artifactApplyMock }) },
}));

// Per-panel resume identity (migration 087): a structured chat turn resumes the
// panel's OWN provider thread. Mocked so a test can hand the turn a target of a
// chosen provider/runtime; the default (null) is a fresh thread.
interface ResumeTargetStub {
  provider: string;
  runtime: string;
  externalSessionId: string;
}
const resumeTargetMock = vi.fn<() => ResumeTargetStub | null>(() => null);
vi.mock('../../orchestrator/agentInvocationStore', () => ({
  AgentInvocationStore: class {
    getLatestPanelResumeTarget(): ResumeTargetStub | null {
      return resumeTargetMock();
    }
    getLatestTopLevelResumeTarget(): ResumeTargetStub | null {
      return null;
    }
  },
}));

import {
  generateQuickWorktreeBranchName,
  registerSessionHandlers,
  QUICK_NAME_ADJECTIVES,
  QUICK_NAME_NOUNS,
} from '../session';
import { panelManager } from '../../services/panelManager';
import { detectClaudeCredentials } from '../../utils/claudeCredentials';
import { detectClaudeBinary } from '../../utils/claudeCodeTest';
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
  vi.mocked(panelManager.getPanel).mockReset();
  vi.mocked(panelManager.getPanelsForSession).mockReset();
  vi.mocked(panelManager.getPanelsForSession).mockReturnValue([]);
  // The core's claim set spans the module lifetime; fixtures here reuse the
  // constant 'sess-001' id, so a stale claim would time out every later await.
  _resetClaimedQuickSessionIdsForTesting();
  resumeTargetMock.mockReturnValue(null);
});

function makeServices(opts?: {
  /**
   * What the fake registry's resolution ladder yields when the REQUESTED
   * substrate is absent — models WorkflowRegistry.createRun resolving
   * 'interactive' via the global default / CYBOFLOW_SUBSTRATE even though the
   * request carried no substrate. Defaults to 'sdk' (the ladder floor).
   */
  resolvedSubstrateDefault?: 'sdk' | 'interactive';
  /**
   * Design Mode (design-mode.md "Idea link — integrity contract"): what the
   * fake db returns for validateDesignIdeaLink's
   * `SELECT ... FROM ideas WHERE id = ?`. undefined = idea not found.
   */
  ideaRow?: { project_id: number; decomposed_at: string | null; archived_at: string | null };
  /**
   * Design Mode belt-guard test knob: when set, the fake registry's createRun
   * IGNORES the requested substrate and always resolves to this value —
   * simulating a config race that defeats the requireSdkSubstrate guard (the
   * fake, unlike the real WorkflowRegistry, does not itself implement that
   * guard) so the IPC handler's own post-resolution assert can be exercised.
   */
  forceResolvedSubstrate?: 'sdk' | 'interactive';
  /** configManager.isInteractivePtyOnly() — the design pre-flight's 2nd gate. */
  interactivePtyOnly?: boolean;
  /**
   * Settings → Integrations / onboarding Connect provider toggles. Defaults to
   * both providers ON, so every existing test keeps its byte-identical path.
   */
  providerAccess?: { claude?: boolean; codex?: boolean; omp?: boolean };
}) {
  const dbRunCalls: Array<{ sql: string; args: unknown[] }> = [];
  let lastPreparedSql = '';
  const fakeStmt = {
    run: (...args: unknown[]) => {
      dbRunCalls.push({ sql: lastPreparedSql, args });
      return { changes: 1, lastInsertRowid: 1 };
    },
    get: (..._args: unknown[]) => (lastPreparedSql.includes('FROM ideas') ? opts?.ideaRow : undefined),
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
      // forceResolvedSubstrate overrides even an explicit request — the fake
      // does not itself implement WorkflowRegistry's requireSdkSubstrate
      // throw, so this is how Design Mode belt-guard tests simulate a config
      // race defeating that guard.
      const requested = args[1] as 'sdk' | 'interactive' | undefined;
      return {
        runId: 'test-run-id-abc',
        permissionMode: 'default' as const,
        substrate: opts?.forceResolvedSubstrate ?? requested ?? opts?.resolvedSubstrateDefault ?? ('sdk' as const),
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
    addSessionError: vi.fn(),
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
    getSession: vi.fn(() => ({ id: 'sess-001', substrate: undefined })),
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

  const fakeOmpPtyManager = {
    isPanelRunning: vi.fn(() => false),
    relayUserTurn: vi.fn(),
    startPanel: vi.fn(() => new Promise<void>(() => {})),
    stopPanel: vi.fn(),
    on: vi.fn(),
  };

  const codexListeners = new Map<string, (payload: Record<string, unknown>) => void>();
  const fakeCodexSdkManager = {
    on: vi.fn((event: string, listener: (payload: Record<string, unknown>) => void) => {
      codexListeners.set(event, listener);
    }),
    isPanelRunning: vi.fn(() => false),
    spawnCliProcess: vi.fn(async () => undefined),
  };
  const emitCodex = (event: string, payload: Record<string, unknown>): void => {
    codexListeners.get(event)?.(payload);
  };

  const ompListeners = new Map<string, (payload: Record<string, unknown>) => void>();
  const fakeOmpSdkManager = {
    on: vi.fn((event: string, listener: (payload: Record<string, unknown>) => void) => {
      ompListeners.set(event, listener);
    }),
    isPanelRunning: vi.fn(() => false),
    spawnCliProcess: vi.fn(async (_options: Record<string, unknown>) => undefined),
    stopPanel: vi.fn(),
  };
  const emitOmp = (event: string, payload: Record<string, unknown>): void => {
    ompListeners.get(event)?.(payload);
  };

  // At-spawn runId→panelId seed (facade.registerInteractivePanel) — the spawn
  // sites must call it BEFORE the fire-and-forget startPanel.
  const fakeRegisterLivePanel = vi.fn();
  const fakeRegisterCodexPtyPanel = vi.fn();
  const fakeRegisterOmpPtyPanel = vi.fn();

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
    ompSdkManager: fakeOmpSdkManager,
    ompPtyManager: fakeOmpPtyManager,
    endLiveSession: vi.fn(async () => {}),
    killLiveSession: vi.fn(async () => {}),
    registerLivePanel: fakeRegisterLivePanel,
    registerCodexPtyPanel: fakeRegisterCodexPtyPanel,
    registerOmpPtyPanel: fakeRegisterOmpPtyPanel,
    gitStatusManager: {},
    archiveProgressManager: undefined,
    // Demo-mode probe used by the eager-spawn + sessions:input interactive
    // branches (gates the real PTY spawn/relay). Off in these tests so the live
    // interactive path runs as before. getQuickSessionWorktreeMode (migration 047)
    // is read by create-quick to decide worktree vs in-place — floored to 'worktree'
    // here so these tests exercise the ordinary worktree-backed path.
    // isInteractivePtyOnly/getConfig back the Design Mode pre-flight
    // (design-mode.md); interactivePtyOnly defaults false so non-design and
    // happy-path design tests aren't gated, and opts.interactivePtyOnly opts a
    // test into the locked-down case.
    configManager: {
      isDemoMode: () => false,
      getQuickSessionWorktreeMode: () => 'worktree',
      isInteractivePtyOnly: () => opts?.interactivePtyOnly === true,
      getConfig: () => ({}),
      // Provider-access gate (Settings → Integrations toggles). Both providers on
      // unless a test opts out, so the launch path stays byte-identical here.
      // OMP is absent⇒DISABLED by policy, so it is only on when a test says so.
      getAgentProviderAccess: () => opts?.providerAccess ?? { claude: true, codex: true },
      isAgentProviderEnabled: (provider: 'claude' | 'codex' | 'omp') =>
        (opts?.providerAccess ?? { claude: true, codex: true })[provider] ?? provider !== 'omp',
    },
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
    emitCodex,
    fakeCodexPtyManager,
    fakeOmpSdkManager,
    emitOmp,
    fakeOmpPtyManager,
    fakeRegisterLivePanel,
    fakeRegisterCodexPtyPanel,
    fakeRegisterOmpPtyPanel,
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
      ['sdk', 'claude-sdk', 'sess-001'],
      ['sdk', 'claude-sdk', 'sess-002'],
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
    expect(stamp?.args).toEqual(['interactive', 'claude-interactive', 'sess-001']);
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
    expect(stamp?.args).toEqual(['interactive', 'claude-interactive', 'sess-001']);
    expect(fakeDatabaseService.updatePanelSettings).toHaveBeenCalledWith('panel-quick-1', {
      model: 'sonnet',
      fastMode: true,
    });
    expect(fakeInteractiveCliManager.startPanel).toHaveBeenCalledWith(
      'panel-quick-1',
      'sess-001',
      `/tmp/project/${TEST_BRANCH}`,
      '', // prompt — the eager spawn opens an idle REPL, it starts no turn
      undefined,
      'sonnet',
      undefined,
      true,
      undefined, // resumeSessionId — fresh eager spawn, not a resume
      undefined, // reasoningEffort — no persisted setting in this test
      undefined, // userAcknowledgedProviderDisabled — not a resume prompt
      expect.stringContaining('cyboflow'), // systemPromptAppend — the briefing
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

  it('surfaces a failed eager interactive spawn as a session error, not a blank terminal', async () => {
    // The regression this guards (CYBOFLOW-APP-1E): a `claude` that is not on
    // PATH rejected the fire-and-forget spawn, create-quick had already returned
    // success + a claudePanelId, and the user got a terminal that never emitted
    // a byte with no error on any surface.
    const { services, fakeInteractiveCliManager, fakeSessionManager } = makeServices();
    fakeInteractiveCliManager.startPanel.mockRejectedValueOnce(
      new Error('Claude Code (Interactive) not available: claude executable not found in PATH'),
    );
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      substrate: 'interactive',
    })) as { success: boolean };

    // The door still succeeds — the spawn is fail-soft by design.
    expect(result.success).toBe(true);

    expect(fakeSessionManager.addSessionError).toHaveBeenCalledTimes(1);
    const [erroredSessionId, headline, details] = fakeSessionManager.addSessionError.mock
      .calls[0] as unknown as [string, string, string];
    expect(erroredSessionId).toBe('sess-001');
    // Copy keyed off the BOUNDED error class, naming the one thing the user can fix.
    expect(headline).toBe('claude not found');
    expect(details).toContain('PATH');
    expect(details).toContain('Settings');

    // …and the status must END as 'error'. The rejection lands inside the
    // microtask window the 'running' write opens, so without the re-assert the
    // running write silently wins and the session looks healthy.
    const statuses = fakeSessionManager.updateSession.mock.calls
      .filter((c) => (c as unknown as [string, { status?: string }])[0] === 'sess-001')
      .map((c) => (c as unknown as [string, { status?: string }])[1]?.status);
    // The idle-REPL write ('stopped' — the spawn starts no turn) is what the
    // rejection races; without the re-assert it would silently win.
    expect(statuses).toContain('stopped');
    expect(statuses[statuses.length - 1]).toBe('error');
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
      title: 'Chat',
    });
    expect(fakeInteractiveCliManager.startPanel).toHaveBeenCalledTimes(1);
    const spawnArgs = fakeInteractiveCliManager.startPanel.mock.calls[0] as unknown as unknown[];
    const [panelId, sessionId, worktreePath, prompt] = spawnArgs as [string, string, string, string];
    const briefing = spawnArgs[11] as string;
    expect(panelId).toBe('panel-quick-1');
    expect(sessionId).toBe('sess-001');
    expect(worktreePath).toBe(`/tmp/project/${TEST_BRANCH}`);
    // The briefing is session CONTEXT and rides --append-system-prompt: it must
    // NOT open the transcript as a user message or spend the session's first turn.
    expect(prompt).toBe('');
    expect(briefing).toContain('cyboflow');
    // That keyword is the USER's to type — never cyboflow-authored prompt text.
    expect(briefing).not.toMatch(/ultracode/i);

    // Idle, not running: nothing rests a 'running' mark when no turn ran.
    expect(fakeSessionManager.updateSession).toHaveBeenCalledWith('sess-001', { status: 'stopped' });
    expect(fakeSessionManager.updateSession).not.toHaveBeenCalledWith('sess-001', { status: 'running' });

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
    expect(stamp?.args).toEqual(['interactive', 'claude-interactive', 'sess-001']);

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
    expect(stamp?.args).toEqual(['interactive', 'codex-pty', 'sess-001']);

    expect(vi.mocked(panelManager.createPanel)).toHaveBeenCalledWith({
      sessionId: 'sess-001',
      type: 'claude',
      title: 'Chat',
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
      undefined, // reasoningEffort — no persisted setting in this test
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
    expect(stamp?.args).toEqual(['interactive', 'codex-pty', 'sess-001']);
    expect(fakeDatabaseService.updatePanelSettings).not.toHaveBeenCalled();
    expect(fakeCodexPtyManager.startPanel).toHaveBeenCalledWith(
      'panel-quick-1',
      'sess-001',
      `/tmp/project/${TEST_BRANCH}`,
      expect.stringContaining('cyboflow'),
      undefined,
      undefined,
      'test-run-id-abc',
      undefined, // reasoningEffort — no persisted setting in this test
    );
  });

  it('accepts codex-sdk for quick sessions, stamps the session and sentinel, and waits for first input', async () => {
    const {
      services,
      createRunArgs,
      dbRunCalls,
      fakeCodexPtyManager,
      fakeCodexSdkManager,
      fakeInteractiveCliManager,
      fakeTaskQueue,
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
    expect(fakeTaskQueue.createSession).toHaveBeenCalledWith(expect.objectContaining({
      agentProvider: 'codex',
      agentRuntime: 'codex-sdk',
      agentModel: 'gpt-5.5',
    }));
    const sessionStamp = dbRunCalls.find((c) => /UPDATE\s+sessions\s+SET\s+substrate/.test(c.sql));
    expect(sessionStamp?.args).toEqual(['sdk', 'codex-sdk', 'sess-001']);
    expect(sessionStamp?.sql).not.toMatch(/agent_provider|agent_model/);
    expect(createRunArgs[0][4]).toEqual({
      requestedModel: 'gpt-5.5',
      requestedAgentProvider: 'codex',
      requestedAgentRuntime: 'codex-sdk',
    });
    expect(dbRunCalls.some((c) => /UPDATE\s+workflow_runs\s+SET\s+agent_provider/.test(c.sql))).toBe(false);
    expect(fakeCodexSdkManager.spawnCliProcess).not.toHaveBeenCalled();
    expect(fakeCodexPtyManager.startPanel).not.toHaveBeenCalled();
    expect(fakeInteractiveCliManager.startPanel).not.toHaveBeenCalled();
  });

  // ── Provider-access gate (Settings → Integrations / onboarding Connect
  // toggles → AppConfig.agentProviderAccess → ConfigManager) ──

  it('rejects a Codex launch when the Codex provider is switched off', async () => {
    const { services, fakeTaskQueue } = makeServices({
      providerAccess: { claude: true, codex: false },
    });
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      agentProvider: 'codex',
      agentRuntime: 'codex-sdk',
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Codex provider is turned off/i);
    // Fails BEFORE anything is created — no session, no worktree.
    expect(fakeTaskQueue.createSession).not.toHaveBeenCalled();
  });

  it('rejects a Claude launch when the Claude provider is switched off', async () => {
    const { services, fakeTaskQueue } = makeServices({
      providerAccess: { claude: false, codex: true },
    });
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      agentRuntime: 'claude-interactive',
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Claude provider is turned off/i);
    expect(fakeTaskQueue.createSession).not.toHaveBeenCalled();
  });

  it('reroutes an UNREQUESTED quick session to Codex when Claude is switched off', async () => {
    const { services, fakeTaskQueue } = makeServices({
      providerAccess: { claude: false, codex: true },
    });
    const handlers = registerWith(services);

    // A Codex-only install must still start a quick session that names nothing.
    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(true);
    expect(fakeTaskQueue.createSession).toHaveBeenCalledWith(expect.objectContaining({
      agentProvider: 'codex',
      agentRuntime: 'codex-sdk',
    }));
  });

  // ── OMP (the third provider) ──

  const OMP_ON = { claude: true, codex: true, omp: true };

  it('accepts omp-sdk for quick sessions, stamps the session and sentinel, and waits for first input', async () => {
    const {
      services,
      createRunArgs,
      dbRunCalls,
      fakeOmpSdkManager,
      fakeOmpPtyManager,
      fakeCodexSdkManager,
      fakeInteractiveCliManager,
      fakeTaskQueue,
    } = makeServices({ providerAccess: OMP_ON });
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      agentProvider: 'omp',
      agentRuntime: 'omp-sdk',
      agentModel: 'anthropic/claude-sonnet-4',
    })) as { success: boolean; data?: { claudePanelId?: string } };

    expect(result.success).toBe(true);
    // Structured lanes wait for the user's first message — no eager panel.
    expect(result.data ?? {}).not.toHaveProperty('claudePanelId');
    expect(fakeTaskQueue.createSession).toHaveBeenCalledWith(expect.objectContaining({
      agentProvider: 'omp',
      agentRuntime: 'omp-sdk',
      agentModel: 'anthropic/claude-sonnet-4',
    }));
    const sessionStamp = dbRunCalls.find((c) => /UPDATE\s+sessions\s+SET\s+substrate/.test(c.sql));
    expect(sessionStamp?.args).toEqual(['sdk', 'omp-sdk', 'sess-001']);
    // The SENTINEL carries the runtime too — the dispatch facade reads that row
    // back to pick the manager, so a dropped stamp misroutes the chat to Claude.
    expect(createRunArgs[0][4]).toEqual({
      requestedModel: 'anthropic/claude-sonnet-4',
      requestedAgentProvider: 'omp',
      requestedAgentRuntime: 'omp-sdk',
    });
    expect(fakeOmpSdkManager.spawnCliProcess).not.toHaveBeenCalled();
    expect(fakeOmpPtyManager.startPanel).not.toHaveBeenCalled();
    expect(fakeCodexSdkManager.spawnCliProcess).not.toHaveBeenCalled();
    expect(fakeInteractiveCliManager.startPanel).not.toHaveBeenCalled();
  });

  it('projects a bare omp PROVIDER request onto the structured omp-sdk lane', async () => {
    const { services, fakeTaskQueue, dbRunCalls } = makeServices({ providerAccess: OMP_ON });
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      agentProvider: 'omp',
    })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(fakeTaskQueue.createSession).toHaveBeenCalledWith(expect.objectContaining({
      agentProvider: 'omp',
      agentRuntime: 'omp-sdk',
    }));
    const sessionStamp = dbRunCalls.find((c) => /UPDATE\s+sessions\s+SET\s+substrate/.test(c.sql));
    expect(sessionStamp?.args).toEqual(['sdk', 'omp-sdk', 'sess-001']);
  });

  it('eagerly spawns the OMP terminal for an omp-pty quick session and stamps interactive', async () => {
    const {
      services,
      dbRunCalls,
      fakeOmpPtyManager,
      fakeCodexPtyManager,
      fakeInteractiveCliManager,
      fakeRegisterLivePanel,
      fakeRegisterCodexPtyPanel,
      fakeRegisterOmpPtyPanel,
    } = makeServices({ providerAccess: OMP_ON });
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      agentProvider: 'omp',
      agentRuntime: 'omp-pty',
      agentModel: 'anthropic/claude-sonnet-4',
    })) as { success: boolean; data?: { claudePanelId?: string } };

    expect(result.success).toBe(true);
    expect(result.data?.claudePanelId).toBe('panel-quick-1');

    // omp-pty is NOT storable, so the sentinel carries no runtime — the SESSION
    // row is the only place this terminal's identity lands.
    const stamp = dbRunCalls.find((c) => /UPDATE\s+sessions\s+SET\s+substrate/.test(c.sql));
    expect(stamp?.args).toEqual(['interactive', 'omp-pty', 'sess-001']);

    expect(fakeOmpPtyManager.startPanel).toHaveBeenCalledTimes(1);
    const startArgs = fakeOmpPtyManager.startPanel.mock.calls[0] as unknown as unknown[];
    expect(startArgs[0]).toBe('panel-quick-1');
    expect(startArgs[1]).toBe('sess-001');
    expect(startArgs[2]).toBe(`/tmp/project/${TEST_BRANCH}`);
    expect(startArgs[3]).toContain('cyboflow');
    // That keyword is the USER's to type — never cyboflow-authored prompt text.
    expect(startArgs[3]).not.toMatch(/ultracode/i);
    expect(startArgs[5]).toBe('anthropic/claude-sonnet-4');
    expect(startArgs[6]).toBe('test-run-id-abc');

    // No sibling terminal may answer for OMP.
    expect(fakeCodexPtyManager.startPanel).not.toHaveBeenCalled();
    expect(fakeInteractiveCliManager.startPanel).not.toHaveBeenCalled();
    expect(fakeRegisterLivePanel).not.toHaveBeenCalled();
    expect(fakeRegisterCodexPtyPanel).not.toHaveBeenCalled();

    expect(fakeRegisterOmpPtyPanel).toHaveBeenCalledWith('test-run-id-abc', 'panel-quick-1');
    expect(fakeRegisterOmpPtyPanel.mock.invocationCallOrder[0]).toBeLessThan(
      fakeOmpPtyManager.startPanel.mock.invocationCallOrder[0],
    );
  });

  // OMP is the first provider whose ABSENT access key means DISABLED, so the
  // default fixture (claude+codex only) is exactly the "never opted in" install.
  it('rejects an OMP launch when the provider access map omits OMP entirely', async () => {
    const { services, fakeTaskQueue } = makeServices();
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      agentProvider: 'omp',
      agentRuntime: 'omp-sdk',
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/OMP provider is turned off/i);
    // Fails BEFORE anything is created — no session, no worktree.
    expect(fakeTaskQueue.createSession).not.toHaveBeenCalled();
  });

  it('rejects an omp-pty launch when OMP is explicitly switched off', async () => {
    const { services, fakeTaskQueue, fakeOmpPtyManager } = makeServices({
      providerAccess: { claude: true, codex: true, omp: false },
    });
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      agentRuntime: 'omp-pty',
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/OMP provider is turned off/i);
    expect(fakeTaskQueue.createSession).not.toHaveBeenCalled();
    expect(fakeOmpPtyManager.startPanel).not.toHaveBeenCalled();
  });

  it('never reroutes an unrequested quick session onto OMP', async () => {
    // Claude off, Codex off, OMP on: the reroute is Codex-only by design, so
    // this must NOT silently start an OMP session behind the user's back.
    const { services, fakeTaskQueue } = makeServices({
      providerAccess: { claude: false, codex: false, omp: true },
    });
    const handlers = registerWith(services);

    await invoke(handlers, 'sessions:create-quick', { projectId: 42, branchName: TEST_BRANCH });

    expect(fakeTaskQueue.createSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ agentProvider: 'omp' }),
    );
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
      getAgentProviderAccess: () => ({ claude: true, codex: true }),
      isAgentProviderEnabled: () => true,
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
  });

  it("honors an INHERITED in-place global default under the interactive substrate (no worktree fallback needed anymore)", async () => {
    const { services, fakeTaskQueue } = makeServices();
    swapConfigManager(services, {
      isDemoMode: () => false,
      getQuickSessionWorktreeMode: () => 'in-place',
      getDefaultSubstrate: () => undefined,
      getAgentProviderAccess: () => ({ claude: true, codex: true }),
      isAgentProviderEnabled: () => true,
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

  it('threads inPlace for an inherited in-place SDK create', async () => {
    const { services, fakeTaskQueue } = makeServices();
    swapConfigManager(services, {
      isDemoMode: () => false,
      getQuickSessionWorktreeMode: () => 'in-place',
      getDefaultSubstrate: () => undefined,
      getAgentProviderAccess: () => ({ claude: true, codex: true }),
      isAgentProviderEnabled: () => true,
    });
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
    })) as { success: boolean };

    expect(result.success).toBe(true);
    const callArg = (fakeTaskQueue.createSession as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Record<string, unknown>;
    expect(callArg.inPlace).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B (cont.) sessions:create-quick - Design Mode (design-mode.md "Session
// plumbing — SDK-pinned, fail-closed" + "Idea link — integrity contract")
// ---------------------------------------------------------------------------

const DESIGN_IDEA_ID = 'idea-1';
const VALID_IDEA_ROW = { project_id: 42, decomposed_at: null, archived_at: null };

describe('sessions:create-quick handler - Design Mode', () => {
  it('rejects a design launch when the linked idea does not exist, creating NO session', async () => {
    // ideaRow omitted -> the fake db's `FROM ideas` SELECT resolves undefined.
    const { services, fakeTaskQueue } = makeServices();
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      designIdeaId: DESIGN_IDEA_ID,
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
    expect(fakeTaskQueue.createSession).not.toHaveBeenCalled();
  });

  it('rejects a design launch when the idea belongs to a different project, creating NO session', async () => {
    const { services, fakeTaskQueue } = makeServices({
      ideaRow: { project_id: 999, decomposed_at: null, archived_at: null },
    });
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      designIdeaId: DESIGN_IDEA_ID,
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/different project/i);
    expect(fakeTaskQueue.createSession).not.toHaveBeenCalled();
  });

  it('rejects a design launch when the idea is already decomposed, creating NO session', async () => {
    const { services, fakeTaskQueue } = makeServices({
      ideaRow: { project_id: 42, decomposed_at: '2026-07-01T00:00:00Z', archived_at: null },
    });
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      designIdeaId: DESIGN_IDEA_ID,
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/decomposed/i);
    expect(fakeTaskQueue.createSession).not.toHaveBeenCalled();
  });

  it('rejects a design launch when the idea is archived, creating NO session', async () => {
    const { services, fakeTaskQueue } = makeServices({
      ideaRow: { project_id: 42, decomposed_at: null, archived_at: '2026-07-01T00:00:00Z' },
    });
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      designIdeaId: DESIGN_IDEA_ID,
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/archived/i);
    expect(fakeTaskQueue.createSession).not.toHaveBeenCalled();
  });

  it('fails closed (no session created) when Claude credentials are not detected', async () => {
    vi.mocked(detectClaudeCredentials).mockResolvedValueOnce({ found: false, source: null, account: null });
    const { services, fakeTaskQueue } = makeServices({ ideaRow: VALID_IDEA_ROW });
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      designIdeaId: DESIGN_IDEA_ID,
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Claude SDK substrate/i);
    expect(fakeTaskQueue.createSession).not.toHaveBeenCalled();
  });

  it('fails closed (no session created) when the app is locked to interactive-PTY-only mode', async () => {
    const { services, fakeTaskQueue } = makeServices({
      ideaRow: VALID_IDEA_ROW,
      interactivePtyOnly: true,
    });
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      designIdeaId: DESIGN_IDEA_ID,
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/interactive-PTY-only/i);
    expect(fakeTaskQueue.createSession).not.toHaveBeenCalled();
  });

  it('creates an SDK-pinned session, stamps design_idea_id, and IGNORES conflicting substrate/runtime request fields (never spawns the eager Codex PTY panel)', async () => {
    const { services, dbRunCalls, createRunArgs, fakeCodexPtyManager, fakeInteractiveCliManager, fakeRegisterCodexPtyPanel } =
      makeServices({ ideaRow: VALID_IDEA_ROW });
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      designIdeaId: DESIGN_IDEA_ID,
      // Deliberately conflicting/attacker-shaped fields: a well-formed
      // wizard launch never sends these alongside designIdeaId, but the
      // handler must hard-override to Claude SDK regardless of what a
      // request claims.
      substrate: 'interactive',
      agentRuntime: 'codex-pty',
    })) as { success: boolean; data?: { sessionId?: string; claudePanelId?: string } };

    expect(result.success).toBe(true);
    expect(result.data?.claudePanelId).toBeUndefined();

    // The forced opts reached WorkflowRegistry.createRun: requestedSubstrate
    // (2nd positional arg) is 'sdk', and the opts object (5th arg) carries
    // the Claude SDK provider/runtime pin + the belt guard flag.
    expect(createRunArgs[0][1]).toBe('sdk');
    const createRunOpts = createRunArgs[0][4] as Record<string, unknown>;
    expect(createRunOpts.requestedAgentProvider).toBe('claude');
    expect(createRunOpts.requestedAgentRuntime).toBe('claude-sdk');
    expect(createRunOpts.requireSdkSubstrate).toBe(true);

    // Neither PTY-spawn path fired: no Codex PTY panel, no interactive REPL.
    expect(fakeCodexPtyManager.startPanel).not.toHaveBeenCalled();
    expect(fakeRegisterCodexPtyPanel).not.toHaveBeenCalled();
    expect(fakeInteractiveCliManager.startPanel).not.toHaveBeenCalled();

    // The idea link was stamped via the :253-precedent backfill UPDATE.
    const stampCall = dbRunCalls.find((c) => c.sql.includes('design_idea_id'));
    expect(stampCall).toBeDefined();
    expect(stampCall?.args).toEqual([DESIGN_IDEA_ID, result.data?.sessionId]);
  });

  it('mints the bytes-less ui-prototype re-entry stub at design-session creation (server-stamped sourceRef + sessionId)', async () => {
    artifactApplyMock.mockClear();
    const { services } = makeServices({ ideaRow: VALID_IDEA_ROW });
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      designIdeaId: DESIGN_IDEA_ID,
    })) as { success: boolean; data?: { sessionId?: string; runId?: string } };

    expect(result.success).toBe(true);
    expect(artifactApplyMock).toHaveBeenCalledTimes(1);
    const [projectId, change] = artifactApplyMock.mock.calls[0] as unknown as [number, Record<string, unknown>];
    expect(projectId).toBe(42);
    expect(change).toMatchObject({
      op: 'create',
      runId: result.data?.runId,
      atype: 'ui-prototype',
      payloadJson: null,
      sourceRef: DESIGN_IDEA_ID,
      sessionId: result.data?.sessionId,
    });
  });

  it('a stub-creation failure is fail-soft: session creation still succeeds', async () => {
    artifactApplyMock.mockClear();
    artifactApplyMock.mockRejectedValueOnce(new Error('router down'));
    const { services } = makeServices({ ideaRow: VALID_IDEA_ROW });
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      designIdeaId: DESIGN_IDEA_ID,
    })) as { success: boolean };

    expect(result.success).toBe(true);
  });

  it('fails closed and does NOT stamp design_idea_id if a config race defeats requireSdkSubstrate (belt guard)', async () => {
    // forceResolvedSubstrate simulates WorkflowRegistry.createRun somehow
    // still resolving 'interactive' despite the requireSdkSubstrate request —
    // the real registry would throw first (tested at the workflowRegistry
    // unit level); this exercises the IPC handler's OWN belt-and-suspenders
    // assert for the same invariant.
    const { services, dbRunCalls, fakeInteractiveCliManager } = makeServices({
      ideaRow: VALID_IDEA_ROW,
      forceResolvedSubstrate: 'interactive',
    });
    const handlers = registerWith(services);

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
      designIdeaId: DESIGN_IDEA_ID,
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Claude SDK substrate/i);
    expect(dbRunCalls.some((c) => c.sql.includes('design_idea_id'))).toBe(false);
    // The handler returned before reaching the eager interactive-spawn code.
    expect(fakeInteractiveCliManager.startPanel).not.toHaveBeenCalled();
  });

  it('a non-design launch (no designIdeaId) is byte-identical: no idea validation, no Claude pre-flight', async () => {
    artifactApplyMock.mockClear();
    const { services, fakeTaskQueue } = makeServices();
    const handlers = registerWith(services);
    vi.mocked(detectClaudeCredentials).mockClear();
    vi.mocked(detectClaudeBinary).mockClear();

    const result = (await invoke(handlers, 'sessions:create-quick', {
      projectId: 42,
      branchName: TEST_BRANCH,
    })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(fakeTaskQueue.createSession).toHaveBeenCalledTimes(1);
    expect(detectClaudeCredentials).not.toHaveBeenCalled();
    expect(detectClaudeBinary).not.toHaveBeenCalled();
    // No prototype re-entry stub outside the design branch.
    expect(artifactApplyMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// C. sessions:input handler - interactive relay branch vs the SDK path
// ---------------------------------------------------------------------------

describe('sessions:input handler - substrate routing', () => {
  const SESSION_ID = 'sess-001';
  const PANEL = { id: 'panel-1', sessionId: SESSION_ID, type: 'claude', state: {} };

  function setupInput(opts: {
    substrate?: string;
    agentRuntime?: string;
    replRunning?: boolean;
    codexRunning?: boolean;
    ompRunning?: boolean;
    runId?: string;
  }) {
    const made = makeServices({ providerAccess: { claude: true, codex: true, omp: true } });
    (made.fakeDatabaseService.getSession as ReturnType<typeof vi.fn>).mockReturnValue({
      id: SESSION_ID,
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
    vi.mocked(panelManager.getPanel).mockReturnValue(
      PANEL as unknown as ReturnType<typeof panelManager.getPanel>,
    );
    made.fakeInteractiveCliManager.isPanelRunning.mockReturnValue(opts.replRunning ?? false);
    made.fakeCodexPtyManager.isPanelRunning.mockReturnValue(opts.codexRunning ?? false);
    made.fakeCodexSdkManager.isPanelRunning.mockReturnValue(opts.codexRunning ?? false);
    made.fakeOmpPtyManager.isPanelRunning.mockReturnValue(opts.ompRunning ?? false);
    made.fakeOmpSdkManager.isPanelRunning.mockReturnValue(opts.ompRunning ?? false);
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
      undefined, // resumeSessionId — fresh-fallback respawn, not an explicit resume
      undefined, // reasoningEffort — no persisted setting in this test
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
      undefined, // reasoningEffort — no persisted setting in this test
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

  it('keeps Codex SDK queued input out of ClaudeCodeManager and preserves pending-send ids', async () => {
    const {
      handlers,
      fakeCodexSdkManager,
      fakeClaudeCodeManager,
    } = setupInput({ agentRuntime: 'codex-sdk', codexRunning: true, runId: 'run-quick-001' });
    vi.mocked(panelManager.getPanel).mockReturnValue(
      PANEL as unknown as ReturnType<typeof panelManager.getPanel>,
    );

    await invoke(handlers, 'panels:queue-input', 'panel-1', 'pending-a', 'first');
    await invoke(handlers, 'panels:queue-input', 'panel-1', 'pending-b', 'second');
    const listed = (await invoke(handlers, 'panels:list-queued-input', 'panel-1')) as {
      success: boolean;
      data: Array<{ id: string; text: string }>;
    };
    expect(listed.data).toEqual([
      { id: 'pending-a', text: 'first' },
      { id: 'pending-b', text: 'second' },
    ]);

    const dequeued = (await invoke(
      handlers,
      'panels:dequeue-input',
      'panel-1',
      'pending-a',
    )) as { data: { dequeued: boolean } };
    expect(dequeued.data.dequeued).toBe(true);
    expect(fakeCodexSdkManager.spawnCliProcess).not.toHaveBeenCalled();
    expect(fakeClaudeCodeManager.sendInput).not.toHaveBeenCalled();
  });

  it.each([0, 1])('drains Codex SDK queued input once whenever turn exit %i leaves the panel idle', async (exitCode) => {
    const {
      handlers,
      fakeCodexSdkManager,
      fakeSessionManager,
      emitCodex,
    } = setupInput({ agentRuntime: 'codex-sdk', codexRunning: true, runId: 'run-quick-001' });
    vi.mocked(panelManager.getPanel).mockReturnValue(
      PANEL as unknown as ReturnType<typeof panelManager.getPanel>,
    );

    await invoke(handlers, 'panels:queue-input', 'panel-1', 'pending-a', 'first');
    await invoke(handlers, 'panels:queue-input', 'panel-1', 'pending-b', 'second');
    fakeCodexSdkManager.isPanelRunning.mockReturnValue(false);
    emitCodex('exit', { panelId: 'panel-1', sessionId: SESSION_ID, exitCode });
    await vi.waitFor(() => expect(fakeCodexSdkManager.spawnCliProcess).toHaveBeenCalledTimes(1));

    expect(fakeCodexSdkManager.spawnCliProcess).toHaveBeenCalledWith(expect.objectContaining({
      panelId: 'panel-1',
      prompt: 'first\n\nsecond',
    }));
    expect(fakeSessionManager.addPanelConversationMessage).toHaveBeenCalledWith(
      'panel-1',
      'user',
      'first\n\nsecond',
    );
    const listed = (await invoke(handlers, 'panels:list-queued-input', 'panel-1')) as {
      data: unknown[];
    };
    expect(listed.data).toEqual([]);
  });

  // ── OMP: the four event classes per lane (proposal §5.5) ──
  //
  // These are the branches the adversarial review flagged: every one of them was
  // a binary claude-vs-codex test that would have answered an OMP panel with
  // Claude. Each assertion below therefore also pins that NO other manager was
  // touched, not just that the right one was.

  it('relays an omp-pty session turn into the live OMP terminal, never Claude or Codex', async () => {
    const {
      handlers,
      fakeOmpPtyManager,
      fakeCodexPtyManager,
      fakeInteractiveCliManager,
      fakeClaudeCodeManager,
      fakeSessionManager,
    } = setupInput({ agentRuntime: 'omp-pty', ompRunning: true });

    const result = (await invoke(handlers, 'sessions:input', SESSION_ID, 'hello omp')) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(fakeOmpPtyManager.relayUserTurn).toHaveBeenCalledWith('panel-1', 'hello omp');
    expect(fakeOmpPtyManager.startPanel).not.toHaveBeenCalled();
    expect(fakeCodexPtyManager.relayUserTurn).not.toHaveBeenCalled();
    expect(fakeInteractiveCliManager.relayUserTurn).not.toHaveBeenCalled();
    expect(fakeClaudeCodeManager.startPanel).not.toHaveBeenCalled();
    expect(fakeSessionManager.updateSession).toHaveBeenCalledWith(SESSION_ID, { status: 'running' });
  });

  it('re-spawns a dead omp-pty session fire-and-forget with the input as first prompt', async () => {
    const {
      handlers,
      fakeOmpPtyManager,
      fakeClaudeCodeManager,
      fakeSessionManager,
      fakeRegisterOmpPtyPanel,
    } = setupInput({ agentRuntime: 'omp-pty', ompRunning: false, runId: 'run-quick-001' });

    const result = (await invoke(handlers, 'sessions:input', SESSION_ID, 'wake omp')) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(fakeOmpPtyManager.startPanel).toHaveBeenCalledWith(
      'panel-1',
      SESSION_ID,
      `/tmp/project/${TEST_BRANCH}`,
      'wake omp',
      undefined, // permissionMode
      undefined, // model — no persisted panel settings in this test
      'run-quick-001', // gate runId
    );
    expect(fakeClaudeCodeManager.startPanel).not.toHaveBeenCalled();
    expect(fakeSessionManager.updateSession).toHaveBeenCalledWith(SESSION_ID, { status: 'running' });
    expect(fakeRegisterOmpPtyPanel).toHaveBeenCalledWith('run-quick-001', 'panel-1');
    expect(fakeRegisterOmpPtyPanel.mock.invocationCallOrder[0]).toBeLessThan(
      fakeOmpPtyManager.startPanel.mock.invocationCallOrder[0],
    );
  });

  it('routes an omp-sdk session turn through the structured OMP manager (initial turn)', async () => {
    const {
      handlers,
      fakeOmpSdkManager,
      fakeCodexSdkManager,
      fakeOmpPtyManager,
      fakeInteractiveCliManager,
      fakeClaudeCodeManager,
      fakeSessionManager,
      fakeDatabaseService,
    } = setupInput({ agentRuntime: 'omp-sdk', runId: 'run-quick-001' });
    fakeDatabaseService.getPanelSettings.mockReturnValue({ model: 'anthropic/claude-sonnet-4' });

    const result = (await invoke(handlers, 'sessions:input', SESSION_ID, 'hello omp sdk')) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(fakeOmpSdkManager.spawnCliProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        panelId: 'panel-1',
        sessionId: SESSION_ID,
        runId: 'run-quick-001',
        worktreePath: `/tmp/project/${TEST_BRANCH}`,
        prompt: 'hello omp sdk',
        model: 'anthropic/claude-sonnet-4',
      }),
    );
    // OMP's spawn has no `--append-system-prompt` equivalent, so a briefing must
    // NOT be passed — it would be silently dropped rather than delivered.
    expect(fakeOmpSdkManager.spawnCliProcess.mock.calls[0][0]).not.toHaveProperty('systemPromptAppend');
    // No prior invocation for this panel, so the first turn carries no resume.
    expect(fakeOmpSdkManager.spawnCliProcess.mock.calls[0][0]).not.toHaveProperty('resumeSessionId');
    expect(fakeSessionManager.addPanelConversationMessage).toHaveBeenCalledWith('panel-1', 'user', 'hello omp sdk');
    expect(fakeSessionManager.updateSession).toHaveBeenCalledWith(SESSION_ID, { status: 'running' });
    expect(fakeCodexSdkManager.spawnCliProcess).not.toHaveBeenCalled();
    expect(fakeOmpPtyManager.startPanel).not.toHaveBeenCalled();
    expect(fakeInteractiveCliManager.startPanel).not.toHaveBeenCalled();
    expect(fakeClaudeCodeManager.startPanel).not.toHaveBeenCalled();
  });

  it('refuses a second omp-sdk turn while one is in flight (session-scoped path)', async () => {
    const { handlers, fakeOmpSdkManager } = setupInput({
      agentRuntime: 'omp-sdk',
      ompRunning: true,
      runId: 'run-quick-001',
    });

    const result = (await invoke(handlers, 'sessions:input', SESSION_ID, 'too soon')) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toBe('OMP is still processing the previous message.');
    expect(fakeOmpSdkManager.spawnCliProcess).not.toHaveBeenCalled();
  });

  it('keeps OMP SDK queued input in its OWN queue, out of ClaudeCodeManager', async () => {
    const { handlers, fakeOmpSdkManager, fakeClaudeCodeManager } = setupInput({
      agentRuntime: 'omp-sdk',
      ompRunning: true,
      runId: 'run-quick-001',
    });
    vi.mocked(panelManager.getPanel).mockReturnValue(
      PANEL as unknown as ReturnType<typeof panelManager.getPanel>,
    );

    await invoke(handlers, 'panels:queue-input', 'panel-1', 'pending-a', 'first');
    await invoke(handlers, 'panels:queue-input', 'panel-1', 'pending-b', 'second');
    const listed = (await invoke(handlers, 'panels:list-queued-input', 'panel-1')) as {
      data: Array<{ id: string; text: string }>;
    };
    expect(listed.data).toEqual([
      { id: 'pending-a', text: 'first' },
      { id: 'pending-b', text: 'second' },
    ]);

    const dequeued = (await invoke(handlers, 'panels:dequeue-input', 'panel-1', 'pending-a')) as {
      data: { dequeued: boolean };
    };
    expect(dequeued.data.dequeued).toBe(true);
    expect(fakeOmpSdkManager.spawnCliProcess).not.toHaveBeenCalled();
    expect(fakeClaudeCodeManager.sendInput).not.toHaveBeenCalled();
  });

  it('drains OMP SDK queued input as one combined turn at the rest boundary', async () => {
    const { handlers, fakeOmpSdkManager, fakeSessionManager, emitOmp } = setupInput({
      agentRuntime: 'omp-sdk',
      ompRunning: true,
      runId: 'run-quick-001',
    });
    vi.mocked(panelManager.getPanel).mockReturnValue(
      PANEL as unknown as ReturnType<typeof panelManager.getPanel>,
    );

    await invoke(handlers, 'panels:queue-input', 'panel-1', 'pending-a', 'first');
    await invoke(handlers, 'panels:queue-input', 'panel-1', 'pending-b', 'second');
    fakeOmpSdkManager.isPanelRunning.mockReturnValue(false);
    emitOmp('exit', { panelId: 'panel-1', sessionId: SESSION_ID, exitCode: 0 });
    await vi.waitFor(() => expect(fakeOmpSdkManager.spawnCliProcess).toHaveBeenCalledTimes(1));

    expect(fakeOmpSdkManager.spawnCliProcess).toHaveBeenCalledWith(expect.objectContaining({
      panelId: 'panel-1',
      prompt: 'first\n\nsecond',
    }));
    expect(fakeSessionManager.addPanelConversationMessage).toHaveBeenCalledWith(
      'panel-1',
      'user',
      'first\n\nsecond',
    );
    const listed = (await invoke(handlers, 'panels:list-queued-input', 'panel-1')) as {
      data: unknown[];
    };
    expect(listed.data).toEqual([]);
  });

  it("resumes an omp-sdk follow-up turn from that panel's OWN session file", async () => {
    const { handlers, fakeOmpSdkManager } = setupInput({
      agentRuntime: 'omp-sdk',
      runId: 'run-quick-001',
    });
    // OMP's external session id is the session FILE PATH (proposal fact §2.6).
    resumeTargetMock.mockReturnValue({
      provider: 'omp',
      runtime: 'omp-sdk',
      externalSessionId: '/omp-sessions/panel-1/abc.jsonl',
    });

    await invoke(handlers, 'sessions:input', SESSION_ID, 'follow up');

    expect(fakeOmpSdkManager.spawnCliProcess).toHaveBeenCalledWith(
      expect.objectContaining({ resumeSessionId: '/omp-sessions/panel-1/abc.jsonl' }),
    );
  });

  it("never hands another vendor's resume handle to OMP", async () => {
    const { handlers, fakeOmpSdkManager } = setupInput({
      agentRuntime: 'omp-sdk',
      runId: 'run-quick-001',
    });
    // A session switched between vendors leaves a Codex thread id behind; OMP
    // would fail (or worse, silently start fresh) if it were passed through.
    resumeTargetMock.mockReturnValue({
      provider: 'codex',
      runtime: 'codex-sdk',
      externalSessionId: 'codex-thread-1',
    });

    await invoke(handlers, 'sessions:input', SESSION_ID, 'follow up');

    expect(fakeOmpSdkManager.spawnCliProcess.mock.calls[0][0]).not.toHaveProperty('resumeSessionId');
  });

});
