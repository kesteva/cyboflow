/**
 * Unit tests for `dismissAsk` in main/src/ipc/sessionOps.ts — the ops
 * implementation behind `cyboflow.sessions.dismissAsk` (TASK-225, the
 * "Dismiss" action on a Needs-your-input quick-session card). Pins the
 * mutation contract the board relies on: the DatabaseService write happens
 * exactly once, and a successful write emits the existing 'session-updated'
 * signal (the same one `rename` / `markViewed` emit) so consumers other than
 * the initiating Home view are notified.
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
    createPanel: vi.fn(),
  },
}));

vi.mock('../../services/database', () => ({
  databaseService: { getSession: vi.fn() },
}));

const validateSessionExists = vi.hoisted(() => vi.fn());
vi.mock('../../utils/sessionValidation', () => ({
  validateSessionExists,
  validatePanelSessionOwnership: vi.fn(() => ({ valid: true, sessionId: 'sess-001' })),
  validatePanelExists: vi.fn(() => ({ valid: true, sessionId: 'sess-001' })),
  validateSessionIsActive: vi.fn(() => ({ valid: true, sessionId: 'sess-001' })),
  logValidationFailure: vi.fn(),
  createValidationError: vi.fn(() => ({ success: false, error: 'validation' })),
}));

vi.mock('../../orchestrator/dynamicWorkflows', () => ({
  DynamicWorkflowTracker: { tryGetInstance: vi.fn(() => undefined) },
}));

import { createSessionOps } from '../sessionOps';
import type { AppServices } from '../types';

const SID = 'sess-001';

function makeServices(opts: { dismissed?: boolean; session?: { id: string } | undefined } = {}) {
  const dismissSessionAsk = vi.fn(() => opts.dismissed ?? true);
  const emit = vi.fn();
  const session = 'session' in opts ? opts.session : { id: SID, name: 'tidy-valley' };
  const services = {
    sessionManager: { getSession: vi.fn(() => session), emit },
    databaseService: { getSession: vi.fn(), dismissSessionAsk },
    configManager: { isSessionSummaryEnabled: () => true, isDemoMode: () => false },
    sessionSummaryScheduler: { maybeSummarizeNow: vi.fn(), noteTurnStart: vi.fn(), noteTurnEnd: vi.fn(), dispose: vi.fn() },
    taskQueue: {},
    worktreeManager: {},
    cliManagerFactory: {},
    claudeCodeManager: {},
    interactiveCliManager: {},
    killLiveSession: vi.fn(),
    registerLivePanel: vi.fn(),
    gitStatusManager: {},
    cyboflow: { workflowRegistry: {}, runLauncher: {} },
  } as unknown as AppServices;
  return { services, dismissSessionAsk, emit, session };
}

beforeEach(() => {
  vi.clearAllMocks();
  validateSessionExists.mockReturnValue({ valid: true, sessionId: SID });
});

describe('sessionOps.dismissAsk (TASK-225)', () => {
  it('writes the dismissal once and emits session-updated for the session', async () => {
    const { services, dismissSessionAsk, emit, session } = makeServices();
    const ops = createSessionOps(services);

    const res = await ops.dismissAsk({ sessionId: SID });

    expect(res).toEqual({ success: true });
    expect(dismissSessionAsk).toHaveBeenCalledTimes(1);
    expect(dismissSessionAsk).toHaveBeenCalledWith(SID);
    expect(emit).toHaveBeenCalledWith('session-updated', session);
  });

  it('does not emit when the session is not in the runtime map (DB-only session)', async () => {
    const { services, emit } = makeServices({ session: undefined });
    const ops = createSessionOps(services);

    const res = await ops.dismissAsk({ sessionId: SID });

    expect(res).toEqual({ success: true });
    expect(emit).not.toHaveBeenCalled();
  });

  it('reports failure (and emits nothing) when the DB write finds no session row', async () => {
    const { services, emit } = makeServices({ dismissed: false });
    const ops = createSessionOps(services);

    const res = await ops.dismissAsk({ sessionId: SID });

    expect(res).toEqual({ success: false, error: 'Session not found' });
    expect(emit).not.toHaveBeenCalled();
  });

  it('returns the validation envelope without writing when the session id fails validation', async () => {
    validateSessionExists.mockReturnValue({ valid: false, error: 'Session sess-001 not found' });
    const { services, dismissSessionAsk, emit } = makeServices();
    const ops = createSessionOps(services);

    const res = await ops.dismissAsk({ sessionId: SID });

    expect(res).toEqual({ success: false, error: 'validation' });
    expect(dismissSessionAsk).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
