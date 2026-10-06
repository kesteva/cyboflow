/**
 * The renderer-facing git ops (main/src/ipc/gitOps.ts, behind the
 * `cyboflow.sessionGit` tRPC router), driven with hostile inputs.
 *
 * These take no free-form git arguments from the renderer — every procedure is
 * keyed by sessionId and builds its own command — so the injection surface is
 * the repo-derived main branch name plus the renderer-supplied commit MESSAGE.
 * Both are asserted at the argv level.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { isPackaged: false, getPath: vi.fn(() => '/mock'), getName: () => 'Cyboflow', getVersion: () => '0.1.0' },
}));
vi.mock('../../index', () => ({ mainWindow: null }));
vi.mock('../../services/panelManager', () => ({
  panelManager: { createPanel: vi.fn(), getPanelsForSession: vi.fn(() => []) },
}));

vi.mock('../../utils/runGit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/runGit')>()),
  runGit: vi.fn(() => ''),
  runGitAsync: vi.fn(async () => ''),
}));

import { runGit, END_OF_OPTIONS } from '../../utils/runGit';
import { createGitOps } from '../gitOps';
import type { SessionGitOpsLike } from '../../orchestrator/trpc/contracts/sessionGitOps';
import type { AppServices } from '../types';

const OPTION_REF = '--upload-pack=touch /tmp/cyboflow-git-handler-injection';

function inertDb() {
  const stmt = { run: () => ({ changes: 0 }), get: () => undefined, all: () => [] };
  return { prepare: () => stmt, transaction: <T>(fn: (...a: unknown[]) => T) => fn };
}

function register(): SessionGitOpsLike {
  const services = {
    sessionManager: {
      getSession: vi.fn(async () => ({ id: 's1', worktreePath: '/wt', archived: false, isMainRepo: false })),
      getProjectForSession: vi.fn(() => ({ id: 1, name: 'Proj', path: '/repo' })),
    },
    worktreeManager: {
      getProjectMainBranch: vi.fn(async () => OPTION_REF),
      getOriginBranch: vi.fn(async () => null),
      generateRebaseCommands: () => [],
      generateSquashCommands: () => [],
      generateMergeCommands: () => [],
    },
    gitDiffManager: {},
    gitStatusManager: { refreshSessionGitStatus: vi.fn(async () => {}) },
    databaseService: { getDb: () => inertDb() },
    claudeCodeManager: {},
  } as unknown as AppServices;
  return createGitOps(services);
}

function argsFor(subcommand: string): string[][] {
  return vi.mocked(runGit).mock.calls.map(([, args]) => args).filter(args => args[0] === subcommand);
}

beforeEach(() => {
  vi.mocked(runGit).mockReset().mockReturnValue('');
});

describe('renderer-facing git ops with hostile inputs', () => {
  it('getBranchCommitSubjects guards the repo-derived main branch', async () => {
    const ops = register();
    await ops.getBranchCommitSubjects({ sessionId: 's1' });

    const [args] = argsFor('log');
    expect(args.slice(0, 2)).toEqual(['log', '--pretty=%s']);
    expect(args.slice(args.indexOf(END_OF_OPTIONS) + 1)).toEqual([`${OPTION_REF}..HEAD`]);
  });

  it('commit passes the message as its own argv element, not a quoted shell fragment', async () => {
    // A message that terminates a shell string and appends a command; as argv it
    // is inert, and it must reach git verbatim rather than escaped.
    const message = `fix: thing'; touch /tmp/cyboflow-commit-injection; echo '`;
    vi.mocked(runGit).mockImplementation((_cwd, args) => (args[0] === 'status' ? ' M a.txt\n' : ''));

    const ops = register();
    const result = (await ops.commit({ sessionId: 's1', message })) as { success: boolean };
    expect(result.success).toBe(true);

    const [args] = argsFor('commit');
    expect(args).toEqual(['commit', '-m', message]);
  });

  it('commit refuses when the worktree is clean, without staging anything', async () => {
    const ops = register();
    const result = (await ops.commit({ sessionId: 's1', message: 'msg' })) as { success: boolean };

    expect(result.success).toBe(false);
    expect(argsFor('add')).toEqual([]);
    expect(argsFor('commit')).toEqual([]);
  });
});
