/**
 * WorktreeManager against hostile repo-controlled refs.
 *
 * Branch names, remote names and refs come off disk and reach almost every
 * method here on an ordinary dashboard refresh. Two distinct attacks have to be
 * closed, and they need different proofs:
 *
 *  1. SHELL injection — a branch literally named `$(id>/tmp/…)`. Proven end to
 *     end against real git: the sentinel file must not appear.
 *  2. git OPTION injection — a ref that starts with `-`, e.g.
 *     `--upload-pack=…`. Shell-freedom does nothing here, so the proof is at the
 *     argv level: `--end-of-options` must sit between the flags and the ref.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../../utils/runGit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/runGit')>()),
  runGitCapture: vi.fn(),
}));

import { runGitCapture, END_OF_OPTIONS } from '../../utils/runGit';
import { WorktreeManager } from '../worktreeManager';
import { withTempDir } from '../../__test_fixtures__/tmp';

/** A ref that would be parsed as a git option if it landed in a flag position. */
const OPTION_REF = '--upload-pack=touch /tmp/cyboflow-option-injection';

type Call = [string, string[]];

function callsFor(subcommand: string): Call[] {
  return vi
    .mocked(runGitCapture)
    .mock.calls.map(([cwd, args]) => [cwd, args] as Call)
    .filter(([, args]) => args[0] === subcommand);
}

/** The argv slice from END_OF_OPTIONS onward, or null when the marker is absent. */
function afterEndOfOptions(args: string[]): string[] | null {
  const idx = args.indexOf(END_OF_OPTIONS);
  return idx === -1 ? null : args.slice(idx + 1);
}

beforeEach(() => {
  vi.mocked(runGitCapture).mockReset();
  vi.mocked(runGitCapture).mockResolvedValue({ stdout: '', stderr: '' });
});

describe('option-injection: a ref starting with "-" never reaches git as an option', () => {
  it('deleteBranch places the branch after --end-of-options', async () => {
    await new WorktreeManager().deleteBranch('/repo', OPTION_REF, { force: true });

    const [[, args]] = callsFor('branch');
    expect(args.slice(0, 2)).toEqual(['branch', '-D']);
    expect(afterEndOfOptions(args)).toEqual([OPTION_REF]);
  });

  it('createBranchRef guards both the new branch and its base', async () => {
    vi.mocked(runGitCapture).mockResolvedValue({ stdout: 'deadbeef\n', stderr: '' });

    await new WorktreeManager().createBranchRef('/repo', OPTION_REF, `${OPTION_REF}-base`);

    const [[, createArgs]] = callsFor('branch');
    expect(afterEndOfOptions(createArgs)).toEqual([OPTION_REF, `${OPTION_REF}-base`]);

    const [[, revParseArgs]] = callsFor('rev-parse');
    expect(afterEndOfOptions(revParseArgs)).toEqual([OPTION_REF]);
  });

  it('hasChangesToRebase guards the rev-list range', async () => {
    vi.mocked(runGitCapture).mockResolvedValue({ stdout: '0\n', stderr: '' });

    await new WorktreeManager().hasChangesToRebase('/wt', OPTION_REF);

    const [[, args]] = callsFor('rev-list');
    expect(afterEndOfOptions(args)).toEqual([`HEAD..${OPTION_REF}`]);
  });

  it('getOriginBranch guards the origin/<branch> ref', async () => {
    await new WorktreeManager().getOriginBranch('/wt', OPTION_REF);

    const [[, args]] = callsFor('rev-parse');
    expect(afterEndOfOptions(args)).toEqual([`origin/${OPTION_REF}`]);
  });

  it('mergeWorktreeToBranch guards the target branch in rebase and branch -f', async () => {
    vi.mocked(runGitCapture)
      .mockResolvedValueOnce({ stdout: 'feature\n', stderr: '' }) // branch --show-current
      .mockResolvedValue({ stdout: 'abc1234 a commit\n', stderr: '' });

    await new WorktreeManager().mergeWorktreeToBranch('/repo', '/wt', OPTION_REF);

    const [[, logArgs]] = callsFor('log');
    expect(afterEndOfOptions(logArgs)).toEqual([`${OPTION_REF}..HEAD`]);

    const [[, rebaseArgs]] = callsFor('rebase');
    expect(afterEndOfOptions(rebaseArgs)).toEqual([OPTION_REF]);

    const forcedBranch = callsFor('branch').find(([, args]) => args.includes('-f'));
    expect(forcedBranch).toBeDefined();
    expect(afterEndOfOptions(forcedBranch![1])).toEqual([OPTION_REF, 'HEAD']);
  });

  it('getLastCommits coerces the IPC-supplied count instead of trusting it', async () => {
    // `count` arrives straight off an IPC channel; the string below would be a
    // second argv element (and an option) if it were interpolated unchecked.
    await new WorktreeManager().getLastCommits('/wt', '5 --upload-pack=touch /tmp/x' as unknown as number);

    const [[, args]] = callsFor('log');
    // Unparseable -> the documented default, never a second argv element.
    expect(args).toContain('-20');
    expect(args.some(a => a.includes('upload-pack'))).toBe(false);
  });

  it('merge-tree, which predates --end-of-options, refuses the ref instead of passing it', async () => {
    const manager = new WorktreeManager();
    vi.spyOn(manager, 'hasChangesToRebase').mockResolvedValue(true);
    vi.mocked(runGitCapture).mockResolvedValue({ stdout: 'deadbeef\n', stderr: '' });

    await manager.checkForRebaseConflicts('/wt', OPTION_REF);

    // assertNotOptionLike throws before the spawn, so merge-tree is never
    // invoked; the method's existing "merge-tree unavailable" fallback takes
    // over, and its diff/log reads are marker-guarded.
    expect(callsFor('merge-tree')).toEqual([]);
    const fallbackReads = [...callsFor('diff'), ...callsFor('log')];
    expect(fallbackReads.length).toBeGreaterThan(0);
    for (const [, args] of fallbackReads) {
      expect(afterEndOfOptions(args)).toHaveLength(1);
    }
    expect(fallbackReads.some(([, args]) => args.some(a => a.includes(OPTION_REF)))).toBe(true);
  });
});

  // POSIX-only: the hostile fixture needs a refname containing '>' (a shell
  // redirect). Git-for-Windows refuses refnames that are invalid Windows
  // filenames, so a branch that would cmd-substitute cannot exist there; the
  // argv-form (shell-less) spawn guarantees are pinned by the suites above.
  describe.skipIf(process.platform === 'win32')(
    'shell injection: a branch named $(…) is inert against real git',
    () => {
  const SENTINEL = join(tmpdir(), 'cyboflow-worktree-shell-injection-sentinel');
  const HOSTILE_BRANCH = `$(id>${SENTINEL})`;

  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }

  beforeEach(() => {
    // Un-mock for this block: these tests must reach real git.
    vi.mocked(runGitCapture).mockImplementation(async (cwd, args, options) => {
      const actual = await vi.importActual<typeof import('../../utils/runGit')>('../../utils/runGit');
      return actual.runGitCapture(cwd, args, options);
    });
    rmSync(SENTINEL, { force: true });
  });

  it('a worktree can be cut from a base branch whose name is a shell command', async () => {
    await withTempDir('wt-hostile-', async (repo) => {
      git(repo, ['init', '-q', '.']);
      git(repo, ['config', 'user.email', 'test@example.com']);
      git(repo, ['config', 'user.name', 'Test']);
      git(repo, ['config', 'commit.gpgsign', 'false']);
      git(repo, ['commit', '-q', '--allow-empty', '-m', 'base']);
      git(repo, ['branch', HOSTILE_BRANCH]);

      const manager = new WorktreeManager();
      const result = await manager.createWorktree(repo, 'derived', undefined, HOSTILE_BRANCH);

      expect(result.baseBranch).toBe(HOSTILE_BRANCH);
      expect(existsSync(result.worktreePath)).toBe(true);
      expect(existsSync(SENTINEL)).toBe(false);

      await manager.removeWorktreeByPath(repo, result.worktreePath);
    });
  });

  it('listBranches reports the hostile name verbatim without executing it', async () => {
    await withTempDir('wt-hostile-list-', async (repo) => {
      git(repo, ['init', '-q', '.']);
      git(repo, ['config', 'user.email', 'test@example.com']);
      git(repo, ['config', 'user.name', 'Test']);
      git(repo, ['config', 'commit.gpgsign', 'false']);
      git(repo, ['commit', '-q', '--allow-empty', '-m', 'base']);
      git(repo, ['branch', HOSTILE_BRANCH]);

      const manager = new WorktreeManager();
      const branches = await manager.listBranches(repo);

      expect(branches.map(b => b.name)).toContain(HOSTILE_BRANCH);
      expect(await manager.hasChangesToRebase(repo, HOSTILE_BRANCH)).toBe(false);
      expect(existsSync(SENTINEL)).toBe(false);
    });
  });
  },
);
