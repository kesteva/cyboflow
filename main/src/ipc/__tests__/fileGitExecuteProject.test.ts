/**
 * `git:execute-project` — the subcommand allowlist and argv construction
 * (main/src/ipc/fileOps.ts → PROJECT_GIT_SUBCOMMANDS).
 *
 * This channel is the only renderer-facing surface that takes a git argv. It
 * used to run `execSync(\`git ${escapeShellArgs(args)}\`)` — shell-escaped, so
 * not injectable as a shell command, but still "whatever git subcommand the
 * renderer asks for" inside the user's real project directory: `push`,
 * `config --global`, `clone`, `-c core.pager=…`. TASK-680 moved it to argv-form
 * git (execFile, no shell) behind an allowlist of the two argv SHAPES the
 * renderer actually sends, both from SetupTasksPanel.tsx.
 *
 * The tests drive the REAL ops with `runGitCapture` stubbed, so they assert
 * the argv that would actually be spawned rather than a reconstructed string.
 *
 * `git:restore`, the other op migrated off shell strings in the same change, is
 * covered here too.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: vi.fn(() => '/mock') } }));

const { gitCalls, gitResult } = vi.hoisted(() => ({
  gitCalls: [] as Array<{ cwd: string; args: string[] }>,
  gitResult: { value: { stdout: '', stderr: '' } as { stdout: string; stderr: string } | Error },
}));

vi.mock('../../utils/runGit', async (importOriginal) => {
  // Keep the REAL assertNotOptionLike / END_OF_OPTIONS — they are part of what
  // is under test; only the process spawn is stubbed.
  const actual = await importOriginal<typeof import('../../utils/runGit')>();
  return {
    ...actual,
    runGitCapture: vi.fn(async (cwd: string, args: string[]) => {
      gitCalls.push({ cwd, args });
      if (gitResult.value instanceof Error) throw gitResult.value;
      return gitResult.value;
    }),
  };
});

import { createFileOps } from '../fileOps';
import type { AppServices } from '../types';
import type { Session } from '../../types/session';

const PROJECT_PATH = '/tmp/cyboflow-test-project';
const WORKTREE_PATH = '/tmp/cyboflow-test-worktree';

let ops: ReturnType<typeof createFileOps>;

beforeEach(() => {
  gitCalls.length = 0;
  gitResult.value = { stdout: '', stderr: '' };

  const session = { id: 's1', worktreePath: WORKTREE_PATH, archived: false } as unknown as Session;
  ops = createFileOps({
    sessionManager: { getSession: vi.fn(() => session) },
    databaseService: { getProject: vi.fn(() => ({ id: 1, path: PROJECT_PATH })) },
  } as unknown as AppServices);
});

const executeProject = (args: string[]) => ops.gitExecuteProject({ projectId: 1, args });

describe('git:execute-project — allowed shapes pass through as argv', () => {
  it('runs `add` with END_OF_OPTIONS before the pathspec, in the project cwd', async () => {
    const res = await executeProject(['add', '.gitignore']);
    expect(res.success).toBe(true);
    expect(gitCalls).toEqual([
      { cwd: PROJECT_PATH, args: ['add', '--end-of-options', '.gitignore'] },
    ]);
  });

  it('runs `commit -m <message>` verbatim, with the message as one argv element', async () => {
    const message = 'Add Cyboflow worktree patterns\n\n- /worktrees/\n- /worktree-*/';
    const res = await executeProject(['commit', '-m', message]);
    expect(res.success).toBe(true);
    expect(gitCalls).toEqual([{ cwd: PROJECT_PATH, args: ['commit', '-m', message] }]);
  });

  it('returns git stdout as `output`', async () => {
    gitResult.value = { stdout: '[main abc1234] done\n', stderr: '' };
    const res = await executeProject(['add', '.gitignore']);
    expect(res.success && res.output).toBe('[main abc1234] done\n');
  });

  it('accepts multiple pathspecs for add', async () => {
    await executeProject(['add', '.gitignore', 'README.md']);
    expect(gitCalls[0].args).toEqual(['add', '--end-of-options', '.gitignore', 'README.md']);
  });

  it('never passes a shell string — the argv is an array of discrete tokens', async () => {
    // A message with shell metacharacters stays ONE argv element; there is no
    // string for a shell to reparse.
    const nasty = '; rm -rf / #$(id)`id`';
    await executeProject(['commit', '-m', nasty]);
    expect(gitCalls[0].args).toEqual(['commit', '-m', nasty]);
  });
});

describe('git:execute-project — the allowlist rejects everything else', () => {
  it.each([
    ['push', ['push', 'origin', 'main']],
    ['clone', ['clone', 'https://attacker.example/repo.git']],
    ['config', ['config', '--global', 'core.pager', 'sh -c id']],
    ['fetch', ['fetch', '--all']],
    ['reset', ['reset', '--hard', 'HEAD~5']],
    ['checkout', ['checkout', 'main']],
    ['status', ['status']],
  ])('rejects `%s` without spawning anything', async (_name, args) => {
    const res = await executeProject(args);
    expect(res.success).toBe(false);
    expect(gitCalls).toEqual([]);
  });

  it('names the offending subcommand and points at the allowlist', async () => {
    const res = await executeProject(['push']);
    expect(!res.success && res.error).toContain('push');
    expect(!res.success && res.error).toContain('PROJECT_GIT_SUBCOMMANDS');
    expect(!res.success && res.error).toContain('add, commit');
  });

  it('rejects a leading global option used to smuggle config', async () => {
    // `git -c core.pager='sh -c id' add .` — the subcommand is not args[0].
    const res = await executeProject(['-c', 'core.pager=sh -c id', 'add', '.']);
    expect(res.success).toBe(false);
    expect(gitCalls).toEqual([]);
  });

  it('rejects an empty argv', async () => {
    const res = await executeProject([]);
    expect(res.success).toBe(false);
    expect(gitCalls).toEqual([]);
  });

  it('does not resolve subcommands off Object.prototype', async () => {
    // A plain `record[key]` lookup would find `constructor`/`toString` and treat
    // them as builders.
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const res = await executeProject([key, 'x']);
      expect(res.success).toBe(false);
    }
    expect(gitCalls).toEqual([]);
  });
});

describe('git:execute-project — per-subcommand argument validation', () => {
  it('rejects an option-shaped pathspec for add', async () => {
    const res = await executeProject(['add', '--all']);
    expect(res.success).toBe(false);
    expect(!res.success && res.error).toMatch(/parsed as options/);
    expect(gitCalls).toEqual([]);
  });

  it('rejects an option-shaped pathspec even in a later position', async () => {
    const res = await executeProject(['add', '.gitignore', '--upload-pack=touch /tmp/pwned']);
    expect(res.success).toBe(false);
    expect(gitCalls).toEqual([]);
  });

  it('rejects add with no pathspec (which would stage everything)', async () => {
    const res = await executeProject(['add']);
    expect(res.success).toBe(false);
    expect(!res.success && res.error).toMatch(/at least one pathspec/);
  });

  it.each([
    ['--amend', ['commit', '--amend']],
    ['-F file', ['commit', '-F', '/etc/passwd']],
    ['extra pathspec', ['commit', '-m', 'msg', 'somefile']],
    ['bare commit', ['commit']],
    ['--author', ['commit', '-m', 'msg', '--author=x']],
  ])('rejects commit form: %s', async (_name, args) => {
    const res = await executeProject(args);
    expect(res.success).toBe(false);
    expect(!res.success && res.error).toMatch(/commit -m <message>/);
    expect(gitCalls).toEqual([]);
  });
});

describe('git:execute-project — error reporting', () => {
  it('prefers git stderr', async () => {
    const err = Object.assign(new Error('exit 1'), { stderr: 'fatal: bad thing\n', stdout: '' });
    gitResult.value = err;
    const res = await executeProject(['add', '.gitignore']);
    expect(res).toMatchObject({ success: false, error: 'fatal: bad thing\n' });
  });

  it('falls through an EMPTY stderr to stdout — "nothing to commit" is a stdout message', async () => {
    // SetupTasksPanel matches on this string to show its "already up to date"
    // path, so an empty stderr must not win the fallback.
    const err = Object.assign(new Error('exit 1'), {
      stderr: '',
      stdout: 'nothing to commit, working tree clean\n',
    });
    gitResult.value = err;
    const res = await executeProject(['commit', '-m', 'msg']);
    expect(res.success).toBe(false);
    expect(!res.success && res.error).toContain('nothing to commit');
  });
});

// ---------------------------------------------------------------------------
// The sibling op migrated off shell strings in the same change.
// ---------------------------------------------------------------------------

describe('git:restore — argv form', () => {
  it('runs reset --hard HEAD then clean -fd', async () => {
    const res = await ops.gitRestore({ sessionId: 's1' });
    expect(res.success).toBe(true);
    expect(gitCalls).toEqual([
      { cwd: WORKTREE_PATH, args: ['reset', '--hard', 'HEAD'] },
      { cwd: WORKTREE_PATH, args: ['clean', '-fd'] },
    ]);
  });
});
