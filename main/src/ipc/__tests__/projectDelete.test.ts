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
 *  - branch close-out: each session's branch (named as the worktree) is
 *    force-deleted after its worktree removal; a failed worktree removal skips
 *    that session's branch delete; a PRE-EXISTING checked-out branch
 *    (base_branch === worktree_name) is preserved; a branch-delete failure
 *    doesn't abort the sweep.
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
  base_branch?: string;
  substrate?: string;
  chat_run_id?: string;
}

function makeServices(opts: {
  project?: { id: number; name: string; path: string; worktree_folder: string | null } | undefined;
  sessions?: SessRow[];
  removeWorktreeImpl?: (path: string, name: string, folder?: string) => Promise<void>;
  deleteBranchImpl?: (path: string, branch: string, o?: { force?: boolean }) => Promise<void>;
  cancelHostedRunsImpl?: (sessionId: string) => Promise<void>;
}) {
  const project = 'project' in opts ? opts.project : { id: 1, name: 'Proj', path: '/proj', worktree_folder: null };
  const sessions = opts.sessions ?? [];

  const removeWorktree = vi.fn(opts.removeWorktreeImpl ?? (async () => {}));
  const deleteBranch = vi.fn(opts.deleteBranchImpl ?? (async () => {}));
  const deleteProject = vi.fn(() => true);
  const stopRunningScript = vi.fn(async () => {});
  const cancelHostedRuns = vi.fn(opts.cancelHostedRunsImpl ?? (async () => {}));

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
    worktreeManager: { removeWorktree, deleteBranch },
    killLiveSession: vi.fn(async () => {}),
    configManager: { isDemoMode: () => false },
    cyboflow: { cancelHostedRuns },
  } as unknown as AppServices;

  return { services, removeWorktree, deleteBranch, deleteProject, stopRunningScript, cancelHostedRuns };
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

describe('projects:delete — branch close-out', () => {
  it('force-deletes each session branch after its worktree, skipping sessions whose removal failed', async () => {
    const made = makeServices({
      project: { id: 1, name: 'Proj', path: '/proj', worktree_folder: null },
      sessions: [
        { id: 's1', project_id: 1, is_main_repo: false, worktree_name: 'wt-1', base_branch: 'main' },
        { id: 's2', project_id: 1, is_main_repo: false, worktree_name: 'wt-2', base_branch: 'main' },
        { id: 's3', project_id: 1, is_main_repo: false, worktree_name: 'wt-3', base_branch: 'main' },
      ],
      // wt-2's worktree removal fails — its (still checked out) branch must be skipped.
      removeWorktreeImpl: async (_path, name) => {
        if (name === 'wt-2') throw new Error('worktree locked');
      },
    });
    const handlers = register(made.services);

    const result = (await invoke(handlers, 'projects:delete', '1')) as { success: boolean };
    expect(result.success).toBe(true);

    const deleted = made.deleteBranch.mock.calls.map((c) => c[1]);
    expect(deleted).toEqual(['wt-1', 'wt-3']);
    expect(made.deleteBranch).toHaveBeenCalledWith('/proj', 'wt-1', { force: true });
    // Each branch delete happens only after its own worktree removal.
    expect(made.removeWorktree.mock.invocationCallOrder[0]).toBeLessThan(
      made.deleteBranch.mock.invocationCallOrder[0],
    );
  });

  it('preserves a PRE-EXISTING branch a session merely checked out (base_branch === worktree_name)', async () => {
    const made = makeServices({
      project: { id: 1, name: 'Proj', path: '/proj', worktree_folder: null },
      sessions: [
        { id: 's1', project_id: 1, is_main_repo: false, worktree_name: 'feature-x', base_branch: 'feature-x' },
        { id: 's2', project_id: 1, is_main_repo: false, worktree_name: 'wt-2', base_branch: 'main' },
      ],
    });
    const handlers = register(made.services);

    await invoke(handlers, 'projects:delete', '1');

    expect(made.removeWorktree).toHaveBeenCalledTimes(2);
    const deleted = made.deleteBranch.mock.calls.map((c) => c[1]);
    expect(deleted).toEqual(['wt-2']);
  });

  it('continues the sweep and still deletes the project when a branch delete throws', async () => {
    const made = makeServices({
      project: { id: 1, name: 'Proj', path: '/proj', worktree_folder: null },
      sessions: [
        { id: 's1', project_id: 1, is_main_repo: false, worktree_name: 'wt-1', base_branch: 'main' },
        { id: 's2', project_id: 1, is_main_repo: false, worktree_name: 'wt-2', base_branch: 'main' },
      ],
      deleteBranchImpl: async (_path, branch) => {
        if (branch === 'wt-1') throw new Error('branch delete failed');
      },
    });
    const handlers = register(made.services);

    const result = (await invoke(handlers, 'projects:delete', '1')) as { success: boolean };
    expect(result.success).toBe(true);

    // Both branch deletes attempted despite the first failing…
    const deleted = made.deleteBranch.mock.calls.map((c) => c[1]);
    expect(deleted).toEqual(['wt-1', 'wt-2']);
    // …and the project row still goes away after all cleanup.
    expect(made.deleteProject).toHaveBeenCalledTimes(1);
    const lastBranchOrder = Math.max(...made.deleteBranch.mock.invocationCallOrder);
    expect(lastBranchOrder).toBeLessThan(made.deleteProject.mock.invocationCallOrder[0]);
  });
});

// ---------------------------------------------------------------------------
// hosted-run cancellation (SDK-aware teardown gap fix): a project's sessions
// may host non-terminal workflow runs on EITHER substrate — unlike the
// interactive-only killLiveSession kill above, cancelHostedRuns (the same seam
// sessions:delete uses) must be called for every worktree-bearing session,
// BEFORE its worktree is removed, so a live agent (interactive OR a warm SDK
// process) is never orphaned/stranded when its cwd disappears.
// ---------------------------------------------------------------------------

describe('projects:delete — hosted-run cancellation', () => {
  it('calls cancelHostedRuns for each worktree-bearing session before its worktree is removed', async () => {
    const made = makeServices({
      project: { id: 1, name: 'Proj', path: '/proj', worktree_folder: null },
      sessions: [
        { id: 's1', project_id: 1, is_main_repo: false, worktree_name: 'wt-1', substrate: 'sdk' },
        { id: 's2', project_id: 1, is_main_repo: false, worktree_name: 'wt-2', substrate: 'interactive', chat_run_id: 'chat-2' },
      ],
    });
    const handlers = register(made.services);

    const result = (await invoke(handlers, 'projects:delete', '1')) as { success: boolean };
    expect(result.success).toBe(true);

    // Cancelled for BOTH substrates — the fixed gap.
    expect(made.cancelHostedRuns).toHaveBeenCalledTimes(2);
    expect(made.cancelHostedRuns).toHaveBeenCalledWith('s1');
    expect(made.cancelHostedRuns).toHaveBeenCalledWith('s2');

    // Ordering: each session's cancel precedes its own worktree removal.
    const cancelOrders = made.cancelHostedRuns.mock.invocationCallOrder;
    const removeOrders = made.removeWorktree.mock.invocationCallOrder;
    expect(Math.max(...cancelOrders)).toBeLessThan(Math.max(...removeOrders));
  });

  it('cancels hosted runs for EVERY session — including main-repo / worktree-less / in-place, which have no worktree to remove but can still host a live (warm SDK) chat process', async () => {
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

    // Cancel is UNCONDITIONAL per session (mirrors sessions:delete)…
    expect(made.cancelHostedRuns).toHaveBeenCalledTimes(3);
    expect(made.cancelHostedRuns).toHaveBeenCalledWith('main');
    expect(made.cancelHostedRuns).toHaveBeenCalledWith('no-wt');
    expect(made.cancelHostedRuns).toHaveBeenCalledWith('s3');
    // …while the worktree-cleanup skip still only removes the real worktree.
    expect(made.removeWorktree).toHaveBeenCalledTimes(1);
    expect(made.removeWorktree.mock.calls[0][1]).toBe('wt-3');
  });

  it('is fail-soft: a cancelHostedRuns failure does not abort the sweep or block the project deletion', async () => {
    const made = makeServices({
      project: { id: 1, name: 'Proj', path: '/proj', worktree_folder: null },
      sessions: [
        { id: 's1', project_id: 1, is_main_repo: false, worktree_name: 'wt-1' },
        { id: 's2', project_id: 1, is_main_repo: false, worktree_name: 'wt-2' },
      ],
      cancelHostedRunsImpl: async (sessionId) => {
        if (sessionId === 's1') throw new Error('cancel failed');
      },
    });
    const handlers = register(made.services);

    const result = (await invoke(handlers, 'projects:delete', '1')) as { success: boolean };
    expect(result.success).toBe(true);

    // Both sessions' cancel was attempted despite the first throwing…
    expect(made.cancelHostedRuns).toHaveBeenCalledTimes(2);
    // …and worktree cleanup + project deletion still proceeded normally.
    expect(made.removeWorktree).toHaveBeenCalledTimes(2);
    expect(made.deleteProject).toHaveBeenCalledTimes(1);
  });
});
