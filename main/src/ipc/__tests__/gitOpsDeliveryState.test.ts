/**
 * Unit tests for `getDeliveryState` in main/src/ipc/gitOps.ts — specifically
 * the `completedNoCode` wiring added alongside `sessionCompletedNoCodeWork`
 * (main/src/orchestrator/runRecovery.ts). That helper's own logic is covered
 * exhaustively by runRecovery.test.ts; these tests instead pin the WRAPPER
 * behaviour inside getDeliveryState that runRecovery.test.ts cannot reach:
 *
 *   - completedNoCode is only even asked for when ownCommits === 0 (the
 *     short-circuit) — with own commits present it must read false regardless
 *     of what sessionCompletedNoCodeWork would say.
 *   - when ownCommits === 0, completedNoCode mirrors sessionCompletedNoCodeWork's
 *     verdict.
 *   - delivered/landed/ownCommits keep flowing through unaffected.
 *
 * gitOps.ts pulls in a wide swath of the main-process singleton graph (the
 * BrowserWindow-backed mainWindow, panelManager, panelEventBus, the various
 * routers) purely for OTHER ops methods — none of it is reachable from
 * getDeliveryState, so every one of those modules is stubbed out here to keep
 * the import graph out of Electron entirely.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { isPackaged: false, getPath: vi.fn(() => '/mock/path') },
}));

vi.mock('../../index', () => ({ mainWindow: null }));

vi.mock('../../services/panelManager', () => ({
  panelManager: { createPanel: vi.fn(), getPanel: vi.fn(), getAllPanels: vi.fn(() => []) },
}));

vi.mock('../../services/panelEventBus', () => ({
  panelEventBus: { emitPanelEvent: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

vi.mock('../../orchestrator/dynamicWorkflows', () => ({
  DynamicWorkflowTracker: { tryGetInstance: vi.fn(() => undefined) },
}));

vi.mock('../../services/worktreeChangeNotifier', () => ({
  WorktreeChangeNotifier: vi.fn().mockImplementation(() => ({
    watch: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock('../../orchestrator/taskChangeRouter', () => ({
  TaskChangeRouter: { getInstance: vi.fn(() => ({})) },
}));

vi.mock('../../orchestrator/artifactRouter', () => ({
  ArtifactRouter: { getInstance: vi.fn(() => ({ reapForRun: vi.fn() })) },
}));

vi.mock('../../orchestrator/sprintLaneStore', () => ({
  SprintLaneStore: { getInstance: vi.fn(() => ({})) },
}));

vi.mock('../../services/telemetry', () => ({
  trackUsage: vi.fn(),
}));

const sessionDeliveredWork = vi.fn(() => false);
const sessionCompletedNoCodeWork = vi.fn(() => false);

vi.mock('../../orchestrator/runRecovery', () => ({
  stampSessionRunsOutcome: vi.fn(),
  stampSessionRunsPrOpen: vi.fn(),
  stampSessionRunsCompleted: vi.fn(),
  sessionDeliveredWork: (...args: unknown[]) => sessionDeliveredWork(...(args as [])),
  sessionCompletedNoCodeWork: (...args: unknown[]) => sessionCompletedNoCodeWork(...(args as [])),
}));

import { createGitOps } from '../gitOps';
import type { AppServices } from '../types';
import type { Session } from '../../types/session';

const SID = 'sess-delivery-1';

function makeServices(opts: {
  worktreePath?: string | null;
  project?: { id: string; path: string } | null;
  ownCommits?: number;
  landed?: boolean;
} = {}) {
  const session: Session = {
    id: SID,
    worktreePath: opts.worktreePath === undefined ? '/tmp/wt' : opts.worktreePath,
    archived: false,
  } as unknown as Session;

  const project = opts.project === undefined ? { id: 'p1', path: '/tmp/project' } : opts.project;

  const getBranchLandingState = vi.fn(async () => ({
    landed: opts.landed ?? false,
    ownCommits: opts.ownCommits ?? 0,
  }));

  const services = {
    sessionManager: {
      getSession: vi.fn(async () => session),
      getProjectForSession: vi.fn(() => project),
    },
    databaseService: {
      getDb: vi.fn(() => ({ prepare: vi.fn(), transaction: vi.fn(), name: ':memory:' })),
    },
    worktreeManager: {
      getProjectMainBranch: vi.fn(async () => 'main'),
      getBranchLandingState,
    },
    gitDiffManager: {},
    gitStatusManager: {},
    configManager: {},
    endLiveSession: vi.fn(),
  } as unknown as AppServices;

  return { services, getBranchLandingState };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionDeliveredWork.mockReturnValue(false);
  sessionCompletedNoCodeWork.mockReturnValue(false);
});

describe('gitOps.getDeliveryState — completedNoCode wiring', () => {
  it('reports completedNoCode:true when ownCommits is 0 and the DB says the run completed with no code', async () => {
    const { services } = makeServices({ ownCommits: 0 });
    sessionCompletedNoCodeWork.mockReturnValue(true);

    const ops = createGitOps(services);
    const res = await ops.getDeliveryState({ sessionId: SID });

    expect(res.success).toBe(true);
    if (!res.success) throw new Error('expected success');
    expect(res.data).toEqual({ delivered: false, landed: false, ownCommits: 0, completedNoCode: true, integratedLaneCount: 0 });
    expect(sessionCompletedNoCodeWork).toHaveBeenCalledWith(expect.anything(), SID);
  });

  it('short-circuits to completedNoCode:false when ownCommits > 0, without even trusting a true verdict from the helper', async () => {
    const { services } = makeServices({ ownCommits: 3 });
    // Even if the DB-side helper would say true, own commits mean git already
    // has a real answer via landed/delivered — completedNoCode must not fire.
    sessionCompletedNoCodeWork.mockReturnValue(true);

    const ops = createGitOps(services);
    const res = await ops.getDeliveryState({ sessionId: SID });

    expect(res.success).toBe(true);
    if (!res.success) throw new Error('expected success');
    expect(res.data.completedNoCode).toBe(false);
    expect(res.data.ownCommits).toBe(3);
  });

  it('reports completedNoCode:false when there is no completed no-code run (e.g. a Sprint run, or one still at a gate)', async () => {
    const { services } = makeServices({ ownCommits: 0 });
    sessionCompletedNoCodeWork.mockReturnValue(false);

    const ops = createGitOps(services);
    const res = await ops.getDeliveryState({ sessionId: SID });

    expect(res.success).toBe(true);
    if (!res.success) throw new Error('expected success');
    expect(res.data.completedNoCode).toBe(false);
  });

  it('still surfaces delivered/landed/ownCommits independently of completedNoCode', async () => {
    const { services } = makeServices({ ownCommits: 0, landed: true });
    sessionDeliveredWork.mockReturnValue(true);
    sessionCompletedNoCodeWork.mockReturnValue(false);

    const ops = createGitOps(services);
    const res = await ops.getDeliveryState({ sessionId: SID });

    expect(res.success).toBe(true);
    if (!res.success) throw new Error('expected success');
    expect(res.data).toEqual({ delivered: true, landed: true, ownCommits: 0, completedNoCode: false, integratedLaneCount: 0 });
  });

  it('fails soft with landed:false/ownCommits:0 (and therefore never fires completedNoCode) when there is no worktree/project to probe', async () => {
    const { services } = makeServices({ worktreePath: null });
    sessionCompletedNoCodeWork.mockReturnValue(true);

    const ops = createGitOps(services);
    const res = await ops.getDeliveryState({ sessionId: SID });

    expect(res.success).toBe(true);
    if (!res.success) throw new Error('expected success');
    // ownCommits stays at its fail-soft default of 0 — an UNPROVEN zero. The
    // "completed with no repository changes" claim needs a proven zero, so the
    // operator gets the plain confirmation instead.
    expect(res.data.landed).toBe(false);
    expect(res.data.ownCommits).toBe(0);
    expect(res.data.completedNoCode).toBe(false);
  });

  it('does not fire completedNoCode when the git landing probe itself fails (ownCommits never established)', async () => {
    const { services, getBranchLandingState } = makeServices({ ownCommits: 0 });
    getBranchLandingState.mockRejectedValueOnce(new Error('fatal: not a git repository'));
    sessionCompletedNoCodeWork.mockReturnValue(true);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const ops = createGitOps(services);
    const res = await ops.getDeliveryState({ sessionId: SID });
    errorSpy.mockRestore();

    expect(res.success).toBe(true);
    if (!res.success) throw new Error('expected success');
    expect(res.data).toEqual({ delivered: false, landed: false, ownCommits: 0, completedNoCode: false, integratedLaneCount: 0 });
  });

  it('fires completedNoCode when the probe SUCCEEDS with zero own commits and the helper agrees', async () => {
    const { services } = makeServices({ ownCommits: 0 });
    sessionCompletedNoCodeWork.mockReturnValue(true);

    const ops = createGitOps(services);
    const res = await ops.getDeliveryState({ sessionId: SID });

    expect(res.success).toBe(true);
    if (!res.success) throw new Error('expected success');
    expect(res.data.completedNoCode).toBe(true);
  });
});
