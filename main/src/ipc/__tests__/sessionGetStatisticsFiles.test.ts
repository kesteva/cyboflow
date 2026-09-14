/**
 * sessionOps.getStatistics — the `files` block.
 *
 * The ops implementation behind the `cyboflow.sessions.getStatistics` tRPC
 * procedure, formerly the `sessions:get-statistics` IPC handler.
 *
 * Regression guard for the quick-session card reading "0 files seen / +0 −0"
 * beside a Diff tab listing hundreds of changed files. It used to sum
 * `execution_diffs`, which ExecutionTracker only writes when the agent PROCESS
 * EXITS — a warm-SDK / PTY quick session keeps one process alive across every
 * turn, so it has NO rows at all however much it edits.
 *
 * It now diffs the worktree against the session's branch point and
 * only falls back to the execution_diffs aggregation when git cannot answer
 * (archived session whose worktree is gone, gc'd base commit).
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
    getPanelsForSession: vi.fn(() => [] as Array<{ id: string; type: string }>),
    createPanel: vi.fn(),
  },
}));

vi.mock('../../services/database', () => ({
  databaseService: {
    getSession: vi.fn(() => ({ id: 'sess-001', status: 'running', archived: false })),
  },
}));

vi.mock('../../services/gitPlumbingCommands', () => ({
  getCurrentBranch: vi.fn(() => 'quick-session-branch'),
}));

const { mockRunGitAsync } = vi.hoisted(() => ({
  mockRunGitAsync: vi.fn<(cwd: string, args: string[]) => Promise<string>>(),
}));

// Backs sessionFileStats' base-ref resolution (`git rev-parse --verify …`).
vi.mock('../../utils/runGit', () => ({
  runGitAsync: mockRunGitAsync,
  runGit: vi.fn(),
  END_OF_OPTIONS: '--end-of-options',
  assertNotOptionLike: (value: string, label: string) => {
    if (value.startsWith('-')) {
      throw new Error(`Refusing to pass ${label} "${value}" to git: values starting with "-" are parsed as options`);
    }
    return value;
  },
}));

import { createSessionOps } from '../sessionOps';
import type { SessionOpsLike } from '../../orchestrator/trpc/contracts/sessionOps';
import type { AppServices } from '../types';

const SESSION_ID = 'sess-001';
const WORKTREE = '/tmp/project/quick-test';
const BASE_COMMIT = 'a'.repeat(40);

interface StatisticsResult {
  success: boolean;
  data: {
    files: {
      totalFilesChanged: number;
      totalLinesAdded: number;
      totalLinesDeleted: number;
      filesModified: string[];
      executionCount: number;
    };
  };
}

/** One execution_diffs row — the legacy source, kept as the git-less fallback. */
function executionDiffRow() {
  return {
    stats_additions: 7,
    stats_deletions: 3,
    stats_files_changed: 1,
    files_changed: ['legacy.ts'],
    before_commit_hash: 'b'.repeat(40),
    after_commit_hash: 'c'.repeat(40),
  };
}

function makeServices(opts: {
  getDiffStatsAgainstRef: ReturnType<typeof vi.fn>;
  baseCommit?: string;
  worktreePath?: string | null;
  isMainRepo?: boolean;
  originBranch?: string | null;
}) {
  const fakeDb = { prepare: vi.fn(() => ({ all: vi.fn(() => []) })) };

  const services = {
    sessionManager: {
      getSession: vi.fn(() => ({
        id: SESSION_ID,
        name: 'Test Session',
        status: 'running',
        createdAt: new Date('2026-08-01T00:00:00Z'),
        lastActivity: new Date('2026-08-01T00:05:00Z'),
        worktreePath: opts.worktreePath === undefined ? WORKTREE : opts.worktreePath,
        baseBranch: 'main',
        baseCommit: opts.baseCommit,
        isMainRepo: opts.isMainRepo ?? false,
      })),
      getProjectForSession: vi.fn(() => ({ id: 1, path: '/tmp/project' })),
    },
    databaseService: {
      getSessionTokenUsage: vi.fn(() => ({
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        messageCount: 0,
      })),
      getExecutionDiffStats: vi.fn(() => [executionDiffRow()]),
      getSessionOutputCounts: vi.fn(() => ({ json: 0, stdout: 0, stderr: 0 })),
      getSessionToolUsage: vi.fn(() => ({ tools: [], totalToolCalls: 0 })),
      getPromptMarkers: vi.fn(() => []),
      getConversationMessageCount: vi.fn(() => 0),
      getPanelSettings: vi.fn(() => ({})),
      getDb: vi.fn(() => fakeDb),
    },
    taskQueue: {},
    worktreeManager: {
      getProjectMainBranch: vi.fn(async () => 'main'),
      getOriginBranch: vi.fn(async () => (opts.originBranch === undefined ? 'origin/main' : opts.originBranch)),
    },
    gitDiffManager: { getDiffStatsAgainstRef: opts.getDiffStatsAgainstRef },
    cliManagerFactory: {},
    claudeCodeManager: { isPanelRunning: vi.fn(() => false) },
    interactiveCliManager: { isPanelRunning: vi.fn(() => false) },
    killLiveSession: vi.fn(),
    registerLivePanel: vi.fn(),
    gitStatusManager: {},
    archiveProgressManager: undefined,
    configManager: { isDemoMode: () => false },
    cyboflow: { workflowRegistry: {}, runLauncher: {} },
  } as unknown as AppServices;

  return createSessionOps(services);
}

async function invoke(ops: SessionOpsLike) {
  return (await ops.getStatistics({ sessionId: SESSION_ID })) as StatisticsResult;
}

describe('sessionOps.getStatistics — file statistics', () => {
  beforeEach(() => {
    mockRunGitAsync.mockReset();
    // Every ref candidate resolves unless a test says otherwise.
    mockRunGitAsync.mockResolvedValue('');
  });

  it('reports the git diff against the session base commit, not the execution_diffs sum', async () => {
    const getDiffStatsAgainstRef = vi.fn(async () => ({
      stats: { additions: 15443, deletions: 745, filesChanged: 177 },
      changedFiles: ['CHANGELOG.md', 'docs/ARCHITECTURE.md'],
    }));
    const ops = makeServices({ getDiffStatsAgainstRef, baseCommit: BASE_COMMIT });

    const result = await invoke(ops);

    expect(result.success).toBe(true);
    expect(result.data.files.totalFilesChanged).toBe(177);
    expect(result.data.files.totalLinesAdded).toBe(15443);
    expect(result.data.files.totalLinesDeleted).toBe(745);
    expect(result.data.files.filesModified).toEqual(['CHANGELOG.md', 'docs/ARCHITECTURE.md']);
    expect(getDiffStatsAgainstRef).toHaveBeenCalledWith(WORKTREE, BASE_COMMIT);
    // executionCount keeps measuring what it always measured: exited turns.
    expect(result.data.files.executionCount).toBe(1);
  });

  it('reports a genuinely untouched worktree as zero', async () => {
    const getDiffStatsAgainstRef = vi.fn(async () => ({
      stats: { additions: 0, deletions: 0, filesChanged: 0 },
      changedFiles: [],
    }));
    const ops = makeServices({ getDiffStatsAgainstRef, baseCommit: BASE_COMMIT });

    const result = await invoke(ops);

    expect(result.data.files.totalFilesChanged).toBe(0);
    expect(result.data.files.filesModified).toEqual([]);
  });

  it('falls back to the execution_diffs aggregation when git cannot answer', async () => {
    // No worktree to diff (archived session): the historical rows are all we have.
    const getDiffStatsAgainstRef = vi.fn();
    const ops = makeServices({
      getDiffStatsAgainstRef,
      baseCommit: BASE_COMMIT,
      worktreePath: null,
    });

    const result = await invoke(ops);

    expect(getDiffStatsAgainstRef).not.toHaveBeenCalled();
    expect(result.data.files.totalFilesChanged).toBe(1);
    expect(result.data.files.totalLinesAdded).toBe(7);
    expect(result.data.files.totalLinesDeleted).toBe(3);
    expect(result.data.files.filesModified).toEqual(['legacy.ts']);
  });

  it('compares a main-repo session against the REMOTE tip, not the branch it commits to', async () => {
    // A main-repo session works on the main branch itself and is created with
    // no base_commit, so comparing against `main` compares HEAD to itself: its
    // own commits advance the ref and disappear from the count. The Diff tab
    // uses origin/<main> for these sessions; the card must agree.
    const getDiffStatsAgainstRef = vi.fn(async () => ({
      stats: { additions: 30, deletions: 4, filesChanged: 3 },
      changedFiles: ['a.ts', 'b.ts', 'c.ts'],
    }));
    const ops = makeServices({ getDiffStatsAgainstRef, baseCommit: undefined, isMainRepo: true });

    const result = await invoke(ops);

    expect(getDiffStatsAgainstRef).toHaveBeenCalledWith(WORKTREE, 'origin/main');
    expect(result.data.files.totalFilesChanged).toBe(3);
  });

  it('falls back to the local main branch for a main-repo session with no remote', async () => {
    const getDiffStatsAgainstRef = vi.fn(async () => ({
      stats: { additions: 1, deletions: 0, filesChanged: 1 },
      changedFiles: ['a.ts'],
    }));
    const ops = makeServices({
      getDiffStatsAgainstRef,
      baseCommit: undefined,
      isMainRepo: true,
      originBranch: null,
    });

    await invoke(ops);

    expect(getDiffStatsAgainstRef).toHaveBeenCalledWith(WORKTREE, 'main');
  });

  it('falls back to the project main branch when the recorded base commit no longer resolves', async () => {
    mockRunGitAsync.mockImplementation(async (_cwd: string, args: string[]) => {
      if (args.includes(`${BASE_COMMIT}^{commit}`)) throw new Error('unknown revision');
      return '';
    });
    const getDiffStatsAgainstRef = vi.fn(async () => ({
      stats: { additions: 4, deletions: 1, filesChanged: 2 },
      changedFiles: ['x.ts', 'y.ts'],
    }));
    const ops = makeServices({ getDiffStatsAgainstRef, baseCommit: BASE_COMMIT });

    const result = await invoke(ops);

    expect(getDiffStatsAgainstRef).toHaveBeenCalledWith(WORKTREE, 'main');
    expect(result.data.files.totalFilesChanged).toBe(2);
  });
});
