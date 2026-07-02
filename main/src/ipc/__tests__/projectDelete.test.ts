/**
 * Behavioral tests for the projects:delete IPC handler
 * (main/src/ipc/project.ts).
 *
 * Covered:
 *  - an unknown project id returns success:false and touches nothing
 *    (deleteProject is never called).
 *  - a running session script is stopped BEFORE the project is deleted.
 *  - every session's worktree removal is attempted even when one throws, and the
 *    DB deleteProject runs only AFTER all cleanup attempts.
 *
 * Handlers captured via a stub ipcMain; scriptExecutionTracker + panelManager +
 * the demo-seed modules are module-mocked so project.ts loads in the host-Node
 * test env, and all service collaborators are object-stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { isPackaged: false, getPath: vi.fn(() => '/mock'), getName: vi.fn(() => 'Cyboflow'), getVersion: vi.fn(() => '0.1.0') },
}));

const scriptTracker = vi.hoisted(() => ({
  getRunningScript: vi.fn(() => undefined as { id: number | string; type: string } | undefined),
  stop: vi.fn(),
  markClosing: vi.fn(),
}));
vi.mock('../../services/scriptExecutionTracker', () => ({ scriptExecutionTracker: scriptTracker }));

vi.mock('../../services/panelManager', () => ({
  panelManager: { getPanelsForSession: vi.fn(() => []) },
}));

vi.mock('../../services/demo/demoSeed', () => ({ seedDemoProjectEntities: vi.fn() }));
vi.mock('../../services/demo/demoInsightsSeed', () => ({ seedDemoInsightsHistory: vi.fn() }));

import { registerProjectHandlers } from '../project';
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

interface SessRow {
  id: string;
  project_id: number;
  is_main_repo?: boolean;
  worktree_name?: string;
  substrate?: string;
  chat_run_id?: string;
}

function makeServices(opts: {
  project?: { id: number; name: string; path: string; worktree_folder: string | null } | undefined;
  sessions?: SessRow[];
  removeWorktreeImpl?: (path: string, name: string, folder?: string) => Promise<void>;
}) {
  const project = 'project' in opts ? opts.project : { id: 1, name: 'Proj', path: '/proj', worktree_folder: null };
  const sessions = opts.sessions ?? [];

  const removeWorktree = vi.fn(opts.removeWorktreeImpl ?? (async () => {}));
  const deleteProject = vi.fn(() => true);
  const stopRunningScript = vi.fn(async () => {});

  const services = {
    databaseService: {
      getProject: vi.fn(() => project),
      getAllSessionsIncludingArchived: vi.fn(() => sessions),
      getAllSessions: vi.fn(() => sessions.filter((s) => s.project_id === project?.id)),
      deleteProject,
    },
    sessionManager: {
      stopRunningScript,
      hasTerminalSession: vi.fn(() => false),
      closeTerminalSession: vi.fn(async () => {}),
      getAllSessions: vi.fn(async () => []),
    },
    worktreeManager: { removeWorktree },
    killLiveSession: vi.fn(async () => {}),
    configManager: { isDemoMode: () => false },
  } as unknown as AppServices;

  return { services, removeWorktree, deleteProject, stopRunningScript };
}

function register(services: AppServices) {
  const { ipcMain, handlers } = makeHandlerCapture();
  registerProjectHandlers(ipcMain as unknown as Parameters<typeof registerProjectHandlers>[0], services);
  return handlers;
}

beforeEach(() => {
  vi.clearAllMocks();
  scriptTracker.getRunningScript.mockReturnValue(undefined);
});

describe('projects:delete — unknown id', () => {
  it('returns success:false and never calls deleteProject', async () => {
    const made = makeServices({ project: undefined });
    const handlers = register(made.services);

    const result = (await invoke(handlers, 'projects:delete', '999')) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe('Project not found');
    expect(made.deleteProject).not.toHaveBeenCalled();
  });
});

describe('projects:delete — running-script stop ordering', () => {
  it('stops a running session script BEFORE deleting the project', async () => {
    scriptTracker.getRunningScript.mockReturnValue({ id: 's1', type: 'session' });
    const made = makeServices({
      project: { id: 1, name: 'Proj', path: '/proj', worktree_folder: null },
      sessions: [{ id: 's1', project_id: 1, is_main_repo: false, worktree_name: 'wt-1' }],
    });
    const handlers = register(made.services);

    const result = (await invoke(handlers, 'projects:delete', '1')) as { success: boolean };
    expect(result.success).toBe(true);

    expect(made.stopRunningScript).toHaveBeenCalledTimes(1);
    expect(scriptTracker.stop).toHaveBeenCalledWith('session', 's1');
    expect(made.deleteProject).toHaveBeenCalledTimes(1);
    // The script stop must happen before the DB row is deleted.
    expect(made.stopRunningScript.mock.invocationCallOrder[0]).toBeLessThan(
      made.deleteProject.mock.invocationCallOrder[0],
    );
  });
});

describe('projects:delete — worktree cleanup resilience + ordering', () => {
  it('attempts every session worktree removal even when one throws, then deletes the project', async () => {
    const made = makeServices({
      project: { id: 1, name: 'Proj', path: '/proj', worktree_folder: null },
      sessions: [
        { id: 's1', project_id: 1, is_main_repo: false, worktree_name: 'wt-1' },
        { id: 's2', project_id: 1, is_main_repo: false, worktree_name: 'wt-2' },
        { id: 's3', project_id: 1, is_main_repo: false, worktree_name: 'wt-3' },
      ],
      // The middle worktree removal fails — the loop must NOT abort.
      removeWorktreeImpl: async (_path, name) => {
        if (name === 'wt-2') throw new Error('worktree locked');
      },
    });
    const handlers = register(made.services);

    const result = (await invoke(handlers, 'projects:delete', '1')) as { success: boolean };
    expect(result.success).toBe(true);

    // All three removals were attempted despite the middle failure.
    expect(made.removeWorktree).toHaveBeenCalledTimes(3);
    const names = made.removeWorktree.mock.calls.map((c) => c[1]);
    expect(names).toEqual(['wt-1', 'wt-2', 'wt-3']);

    // deleteProject runs only AFTER every cleanup attempt.
    expect(made.deleteProject).toHaveBeenCalledTimes(1);
    const lastRemoveOrder = Math.max(...made.removeWorktree.mock.invocationCallOrder);
    expect(lastRemoveOrder).toBeLessThan(made.deleteProject.mock.invocationCallOrder[0]);
  });

  it('skips main-repo and worktree-less sessions during cleanup', async () => {
    const made = makeServices({
      project: { id: 1, name: 'Proj', path: '/proj', worktree_folder: null },
      sessions: [
        { id: 'main', project_id: 1, is_main_repo: true, worktree_name: 'ignored' },
        { id: 'no-wt', project_id: 1, is_main_repo: false },
        { id: 's3', project_id: 1, is_main_repo: false, worktree_name: 'wt-3' },
      ],
    });
    const handlers = register(made.services);

    await invoke(handlers, 'projects:delete', '1');

    // Only the real worktree session is torn down.
    expect(made.removeWorktree).toHaveBeenCalledTimes(1);
    expect(made.removeWorktree.mock.calls[0][1]).toBe('wt-3');
    expect(made.deleteProject).toHaveBeenCalledTimes(1);
  });
});
