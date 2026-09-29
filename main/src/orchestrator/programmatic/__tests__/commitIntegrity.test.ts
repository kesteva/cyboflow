import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { withTempDir } from '../../../__test_fixtures__/tmp';
import { runGitExit, type RunGitOptions } from '../../../utils/runGit';
import type { GitExit } from '../laneBuildSlots';
import {
  COMMITTED_BUILD_SLOTS_UNLISTED,
  checkCommittedBuildSlots,
  commitIntegrityExcerpt,
  committedBuildSlotsExcerpt,
  parsePorcelainPaths,
  unverifiedBuildSlotsExcerpt,
} from '../commitIntegrity';

describe('parsePorcelainPaths', () => {
  it('keeps the leading-space status column intact and returns each path', () => {
    // `runGitAsync` does not trim, so " M" (worktree-modified) keeps its space.
    expect(parsePorcelainPaths(' M src/a.ts\n?? src/new.ts\nA  src/b.ts\n')).toEqual([
      'src/a.ts',
      'src/new.ts',
      'src/b.ts',
    ]);
  });

  it('returns the destination of a rename', () => {
    expect(parsePorcelainPaths('R  old/x.ts -> new/x.ts\n')).toEqual(['new/x.ts']);
  });

  it('returns nothing for a clean tree', () => {
    expect(parsePorcelainPaths('')).toEqual([]);
  });
});

describe('commitIntegrityExcerpt', () => {
  it('flags ambiguous ownership and lists the NEW paths when siblings shared the worktree', () => {
    const text = commitIntegrityExcerpt(
      { headAdvanced: false, dirty: true, dirtyPaths: ['old.ts', 'new.ts'], newDirtyPaths: ['new.ts'] },
      true,
    );
    expect(text).toContain('OWNERSHIP IS AMBIGUOUS');
    expect(text).toContain('appeared while this lane ran');
    expect(text).toContain('- new.ts');
    expect(text).not.toContain('- old.ts');
  });

  it('says the lane ran alone and truncates long path lists', () => {
    const paths = Array.from({ length: 45 }, (_, i) => `f${i}.ts`);
    const text = commitIntegrityExcerpt({ headAdvanced: false, dirty: true, dirtyPaths: paths }, false);
    expect(text).toContain('No other lane was running');
    expect(text).toContain('- f39.ts');
    expect(text).not.toContain('- f40.ts');
    expect(text).toContain('… and 5 more');
  });
});

describe('committedBuildSlotsExcerpt', () => {
  it('lists the paths, names the fix, rules out accept, and says the files may predate the lane', () => {
    const text = committedBuildSlotsExcerpt(['.cyboflow/build-slots/slot-0/a.o'], false);
    expect(text).toContain('committed tree at the lane-end HEAD');
    expect(text).toContain('- .cyboflow/build-slots/slot-0/a.o');
    expect(text).toContain('git rm -r --cached -- .cyboflow/build-slots');
    expect(text).toContain('"accept" IS NOT AN OPTION');
    expect(text).toContain('no other lane was running');
    expect(text).toContain('already in HEAD when it started');
    expect(text).not.toContain('commits made while it ran');
  });

  it('names a sibling lane as a possible committer for an overlapped lane, and caps the list', () => {
    const paths = Array.from({ length: 25 }, (_, i) => `.cyboflow/build-slots/slot-1/f${i}.o`);
    const text = committedBuildSlotsExcerpt(paths, true);
    expect(text).toContain('a sibling lane');
    expect(text).toContain('SAME worktree');
    expect(text).toContain('- .cyboflow/build-slots/slot-1/f19.o');
    expect(text).not.toContain('- .cyboflow/build-slots/slot-1/f20.o');
    expect(text).toContain('… and 5 more');
  });
});

describe('unverifiedBuildSlotsExcerpt', () => {
  it('says git could not verify, gives the check and the fix, and rules out accept', () => {
    const text = unverifiedBuildSlotsExcerpt();
    expect(text).toContain('git could not verify');
    expect(text).toContain('git ls-tree -r --name-only HEAD -- .cyboflow/build-slots');
    expect(text).toContain('git rm -r --cached -- .cyboflow/build-slots');
    expect(text).toContain('"accept" IS NOT AN OPTION');
    expect(text).toContain('check runs again');
  });
});

// ── real git: does the lane-end HEAD's committed tree carry build-slot paths ──
describe('checkCommittedBuildSlots — real git', () => {
  function git(args: string[], cwd: string): string {
    return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  }
  function commitFile(repo: string, rel: string, content: string, force = false): string {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content, 'utf8');
    git(['add', ...(force ? ['-f'] : []), '--', rel], repo);
    git(['commit', '-q', '-m', `add ${rel}`], repo);
    return git(['rev-parse', 'HEAD'], repo);
  }
  function commitAll(repo: string, message: string): string {
    git(['commit', '-q', '-m', message], repo);
    return git(['rev-parse', 'HEAD'], repo);
  }
  /** A repo with the exclude in place, as LaneBuildSlots writes it — a force-add beats it. */
  function initRepo(repo: string): string {
    git(['init', '-q'], repo);
    fs.appendFileSync(path.resolve(repo, git(['rev-parse', '--git-path', 'info/exclude'], repo)), '/.cyboflow/build-slots/\n');
    return commitFile(repo, 'README.md', 'hello\n');
  }
  /** The probe's own runners (index.ts beginCommitProbe): `runGitExit` and an on-disk check in the worktree. */
  const inRepo = (repo: string, options: RunGitOptions = {}) => (args: string[]) => runGitExit(repo, args, options);
  const onDisk = (repo: string) => (rel: string) => fs.existsSync(path.join(repo, rel));
  const check = (repo: string, options: RunGitOptions = {}) => checkCommittedBuildSlots(inRepo(repo, options), onDisk(repo));

  it(
    'reports a force-committed build-slot file, clears once a later commit removes it, and ignores unrelated files',
    async () => {
      await withTempDir('commit-integrity-slots-', async (repo) => {
        initRepo(repo);
        // Slots in use on disk (git-excluded, uncommitted): nothing committed ⇒ clean.
        fs.mkdirSync(path.join(repo, '.cyboflow', 'build-slots', 'slot-0'), { recursive: true });
        fs.writeFileSync(path.join(repo, '.cyboflow', 'build-slots', 'slot-0', 'scratch.o'), 'o');
        commitFile(repo, 'src/a.ts', 'export {};\n');
        expect(await check(repo)).toEqual({ kind: 'clean' });

        commitFile(repo, '.cyboflow/build-slots/slot-0/DerivedData/build.db', 'x', true);
        expect(await check(repo)).toEqual({
          kind: 'leak',
          paths: ['.cyboflow/build-slots/slot-0/DerivedData/build.db'],
        });
        // A project's OTHER .cyboflow/ files are not build output, nor is a look-alike sibling dir.
        commitFile(repo, '.cyboflow/verify-runbook.json', '{}\n');
        commitFile(repo, '.cyboflow/build-slots-archive/notes.txt', 'n\n');
        expect(await check(repo)).toEqual({
          kind: 'leak',
          paths: ['.cyboflow/build-slots/slot-0/DerivedData/build.db'],
        });

        git(['rm', '-q', '-r', '--cached', '--', '.cyboflow/build-slots'], repo);
        commitAll(repo, 'untrack build output');
        expect(await check(repo)).toEqual({ kind: 'clean' });
      });
    },
    60_000,
  );

  it(
    'still reports output committed BEFORE the lane started (already in its start HEAD — e.g. an earlier run, pre-restart)',
    async () => {
      await withTempDir('commit-integrity-slots-before-', async (repo) => {
        initRepo(repo);
        commitFile(repo, '.cyboflow/build-slots/slot-1/app.o', 'object code\n', true);
        // The lane starts HERE and commits only unrelated work: no start..end range
        // would contain the leak, but the end HEAD's tree still does.
        const laneStart = git(['rev-parse', 'HEAD'], repo);
        const laneEnd = commitFile(repo, 'src/feature.ts', 'export const x = 1;\n');
        expect(laneEnd).not.toBe(laneStart);
        expect(await check(repo)).toEqual({ kind: 'leak', paths: ['.cyboflow/build-slots/slot-1/app.o'] });
      });
    },
    60_000,
  );

  it(
    'still reports a leak too big to LIST (the name listing overflows the output buffer)',
    async () => {
      await withTempDir('commit-integrity-slots-big-', async (repo) => {
        initRepo(repo);
        commitFile(repo, '.cyboflow/build-slots/slot-0/DerivedData/Index.noindex/big.idx', 'x', true);

        // A buffer that fits the one top entry the presence check prints but not
        // the full recursive listing stands in for 80k DerivedData paths
        // overflowing the real 10 MB one: git said the files are there, so the
        // lane is still refused — with a placeholder instead of the list.
        const small = { maxBuffer: '.cyboflow/build-slots\n'.length + 4 };
        await expect(
          runGitExit(repo, ['ls-tree', '-r', '--name-only', 'HEAD', '--', '.cyboflow/build-slots'], small),
        ).rejects.toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
        expect(await check(repo, small)).toEqual({ kind: 'leak', paths: [COMMITTED_BUILD_SLOTS_UNLISTED] });
      });
    },
    60_000,
  );
  it(
    'fails closed (unknown) when real git cannot read the tree and the slots directory exists — clean when it does not',
    async () => {
      // Not a repository at all: every git read fails (exit 128), twice.
      await withTempDir('commit-integrity-slots-nogit-', async (dir) => {
        fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /nonexistent/cyboflow-test-gitdir\n');
        expect(await check(dir)).toEqual({ kind: 'clean' });
        fs.mkdirSync(path.join(dir, '.cyboflow', 'build-slots', 'slot-0'), { recursive: true });
        expect(await check(dir)).toEqual({ kind: 'unknown' });
      });
    },
    60_000,
  );
});

describe('checkCommittedBuildSlots — git failures (tri-state)', () => {
  const clean: GitExit = { exitCode: 0, stdout: '', stderr: '' };
  const failed: GitExit = { exitCode: 128, stdout: '', stderr: 'fatal: unable to read tree' };
  /** A git runner that answers each call from `script` in order (the last entry repeats), counting calls. */
  function scripted(script: Array<GitExit | Error>): { git: (args: string[]) => Promise<GitExit>; calls: string[][] } {
    const calls: string[][] = [];
    return {
      calls,
      git: async (args) => {
        calls.push(args);
        const next = script[Math.min(calls.length - 1, script.length - 1)];
        if (next instanceof Error) throw next;
        return next;
      },
    };
  }

  it('reports unknown when git fails twice and the slots directory exists on disk', async () => {
    const { git, calls } = scripted([failed]);
    const asked: string[] = [];
    const result = await checkCommittedBuildSlots(git, (rel) => {
      asked.push(rel);
      return true;
    });
    expect(result).toEqual({ kind: 'unknown' });
    expect(calls).toHaveLength(2);
    expect(asked).toEqual(['.cyboflow/build-slots']);
  });

  it('treats a THROWING git (spawn failure) like a failed exit', async () => {
    const { git, calls } = scripted([new Error('spawn git ENOENT')]);
    expect(await checkCommittedBuildSlots(git, () => true)).toEqual({ kind: 'unknown' });
    expect(calls).toHaveLength(2);
  });

  it('reports clean when git fails twice but no slots directory exists (nothing could have leaked)', async () => {
    const { git, calls } = scripted([failed]);
    expect(await checkCommittedBuildSlots(git, () => false)).toEqual({ kind: 'clean' });
    expect(calls).toHaveLength(2);
  });

  it('fails closed when the on-disk check itself throws', async () => {
    const { git } = scripted([failed]);
    const result = await checkCommittedBuildSlots(git, () => {
      throw new Error('EACCES');
    });
    expect(result).toEqual({ kind: 'unknown' });
  });

  it('uses the RETRY\'s answer when git fails once and then succeeds', async () => {
    const present: GitExit = { exitCode: 0, stdout: '.cyboflow/build-slots\n', stderr: '' };
    const listing: GitExit = { exitCode: 0, stdout: '.cyboflow/build-slots/slot-0/a.o\n', stderr: '' };
    const leak = scripted([failed, present, listing]);
    expect(await checkCommittedBuildSlots(leak.git, () => true)).toEqual({
      kind: 'leak',
      paths: ['.cyboflow/build-slots/slot-0/a.o'],
    });
    const cleanAfterRetry = scripted([failed, clean]);
    expect(await checkCommittedBuildSlots(cleanAfterRetry.git, () => true)).toEqual({ kind: 'clean' });
    expect(cleanAfterRetry.calls).toHaveLength(2);
  });

  it('never consults the disk or retries when the first read answers', async () => {
    const { git, calls } = scripted([clean]);
    let asked = false;
    const result = await checkCommittedBuildSlots(git, () => {
      asked = true;
      return true;
    });
    expect(result).toEqual({ kind: 'clean' });
    expect(calls).toHaveLength(1);
    expect(asked).toBe(false);
  });

  it('reports the placeholder when the presence check says yes but the listing fails or comes back empty', async () => {
    const present: GitExit = { exitCode: 0, stdout: '.cyboflow/build-slots\n', stderr: '' };
    const overflow = Object.assign(new Error('stdout maxBuffer length exceeded'), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    });
    for (const listing of [overflow, failed, clean]) {
      const { git } = scripted([present, listing]);
      expect(await checkCommittedBuildSlots(git, () => true)).toEqual({
        kind: 'leak',
        paths: [COMMITTED_BUILD_SLOTS_UNLISTED],
      });
    }
  });
});
