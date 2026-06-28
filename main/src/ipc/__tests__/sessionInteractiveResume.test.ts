/**
 * Unit tests for the interactive-resume IPC surface (resume a lost PTY quick
 * session after an app restart):
 *
 *  - sessions:get-interactive-resume-state — reports replRunning + claudeSessionId
 *    + worktreeExists so the UI can decide whether to offer resume.
 *  - sessions:resume-interactive — arms a one-shot, per-session resume intent
 *    (guarded on substrate + a stored claude_session_id).
 *  - sessions:input dead-REPL respawn — when the intent is armed, threads the
 *    stored claude_session_id to interactiveCliManager.startPanel as the 9th
 *    (resumeSessionId) arg so the first turn resumes via --resume --fork-session;
 *    otherwise a fresh spawn. The intent is consumed exactly once.
 *
 * Exercised via the same handler-capture harness as sessionPermissionMode.test.ts.
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
  // The session owns one server-side 'claude' panel (id matches PANEL_ID below;
  // inlined here because vi.mock factories may not close over non-`mock` vars).
  panelManager: {
    getPanel: vi.fn(),
    getAllPanels: vi.fn(() => []),
    getPanelsForSession: vi.fn(() => [{ id: 'panel-1', type: 'claude' }]),
    createPanel: vi.fn(),
  },
}));

vi.mock('../../services/database', () => ({
  databaseService: { getSession: vi.fn() },
}));

// existsSync gates worktreeExists. Default: present.
const mockExistsSync = vi.fn((_p: string) => true);
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: (p: string) => mockExistsSync(p) };
});

// sessions:input validates the session is active; keep it deterministic.
// (sessionId literal inlined — vi.mock factories may not close over consts.)
vi.mock('../../utils/sessionValidation', () => ({
  validateSessionExists: vi.fn(() => ({ valid: true, sessionId: 'sess-001' })),
  validatePanelSessionOwnership: vi.fn(() => ({ valid: true, sessionId: 'sess-001' })),
  validatePanelExists: vi.fn(() => ({ valid: true, sessionId: 'sess-001' })),
  validateSessionIsActive: vi.fn(() => ({ valid: true, sessionId: 'sess-001' })),
  logValidationFailure: vi.fn(),
  createValidationError: vi.fn(() => ({ success: false, error: 'validation' })),
}));

vi.mock('../../orchestrator/dynamicWorkflows', () => ({
  DynamicWorkflowTracker: { tryGetInstance: vi.fn(() => undefined) },
}));

import { registerSessionHandlers } from '../session';
import type { AppServices } from '../types';

const SESSION_ID = 'sess-001';
const PANEL_ID = 'panel-1';
const RUN_ID = 'run-1';
const WORKTREE = '/tmp/project/quick-test';
const CLAUDE_SESSION_ID = 'uuid-abc';

const RESUME_STATE = 'sessions:get-interactive-resume-state';
const RESUME = 'sessions:resume-interactive';
const INPUT = 'sessions:input';

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

function makeServices(opts: {
  substrate?: string;
  claudeSessionId?: string | undefined;
  replRunning?: boolean;
  worktreePath?: string | undefined;
  sessionExists?: boolean;
} = {}) {
  const dbSession =
    opts.sessionExists === false
      ? undefined
      : {
          id: SESSION_ID,
          substrate: opts.substrate ?? 'interactive',
          run_id: RUN_ID,
          worktree_path: opts.worktreePath === undefined ? WORKTREE : opts.worktreePath,
          commit_mode: undefined,
        };

  // Variadic args so mock.calls[n][8] (the resumeSessionId positional) is indexable.
  const startPanel = vi.fn((..._args: unknown[]) => Promise.resolve());
  const fakeDatabaseService = {
    getSession: vi.fn(() => dbSession),
    getPanelSettings: vi.fn(() => ({ model: undefined, fastMode: false })),
  };
  const fakeSessionManager = {
    getSession: vi.fn(() =>
      Promise.resolve({
        id: SESSION_ID,
        status: 'running',
        worktreePath: WORKTREE,
        permissionMode: 'approve',
        toolType: 'claude',
      }),
    ),
    // Key absent → a stored id (the default); key present (even `undefined`) →
    // that exact value, so a test can force "no stored conversation".
    getClaudeSessionId: vi.fn(() =>
      'claudeSessionId' in opts ? opts.claudeSessionId : CLAUDE_SESSION_ID,
    ),
    addSessionOutput: vi.fn(() => Promise.resolve()),
    updateSession: vi.fn(() => Promise.resolve()),
    emit: vi.fn(),
  };
  const fakeInteractive = {
    isPanelRunning: vi.fn(() => opts.replRunning ?? false),
    startPanel,
    relayUserTurn: vi.fn(),
  };

  const services = {
    sessionManager: fakeSessionManager,
    databaseService: fakeDatabaseService,
    taskQueue: {},
    worktreeManager: {},
    cliManagerFactory: {},
    claudeCodeManager: { isPanelRunning: vi.fn(() => false) },
    interactiveCliManager: fakeInteractive,
    killLiveSession: vi.fn(),
    registerLivePanel: vi.fn(),
    gitStatusManager: {},
    archiveProgressManager: undefined,
    configManager: { isDemoMode: () => false },
    cyboflow: { workflowRegistry: {}, runLauncher: {} },
  } as unknown as AppServices;

  return { services, startPanel, fakeSessionManager, fakeInteractive };
}

function registerWith(services: AppServices) {
  const { ipcMain, handlers } = makeHandlerCapture();
  registerSessionHandlers(
    ipcMain as unknown as Parameters<typeof registerSessionHandlers>[0],
    services,
  );
  return handlers;
}

type ResumeStateResult = {
  success: boolean;
  data?: { replRunning: boolean; claudeSessionId: string | null; worktreeExists: boolean };
  error?: string;
};

beforeEach(() => {
  mockExistsSync.mockReset().mockReturnValue(true);
});

describe('sessions:get-interactive-resume-state', () => {
  it('reports a resumable session (dead REPL + stored id + worktree present)', async () => {
    const { services } = makeServices({ replRunning: false });
    const handlers = registerWith(services);
    const res = (await invoke(handlers, RESUME_STATE, SESSION_ID)) as ResumeStateResult;
    expect(res.success).toBe(true);
    expect(res.data).toEqual({
      replRunning: false,
      claudeSessionId: CLAUDE_SESSION_ID,
      worktreeExists: true,
    });
  });

  it('reports replRunning=true when the REPL is alive', async () => {
    const { services } = makeServices({ replRunning: true });
    const handlers = registerWith(services);
    const res = (await invoke(handlers, RESUME_STATE, SESSION_ID)) as ResumeStateResult;
    expect(res.data?.replRunning).toBe(true);
  });

  it('reports claudeSessionId=null when none is stored', async () => {
    const { services } = makeServices({ claudeSessionId: undefined });
    const handlers = registerWith(services);
    const res = (await invoke(handlers, RESUME_STATE, SESSION_ID)) as ResumeStateResult;
    expect(res.data?.claudeSessionId).toBeNull();
  });

  it('reports worktreeExists=false when the worktree is gone', async () => {
    mockExistsSync.mockReturnValue(false);
    const { services } = makeServices();
    const handlers = registerWith(services);
    const res = (await invoke(handlers, RESUME_STATE, SESSION_ID)) as ResumeStateResult;
    expect(res.data?.worktreeExists).toBe(false);
  });

  it('fails when the session does not exist', async () => {
    const { services } = makeServices({ sessionExists: false });
    const handlers = registerWith(services);
    const res = (await invoke(handlers, RESUME_STATE, SESSION_ID)) as ResumeStateResult;
    expect(res.success).toBe(false);
  });
});

describe('sessions:resume-interactive (arm intent)', () => {
  it('arms for an interactive session with a stored claude_session_id', async () => {
    const { services } = makeServices({ substrate: 'interactive' });
    const handlers = registerWith(services);
    const res = (await invoke(handlers, RESUME, SESSION_ID)) as { success: boolean };
    expect(res.success).toBe(true);
  });

  it('refuses a non-interactive session', async () => {
    const { services } = makeServices({ substrate: 'sdk' });
    const handlers = registerWith(services);
    const res = (await invoke(handlers, RESUME, SESSION_ID)) as { success: boolean; error?: string };
    expect(res.success).toBe(false);
  });

  it('refuses when no prior claude_session_id is stored', async () => {
    const { services } = makeServices({ substrate: 'interactive', claudeSessionId: undefined });
    const handlers = registerWith(services);
    const res = (await invoke(handlers, RESUME, SESSION_ID)) as { success: boolean };
    expect(res.success).toBe(false);
  });
});

describe('sessions:input deferred resume wiring', () => {
  it('threads the stored claude_session_id to startPanel after Resume is armed', async () => {
    const { services, startPanel } = makeServices({ replRunning: false });
    const handlers = registerWith(services);
    await invoke(handlers, RESUME, SESSION_ID); // arm
    await invoke(handlers, INPUT, SESSION_ID, 'continue please');
    expect(startPanel).toHaveBeenCalledTimes(1);
    // startPanel(panelId, sessionId, worktree, prompt, perm, model, effort, fast, resumeSessionId)
    expect(startPanel.mock.calls[0][8]).toBe(CLAUDE_SESSION_ID);
  });

  it('spawns fresh (no resumeSessionId) when Resume was not armed', async () => {
    const { services, startPanel } = makeServices({ replRunning: false });
    const handlers = registerWith(services);
    await invoke(handlers, INPUT, SESSION_ID, 'hello');
    expect(startPanel).toHaveBeenCalledTimes(1);
    expect(startPanel.mock.calls[0][8]).toBeUndefined();
  });

  it('consumes the resume intent exactly once', async () => {
    const { services, startPanel } = makeServices({ replRunning: false });
    const handlers = registerWith(services);
    await invoke(handlers, RESUME, SESSION_ID); // arm once
    await invoke(handlers, INPUT, SESSION_ID, 'turn 1');
    await invoke(handlers, INPUT, SESSION_ID, 'turn 2');
    expect(startPanel.mock.calls[0][8]).toBe(CLAUDE_SESSION_ID); // resumed
    expect(startPanel.mock.calls[1][8]).toBeUndefined(); // fresh (flag consumed)
  });
});
