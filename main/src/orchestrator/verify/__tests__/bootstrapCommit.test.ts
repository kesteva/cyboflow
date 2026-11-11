/**
 * Unit tests for the bootstrap's pathspec commit
 * (docs/proposals/lane-runbook-bootstrap.md §8 check 4, §9).
 *
 * The defect this replaces is specific and was found by both adversarial
 * reviews: v1 used `git add -f` plus a BARE `git commit`, in a worktree five
 * sprint lanes are editing concurrently. A bare commit takes whatever is staged,
 * so the "runbook commit" would silently carry another lane's half-finished
 * work — and the guard that was supposed to make this safe would then have
 * "safely" reverted it.
 *
 * So the assertions here are mostly about the exact argv, which is unusual for a
 * test and correct for this one: the difference between safe and unsafe is
 * entirely in whether `--` and the pathspec are present on the commit.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  commitPathspec,
  isIndexLockContention,
  INDEX_LOCK_MAX_ATTEMPTS,
  type GitRunner,
} from '../bootstrapCommit';

/** A fake git that records argv and answers `rev-parse` with a scripted sha. */
function fakeGit(over: { shas?: string[]; fail?: (args: string[], call: number) => Error | null } = {}): {
  git: GitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const shas = over.shas ?? ['head-before', 'head-after'];
  let revParseCount = 0;
  let call = 0;
  const git: GitRunner = async (args) => {
    calls.push(args);
    call += 1;
    const failure = over.fail?.(args, call);
    if (failure) throw failure;
    if (args[0] === 'rev-parse') {
      const sha = shas[Math.min(revParseCount, shas.length - 1)];
      revParseCount += 1;
      return `${sha}\n`;
    }
    return '';
  };
  return { git, calls };
}

describe('commitPathspec', () => {
  it('stages and commits EXACTLY the named paths, never a bare commit', () => {
    // The whole defect in one assertion: `commit -- <paths>` is a partial
    // commit, so git builds a temporary index from HEAD plus these paths and
    // whatever siblings have staged is neither committed nor disturbed.
    //
    // `-f` on the add is load-bearing too: many repos exclude `.cyboflow/` (it is
    // where cyboflow keeps its own worktrees), so a plain `git add` of the
    // runbook is a silent no-op there, and it surfaced live on the setup flow
    // ten minutes later as a proof failing against a snapshot that did not
    // contain the file.
    const { git, calls } = fakeGit();
    return commitPathspec({ git, paths: ['.cyboflow/verify-runbook.json'], message: 'msg' }).then(() => {
      expect(calls[0]).toEqual(['add', '-f', '--', '.cyboflow/verify-runbook.json']);
      const commit = calls.find((c) => c[0] === 'commit');
      expect(commit).toEqual(['commit', '-m', 'msg', '--', '.cyboflow/verify-runbook.json']);
    });
  });

  it('returns the resulting HEAD sha', async () => {
    // Load-bearing downstream: the sha is recorded on the stamp and EXCLUDED
    // from every sibling lane's commit-integrity probe.
    const { git } = fakeGit({ shas: ['before', 'after'] });
    await expect(commitPathspec({ git, paths: ['a.json'], message: 'm' })).resolves.toBe('after');
  });

  it('treats an EMPTY commit as success, returning HEAD unchanged', async () => {
    // The re-run-after-a-crash case: the content on disk already matches HEAD,
    // so the tree already says what this was trying to say. The returned sha IS
    // the commit carrying this content, which is exactly what the caller records.
    const { git } = fakeGit({
      shas: ['head-x'],
      fail: (args) => (args[0] === 'commit' ? new Error('nothing to commit, working tree clean') : null),
    });
    await expect(commitPathspec({ git, paths: ['a.json'], message: 'm' })).resolves.toBe('head-x');
  });

  it('rejects on a real commit failure', async () => {
    const { git } = fakeGit({
      fail: (args) => (args[0] === 'commit' ? new Error('Author identity unknown') : null),
    });
    await expect(commitPathspec({ git, paths: ['a.json'], message: 'm' })).rejects.toThrow(/Author identity/);
  });

  it('requires at least one path', async () => {
    const { git } = fakeGit();
    await expect(commitPathspec({ git, paths: [], message: 'm' })).rejects.toThrow(/at least one path/);
  });
});

describe('commitPathspec — index.lock', () => {
  it('retries a lock collision, which is an ORDINARY event on a shared worktree', async () => {
    // Concurrent lanes run git constantly and hold `.git/index.lock` for the
    // duration of each command. A bootstrap that gave up because a sibling was
    // mid-`git status` would fail for a reason unrelated to the project.
    let addAttempts = 0;
    const { git } = fakeGit({
      fail: (args) => {
        if (args[0] !== 'add') return null;
        addAttempts += 1;
        return addAttempts < 3 ? new Error("Unable to create '/repo/.git/index.lock': File exists.") : null;
      },
    });
    await expect(commitPathspec({ git, paths: ['a.json'], message: 'm', backoffMs: 1 })).resolves.toBe('head-after');
    expect(addAttempts).toBe(3);
  });

  it('gives up after the attempt cap rather than retrying forever', async () => {
    let attempts = 0;
    const { git } = fakeGit({
      fail: (args) => {
        if (args[0] !== 'add') return null;
        attempts += 1;
        return new Error('index.lock exists');
      },
    });
    await expect(commitPathspec({ git, paths: ['a.json'], message: 'm', backoffMs: 1 })).rejects.toThrow(
      /index\.lock/,
    );
    expect(attempts).toBe(INDEX_LOCK_MAX_ATTEMPTS);
  });

  it('does NOT retry an error that waiting cannot fix', async () => {
    // A missing author identity does not become true by waiting, and retrying it
    // would turn a two-second error into a ten-second one while the owning lane
    // is parked.
    let attempts = 0;
    const { git } = fakeGit({
      fail: (args) => {
        if (args[0] !== 'add') return null;
        attempts += 1;
        return new Error('fatal: pathspec did not match any files');
      },
    });
    await expect(commitPathspec({ git, paths: ['a.json'], message: 'm' })).rejects.toThrow(/pathspec/);
    expect(attempts).toBe(1);
  });

  it('logs each retry so a slow bootstrap is explicable', async () => {
    const debug = vi.fn();
    let attempts = 0;
    const { git } = fakeGit({
      fail: (args) => {
        if (args[0] !== 'add') return null;
        attempts += 1;
        return attempts < 2 ? new Error('index.lock') : null;
      },
    });
    await commitPathspec({
      git,
      paths: ['a.json'],
      message: 'm',
      backoffMs: 1,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug },
    });
    expect(debug).toHaveBeenCalled();
  });
});

describe('isIndexLockContention', () => {
  it.each([
    "Unable to create '/repo/.git/index.lock': File exists.",
    'fatal: Another git process seems to be running in this repository',
    'error: could not lock config file .git/index.lock',
  ])('recognizes `%s`', (message) => {
    expect(isIndexLockContention(message)).toBe(true);
  });

  it.each([
    'fatal: Author identity unknown',
    'error: pathspec did not match any file(s) known to git',
    'fatal: not a git repository',
  ])('does not mistake `%s` for contention', (message) => {
    // Matched on the message because git offers no other channel — a lock
    // collision exits 128 exactly like a dozen unrelated errors, so keying on
    // the code would retry things that can never succeed.
    expect(isIndexLockContention(message)).toBe(false);
  });
});
