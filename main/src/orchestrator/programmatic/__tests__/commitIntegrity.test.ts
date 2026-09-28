import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { withTempDir } from '../../../__test_fixtures__/tmp';
import { runGitExit, type RunGitOptions } from '../../../utils/runGit';
import type { GitExit } from '../laneBuildSlots';
import {
  COMMITTED_BUILD_SLOTS_UNLISTED,
  commitIntegrityExcerpt,
  committedBuildSlotsExcerpt,
  parsePorcelainPaths,
  readCommittedBuildSlotPaths,
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
  it('lists the paths, names the fix, and rules out accept', () => {
    const text = committedBuildSlotsExcerpt(['.cyboflow/build-slots/slot-0/a.o'], false);
    expect(text).toContain('- .cyboflow/build-slots/slot-0/a.o');
    expect(text).toContain('git rm -r --cached -- .cyboflow/build-slots');
    expect(text).toContain('"accept" IS NOT AN OPTION');
    expect(text).toContain('No other lane was running');
    expect(text).not.toContain('OWNERSHIP:');
  });

  it("notes that an overlapped lane's range includes siblings' commits, and caps the list", () => {
    const paths = Array.from({ length: 25 }, (_, i) => `.cyboflow/build-slots/slot-1/f${i}.o`);
    const text = committedBuildSlotsExcerpt(paths, true);
    expect(text).toContain('OWNERSHIP:');
    expect(text).toContain('also contains their commits');
    expect(text).toContain('- .cyboflow/build-slots/slot-1/f19.o');
    expect(text).not.toContain('- .cyboflow/build-slots/slot-1/f20.o');
    expect(text).toContain('… and 5 more');
  });
});

// ── real git: which build-slot paths a lane's commit range carries ──
describe('readCommittedBuildSlotPaths — real git', () => {
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
  /** The probe's own runner: `runGitExit` in the worktree (index.ts beginCommitProbe). */
  const inRepo = (repo: string, options: RunGitOptions = {}) => (args: string[]) => runGitExit(repo, args, options);

  it(
    'reports a force-added build-slot file, clears once a later commit removes it, and ignores unrelated commits',
    async () => {
      await withTempDir('commit-integrity-slots-', async (repo) => {
        const start = initRepo(repo);

        expect(await readCommittedBuildSlotPaths(inRepo(repo), start, start)).toEqual([]);
        const unrelated = commitFile(repo, 'src/a.ts', 'export {};\n');
        expect(await readCommittedBuildSlotPaths(inRepo(repo), start, unrelated)).toEqual([]);

        const leaked = commitFile(repo, '.cyboflow/build-slots/slot-0/DerivedData/build.db', 'x', true);
        expect(await readCommittedBuildSlotPaths(inRepo(repo), start, leaked)).toEqual([
          '.cyboflow/build-slots/slot-0/DerivedData/build.db',
        ]);
        // A project's OTHER .cyboflow/ files are not build output, nor is a look-alike sibling dir.
        commitFile(repo, '.cyboflow/verify-runbook.json', '{}\n');
        const runbook = commitFile(repo, '.cyboflow/build-slots-archive/notes.txt', 'n\n');
        expect(await readCommittedBuildSlotPaths(inRepo(repo), leaked, runbook)).toEqual([]);

        git(['rm', '-q', '-r', '--cached', '--', '.cyboflow/build-slots'], repo);
        const fixed = commitAll(repo, 'untrack build output');
        // Tree comparison: the range as a whole no longer carries them.
        expect(await readCommittedBuildSlotPaths(inRepo(repo), start, fixed)).toEqual([]);
        // A lane whose range only REMOVES an earlier offender is not blamed for it.
        expect(await readCommittedBuildSlotPaths(inRepo(repo), runbook, fixed)).toEqual([]);
      });
    },
    60_000,
  );

  it(
    'reports a file RENAMED into the slots root as the add it is, even with diff.renames on',
    async () => {
      await withTempDir('commit-integrity-slots-rename-', async (repo) => {
        const start = initRepo(repo);
        git(['config', 'diff.renames', 'true'], repo);
        const before = commitFile(repo, 'build/app.o', 'object code\n');
        fs.mkdirSync(path.join(repo, '.cyboflow', 'build-slots', 'slot-1'), { recursive: true });
        git(['mv', '-f', '--', 'build/app.o', '.cyboflow/build-slots/slot-1/app.o'], repo);
        const moved = commitAll(repo, 'move build output');

        expect(await readCommittedBuildSlotPaths(inRepo(repo), before, moved)).toEqual([
          '.cyboflow/build-slots/slot-1/app.o',
        ]);
        expect(await readCommittedBuildSlotPaths(inRepo(repo), start, moved)).toEqual([
          '.cyboflow/build-slots/slot-1/app.o',
        ]);
      });
    },
    60_000,
  );

  it(
    'still reports a leak too big to LIST (the name listing overflows the output buffer)',
    async () => {
      await withTempDir('commit-integrity-slots-big-', async (repo) => {
        const start = initRepo(repo);
        const leaked = commitFile(repo, '.cyboflow/build-slots/slot-0/DerivedData/Index.noindex/big.idx', 'x', true);

        // A buffer too small for even one path stands in for 80k DerivedData paths
        // overflowing the real 10 MB one: git said the files are there, so the
        // lane is still refused — with a placeholder instead of the list.
        const tiny = inRepo(repo, { maxBuffer: 16 });
        await expect(runGitExit(repo, ['diff', '--name-only', start, leaked], { maxBuffer: 16 })).rejects.toMatchObject({
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        });
        expect(await readCommittedBuildSlotPaths(tiny, start, leaked)).toEqual([COMMITTED_BUILD_SLOTS_UNLISTED]);
      });
    },
    60_000,
  );

  it('resolves undefined (never throws) when git cannot answer whether anything is there', async () => {
    const failing = async (): Promise<GitExit> => {
      throw new Error('spawn git ENOENT');
    };
    expect(await readCommittedBuildSlotPaths(failing, 'aaa', 'bbb')).toBeUndefined();
    const badObject = async (): Promise<GitExit> => ({ exitCode: 128, stdout: '', stderr: 'fatal: bad object aaa' });
    expect(await readCommittedBuildSlotPaths(badObject, 'aaa', 'bbb')).toBeUndefined();
  });

  it('reports the placeholder when the presence check says yes but the listing fails or comes back empty', async () => {
    const presentThen = (listing: () => Promise<GitExit>) => async (args: string[]): Promise<GitExit> =>
      args.includes('--quiet') ? { exitCode: 1, stdout: '', stderr: '' } : listing();
    const overflow = Object.assign(new Error('stdout maxBuffer length exceeded'), {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
    });
    expect(
      await readCommittedBuildSlotPaths(presentThen(async () => Promise.reject(overflow)), 'aaa', 'bbb'),
    ).toEqual([COMMITTED_BUILD_SLOTS_UNLISTED]);
    expect(
      await readCommittedBuildSlotPaths(presentThen(async () => ({ exitCode: 128, stdout: '', stderr: 'boom' })), 'aaa', 'bbb'),
    ).toEqual([COMMITTED_BUILD_SLOTS_UNLISTED]);
  });
});
