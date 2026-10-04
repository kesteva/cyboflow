/** Real-git coverage: a temp repo with worktrees in clean / dirty / ahead states. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeWorktreeGit } from './probeWorktreeGit';

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
};

let root: string;
let repo: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'probe-wt-')));
  repo = path.join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(path.join(repo, 'README.md'), 'hi\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  for (const name of ['clean', 'dirty', 'ahead']) {
    git(repo, 'worktree', 'add', '-q', path.join(root, name), '-b', `b/${name}`);
  }
  writeFileSync(path.join(root, 'dirty', 'README.md'), 'changed\n');
  writeFileSync(path.join(root, 'dirty', 'new.txt'), 'x\n');
  writeFileSync(path.join(root, 'ahead', 'a.txt'), 'a\n');
  git(path.join(root, 'ahead'), 'add', 'a.txt');
  git(path.join(root, 'ahead'), 'commit', '-qm', 'ahead');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('probeWorktreeGit', () => {
  it('reports a clean worktree as clean and not ahead', async () => {
    expect(await probeWorktreeGit(path.join(root, 'clean'))).toEqual({ dirty: false, dirtyFileCount: 0, aheadOfMain: 0 });
  });

  it('counts tracked and untracked changes', async () => {
    expect(await probeWorktreeGit(path.join(root, 'dirty'))).toEqual({ dirty: true, dirtyFileCount: 2, aheadOfMain: 0 });
  });

  it('counts commits ahead of the project root branch', async () => {
    expect(await probeWorktreeGit(path.join(root, 'ahead'))).toEqual({ dirty: false, dirtyFileCount: 0, aheadOfMain: 1 });
  });

  it('returns null when the path is not a git worktree', async () => {
    expect(await probeWorktreeGit(path.join(root, 'does-not-exist'))).toBeNull();
  });
});
